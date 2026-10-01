/** Pricing rules. Money values are rupees. */

/**
 * A "base + per km" tariff set by admins:
 * - customer delivery charge: per service area (known at checkout);
 * - driver fare: per driver — their vehicle type's rates, or a custom rate.
 */
export interface Tariff {
  base: number;
  perKm: number;
}

/** Fallbacks for legacy records (orders without an area, drivers without a vehicle type). */
export const DEFAULT_DELIVERY_TARIFF: Tariff = { base: 60, perKm: 30 };
export const DEFAULT_DRIVER_TARIFF: Tariff = { base: 40, perKm: 13 };

/** base + perKm × distance, rounded to the nearest rupee. */
export function applyTariff(t: Tariff, distanceKm: number): number {
  return Math.round(t.base + t.perKm * Math.max(0, distanceKm));
}

/** Delivery charge billed to the customer (area tariff). */
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
