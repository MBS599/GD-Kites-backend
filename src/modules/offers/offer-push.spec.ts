import { Prisma } from '@prisma/client';
import { offerPush } from './offers.controller';

const d = (v: number) => new Prisma.Decimal(v);

describe('offer notification', () => {
  it('says what the offer gives, its minimum and end date', () => {
    const p = offerPush({
      id: 'o1',
      title: 'Sankranti special',
      description: 'On all fighter kites.',
      kind: 'PERCENT',
      value: d(10),
      maxDiscount: d(500),
      minOrder: d(2000),
      endsAt: new Date('2026-12-31T12:00:00Z'),
    });
    expect(p.title).toBe('New offer: Sankranti special');
    expect(p.body).toBe('10% off (up to ₹500) on orders above ₹2,000 · till 31 Dec. On all fighter kites.');
    expect(p.data).toEqual({ type: 'offer', offerId: 'o1' });
  });

  it('a flat offer for any order', () => {
    const p = offerPush({ id: 'o2', title: 'Thank you', description: null, kind: 'FLAT', value: d(75), maxDiscount: null, minOrder: d(0), endsAt: null });
    expect(p.body).toBe('₹75 off.');
  });
});
