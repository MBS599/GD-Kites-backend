import { ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.service';
import { GeoService } from './geo.service';

const config = (googleKey = '') => ({ get: (k: string) => ({ GOOGLE_MAPS_API_KEY: googleKey })[k] }) as unknown as AppConfig;

/** Google Geocoding answer for the Katraj pin. */
const geocodeBody = {
  status: 'OK',
  results: [
    {
      formatted_address: 'Shop 14, Katraj Chowk, Katraj, Pune, Maharashtra 411046, India',
      address_components: [
        { long_name: 'Katraj Chowk', types: ['route'] },
        { long_name: 'Katraj', types: ['sublocality_level_1', 'sublocality'] },
        { long_name: 'Pune', types: ['locality'] },
        { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
        { long_name: '411046', types: ['postal_code'] },
      ],
    },
  ],
};
const google = () => jest.fn().mockResolvedValue({ ok: true, json: async () => geocodeBody });

describe('GeoService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('reverse-geocodes with Google and maps the address parts', async () => {
    const fetchMock = google();
    global.fetch = fetchMock as never;
    const place = await new GeoService(config('key-123')).reverse(18.4529, 73.8652);
    expect(String(fetchMock.mock.calls[0][0])).toContain('maps.googleapis.com/maps/api/geocode/json');
    expect(place).toMatchObject({ label: 'Katraj Chowk, Katraj, Pune', area: 'Katraj', city: 'Pune', state: 'Maharashtra', pincode: '411046' });
  });

  it('never uses another provider: without a key it answers 503 and calls nothing', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    await expect(new GeoService(config()).reverse(18.4529, 73.8652)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches by ~11 m grid cell so repeat lookups skip Google', async () => {
    const fetchMock = google();
    global.fetch = fetchMock as never;
    const geo = new GeoService(config('key-123'));
    await geo.reverse(18.48661, 73.86561);
    await geo.reverse(18.48662, 73.86559);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns provider failures into a 503', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    await expect(new GeoService(config('key-123')).reverse(1, 1)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe('Places search', () => {
    it('reports search as off without a key and never calls Google', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as never;
      const geo = new GeoService(config());
      expect(geo.searchEnabled).toBe(false);
      await expect(geo.autocomplete('katraj', 'session-1234')).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends India-only autocomplete with the session token and maps the suggestions', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          suggestions: [
            {
              placePrediction: {
                placeId: 'ChIJ-katraj',
                text: { text: 'Katraj Chowk, Katraj, Pune' },
                structuredFormat: { mainText: { text: 'Katraj Chowk' }, secondaryText: { text: 'Katraj, Pune, Maharashtra' } },
              },
            },
            { queryPrediction: { text: { text: 'katraj dairy' } } },
          ],
        }),
      });
      global.fetch = fetchMock as never;
      const list = await new GeoService(config('key-123')).autocomplete('katraj', 'session-1234', { lat: 18.45, lng: 73.86 });
      expect(list).toEqual([{ placeId: 'ChIJ-katraj', main: 'Katraj Chowk', secondary: 'Katraj, Pune, Maharashtra' }]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://places.googleapis.com/v1/places:autocomplete');
      expect(init.headers['X-Goog-Api-Key']).toBe('key-123');
      expect(JSON.parse(init.body)).toMatchObject({ input: 'katraj', sessionToken: 'session-1234', includedRegionCodes: ['in'] });
    });

    it('maps place details to a location and address parts', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'ChIJ-shop',
          displayName: { text: 'Laxmi Market' },
          formattedAddress: '12, Satara Rd, Katraj, Pune, Maharashtra 411046, India',
          location: { latitude: 18.4529, longitude: 73.8652 },
          addressComponents: [
            { longText: '12', types: ['street_number'] },
            { longText: 'Satara Road', types: ['route'] },
            { longText: 'Katraj', types: ['sublocality_level_1', 'sublocality'] },
            { longText: 'Pune', types: ['locality'] },
            { longText: 'Maharashtra', types: ['administrative_area_level_1'] },
            { longText: '411046', types: ['postal_code'] },
          ],
        }),
      });
      global.fetch = fetchMock as never;
      const place = await new GeoService(config('key-123')).details('ChIJ-shop', 'session-1234');
      expect(place).toMatchObject({
        lat: 18.4529,
        lng: 73.8652,
        houseNumber: '12',
        building: 'Laxmi Market',
        street: 'Satara Road',
        area: 'Katraj',
        city: 'Pune',
        state: 'Maharashtra',
        pincode: '411046',
      });
      expect(String(fetchMock.mock.calls[0][0])).toContain('sessionToken=session-1234');
      expect(fetchMock.mock.calls[0][1].headers['X-Goog-FieldMask']).toContain('addressComponents');
    });

    it('turns a quota error into a friendly 503', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'quota' }) as never;
      await expect(new GeoService(config('key-123')).autocomplete('pune', 'session-1234')).rejects.toThrow(/Too many searches/);
    });
  });
});
