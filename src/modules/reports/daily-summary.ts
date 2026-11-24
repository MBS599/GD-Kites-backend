import { BadRequestException, Controller, Get, HttpCode, Injectable, Logger, Post, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/auth.decorators';
import { istDateKey, istDayStart, istHour } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';
import { renderSms } from '../sms/sms.templates';
import { normalizeIndianMobile, SmsService } from '../sms/sms.service';

const DAY_MS = 24 * 3600_000;
const rs = (n: number) => Math.round(n).toLocaleString('en-IN');
const num = (v: { toNumber(): number } | null | undefined) => v?.toNumber() ?? 0;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Db = Pick<PrismaService, 'order'>;

/** Sales of orders placed in [start, end) (not cancelled), split into app orders and shop counter bills. */
export async function salesBySource(prisma: Db, start: Date, end: Date) {
  const groups = await prisma.order.groupBy({
    by: ['deliveryMode'],
    where: { status: { not: 'CANCELLED' }, placedAt: { gte: start, lt: end } },
    _sum: { total: true },
    _count: true,
  });
  const pick = (shop: boolean) => {
    const gs = groups.filter((g) => (g.deliveryMode === 'COUNTER') === shop);
    return { sales: gs.reduce((a, g) => a + num(g._sum.total), 0), orders: gs.reduce((a, g) => a + g._count, 0) };
  };
  return { online: pick(false), shop: pick(true) };
}

/** Cash paid for orders delivered in [start, end), by who collected it (driver, shop counter, courier). */
export async function cashCollected(prisma: Db, start: Date, end: Date) {
  const delivered = await prisma.order.findMany({
    where: { status: 'DELIVERED', deliveredAt: { gte: start, lt: end } },
    select: { total: true, paidOnline: true, deliveryMode: true, delivery: { select: { driver: { select: { user: { select: { name: true } } } } } } },
  });
  const by = new Map<string, number>();
  for (const o of delivered) {
    const cash = num(o.total) - num(o.paidOnline);
    if (cash <= 0) continue;
    const who = o.deliveryMode === 'COUNTER' ? 'Shop counter' : (o.delivery?.driver.user.name ?? (o.deliveryMode === 'COURIER' ? 'Courier' : 'Other'));
    by.set(who, (by.get(who) ?? 0) + cash);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    delivered: delivered.length,
    total: r2([...by.values()].reduce((a, b) => a + b, 0)),
    by: [...by].map(([who, amount]) => ({ who, amount: r2(amount) })).sort((a, b) => b.amount - a.amount),
  };
}

/** The summary's numbers (sales as on the dashboard: orders placed that IST day, not cancelled). */
export interface DaySummary {
  date: string;
  sales: number;
  orders: number;
  previousSales: number;
  online: { sales: number; orders: number };
  shop: { sales: number; orders: number };
  /** Sale price minus cost price (null when no product has a cost price). */
  profit: number | null;
  cash: number;
  cashBy: { who: string; amount: number }[];
  delivered: number;
  cancelled: number;
  open: { toConfirm: number; needDriver: number; onTheWay: number; qrWaiting: number };
  top: { name: string; qty: number; unit: string; revenue: number }[];
}

/** Owner's numbers from the setting ("919860838860, 9822011122" → ["919860838860", "919822011122"]). */
export function summaryNumbers(setting: string | null | undefined) {
  return (setting ?? '')
    .split(/[,;]+/)
    .map((n) => normalizeIndianMobile(n))
    .filter((n): n is string => !!n);
}

/** The WhatsApp message variables, in the order of the dailySummary template. */
export function summaryVars(s: DaySummary): string[] {
  const change =
    s.previousSales > 0
      ? `, ${s.sales >= s.previousSales ? 'up' : 'down'} ${Math.abs(Math.round(((s.sales - s.previousSales) / s.previousSales) * 100))}% on yesterday`
      : '';
  const open = [
    s.open.toConfirm && `${s.open.toConfirm} to confirm`,
    s.open.needDriver && `${s.open.needDriver} need a driver`,
    s.open.onTheWay && `${s.open.onTheWay} out for delivery`,
    s.open.qrWaiting && plural(s.open.qrWaiting, 'QR order') + ' waiting',
  ].filter(Boolean);
  const d = new Date(`${s.date}T12:00:00Z`);
  const day = `${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}, ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  return [
    day,
    rs(s.sales),
    plural(s.orders, 'order') + change,
    rs(s.online.sales),
    plural(s.online.orders, 'order'),
    rs(s.shop.sales),
    plural(s.shop.orders, 'bill'),
    s.profit === null ? 'Profit: add cost prices to products to see it' : `Profit on goods: Rs ${rs(s.profit)}`,
    rs(s.cash),
    s.cashBy.length ? s.cashBy.map((c) => `${c.who} Rs ${rs(c.amount)}`).join(' · ') : 'No cash collected today',
    String(s.delivered),
    String(s.cancelled),
    open.length ? open.join(' · ') : 'nothing waiting',
    s.top.length
      ? s.top.map((t, i) => `${i + 1}) ${t.name}: ${t.qty.toLocaleString('en-IN')} ${t.unit}${t.qty === 1 ? '' : 's'}, Rs ${rs(t.revenue)}`).join(' · ')
      : 'No sales today',
  ];
}

/**
 * Sends the owner a sales summary on WhatsApp every night (Settings → Daily sales summary:
 * numbers and hour, default 10 PM IST). Checked every minute; the day it was sent is saved, so a
 * restart or a second server never sends it twice.
 */
@Injectable()
export class DailySummaryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DailySummary');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log.error(e)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Sends today's summary once the hour has come, if it hasn't gone yet. */
  async tick(now = new Date()) {
    const s = await this.prisma.appSettings.findUnique({ where: { id: 1 } });
    const to = summaryNumbers(s?.dailySummaryTo);
    if (!s || !to.length) return false;
    const today = istDateKey(now);
    if (istHour(now) < s.dailySummaryHour || s.dailySummarySentOn === today) return false;
    // Claim the day first, so only one sender goes ahead.
    const claimed = await this.prisma.appSettings.updateMany({
      where: { id: 1, OR: [{ dailySummarySentOn: null }, { dailySummarySentOn: { not: today } }] },
      data: { dailySummarySentOn: today },
    });
    if (!claimed.count) return false;
    await this.sms.dailySummary(to, summaryVars(await this.build(today)));
    this.log.log(`Daily summary for ${today} sent to ${to.length} number(s)`);
    return true;
  }

  /** The numbers for one IST day (YYYY-MM-DD). */
  async build(day: string): Promise<DaySummary> {
    const start = istDayStart(day);
    const end = new Date(start.getTime() + DAY_MS);
    const [source, previous, cancelled, cash, discounts, toConfirm, needDriver, onTheWay, qrWaiting] = await Promise.all([
      salesBySource(this.prisma, start, end),
      this.prisma.order.aggregate({
        where: { status: { not: 'CANCELLED' }, placedAt: { gte: new Date(start.getTime() - DAY_MS), lt: start } },
        _sum: { total: true },
      }),
      this.prisma.order.count({ where: { status: 'CANCELLED', placedAt: { gte: start, lt: end } } }),
      cashCollected(this.prisma, start, end),
      this.prisma.order.aggregate({ where: { status: { not: 'CANCELLED' }, placedAt: { gte: start, lt: end } }, _sum: { discount: true } }),
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.order.count({ where: { status: 'CONFIRMED' } }),
      this.prisma.order.count({ where: { status: { in: ['ASSIGNED', 'OUT_FOR_DELIVERY'] } } }),
      this.prisma.shopRequest.count({ where: { status: 'WAITING' } }),
    ]);
    // Profit as on the dashboard: sale price minus cost price, less offer discounts.
    const [margin] = await this.prisma.$queryRaw<{ profit: string | null }[]>`
      SELECT SUM(i."lineTotal" - i."unitCost" * i.qty) FILTER (WHERE i."unitCost" IS NOT NULL)::text AS profit
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE o.status <> 'CANCELLED' AND o."placedAt" >= ${start} AND o."placedAt" < ${end}`;
    const top = await this.prisma.$queryRaw<{ name: string; unit: string; qty: number; revenue: string }[]>`
      SELECT i."productName" AS name, MIN(i.unit) AS unit, SUM(i.qty)::int AS qty, SUM(i."lineTotal")::text AS revenue
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
      WHERE o.status <> 'CANCELLED' AND o."placedAt" >= ${start} AND o."placedAt" < ${end}
      GROUP BY i."productName" ORDER BY SUM(i."lineTotal") DESC LIMIT 3`;
    return {
      date: day,
      sales: source.online.sales + source.shop.sales,
      orders: source.online.orders + source.shop.orders,
      previousSales: num(previous._sum.total),
      online: source.online,
      shop: source.shop,
      profit: margin?.profit == null ? null : Number(margin.profit) - num(discounts._sum.discount),
      cash: cash.total,
      cashBy: cash.by,
      delivered: cash.delivered,
      cancelled,
      open: { toConfirm, needDriver, onTheWay, qrWaiting },
      top: top.map((t) => ({ name: t.name, unit: t.unit, qty: t.qty, revenue: Number(t.revenue) })),
    };
  }
}

@ApiTags('Reports')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('reports/daily-summary')
export class DailySummaryController {
  constructor(
    private readonly summary: DailySummaryService,
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  /** Today's summary as it would be sent now (for the Settings preview). */
  @Get()
  async preview() {
    const s = await this.summary.build(istDateKey(new Date()));
    return { summary: s, text: renderSms('dailySummary', summaryVars(s)) };
  }

  /** Settings → "Send now": today's summary to the summary number(s), right away. */
  @Post('send')
  @HttpCode(200)
  async sendNow() {
    const settings = await this.prisma.appSettings.findUnique({ where: { id: 1 } });
    const to = summaryNumbers(settings?.dailySummaryTo);
    if (!to.length) throw new BadRequestException('Add a WhatsApp number for the daily summary first.');
    const results = await this.sms.dailySummary(to, summaryVars(await this.summary.build(istDateKey(new Date()))));
    return { results: results.map((r) => ({ to: r.to, status: r.status.toLowerCase(), error: r.error })) };
  }
}
