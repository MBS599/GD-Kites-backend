import type { DriverProfile, Prisma, VehicleType } from '@prisma/client';
import { DEFAULT_DELIVERY_TARIFF, DEFAULT_DRIVER_TARIFF, type Tariff } from '../domain/pricing';

type DriverRateFields = Pick<DriverProfile, 'customBaseFare' | 'customPerKm'> & {
  vehicleType?: Pick<VehicleType, 'baseFare' | 'perKm' | 'tierKm' | 'perKmAfter'> | null;
};

const n = (d: Prisma.Decimal) => d.toNumber();

/** A vehicle type's tariff, including its second per-km rate when set. */
export function vehicleTariff(v: Pick<VehicleType, 'baseFare' | 'perKm' | 'tierKm' | 'perKmAfter'>): Tariff {
  return {
    base: n(v.baseFare),
    perKm: n(v.perKm),
    ...(v.tierKm != null && v.perKmAfter != null ? { tierKm: v.tierKm, perKmAfter: n(v.perKmAfter) } : {}),
  };
}

/** Customer delivery tariff: the delivery vehicle's rates (the Tempo), set in admin settings. */
export function deliveryTariffOf(
  vehicle: Pick<VehicleType, 'baseFare' | 'perKm' | 'tierKm' | 'perKmAfter'> | null | undefined,
): Tariff {
  if (!vehicle) return DEFAULT_DELIVERY_TARIFF;
  return vehicleTariff(vehicle);
}

export type DriverTariffSource = 'custom' | 'vehicle' | 'default';

/**
 * A driver's fare tariff: their custom (negotiated) rate if set, otherwise
 * their vehicle type's rate.
 */
export function driverTariffOf(driver: DriverRateFields): { tariff: Tariff; source: DriverTariffSource } {
  if (driver.customBaseFare != null && driver.customPerKm != null) {
    return { tariff: { base: n(driver.customBaseFare), perKm: n(driver.customPerKm) }, source: 'custom' };
  }
  if (driver.vehicleType) {
    return { tariff: vehicleTariff(driver.vehicleType), source: 'vehicle' };
  }
  return { tariff: DEFAULT_DRIVER_TARIFF, source: 'default' };
}
