/** Pricing rules. Money values are rupees. */

/**
 * A "base + per km" tariff set by admins:
 * - customer delivery charge: the delivery vehicle's rates (the Tempo, set in admin settings);
 * - driver fare: per driver — their vehicle type's rates, or a custom rate.
 */
export interface Tariff {
  base: number;
  /** Rate per km (for the first [tierKm] km when a second rate is set). */
  perKm: number;
  /** Two-step rate: after this many km, [perKmAfter] applies to each further km. */
  tierKm?: number | null;
  perKmAfter?: number | null;
}

/** Fallbacks: no delivery vehicle set (Tempo rate), drivers without a vehicle type. */
export const DEFAULT_DELIVERY_TARIFF: Tariff = { base: 50, perKm: 10, tierKm: 5, perKmAfter: 8 };
export const DEFAULT_DRIVER_TARIFF: Tariff = { base: 40, perKm: 13 };

/**
 * base + perKm × distance, rounded to the nearest rupee. With a second rate:
 * perKm for the first tierKm km, perKmAfter for the rest
 * (e.g. 50 + 10/km for 5 km + 8/km after: 3 km = 80, 8 km = 124).
 */
export function applyTariff(t: Tariff, distanceKm: number): number {
  const d = Math.max(0, distanceKm);
  if (t.tierKm != null && t.perKmAfter != null && d > t.tierKm) {
    return Math.round(t.base + t.perKm * t.tierKm + t.perKmAfter * (d - t.tierKm));
  }
  return Math.round(t.base + t.perKm * d);
}

/** Delivery charge billed to the customer (delivery vehicle's tariff). */
export function deliveryChargeFor(distanceKm: number, tariff: Tariff): number {
  return applyTariff(tariff, distanceKm);
}

/** Fare credited to the driver for one delivery (driver's tariff). */
export function driverFareFor(distanceKm: number, tariff: Tariff): number {
  return applyTariff(tariff, distanceKm);
}

export interface PricedProduct {
  price: number;
  slabQty: number | null;
  slabPrice: number | null;
}

/** Wholesale slab: above [slabQty] pieces the unit price drops to [slabPrice]. */
export function unitPriceFor(product: PricedProduct, qty: number): number {
  if (product.slabQty != null && product.slabPrice != null && qty > product.slabQty) {
    return product.slabPrice;
  }
  return product.price;
}

/** Average city speed used for ETA estimates. */
export const AVG_SPEED_KMPH = 22;

export function etaMinutes(distanceKm: number): number {
  return Math.max(5, Math.round((distanceKm / AVG_SPEED_KMPH) * 60));
}

/** GST Razorpay charges on its own fee (fixed by law). */
export const GATEWAY_FEE_GST_PERCENT = 18;

export interface OnlineCharges {
  /** GST on the delivery charge. */
  tax: number;
  /** Razorpay's fee (+ GST on it), passed to the customer. */
  fee: number;
  /** What the customer pays online: delivery charge + tax + fee. */
  total: number;
}

/**
 * Amount paid online for the delivery charge, in rupees with paise precision.
 * The fee is grossed up so that after Razorpay deducts feePercent (+18% GST on
 * it) from the amount charged, the business still receives delivery + tax.
 */
export function onlineChargesFor(deliveryCharge: number, gstPercent: number, feePercent: number): OnlineCharges {
  const paise = (rupees: number) => Math.round(rupees * 100);
  const base = paise(deliveryCharge);
  const tax = Math.round((base * gstPercent) / 100);
  const net = base + tax;
  const feeRate = (feePercent / 100) * (1 + GATEWAY_FEE_GST_PERCENT / 100);
  const charged = feeRate > 0 ? Math.ceil(net / (1 - feeRate)) : net;
  return { tax: tax / 100, fee: (charged - net) / 100, total: charged / 100 };
}
