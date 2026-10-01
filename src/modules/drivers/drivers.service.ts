import { pageArgs, toPage, type PageQuery } from '../../common/paging';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type DriverType } from '@prisma/client';
import { driverInclude, driverOut, orderInclude, orderOut, type DriverWithUser, type FullOrder } from '../../common/serializers';
import { startOfToday } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SmsService } from '../sms/sms.service';

@Injectable()
export class DriversService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly sms: SmsService,
  ) {}

  async withCounts(drivers: DriverWithUser[]) {
    const ids = drivers.map((d) => d.id);
    const today = startOfToday();
    const [active, doneToday] = await Promise.all([
      this.prisma.delivery.groupBy({
        by: ['driverId'],
        where: { driverId: { in: ids }, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } },
        _count: { _all: true },
      }),
      this.prisma.delivery.groupBy({
        by: ['driverId'],
        where: { driverId: { in: ids }, status: 'DELIVERED', completedAt: { gte: today } },
        _count: { _all: true },
      }),
    ]);
    const count = (rows: { driverId: string; _count: { _all: number } }[], id: string) =>
      rows.find((r) => r.driverId === id)?._count._all ?? 0;
    return drivers.map((d) =>
      driverOut(d, {
        activeDeliveries: count(active, d.id),
        deliveriesToday: count(active, d.id) + count(doneToday, d.id),
      }),
    );
  }

  /** Driver dashboard: profile plus today's numbers. */
  async dashboard(driverId: string) {
    const driver = await this.prisma.driverProfile.findUniqueOrThrow({ where: { id: driverId }, include: driverInclude });
    const today = startOfToday();
    const [pending, completedToday, completedTotal, earnings] = await Promise.all([
      this.prisma.delivery.count({ where: { driverId, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } } }),
      this.prisma.delivery.count({ where: { driverId, status: 'DELIVERED', completedAt: { gte: today } } }),
      this.prisma.delivery.count({ where: { driverId, status: 'DELIVERED' } }),
      this.prisma.delivery.aggregate({
        where: { driverId, status: 'DELIVERED', completedAt: { gte: today } },
        _sum: { fare: true },
      }),
    ]);
    const [out] = await this.withCounts([driver]);
    return {
      driver: out,
      stats: {
        deliveriesToday: pending + completedToday,
        pending,
        completedToday,
        completedTotal,
        earningsToday: earnings._sum.fare?.toNumber() ?? 0,
      },
    };
  }

  async setAvailability(driverId: string, available: boolean) {
    const onRoad = await this.prisma.delivery.count({ where: { driverId, status: 'IN_TRANSIT' } });
    if (!available && onRoad > 0) throw new ConflictException('Finish your active delivery before going offline.');
    const updated = await this.prisma.driverProfile.update({
      where: { id: driverId },
      data: { availability: !available ? 'OFFLINE' : onRoad > 0 ? 'ON_DELIVERY' : 'AVAILABLE' },
      include: driverInclude,
    });
    this.realtime.driverUpdated(updated);
    const [out] = await this.withCounts([updated]);
    return out;
  }

  /** Stores the latest position and forwards it to admins and customers with an order on the road. */
  /**
   * Stores and broadcasts a driver position. Ignored while the driver is
   * offline — drivers are only tracked when on duty.
   */
  async updateLocation(driverId: string, lat: number, lng: number) {
    const at = new Date();
    const { count } = await this.prisma.driverProfile.updateMany({
      where: { id: driverId, availability: { not: 'OFFLINE' } },
      data: { lastLat: lat, lastLng: lng, lastLocationAt: at },
    });
    if (count === 0) return null;
    const onRoad = await this.prisma.delivery.findMany({
      where: { driverId, status: 'IN_TRANSIT' },
      select: { order: { select: { customerId: true } } },
    });
    this.realtime.driverLocation(
      driverId,
      onRoad.map((d) => d.order.customerId),
      { lat, lng, at: at.toISOString() },
    );
    return { lat, lng, at: at.toISOString() };
  }

  async list(serviceAreaId?: string, paging: PageQuery = {}) {
    const { limit, args } = pageArgs(paging);
    const drivers = await this.prisma.driverProfile.findMany({
      where: { user: { isActive: true }, ...(serviceAreaId ? { serviceAreaId } : {}) },
      include: driverInclude,
      orderBy: [{ user: { name: 'asc' } }, { id: 'asc' }],
      ...args,
    });
    const page = toPage(drivers, limit);
    return { items: await this.withCounts(page.items), nextCursor: page.nextCursor };
  }

  async detail(id: string) {
    const driver = await this.prisma.driverProfile.findUnique({ where: { id }, include: driverInclude });
    if (!driver) throw new NotFoundException('Driver not found.');
    // Open deliveries only (few); completed history is paged via GET /orders?driverId=.
    const [orders, done] = await Promise.all([
      this.prisma.order.findMany({
        where: { delivery: { driverId: id, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } } },
        include: orderInclude,
        orderBy: { placedAt: 'desc' },
      }) as Promise<FullOrder[]>,
      this.prisma.delivery.aggregate({
        where: { driverId: id, status: 'DELIVERED' },
        _count: { _all: true },
        _sum: { fare: true },
      }),
    ]);
    const [out] = await this.withCounts([driver]);
    return {
      driver: out,
      orders: orders.map(orderOut),
      totals: { completedDeliveries: done._count._all, totalFares: Number(done._sum.fare ?? 0) },
    };
  }

  /**
   * Registers a driver by Google email. The person then signs in with that
   * Google account and receives the DRIVER role — never self-selected.
   */
  /** Moves a driver to another service area (admin). */
  async setServiceArea(id: string, serviceAreaId: string) {
    const area = await this.prisma.serviceArea.findUnique({ where: { id: serviceAreaId } });
    if (!area) throw new NotFoundException('Service area not found.');
    const open = await this.prisma.delivery.count({ where: { driverId: id, status: { in: ['ASSIGNED', 'IN_TRANSIT'] } } });
    if (open > 0) throw new ConflictException('Reassign or finish this driver’s open deliveries first.');
    const driver = await this.prisma.driverProfile.update({
      where: { id },
      data: { serviceAreaId, hub: area.hubName },
      include: driverInclude,
    });
    this.realtime.driverUpdated(driver);
    this.sms.driverWelcome(driver.user);
    const [out] = await this.withCounts([driver]);
    return out;
  }

  async create(input: {
    name: string;
    email: string;
    phone: string;
    type: DriverType;
    vehicleNumber: string;
    serviceAreaId?: string;
    vehicleTypeId?: string;
  }) {
    const email = input.email.toLowerCase();
    const area = input.serviceAreaId
      ? await this.prisma.serviceArea.findUnique({ where: { id: input.serviceAreaId } })
      : await this.prisma.serviceArea.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
    if (input.serviceAreaId && !area) throw new NotFoundException('Service area not found.');
    const vehicle = input.vehicleTypeId
      ? await this.prisma.vehicleType.findUnique({ where: { id: input.vehicleTypeId } })
      : await this.prisma.vehicleType.findFirst({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    if (input.vehicleTypeId && !vehicle) throw new NotFoundException('Vehicle type not found.');
    const driver = await this.prisma.tx(async (tx) => {
      const existing = await tx.user.findUnique({ where: { email }, include: { driverProfile: true } });
      if (existing?.role === 'ADMIN') throw new ConflictException('This email belongs to an admin account.');
      if (existing?.driverProfile) throw new ConflictException('This person is already registered as a driver.');
      const user = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { role: 'DRIVER', phone: input.phone } })
        : await tx.user.create({ data: { email, name: input.name.trim(), phone: input.phone, role: 'DRIVER' } });
      return tx.driverProfile.create({
        data: {
          userId: user.id,
          type: input.type,
          vehicleNumber: input.vehicleNumber.trim().toUpperCase(),
          serviceAreaId: area?.id ?? null,
          vehicleTypeId: vehicle?.id ?? null,
          hub: area?.hubName ?? 'Hub',
        },
        include: driverInclude,
      });
    });
    this.realtime.driverUpdated(driver);
    const [out] = await this.withCounts([driver]);
    return out;
  }

  /**
   * Admin edit: vehicle type/number, driver type, or a per-driver custom fare.
   * Fare changes apply to future assignments only.
   */
  async update(
    id: string,
    input: {
      vehicleTypeId?: string;
      vehicleNumber?: string;
      type?: DriverType;
      customBaseFare?: number | null;
      customPerKm?: number | null;
    },
  ) {
    const existing = await this.prisma.driverProfile.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Driver not found.');
    if (input.vehicleTypeId) {
      const v = await this.prisma.vehicleType.findUnique({ where: { id: input.vehicleTypeId } });
      if (!v) throw new NotFoundException('Vehicle type not found.');
    }
    const touchesCustom = input.customBaseFare !== undefined || input.customPerKm !== undefined;
    if (touchesCustom && (input.customBaseFare == null) !== (input.customPerKm == null)) {
      throw new BadRequestException('Set both custom base fare and per-km rate, or clear both.');
    }
    const driver = await this.prisma.driverProfile.update({
      where: { id },
      data: {
        vehicleTypeId: input.vehicleTypeId,
        vehicleNumber: input.vehicleNumber?.trim().toUpperCase(),
        type: input.type,
        ...(touchesCustom
          ? {
              customBaseFare: input.customBaseFare == null ? null : new Prisma.Decimal(input.customBaseFare),
              customPerKm: input.customPerKm == null ? null : new Prisma.Decimal(input.customPerKm),
            }
          : {}),
      },
      include: driverInclude,
    });
    this.realtime.driverUpdated(driver);
    const [out] = await this.withCounts([driver]);
    return out;
  }
}
