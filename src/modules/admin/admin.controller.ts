import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import { istDateKey, istDayStart, startOfToday } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export class DashboardQuery {
  /** First IST calendar day of the period (YYYY-MM-DD). Defaults to today. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' }) from?: string;
  /** Last IST calendar day of the period, inclusive (YYYY-MM-DD). Defaults to `from`. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' }) to?: string;
}

@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Business overview for the admin dashboard. Money values are rupees.
   * Sales and order counts cover the period [from, to] (whole IST days, default today) and are
   * compared with the same number of days just before it. Pending, awaiting-driver and active
   * deliveries are always "right now".
   */
  @Get('dashboard')
  async dashboard(@Query() q: DashboardQuery) {
    const fromKey = q.from ?? istDateKey(startOfToday());
    const toKey = q.to ?? fromKey;
    const start = istDayStart(fromKey);
    const end = new Date(istDayStart(toKey).getTime() + DAY_MS); // exclusive
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new BadRequestException('Invalid date.');
    if (end <= start) throw new BadRequestException('`from` must be on or before `to`.');
    if (end.getTime() - start.getTime() > 3 * 366 * DAY_MS) throw new BadRequestException('Pick a period of up to three years.');
    const prevStart = new Date(start.getTime() - (end.getTime() - start.getTime()));

    const live = { status: { not: 'CANCELLED' as const } };
    const inPeriod = { gte: start, lt: end };
    const [sales, previousSales, orders, cancelled, completed, delivered, fares, totalSales, pending, awaitingDriver, activeDeliveries] =
      await Promise.all([
        this.prisma.order.aggregate({ where: { ...live, placedAt: inPeriod }, _sum: { total: true } }),
        this.prisma.order.aggregate({ where: { ...live, placedAt: { gte: prevStart, lt: start } }, _sum: { total: true } }),
        this.prisma.order.count({ where: { ...live, placedAt: inPeriod } }),
        this.prisma.order.count({ where: { status: 'CANCELLED', placedAt: inPeriod } }),
        this.prisma.order.count({ where: { status: 'DELIVERED', deliveredAt: inPeriod } }),
        // Delivery earnings: what customers paid for delivery minus what drivers were paid,
        // for orders delivered in the period.
        this.prisma.order.aggregate({ where: { status: 'DELIVERED', deliveredAt: inPeriod }, _sum: { deliveryCharge: true } }),
        this.prisma.delivery.aggregate({ where: { status: 'DELIVERED', order: { deliveredAt: inPeriod } }, _sum: { fare: true } }),
        this.prisma.order.aggregate({ where: { status: 'DELIVERED' }, _sum: { total: true } }),
        this.prisma.order.count({ where: { status: 'PENDING' } }),
        this.prisma.order.count({ where: { status: 'CONFIRMED' } }),
        this.prisma.order.count({ where: { status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } } }),
      ]);

    // Goods profit: sale price minus cost price, for lines of non-cancelled orders placed in the period.
    const [margin] = await this.prisma.$queryRaw<{ profit: string | null; costed: string | null; uncosted: string | null }[]>`
      SELECT SUM(i."lineTotal" - i."unitCost" * i.qty) FILTER (WHERE i."unitCost" IS NOT NULL)::text AS profit,
             SUM(i."lineTotal") FILTER (WHERE i."unitCost" IS NOT NULL)::text AS costed,
             SUM(i."lineTotal") FILTER (WHERE i."unitCost" IS NULL)::text AS uncosted
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE o.status <> 'CANCELLED' AND o."placedAt" >= ${start} AND o."placedAt" < ${end}`;

    const s = sales._sum.total?.toNumber() ?? 0;
    const p = previousSales._sum.total?.toNumber() ?? 0;
    const deliveryCharges = delivered._sum.deliveryCharge?.toNumber() ?? 0;
    const driverFares = fares._sum.fare?.toNumber() ?? 0;
    return {
      stats: {
        period: { from: fromKey, to: toKey },
        sales: s,
        previousSales: p,
        salesChangePct: p === 0 ? null : Math.round(((s - p) / p) * 100),
        orders,
        completed,
        cancelled,
        deliveryCharges,
        driverFares,
        deliveryEarnings: Math.round((deliveryCharges - driverFares) * 100) / 100,
        /** Sale price minus cost price of the goods sold in the period. */
        profit: Number(margin?.profit ?? 0),
        /** Goods sales the profit covers, and goods sales without a cost price (not in profit). */
        costedSales: Number(margin?.costed ?? 0),
        salesWithoutCost: Number(margin?.uncosted ?? 0),
        totalSales: totalSales._sum.total?.toNumber() ?? 0,
        pending,
        awaitingDriver,
        activeDeliveries,
      },
    };
  }
}
