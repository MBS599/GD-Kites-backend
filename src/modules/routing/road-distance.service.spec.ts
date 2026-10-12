import type { AppConfig } from '../../config/app-config.service';
import { roadDistanceKm } from '../../domain/geo';
import { RoadDistanceService } from './road-distance.service';

const config = (key = 'key-123') => ({ get: () => key }) as unknown as AppConfig;
const hub = { lat: 18.444112, lng: 73.874016 };
const shop = { lat: 18.4435578, lng: 73.8564708 };

describe('RoadDistanceService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('uses the Google Routes driving distance, rounded to 100 m, and caches it', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ routes: [{ distanceMeters: 3456 }] }) });
    global.fetch = fetchMock as never;
    const roads = new RoadDistanceService(config());
    expect(await roads.km(hub, shop)).toBe(3.5);
    expect(await roads.km(hub, { lat: shop.lat + 0.00001, lng: shop.lng })).toBe(3.5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    expect(init.headers['X-Goog-Api-Key']).toBe('key-123');
    expect(init.headers['X-Goog-FieldMask']).toBe('routes.distanceMeters');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' });
    expect(body.origin.location.latLng).toEqual({ latitude: hub.lat, longitude: hub.lng });
  });

  it('falls back to the straight-line estimate when Google fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;
    const km = await new RoadDistanceService(config()).km(hub, shop);
    expect(km).toBe(roadDistanceKm(hub.lat, hub.lng, shop.lat, shop.lng));
  });

  it('uses the estimate without calling anything when no key is set', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const km = await new RoadDistanceService(config('')).km(hub, shop);
    expect(km).toBe(roadDistanceKm(hub.lat, hub.lng, shop.lat, shop.lng));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
