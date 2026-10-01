import type { AppConfig } from '../../config/app-config.service';
import { OsrmPlanner } from './osrm.planner';
import { nearestNeighbourTrip } from './route-planner';
import { RoutingService } from './routing.service';

const hub = { lat: 18.4866, lng: 73.8656 };
const katraj = { lat: 18.4529, lng: 73.8652 };
const bibwewadi = { lat: 18.4697, lng: 73.8687 };
const swargate = { lat: 18.5018, lng: 73.8636 };

// Shape of a real OSRM trip response for hub → [katraj, bibwewadi, swargate]:
// trip visits hub(0) → swargate → bibwewadi → katraj.
const osrmTrip = {
  code: 'Ok',
  waypoints: [
    { waypoint_index: 0, trips_index: 0 },
    { waypoint_index: 3, trips_index: 0 },
    { waypoint_index: 2, trips_index: 0 },
    { waypoint_index: 1, trips_index: 0 },
  ],
  trips: [
    {
      distance: 10941,
      duration: 1054,
      geometry: { coordinates: [[73.8656, 18.4866], [73.864, 18.5], [73.8652, 18.4529]] },
      legs: [
        { distance: 3063, duration: 300 },
        { distance: 5114, duration: 480 },
        { distance: 2765, duration: 274 },
      ],
    },
  ],
};

const config = { get: () => 'https://osrm.example' } as unknown as AppConfig;

describe('routing', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('maps OSRM waypoint indexes to the optimal stop order', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => osrmTrip }) as never;
    const trip = await new OsrmPlanner('https://osrm.example').planTrip(hub, [katraj, bibwewadi, swargate]);
    expect(trip.order).toEqual([2, 1, 0]); // swargate, bibwewadi, katraj
    expect(trip.totalDistanceKm).toBe(10.9);
    expect(trip.totalDurationMin).toBe(18);
    expect(trip.legs.map((l) => l.distanceKm)).toEqual([3.1, 5.1, 2.8]);
    expect(trip.geometry[0]).toEqual({ lat: 18.4866, lng: 73.8656 });
    expect(trip.optimized).toBe(true);
    const url = String((global.fetch as jest.Mock).mock.calls[0][0]);
    expect(url).toContain('/trip/v1/driving/73.865600,18.486600;');
    expect(url).toContain('source=first');
    expect(url).toContain('roundtrip=false');
  });

  it('falls back to nearest-neighbour when the provider fails, and does not cache the fallback', async () => {
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
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => osrmTrip });
    global.fetch = fetchMock as never;
    const svc = new RoutingService(config);
    await svc.planTrip(hub, [katraj, bibwewadi, swargate]);
    await svc.planTrip(hub, [katraj, bibwewadi, swargate]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('nearest-neighbour visits every stop exactly once', () => {
    const trip = nearestNeighbourTrip(hub, [katraj, swargate, bibwewadi]);
    expect([...trip.order].sort()).toEqual([0, 1, 2]);
    expect(trip.order[0]).toBe(1); // Swargate (~1.7 km) is closest to the hub
    expect(trip.totalDistanceKm).toBeGreaterThan(0);
  });

  it('returns an empty trip without calling the provider when there are no stops', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    const trip = await new RoutingService(config).planTrip(hub, []);
    expect(trip.order).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
