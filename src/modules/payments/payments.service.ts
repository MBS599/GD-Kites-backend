import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Payment } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { orderCode, orderInclude, type FullOrder } from '../../common/serializers';
import type { Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SmsService } from '../sms/sms.service';
import { moveOrder } from '../orders/order-workflow';
import { RazorpayClient, RazorpayError, type RzpPayment } from './razorpay.client';
import { SettingsService } from '../settings/settings.controller';
import { onlineChargesFor } from '../../domain/pricing';

/** What the app needs to open Razorpay Checkout. Amount is in paise. */
export interface CheckoutSession {
  provider: 'razorpay';
  keyId: string;
  orderId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill: { name: string; contact: string; email: string };
  dueBy: string | null;
}

const paise = (d: Prisma.Decimal) => Math.round(d.toNumber() * 100);

/**
 * Online payment of the delivery charge (Razorpay). The goods are still paid in
 * cash on delivery. Amounts always come from the order in the database, never
 * from the app.
 *
 * An order is marked paid by the app's verify call (checkout signature) or by the
 * Razorpay webhook, whichever arrives first; both are idempotent.
 */
@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Payments');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly rzp: RazorpayClient,
    private readonly realtime: RealtimeService,
    private readonly sms: SmsService,
    private readonly settings: SettingsService,
  ) {}

  /** GST + passed-on gateway fee for a delivery charge, from the admin settings. */
  async onlineCharges(deliveryCharge: Prisma.Decimal) {
    const s = await this.settings.get();
    return onlineChargesFor(deliveryCharge.toNumber(), s.deliveryGstPercent, s.gatewayFeePercent);
  }

  /** Charged online for an order: delivery charge + GST + gateway fee (fixed when it was placed). */
  static onlineAmount(o: { deliveryCharge: Prisma.Decimal; deliveryTax: Prisma.Decimal; paymentFee: Prisma.Decimal }) {
    return o.deliveryCharge.add(o.deliveryTax).add(o.paymentFee);
  }

  get enabled(): boolean {
    return this.config.get('PAYMENTS_PROVIDER') === 'razorpay';
  }

  get timeoutMin(): number {
    return this.config.get('PAYMENT_TIMEOUT_MIN');
  }

  /** Orders with a delivery charge are paid online first (when payments are on). */
  requiresPayment(deliveryCharge: Prisma.Decimal): boolean {
    return this.enabled && deliveryCharge.gt(0);
  }

  onModuleInit() {
    if (!this.enabled || process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.expireStale().catch((e) => this.log.error(e)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private load(id: string) {
    return this.prisma.order.findUniqueOrThrow({ where: { id }, include: orderInclude }) as Promise<FullOrder>;
  }

  /** Opens (or reopens) checkout for an unpaid order. Reuses the open Razorpay order. */
  async checkout(customer: AuthUser, orderId: string): Promise<CheckoutSession> {
    const o = await this.load(orderId);
    if (o.customerId !== customer.id) throw new NotFoundException('Order not found.');
    if (o.status !== 'AWAITING_PAYMENT') throw new ConflictException('This order does not need a payment.');
    if (o.paymentDueBy && o.paymentDueBy < new Date()) {
      throw new ConflictException('The time to pay for this order is over. Please place it again.');
    }
    let p = await this.prisma.payment.findFirst({ where: { orderId, status: 'CREATED' }, orderBy: { createdAt: 'desc' } });
    const amount = PaymentsService.onlineAmount(o);
    if (!p || !p.amount.eq(amount)) {
      const code = orderCode(o.number);
      const rzpOrder = await this.rzp.createOrder(paise(amount), code, { orderId: o.id, purpose: 'delivery_charge' });
      p = await this.prisma.payment.create({
        data: { orderId, providerOrderId: rzpOrder.id, amount, currency: rzpOrder.currency },
      });
    }
    return {
      provider: 'razorpay',
      keyId: this.rzp.keyId,
      orderId: p.providerOrderId,
      amount: paise(p.amount),
      currency: p.currency,
      name: 'GD Kite Center',
      description: o.deliveryTax.gt(0) || o.paymentFee.gt(0)
        ? `Delivery charge + GST + fee · ${orderCode(o.number)}`
        : `Delivery charge · ${orderCode(o.number)}`,
      prefill: { name: o.contactName, contact: o.contactPhone, email: customer.email ?? '' },
      dueBy: o.paymentDueBy?.toISOString() ?? null,
    };
  }

  /** The app's success callback: checks the checkout signature, then confirms with Razorpay. */
  async verify(customer: AuthUser, orderId: string, providerOrderId: string, providerPaymentId: string, signature: string) {
    const p = await this.prisma.payment.findUnique({ where: { providerOrderId }, include: { order: true } });
    if (!p || p.orderId !== orderId || p.order.customerId !== customer.id) throw new NotFoundException('Payment not found.');
    if (!this.rzp.checkoutSignatureValid(providerOrderId, providerPaymentId, signature)) {
      throw new BadRequestException('Payment could not be verified.');
    }
    await this.settle(p, await this.rzp.fetchPayment(providerPaymentId));
    return this.load(orderId);
  }

  /** Razorpay webhook (signature already checked by the controller). */
  async handleWebhook(body: any) {
    const event: string = body?.event ?? '';
    if (event.startsWith('refund.')) {
      const refund = body?.payload?.refund?.entity;
      const status = event === 'refund.processed' ? 'REFUNDED' : event === 'refund.failed' ? 'REFUND_FAILED' : null;
      if (refund?.id && status) {
        await this.prisma.payment.updateMany({
          where: { refundId: refund.id },
          data: { status, refundedAt: status === 'REFUNDED' ? new Date() : null },
        });
      }
      return;
    }
    const payment: RzpPayment | undefined = body?.payload?.payment?.entity;
    if (!payment?.order_id) return;
    const p = await this.prisma.payment.findUnique({ where: { providerOrderId: payment.order_id } });
    if (!p) return; // not ours (e.g. another app on the same Razorpay account)
    if (event === 'payment.failed') {
      if (p.status === 'CREATED') {
        await this.prisma.payment.update({ where: { id: p.id }, data: { error: payment.error_description ?? 'Payment failed' } });
      }
      return;
    }
    if (event === 'payment.authorized' || event === 'payment.captured' || event === 'order.paid') {
      await this.settle(p, payment);
    }
  }

  /** Captures if needed, checks it matches what we asked for, then marks the order paid. */
  private async settle(p: Payment, payment: RzpPayment) {
    if (payment.order_id !== p.providerOrderId || payment.amount !== paise(p.amount) || payment.currency !== p.currency) {
      this.log.warn(`Payment ${payment.id} does not match ${p.providerOrderId}`);
      throw new BadRequestException('Payment could not be verified.');
    }
    if (payment.status === 'authorized') {
      try {
        payment = await this.rzp.capture(payment.id, payment.amount);
      } catch (e) {
        // Auto-capture may have captured it meanwhile.
        if (!(e instanceof RazorpayError)) throw e;
        payment = await this.rzp.fetchPayment(payment.id);
      }
    }
    if (payment.status !== 'captured') throw new ConflictException('Payment is not complete yet.');
    await this.markPaid(p.id, payment);
  }

  private async markPaid(paymentId: string, payment: RzpPayment) {
    let result: { orderId: string; late: boolean } | null = null;
    await this.prisma.tx(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: ['CREATED', 'FAILED'] } },
        data: { status: 'PAID', providerPaymentId: payment.id, method: payment.method ?? null, error: null, paidAt: new Date() },
      });
      if (claimed.count === 0) return; // already handled
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { order: true } });
      const o = p.order;
      await tx.order.update({ where: { id: o.id }, data: { paidOnline: { increment: p.amount } } });
      if (o.status !== 'AWAITING_PAYMENT') {
        result = { orderId: o.id, late: true }; // paid after the order was cancelled
        return;
      }
      await moveOrder(tx, o.id, o.status, 'PENDING', o.customerId, `Delivery charge paid online (${payment.method ?? 'Razorpay'})`, {
        paymentMethod: 'DELIVERY_PREPAID',
      });
      result = { orderId: o.id, late: false };
    });
    const r = result as { orderId: string; late: boolean } | null;
    if (!r) return;
    if (r.late) {
      await this.refundPaid(r.orderId, 'Order was already cancelled');
      return;
    }
    const full = await this.load(r.orderId);
    this.realtime.orderUpdated(full);
    this.sms.orderPlaced(full);
  }

  /**
   * Refunds every successful payment of an order (on cancel / reject). Never
   * throws: a failed refund is recorded as REFUND_FAILED for the admin to see.
   * Returns the amount (rupees) being refunded.
   */
  async refundPaid(orderId: string, reason: string): Promise<number> {
    const paid = await this.prisma.payment.findMany({ where: { orderId, status: 'PAID' } });
    let total = 0;
    for (const p of paid) {
      const claimed = await this.prisma.payment.updateMany({ where: { id: p.id, status: 'PAID' }, data: { status: 'REFUND_PENDING' } });
      if (claimed.count === 0 || !p.providerPaymentId) continue;
      total += p.amount.toNumber();
      try {
        const r = await this.rzp.refund(p.providerPaymentId, paise(p.amount), { orderId, reason: reason.slice(0, 200) });
        await this.prisma.payment.update({
          where: { id: p.id },
          data: {
            refundId: r.id,
            status: r.status === 'processed' ? 'REFUNDED' : r.status === 'failed' ? 'REFUND_FAILED' : 'REFUND_PENDING',
            refundedAt: r.status === 'processed' ? new Date() : null,
          },
        });
      } catch (e) {
        const why = e instanceof RazorpayError ? e.reason : (e as Error).message;
        this.log.error(`Refund of ${p.providerPaymentId} failed: ${why}`);
        await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'REFUND_FAILED', error: why } });
      }
    }
    if (total > 0) await this.prisma.order.update({ where: { id: orderId }, data: { paidOnline: { decrement: total } } });
    return total;
  }

  /**
   * Cancels orders whose time to pay is over. Asks
   * Razorpay first, so a payment whose callback was lost is not thrown away.
   */
  async expireStale(now = new Date()) {
    const stale = await this.prisma.order.findMany({
      where: { status: 'AWAITING_PAYMENT', paymentDueBy: { lt: now } },
      include: { payments: { where: { status: 'CREATED' } } },
      take: 50,
    });
    let cancelled = 0;
    for (const o of stale) {
      let keep = false;
      for (const p of o.payments) {
        try {
          const done = (await this.rzp.orderPayments(p.providerOrderId)).find(
            (x) => x.status === 'captured' || x.status === 'authorized',
          );
          if (done) {
            await this.settle(p, done);
            keep = true;
          }
        } catch (e) {
          this.log.warn(`Could not check ${p.providerOrderId}: ${(e as Error).message}`);
          keep = true; // try again next minute rather than cancel a possibly-paid order
        }
      }
      if (keep) continue;
      const reason = `Payment not completed within ${this.timeoutMin} minutes`;
      try {
        await this.prisma.tx(async (tx) => {
          await moveOrder(tx, o.id, 'AWAITING_PAYMENT', 'CANCELLED', null, reason, { rejectionReason: reason });
        });
      } catch (e) {
        if (e instanceof ConflictException) continue; // paid meanwhile
        throw e;
      }
      cancelled++;
      const full = await this.load(o.id);
      this.realtime.orderUpdated(full);
      this.sms.orderCancelled(full, reason, null);
    }
    return cancelled;
  }
}
