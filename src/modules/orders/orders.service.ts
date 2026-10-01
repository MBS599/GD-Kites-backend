import { pageArgs, toPage, type PageQuery } from '../../common/paging';
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type OrderStatus } from '@prisma/client';
import type { AuthUser } from '../../common/auth.decorators';
import { lineTotal, unitPrice } from '../../common/pricing';
import { orderInclude, orderOut, upperSnake, type FullOrder } from '../../common/serializers';
import { STOCK_RESERVED } from '../../domain/orderStateMachine';
import { deliveryChargeFor, driverFareFor, etaMinutes } from '../../domain/pricing';
import { PrismaService } from '../../prisma/prisma.service';
import { deliveryTariffOf, driverTariffOf } from '../../common/rates';
import { RealtimeService } from '../realtime/realtime.service';
import { SmsService } from '../sms/sms.service';
import { OtpGenerator } from '../sms/otp';
import { DELIVERY_OTP_DIGITS, DELIVERY_OTP_MAX_ATTEMPTS } from '../deliveries/deliveries.service';

const DELIVERY_OTP_RESEND_MS = 60_000;
const DELIVERY_OTP_MAX_SENDS = 4;
import { ServiceAreasService } from '../service-areas/service-areas.service';
import { assertTransition, moveOrder, refreshDriverAvailability, releaseStock } from './order-workflow';
import { PaymentsService, type CheckoutSession } from '../payments/payments.service';

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly areas: ServiceAreasService,
    private readonly sms: SmsService,
    private readonly otp: OtpGenerator,
    private readonly payments: PaymentsService,
  ) {}

  private load(id: string) {
    return this.prisma.order.findUniqueOrThrow({ where: { id }, include: orderInclude }) as Promise<FullOrder>;
  }

  private canView(user: AuthUser, o: FullOrder) {
    if (user.role === 'ADMIN') return true;
    if (user.role === 'CUSTOMER') return o.customerId === user.id;
    // Drivers only see orders currently assigned to them.
    return !!user.driverProfile && o.delivery?.driverId === user.driverProfile.id && o.delivery.status !== 'CANCELLED';
  }

  async list(user: AuthUser, statuses: string[], q?: string, paging: PageQuery = {}, filters: { serviceAreaId?: string; driverId?: string } = {}) {
    const { serviceAreaId, driverId } = filters;
    const { limit, args } = pageArgs(paging, 100);
    const scope: Prisma.OrderWhereInput =
      user.role === 'ADMIN'
        ? {}
        : user.role === 'CUSTOMER'
          ? { customerId: user.id }
          : { delivery: { driverId: user.driverProfile?.id ?? '__none__', status: { not: 'CANCELLED' } } };

    const numeric = q && /^\s*#?(gd)?\d+\s*$/i.test(q) ? Number(q.replace(/\D/g, '')) : null;
    const search: Prisma.OrderWhereInput = q
      ? {
          OR: [
            { contactName: { contains: q, mode: 'insensitive' } },
            { addrArea: { contains: q, mode: 'insensitive' } },
            ...(numeric ? [{ number: numeric }] : []),
          ],
        }
      : {};

    const orders = (await this.prisma.order.findMany({
      where: {
        AND: [
          scope,
          search,
          statuses.length ? { status: { in: statuses.map((s) => upperSnake(s) as OrderStatus) } } : {},
          serviceAreaId ? { serviceAreaId } : {},
          driverId ? { delivery: { driverId, status: { not: 'CANCELLED' } } } : {},
        ],
      },
      include: orderInclude,
      orderBy: [{ placedAt: 'desc' }, { id: 'desc' }],
      ...args,
    })) as FullOrder[];
    const page = toPage(orders, limit);
    return { items: page.items.map(orderOut), nextCursor: page.nextCursor };
  }

  async get(user: AuthUser, id: string) {
    const o = (await this.prisma.order.findUnique({ where: { id }, include: orderInclude })) as FullOrder | null;
    if (!o || !this.canView(user, o)) throw new NotFoundException('Order not found.');
    const customerOrderCount =
      user.role === 'ADMIN' ? await this.prisma.order.count({ where: { customerId: o.customerId } }) : undefined;
    return { order: orderOut(o), customerOrderCount, deliveryOtp: this.visibleOtp(user, o) };
  }

  /**
   * The delivery handover code, only for the order's customer (to tell the
   * driver) and admins (phone support). Never for drivers — they must get it
   * from the customer. Not part of orderOut, which is also broadcast to drivers.
   */
  private visibleOtp(user: AuthUser, o: FullOrder) {
    const d = o.delivery;
    if (!d?.otpCode || d.status !== 'IN_TRANSIT') return null;
    return user.role === 'ADMIN' || (user.role === 'CUSTOMER' && o.customerId === user.id) ? d.otpCode : null;
  }

  /**
   * Customer re-sends the delivery OTP by SMS (lost the message). Same code,
   * unless the driver was locked out by wrong guesses — then a fresh one.
   */
  async resendDeliveryOtp(customer: AuthUser, id: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { delivery: true } });
    if (!o || o.customerId !== customer.id) throw new NotFoundException('Order not found.');
    const d = o.delivery;
    if (!d || d.status !== 'IN_TRANSIT' || !d.otpCode) throw new ConflictException('The order is not out for delivery.');
    const wait = d.otpLastSentAt ? DELIVERY_OTP_RESEND_MS - (Date.now() - d.otpLastSentAt.getTime()) : 0;
    if (wait > 0) {
      throw new HttpException(
        { message: `Please wait ${Math.ceil(wait / 1000)} s before resending.`, code: 'too_many_requests', details: { retryAfterSec: Math.ceil(wait / 1000) } },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (d.otpSentCount >= DELIVERY_OTP_MAX_SENDS) {
      throw new HttpException(
        { message: 'The OTP was already sent several times. It is also shown in your app.', code: 'too_many_requests' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const locked = d.otpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS;
    const code = locked ? this.otp.code(DELIVERY_OTP_DIGITS) : d.otpCode;
    await this.prisma.delivery.update({
      where: { id: d.id },
      data: {
        otpCode: code,
        otpAttempts: locked ? 0 : undefined,
        otpSentCount: { increment: 1 },
        otpLastSentAt: new Date(),
      },
    });
    this.sms.deliveryOtp(o, code);
    return { deliveryOtp: code, resendAfterSec: DELIVERY_OTP_RESEND_MS / 1000, newCode: locked };
  }

  /** Customer tracking view: status timeline, driver and live position. */
  async tracking(user: AuthUser, id: string) {
    const { order } = await this.get(user, id);
    const o = await this.load(id);
    const d = o.delivery && o.delivery.status !== 'CANCELLED' ? o.delivery.driver : null;
    return {
      orderId: order.id,
      code: order.code,
      status: order.status,
      history: order.history,
      driver: order.driver,
      driverLocation:
        d?.lastLat != null && d.lastLng != null
          ? { lat: d.lastLat, lng: d.lastLng, at: d.lastLocationAt?.toISOString() ?? null }
          : null,
      destination: order.address.location,
      distanceKm: order.address.distanceKm,
      etaMinutes: etaMinutes(order.address.distanceKm),
    };
  }

  /**
   * Places an order from the customer's server-side cart in one transaction:
   * validates MOQ, reserves stock atomically, snapshots prices + address,
   * records history and inventory movements, then empties the cart.
   */
  async place(customer: AuthUser, addressId: string) {
    let awaiting = false;
    const order = await this.prisma.tx(async (tx) => {
      const address = await tx.address.findFirst({ where: { id: addressId, userId: customer.id, isDeleted: false } });
      if (!address) throw new BadRequestException('Please choose a valid delivery address.');
      // Re-check the geofence at checkout: the area may have been switched off since the address was saved.
      const coverage = await this.areas.require(address.lat, address.lng, tx);

      const cart = await tx.cart.findUnique({
        where: { userId: customer.id },
        include: { items: { include: { product: true }, orderBy: { addedAt: 'asc' } } },
      });
      const lines = cart?.items ?? [];
      if (lines.length === 0) throw new BadRequestException('Your cart is empty.');

      let subtotal = new Prisma.Decimal(0);
      const itemRows: Prisma.OrderItemCreateManyOrderInput[] = [];
      const reserved: { productId: string; qty: number; stockAfter: number }[] = [];

      for (const { product: p, qty } of lines) {
        if (!p.isActive) throw new BadRequestException(`${p.name} is no longer available. Remove it from your cart.`);
        if (qty < p.minOrderQty) throw new BadRequestException(`${p.name}: minimum order is ${p.minOrderQty} ${p.unit}s.`);
        let after;
        try {
          // Conditional update: fails if another order took the stock first.
          after = await tx.product.update({
            where: { id: p.id, stock: { gte: qty } },
            data: { stock: { decrement: qty } },
          });
        } catch (e) {
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
            const now = await tx.product.findUnique({ where: { id: p.id }, select: { stock: true } });
            throw new ConflictException(`${p.name}: only ${now?.stock ?? 0} ${p.unit}s left in stock.`);
          }
          throw e;
        }
        const total = lineTotal(p, qty);
        subtotal = subtotal.add(total);
        itemRows.push({
          productId: p.id,
          productName: p.name,
          unit: p.unit,
          qty,
          unitPrice: unitPrice(p, qty),
          lineTotal: total,
        });
        reserved.push({ productId: p.id, qty, stockAfter: after.stock });
      }

      const deliveryCharge = new Prisma.Decimal(deliveryChargeFor(coverage.distanceKm, deliveryTariffOf(coverage.area)));
      // With online payments on, the delivery charge is paid first; the order reaches the admin once paid.
      awaiting = this.payments.requiresPayment(deliveryCharge);
      const status: OrderStatus = awaiting ? 'AWAITING_PAYMENT' : 'PENDING';
      // Paid online: GST on the delivery charge + the gateway fee (admin settings), added to the total.
      const online = awaiting ? await this.payments.onlineCharges(deliveryCharge) : { tax: 0, fee: 0 };
      const deliveryTax = new Prisma.Decimal(online.tax);
      const paymentFee = new Prisma.Decimal(online.fee);
      const created = await tx.order.create({
        data: {
          status,
          paymentDueBy: awaiting ? new Date(Date.now() + this.payments.timeoutMin * 60_000) : null,
          customerId: customer.id,
          addressId: address.id,
          serviceAreaId: coverage.area.id,
          subtotal,
          deliveryCharge,
          deliveryTax,
          paymentFee,
          total: subtotal.add(deliveryCharge).add(deliveryTax).add(paymentFee),
          addrLabel: address.label,
          addrArea: address.area,
          addrLine: address.line,
          addrCity: address.city,
          addrPincode: address.pincode,
          addrLat: address.lat,
          addrLng: address.lng,
          distanceKm: coverage.distanceKm,
          contactName: address.contactName ?? customer.businessName ?? customer.name,
          contactPhone: address.contactPhone ?? customer.phone ?? '',
          items: { createMany: { data: itemRows } },
          history: { create: { status, actorId: customer.id } },
        },
      });
      await tx.inventoryMovement.createMany({
        data: reserved.map((r) => ({
          productId: r.productId,
          delta: -r.qty,
          stockAfter: r.stockAfter,
          reason: 'ORDER_RESERVED' as const,
          orderId: created.id,
          actorId: customer.id,
        })),
      });
      await tx.cartItem.deleteMany({ where: { cartId: cart!.id } });
      return created;
    });

    let checkout: CheckoutSession | null = null;
    if (awaiting) {
      // If Razorpay is unreachable the order still exists; the app offers "Pay now" to retry.
      checkout = await this.payments.checkout(customer, order.id).catch(() => null);
    }
    const full = await this.load(order.id);
    this.realtime.orderUpdated(full);
    for (const i of full.items) this.realtime.catalogUpdated(i.productId);
    if (!awaiting) this.sms.orderPlaced(full); // otherwise sent once paid
    await this.alertLowStock(full);
    return { order: orderOut(full), checkout };
  }

  async confirm(admin: AuthUser, id: string) {
    await this.prisma.tx(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id } });
      const to = assertTransition('confirm', o.status, admin.role);
      await moveOrder(tx, id, o.status, to, admin.id, 'by GD Kite Center');
    });
    return this.emit(id, (o) => this.sms.orderConfirmed(o));
  }

  /** Assigns (or re-assigns) a driver and fixes the fare from distance. */
  async assign(admin: AuthUser, id: string, driverId: string) {
    let previousDriver: string | null = null;
    await this.prisma.tx(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id }, include: { delivery: true, serviceArea: true } });
      const to = assertTransition('assign', o.status, admin.role);
      const driver = await tx.driverProfile.findUnique({
        where: { id: driverId },
        include: { user: true, vehicleType: true },
      });
      if (!driver || !driver.user.isActive) throw new NotFoundException('Driver not found.');
      if (driver.availability === 'OFFLINE') throw new ConflictException(`${driver.user.name} is offline.`);
      if (driver.serviceAreaId && o.serviceAreaId && driver.serviceAreaId !== o.serviceAreaId) {
        throw new ConflictException(`${driver.user.name} works in a different service area.`);
      }
      if (o.delivery?.driverId === driverId && o.delivery.status === 'ASSIGNED') {
        throw new ConflictException(`${driver.user.name} is already assigned to this order.`);
      }
      previousDriver = o.delivery && o.delivery.status !== 'CANCELLED' ? o.delivery.driverId : null;
      // Fare = this driver's rate (vehicle type or custom) × distance, snapshotted on the delivery.
      const fare = new Prisma.Decimal(driverFareFor(o.distanceKm, driverTariffOf(driver).tariff));
      await tx.delivery.upsert({
        where: { orderId: id },
        create: { orderId: id, driverId, fare, status: 'ASSIGNED' },
        update: { driverId, fare, status: 'ASSIGNED', assignedAt: new Date(), startedAt: null },
      });
      await moveOrder(tx, id, o.status, to, admin.id, driver.user.name);
    });
    if (previousDriver && previousDriver !== driverId) this.realtime.orderRevoked(previousDriver, id);
    const replaced: string | null = previousDriver;
    return this.emit(id, (o) => this.sms.driverAssigned(o, replaced));
  }

  async reject(admin: AuthUser, id: string, reason: string) {
    return this.cancelInternal(admin, id, 'reject', reason);
  }

  async cancelByCustomer(customer: AuthUser, id: string) {
    const o = await this.prisma.order.findUnique({ where: { id } });
    if (!o || o.customerId !== customer.id) throw new NotFoundException('Order not found.');
    return this.cancelInternal(customer, id, 'cancel', 'Cancelled by customer');
  }

  private async cancelInternal(actor: AuthUser, id: string, action: 'reject' | 'cancel', reason: string) {
    let freed: Awaited<ReturnType<typeof refreshDriverAvailability>> | null = null;
    let revokedDriver: string | null = null;
    await this.prisma.tx(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id }, include: { delivery: true } });
      const to = assertTransition(action, o.status, actor.role);
      await moveOrder(tx, id, o.status, to, actor.id, reason, { rejectionReason: reason });
      if (STOCK_RESERVED.includes(o.status)) await releaseStock(tx, id, actor.id);
      if (o.delivery && o.delivery.status !== 'CANCELLED') {
        await tx.delivery.update({ where: { id: o.delivery.id }, data: { status: 'CANCELLED' } });
        revokedDriver = o.delivery.driverId;
        freed = await refreshDriverAvailability(tx, o.delivery.driverId);
      }
    });
    if (revokedDriver) this.realtime.orderRevoked(revokedDriver, id);
    if (freed) this.realtime.driverUpdated(freed);
    const revoked: string | null = revokedDriver;
    const refunded = await this.payments.refundPaid(id, reason);
    const told = refunded > 0 ? `${reason}. Your delivery charge of Rs ${refunded} will be refunded in 5-7 working days` : reason;
    return this.emit(id, (o) => this.sms.orderCancelled(o, told, revoked));
  }

  private async emit(id: string, notify?: (o: FullOrder) => void) {
    const full = await this.load(id);
    this.realtime.orderUpdated(full);
    notify?.(full);
    return orderOut(full);
  }

  /** SMS admins about products this order pushed to (or below) their low-stock threshold. */
  private async alertLowStock(o: FullOrder) {
    const ordered = new Map<string, number>();
    for (const i of o.items) ordered.set(i.productId, (ordered.get(i.productId) ?? 0) + i.qty);
    const products = await this.prisma.product.findMany({ where: { id: { in: [...ordered.keys()] } } });
    const crossed = products.filter(
      (p) => p.stock <= p.lowStockThreshold && p.stock + (ordered.get(p.id) ?? 0) > p.lowStockThreshold,
    );
    if (crossed.length) this.sms.lowStock(crossed);
  }
}
