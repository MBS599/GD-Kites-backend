import type { DriverProfile, Prisma, VehicleType } from '@prisma/client';
import { DEFAULT_DELIVERY_TARIFF, DEFAULT_DRIVER_TARIFF, type Tariff } from '../domain/pricing';

type DriverRateFields = Pick<DriverProfile, 'customBaseFare' | 'customPerKm'> & {
  vehicleType?: Pick<VehicleType, 'baseFare' | 'perKm'> | null;
};

const n = (d: Prisma.Decimal) => d.toNumber();

/** Customer delivery tariff: the delivery vehicle's rates (the Tempo), set in admin settings. */
export function deliveryTariffOf(vehicle: Pick<VehicleType, 'baseFare' | 'perKm'> | null | undefined): Tariff {
  if (!vehicle) return DEFAULT_DELIVERY_TARIFF;
  return { base: n(vehicle.baseFare), perKm: n(vehicle.perKm) };
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
    return { tariff: { base: n(driver.vehicleType.baseFare), perKm: n(driver.vehicleType.perKm) }, source: 'vehicle' };
  }
  return { tariff: DEFAULT_DRIVER_TARIFF, source: 'default' };
}
