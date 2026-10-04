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
  /** md5 over planner_version, the ordered chapters/waypoints and every source bundle hash. */
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
