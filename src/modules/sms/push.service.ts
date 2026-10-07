import { Injectable, Logger } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'node:fs';
import { AppConfig } from '../../config/app-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { SmsEvent } from './sms.templates';

export interface PushMessage {
  title: string;
  body: string;
  /** Delivered to the app for tap handling (e.g. open this order). */
  data: Record<string, string>;
}

/** Push text per event, from the same variables as the SMS/WhatsApp message. */
const PUSH: Partial<Record<SmsEvent, (v: string[]) => Omit<PushMessage, 'data'>>> = {
  orderPlaced: ([, code, , amount]) => ({ title: 'Order placed', body: `${code} · Rs ${amount}. We will confirm it shortly.` }),
  orderConfirmed: ([, code]) => ({ title: 'Order confirmed', body: `${code} is confirmed and being packed.` }),
  driverAssigned: ([, code, driver]) => ({ title: 'Driver assigned', body: `${driver} will deliver ${code}.` }),
  outForDelivery: ([, code, driver, , otp]) => ({
    title: 'Out for delivery',
    body: `${code} is on the way with ${driver}. Delivery code: ${otp}`,
  }),
  deliveryOtp: ([otp, code]) => ({ title: 'Delivery code', body: `Code for ${code}: ${otp}. Share it only when you receive your order.` }),
  orderDelivered: ([, code, , amount]) => ({ title: 'Delivered', body: `${code} delivered (Rs ${amount}). Thank you!` }),
  orderCancelled: ([, code, , reason]) => ({ title: 'Order cancelled', body: `${code}: ${reason}` }),
  deliveryAssigned: ([, code, name, area]) => ({ title: 'New delivery', body: `${code} for ${name}, ${area}` }),
  deliveryRemoved: ([code]) => ({ title: 'Delivery removed', body: `${code} is no longer assigned to you.` }),
  adminNewOrder: ([code, name, , amount]) => ({ title: 'New order', body: `${code} from ${name} · Rs ${amount}` }),
};

export function pushFor(event: SmsEvent, vars: string[], orderId?: string): PushMessage | null {
  const make = PUSH[event];
  if (!make) return null;
  return { ...make(vars), data: { type: event, ...(orderId ? { orderId } : {}) } };
}

/**
 * Firebase Cloud Messaging (HTTP v1). Free, no per-message cost. Sends to
 * every registered install of a user and forgets tokens Firebase reports as
 * gone (app uninstalled / token rotated). Off when no service account is set.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly auth: GoogleAuth | null = null;
  private readonly projectId: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    config: AppConfig,
  ) {
    const raw = config.get('FIREBASE_SERVICE_ACCOUNT').trim();
    if (!raw) return;
    try {
      const creds = JSON.parse(raw.startsWith('{') ? raw : readFileSync(raw, 'utf8')) as { project_id: string };
      this.projectId = creds.project_id;
      this.auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
    } catch (e) {
      this.logger.error(`FIREBASE_SERVICE_ACCOUNT could not be read: ${String(e)} — push notifications are off.`);
    }
  }

  get enabled() {
    return this.auth !== null;
  }

  /** Remember this install for the user (a token moves to whoever signed in last). */
  register(userId: string, token: string, platform: string) {
    return this.prisma.deviceToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform, lastSeenAt: new Date() },
    });
  }

  unregister(userId: string, token: string) {
    return this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  /** Fire-and-forget: never throws. */
  notifyUser(userId: string, message: PushMessage | null) {
    if (!message || !this.enabled) return;
    void this.sendToUser(userId, message).catch((e) => this.logger.warn(`push: ${String(e)}`));
  }

  private async sendToUser(userId: string, message: PushMessage) {
    const devices = await this.prisma.deviceToken.findMany({ where: { userId } });
    if (!devices.length) return;
    const client = await this.auth!.getClient();
    const { token: accessToken } = await client.getAccessToken();
    for (const d of devices) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: d.token,
            notification: { title: message.title, body: message.body },
            data: message.data,
            android: { priority: 'high', notification: { channel_id: 'orders', sound: 'default' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) continue;
      const text = await res.text();
      // App uninstalled or token replaced: stop sending to it.
      if (res.status === 404 || text.includes('UNREGISTERED') || text.includes('registration-token-not-registered')) {
        await this.prisma.deviceToken.delete({ where: { id: d.id } }).catch(() => undefined);
      } else {
        this.logger.warn(`push to ${userId} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
    }
  }
}
