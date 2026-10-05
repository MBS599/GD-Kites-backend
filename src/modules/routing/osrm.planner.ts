import type { LatLng, PlannedTrip, RoutePlanner } from './route-planner';

interface OsrmTripResponse {
  code: string;
  message?: string;
  waypoints: { waypoint_index: number; trips_index: number }[];
  trips: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
    legs: { distance: number; duration: number }[];
  }[];
}

/** OSRM `trip` service: solves stop order on the real road network. */
export class OsrmPlanner implements RoutePlanner {
  readonly name = 'osrm';

  constructor(private readonly baseUrl: string) {}

  async planTrip(origin: LatLng, stops: LatLng[], end?: LatLng): Promise<PlannedTrip> {
    // With an end point (the hub) it is the last input and the trip must finish there,
    // so OSRM picks the stop order that also keeps the drive back short.
    const inputs = end ? [origin, ...stops, end] : [origin, ...stops];
    const points = inputs.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = new URL(`/trip/v1/driving/${points}`, this.baseUrl);
    url.search = new URLSearchParams({
      source: 'first',
      roundtrip: 'false',
      destination: end ? 'last' : 'any',
      geometries: 'geojson',
      overview: 'full',
    }).toString();

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const body = (await res.json()) as OsrmTripResponse;
    if (body.code !== 'Ok' || !body.trips?.length) throw new Error(`OSRM ${body.code}: ${body.message ?? ''}`);

    // waypoints[i] is input point i; waypoint_index is its position in the trip.
    // Input 0 is the origin (source=first), stops are inputs 1..n, the end (if any) n+1.
    const byPosition = body.waypoints
      .map((w, input) => ({ input, pos: w.waypoint_index }))
      .filter((w) => w.input > 0 && w.input <= stops.length)
      .sort((a, b) => a.pos - b.pos);
    const trip = body.trips[0];
    const legs = trip.legs.map((l) => ({
      distanceKm: Math.round((l.distance / 1000) * 10) / 10,
      durationMin: Math.max(1, Math.round(l.duration / 60)),
    }));

    return {
      order: byPosition.map((w) => w.input - 1),
      legs: legs.slice(0, stops.length),
      returnLeg: end ? (legs[stops.length] ?? null) : null,
      totalDistanceKm: Math.round((trip.distance / 1000) * 10) / 10,
      totalDurationMin: Math.max(1, Math.round(trip.duration / 60)),
      geometry: trip.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      optimized: true,
      provider: this.name,
    };
  }
}
