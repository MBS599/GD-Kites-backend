import { contains, distanceFromHub, findServiceArea, type GeoArea } from './geofence';

const pune: GeoArea = {
  id: 'pune', centerLat: 18.5204, centerLng: 73.8567, radiusKm: 25,
  hubLat: 18.4866, hubLng: 73.8656, isActive: true,
};
const ahilyanagar: GeoArea = {
  id: 'ahilyanagar', centerLat: 19.0948, centerLng: 74.748, radiusKm: 15,
  hubLat: 19.0948, hubLng: 74.748, isActive: false,
};
const katraj = { lat: 18.4529, lng: 73.8652 };
const ahilyanagarBazaar = { lat: 19.09, lng: 74.74 };

describe('geofence', () => {
  it('contains points inside the radius only', () => {
    expect(contains(pune, katraj.lat, katraj.lng)).toBe(true);
    expect(contains(pune, ahilyanagarBazaar.lat, ahilyanagarBazaar.lng)).toBe(false);
  });

  it('ignores inactive areas', () => {
    expect(findServiceArea([pune, ahilyanagar], ahilyanagarBazaar.lat, ahilyanagarBazaar.lng)).toBeNull();
    const live = { ...ahilyanagar, isActive: true };
    expect(findServiceArea([pune, live], ahilyanagarBazaar.lat, ahilyanagarBazaar.lng)?.id).toBe('ahilyanagar');
  });

  it('picks the nearest centre when circles overlap', () => {
    const pcmc: GeoArea = { ...pune, id: 'pcmc', centerLat: 18.6298, centerLng: 73.7997, radiusKm: 25 };
    expect(findServiceArea([pune, pcmc], katraj.lat, katraj.lng)?.id).toBe('pune');
    expect(findServiceArea([pune, pcmc], 18.63, 73.8)?.id).toBe('pcmc');
  });

  it('measures distance from the area hub, not the centre', () => {
    expect(distanceFromHub(pune, pune.hubLat, pune.hubLng)).toBe(0);
    expect(distanceFromHub(pune, katraj.lat, katraj.lng)).toBeGreaterThan(3);
  });
});
