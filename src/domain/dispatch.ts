import { haversineKm } from './geo';

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface GroupOptions {
  /** Most orders one driver should get in a group. */
  maxPerGroup: number;
  /** An order joins a group only if it is within this distance (km, straight line) of the group's first order. */
  radiusKm: number;
}

const dist = (a: GeoPoint, b: GeoPoint) => haversineKm(a.lat, a.lng, b.lat, b.lng);

/**
 * Groups orders around a starting order so one driver can take them all.
 *
 * Points must be given oldest first. Repeatedly:
 *  1. The oldest order not yet grouped starts a group (e.g. Katraj).
 *  2. The remaining orders nearest to it are added, closest first, while they
 *     are within `radiusKm` of it and the group has room.
 * Every order ends up in exactly one group; an order with nothing nearby is a
 * group of one.
 *
 * Returns groups of indexes into `points`, the starting order first.
 */
export function groupNearby(points: GeoPoint[], opts: GroupOptions): number[][] {
  const maxPer = Math.max(1, Math.floor(opts.maxPerGroup));
  const remaining = points.map((_, i) => i); // oldest first
  const groups: number[][] = [];

  while (remaining.length) {
    const seed = remaining.shift()!;
    const nearby = remaining
      .map((i) => ({ i, d: dist(points[seed], points[i]) }))
      .filter((c) => c.d <= opts.radiusKm)
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .slice(0, maxPer - 1)
      .map((c) => c.i);
    for (const i of nearby) remaining.splice(remaining.indexOf(i), 1);
    groups.push([seed, ...nearby]);
  }
  return groups;
}

/** Middle of a set of points (fine at city scale). */
export function centroid(points: GeoPoint[]): GeoPoint {
  const n = points.length || 1;
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / n,
    lng: points.reduce((s, p) => s + p.lng, 0) / n,
  };
}

/** Shortest straight-line distance between any point of `a` and any point of `b`. */
export function nearestBetween(a: GeoPoint[], b: GeoPoint[]): number {
  let best = Infinity;
  for (const p of a) for (const q of b) best = Math.min(best, dist(p, q));
  return best;
}
