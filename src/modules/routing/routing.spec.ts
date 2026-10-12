import type { AppConfig } from '../../config/app-config.service';
import { decodePolyline } from './google-routes';
import { GooglePlanner } from './google.planner';
import { nearestNeighbourTrip } from './route-planner';
import { RoutingService } from './routing.service';

const hub = { lat: 18.4866, lng: 73.8656 };
const katraj = { lat: 18.4529, lng: 73.8652 };
const bibwewadi = { lat: 18.4697, lng: 73.8687 };
const swargate = { lat: 18.5018, lng: 73.8636 };

// Google Routes answer for hub → [katraj, bibwewadi, swargate] → hub with optimizeWaypointOrder:
// visits swargate (2), bibwewadi (1), katraj (0), then drives back to the hub.
const roundTrip = {
  routes: [
    {
      distanceMeters: 14441,
      duration: '1474s',
      optimizedIntermediateWaypointIndex: [2, 1, 0],
      polyline: { encodedPolyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
      legs: [
        { distanceMeters: 3063, duration: '300s' },
        { distanceMeters: 5114, duration: '480s' },
        { distanceMeters: 2765, duration: '274s' },
        { distanceMeters: 3500, duration: '420s' },
      ],
    },
  ],
};

const config = { get: () => 'key-123' } as unknown as AppConfig;
const ok = (body: object) => jest.fn().mockResolvedValue({ ok: true, json: async () => body });

describe('routing (Google Routes)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('maps the optimised waypoint order, legs, return leg and totals', async () => {
    const fetchMock = ok(roundTrip);
    global.fetch = fetchMock as never;
    const trip = await new GooglePlanner('key-123').planTrip(hub, [katraj, bibwewadi, swargate], hub);
    expect(trip.order).toEqual([2, 1, 0]); // swargate, bibwewadi, katraj
    expect(trip.legs.map((l) => l.distanceKm)).toEqual([3.1, 5.1, 2.8]);
    expect(trip.returnLeg).toEqual({ distanceKm: 3.5, durationMin: 7 });
    expect(trip.totalDistanceKm).toBe(14.4);
    expect(trip.totalDurationMin).toBe(25);
    expect(trip.optimized).toBe(true);
    expect(trip.provider).toBe('google');
    expect(trip.geometry.length).toBeGreaterThan(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://routes.googleapis.com/directions/v2:computeRoutes');
    const body = JSON.parse(init.body);
    expect(body.optimizeWaypointOrder).toBe(true);
    expect(body.intermediates).toHaveLength(3);
    expect(body.destination.location.latLng).toEqual({ latitude: hub.lat, longitude: hub.lng });
    expect(init.headers['X-Goog-FieldMask']).toContain('routes.optimizedIntermediateWaypointIndex');
  });

  it('without an end, finishes at the stop farthest from the origin', async () => {
    const fetchMock = ok({
      routes: [
        {
          distanceMeters: 8000,
          duration: '900s',
          optimizedIntermediateWaypointIndex: [1, 0],
          legs: [
            { distanceMeters: 2000, duration: '200s' },
            { distanceMeters: 3000, duration: '300s' },
            { distanceMeters: 3000, duration: '400s' },
          ],
        },
      ],
    });
    global.fetch = fetchMock as never;
    // Katraj (index 0) is farthest from the hub, so it is the destination; swargate and bibwewadi are waypoints.
    const trip = await new GooglePlanner('key-123').planTrip(hub, [katraj, bibwewadi, swargate]);
    expect(trip.order).toEqual([2, 1, 0]);
    expect(trip.returnLeg).toBeNull();
    expect(trip.legs).toHaveLength(3);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.destination.location.latLng).toEqual({ latitude: katraj.lat, longitude: katraj.lng });
    expect(body.intermediates).toHaveLength(2);
  });

  it('decodes Google polylines', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  it('falls back to nearest-neighbour when Google fails, and does not cache the fallback', async () => {
    const fetchMock = jest.fn().mockRejectedValue(new Error('offline'));
    global.fetch = fetchMock as never;
    const svc = new RoutingService(config);
    const trip = await svc.planTrip(hub, [swargate, katraj, bibwewadi]);
    expect(trip.optimized).toBe(false);
    expect(trip.order).toHaveLength(3);
    await svc.planTrip(hub, [swargate, katraj, bibwewadi]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caches successful plans for identical inputs', async () => {
    const fetchMock = ok(roundTrip);
    global.fetch = fetchMock as never;
    const svc = new RoutingService(config);
    await svc.planTrip(hub, [katraj, bibwewadi, swargate], hub);
    await svc.planTrip(hub, [katraj, bibwewadi, swargate], hub);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fallback also drives back to the hub', () => {
    const trip = nearestNeighbourTrip(hub, [katraj, swargate], hub);
    expect(trip.returnLeg!.distanceKm).toBeGreaterThan(0);
    const legsKm = trip.legs.reduce((s, l) => s + l.distanceKm, 0) + trip.returnLeg!.distanceKm;
    expect(trip.totalDistanceKm).toBeCloseTo(legsKm, 1);
    expect(trip.geometry[trip.geometry.length - 1]).toEqual(hub);
    expect(nearestNeighbourTrip(hub, [katraj]).returnLeg).toBeNull();
  });

  it('nearest-neighbour visits every stop exactly once', () => {
    const trip = nearestNeighbourTrip(hub, [katraj, swargate, bibwewadi]);
    expect([...trip.order].sort()).toEqual([0, 1, 2]);
    expect(trip.order[0]).toBe(1); // Swargate (~1.7 km) is closest to the hub
    expect(trip.totalDistanceKm).toBeGreaterThan(0);
  });

  it('returns an empty trip without calling Google when there are no stops', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const trip = await new RoutingService(config).planTrip(hub, []);
    expect(trip.order).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
