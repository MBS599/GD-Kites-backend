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
        INDIA_POST_URL: 'https://indiapost.example',
      })[k],
  }) as unknown as AppConfig;

/** India Post directory stub: Pune's real PINs; unknown ones are "Error". */
const indiaPost = (url: string) => {
  const offices: Record<string, { Name: string; Pincode: string; District: string }[]> = {
    'pincode/411001': [{ Name: 'Dr.B.A. Chowk', Pincode: '411001', District: 'Pune' }],
    'pincode/411037': [{ Name: 'Mukund Nagar', Pincode: '411037', District: 'Pune' }],
    'pincode/411046': [{ Name: 'Katraj', Pincode: '411046', District: 'Pune' }],
    'postoffice/Katraj': [{ Name: 'Katraj', Pincode: '411046', District: 'Pune' }],
  };
  const hit = Object.entries(offices).find(([k]) => url.endsWith(`/${k}`));
  return [hit ? { Status: 'Success', PostOffice: hit[1] } : { Status: 'Error', PostOffice: null }];
};

/** fetch stub: Nominatim answers [nominatim]; India Post answers from its directory. */
const providers = (nominatim: object) =>
  jest.fn(async (url: URL | string, _init?: { headers: Record<string, string> }) => ({
    ok: true,
    json: async () => (String(url).includes('indiapost.example') ? indiaPost(String(url)) : nominatim),
  }));

const nominatimBody = {
  display_name: 'Marketyard, Mukund Nagar, Pune, Maharashtra, 411037, India',
  address: { commercial: 'Marketyard', suburb: 'Mukund Nagar', city: 'Pune', postcode: '411037', state: 'Maharashtra' },
};

describe('GeoService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('maps a Nominatim result to a short label and address parts, with User-Agent', async () => {
    const fetchMock = providers(nominatimBody);
    global.fetch = fetchMock as never;
    const place = await new GeoService(config()).reverse(18.4866, 73.8656);
    expect(place).toMatchObject({
      label: 'Marketyard, Mukund Nagar, Pune',
      area: 'Mukund Nagar',
      city: 'Pune',
      // OSM's postcode, confirmed by India Post for a post office of that locality.
      pincode: '411037',
      state: 'Maharashtra',
    });
    // OSM's (often wrong) postcode is left out of the address text.
    expect(place.full).not.toMatch(/\d{6}/);
    expect(fetchMock.mock.calls[0][1]!.headers['User-Agent']).toBe('Test/1.0');
  });

  it('replaces a wrong OSM postcode with the India Post PIN of the locality', async () => {
    // The shop: OSM says 411406 (no such PIN); India Post has Katraj at 411046.
    global.fetch = providers({
      display_name: 'Katraj, Kondhwa Budruk, Pune City Subdistrict, Pune District, Maharashtra, 411406, India',
      address: { suburb: 'Katraj', city: 'Pune', state_district: 'Pune District', postcode: '411406', state: 'Maharashtra' },
    }) as never;
    const place = await new GeoService(config()).reverse(18.444112, 73.874016);
    expect(place.pincode).toBe('411046');
    expect(place.full).not.toContain('411406');
  });

  it('ignores a real PIN that belongs to another area', async () => {
    // 411001 exists in Pune, but not for Mukund Nagar: a wrong PIN is worse than none.
    global.fetch = providers({
      display_name: 'Marketyard, Mukund Nagar, Pune, Maharashtra, 411001, India',
      address: { suburb: 'Mukund Nagar', city: 'Pune', postcode: '411001', state: 'Maharashtra' },
    }) as never;
    expect((await new GeoService(config()).reverse(18.4866, 73.8656)).pincode).toBeNull();
  });

  it('leaves the PIN empty when India Post has no match (customer types it)', async () => {
    global.fetch = providers({
      display_name: 'Somewhere, Pune, Maharashtra, 400000, India',
      address: { suburb: 'Nowhere Nagar', city: 'Pune', postcode: '400000', state: 'Maharashtra' },
    }) as never;
    expect((await new GeoService(config()).reverse(18.5, 73.8)).pincode).toBeNull();
  });

  it('caches by ~11 m grid cell so repeat lookups skip the provider', async () => {
    const fetchMock = providers(nominatimBody);
    global.fetch = fetchMock as never;
    const geo = new GeoService(config());
    await geo.reverse(18.48661, 73.86561);
    await geo.reverse(18.48662, 73.86559);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('nominatim')).length).toBe(1);
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
