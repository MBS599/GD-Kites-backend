import { checkTransition } from './orderStateMachine';
import { deliveryChargeFor, driverFareFor, etaMinutes, unitPriceFor } from './pricing';
import { roadDistanceKm } from './geo';

describe('order state machine', () => {
  it('follows the happy path across roles', () => {
    expect(checkTransition('confirm', 'PENDING', 'ADMIN')).toEqual({ ok: true, to: 'CONFIRMED' });
    expect(checkTransition('assign', 'CONFIRMED', 'ADMIN')).toEqual({ ok: true, to: 'ASSIGNED' });
    expect(checkTransition('start', 'ASSIGNED', 'DRIVER')).toEqual({ ok: true, to: 'OUT_FOR_DELIVERY' });
    expect(checkTransition('complete', 'OUT_FOR_DELIVERY', 'DRIVER')).toEqual({ ok: true, to: 'DELIVERED' });
  });

  it('rejects actions from the wrong role', () => {
    expect(checkTransition('confirm', 'PENDING', 'CUSTOMER').ok).toBe(false);
    expect(checkTransition('confirm', 'PENDING', 'DRIVER').ok).toBe(false);
    expect(checkTransition('complete', 'OUT_FOR_DELIVERY', 'ADMIN').ok).toBe(false);
  });

  it('rejects out-of-order transitions', () => {
    expect(checkTransition('assign', 'PENDING', 'ADMIN').ok).toBe(false);
    expect(checkTransition('complete', 'ASSIGNED', 'DRIVER').ok).toBe(false);
    expect(checkTransition('reject', 'OUT_FOR_DELIVERY', 'ADMIN').ok).toBe(false);
    expect(checkTransition('reject', 'DELIVERED', 'ADMIN').ok).toBe(false);
    expect(checkTransition('cancel', 'CONFIRMED', 'CUSTOMER').ok).toBe(false);
  });

  it('allows re-assigning an assigned order', () => {
    expect(checkTransition('assign', 'ASSIGNED', 'ADMIN')).toEqual({ ok: true, to: 'ASSIGNED' });
  });
});

describe('pricing', () => {
  it('delivery charge = area base + per km × distance', () => {
    const area = { base: 60, perKm: 30 };
    expect(deliveryChargeFor(8.4, area)).toBe(312); // 60 + 30 × 8.4
    expect(deliveryChargeFor(0, area)).toBe(60);
  });

  it('driver fare = driver base + per km × distance, rounded to the rupee', () => {
    expect(driverFareFor(8.4, { base: 40, perKm: 13 })).toBe(149); // bike: 149.2
    expect(driverFareFor(8.4, { base: 150, perKm: 25 })).toBe(360); // tempo
    // Two-step rate: Rs 50 + 10/km for the first 5 km, 8/km after.
    const tempo = { base: 50, perKm: 10, tierKm: 5, perKmAfter: 8 };
    expect(deliveryChargeFor(3, tempo)).toBe(80);
    expect(deliveryChargeFor(5, tempo)).toBe(100);
    expect(deliveryChargeFor(8, tempo)).toBe(124);
    expect(deliveryChargeFor(0, tempo)).toBe(50);
  });

  it('applies wholesale slab only above the slab quantity', () => {
    const kite = { price: 25, slabQty: 500, slabPrice: 23 };
    expect(unitPriceFor(kite, 500)).toBe(25);
    expect(unitPriceFor(kite, 501)).toBe(23);
    expect(unitPriceFor({ price: 40, slabQty: null, slabPrice: null }, 5000)).toBe(40);
  });

  it('estimates ETA with a floor', () => {
    expect(etaMinutes(0.1)).toBe(5);
    expect(etaMinutes(11)).toBe(30);
  });
});

describe('geo', () => {
  it('returns 0 for the same point and a sane city distance', () => {
    expect(roadDistanceKm(18.4866, 73.8656, 18.4866, 73.8656)).toBe(0);
    const d = roadDistanceKm(18.4866, 73.8656, 18.4529, 73.8652);
    expect(d).toBeGreaterThan(3);
    expect(d).toBeLessThan(7);
  });
});
