import { renderSms } from '../sms/sms.templates';
import { DailySummaryService, summaryNumbers, summaryVars, type DaySummary } from './daily-summary';

const day: DaySummary = {
  date: '2026-11-24',
  sales: 42500,
  orders: 18,
  previousSales: 37946,
  online: { sales: 30000, orders: 11 },
  shop: { sales: 12500, orders: 7 },
  profit: 6200,
  cash: 25300,
  cashBy: [
    { who: 'Shop counter', amount: 12500 },
    { who: 'Rahul Patil', amount: 12800 },
  ],
  delivered: 15,
  cancelled: 1,
  open: { toConfirm: 2, needDriver: 0, onTheWay: 1, qrWaiting: 1 },
  top: [{ name: 'Paper Fighter Kite', unit: 'piece', qty: 900, revenue: 28800 }],
};

describe('daily sales summary', () => {
  it('reads the owner numbers from the setting', () => {
    expect(summaryNumbers('9860838860, +91 98220 11122')).toEqual(['919860838860', '919822011122']);
    expect(summaryNumbers(null)).toEqual([]);
    expect(summaryNumbers('12345')).toEqual([]);
  });

  it('is one readable WhatsApp message', () => {
    const text = renderSms('dailySummary', summaryVars(day));
    expect(text).toContain('Tue, 24 Nov 2026');
    expect(text).toContain('*Sales: Rs 42,500* (18 orders, up 12% on yesterday)');
    expect(text).toContain('• Online: Rs 30,000 (11 orders)');
    expect(text).toContain('• Shop counter: Rs 12,500 (7 bills)');
    expect(text).toContain('Profit on goods: Rs 6,200');
    expect(text).toContain('*Cash collected: Rs 25,300*');
    expect(text).toContain('Shop counter Rs 12,500 · Rahul Patil Rs 12,800');
    expect(text).toContain('*Still open:* 2 to confirm · 1 out for delivery · 1 QR order waiting');
    expect(text).toContain('1) Paper Fighter Kite: 900 pieces, Rs 28,800');
  });

  it('a quiet day still reads well', () => {
    const text = renderSms(
      'dailySummary',
      summaryVars({ ...day, sales: 0, orders: 0, previousSales: 0, profit: null, cash: 0, cashBy: [], top: [], open: { toConfirm: 0, needDriver: 0, onTheWay: 0, qrWaiting: 0 } }),
    );
    expect(text).toContain('*Sales: Rs 0* (0 orders)');
    expect(text).toContain('No cash collected today');
    expect(text).toContain('*Still open:* nothing waiting');
    expect(text).toContain('No sales today');
  });

  it('goes out once a day, after the hour, only when a number is set', async () => {
    let settings: any = { id: 1, dailySummaryTo: '919860838860', dailySummaryHour: 22, dailySummarySentOn: null };
    const prisma: any = {
      appSettings: {
        findUnique: async () => settings,
        updateMany: async ({ where, data }: any) => {
          const free = settings.dailySummarySentOn === null || settings.dailySummarySentOn !== where.OR[1].dailySummarySentOn.not;
          if (!free) return { count: 0 };
          settings = { ...settings, ...data };
          return { count: 1 };
        },
      },
    };
    const sent: string[][] = [];
    const sms: any = { dailySummary: async (to: string[]) => sent.push(to) };
    const svc = new DailySummaryService(prisma, sms);
    jest.spyOn(svc, 'build').mockResolvedValue(day);

    // 9:59 PM IST: too early. 10:00 PM: sends. 10:05 PM: already sent today.
    expect(await svc.tick(new Date('2026-11-24T16:29:00Z'))).toBe(false);
    expect(await svc.tick(new Date('2026-11-24T16:30:00Z'))).toBe(true);
    expect(await svc.tick(new Date('2026-11-24T16:35:00Z'))).toBe(false);
    expect(sent).toEqual([['919860838860']]);
    // Next night again.
    expect(await svc.tick(new Date('2026-11-25T16:31:00Z'))).toBe(true);
    // Off when no number.
    settings = { ...settings, dailySummaryTo: null, dailySummarySentOn: null };
    expect(await svc.tick(new Date('2026-11-26T16:31:00Z'))).toBe(false);
    expect(sent).toHaveLength(2);
  });
});
