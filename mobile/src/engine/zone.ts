import type { LatLng } from '../types/domain.ts';
import { planarDistanceMeters, sweptCircle, sweptPolygon, type SweepHit } from './geo/sweep.ts';
import type { EngineZone } from './types.ts';

/**
 * The reducer's three questions about a zone, on top of the reviewed swept
 * math (geo/sweep.ts). A point test is a swept test of a zero-length segment:
 * sweptCircle/sweptPolygon answer "A inside" before anything else, and treat
 * a degenerate segment as stationary.
 */

/** Did the path from -> to touch the zone? `from === to` is a point test. */
export function sweepZone(from: LatLng, to: LatLng, zone: EngineZone): SweepHit {
  return zone.kind === 'radius' ? sweptCircle(from, to, zone.center, zone.radiusM) : sweptPolygon(from, to, zone.ring);
}

/**
 * Is `p` inside the zone grown by `scale` (exit hysteresis)?
 *
 * A polygon is grown about the mean of its vertices, in degrees - the same
 * approximation geometry.ts has always used for exits. Over a plaza-sized
 * ring it is accurate to centimetres, and hysteresis only needs to be wider,
 * not exact.
 */
export function insideZone(p: LatLng, zone: EngineZone, scale = 1): boolean {
  if (zone.kind === 'radius') return sweptCircle(p, p, zone.center, zone.radiusM * scale).hit;
  if (scale === 1) return sweptPolygon(p, p, zone.ring).hit;
  const c = ringCentroid(zone.ring);
  const grown = zone.ring.map((v) => ({
    latitude: c.latitude + (v.latitude - c.latitude) * scale,
    longitude: c.longitude + (v.longitude - c.longitude) * scale,
  }));
  return sweptPolygon(p, p, grown).hit;
}

/** Metres from `p` to the zone's edge (radius) or centre (polygon); 0 inside. */
export function distanceToZoneM(p: LatLng, zone: EngineZone): number {
  if (zone.kind === 'radius') return Math.max(0, planarDistanceMeters(p, zone.center) - zone.radiusM);
  if (sweptPolygon(p, p, zone.ring).hit) return 0;
  return planarDistanceMeters(p, ringCentroid(zone.ring));
}

function ringCentroid(ring: readonly LatLng[]): LatLng {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = ring.length > 1 && first !== undefined && last !== undefined
    && first.latitude === last.latitude && first.longitude === last.longitude;
  const pts = closed ? ring.slice(0, -1) : ring;
  let lat = 0;
  let lon = 0;
  for (const v of pts) {
    lat += v.latitude;
    lon += v.longitude;
  }
  return { latitude: lat / pts.length, longitude: lon / pts.length };
}
