import { Prisma } from '@prisma/client';
import { DEFAULT_DRIVER_TARIFF } from '../domain/pricing';
import { deliveryTariffOf, driverTariffOf } from './rates';

const D = (n: number) => new Prisma.Decimal(n);
const tempo = { baseFare: D(150), perKm: D(25) };

describe('driverTariffOf', () => {
  it('uses the vehicle type rates by default', () => {
    expect(driverTariffOf({ customBaseFare: null, customPerKm: null, vehicleType: tempo })).toEqual({
      tariff: { base: 150, perKm: 25 },
      source: 'vehicle',
    });
  });

  it('a custom per-driver fare overrides the vehicle rates', () => {
    expect(driverTariffOf({ customBaseFare: D(60), customPerKm: D(16.5), vehicleType: tempo })).toEqual({
      tariff: { base: 60, perKm: 16.5 },
      source: 'custom',
    });
  });

  it('falls back to the default only for drivers with neither', () => {
    expect(driverTariffOf({ customBaseFare: null, customPerKm: null, vehicleType: null })).toEqual({
      tariff: DEFAULT_DRIVER_TARIFF,
      source: 'default',
    });
  });
});

describe('deliveryTariffOf', () => {
  it('reads the delivery vehicle rates', () => {
    expect(deliveryTariffOf({ baseFare: D(150), perKm: D(25) })).toEqual({ base: 150, perKm: 25 });
  });
  it('falls back to the default Tempo rate when no vehicle is set', () => {
    expect(deliveryTariffOf(null)).toEqual({ base: 150, perKm: 25 });
  });
});
