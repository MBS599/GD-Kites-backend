import { groupNearby, nearestBetween } from './dispatch';

// Real customer locations from the seed data (Pune).
const katraj = { lat: 18.4529, lng: 73.8652 };
const ambegaon = { lat: 18.4541, lng: 73.8446 };
const dhankawadi = { lat: 18.4637, lng: 73.8533 };
const bibwewadi = { lat: 18.4697, lng: 73.8687 };
const swargate = { lat: 18.5018, lng: 73.8636 };
const hadapsar = { lat: 18.5089, lng: 73.926 };

describe('groupNearby', () => {
  it('starts from the oldest order and groups the orders nearest to it', () => {
    // Oldest first: Katraj, then a mix.
    const points = [katraj, hadapsar, bibwewadi, swargate, dhankawadi, ambegaon];
    const groups = groupNearby(points, { maxPerGroup: 8, radiusKm: 4 });
    const named = groups.map((g) => g.map((i) => points[i]));
    // Katraj group: its neighbours, closest first (Dhankawadi ≈1.6 km, Bibwewadi ≈1.9, Ambegaon ≈2.2).
    expect(named[0]).toEqual([katraj, dhankawadi, bibwewadi, ambegaon]);
    // Swargate is ≈5.4 km from Katraj, so not in the Katraj group even though it is 3.6 km from Bibwewadi.
    expect(named[0]).not.toContainEqual(swargate);
    // The remaining orders start their own groups, oldest first.
    expect(named.slice(1)).toEqual([[hadapsar], [swargate]]);
    expect(groups.flat().sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('caps how many orders one driver gets', () => {
    const groups = groupNearby([katraj, dhankawadi, bibwewadi, ambegaon], { maxPerGroup: 2, radiusKm: 4 });
    expect(groups).toEqual([
      [0, 1], // Katraj + its nearest (Dhankawadi)
      [2, 3], // next oldest (Bibwewadi) + Ambegaon
    ]);
  });

  it('a bigger radius pulls in more areas', () => {
    const groups = groupNearby([katraj, swargate, bibwewadi], { maxPerGroup: 10, radiusKm: 6 });
    expect(groups).toHaveLength(1);
  });

  it('handles no orders', () => {
    expect(groupNearby([], { maxPerGroup: 5, radiusKm: 3 })).toEqual([]);
  });

  it('nearestBetween measures the closest pair', () => {
    expect(nearestBetween([katraj], [katraj, hadapsar])).toBe(0);
    expect(nearestBetween([katraj], [hadapsar])).toBeGreaterThan(7);
  });
});
