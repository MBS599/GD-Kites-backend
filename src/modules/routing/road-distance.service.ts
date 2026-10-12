import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config.service';
import { roadDistanceKm } from '../../domain/geo';
import { computeRoute, km } from './google-routes';

const CACHE_MAX = 20_000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Driving distance (km) along real roads, from the Google Routes API — what the
 * delivery charge and the driver's fare are based on. Results are cached per ~11 m
 * cell pair, so the quote, the saved address and the order use one lookup. If Google
 * can't be reached, falls back to the straight-line estimate (× road factor) so
 * checkout never stops.
 */
@Injectable()
export class RoadDistanceService {
  private readonly logger = new Logger(RoadDistanceService.name);
  private readonly cache = new Map<string, { km: number; at: number }>();
  private readonly inflight = new Map<string, Promise<number>>();

  constructor(private readonly config: AppConfig) {}

  async km(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number> {
    const key = [from.lat, from.lng, to.lat, to.lng].map((n) => n.toFixed(4)).join(',');
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.km;
    const running = this.inflight.get(key);
    if (running) return running;

    const job = this.google(from, to)
      .then((d) => {
        if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { km: d, at: Date.now() });
        return d;
      })
      .catch((e: unknown) => {
        this.logger.warn(`road distance unavailable, using estimate: ${String(e)}`);
        return roadDistanceKm(from.lat, from.lng, to.lat, to.lng);
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async google(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<number> {
    const route = await computeRoute(
      this.config.get('GOOGLE_MAPS_API_KEY'),
      { origin: from, destination: to },
      'routes.distanceMeters',
      6000,
    );
    if (route.distanceMeters == null) throw new Error('Google Routes: no distance');
    return km(route.distanceMeters);
  }
}
