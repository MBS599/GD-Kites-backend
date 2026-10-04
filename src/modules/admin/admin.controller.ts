import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth.decorators';
import { startOfToday, startOfYesterday } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';

@ApiTags('Admin')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(private readonly prisma: PrismaService) {}

  /** Business overview for the admin dashboard. Money values are rupees. */
  @Get('dashboard')
  async dashboard() {
    const today = startOfToday();
    const yesterday = startOfYesterday();
    const live = { status: { not: 'CANCELLED' as const } };

    const [salesToday, salesYesterday, totalSales, ordersToday, pending, awaitingDriver, activeDeliveries, completedToday] =
      await Promise.all([
        this.prisma.order.aggregate({ where: { ...live, placedAt: { gte: today } }, _sum: { total: true } }),
        this.prisma.order.aggregate({ where: { ...live, placedAt: { gte: yesterday, lt: today } }, _sum: { total: true } }),
        this.prisma.order.aggregate({ where: { status: 'DELIVERED' }, _sum: { total: true } }),
        this.prisma.order.count({ where: { placedAt: { gte: today } } }),
        this.prisma.order.count({ where: { status: 'PENDING' } }),
        this.prisma.order.count({ where: { status: 'CONFIRMED' } }),
        this.prisma.order.count({ where: { status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } } }),
        this.prisma.order.count({ where: { status: 'DELIVERED', deliveredAt: { gte: today } } })
      ]);

    const t = salesToday._sum.total?.toNumber() ?? 0;
    const y = salesYesterday._sum.total?.toNumber() ?? 0;
    return {
      stats: {
        salesToday: t,
        salesYesterday: y,
        salesChangePct: y === 0 ? null : Math.round(((t - y) / y) * 100),
        totalSales: totalSales._sum.total?.toNumber() ?? 0,
        ordersToday,
        pending,
        awaitingDriver,
        activeDeliveries,
        completedToday,
      },
    };
  }
}
