import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../../common/auth.decorators';
import { startOfToday } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';

export class RangeQuery {
  /** ISO date/time; defaults to 30 days ago. */
  @IsOptional() @Type(() => Date) @IsDate() from?: Date;
  /** ISO date/time (exclusive); defaults to now. */
  @IsOptional() @Type(() => Date) @IsDate() to?: Date;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

const range = (q: RangeQuery) => {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(startOfToday().getTime() - 29 * 86_400_000);
  if (from >= to) throw new BadRequestException('`from` must be before `to`.');
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new BadRequestException('Range cannot exceed one year.');
  return { from, to };
};

@ApiTags('Reports')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('reports')
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Daily sales (IST calendar days) for non-cancelled orders placed in the range. */
  @Get('sales')
  async sales(@Query() q: RangeQuery) {
    const { from, to } = range(q);
    const rows = await this.prisma.$queryRaw<
      { day: Date; orders: bigint; revenue: string | null; delivered: bigint; cancelled: bigint }[]
    >`
      SELECT date_trunc('day', "placedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') AS day,
             COUNT(*) FILTER (WHERE status <> 'CANCELLED')::bigint AS orders,
             SUM(total) FILTER (WHERE status <> 'CANCELLED')::text AS revenue,
             COUNT(*) FILTER (WHERE status = 'DELIVERED')::bigint AS delivered,
             COUNT(*) FILTER (WHERE status = 'CANCELLED')::bigint AS cancelled
      FROM "Order"
      WHERE "placedAt" >= ${from} AND "placedAt" < ${to}
      GROUP BY 1 ORDER BY 1`;
    const days = rows.map((r) => ({
      date: r.day.toISOString().slice(0, 10),
      orders: Number(r.orders),
      revenue: Number(r.revenue ?? 0),
      delivered: Number(r.delivered),
      cancelled: Number(r.cancelled),
    }));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totals: {
        orders: days.reduce((s, d) => s + d.orders, 0),
        revenue: days.reduce((s, d) => s + d.revenue, 0),
        delivered: days.reduce((s, d) => s + d.delivered, 0),
        cancelled: days.reduce((s, d) => s + d.cancelled, 0),
      },
      days,
    };
  }

  /** Best-selling products by quantity (non-cancelled orders). */
  @Get('products')
  async products(@Query() q: RangeQuery) {
    const { from, to } = range(q);
    const rows = await this.prisma.$queryRaw<{ productId: string; name: string; qty: bigint; revenue: string }[]>`
      SELECT i."productId", MAX(i."productName") AS name, SUM(i.qty)::bigint AS qty, SUM(i."lineTotal")::text AS revenue
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE o.status <> 'CANCELLED' AND o."placedAt" >= ${from} AND o."placedAt" < ${to}
      GROUP BY i."productId" ORDER BY qty DESC LIMIT ${q.limit ?? 20}`;
    return {
      products: rows.map((r) => ({ productId: r.productId, name: r.name, qty: Number(r.qty), revenue: Number(r.revenue) })),
    };
  }

  /** Completed deliveries and fares per driver. */
  @Get('drivers')
  async drivers(@Query() q: RangeQuery) {
    const { from, to } = range(q);
    const rows = await this.prisma.$queryRaw<
      { driverId: string; name: string; type: string; deliveries: bigint; fares: string | null }[]
    >`
      SELECT d.id AS "driverId", u.name, d.type::text AS type,
             COUNT(v.id)::bigint AS deliveries, SUM(v.fare)::text AS fares
      FROM "DriverProfile" d
      JOIN "User" u ON u.id = d."userId"
      LEFT JOIN "Delivery" v ON v."driverId" = d.id AND v.status = 'DELIVERED'
           AND v."completedAt" >= ${from} AND v."completedAt" < ${to}
      GROUP BY d.id, u.name, d.type ORDER BY deliveries DESC`;
    return {
      drivers: rows.map((r) => ({
        driverId: r.driverId,
        name: r.name,
        type: r.type === 'GD' ? 'gd' : 'external',
        deliveries: Number(r.deliveries),
        fares: Number(r.fares ?? 0),
      })),
    };
  }
}
