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
    return {
      label: parts.length ? parts.join(', ') : (body.display_name ?? '').split(',').slice(0, 3).join(',').trim(),
      full: body.display_name ?? parts.join(', '),
      area,
      city,
      pincode: a.postcode ?? null,
      state: a.state ?? null,
    };
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
    };
  }
}
