import { pushFor, shopBillPush, shopRejectedPush, shopRequestPush } from './push.service';

describe('shop push notifications', () => {
  it('tells shop staff who ordered, how much and that they are waiting', () => {
    expect(shopRequestPush('r1', 'Rahul', 3, 12500)).toEqual({
      title: 'New counter order',
      body: 'Rahul · 3 items · ₹12,500. Waiting at the counter.',
      data: { type: 'shopRequest', requestId: 'r1' },
    });
    expect(shopRequestPush('r1', 'Rahul', 1, 80).body).toBe('Rahul · 1 item · ₹80. Waiting at the counter.');
  });

  it('thanks the customer for a counter purchase and opens it on tap', () => {
    expect(shopBillPush('o1', 1042, '2980.00')).toEqual({
      title: 'Thank you for shopping',
      body: 'GD1042 · ₹2,980 paid at the shop. Tap to see your bill.',
      data: { type: 'shopBill', orderId: 'o1' },
    });
  });

  it('tells the customer when the shop turns down a QR order', () => {
    expect(shopRejectedPush().data).toEqual({ type: 'shopRejected' });
  });

  it('shows amounts in rupees', () => {
    expect(pushFor('orderDelivered', ['Mayur', 'GD7', '2 × Kite', '1,200'], 'o7')?.body).toBe('GD7 delivered (₹1,200). Thank you!');
  });
});
