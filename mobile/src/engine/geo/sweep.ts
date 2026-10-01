import type { LatLng } from '../../types/domain.ts';

/**
 * Swept geofence test (Epic 15).
 *
 * A point test asks "is this fix inside the zone?" and misses any zone the
 * fixes step over: at 100 km/h a 1 Hz fix stream is 28 m apart, and a road
 * passing 215 m from the centre of a 220 m zone crosses it for only 93 m. The
 * swept test asks "did the straight path between the previous fix and this
 * one cross the zone?", which cannot step over anything.
 *
 * Pure and synchronous. No React Native imports: the reducer and the Node
 * simulator call it directly.
 *
 * NUMERICS - WHY A LOCAL PLANE, NOT SPHERICAL FORMULAS
 *
 * Every test runs in a local east/north frame in metres, centred on the
 * segment's start A:
 *
 *   x = R * dLon * cos(lat0),   y = R * dLat     (dLon wrapped to [-180, 180))
 *
 *   * Accuracy. Over the <= 2 km the reducer ever sweeps, the equirectangular
 *     error is about |dLat| * tan(lat0) relative - at Tel Aviv, 1 km north
 *     moves the scale by 1e-4, i.e. 10 cm. Zones are 15-300 m. Tests pin the
 *     error against haversine at latitudes up to 70 degrees.
 *   * Stability. Spherical cross/along-track distances need acos(cos d13 /
 *     cos dxt), which loses every significant digit when both cosines are
 *     ~1 - exactly the metre-scale case. Here every quantity is a small
 *     difference taken ONCE, in degrees, then scaled: no catastrophic
 *     cancellation, and the products stay ~1e6 m^2, far from double limits.
 *   * The antimeridian. dLon is wrapped, so a segment from 179.9999 E to
 *     179.9999 W is 22 m long, not 40,000 km.
 *
 * Not for: segments or polygons spanning more than a few km, or the poles
 * (cos(lat0) -> 0). The reducer never sweeps a gap above MAX_SWEEP_METERS.
 */

export const EARTH_RADIUS_M = 6_371_000;

/**
 * The reducer falls back to a point test above this (a tunnel exit, a
 * teleporting cell fix): the straight line between two such fixes is not
 * the path travelled. Also bounds the planar approximation's error.
 */
export const MAX_SWEEP_METERS = 2_000;

/** A segment shorter than this is a stationary fix: point test. 1 mm. */
const DEGENERATE_SEGMENT_M2 = 1e-6;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Planar vector in metres. */
export interface Vec {
  x: number;
  y: number;
}

/** Longitude difference wrapped into [-180, 180). */
export function wrapLonDelta(deg: number): number {
  // JS % keeps the dividend's sign, hence the second +360 / % pass. The
  // inner value is in [0, 360) - an exact 360 from (-0 + 360) is folded back
  // to 0 by the outer % - so the result is in [-180, 180).
  return ((((deg + 180) % 360) + 360) % 360) - 180;
}

/** A local east/north frame in metres around `origin`. */
export function localFrame(origin: LatLng): (p: LatLng) => Vec {
  assertFinitePoint(origin, 'origin');
  const cosLat = Math.cos(toRad(origin.latitude));
  const kx = toRad(1) * EARTH_RADIUS_M * cosLat;
  const ky = toRad(1) * EARTH_RADIUS_M;
  return (p) => {
    assertFinitePoint(p, 'point');
    return {
      x: wrapLonDelta(p.longitude - origin.longitude) * kx,
      y: (p.latitude - origin.latitude) * ky,
    };
  };
}

const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x;
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * Where a swept segment first meets a zone.
 *
 * `t` is the fraction of the way from A to B at which the path ENTERS the zone:
 * 0 when A is already inside. The reducer uses it to interpolate the trigger
 * time and to order two zones crossed by the same segment.
 */
export type SweepHit = { hit: false } | { hit: true; t: number };

const MISS: SweepHit = { hit: false };

// -----------------------------------------------------------------------------
// Circle
// -----------------------------------------------------------------------------

/**
 * Does the segment A->B pass within `radiusMeters` of `center`?
 *
 * In the frame centred on A, with d = B - A and c = center:
 *
 *   tc = (c . d) / (d . d)           parameter of the point on the LINE
 *                                    closest to c (not clamped yet)
 *   h  = |d x c| / |d|               perpendicular distance from c to the line
 *   half-chord in t:  w = sqrt(r^2 - h^2) / |d|
 *   the LINE is inside the circle for t in [tc - w, tc + w]
 *
 * The SEGMENT is t in [0, 1], so it touches the circle iff the two intervals
 * overlap, and it enters at max(0, tc - w).
 *
 * Why this form and not the textbook quadratic |A + t d - c|^2 = r^2: the
 * quadratic's (-b +- sqrt(b^2 - 4ac)) / 2a cancels catastrophically when the
 * segment is short relative to its distance from the centre - the common case
 * at 1 Hz. h from the cross product and tc from the dot product are each one
 * well-conditioned operation, and r^2 - h^2 is only subtracted after h <= r is
 * known, so the sqrt never sees a negative.
 *
 * Boundary: a path exactly tangent (h == r) counts as a hit, matching
 * isInsideZone's `<=`. A tangent pass is a zero-length chord; at the
 * reducer's level it is indistinguishable from a 1 cm one.
 */
export function sweptCircle(a: LatLng, b: LatLng, center: LatLng, radiusMeters: number): SweepHit {
  if (!(radiusMeters > 0) || !Number.isFinite(radiusMeters)) {
    throw new RangeError(`sweptCircle: radius must be a positive finite number, got ${radiusMeters}`);
  }
  const toLocal = localFrame(a);
  const d = toLocal(b);
  const c = toLocal(center);
  const r2 = radiusMeters * radiusMeters;

  // A already inside: the path "enters" at its start.
  if (dot(c, c) <= r2) return { hit: true, t: 0 };

  const dd = dot(d, d);
  if (dd < DEGENERATE_SEGMENT_M2) return MISS; // stationary, and A is outside

  const h = Math.abs(cross(d, c)) / Math.sqrt(dd);
  if (h > radiusMeters) return MISS;

  const tc = dot(c, d) / dd;
  const w = Math.sqrt(r2 - h * h) / Math.sqrt(dd);
  const tEnter = tc - w;
  const tExit = tc + w;
  // A is outside, so tEnter > 0 whenever the circle lies ahead; a circle
  // wholly behind A has tExit < 0.
  if (tExit < 0 || tEnter > 1) return MISS;
  return { hit: true, t: Math.max(0, tEnter) };
}

// -----------------------------------------------------------------------------
// Polygon
// -----------------------------------------------------------------------------

/**
 * Does the segment A->B touch the polygon `ring` (exterior ring, lon/lat; a
 * closing vertex equal to the first is allowed and ignored)?
 *
 *   * A inside            -> hit at t = 0
 *   * otherwise, the smallest t at which A->B crosses or touches an edge
 *   * B inside but no edge crossed cannot happen for a simple polygon with A
 *     outside, and is still checked last, so a ring with a defect cannot turn
 *     a real entry into a miss
 *
 * Works for concave rings: a path through a U-shaped polygon's notch crosses
 * no edge and has neither end inside, so it is a miss, as it should be.
 *
 * Orientation-agnostic (clockwise or not). Holes are not modelled: the bundle
 * ships only the exterior ring (get_tour_bundle: coordinates -> 0).
 */
export function sweptPolygon(a: LatLng, b: LatLng, ring: readonly LatLng[]): SweepHit {
  const pts = openRing(ring);
  if (pts.length < 3) {
    throw new RangeError(`sweptPolygon: a ring needs at least 3 distinct vertices, got ${pts.length}`);
  }
  const toLocal = localFrame(a);
  const poly = pts.map(toLocal);
  const origin: Vec = { x: 0, y: 0 };
  const d = toLocal(b);

  if (pointInPolygon(origin, poly)) return { hit: true, t: 0 };

  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const t = segmentIntersectionT(origin, d, poly[j] as Vec, poly[i] as Vec);
    if (t !== null && t < best) best = t;
  }
  if (best !== Infinity) return { hit: true, t: best };

  // Defensive only for malformed (self-intersecting) rings; see above.
  if (pointInPolygon(d, poly)) return { hit: true, t: 1 };
  return MISS;
}

/**
 * Parameter t in [0, 1] along P0 + t*d where it meets edge Q0->Q1, or null.
 *
 * With e = Q1 - Q0 and w = Q0 - P0:
 *   denom = d x e
 *   t = (w x e) / denom      (position along the path)
 *   u = (w x d) / denom      (position along the edge)
 * and the two meet iff both are in [0, 1].
 *
 * Parallel (|denom| tiny RELATIVE to |d||e| - an absolute epsilon would be
 * wrong for both 1 m and 1 km edges): the path and the edge meet only if
 * collinear and overlapping, in which case the first shared point is the
 * entry. Epsilons are relative and widen [0, 1] by 1e-9, so a path through a
 * vertex shared by two edges is caught by at least one of them despite
 * rounding on either side.
 */
function segmentIntersectionT(p0: Vec, d: Vec, q0: Vec, q1: Vec): number | null {
  const e = sub(q1, q0);
  const w = sub(q0, p0);
  const denom = cross(d, e);
  const scale = Math.sqrt(dot(d, d) * dot(e, e));
  if (scale === 0) return null; // zero-length path or edge

  const EPS = 1e-9;
  if (Math.abs(denom) <= EPS * scale) {
    // Parallel. Collinear only if Q0 lies on the path's line (w = 0, Q0 at
    // the path's start, gives 0 > 0: collinear).
    if (Math.abs(cross(w, d)) > EPS * Math.sqrt(dot(w, w) * dot(d, d))) return null;
    const dd = dot(d, d);
    if (dd === 0) return null;
    const t0 = dot(w, d) / dd; // Q0 along the path
    const t1 = dot(sub(q1, p0), d) / dd; // Q1 along the path
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    return lo <= hi + EPS ? lo : null;
  }

  const t = cross(w, e) / denom;
  const u = cross(w, d) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.min(1, Math.max(0, t));
}

/**
 * Even-odd ray cast in the local plane. Boundary points may land either way,
 * which is why sweptPolygon tests edges explicitly rather than relying on it.
 */
function pointInPolygon(p: Vec, poly: readonly Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const vi = poly[i] as Vec;
    const vj = poly[j] as Vec;
    if (vi.y > p.y !== vj.y > p.y) {
      const xCross = ((vj.x - vi.x) * (p.y - vi.y)) / (vj.y - vi.y) + vi.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Drop the closing vertex if the ring repeats its first one. */
function openRing(ring: readonly LatLng[]): LatLng[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed =
    ring.length > 1 &&
    first !== undefined &&
    last !== undefined &&
    first.latitude === last.latitude &&
    first.longitude === last.longitude;
  return closed ? ring.slice(0, -1) : [...ring];
}

/**
 * Coordinates are validated at fix ingestion; a non-finite one reaching the
 * geometry is a bug upstream, and a NaN here would silently compare false
 * everywhere (a zone that can never fire). Fail loudly instead.
 */
function assertFinitePoint(p: LatLng, label: string): void {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90) {
    throw new RangeError(`geometry: ${label} is not a valid coordinate (${p.latitude}, ${p.longitude})`);
  }
}

/** Planar distance in metres, for tests and the reducer's gap guard. */
export function planarDistanceMeters(a: LatLng, b: LatLng): number {
  const v = localFrame(a)(b);
  return Math.hypot(v.x, v.y);
}
