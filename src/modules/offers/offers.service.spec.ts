import { Prisma } from '@prisma/client';
import { discountFor, isLive } from './offers.service';

const d = (n: number) => new Prisma.Decimal(n);

describe('offer discount', () => {
  it('takes whole rupees off for % offers, up to the cap', () => {
    expect(discountFor({ kind: 'PERCENT', value: d(10), maxDiscount: null }, d(2555)).toNumber()).toBe(255);
    expect(discountFor({ kind: 'PERCENT', value: d(10), maxDiscount: d(100) }, d(2500)).toNumber()).toBe(100);
  });

  it('never takes more than the goods', () => {
    expect(discountFor({ kind: 'FLAT', value: d(500), maxDiscount: null }, d(300)).toNumber()).toBe(300);
    expect(discountFor({ kind: 'FLAT', value: d(50), maxDiscount: d(10) }, d(300)).toNumber()).toBe(50);
  });

  it('is live only while switched on and inside its dates', () => {
    const now = new Date('2026-10-13T10:00:00Z');
    const day = 24 * 3600 * 1000;
    expect(isLive({ isActive: true, startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isLive({ isActive: false, startsAt: null, endsAt: null }, now)).toBe(false);
    expect(isLive({ isActive: true, startsAt: new Date(now.getTime() + day), endsAt: null }, now)).toBe(false);
    expect(isLive({ isActive: true, startsAt: null, endsAt: new Date(now.getTime() - day) }, now)).toBe(false);
  });
});
