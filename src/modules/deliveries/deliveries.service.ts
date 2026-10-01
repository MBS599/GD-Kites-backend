import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/auth.decorators';
import { orderInclude, orderOut, type FullOrder } from '../../common/serializers';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig } from '../../config/app-config.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SmsService } from '../sms/sms.service';
import { OtpGenerator, sameHash } from '../sms/otp';
import { RoutingService } from '../routing/routing.service';
import { assertTransition, moveOrder, refreshDriverAvailability } from '../orders/order-workflow';

const MAX_PROOF_PHOTOS = 5;
export const DELIVERY_OTP_DIGITS = 4;
/** Wrong delivery codes before the driver is locked out (the customer can then resend a new code). */
export const DELIVERY_OTP_MAX_ATTEMPTS = 5;
/** A driver position older than this is ignored and the route starts at the hub. */
const LIVE_LOCATION_MAX_AGE_MS = 30 * 60 * 1000;

@Injectable()
export class DeliveriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly routing: RoutingService,
    private readonly config: AppConfig,
    private readonly sms: SmsService,
    private readonly otp: OtpGenerator,
  ) {}

  /** Loads a delivery by order id, only if it belongs to this driver (404 otherwise). */
  private async own(driverId: string, orderId: string) {
    const d = await this.prisma.delivery.findUnique({ where: { orderId } });
    if (!d || d.driverId !== driverId || d.status === 'CANCELLED') throw new NotFoundException('Delivery not found.');
    return d;
  }

  async list(driverId: string, scope: 'active' | 'completed' | 'all') {
    const statuses =
      scope === 'active' ? (['ASSIGNED', 'IN_TRANSIT'] as const) : scope === 'completed' ? (['DELIVERED'] as const) : (['ASSIGNED', 'IN_TRANSIT', 'DELIVERED'] as const);
    const orders = (await this.prisma.order.findMany({
      where: { delivery: { driverId, status: { in: [...statuses] } } },
      include: orderInclude,
      orderBy: { placedAt: 'desc' },
      take: 100,
    })) as FullOrder[];
    return orders.map(orderOut);
  }

  async detail(driverId: string, orderId: string) {
    await this.own(driverId, orderId);
    return orderOut((await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })) as FullOrder);
  }

  async start(user: AuthUser, driverId: string, orderId: string) {
    await this.own(driverId, orderId);
    const otp = this.otp.code(DELIVERY_OTP_DIGITS);
    const driver = await this.prisma.tx(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
      const to = assertTransition('start', o.status, user.role);
      await moveOrder(tx, orderId, o.status, to, user.id);
      await tx.delivery.update({
        where: { orderId },
        data: {
          status: 'IN_TRANSIT',
          startedAt: new Date(),
          // Handover code: the customer tells it to the driver on delivery.
          otpCode: otp,
          otpAttempts: 0,
          otpSentCount: 1,
          otpLastSentAt: new Date(),
          otpVerifiedAt: null,
        },
      });
      return refreshDriverAvailability(tx, driverId);
    });
    this.realtime.driverUpdated(driver);
    return this.emit(orderId, (o) => this.sms.outForDelivery(o, otp));
  }

  /** Attaches an already-stored proof photo to the delivery. */
  async addProof(driverId: string, orderId: string, url: string) {
    const d = await this.own(driverId, orderId);
    if (d.status !== 'IN_TRANSIT') throw new ConflictException('Start the delivery before uploading proof.');
    if (d.proofPhotoUrls.length >= MAX_PROOF_PHOTOS) throw new BadRequestException(`At most ${MAX_PROOF_PHOTOS} photos.`);
    const updated = await this.prisma.delivery.update({
      where: { orderId },
      data: { proofPhotoUrls: { push: url } },
    });
    return { url, photoUrls: updated.proofPhotoUrls };
  }

  async complete(
    user: AuthUser,
    driverId: string,
    orderId: string,
    input: { customerReceived: boolean; cashCollected: boolean; otp?: string },
  ) {
    if (!input.customerReceived) throw new BadRequestException('Confirm that the customer received the order.');
    if (!input.cashCollected) throw new BadRequestException('Confirm that cash on delivery was collected.');
    const d = await this.own(driverId, orderId);
    if (d.proofPhotoUrls.length === 0) throw new BadRequestException('Upload at least one proof-of-delivery photo.');
    await this.checkOtp(d, input.otp);

    const driver = await this.prisma.tx(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
      const to = assertTransition('complete', o.status, user.role);
      const now = new Date();
      await moveOrder(tx, orderId, o.status, to, user.id, null, { deliveredAt: now });
      await tx.delivery.update({
        where: { orderId },
        data: {
          status: 'DELIVERED',
          completedAt: now,
          customerReceived: true,
          cashCollected: true,
          otpVerifiedAt: d.otpCode ? now : null,
        },
      });
      for (const productId of new Set(o.items.map((i) => i.productId))) {
        await tx.product.update({ where: { id: productId }, data: { buyerCount: { increment: 1 } } });
      }
      return refreshDriverAvailability(tx, driverId);
    });
    this.realtime.driverUpdated(driver);
    return this.emit(orderId, (o) => this.sms.orderDelivered(o));
  }

  /**
   * The customer's handover code must match. Wrong codes are counted; after
   * DELIVERY_OTP_MAX_ATTEMPTS the customer has to send a fresh code.
   * Deliveries started before OTPs existed (no code) skip the check.
   */
  private async checkOtp(d: { id: string; otpCode: string | null; otpAttempts: number }, otp?: string) {
    if (!d.otpCode) return;
    if (d.otpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS) {
      throw new HttpException(
        { message: 'Too many wrong codes. Ask the customer to resend the OTP from their app.', code: 'otp_locked' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!otp) throw new BadRequestException('Enter the 4-digit delivery OTP from the customer.');
    if (!sameHash(otp, d.otpCode)) {
      // Conditional increment so parallel wrong guesses can't exceed the limit.
      const bumped = await this.prisma.delivery.updateMany({
        where: { id: d.id, otpAttempts: { lt: DELIVERY_OTP_MAX_ATTEMPTS } },
        data: { otpAttempts: { increment: 1 } },
      });
      const left = DELIVERY_OTP_MAX_ATTEMPTS - d.otpAttempts - 1;
      if (bumped.count === 0 || left <= 0) {
        throw new HttpException(
          { message: 'Too many wrong codes. Ask the customer to resend the OTP from their app.', code: 'otp_locked' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        { message: `Wrong delivery OTP. ${left} ${left === 1 ? 'attempt' : 'attempts'} left.`, code: 'otp_invalid' },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Today's route for a driver: open deliveries in the best order on real
   * roads, starting from the driver's live position (if fresh) or their hub.
   * A delivery already in transit stays first; the rest are optimised after it.
   */
  async route(driverId: string) {
    const driver = await this.prisma.driverProfile.findUniqueOrThrow({
      where: { id: driverId },
      include: { serviceArea: true },
    });
    const orders = (await this.prisma.order.findMany({
      where: { delivery: { driverId, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } } },
      include: orderInclude,
      orderBy: { placedAt: 'asc' },
    })) as FullOrder[];

    const fresh = driver.lastLocationAt && Date.now() - driver.lastLocationAt.getTime() < LIVE_LOCATION_MAX_AGE_MS;
    const area = driver.serviceArea ?? orders[0]?.serviceArea ?? null;
    const origin =
      fresh && driver.lastLat != null && driver.lastLng != null
        ? { lat: driver.lastLat, lng: driver.lastLng, source: 'driver' as const, label: 'Your location' }
        : {
            lat: area?.hubLat ?? this.config.hub.lat,
            lng: area?.hubLng ?? this.config.hub.lng,
            source: 'hub' as const,
            label: area?.hubName ?? 'Hub',
          };

    const pt = (o: FullOrder) => ({ lat: o.addrLat, lng: o.addrLng });
    const inTransit = orders.filter((o) => o.delivery?.status === 'IN_TRANSIT');
    const pending = orders.filter((o) => o.delivery?.status !== 'IN_TRANSIT');

    // Visit in-transit deliveries first (in their own best order), then the rest from the last of those.
    const first = await this.routing.planTrip(origin, inTransit.map(pt));
    const firstOrdered = first.order.map((i) => inTransit[i]);
    const restOrigin = firstOrdered.length ? pt(firstOrdered[firstOrdered.length - 1]) : origin;
    const rest = await this.routing.planTrip(restOrigin, pending.map(pt));
    const ordered = [...firstOrdered, ...rest.order.map((i) => pending[i])];
    const legs = [...first.legs, ...rest.legs];

    let elapsed = 0;
    const stops = ordered.map((o, i) => {
      elapsed += legs[i]?.durationMin ?? 0;
      return {
        sequence: i + 1,
        legDistanceKm: legs[i]?.distanceKm ?? 0,
        legDurationMin: legs[i]?.durationMin ?? 0,
        arrivalMinutes: elapsed,
        order: orderOut(o),
      };
    });
    const geometry = firstOrdered.length ? [...first.geometry, ...rest.geometry.slice(1)] : rest.geometry;

    return {
      origin,
      stops,
      totalDistanceKm: Math.round((first.totalDistanceKm + rest.totalDistanceKm) * 10) / 10,
      totalDurationMin: first.totalDurationMin + rest.totalDurationMin,
      totalFare: ordered.reduce((s, o) => s + (o.delivery?.fare.toNumber() ?? 0), 0),
      geometry,
      optimized: first.optimized && rest.optimized,
      provider: rest.optimized ? rest.provider : 'fallback',
    };
  }

  private async emit(orderId: string, notify?: (o: FullOrder) => void) {
    const full = (await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude })) as FullOrder;
    this.realtime.orderUpdated(full);
    notify?.(full);
    return orderOut(full);
  }
}
