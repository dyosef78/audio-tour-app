import type { GeofenceZone, LatLng } from '../../types/domain';

/**
 * Local spatial predicates.
 *
 * The backend has PostGIS, but the device does not - the tour runs offline, so
 * every containment test has to happen here in plain TypeScript against the
 * downloaded bundle. These are pure functions with no platform dependencies,
 * which also makes them the part of the engine that can be unit-tested without
 * a device or a GPS fix.
 */

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in metres.
 *
 * Haversine rather than a projected/equirectangular approximation: at the
 * 20-300 m scale of our geofences the difference is negligible, but haversine
 * costs nothing here and does not degrade at high latitude or across the
 * antimeridian, so there is no reason to take on that failure mode.
 */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/**
 * Ray-casting point-in-polygon over lon/lat treated as a plane.
 *
 * Safe for our polygons: a city plaza spans ~100 m, far too small for the
 * planar approximation to matter. It would NOT be safe for a polygon spanning
 * degrees, or one crossing the antimeridian.
 *
 * Vertices on the boundary are not guaranteed either way - which is fine,
 * because the hysteresis in LocationService means a boundary-exact fix is never
 * load-bearing.
 */
export function isPointInPolygon(point: LatLng, ring: LatLng[]): boolean {
  if (ring.length < 3) return false;

  const { longitude: x, latitude: y } = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const vi = ring[i];
    const vj = ring[j];
    if (!vi || !vj) continue;

    const intersects =
      vi.latitude > y !== vj.latitude > y &&
      x <
        ((vj.longitude - vi.longitude) * (y - vi.latitude)) /
          (vj.latitude - vi.latitude) +
          vi.longitude;

    if (intersects) inside = !inside;
  }

  return inside;
}

/**
 * Is `point` inside `zone`?
 *
 * `scale` widens the zone for exit tests (hysteresis). For radius zones it
 * multiplies the radius directly. For polygon zones there is no cheap true
 * buffer, so we approximate: scale the ring outward from its centroid. That is
 * good enough to stop boundary jitter, which is all hysteresis needs to do.
 */
export function isInsideZone(point: LatLng, zone: GeofenceZone, scale = 1): boolean {
  if (zone.zoneType === 'radius') {
    return distanceMeters(point, zone.center) <= zone.radiusMeters * scale;
  }

  if (scale === 1) return isPointInPolygon(point, zone.ring);

  const c = centroid(zone.ring);
  const grown = zone.ring.map((v) => ({
    latitude: c.latitude + (v.latitude - c.latitude) * scale,
    longitude: c.longitude + (v.longitude - c.longitude) * scale,
  }));
  return isPointInPolygon(point, grown);
}

/** Distance to a zone's reference point; 0 when already inside. */
export function distanceToZone(point: LatLng, zone: GeofenceZone): number {
  if (zone.zoneType === 'radius') {
    return Math.max(0, distanceMeters(point, zone.center) - zone.radiusMeters);
  }
  if (isPointInPolygon(point, zone.ring)) return 0;
  return distanceMeters(point, centroid(zone.ring));
}

/** Arithmetic mean of ring vertices, ignoring the duplicated closing vertex. */
export function centroid(ring: LatLng[]): LatLng {
  const isClosed =
    ring.length > 1 &&
    ring[0]?.latitude === ring[ring.length - 1]?.latitude &&
    ring[0]?.longitude === ring[ring.length - 1]?.longitude;

  const pts = isClosed ? ring.slice(0, -1) : ring;
  if (pts.length === 0) return { latitude: 0, longitude: 0 };

  const sum = pts.reduce(
    (acc, p) => ({
      latitude: acc.latitude + p.latitude,
      longitude: acc.longitude + p.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );

  return { latitude: sum.latitude / pts.length, longitude: sum.longitude / pts.length };
}
