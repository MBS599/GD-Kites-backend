import type { AppConfig } from '../../config/app-config.service';
import { roadDistanceKm } from '../../domain/geo';
import { RoadDistanceService } from './road-distance.service';

const config = { get: () => 'https://osrm.example' } as unknown as AppConfig;
const hub = { lat: 18.444112, lng: 73.874016 };
const shop = { lat: 18.4435578, lng: 73.8564708 };

describe('RoadDistanceService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('uses the driving distance along roads, rounded to 100 m, and caches it', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 'Ok', routes: [{ distance: 3456 }] }) });
    global.fetch = fetchMock as never;
    const roads = new RoadDistanceService(config);
    expect(await roads.km(hub, shop)).toBe(3.5);
    expect(await roads.km(hub, { lat: shop.lat + 0.00001, lng: shop.lng })).toBe(3.5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/route/v1/driving/73.874016,18.444112;73.856471,18.443558');
  });

  it('falls back to the straight-line estimate when the router fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;
    const km = await new RoadDistanceService(config).km(hub, shop);
    expect(km).toBe(roadDistanceKm(hub.lat, hub.lng, shop.lat, shop.lng));
  });
});
