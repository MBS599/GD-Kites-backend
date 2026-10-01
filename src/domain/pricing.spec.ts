import { onlineChargesFor } from './pricing';

describe('onlineChargesFor', () => {
  it('adds GST on the delivery charge and grosses up the gateway fee', () => {
    const c = onlineChargesFor(207, 18, 2);
    expect(c.tax).toBe(37.26);
    expect(c.total).toBe(250.17);
    expect(c.fee).toBe(5.91);
    // Razorpay keeps 2% + 18% GST of what it charged; the business keeps at least delivery + GST.
    expect(c.total - Math.round(c.total * 0.0236 * 100) / 100).toBeGreaterThanOrEqual(207 + 37.26);
  });

  it('can switch either part off', () => {
    expect(onlineChargesFor(100, 0, 0)).toEqual({ tax: 0, fee: 0, total: 100 });
    expect(onlineChargesFor(100, 18, 0)).toEqual({ tax: 18, fee: 0, total: 118 });
  });
});
