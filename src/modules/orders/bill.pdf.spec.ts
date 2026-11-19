import { Prisma } from '@prisma/client';
import type { FullOrder } from '../../common/serializers';
import { billMoney, billTotals, renderBill } from './bill.pdf';

const d = (v: number) => new Prisma.Decimal(v);

const order = (over: Partial<FullOrder> = {}) =>
  ({
    id: 'o1',
    number: 1029,
    status: 'DELIVERED',
    placedAt: new Date('2026-11-17T05:00:00Z'),
    deliveredAt: new Date('2026-11-17T09:00:00Z'),
    contactName: 'Mayur Traders',
    contactPhone: '+91 98220 45118',
    addrLine: 'Shop 14, Katraj Chowk',
    addrArea: 'Katraj',
    addrCity: 'Pune',
    addrPincode: '411046',
    deliveryMode: 'LOCAL',
    distanceKm: 4.9,
    subtotal: d(3000),
    discount: d(0),
    offerTitle: null,
    deliveryCharge: d(207),
    packingCharge: d(0),
    deliveryTax: d(0),
    paymentFee: d(0),
    total: d(3207),
    paidOnline: d(0),
    courierName: null,
    items: [
      { productName: 'Premium Fighter Kite', unit: 'piece', qty: 120, unitPrice: d(25), lineTotal: d(3000), contents: null },
      { productName: 'Retailer Combo', unit: 'combo', qty: 1, unitPrice: d(0), lineTotal: d(0), contents: '50 × Pona (Big), 2 × Manjha' },
    ],
    ...over,
  }) as unknown as FullOrder;

describe('bill PDF', () => {
  it('is a PDF', async () => {
    const pdf = await renderBill(order(), { phone: '+91 89833 93542' });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('totals: goods, offer, delivery, online part and the cash collected', () => {
    const t = billTotals(
      order({ discount: d(100), offerTitle: 'Diwali', deliveryTax: d(37.26), paymentFee: d(4.9), total: d(3149.16), paidOnline: d(249.16) } as never),
    );
    expect(t.rows.map((r) => r.label)).toEqual(['Goods', 'Offer · Diwali', 'Delivery charge · 4.9 km', 'GST on delivery charge', 'Online payment fee']);
    expect(t.rows[1].amount).toBe(-100);
    expect(t.cash).toBe(2900);
    expect(billMoney(3149.16)).toBe('Rs 3,149.16');
  });

  it('counter sales: goods only, paid in cash at the shop', async () => {
    const o = order({ deliveryMode: 'COUNTER', deliveryCharge: d(0), total: d(3000), distanceKm: 0 } as never);
    expect(billTotals(o).rows.map((r) => r.label)).toEqual(['Goods']);
    expect(billTotals(o).cash).toBe(3000);
    expect((await renderBill(o, { phone: null })).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('courier orders show the packing charge instead of delivery', () => {
    const t = billTotals(order({ deliveryMode: 'COURIER', deliveryCharge: d(0), packingCharge: d(200) } as never));
    expect(t.rows.map((r) => r.label)).toEqual(['Goods', 'Packing charge (courier)']);
  });
});
