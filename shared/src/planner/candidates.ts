/**
 * The get_planner_candidates answer (20261005120100 section 5), parsed and
 * checked. A shape this build does not recognise is refused, never guessed:
 * a plan built on a misread cost is worse than no plan.
 */

import type { TransitMode } from '../contracts/planTour.ts';
import type { ValhallaProfile } from '../routing/valhalla.ts';
import type { StopRole } from '../vocabulary.ts';

export type Pair = readonly [lon: number, lat: number];

export interface CandidateStop {
  waypointId: string;
  sortOrder: number;
  stopRole: StopRole;
  poiType: string;
  coordinates: Pair;
  /** Core stops are always eligible; an extension may be restricted to other audiences. */
  eligible: boolean;
  /** Defined by the SQL, once (driving: override or 0; walking/biking: override or narration). */
  dwellS: number;
  /** Deep Dive length; 0 in driving chapters. */
  deepDiveDwellS: number;
  narrationS: number | null;
  matchedWeight: number;
}

export interface Candidate {
  chapterId: string;
  tourId: string;
  tourTitle: string;
  title: string | null;
  transitMode: TransitMode;
  profile: ValhallaProfile;
  entry: Pair;
  exit: Pair;
  coreMatchedWeight: number;
  lowerBoundS: number;
  /** Authored order. */
  stops: CandidateStop[];
}

export interface CostRow {
  durationS: number | null;
  distanceM: number | null;
  coordsKey: string;
}

export interface TransferRow extends CostRow {
  fromChapterId: string;
  toChapterId: string;
}

export interface LegRow extends CostRow {
  chapterId: string;
  fromNode: string;
  toNode: string;
}

export interface PlannerCandidates {
  transferProfile: ValhallaProfile;
  budgetS: number;
  considered: number;
  pruned: Readonly<Record<string, number>>;
  minPrunedLowerBoundS: number | null;
  truncated: boolean;
  candidates: Candidate[];
  transfers: TransferRow[];
  legs: LegRow[];
}

export class CandidatesShapeError extends Error {
  override readonly name = 'CandidatesShapeError';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function fail(where: string): never {
  throw new CandidatesShapeError(`get_planner_candidates: unexpected ${where}`);
}
function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  return typeof v === 'string' ? v : fail(`${where}.${k}`);
}
function num(o: Obj, k: string, where: string): number {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where}.${k}`);
}
function nullableNum(o: Obj, k: string, where: string): number | null {
  const v = o[k];
  return v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : fail(`${where}.${k}`);
}
function pair(o: Obj, k: string, where: string): Pair {
  const v = o[k];
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    fail(`${where}.${k}`);
  }
  return [v[0] as number, v[1] as number];
}
function arr(o: Obj, k: string, where: string): unknown[] {
  const v = o[k];
  return Array.isArray(v) ? v : fail(`${where}.${k}`);
}

const MODES: ReadonlySet<string> = new Set(['walking', 'biking', 'driving']);
const PROFILES: ReadonlySet<string> = new Set(['pedestrian', 'bicycle', 'auto']);

function costRow(o: Obj, where: string): CostRow {
  const durationS = nullableNum(o, 'duration_s', where);
  const distanceM = nullableNum(o, 'distance_m', where);
  if ((durationS === null) !== (distanceM === null)) fail(`${where}: half-unroutable row`);
  return { durationS, distanceM, coordsKey: str(o, 'coords_key', where) };
}

export function parseCandidates(value: unknown): PlannerCandidates {
  if (!isObj(value)) fail('answer (not an object)');
  const transferProfile = str(value, 'transfer_profile', 'answer');
  if (!PROFILES.has(transferProfile)) fail('answer.transfer_profile');
  const pruned = value.pruned;
  if (!isObj(pruned) || !Object.values(pruned).every((n) => typeof n === 'number')) fail('answer.pruned');

  const candidates = arr(value, 'candidates', 'answer').map((c, i): Candidate => {
    const w = `candidates[${i}]`;
    if (!isObj(c)) fail(w);
    const transitMode = str(c, 'transit_mode', w);
    const profile = str(c, 'profile', w);
    if (!MODES.has(transitMode) || !PROFILES.has(profile)) fail(`${w}.transit_mode/profile`);
    const title = c.title;
    if (title !== null && typeof title !== 'string') fail(`${w}.title`);
    const stops = arr(c, 'stops', w).map((s, j): CandidateStop => {
      const ws = `${w}.stops[${j}]`;
      if (!isObj(s)) fail(ws);
      const stopRole = str(s, 'stop_role', ws);
      if (stopRole !== 'core' && stopRole !== 'extension') fail(`${ws}.stop_role`);
      if (typeof s.eligible !== 'boolean') fail(`${ws}.eligible`);
      return {
        waypointId: str(s, 'waypoint_id', ws),
        sortOrder: num(s, 'sort_order', ws),
        stopRole,
        poiType: str(s, 'poi_type', ws),
        coordinates: pair(s, 'coordinates', ws),
        eligible: s.eligible,
        dwellS: num(s, 'dwell_s', ws),
        deepDiveDwellS: num(s, 'deep_dive_dwell_s', ws),
        narrationS: nullableNum(s, 'narration_s', ws),
        matchedWeight: num(s, 'matched_weight', ws),
      };
    });
    // The SQL orders them; a planner that silently re-sorted would hide a regression.
    if (stops.some((s, j) => j > 0 && (stops[j - 1] as CandidateStop).sortOrder >= s.sortOrder)) fail(`${w}.stops order`);
    return {
      chapterId: str(c, 'chapter_id', w),
      tourId: str(c, 'tour_id', w),
      tourTitle: str(c, 'tour_title', w),
      title: title as string | null,
      transitMode: transitMode as TransitMode,
      profile: profile as ValhallaProfile,
      entry: pair(c, 'entry', w),
      exit: pair(c, 'exit', w),
      coreMatchedWeight: num(c, 'core_matched_weight', w),
      lowerBoundS: num(c, 'lower_bound_s', w),
      stops,
    };
  });

  const transfers = arr(value, 'transfers', 'answer').map((t, i): TransferRow => {
    const w = `transfers[${i}]`;
    if (!isObj(t)) fail(w);
    return { fromChapterId: str(t, 'from_chapter_id', w), toChapterId: str(t, 'to_chapter_id', w), ...costRow(t, w) };
  });
  const legs = arr(value, 'legs', 'answer').map((l, i): LegRow => {
    const w = `legs[${i}]`;
    if (!isObj(l)) fail(w);
    return { chapterId: str(l, 'chapter_id', w), fromNode: str(l, 'from_node', w), toNode: str(l, 'to_node', w), ...costRow(l, w) };
  });

  const truncated = value.truncated;
  if (typeof truncated !== 'boolean') fail('answer.truncated');
  return {
    transferProfile: transferProfile as ValhallaProfile,
    budgetS: num(value, 'budget_s', 'answer'),
    considered: num(value, 'considered', 'answer'),
    pruned: pruned as Record<string, number>,
    minPrunedLowerBoundS: nullableNum(value, 'min_pruned_lower_bound_s', 'answer'),
    truncated,
    candidates,
    transfers,
    legs,
  };
}
