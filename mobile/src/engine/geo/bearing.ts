import type { LatLng } from '../../types/domain.ts';
import { localFrame } from './sweep.ts';

/**
 * Direction-of-travel checks (Epic 15).
 *
 * A stop on a divided highway must not fire for the opposite carriageway.
 * Each waypoint may carry an approach bearing (degrees clockwise from true
 * north) with a tolerance and a policy; this module estimates the course we
 * are actually travelling and says whether it matches.
 *
 * ALL ANGLE ARITHMETIC GOES THROUGH TWO FUNCTIONS, so the 360/0 seam is
 * handled in exactly one place:
 *
 *   normalizeDegrees(x)       any finite angle -> [0, 360)
 *   angularDifference(a, b)   smallest unsigned angle between two headings,
 *                             in [0, 180]; 359 vs 1 is 2, not 358
 *
 * Nothing else subtracts or compares raw headings.
 */

/** Below this speed GPS course is noise (a car at a light, a walker). */
export const MIN_COURSE_SPEED_MPS = 2.5;

/**
 * A displacement-derived course needs the two fixes to be clearly apart
 * relative to their own error: at least this far, and at least twice their
 * combined 1-sigma error.
 */
export const MIN_COURSE_DISPLACEMENT_M = 10;

/** Assumed horizontal error when a fix reports none (iOS and Android both can). */
const UNKNOWN_ACCURACY_M = 25;

export type BearingPolicy = 'required' | 'preferred' | 'ignore';

/** What the device reported alongside one fix. */
export interface CourseFix {
  coordinate: LatLng;
  /** Course over ground, degrees. iOS reports -1 when invalid. */
  headingDeg: number | null;
  speedMps: number | null;
  accuracyM: number | null;
}

export type Course = { deg: number; source: 'device' | 'displacement' } | null;

/**
 * Any finite angle in degrees -> [0, 360).
 *
 * JS % keeps the dividend's sign, so -90 % 360 is -90: the second +360 / %
 * pass maps it to 270. The one floating-point trap: a remainder of exactly -0
 * (from -360) gives -0 + 360 = 360, which the outer % folds back to 0. A tiny
 * negative like -1e-14 gives 360 - 1e-14, which rounds to exactly 360 in
 * double precision and is likewise folded to 0. The result is never 360.
 */
export function normalizeDegrees(deg: number): number {
  if (!Number.isFinite(deg)) throw new RangeError(`normalizeDegrees: not a finite angle (${deg})`);
  return ((deg % 360) + 360) % 360;
}

/**
 * Smallest unsigned angle between two headings, in [0, 180].
 *
 * |a - b| % 360 is in [0, 360) whatever the inputs' range (negative, > 360);
 * the shorter way round is that or 360 minus it. Symmetric, and exact for the
 * integer degrees the database stores.
 */
export function angularDifference(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    throw new RangeError(`angularDifference: not finite (${a}, ${b})`);
  }
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Bearing of travel from `from` to `to`, degrees in [0, 360), in the same
 * local plane the swept test uses (atan2(east, north)). Over the <= 2 km the
 * reducer handles, it differs from the great-circle initial bearing by under
 * 0.01 degree. Meaningless for coincident points - callers gate on distance.
 */
export function segmentBearing(from: LatLng, to: LatLng): number {
  const v = localFrame(from)(to);
  return normalizeDegrees((Math.atan2(v.x, v.y) * 180) / Math.PI);
}

/**
 * Best available course at `curr`, or null when it cannot be known.
 *
 *   1. The device's course over ground, when it is valid (finite, >= 0 - iOS
 *      uses -1 for "invalid") and we are moving fast enough for it to mean
 *      anything. Android reports bearing 0 when it has none; the speed gate
 *      is what stops a stationary 0 from reading as "due north".
 *   2. Otherwise the direction from the previous fix, when the two are far
 *      enough apart that their position error cannot flip it.
 *   3. Otherwise null - "indeterminate", which the policy decides about.
 */
export function estimateCourse(prev: CourseFix | null, curr: CourseFix): Course {
  const { headingDeg, speedMps } = curr;
  if (
    headingDeg !== null &&
    Number.isFinite(headingDeg) &&
    headingDeg >= 0 &&
    speedMps !== null &&
    speedMps >= MIN_COURSE_SPEED_MPS
  ) {
    return { deg: normalizeDegrees(headingDeg), source: 'device' };
  }

  if (prev === null) return null;
  const v = localFrame(prev.coordinate)(curr.coordinate);
  const distance = Math.hypot(v.x, v.y);
  const sigma = Math.hypot(prev.accuracyM ?? UNKNOWN_ACCURACY_M, curr.accuracyM ?? UNKNOWN_ACCURACY_M);
  if (distance < Math.max(MIN_COURSE_DISPLACEMENT_M, 2 * sigma)) return null;
  return { deg: normalizeDegrees((Math.atan2(v.x, v.y) * 180) / Math.PI), source: 'displacement' };
}

export type ApproachVerdict =
  | { fire: true; reason: 'no_check' | 'match' | 'no_course_preferred' }
  | { fire: false; reason: 'mismatch' | 'no_course_required' };

/**
 * May this stop fire for this course?
 *
 *   ignore     always
 *   required   only with a known course within tolerance
 *   preferred  a known course must be within tolerance; an unknown one passes
 *
 * Tolerance is inclusive (diff <= tolerance) and is the HALF-width of the
 * cone: 45 accepts 90 degrees of headings. The reason is returned for
 * telemetry (trigger_rejected_bearing) - tolerances get tuned from it.
 */
export function evaluateApproach(
  policy: BearingPolicy,
  approachDeg: number | null,
  toleranceDeg: number,
  course: Course,
): ApproachVerdict {
  if (policy === 'ignore') return { fire: true, reason: 'no_check' };
  if (approachDeg === null || !Number.isFinite(approachDeg)) {
    // The database refuses this (waypoints_bearing_policy_needs_bearing_check);
    // a manifest carrying it is corrupt, not a stop to guess about.
    throw new RangeError(`evaluateApproach: policy '${policy}' with no approach bearing`);
  }
  if (!(toleranceDeg >= 0 && toleranceDeg <= 180)) {
    throw new RangeError(`evaluateApproach: tolerance must be in [0, 180], got ${toleranceDeg}`);
  }
  if (course === null) {
    return policy === 'required'
      ? { fire: false, reason: 'no_course_required' }
      : { fire: true, reason: 'no_course_preferred' };
  }
  return angularDifference(course.deg, approachDeg) <= toleranceDeg
    ? { fire: true, reason: 'match' }
    : { fire: false, reason: 'mismatch' };
}
