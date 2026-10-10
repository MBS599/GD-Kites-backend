import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';

export interface Place {
  /** Short human label, e.g. "Marketyard, Mukund Nagar, Pune". */
  label: string;
  /** Full formatted address from the provider. */
  full: string;
  area: string | null;
  city: string | null;
  pincode: string | null;
  state: string | null;
  /** Finer parts when the provider has them (prefill the address form). */
  houseNumber?: string | null;
  building?: string | null;
  street?: string | null;
}

/** One Places autocomplete suggestion. */
export interface Suggestion {
  placeId: string;
  /** "Katraj Chowk" */
  main: string;
  /** "Katraj, Pune, Maharashtra, India" */
  secondary: string;
}

/** A chosen suggestion: where it is plus its address parts. */
export interface PlaceDetails extends Place {
  placeId: string;
  lat: number;
  lng: number;
}

interface GoogleComponent {
  longText: string;
  shortText?: string;
  types: string[];
}

const PLACES_URL = 'https://places.googleapis.com/v1';

interface IndiaPostOffice {
  Name: string;
  Pincode: string;
  District: string;
}

const CACHE_MAX = 5000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Nominatim usage policy: at most 1 request per second. */
const NOMINATIM_SPACING_MS = 1100;

/**
 * Reverse geocoding (coordinates → address). Uses Google Geocoding when
 * GOOGLE_MAPS_API_KEY is set, otherwise OpenStreetMap Nominatim with the
 * policy-required User-Agent and 1 req/s throttle. Results are cached by
 * ~11 m grid cell so repeated lookups never hit the provider.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly cache = new Map<string, { place: Place; at: number }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastCall = 0;

  constructor(private readonly config: AppConfig) {}

  async reverse(lat: number, lng: number): Promise<Place> {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.place;

    let place: Place;
    try {
      place = this.config.get('GOOGLE_MAPS_API_KEY') ? await this.google(lat, lng) : await this.nominatimThrottled(lat, lng);
    } catch (e) {
      this.logger.warn(`reverse geocode failed for ${key}: ${String(e)}`);
      throw new ServiceUnavailableException('Address lookup is unavailable right now.');
    }

    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { place, at: Date.now() });
    return place;
  }

  /** Serialises calls so we never exceed Nominatim's rate limit. */
  private nominatimThrottled(lat: number, lng: number): Promise<Place> {
    const run = async () => {
      const wait = this.lastCall + NOMINATIM_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      return this.nominatim(lat, lng);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async nominatim(lat: number, lng: number): Promise<Place> {
    const url = new URL('/reverse', this.config.get('NOMINATIM_URL'));
    url.search = new URLSearchParams({
      format: 'jsonv2',
      lat: String(lat),
      lon: String(lng),
      zoom: '18',
      addressdetails: '1',
      'accept-language': 'en',
    }).toString();
    const res = await fetch(url, {
      headers: { 'User-Agent': this.config.get('GEOCODER_USER_AGENT') },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const body = (await res.json()) as { display_name?: string; error?: string; address?: Record<string, string> };
    if (body.error || !body.address) throw new Error(body.error ?? 'no address');
    const a = body.address;
    const road = a.road ?? a.pedestrian ?? null;
    const place = a.commercial ?? a.amenity ?? a.shop ?? a.building ?? a.house_name ?? null;
    const area = a.suburb ?? a.neighbourhood ?? a.quarter ?? a.village ?? a.hamlet ?? a.city_district ?? null;
    const city = a.city ?? a.town ?? a.village ?? a.municipality ?? a.state_district ?? null;
    const parts = [place ?? road, area, city].filter((p, i, arr): p is string => !!p && arr.indexOf(p) === i);
    // OpenStreetMap's Indian PIN codes are often wrong (e.g. 411406 for the Kondhwa shop,
    // really 411046): the PIN comes from India Post instead, and the OSM one is left out.
    const full = (body.display_name ?? parts.join(', '))
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x && !/^\d{6}$/.test(x) && x !== 'India')
      .join(', ');
    return {
      label: parts.length ? parts.join(', ') : full.split(',').slice(0, 3).join(',').trim(),
      full,
      area,
      city,
      pincode: await this.indiaPostPin(a),
      state: a.state ?? null,
      houseNumber: a.house_number ?? null,
      building: place,
      street: road,
    };
  }

  /**
   * PIN code from India Post's directory (free, no key) for an OpenStreetMap address.
   * A wrong PIN is worse than none, so only a PIN tied to the locality's name is used:
   * 1. the post office named like the locality, in the same district (Katraj → 411046);
   * 2. else OSM's postcode, if India Post lists it for a post office with that name;
   * 3. else null (the customer types it).
   */
  private async indiaPostPin(a: Record<string, string>): Promise<string | null> {
    const district = (a.state_district ?? a.county ?? a.city ?? '').replace(/\s+district$/i, '').trim().toLowerCase();
    const inDistrict = (o: IndiaPostOffice) => !district || o.District.toLowerCase().includes(district.split(' ')[0]);
    const names = [a.suburb, a.neighbourhood, a.quarter, a.village, a.hamlet, a.city_district, a.town]
      .filter((n): n is string => !!n)
      .flatMap((n) => [n, n.split(/\s+/)[0]])
      .filter((n, i, arr) => n.length >= 4 && arr.indexOf(n) === i)
      .slice(0, 4);
    const named = (o: IndiaPostOffice) =>
      names.some((n) => o.Name.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(o.Name.toLowerCase()));
    try {
      for (const name of names) {
        const offices = (await this.indiaPost(`postoffice/${encodeURIComponent(name)}`)).filter(inDistrict);
        if (!offices.length) continue;
        const lower = name.toLowerCase();
        const best =
          offices.find((o) => o.Name.toLowerCase() === lower) ??
          offices.find((o) => o.Name.toLowerCase().startsWith(lower)) ??
          offices[0];
        return best.Pincode;
      }
      const osm = a.postcode?.replace(/\s/g, '');
      if (osm && /^[1-9]\d{5}$/.test(osm)) {
        const offices = await this.indiaPost(`pincode/${osm}`);
        if (offices.some((o) => inDistrict(o) && named(o))) return osm;
      }
    } catch (e) {
      this.logger.warn(`India Post PIN lookup failed: ${String(e)}`);
    }
    return null;
  }

  private async indiaPost(path: string): Promise<IndiaPostOffice[]> {
    const res = await fetch(new URL(`/${path}`, this.config.get('INDIA_POST_URL')), {
      headers: { 'User-Agent': this.config.get('GEOCODER_USER_AGENT') },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`India Post HTTP ${res.status}`);
    const body = (await res.json()) as { Status?: string; PostOffice?: IndiaPostOffice[] | null }[];
    return body[0]?.Status === 'Success' ? (body[0].PostOffice ?? []) : [];
  }

  private async google(lat: number, lng: number): Promise<Place> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.search = new URLSearchParams({
      latlng: `${lat},${lng}`,
      key: this.config.get('GOOGLE_MAPS_API_KEY'),
      language: 'en',
    }).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
    const body = (await res.json()) as {
      status: string;
      results: { formatted_address: string; address_components: { long_name: string; types: string[] }[] }[];
    };
    if (body.status !== 'OK' || !body.results.length) throw new Error(`Google status ${body.status}`);
    const top = body.results[0];
    const get = (...types: string[]) =>
      top.address_components.find((c) => types.some((t) => c.types.includes(t)))?.long_name ?? null;
    const area = get('sublocality_level_1', 'sublocality', 'neighborhood');
    const city = get('locality', 'administrative_area_level_3');
    const street = get('premise', 'route');
    const parts = [street, area, city].filter((p, i, arr): p is string => !!p && arr.indexOf(p) === i);
    return {
      label: parts.length ? parts.join(', ') : top.formatted_address,
      full: top.formatted_address,
      area,
      city,
      pincode: get('postal_code'),
      state: get('administrative_area_level_1'),
      houseNumber: get('street_number'),
      building: get('premise', 'subpremise'),
      street: get('route'),
    };
  }

  /** Address search is available (a Google key is configured on the server). */
  get searchEnabled(): boolean {
    return !!this.config.get('GOOGLE_MAPS_API_KEY');
  }

  /**
   * Places API (New) autocomplete, India only, biased towards [near]. The session token
   * groups the keystrokes and the final place lookup into one billed session.
   */
  async autocomplete(input: string, sessionToken: string, near?: { lat: number; lng: number }): Promise<Suggestion[]> {
    const body = {
      input,
      sessionToken,
      includedRegionCodes: ['in'],
      languageCode: 'en',
      ...(near && { locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 30000 } } }),
    };
    const res = await this.places('/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const suggestions = (res.suggestions ?? []) as {
      placePrediction?: {
        placeId: string;
        text?: { text: string };
        structuredFormat?: { mainText?: { text: string }; secondaryText?: { text: string } };
      };
    }[];
    return suggestions
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
      .map((p) => ({
        placeId: p.placeId,
        main: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        secondary: p.structuredFormat?.secondaryText?.text ?? '',
      }));
  }

  /** Location and address parts of a suggestion; ends the autocomplete session. */
  async details(placeId: string, sessionToken?: string): Promise<PlaceDetails> {
    const qs = sessionToken ? `?${new URLSearchParams({ sessionToken, languageCode: 'en' })}` : '?languageCode=en';
    const p = (await this.places(`/places/${encodeURIComponent(placeId)}${qs}`, {
      headers: { 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,addressComponents' },
    })) as {
      id: string;
      displayName?: { text: string };
      formattedAddress?: string;
      location?: { latitude: number; longitude: number };
      addressComponents?: GoogleComponent[];
    };
    if (!p.location) throw new ServiceUnavailableException('This place has no map location. Try another result.');
    const comps = p.addressComponents ?? [];
    const get = (...types: string[]) => comps.find((c) => types.some((t) => c.types.includes(t)))?.longText ?? null;
    const area = get('sublocality_level_1', 'sublocality', 'neighborhood');
    const city = get('locality', 'administrative_area_level_3');
    const name = p.displayName?.text ?? null;
    const street = get('route');
    const parts = [name, area, city].filter((x, i, arr): x is string => !!x && arr.indexOf(x) === i);
    return {
      placeId: p.id,
      lat: p.location.latitude,
      lng: p.location.longitude,
      label: parts.join(', ') || (p.formattedAddress ?? ''),
      full: p.formattedAddress ?? parts.join(', '),
      area,
      city,
      pincode: get('postal_code'),
      state: get('administrative_area_level_1'),
      houseNumber: get('street_number'),
      // The place's own name (a shop, a building) when it isn't just the street or locality.
      building: get('premise', 'subpremise') ?? (name && name !== street && name !== area && name !== city ? name : null),
      street,
    };
  }

  private async places(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const key = this.config.get('GOOGLE_MAPS_API_KEY');
    if (!key) throw new ServiceUnavailableException('Address search is not set up on the server (GOOGLE_MAPS_API_KEY).');
    let res: Response;
    try {
      res = await fetch(`${PLACES_URL}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), 'X-Goog-Api-Key': key },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      this.logger.warn(`Places ${path.split('?')[0]} failed: ${String(e)}`);
      throw new ServiceUnavailableException('Address search is unavailable right now. Check your connection and try again.');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`Places HTTP ${res.status}: ${text.slice(0, 300)}`);
      throw new ServiceUnavailableException(
        res.status === 429 ? 'Too many searches right now. Wait a moment and try again.' : 'Address search is unavailable right now.',
      );
    }
    return (await res.json()) as Record<string, unknown>;
  }
}
