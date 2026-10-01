const EARTH_RADIUS_KM = 6371;

/** Multiplier from straight-line to approximate road distance in the city. */
export const ROAD_FACTOR = 1.3;

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export function roadDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return Math.round(haversineKm(lat1, lng1, lat2, lng2) * ROAD_FACTOR * 10) / 10;
}
