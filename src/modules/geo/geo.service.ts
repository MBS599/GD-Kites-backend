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

const CACHE_MAX = 5000;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Google Maps Platform for addresses: Geocoding API for pin → address and Places API
 * (New) for search. Reverse lookups are cached by ~11 m grid cell so repeated lookups
 * never hit Google.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly cache = new Map<string, { place: Place; at: number }>();

  constructor(private readonly config: AppConfig) {}

  async reverse(lat: number, lng: number): Promise<Place> {
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.place;

    let place: Place;
    try {
      place = await this.google(lat, lng);
    } catch (e) {
      this.logger.warn(`reverse geocode failed for ${key}: ${String(e)}`);
      throw new ServiceUnavailableException('Address lookup is unavailable right now.');
    }

    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { place, at: Date.now() });
    return place;
  }

  private async google(lat: number, lng: number): Promise<Place> {
    if (!this.config.get('GOOGLE_MAPS_API_KEY')) throw new Error('GOOGLE_MAPS_API_KEY is not set');
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
