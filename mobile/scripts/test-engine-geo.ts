/**
 * Epic 15 - engine geometry: swept geofence test and bearing checks.
 *
 * Pure math, no app modules and no stubs. Every edge case the PM asked to see
 * pinned is a named case here: the 360/0 seam, tangent passes, the 215 m-offset
 * blind spot, vertex and collinear contact, concave notches, the antimeridian,
 * and the planar approximation's error against haversine.
 *
 * Run:  npm run test:engine
 */

import {
  angularDifference,
  estimateCourse,
  evaluateApproach,
  normalizeDegrees,
  segmentBearing,
  type CourseFix,
} from '../src/engine/geo/bearing.ts';
import {
  EARTH_RADIUS_M,
  planarDistanceMeters,
  sweptCircle,
  sweptPolygon,
  wrapLonDelta,
  type SweepHit,
} from '../src/engine/geo/sweep.ts';
import type { LatLng } from '../src/types/domain.ts';

let checks = 0;
let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}
function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}
function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    assert(label, false, 'did not throw');
  } catch (e) {
    assert(label, e instanceof RangeError, String(e));
  }
}
const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;
const hitT = (h: SweepHit): number | null => (h.hit ? h.t : null);

/** A point `east`/`north` metres from `origin` (inverse of the local frame). */
function offset(origin: LatLng, east: number, north: number): LatLng {
  const k = (Math.PI / 180) * EARTH_RADIUS_M;
  return {
    latitude: origin.latitude + north / k,
    longitude: origin.longitude + east / (k * Math.cos((origin.latitude * Math.PI) / 180)),
  };
}

const TLV: LatLng = { latitude: 32.0853, longitude: 34.7818 };

/**
 * The ORACLE: great-circle distance by haversine, written here and nowhere
 * else, so the code under test is checked against an independent formula.
 */
function distanceMeters(a: LatLng, b: LatLng): number {
  const r = (d: number): number => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// -----------------------------------------------------------------------------
heading('Local plane: error against haversine, antimeridian wrap');
// -----------------------------------------------------------------------------
for (const lat of [0, 32, 60, 70]) {
  const o: LatLng = { latitude: lat, longitude: 10 };
  let worst = 0;
  for (const dist of [50, 500, 2000]) {
    for (let deg = 0; deg < 360; deg += 45) {
      const p = offset(o, dist * Math.sin((deg * Math.PI) / 180), dist * Math.cos((deg * Math.PI) / 180));
      worst = Math.max(worst, Math.abs(planarDistanceMeters(o, p) - distanceMeters(o, p)));
    }
  }
  // Theory: relative error ~ |dLat| * tan(lat). 2 km north is 3.1e-4 rad.
  const bound = 2000 * (3.2e-4 * Math.tan((lat * Math.PI) / 180) + 1e-5) + 0.01;
  assert(`lat ${lat}: worst |planar - haversine| over <= 2 km is ${worst.toFixed(3)} m (bound ${bound.toFixed(2)} m)`, worst <= bound);
}
assert('zone-scale error at Tel Aviv: <= 5 cm at 300 m', (() => {
  const p = offset(TLV, 212, 212);
  return Math.abs(planarDistanceMeters(TLV, p) - distanceMeters(TLV, p)) <= 0.05;
})());
{
  const a: LatLng = { latitude: 0, longitude: 179.9999 };
  const b: LatLng = { latitude: 0, longitude: -179.9999 };
  const d = planarDistanceMeters(a, b);
  assert(`antimeridian: 179.9999E -> 179.9999W is ${d.toFixed(2)} m, not 40,000 km`, near(d, 22.24, 0.01));
}
assert('wrapLonDelta(190) = -170', wrapLonDelta(190) === -170);
assert('wrapLonDelta(-190) = 170', wrapLonDelta(-190) === 170);
assert('wrapLonDelta(180) = -180 (half-open interval)', wrapLonDelta(180) === -180);
assert('wrapLonDelta(-180) = -180', wrapLonDelta(-180) === -180);
assert('wrapLonDelta(360) = 0', wrapLonDelta(360) === 0);

// -----------------------------------------------------------------------------
heading('sweptCircle');
// -----------------------------------------------------------------------------
{
  // The PM's 140 m blind spot, made concrete: a road passing 215 m from the
  // centre of a 220 m zone crosses it for 2*sqrt(220^2 - 215^2) = 93.3 m.
  // Fixes 100 m apart, either side of the closest approach, are BOTH outside.
  const c = TLV;
  const a = offset(c, -50, 215);
  const b = offset(c, 50, 215);
  assert('blind spot: neither fix is inside (the point test misses)', distanceMeters(a, c) > 220 && distanceMeters(b, c) > 220);
  const h = sweptCircle(a, b, c, 220);
  const halfChord = Math.sqrt(220 ** 2 - 215 ** 2);
  assert(
    `blind spot: the swept test hits, entering at t=${hitT(h)?.toFixed(4)} (expected ${((50 - halfChord) / 100).toFixed(4)})`,
    h.hit && near(h.t, (50 - halfChord) / 100, 1e-3),
  );
  if (h.hit) {
    const entry = offset(c, -50 + 100 * h.t, 215);
    assert('blind spot: the entry point lies on the circle (+-2 cm)', near(distanceMeters(entry, c), 220, 0.02));
  }
  assert('offset 221 m: miss', !sweptCircle(offset(c, -50, 221), offset(c, 50, 221), c, 220).hit);
  assert('offset 219.99 m (1 cm inside the tangent): hit', sweptCircle(offset(c, -50, 219.99), offset(c, 50, 219.99), c, 220).hit);
  assert('offset 220.01 m (1 cm outside the tangent): miss', !sweptCircle(offset(c, -50, 220.01), offset(c, 50, 220.01), c, 220).hit);
}
{
  const c = TLV;
  assert('A inside: t = 0', hitT(sweptCircle(offset(c, 10, 0), offset(c, 500, 0), c, 50)) === 0);
  assert('stationary inside: t = 0', hitT(sweptCircle(offset(c, 10, 0), offset(c, 10, 0), c, 50)) === 0);
  assert('stationary outside: miss', !sweptCircle(offset(c, 80, 0), offset(c, 80, 0), c, 50).hit);
  assert('zone behind A, moving away: miss', !sweptCircle(offset(c, 100, 0), offset(c, 200, 0), c, 50).hit);
  assert('zone beyond B, stopping short: miss', !sweptCircle(offset(c, -200, 0), offset(c, -100, 0), c, 50).hit);
  const through = sweptCircle(offset(c, -100, 0), offset(c, 100, 0), c, 50);
  assert(`straight through the centre: enters at t=0.25 (got ${hitT(through)?.toFixed(6)})`, through.hit && near(through.t, 0.25, 1e-4));
  const endsInside = sweptCircle(offset(c, -100, 0), offset(c, 0, 0), c, 50);
  assert('ends inside: enters at t=0.5', endsInside.hit && near(endsInside.t, 0.5, 1e-4));
  // 2 km at 100 km/h after a GPS gap - the longest the reducer sweeps.
  const long = sweptCircle(offset(c, -1000, 30), offset(c, 1000, 30), c, 150);
  assert('2 km sweep, 30 m off-centre: hit', long.hit && near(long.t, (1000 - Math.sqrt(150 ** 2 - 30 ** 2)) / 2000, 1e-4));
  // 1 m segments far from a small zone - where the textbook quadratic cancels.
  assert('1 m segment 5 km from a 15 m zone: miss, no NaN', !sweptCircle(offset(c, 5000, 0), offset(c, 5001, 0), c, 15).hit);
  throws('radius 0 throws', () => sweptCircle(c, offset(c, 10, 0), c, 0));
  throws('NaN radius throws', () => sweptCircle(c, offset(c, 10, 0), c, Number.NaN));
  throws('NaN coordinate throws (never a silent miss)', () => sweptCircle({ latitude: Number.NaN, longitude: 0 }, c, c, 10));
}
{
  // A zone straddling the antimeridian, crossed by a segment that does too.
  const center: LatLng = { latitude: -17, longitude: 180 };
  const a: LatLng = { latitude: -17, longitude: 179.998 };
  const b: LatLng = { latitude: -17, longitude: -179.998 };
  assert('antimeridian: segment across 180 hits a zone on 180', sweptCircle(a, b, center, 50).hit);
}

// -----------------------------------------------------------------------------
heading('sweptPolygon');
// -----------------------------------------------------------------------------
{
  const o = TLV;
  const P = (e: number, n: number): LatLng => offset(o, e, n);
  const square = [P(0, 0), P(100, 0), P(100, 100), P(0, 100)];
  const closed = [...square, P(0, 0)];
  const clockwise = [...square].reverse();

  const through = sweptPolygon(P(-50, 50), P(150, 50), square);
  assert(`through the square: enters at t=0.25 (got ${hitT(through)?.toFixed(6)})`, through.hit && near(through.t, 0.25, 1e-6));
  assert('closed ring: same t', near(hitT(sweptPolygon(P(-50, 50), P(150, 50), closed)) ?? -1, 0.25, 1e-6));
  assert('clockwise ring: same t', near(hitT(sweptPolygon(P(-50, 50), P(150, 50), clockwise)) ?? -1, 0.25, 1e-6));
  assert('A inside: t = 0', hitT(sweptPolygon(P(50, 50), P(500, 50), square)) === 0);
  assert('both ends outside, passing 1 m beside an edge: miss', !sweptPolygon(P(-50, -1), P(150, -1), square).hit);
  const corner = sweptPolygon(P(-50, 50), P(50, 150), square);
  assert(`touches a vertex only: hit at t=0.5 (got ${hitT(corner)?.toFixed(6)})`, corner.hit && near(corner.t, 0.5, 1e-6));
  const collinear = sweptPolygon(P(-50, 0), P(150, 0), square);
  assert(`runs along an edge: hit at t=0.25 (got ${hitT(collinear)?.toFixed(6)})`, collinear.hit && near(collinear.t, 0.25, 1e-6));
  assert('stops short of the square: miss', !sweptPolygon(P(-50, 50), P(-1, 50), square).hit);
  // Lies wholly ON the top edge, between its vertices: no other edge is met
  // and the ray cast puts a top-edge point outside, so only the collinear
  // branch can see it. Boundary contact counts, like the circle's tangent.
  const onEdge = sweptPolygon(P(20, 100), P(60, 100), square);
  assert(`lies on an edge between vertices: hit at t=0 (got ${hitT(onEdge)})`, onEdge.hit && onEdge.t === 0);
  assert('point-in-polygon: always-false would be caught (A inside must give t=0, not an edge t)', hitT(sweptPolygon(P(50, 50), P(150, 50), square)) === 0);

  // A U: two arms (x 0..30 and 70..100), joined along the bottom (y 0..30).
  const u = [P(0, 0), P(100, 0), P(100, 100), P(70, 100), P(70, 30), P(30, 30), P(30, 100), P(0, 100)];
  assert('concave U: straight down the notch, both ends outside: miss', !sweptPolygon(P(50, 150), P(50, 40), u).hit);
  const arm = sweptPolygon(P(-20, 60), P(120, 60), u);
  assert(`concave U: across both arms, enters the first at t=1/7 (got ${hitT(arm)?.toFixed(6)})`, arm.hit && near(arm.t, 20 / 140, 1e-6));

  throws('fewer than 3 distinct vertices throws', () => sweptPolygon(P(0, 0), P(1, 1), [P(0, 0), P(1, 0), P(0, 0)]));
}

// -----------------------------------------------------------------------------
heading('normalizeDegrees and angularDifference: the 360/0 seam');
// -----------------------------------------------------------------------------
assert('normalize(-90) = 270', normalizeDegrees(-90) === 270);
assert('normalize(360) = 0', normalizeDegrees(360) === 0);
assert('normalize(720) = 0', normalizeDegrees(720) === 0);
assert('normalize(-360) = 0, and +0 not -0', Object.is(normalizeDegrees(-360), 0));
assert('normalize(-1e-14) = 0 (360 - 1e-14 rounds to 360, folded)', normalizeDegrees(-1e-14) === 0);
assert('normalize(-1e-13) is just below 360, never 360', (() => {
  const v = normalizeDegrees(-1e-13);
  return v < 360 && v > 359.9999;
})());
{
  let ok = true;
  let worst = '';
  for (const v of [-1e12, -721.5, -0.0000001, -0, 0, 1e-300, 359.99999999999994, 359.9999999999999, 1e12, 12345.678]) {
    const n = normalizeDegrees(v);
    if (!(n >= 0 && n < 360)) {
      ok = false;
      worst = `${v} -> ${n}`;
    }
  }
  assert('normalize: always in [0, 360) across extreme and seam inputs', ok, worst);
}
throws('normalize(NaN) throws', () => normalizeDegrees(Number.NaN));
throws('normalize(Infinity) throws', () => normalizeDegrees(Number.POSITIVE_INFINITY));

assert('diff(359, 1) = 2 (not 358)', angularDifference(359, 1) === 2);
assert('diff(1, 359) = 2 (symmetric)', angularDifference(1, 359) === 2);
assert('diff(0, 180) = 180', angularDifference(0, 180) === 180);
assert('diff(90, 270) = 180', angularDifference(90, 270) === 180);
assert('diff(-10, 10) = 20 (negative input)', angularDifference(-10, 10) === 20);
assert('diff(370, 10) = 0 (input above 360)', angularDifference(370, 10) === 0);
assert('diff(0, 360) = 0', angularDifference(0, 360) === 0);
assert('diff(179.5, -179.5) = 1', near(angularDifference(179.5, -179.5), 1, 1e-12));
{
  let ok = true;
  for (let i = 0; i < 2000; i++) {
    const a = (i * 137.507764) % 1080 - 360;
    const b = (i * 59.29) % 1080 - 360;
    const d = angularDifference(a, b);
    if (!(d >= 0 && d <= 180) || d !== angularDifference(b, a)) ok = false;
  }
  assert('diff: 2000 pairs in [-360, 720) - always in [0, 180], always symmetric', ok);
}
throws('diff with NaN throws', () => angularDifference(Number.NaN, 0));

// -----------------------------------------------------------------------------
heading('segmentBearing and estimateCourse');
// -----------------------------------------------------------------------------
assert('north = 0', near(segmentBearing(TLV, offset(TLV, 0, 100)), 0, 1e-9) || near(segmentBearing(TLV, offset(TLV, 0, 100)), 360, 1e-9));
assert('east = 90', near(segmentBearing(TLV, offset(TLV, 100, 0)), 90, 1e-9));
assert('south = 180', near(segmentBearing(TLV, offset(TLV, 0, -100)), 180, 1e-9));
assert('west = 270', near(segmentBearing(TLV, offset(TLV, -100, 0)), 270, 1e-9));
assert('just west of north = 359.x, not -0.x', (() => {
  const b = segmentBearing(TLV, offset(TLV, -1, 100));
  return b > 359 && b < 360;
})());
assert('eastward across the antimeridian = 90', near(segmentBearing({ latitude: 0, longitude: 179.9999 }, { latitude: 0, longitude: -179.9999 }), 90, 1e-6));

const fix = (c: LatLng, headingDeg: number | null, speedMps: number | null, accuracyM: number | null = 5): CourseFix => ({
  coordinate: c,
  headingDeg,
  speedMps,
  accuracyM,
});
{
  const prev = fix(TLV, null, null);
  const c1 = estimateCourse(prev, fix(offset(TLV, 0, 30), 92, 27.8));
  assert('moving at 100 km/h: the device course wins (92)', c1?.source === 'device' && c1.deg === 92);
  const c2 = estimateCourse(prev, fix(offset(TLV, 30, 0), -1, 27.8));
  assert('iOS invalid course (-1): falls back to displacement (90)', c2?.source === 'displacement' && near(c2.deg, 90, 1e-6));
  assert('Android "bearing 0" while stopped is NOT read as north', estimateCourse(null, fix(TLV, 0, 0)) === null);
  const c3 = estimateCourse(prev, fix(offset(TLV, 0, 30), 0, 1.2));
  assert('walking pace: displacement, not the device course', c3?.source === 'displacement' && near(normalizeDegrees(c3.deg + 180), 180, 1e-6));
  assert('8 m apart with 5 m fixes: too close to trust - null', estimateCourse(prev, fix(offset(TLV, 0, 8), null, 1)) === null);
  assert('30 m apart with 25 m fixes: still too close (needs 2 x 35 m) - null', estimateCourse(fix(TLV, null, null, 25), fix(offset(TLV, 0, 30), null, 1, 25)) === null);
  assert('device course 360 is normalised to 0', estimateCourse(null, fix(TLV, 360, 10))?.deg === 0);
}

// -----------------------------------------------------------------------------
heading('evaluateApproach');
// -----------------------------------------------------------------------------
const course = (deg: number) => ({ deg, source: 'device' as const });
assert('opposite carriageway: approach 90, travelling 270 -> rejected', !evaluateApproach('required', 90, 45, course(270)).fire);
assert('right carriageway: approach 90, travelling 100 -> fires', evaluateApproach('required', 90, 45, course(100)).fire);
assert('seam: approach 350, tol 20, travelling 5 -> fires (diff 15)', evaluateApproach('required', 350, 20, course(5)).fire);
assert('seam: approach 5, tol 20, travelling 350 -> fires (diff 15)', evaluateApproach('required', 5, 20, course(350)).fire);
assert('seam: approach 0, tol 10, travelling 349 -> rejected (diff 11)', !evaluateApproach('required', 0, 10, course(349)).fire);
assert('boundary inclusive: diff exactly 45 -> fires', evaluateApproach('required', 90, 45, course(135)).fire);
assert('boundary: diff 45 + 1e-9 -> rejected', !evaluateApproach('required', 90, 45, course(135 + 1e-9)).fire);
assert('required, course unknown -> rejected', evaluateApproach('required', 90, 45, null).fire === false);
assert('preferred, course unknown -> fires', evaluateApproach('preferred', 90, 45, null).fire);
assert('preferred, course contradicts -> rejected', !evaluateApproach('preferred', 90, 45, course(270)).fire);
assert('ignore -> fires whatever the course', evaluateApproach('ignore', null, 45, course(270)).fire);
throws('required with no bearing throws (corrupt manifest)', () => evaluateApproach('required', null, 45, course(0)));
throws('tolerance out of range throws', () => evaluateApproach('required', 0, 200, course(0)));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
