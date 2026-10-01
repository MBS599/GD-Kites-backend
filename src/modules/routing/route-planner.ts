import { haversineKm } from '../../domain/geo';

export interface LatLng {
  lat: number;
  lng: number;
}

/** A solved driver trip: stop order plus road geometry and per-leg figures. */
export interface PlannedTrip {
  /** Indexes into the input `stops`, in visiting order. */
  order: number[];
  /** Per visited stop (same order as `order`): distance/time of the leg arriving there. */
  legs: { distanceKm: number; durationMin: number }[];
  totalDistanceKm: number;
  totalDurationMin: number;
  /** Road-following polyline from origin through all stops. */
  geometry: LatLng[];
  /** False when the fallback heuristic was used (provider unavailable). */
  optimized: boolean;
  provider: string;
}

/** Road routing provider. OSRM today; a Google Routes implementation can be added later. */
export interface RoutePlanner {
  readonly name: string;
  /** Best open trip starting at `origin` visiting every stop once (ending anywhere). */
  planTrip(origin: LatLng, stops: LatLng[]): Promise<PlannedTrip>;
}

const ROAD_FACTOR = 1.3;
const AVG_KMPH = 22;

/**
 * Offline fallback: greedy nearest-neighbour on straight-line distance with a
 * road factor. Used when the routing provider is unreachable.
 */
export function nearestNeighbourTrip(origin: LatLng, stops: LatLng[]): PlannedTrip {
  const remaining = stops.map((_, i) => i);
  const order: number[] = [];
  const legs: PlannedTrip['legs'] = [];
  let from = origin;
  while (remaining.length) {
    remaining.sort(
      (a, b) =>
        haversineKm(from.lat, from.lng, stops[a].lat, stops[a].lng) -
        haversineKm(from.lat, from.lng, stops[b].lat, stops[b].lng),
    );
    const next = remaining.shift()!;
    const km = Math.round(haversineKm(from.lat, from.lng, stops[next].lat, stops[next].lng) * ROAD_FACTOR * 10) / 10;
    legs.push({ distanceKm: km, durationMin: Math.max(1, Math.round((km / AVG_KMPH) * 60)) });
    order.push(next);
    from = stops[next];
  }
  return {
    order,
    legs,
    totalDistanceKm: Math.round(legs.reduce((s, l) => s + l.distanceKm, 0) * 10) / 10,
    totalDurationMin: legs.reduce((s, l) => s + l.durationMin, 0),
    geometry: [origin, ...order.map((i) => stops[i])],
    optimized: false,
    provider: 'fallback',
  };
}
