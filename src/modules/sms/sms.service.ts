import { Injectable, Logger } from '@nestjs/common';
import type { Product, User } from '@prisma/client';
import { AppConfig } from '../../config/app-config.service';
import { orderCode, type FullOrder } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { LogSmsProvider, SmsProviderError, WhatsAppProvider, WhatsAppWebProvider, type SmsProvider } from './sms.providers';
import { WhatsAppWebSession } from './whatsapp-web.session';
import { clipVar, maskSecret, renderSms, SMS_EVENTS, type SmsEvent } from './sms.templates';
import { renderWhatsApp } from './whatsapp.templates';
import { pushFor, PushService } from './push.service';

interface Job {
  event: SmsEvent;
  to: string;
  vars: (string | number)[];
  userId?: string;
  orderId?: string;
}

/** Same text to the same number within this window is sent once (retries, double taps). */
const DEDUPE_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [2_000, 8_000];

/**
 * Messages (WhatsApp) and push notifications for customers, drivers and
 * admins. Sending is fire-and-forget: it never blocks or fails the business
 * action that caused it, and every message attempt is recorded in SmsMessage.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  readonly provider: SmsProvider;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    config: AppConfig,
    private readonly pushService: PushService,
    webSession: WhatsAppWebSession,
  ) {
    this.provider = (() => {
      switch (config.get('MESSAGING_PROVIDER')) {
        case 'wwebjs':
          return new WhatsAppWebProvider(webSession);
        case 'whatsapp':
          return new WhatsAppProvider(
            config.get('WHATSAPP_TOKEN'),
            config.get('WHATSAPP_PHONE_NUMBER_ID'),
            config.get('WHATSAPP_LANG'),
            config.get('WHATSAPP_API_VERSION'),
          );
        default:
          return new LogSmsProvider((line) => this.logger.log(line));
      }
    })();
  }

  /** Setup overview for the admin Settings screen (no secrets). */
  status() {
    return {
      provider: this.provider.name,
      live: this.provider.name !== 'log',
      pushEnabled: this.pushService.enabled,
      events: SMS_EVENTS.map((event) => ({ event })),
    };
  }

  /** Waits until queued messages are processed (tests, graceful shutdown). */
  async drain() {
    // Jobs can queue follow-up jobs (recipient lookup → send), so wait until stable.
    let current: Promise<void>;
    do {
      current = this.queue;
      await current;
    } while (current !== this.queue);
  }

  // ------------------------------------------------------------ events

  orderPlaced(o: FullOrder) {
    const code = orderCode(o.number);
    this.toCustomer(o, 'orderPlaced', [o.contactName, code, money(o.total)]);
    this.toAdmins('adminNewOrder', [code, o.contactName, money(o.total)], o.id);
  }

  orderConfirmed(o: FullOrder) {
    this.toCustomer(o, 'orderConfirmed', [orderCode(o.number)]);
  }

  /** New driver told, customer told who is coming, a replaced driver told it is gone. */
  driverAssigned(o: FullOrder, previousDriverId: string | null) {
    const d = o.delivery?.driver;
    if (!d) return;
    const code = orderCode(o.number);
    this.toCustomer(o, 'driverAssigned', [code, d.user.name, d.user.phone ?? '']);
    this.toUser(d.user, 'deliveryAssigned', [code, o.contactName, o.addrArea], o.id);
    if (previousDriverId && previousDriverId !== d.id) this.toDriverId(previousDriverId, 'deliveryRemoved', [code], o.id);
  }

  /** Includes the delivery handover OTP the customer gives the driver. */
  outForDelivery(o: FullOrder, otp: string) {
    const d = o.delivery?.driver;
    if (!d) return;
    this.toCustomer(o, 'outForDelivery', [orderCode(o.number), d.user.name, d.user.phone ?? '', otp]);
  }

  /** Customer asked for the delivery OTP again: sent even if they turned SMS updates off. */
  deliveryOtp(o: Pick<FullOrder, 'id' | 'number' | 'customerId' | 'contactPhone'>, otp: string) {
    this.push(o.customerId, 'deliveryOtp', [otp, orderCode(o.number)], o.id);
    this.later(async () => {
      const customer = await this.prisma.user.findUnique({ where: { id: o.customerId } });
      this.enqueue({
        event: 'deliveryOtp',
        to: o.contactPhone || customer?.phone || '',
        vars: [otp, orderCode(o.number)],
        userId: o.customerId,
        orderId: o.id,
      });
    });
  }

  /**
   * Sign-in code. Sent right away (not behind other queued SMS); the code is
   * never written to the SMS log. Resolves once the gateway accepted or failed.
   */
  async loginOtp(to: string, code: string) {
    const m = await this.process({ event: 'loginOtp', to, vars: [code] }, { dedupe: false });
    return m.status;
  }

  orderDelivered(o: FullOrder) {
    this.toCustomer(o, 'orderDelivered', [orderCode(o.number), money(o.total)]);
  }

  orderCancelled(o: FullOrder, reason: string, revokedDriverId: string | null) {
    const code = orderCode(o.number);
    this.toCustomer(o, 'orderCancelled', [code, reason]);
    if (revokedDriverId) this.toDriverId(revokedDriverId, 'deliveryRemoved', [code], o.id);
  }

  driverWelcome(user: User) {
    this.toUser(user, 'driverWelcome', [user.name.split(' ')[0], user.email ?? 'your mobile number']);
  }

  /** Products that just dropped to/below their low-stock threshold. */
  lowStock(products: Pick<Product, 'name' | 'stock' | 'unit'>[]) {
    for (const p of products) this.toAdmins('adminLowStock', [p.name, `${p.stock} ${p.unit}`]);
  }

  /** Admin test from Settings; bypasses dedupe and opt-out, waits for the result. */
  async sendTest(phone: string, userId: string) {
    const to = normalizeIndianMobile(phone);
    if (!to) return this.record({ event: 'test', to: phone, vars: [], userId }, 'SKIPPED', 'Invalid Indian mobile number');
    return this.process({ event: 'test', to, vars: [], userId }, { dedupe: false });
  }

  // ------------------------------------------------------------ recipients

  /** Push (free, always) plus WhatsApp/SMS (unless the user turned messages off). */
  private push(userId: string, event: SmsEvent, vars: Job['vars'], orderId?: string) {
    this.pushService.notifyUser(userId, pushFor(event, vars.map(clipVar), orderId));
  }

  private toCustomer(o: FullOrder, event: SmsEvent, vars: Job['vars']) {
    this.push(o.customerId, event, vars, o.id);
    this.later(async () => {
      const customer = await this.prisma.user.findUnique({ where: { id: o.customerId } });
      if (!customer?.smsEnabled) return;
      // The delivery contact number given at checkout, else the account phone.
      this.enqueue({ event, to: o.contactPhone || customer.phone || '', vars, userId: customer.id, orderId: o.id });
    });
  }

  private toUser(user: Pick<User, 'id' | 'phone' | 'smsEnabled' | 'isActive'>, event: SmsEvent, vars: Job['vars'], orderId?: string) {
    if (!user.isActive) return;
    this.push(user.id, event, vars, orderId);
    if (!user.smsEnabled || !user.phone) return;
    this.enqueue({ event, to: user.phone, vars, userId: user.id, orderId });
  }

  private toDriverId(driverId: string, event: SmsEvent, vars: Job['vars'], orderId?: string) {
    this.later(async () => {
      const d = await this.prisma.driverProfile.findUnique({ where: { id: driverId }, include: { user: true } });
      if (d) this.toUser(d.user, event, vars, orderId);
    });
  }

  private toAdmins(event: SmsEvent, vars: Job['vars'], orderId?: string) {
    this.later(async () => {
      const admins = await this.prisma.user.findMany({ where: { role: 'ADMIN', isActive: true } });
      for (const a of admins) this.toUser(a, event, vars, orderId);
    });
  }

  // ------------------------------------------------------------ queue

  private later(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((e) => this.logger.warn(`sms: ${String(e)}`));
  }

  private enqueue(job: Job) {
    this.later(async () => {
      const to = normalizeIndianMobile(job.to);
      if (!to) {
        await this.record(job, 'SKIPPED', 'Invalid Indian mobile number');
        return;
      }
      await this.process({ ...job, to }, { dedupe: true });
    });
  }

  private async process(job: Job, opts: { dedupe: boolean }) {
    const vars = job.vars.map(clipVar);
    const text = this.render(job.event, vars);
    // What we store: one-time codes masked.
    const logText = this.render(job.event, vars, true);
    const live = this.provider.name !== 'log';

    if (opts.dedupe) {
      const dup = await this.prisma.smsMessage.findFirst({
        where: {
          to: job.to,
          orderId: job.orderId ?? null,
          body: logText,
          status: { in: ['SENT', 'LOGGED'] },
          createdAt: { gte: new Date(Date.now() - DEDUPE_MS) },
        },
      });
      if (dup) return dup;
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const { ref } = await this.provider.send({ event: job.event, to: job.to, vars, text });
        return this.record(job, live ? 'SENT' : 'LOGGED', null, logText, ref);
      } catch (e) {
        const retryable = e instanceof SmsProviderError && e.retryable;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) {
          this.logger.warn(`SMS ${job.event} to ${mask(job.to)} failed: ${String(e)}`);
          return this.record(job, 'FAILED', String(e instanceof Error ? e.message : e).slice(0, 300), logText);
        }
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }

  /** The message as the recipient sees it on this channel; `masked` hides one-time codes (for the log). */
  private render(event: SmsEvent, vars: string[], masked = false) {
    const shown = masked ? maskSecret(event, vars) : vars;
    return this.provider.name === 'log' ? renderSms(event, shown) : renderWhatsApp(event, shown);
  }

  private record(
    job: Job,
    status: 'SENT' | 'LOGGED' | 'FAILED' | 'SKIPPED',
    error: string | null,
    text = this.render(job.event, job.vars.map(clipVar), true),
    providerRef?: string,
  ) {
    return this.prisma.smsMessage.create({
      data: {
        event: job.event,
        to: job.to.slice(0, 20),
        userId: job.userId,
        orderId: job.orderId,
        body: text,
        status,
        provider: this.provider.name,
        providerRef,
        error,
      },
    });
  }
}

const money = (v: { toString(): string } | number) => Math.round(Number(v.toString())).toLocaleString('en-IN');

/** 98220 11122 / +91-9822011122 / 09822011122 → 919822011122; null if not an Indian mobile. */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, '');
  const ten = d.length === 10 ? d : d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : null;
  return ten && /^[6-9]\d{9}$/.test(ten) ? `91${ten}` : null;
}

const mask = (n: string) => `${n.slice(0, 4)}******${n.slice(-2)}`;
