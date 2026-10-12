import type { LatLng } from './route-planner';

/** Google Routes API (computeRoutes), driving, no live traffic — the cheaper Essentials tier. */
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export interface GoogleRoute {
  distanceMeters?: number;
  /** e.g. "1234s" */
  duration?: string;
  legs?: { distanceMeters?: number; duration?: string }[];
  polyline?: { encodedPolyline?: string };
  optimizedIntermediateWaypointIndex?: number[];
}

const waypoint = (p: LatLng) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });

export async function computeRoute(
  key: string,
  route: { origin: LatLng; destination: LatLng; intermediates?: LatLng[]; optimize?: boolean },
  fieldMask: string,
  timeoutMs: number,
): Promise<GoogleRoute> {
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is not set');
  const res = await fetch(ROUTES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask },
    body: JSON.stringify({
      origin: waypoint(route.origin),
      destination: waypoint(route.destination),
      ...(route.intermediates?.length && { intermediates: route.intermediates.map(waypoint) }),
      ...(route.optimize && { optimizeWaypointOrder: true }),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      languageCode: 'en',
      regionCode: 'IN',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Routes HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = (await res.json()) as { routes?: GoogleRoute[] };
  const top = body.routes?.[0];
  if (!top) throw new Error('Google Routes: no route');
  return top;
}

/** "1234s" → minutes (at least 1). */
export const minutes = (d?: string) => Math.max(1, Math.round((parseFloat(d ?? '0') || 0) / 60));
/** metres → km, one decimal. */
export const km = (m?: number) => Math.round(((m ?? 0) / 1000) * 10) / 10;

/** Google's encoded polyline format → points. */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < encoded.length) {
    lat += next();
    lng += next();
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}
