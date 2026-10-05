import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthUser } from '../../common/auth.decorators';
import { driverTariffOf } from '../../common/rates';
import { orderCode } from '../../common/serializers';
import { centroid, groupNearby, nearestBetween, type GeoPoint } from '../../domain/dispatch';
import { haversineKm } from '../../domain/geo';
import { driverFareFor } from '../../domain/pricing';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { OrdersService } from './orders.service';

/** A driver position older than this is not used for suggestions. */
const FRESH_LOCATION_MS = 30 * 60_000;

export interface DispatchOptions {
  serviceAreaId?: string;
  /** Most orders suggested for one driver. */
  maxPerDriver: number;
  /** Orders join a group only within this distance (km) of its first (oldest) order. */
  radiusKm: number;
}

type DriverRow = Awaited<ReturnType<DispatchService['loadDrivers']>>[number];

/**
 * Dispatch planning for admins: the oldest confirmed order starts a group, the
 * orders nearest to it join (within a radius, up to a per-driver limit), and
 * one driver is suggested for the whole group with its optimised route — so a
 * neighbourhood goes to one driver instead of being spread across drivers.
 */
@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly orders: OrdersService,
  ) {}

  async plan(opts: DispatchOptions) {
    const orders = await this.prisma.order.findMany({
      where: { status: 'CONFIRMED', ...(opts.serviceAreaId ? { serviceAreaId: opts.serviceAreaId } : {}) },
      include: { serviceArea: true },
      orderBy: { placedAt: 'asc' },
    });
    const drivers = await this.loadDrivers(opts.serviceAreaId);
    const taken = new Set<string>();
    const groups = [];

    // Never mix service areas: each area has its own hub and drivers.
    const byArea = new Map<string, typeof orders>();
    for (const o of orders) {
      const key = o.serviceAreaId ?? 'none';
      byArea.set(key, [...(byArea.get(key) ?? []), o]);
    }

    for (const [areaId, areaOrders] of byArea) {
      const area = areaOrders[0].serviceArea;
      const hub: GeoPoint = area ? { lat: area.hubLat, lng: area.hubLng } : { lat: areaOrders[0].addrLat, lng: areaOrders[0].addrLng };
      const points = areaOrders.map((o) => ({ lat: o.addrLat, lng: o.addrLng }));
      // Orders are oldest first, so the oldest waiting order starts each group.
      const indexGroups = groupNearby(points, { maxPerGroup: opts.maxPerDriver, radiusKm: opts.radiusKm });

      for (const idx of indexGroups) {
        const members = idx.map((i) => areaOrders[i]);
        const stops = idx.map((i) => points[i]);
        // Round trip: out from the hub, every stop, back to the hub.
        const trip = await this.routing.planTrip(hub, stops, hub);
        const ordered = trip.order.map((i) => members[i]);
        const candidates = drivers.filter((d) => (areaId === 'none' || d.serviceAreaId === areaId) && !taken.has(d.id));
        const ranked = this.rank(candidates, stops, hub, opts.maxPerDriver);
        const best = ranked[0];
        if (best) taken.add(best.driver.id);

        groups.push({
          id: ordered.map((o) => o.id).join(','),
          serviceArea: area ? { id: area.id, name: area.name } : null,
          // Named after the order that started the group (the oldest).
          area: members[0].addrArea,
          orders: ordered.map((o) => ({
            id: o.id,
            code: orderCode(o.number),
            customerName: o.contactName,
            area: o.addrArea,
            location: { lat: o.addrLat, lng: o.addrLng },
            distanceKm: o.distanceKm,
          })),
          hub,
          route: {
            // Totals include the drive back to the hub (`returnDistanceKm`).
            distanceKm: round1(trip.totalDistanceKm),
            durationMin: Math.round(trip.totalDurationMin),
            returnDistanceKm: round1(trip.returnLeg?.distanceKm ?? 0),
            geometry: trip.geometry,
            optimized: trip.optimized,
          },
          suggestedDriver: best ? this.driverOut(best, ordered) : null,
          // Next-best options for the dropdown (not reserved for this group).
          otherDrivers: ranked.slice(1, 4).map((r) => this.driverOut(r, ordered)),
        });
      }
    }

    return {
      groups,
      totals: { orders: orders.length, groups: groups.length, withoutDriver: groups.filter((g) => !g.suggestedDriver).length },
    };
  }

  /** Assigns every order of a group to one driver (each through the normal assign rules). */
  async assignGroup(admin: AuthUser, driverId: string, orderIds: string[]) {
    const results: { orderId: string; ok: boolean; error?: string }[] = [];
    for (const id of orderIds) {
      try {
        await this.orders.assign(admin, id, driverId);
        results.push({ orderId: id, ok: true });
      } catch (e) {
        results.push({ orderId: id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { assigned: results.filter((r) => r.ok).length, results };
  }

  /** Drivers ranked for one order: nearest to where they are already going first. */
  async suggestForOrder(orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: { serviceArea: true } });
    if (!o) throw new NotFoundException('Order not found.');
    const hub = o.serviceArea ? { lat: o.serviceArea.hubLat, lng: o.serviceArea.hubLng } : { lat: o.addrLat, lng: o.addrLng };
    const drivers = (await this.loadDrivers(o.serviceAreaId ?? undefined)).filter((d) => !o.serviceAreaId || d.serviceAreaId === o.serviceAreaId);
    return this.rank(drivers, [{ lat: o.addrLat, lng: o.addrLng }], hub, Number.MAX_SAFE_INTEGER).map((r) => ({
      driverId: r.driver.id,
      name: r.driver.user.name,
      distanceKm: round1(r.distanceKm),
      reason: r.reason,
      openDeliveries: r.driver.deliveries.length,
    }));
  }

  // ---------------------------------------------------------------- helpers

  private loadDrivers(serviceAreaId?: string) {
    return this.prisma.driverProfile.findMany({
      where: {
        availability: { not: 'OFFLINE' },
        isActive: true,
        user: { isActive: true },
        ...(serviceAreaId ? { serviceAreaId } : {}),
      },
      include: {
        user: true,
        vehicleType: true,
        deliveries: {
          where: { status: { in: ['ASSIGNED', 'IN_TRANSIT'] } },
          include: { order: { select: { addrLat: true, addrLng: true, addrArea: true } } },
        },
      },
    });
  }

  /**
   * Scores drivers for a set of stops. Lower is better:
   * - already delivering nearby → distance from their open stops (they are going there anyway)
   * - fresh live location       → distance from where they are + 2 km (needs a trip out)
   * - otherwise                 → distance from the hub + 2 km
   * A driver whose open jobs plus these would exceed the limit is pushed back.
   */
  private rank(drivers: DriverRow[], stops: GeoPoint[], hub: GeoPoint, maxPerDriver: number) {
    const now = Date.now();
    return drivers
      .map((driver) => {
        const open = driver.deliveries.map((d) => ({ lat: d.order.addrLat, lng: d.order.addrLng }));
        const fresh =
          driver.lastLat != null && driver.lastLng != null && driver.lastLocationAt && now - driver.lastLocationAt.getTime() < FRESH_LOCATION_MS;
        let distanceKm: number;
        let reason: string;
        let score: number;
        if (open.length) {
          distanceKm = nearestBetween(open, stops);
          // Name the area of the open delivery closest to these orders.
          const nearest = driver.deliveries
            .map((d) => ({ area: d.order.addrArea, km: nearestBetween([{ lat: d.order.addrLat, lng: d.order.addrLng }], stops) }))
            .sort((a, b) => a.km - b.km)[0];
          reason =
            distanceKm <= 3
              ? `Already delivering nearby (${nearest.area}, ${round1(distanceKm)} km)`
              : `Nearest open delivery ${round1(distanceKm)} km away (${nearest.area})`;
          score = distanceKm;
        } else if (fresh) {
          distanceKm = nearestBetween([{ lat: driver.lastLat!, lng: driver.lastLng! }], stops);
          reason = `Free · ${round1(distanceKm)} km from the area now`;
          score = distanceKm + 2;
        } else {
          distanceKm = haversineKm(hub.lat, hub.lng, centroid(stops).lat, centroid(stops).lng);
          reason = 'Free · starts from the hub';
          score = distanceKm + 2;
        }
        if (open.length + stops.length > maxPerDriver) {
          score += 100;
          reason += ` · already has ${open.length} open`;
        }
        return { driver, distanceKm, reason, score };
      })
      .sort((a, b) => a.score - b.score);
  }

  private driverOut(r: ReturnType<DispatchService['rank']>[number], orders: { distanceKm: number }[]) {
    const { tariff } = driverTariffOf(r.driver);
    return {
      id: r.driver.id,
      name: r.driver.user.name,
      vehicle: r.driver.vehicleType?.name ?? null,
      openDeliveries: r.driver.deliveries.length,
      reason: r.reason,
      // Same rule as assignment: fare per order from its distance and this driver's rate.
      fareTotal: orders.reduce((s, o) => s + driverFareFor(o.distanceKm, tariff), 0),
    };
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

