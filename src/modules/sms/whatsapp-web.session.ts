import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { resolve } from 'node:path';
import { toDataURL } from 'qrcode';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

export type WebSessionState = 'off' | 'starting' | 'qr' | 'ready' | 'disconnected' | 'failed';

/** The parts of whatsapp-web.js the app uses (lets tests use a fake). */
export interface WebClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  getNumberId(number: string): Promise<{ _serialized: string } | null>;
  sendMessage(chatId: string, content: string): Promise<{ id: { _serialized: string } }>;
  info?: { wid?: { user?: string } };
}

/**
 * WhatsApp through a linked phone (whatsapp-web.js — unofficial).
 *
 * The server runs WhatsApp Web in headless Chromium, linked to the business
 * phone by scanning a QR code (Admin → Settings → WhatsApp & notifications).
 * The login is saved in WWEBJS_SESSION_DIR, so the link survives restarts.
 *
 * Unofficial: automating WhatsApp Web is against WhatsApp's terms and the
 * number can be banned. Sends are spaced out (WWEBJS_MIN_GAP_MS) and only go
 * to numbers that are on WhatsApp.
 */
@Injectable()
export class WhatsAppWebSession implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('WhatsAppWeb');
  private client: WebClient | null = null;
  state: WebSessionState = 'off';
  /** Latest QR to scan, as a PNG data URL (only while state is "qr"). */
  qr: string | null = null;
  lastError: string | null = null;
  private lastSendAt = 0;
  private sendChain: Promise<unknown> = Promise.resolve();
  private restartTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  get enabled() {
    return this.config.get('MESSAGING_PROVIDER') === 'wwebjs';
  }

  /** Linked phone number (e.g. 919822011122) once ready. */
  get number() {
    return this.client?.info?.wid?.user ?? null;
  }

  onModuleInit() {
    // Starting Chromium takes a few seconds: never block server start-up.
    if (this.enabled) void this.start();
  }

  async onModuleDestroy() {
    clearTimeout(this.restartTimer);
    await this.client?.destroy().catch(() => undefined);
  }

  /** Overridable in tests. */
  protected async createClient(): Promise<WebClient> {
    const { Client, LocalAuth } = await import('whatsapp-web.js');
    return new Client({
      authStrategy: new LocalAuth({ dataPath: resolve(this.config.get('WWEBJS_SESSION_DIR')) }),
      puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
    }) as unknown as WebClient;
  }

  async start() {
    if (this.state === 'starting' || this.state === 'ready' || this.state === 'qr') return;
    this.state = 'starting';
    this.qr = null;
    try {
      const client = await this.createClient();
      this.client = client;
      client.on('qr', async (qr: string) => {
        this.state = 'qr';
        this.qr = await toDataURL(qr, { margin: 1, width: 320 });
        this.logger.log('Scan the QR code in Admin → Settings → WhatsApp & notifications to link the phone.');
      });
      client.on('ready', () => {
        this.state = 'ready';
        this.qr = null;
        this.lastError = null;
        this.logger.log(`WhatsApp linked (${this.number ?? 'unknown number'}).`);
      });
      client.on('auth_failure', (msg: string) => {
        this.state = 'failed';
        this.lastError = `Authentication failed: ${msg}`;
      });
      client.on('disconnected', (reason: string) => {
        this.state = 'disconnected';
        this.lastError = `Disconnected: ${reason}`;
        this.logger.warn(this.lastError);
        // Try again shortly (a new QR appears if the phone unlinked the device).
        this.restartTimer = setTimeout(() => void this.restart(), 15_000);
      });
      client.on('message_ack', (msg: { id: { _serialized: string } }, ack: number) => {
        void this.applyAck(msg.id._serialized, ack);
      });
      await client.initialize();
    } catch (e) {
      this.state = 'failed';
      this.lastError = String(e instanceof Error ? e.message : e);
      this.logger.error(`WhatsApp Web could not start: ${this.lastError}`);
    }
  }

  async restart() {
    await this.client?.destroy().catch(() => undefined);
    this.client = null;
    this.state = 'off';
    await this.start();
  }

  /** Unlinks the phone; a new QR code appears for linking another one. */
  async logout() {
    await this.client?.logout().catch(() => undefined);
    await this.restart();
  }

  /**
   * Sends one text. Messages go one at a time with a minimum gap, so the
   * account doesn't look like a bulk sender.
   */
  send(to: string, text: string) {
    const next = this.sendChain.then(() => this.sendNow(to, text));
    this.sendChain = next.catch(() => undefined);
    return next;
  }

  private async sendNow(to: string, text: string) {
    if (this.state !== 'ready' || !this.client) {
      throw new WebNotReadyError(
        this.state === 'qr'
          ? 'WhatsApp is not linked yet — scan the QR code in Admin → Settings.'
          : `WhatsApp is not connected (${this.state}).`,
      );
    }
    const gap = this.config.get('WWEBJS_MIN_GAP_MS');
    const wait = this.lastSendAt + gap + Math.floor(Math.random() * gap) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const id = await this.client.getNumberId(to);
    if (!id) throw new NotOnWhatsAppError();
    const sent = await this.client.sendMessage(id._serialized, text);
    this.lastSendAt = Date.now();
    return sent.id._serialized;
  }

  /** Delivery / read receipts from the phone. */
  private async applyAck(ref: string, ack: number) {
    const status = ack < 0 ? 'failed' : ack >= 3 ? 'read' : ack === 2 ? 'delivered' : ack === 1 ? 'sent' : null;
    if (!status) return;
    await this.prisma.smsMessage
      .updateMany({
        where: { providerRef: ref, OR: [{ deliveryStatus: null }, { deliveryStatus: { not: 'read' } }] },
        data: { deliveryStatus: status, statusAt: new Date(), ...(status === 'failed' ? { status: 'FAILED' } : {}) },
      })
      .catch(() => undefined);
  }
}

export class WebNotReadyError extends Error {}
export class NotOnWhatsAppError extends Error {
  constructor() {
    super('This number is not on WhatsApp.');
  }
}
