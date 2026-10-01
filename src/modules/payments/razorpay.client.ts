import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env';

export interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
  status: 'created' | 'attempted' | 'paid';
}

export interface RzpPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  method?: string;
  error_description?: string | null;
}

export interface RzpRefund {
  id: string;
  status: 'pending' | 'processed' | 'failed';
}

/** Constant-time comparison of two hex HMACs. */
export function hmacMatches(secret: string, payload: string | Buffer, signature: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('hex'));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Minimal Razorpay REST client (https://razorpay.com/docs/api). Amounts are in
 * paise. Only the server talks to Razorpay with the key secret; the app gets the
 * public key id and a Razorpay order id.
 */
@Injectable()
export class RazorpayClient {
  private readonly log = new Logger('Razorpay');
  private readonly base = 'https://api.razorpay.com/v1';

  constructor(private readonly config: ConfigService<Env, true>) {}

  get keyId(): string {
    return this.config.get('RAZORPAY_KEY_ID');
  }

  /** Checkout signature: HMAC-SHA256(order_id|payment_id, key secret). */
  checkoutSignatureValid(orderId: string, paymentId: string, signature: string): boolean {
    return hmacMatches(this.config.get('RAZORPAY_KEY_SECRET'), `${orderId}|${paymentId}`, signature);
  }

  /** Webhook signature: HMAC-SHA256(raw body, webhook secret). */
  webhookSignatureValid(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    return !!rawBody && hmacMatches(this.config.get('RAZORPAY_WEBHOOK_SECRET'), rawBody, signature);
  }

  createOrder(amountPaise: number, receipt: string, notes: Record<string, string>): Promise<RzpOrder> {
    return this.call('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt, notes });
  }

  async orderPayments(orderId: string): Promise<RzpPayment[]> {
    return (await this.call<{ items: RzpPayment[] }>('GET', `/orders/${orderId}/payments`)).items;
  }

  fetchPayment(paymentId: string): Promise<RzpPayment> {
    return this.call('GET', `/payments/${paymentId}`);
  }

  capture(paymentId: string, amountPaise: number): Promise<RzpPayment> {
    return this.call('POST', `/payments/${paymentId}/capture`, { amount: amountPaise, currency: 'INR' });
  }

  refund(paymentId: string, amountPaise: number, notes: Record<string, string>): Promise<RzpRefund> {
    return this.call('POST', `/payments/${paymentId}/refund`, { amount: amountPaise, speed: 'normal', notes });
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.keyId}:${this.config.get('RAZORPAY_KEY_SECRET')}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.log.error(`${method} ${path} failed: ${(e as Error).message}`);
      throw new ServiceUnavailableException('Online payment is unavailable right now. Please try again.');
    }
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const reason = json?.error?.description ?? `HTTP ${res.status}`;
      this.log.error(`${method} ${path}: ${reason}`);
      throw new RazorpayError(reason, res.status);
    }
    return json as T;
  }
}

/** Razorpay refused a call (bad keys, invalid state, ...). Shown to the app as 503; the reason is logged. */
export class RazorpayError extends ServiceUnavailableException {
  constructor(
    readonly reason: string,
    readonly httpStatus: number,
  ) {
    super('Online payment is unavailable right now. Please try again in a few minutes.');
  }
}
