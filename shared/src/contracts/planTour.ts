/**
 * Epic 16 - plan-tour Edge Function contract. Approved by the PM 2 Oct 2026;
 * the Edge Function itself is not built yet.
 *
 *   POST /functions/v1/plan-tour            PlanTourRequest  -> PlanTourResponse
 *   GET  /functions/v1/plan-tour?plan_id=   (none)           -> PlanFetchResponse
 *
 * Called with fetch + an explicit timeout, never supabase.functions.invoke (a
 * UI-blocking flow; see Epic 11). Anonymous callers allowed (PM decision 4).
 *
 * Runtime-neutral, no npm imports: Metro, Node and Deno all compile this file.
 */

// test:cms pins these ids against interest_tag_vocabulary() and
// audience_tag_vocabulary(); mobile's options.ts re-exports them.
import type { GroupType, Interest } from '../vocabulary.ts';

export const PLAN_CONTRACT_VERSION = 1 as const;

export type TransitMode = 'walking' | 'biking' | 'driving';
export type HandoffProvider = 'google_maps' | 'waze';
/** 'estimated' = no cached Valhalla cost; haversine x detour factor. Never stored. */
export type CostSource = 'valhalla' | 'estimated';

export interface LonLat {
  lon: number;
  lat: number;
}

// -----------------------------------------------------------------------------
// Request
// -----------------------------------------------------------------------------

export interface PlanTourRequest {
  contract_version: typeof PLAN_CONTRACT_VERSION;
  /** cities.id. Candidates never cross a city boundary. */
  city_id: string;
  /**
   * Where the plan starts (PM decision 3). Used in memory only: never stored,
   * never echoed back (tour_plans_request_check / origin_rounded_check).
   * An address is geocoded on the device; the server only sees coordinates.
   */
  origin: LonLat & { source: 'gps' | 'address' };
  /** Integer minutes, 15..1440. The hard budget the estimate must fit. */
  available_minutes: number;
  /**
   * The visitor's means of transport. It decides two things, so the request
   * cannot contradict itself:
   *   transfers between chapters  use this mode
   *   eligible chapters           walking always; biking if 'biking';
   *                               walking + driving if 'driving'
   */
  transit_mode: TransitMode;
  group_type: GroupType;
  /** A SET: order must not change the plan (same rule as route-stops). Non-empty. */
  interests: readonly Interest[];
  /** ISO 8601 WITH offset; time-of-day rules use the visitor's clock (SmartSorter contract 1). */
  context: { local_time: string };
  /** true: Deep Dives count against the budget. false: reported as estimate.deep_dive_extra_s. */
  include_deep_dives: boolean;
  /** Re-plan without these ("done that one"). Optional, <= 50. */
  exclude_chapter_ids?: readonly string[];
}

// -----------------------------------------------------------------------------
// Response
// -----------------------------------------------------------------------------

export type PlanTourResponse = PlanTourOk | PlanTourError;

export interface PlanTourOk {
  status: 'ok';
  contract_version: typeof PLAN_CONTRACT_VERSION;
  plan_id: string;
  /** 'v1'... Bumped whenever the same request can produce a different plan. */
  planner_version: string;
  /**
   * First 128 bits of SHA-256 (32 hex) over planner_version, the ordered
   * chapters and waypoints, each chapter's entry/exit point and every source
   * bundle hash. A GET recomputes it; any difference is plan_stale.
   */
  content_hash: string;
  /** ISO 8601. GET after this -> plan_expired. */
  expires_at: string;
  /**
   * Bundles the device must hold, each pinned to the hash the plan was built
   * on. A downloaded bundle with a different hash means the plan is stale:
   * re-fetch (the server answers plan_stale) - never run it anyway.
   */
  sources: readonly PlanSource[];
  /**
   * In travel order, strictly alternating, starting with a transfer:
   *   transfer, chapter, transfer, chapter, ...
   * One-way (PM decision 3): no transfer after the last chapter.
   */
  segments: readonly PlanSegment[];
  estimate: PlanEstimate;
  quality: PlanQuality;
}

export interface PlanSource {
  tour_id: string;
  bundle_version_hash: string;
}

export type PlanSegment = TransferSegment | ChapterSegment;

export interface TransferSegment {
  kind: 'transfer';
  /**
   * The first transfer starts at the request origin and carries NO coordinates:
   * this object is stored in tour_plans.plan, and the origin must not be.
   */
  from: { kind: 'origin' } | { kind: 'chapter_exit'; chapter_id: string; point: LonLat };
  to_chapter_id: string;
  /** The chapter's entry_point - where navigation routes to. */
  to: LonLat;
  mode: TransitMode;
  duration_s: number;
  distance_m: number;
  cost_source: CostSource;
  /**
   * Decided server-side, like get_tour_bundle's handoff.providers: a transfer
   * has no anchors, so driving -> both, walking/biking -> google_maps only.
   */
  providers: readonly HandoffProvider[];
}

export interface ChapterSegment {
  kind: 'chapter';
  tour_id: string;
  chapter_id: string;
  transit_mode: TransitMode;
  /**
   * Core stops + kept extensions, in authored sort_order. The device arms
   * exactly these and nothing else from this chapter.
   *
   * ALWAYS every core stop of the chapter, transitions included (PM, 4 Oct
   * 2026: core means core). The planner chooses chapters and extensions; it
   * never drops a core stop. A device holding the bundle refuses a plan whose
   * chapter omits one (plan_stale), exactly as a catalogue session runs them all.
   */
  waypoint_ids: readonly string[];
  /** Subset of waypoint_ids: the extensions the planner kept. */
  kept_extension_ids: readonly string[];
  /**
   * Planner v4 (Option E, PM 6 Oct 2026): CORE stops of this chapter within
   * DEDUP_RADIUS_M of a stop an EARLIER chapter of the plan already narrates
   * (two tours that share a plaza). Still in waypoint_ids - core means core,
   * and the zone still fires, so sequencing and transitions are untouched -
   * but the device plays nothing there: no audio session, no audio telemetry.
   * Additive: absent on the wire (plans before v4) parses as [].
   */
  silent_stop_ids: readonly string[];
  /**
   * Extensions present in the bundle that must NOT be armed (they lie along
   * the path; arming them would narrate stops the plan dropped). Explicit so
   * the device can assert waypoint_ids + dropped = the chapter's stops in its
   * bundle, and treat any difference as plan_stale.
   */
  dropped_extension_ids: readonly string[];
  /** Movement inside the chapter (entry -> stops -> exit) and time at stops. */
  travel_s: number;
  dwell_s: number;
  /** 'estimated' if ANY leg inside the chapter was. */
  cost_source: CostSource;
}

export interface PlanEstimate {
  budget_s: number;
  /** transfer_s + chapter_travel_s + dwell_s (+ Deep Dives if included). Always <= budget_s. */
  total_s: number;
  transfer_s: number;
  chapter_travel_s: number;
  dwell_s: number;
  /** Deep Dive time NOT in total_s (0 when include_deep_dives). */
  deep_dive_extra_s: number;
  /** budget_s - total_s. */
  slack_s: number;
  /** Walking-pace multiplier applied for group_type (e.g. 1.3 for family_kids). */
  pace_factor: number;
}

export interface PlanQuality {
  candidates_considered: number;
  legs_total: number;
  /** Legs priced by estimate. > 0 means the totals are approximate; UI may say "about". */
  legs_estimated: number;
  /**
   * The chapter search hit its node cap and returned the best plan found so
   * far. Deterministic: the same request truncates at the same place.
   */
  search_truncated: boolean;
  /**
   * Extensions with matched weight >= 2, in chapters this plan INCLUDES, that
   * the chapter would keep with unlimited time but this plan dropped - i.e.
   * strictly for lack of time. Never counted: extensions excluded by audience,
   * unroutable or driving-queue constraints, or no matching interest. Feeds the
   * "add more time" suggestion. Planner v2+.
   */
  dropped_high_value_extensions: number;
}

// -----------------------------------------------------------------------------
// Errors. Coded, like RoutingError: callers branch on `code`, never on text.
// -----------------------------------------------------------------------------

export type PlanTourErrorCode =
  /** 400. Malformed body, unknown vocabulary id, minutes out of range. */
  | 'invalid_request'
  /** 400. contract_version this deployment does not speak. */
  | 'unsupported_contract'
  /** 422. No plannable chapter in the city for this transit_mode. */
  | 'no_candidates'
  /** 422. Not even one chapter fits; `shortfall_s` = cheapest plan - budget. */
  | 'plan_infeasible'
  /** 422. Every candidate's entry is beyond the transfer radius from origin. */
  | 'origin_out_of_range'
  /** 429. `retry_after_s` set. */
  | 'rate_limited'
  /** 500. A bug; logged with a request id. */
  | 'internal';

export interface PlanTourError {
  status: 'error';
  code: PlanTourErrorCode;
  /** Operator-facing; not for display. */
  detail: string;
  retryable: boolean;
  shortfall_s?: number;
  retry_after_s?: number;
  request_id: string;
}

// -----------------------------------------------------------------------------
// GET by id (resume, second device, re-download)
// -----------------------------------------------------------------------------

export type PlanFetchResponse = PlanTourOk | PlanFetchError;

export interface PlanFetchError {
  status: 'error';
  code:
    /** 404. Unknown id - or a signed-in user's plan requested by someone else. */
    | 'plan_not_found'
    /** 410. Past expires_at. */
    | 'plan_expired'
    /** 409. A source tour's bundle hash moved since planning. Re-plan. */
    | 'plan_stale';
  detail: string;
  retryable: false;
  /** plan_stale only: which tours changed. */
  stale_tour_ids?: readonly string[];
  request_id: string;
}

// -----------------------------------------------------------------------------
// Runtime parsing - the app never trusts a response's shape (Epic 16 Part 4).
// One parser for both sides: the app parses with it, and plan-tour's tests do.
// -----------------------------------------------------------------------------

export class PlanContractError extends Error {
  override readonly name = 'PlanContractError';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function bad(where: string): never {
  throw new PlanContractError(`plan-tour response: unexpected ${where}`);
}
const MODES: readonly string[] = ['walking', 'biking', 'driving'];
const SOURCES: readonly string[] = ['valhalla', 'estimated'];
const PROVIDERS: readonly string[] = ['google_maps', 'waze'];
const HEX32 = /^[0-9a-f]{32}$/;
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(o: Obj, k: string, w: string): string {
  return typeof o[k] === 'string' ? (o[k] as string) : bad(`${w}.${k}`);
}
function num(o: Obj, k: string, w: string, min = 0): number {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : bad(`${w}.${k}`);
}
function strings(o: Obj, k: string, w: string): string[] {
  const v = o[k];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : bad(`${w}.${k}`);
}
function point(v: unknown, w: string): LonLat {
  if (!isObj(v) || typeof v.lon !== 'number' || typeof v.lat !== 'number' || !Number.isFinite(v.lon) || !Number.isFinite(v.lat)) bad(w);
  return { lon: v.lon as number, lat: v.lat as number };
}
function oneOf<T extends string>(v: unknown, allowed: readonly string[], w: string): T {
  return typeof v === 'string' && allowed.includes(v) ? (v as T) : bad(w);
}

/** silent_stop_ids: optional (plans before v4), unique, planned, and never a kept extension. */
function silentIds(s: Obj, waypointIds: readonly string[], w: string): string[] {
  if (s.silent_stop_ids === undefined) return [];
  const ids = strings(s, 'silent_stop_ids', w);
  const planned = new Set(waypointIds);
  const kept = new Set(Array.isArray(s.kept_extension_ids) ? (s.kept_extension_ids as string[]) : []);
  if (new Set(ids).size !== ids.length || ids.some((id) => !planned.has(id) || kept.has(id))) bad(`${w}.silent_stop_ids (must be planned core stops, once each)`);
  return ids;
}

/**
 * A 200 body, checked in full: field types, the transfer/chapter alternation,
 * each transfer pointing at the chapter that follows it, exits chained to the
 * previous chapter, and every chapter's tour among the pinned sources (and
 * every pinned source used). Throws PlanContractError.
 */
export function parsePlanTourOk(value: unknown): PlanTourOk {
  if (!isObj(value) || value.status !== 'ok') bad('status');
  if (value.contract_version !== PLAN_CONTRACT_VERSION) bad('contract_version');
  const planId = str(value, 'plan_id', 'body');
  if (!UUIDISH.test(planId)) bad('plan_id');
  const plannerVersion = str(value, 'planner_version', 'body');
  if (!/^v\d+$/.test(plannerVersion)) bad('planner_version');
  const contentHash = str(value, 'content_hash', 'body');
  if (!HEX32.test(contentHash)) bad('content_hash');
  const expiresAt = str(value, 'expires_at', 'body');
  if (!Number.isFinite(Date.parse(expiresAt))) bad('expires_at');

  const rawSources = Array.isArray(value.sources) ? value.sources : bad('sources');
  const sources = rawSources.map((s, i): PlanSource => {
    if (!isObj(s)) bad(`sources[${i}]`);
    return { tour_id: str(s, 'tour_id', `sources[${i}]`), bundle_version_hash: str(s, 'bundle_version_hash', `sources[${i}]`) };
  });
  const sourceIds = new Set(sources.map((s) => s.tour_id));
  if (sources.length === 0 || sourceIds.size !== sources.length) bad('sources (empty or repeated)');

  const raw = Array.isArray(value.segments) ? value.segments : bad('segments');
  if (raw.length === 0 || raw.length % 2 !== 0) bad('segments (must be transfer, chapter pairs)');
  const segments: PlanSegment[] = [];
  const usedTours = new Set<string>();
  raw.forEach((s, i) => {
    const w = `segments[${i}]`;
    if (!isObj(s)) bad(w);
    if (i % 2 === 0) {
      if (s.kind !== 'transfer') bad(`${w}.kind (expected transfer)`);
      const from = s.from;
      if (!isObj(from)) bad(`${w}.from`);
      let parsedFrom: TransferSegment['from'];
      if (i === 0) {
        if (from.kind !== 'origin' || 'point' in from) bad(`${w}.from (the first transfer starts at the origin, with no coordinates)`);
        parsedFrom = { kind: 'origin' };
      } else {
        if (from.kind !== 'chapter_exit') bad(`${w}.from.kind`);
        const prev = segments[i - 1] as ChapterSegment;
        if (from.chapter_id !== prev.chapter_id) bad(`${w}.from.chapter_id (must be the previous chapter)`);
        parsedFrom = { kind: 'chapter_exit', chapter_id: prev.chapter_id, point: point(from.point, `${w}.from.point`) };
      }
      const providers = strings(s, 'providers', w);
      if (providers.length === 0 || !providers.every((p) => PROVIDERS.includes(p))) bad(`${w}.providers`);
      segments.push({
        kind: 'transfer',
        from: parsedFrom,
        to_chapter_id: str(s, 'to_chapter_id', w),
        to: point(s.to, `${w}.to`),
        mode: oneOf<TransitMode>(s.mode, MODES, `${w}.mode`),
        duration_s: num(s, 'duration_s', w),
        distance_m: num(s, 'distance_m', w),
        cost_source: oneOf<CostSource>(s.cost_source, SOURCES, `${w}.cost_source`),
        providers: providers as HandoffProvider[],
      });
    } else {
      if (s.kind !== 'chapter') bad(`${w}.kind (expected chapter)`);
      const chapterId = str(s, 'chapter_id', w);
      if ((segments[i - 1] as TransferSegment).to_chapter_id !== chapterId) bad(`${w}.chapter_id (the transfer before it goes elsewhere)`);
      const tourId = str(s, 'tour_id', w);
      if (!sourceIds.has(tourId)) bad(`${w}.tour_id (not among the pinned sources)`);
      usedTours.add(tourId);
      const waypointIds = strings(s, 'waypoint_ids', w);
      if (waypointIds.length === 0 || new Set(waypointIds).size !== waypointIds.length) bad(`${w}.waypoint_ids`);
      segments.push({
        kind: 'chapter',
        tour_id: tourId,
        chapter_id: chapterId,
        transit_mode: oneOf<TransitMode>(s.transit_mode, MODES, `${w}.transit_mode`),
        waypoint_ids: waypointIds,
        kept_extension_ids: strings(s, 'kept_extension_ids', w),
        dropped_extension_ids: strings(s, 'dropped_extension_ids', w),
        silent_stop_ids: silentIds(s, waypointIds, w),
        travel_s: num(s, 'travel_s', w),
        dwell_s: num(s, 'dwell_s', w),
        cost_source: oneOf<CostSource>(s.cost_source, SOURCES, `${w}.cost_source`),
      });
    }
  });
  if (usedTours.size !== sourceIds.size) bad('sources (a pinned tour no chapter uses)');

  const e = isObj(value.estimate) ? value.estimate : bad('estimate');
  const estimate: PlanEstimate = {
    budget_s: num(e, 'budget_s', 'estimate'),
    total_s: num(e, 'total_s', 'estimate'),
    transfer_s: num(e, 'transfer_s', 'estimate'),
    chapter_travel_s: num(e, 'chapter_travel_s', 'estimate'),
    dwell_s: num(e, 'dwell_s', 'estimate'),
    deep_dive_extra_s: num(e, 'deep_dive_extra_s', 'estimate'),
    slack_s: num(e, 'slack_s', 'estimate'),
    pace_factor: num(e, 'pace_factor', 'estimate', 1),
  };
  if (estimate.total_s > estimate.budget_s) bad('estimate (total over budget)');
  const q = isObj(value.quality) ? value.quality : bad('quality');
  if (typeof q.search_truncated !== 'boolean') bad('quality.search_truncated');
  const quality: PlanQuality = {
    candidates_considered: num(q, 'candidates_considered', 'quality'),
    legs_total: num(q, 'legs_total', 'quality'),
    legs_estimated: num(q, 'legs_estimated', 'quality'),
    search_truncated: q.search_truncated,
    dropped_high_value_extensions: num(q, 'dropped_high_value_extensions', 'quality'),
  };

  return {
    status: 'ok', contract_version: PLAN_CONTRACT_VERSION, plan_id: planId, planner_version: plannerVersion,
    content_hash: contentHash, expires_at: expiresAt, sources, segments, estimate, quality,
  };
}

export interface ParsedError {
  code: string;
  detail: string;
  retryAfterS?: number;
  shortfallS?: number;
  staleTourIds?: string[];
  requestId?: string;
}

/** A non-200 body's error fields, or null when it is not this contract's error shape (a gateway page, say). */
export function parsePlanError(value: unknown): ParsedError | null {
  if (!isObj(value) || value.status !== 'error' || typeof value.code !== 'string') return null;
  const out: ParsedError = { code: value.code, detail: typeof value.detail === 'string' ? value.detail : '' };
  if (typeof value.retry_after_s === 'number') out.retryAfterS = value.retry_after_s;
  if (typeof value.shortfall_s === 'number') out.shortfallS = value.shortfall_s;
  if (Array.isArray(value.stale_tour_ids)) out.staleTourIds = value.stale_tour_ids.filter((x): x is string => typeof x === 'string');
  if (typeof value.request_id === 'string') out.requestId = value.request_id;
  return out;
}
