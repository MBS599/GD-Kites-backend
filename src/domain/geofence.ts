import { haversineKm, roadDistanceKm } from './geo';

export interface GeoArea {
  id: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  hubLat: number;
  hubLng: number;
  isActive: boolean;
}

/** True when the point lies inside the area's circle (straight-line distance). */
export function contains(area: GeoArea, lat: number, lng: number): boolean {
  return haversineKm(area.centerLat, area.centerLng, lat, lng) <= area.radiusKm;
}

/**
 * The active area serving a point. When circles overlap, the area whose
 * centre is closest wins. Returns null when the point is not serviceable.
 */
export function findServiceArea<T extends GeoArea>(areas: T[], lat: number, lng: number): T | null {
  let best: T | null = null;
  let bestDist = Infinity;
  for (const a of areas) {
    if (!a.isActive || !contains(a, lat, lng)) continue;
    const d = haversineKm(a.centerLat, a.centerLng, lat, lng);
    if (d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

/** Road distance from the area's dispatch hub — basis for charges and fares. */
export function distanceFromHub(area: GeoArea, lat: number, lng: number): number {
  return roadDistanceKm(area.hubLat, area.hubLng, lat, lng);
}
