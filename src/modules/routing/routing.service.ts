import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { OsrmPlanner } from './osrm.planner';
import { nearestNeighbourTrip, type LatLng, type PlannedTrip, type RoutePlanner } from './route-planner';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

/**
 * Plans driver trips through the configured provider, with a short cache (the
 * Route tab re-requests often) and a heuristic fallback so drivers always get
 * a usable stop order even if the provider is down.
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  private readonly planner: RoutePlanner;
  private readonly cache = new Map<string, { trip: PlannedTrip; at: number }>();

  constructor(config: AppConfig) {
    this.planner = new OsrmPlanner(config.get('OSRM_URL'));
  }

  async planTrip(origin: LatLng, stops: LatLng[]): Promise<PlannedTrip> {
    if (stops.length === 0) {
      return { order: [], legs: [], totalDistanceKm: 0, totalDurationMin: 0, geometry: [origin], optimized: true, provider: this.planner.name };
    }
    const key = [origin, ...stops].map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join('|');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.trip;

    let trip: PlannedTrip;
    try {
      trip = await this.planner.planTrip(origin, stops);
    } catch (e) {
      this.logger.warn(`route planning via ${this.planner.name} failed, using fallback: ${String(e)}`);
      return nearestNeighbourTrip(origin, stops); // not cached: retry the provider next time
    }
    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { trip, at: Date.now() });
    return trip;
  }
}
