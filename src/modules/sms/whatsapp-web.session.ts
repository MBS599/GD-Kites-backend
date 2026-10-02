import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { resolve } from 'node:path';
import { toDataURL } from 'qrcode';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';

/** Older than this, a QR code can no longer be scanned. */
const QR_STALE_MS = 45_000;

export type WebSessionState = 'off' | 'starting' | 'qr' | 'ready' | 'disconnected' | 'failed';

/** The parts of whatsapp-web.js the app uses (lets tests use a fake). */
export interface WebClient {
  on(event: string, listener: (...args: any[]) => void): unknown;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  logout(): Promise<void>;
  getState(): Promise<string | null>;
  getNumberId(number: string): Promise<{ _serialized: string } | null>;
  sendMessage(chatId: string, content: string): Promise<{ id?: { _serialized?: string } } | undefined>;
  getChatById(chatId: string): Promise<{
    fetchMessages(opts: { limit: number; fromMe?: boolean }): Promise<{ body: string; id?: { _serialized?: string } }[]>;
  }>;
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
  /** When the current QR was issued (WhatsApp rotates it every ~20 s, then stops after a few minutes). */
  private qrAt = 0;
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
    clearInterval(this.readyPoll);
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
        this.qrAt = Date.now();
        this.qr = await toDataURL(qr, { margin: 1, width: 320 });
        this.logger.log('Scan the QR code in Admin → Settings → WhatsApp & notifications to link the phone.');
      });
      client.on('ready', () => this.markReady('ready event'));
      client.on('authenticated', () => {
        this.logger.log('WhatsApp session authenticated, loading chats…');
        this.watchForConnected(client);
      });
      client.on('loading_screen', (percent: number, message: string) =>
        this.logger.log(`WhatsApp loading ${percent}% ${message ?? ''}`),
      );
      client.on('change_state', (s: string) => this.logger.log(`WhatsApp state: ${s}`));
      client.on('auth_failure', (msg: string) => {
        this.state = 'failed';
        this.lastError = `Authentication failed: ${msg}`;
        void this.saveNumber(null);
      });
      client.on('disconnected', (reason: string) => {
        this.state = 'disconnected';
        this.lastError = `Disconnected: ${reason}`;
        this.logger.warn(this.lastError);
        // Unlinked from the phone (Linked devices → Log out): stop showing the number.
        // Other reasons are network blips; the saved login reconnects with the same number.
        if (reason === 'LOGOUT') void this.saveNumber(null);
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

  /**
   * The QR to show right now. WhatsApp Web stops issuing new codes after a few
   * minutes without a scan, leaving an expired one; when someone is looking
   * and the code is stale, start over to get a fresh code.
   */
  currentQr() {
    if (this.state !== 'qr') return null;
    if (Date.now() - this.qrAt > QR_STALE_MS) {
      if (!this.refreshing) {
        this.refreshing = true;
        this.logger.log('QR code expired — getting a fresh one.');
        void this.restart().finally(() => (this.refreshing = false));
      }
      return null; // never show a code that can't be scanned
    }
    return this.qr;
  }

  private refreshing = false;

  private markReady(how: string) {
    if (this.state === 'ready') return;
    clearInterval(this.readyPoll);
    this.state = 'ready';
    this.qr = null;
    this.lastError = null;
    this.logger.log(`WhatsApp linked (${this.number ?? 'number pending'}) — ${how}.`);
    void this.rememberNumber();
  }

  /** The linked number is the shop's public contact number; WhatsApp Web may fill it in just after ready. */
  private async rememberNumber(tries = 10) {
    if (this.state !== 'ready') return;
    if (this.number) return this.saveNumber(this.number);
    if (tries > 0) setTimeout(() => void this.rememberNumber(tries - 1), 3000);
  }

  private async saveNumber(whatsappNumber: string | null) {
    try {
      await this.prisma.appSettings.upsert({
        where: { id: 1 },
        create: { id: 1, whatsappNumber },
        update: { whatsappNumber },
      });
    } catch (e) {
      this.logger.error(`Could not save the linked WhatsApp number: ${String(e)}`);
    }
  }

  private readyPoll?: NodeJS.Timeout;

  /**
   * whatsapp-web.js sometimes never emits "ready" when it restores a saved
   * login on current WhatsApp Web. After authentication, poll the connection
   * state and treat CONNECTED as ready.
   */
  private watchForConnected(client: WebClient) {
    clearInterval(this.readyPoll);
    let tries = 0;
    this.readyPoll = setInterval(async () => {
      if (this.state === 'ready' || this.client !== client || ++tries > 60) return clearInterval(this.readyPoll);
      try {
        if ((await client.getState()) === 'CONNECTED') this.markReady('connection state');
      } catch {
        // page still loading
      }
    }, 3000);
  }

  async restart() {
    clearInterval(this.readyPoll);
    await this.client?.destroy().catch(() => undefined);
    this.client = null;
    this.state = 'off';
    await this.start();
  }

  /** Unlinks the phone; a new QR code appears for linking another one. */
  async logout() {
    await this.client?.logout().catch(() => undefined);
    await this.saveNumber(null);
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
    let sent: { id?: { _serialized?: string } } | undefined;
    try {
      sent = await this.client.sendMessage(id._serialized, text);
    } catch (e) {
      // whatsapp-web.js can fail *after* WhatsApp accepted the message
      // (e.g. "Cannot read properties of undefined (reading 'id')" when
      // WhatsApp Web changes). Treat it as sent — retrying would send it twice.
      this.logger.warn(`sendMessage reported an error after sending: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.lastSendAt = Date.now();
    }
    return sent?.id?._serialized ?? (await this.lastSentId(id._serialized, text));
  }

  /** Finds the message we just sent when the library couldn't return it (for delivery ticks). */
  private async lastSentId(chatId: string, text: string): Promise<string | null> {
    try {
      const chat = await this.client!.getChatById(chatId);
      const recent = await chat.fetchMessages({ limit: 5, fromMe: true });
      return recent.reverse().find((m) => m.body === text)?.id?._serialized ?? null;
    } catch {
      return null;
    }
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
