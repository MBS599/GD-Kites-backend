import { haversineKm } from '../../domain/geo';
import { computeRoute, decodePolyline, km, minutes } from './google-routes';
import type { LatLng, PlannedTrip, RoutePlanner } from './route-planner';

/** Google allows up to 25 intermediate waypoints when it optimises their order. */
export const MAX_GOOGLE_STOPS = 25;

/** Google Routes API with `optimizeWaypointOrder`: the stop order on the real road network. */
export class GooglePlanner implements RoutePlanner {
  readonly name = 'google';

  constructor(private readonly key: string) {}

  async planTrip(origin: LatLng, stops: LatLng[], end?: LatLng): Promise<PlannedTrip> {
    // Google needs a fixed destination. With an end (the hub) every stop is a waypoint and
    // the trip finishes at the hub; without one, the trip ends at the stop farthest from
    // the origin and the others are visited on the way.
    const last = end ? -1 : farthest(origin, stops);
    const via = stops.map((p, i) => ({ p, i })).filter((s) => s.i !== last);
    if (via.length > MAX_GOOGLE_STOPS) throw new Error(`more than ${MAX_GOOGLE_STOPS} stops`);

    const route = await computeRoute(
      this.key,
      { origin, destination: end ?? stops[last], intermediates: via.map((s) => s.p), optimize: via.length > 1 },
      'routes.distanceMeters,routes.duration,routes.legs.distanceMeters,routes.legs.duration,routes.polyline.encodedPolyline,routes.optimizedIntermediateWaypointIndex',
      10_000,
    );
    // optimizedIntermediateWaypointIndex[k] = which intermediate is visited k-th.
    const visit = route.optimizedIntermediateWaypointIndex?.length === via.length
      ? route.optimizedIntermediateWaypointIndex
      : via.map((_, k) => k);
    const order = [...visit.map((k) => via[k].i), ...(end ? [] : [last])];
    const legs = (route.legs ?? []).map((l) => ({ distanceKm: km(l.distanceMeters), durationMin: minutes(l.duration) }));
    if (legs.length !== stops.length + (end ? 1 : 0)) throw new Error('Google Routes: unexpected number of legs');

    return {
      order,
      legs: legs.slice(0, stops.length),
      returnLeg: end ? legs[stops.length] : null,
      totalDistanceKm: km(route.distanceMeters),
      totalDurationMin: minutes(route.duration),
      geometry: route.polyline?.encodedPolyline ? decodePolyline(route.polyline.encodedPolyline) : [origin, ...order.map((i) => stops[i])],
      optimized: true,
      provider: this.name,
    };
  }
}

function farthest(origin: LatLng, stops: LatLng[]): number {
  let best = 0;
  stops.forEach((s, i) => {
    if (haversineKm(origin.lat, origin.lng, s.lat, s.lng) > haversineKm(origin.lat, origin.lng, stops[best].lat, stops[best].lng)) best = i;
  });
  return best;
}
