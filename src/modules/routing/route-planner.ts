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
  /** Last stop → `end` (e.g. back to the hub), when an end was given. */
  returnLeg: { distanceKm: number; durationMin: number } | null;
  /** Whole trip, including `returnLeg`. */
  totalDistanceKm: number;
  totalDurationMin: number;
  /** Road-following polyline from origin through all stops (and on to `end`). */
  geometry: LatLng[];
  /** False when the fallback heuristic was used (provider unavailable). */
  optimized: boolean;
  provider: string;
}

/** Road routing provider. OSRM today; a Google Routes implementation can be added later. */
export interface RoutePlanner {
  readonly name: string;
  /**
   * Best trip starting at `origin` that visits every stop once, then goes to
   * `end` (e.g. back to the hub) — or ends at the last stop when `end` is omitted.
   * The stop order is chosen with the final leg included.
   */
  planTrip(origin: LatLng, stops: LatLng[], end?: LatLng): Promise<PlannedTrip>;
}

const ROAD_FACTOR = 1.3;
const AVG_KMPH = 22;

/**
 * Offline fallback: greedy nearest-neighbour on straight-line distance with a
 * road factor. Used when the routing provider is unreachable.
 */
export function nearestNeighbourTrip(origin: LatLng, stops: LatLng[], end?: LatLng): PlannedTrip {
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
  let returnLeg: PlannedTrip['returnLeg'] = null;
  if (end && stops.length) {
    const km = Math.round(haversineKm(from.lat, from.lng, end.lat, end.lng) * ROAD_FACTOR * 10) / 10;
    returnLeg = { distanceKm: km, durationMin: Math.max(1, Math.round((km / AVG_KMPH) * 60)) };
  }
  const all = returnLeg ? [...legs, returnLeg] : legs;
  return {
    order,
    legs,
    returnLeg,
    totalDistanceKm: Math.round(all.reduce((s, l) => s + l.distanceKm, 0) * 10) / 10,
    totalDurationMin: all.reduce((s, l) => s + l.durationMin, 0),
    geometry: [origin, ...order.map((i) => stops[i]), ...(returnLeg && end ? [end] : [])],
    optimized: false,
    provider: 'fallback',
  };
}
