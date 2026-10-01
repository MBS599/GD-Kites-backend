import { ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.service';
import { GeoService } from './geo.service';

const config = (googleKey = '') =>
  ({
    get: (k: string) =>
      ({
        GOOGLE_MAPS_API_KEY: googleKey,
        NOMINATIM_URL: 'https://nominatim.example',
        GEOCODER_USER_AGENT: 'Test/1.0',
      })[k],
  }) as unknown as AppConfig;

const nominatimBody = {
  display_name: 'Marketyard, Mukund Nagar, Pune, Maharashtra, 411001, India',
  address: { commercial: 'Marketyard', suburb: 'Mukund Nagar', city: 'Pune', postcode: '411001', state: 'Maharashtra' },
};

describe('GeoService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('maps a Nominatim result to a short label and address parts, with User-Agent', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => nominatimBody });
    global.fetch = fetchMock as never;
    const place = await new GeoService(config()).reverse(18.4866, 73.8656);
    expect(place).toMatchObject({
      label: 'Marketyard, Mukund Nagar, Pune',
      area: 'Mukund Nagar',
      city: 'Pune',
      pincode: '411001',
      state: 'Maharashtra',
    });
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toBe('Test/1.0');
  });

  it('caches by ~11 m grid cell so repeat lookups skip the provider', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => nominatimBody });
    global.fetch = fetchMock as never;
    const geo = new GeoService(config());
    await geo.reverse(18.48661, 73.86561);
    await geo.reverse(18.48662, 73.86559);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns provider failures into a 503', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as never;
    await expect(new GeoService(config()).reverse(1, 1)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('uses Google when an API key is configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'OK',
        results: [
          {
            formatted_address: 'Shop 14, Katraj Chowk, Katraj, Pune, Maharashtra 411046, India',
            address_components: [
              { long_name: 'Katraj Chowk', types: ['route'] },
              { long_name: 'Katraj', types: ['sublocality_level_1', 'sublocality'] },
              { long_name: 'Pune', types: ['locality'] },
              { long_name: '411046', types: ['postal_code'] },
            ],
          },
        ],
      }),
    });
    global.fetch = fetchMock as never;
    const place = await new GeoService(config('key-123')).reverse(18.4529, 73.8652);
    expect(String(fetchMock.mock.calls[0][0])).toContain('maps.googleapis.com');
    expect(place).toMatchObject({ label: 'Katraj Chowk, Katraj, Pune', pincode: '411046' });
  });
});
