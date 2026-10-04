/**
 * Epic 16 planner constants. Every number that changes a plan lives here, and
 * PLANNER_VERSION is bumped whenever one changes: the version is part of
 * request_hash, so a changed rule can never be served a plan cached under the
 * old one.
 *
 * PM-approved 4 Oct 2026: margin, base value, detour factor, pace modifiers.
 * ESTIMATE_SPEED_MPS is new with this implementation (see the handover).
 */

import type { GroupType } from '../vocabulary.ts';
import type { TransitMode } from '../contracts/planTour.ts';

/** v2 (Part 4): quality.dropped_high_value_extensions. Same plans, richer metadata. */
export const PLANNER_VERSION = 'v2';

/** Plans fill at most (1 - margin) of the budget: slack absorbs pace error. */
export const PLANNING_MARGIN = 0.1;

/**
 * An extension counts toward quality.dropped_high_value_extensions (the
 * "add more time" upsell) only at this matched weight or above.
 */
export const HIGH_VALUE_WEIGHT = 2;

/** Value of a chapter merely for being in the plan, so content beats idle time. */
export const BASE_CHAPTER_VALUE = 1;

/** A missing cost is estimated as straight-line metres x this. */
export const DETOUR_FACTOR = 1.4;

/**
 * Speeds for ESTIMATED costs only (never the pruning bound). Realistic, not
 * upper bounds: an estimate should be neither optimistic nor absurd.
 *   walking  5.1 km/h, Valhalla's pedestrian default
 *   biking   18 km/h
 *   driving  40 km/h, a blend of town and road
 */
export const ESTIMATE_SPEED_MPS: Readonly<Record<TransitMode, number>> = {
  walking: 1.42,
  biking: 5.0,
  driving: 11.1,
};

/** Multiplies WALKING travel time only (PM: walking pace modifiers). */
export const WALKING_PACE: Readonly<Record<GroupType, number>> = {
  solo: 1.0,
  couple: 1.0,
  friends: 1.0,
  family_kids: 1.3,
};

/** Chapter-sequence search bounds. Deterministic: same input, same cut-off. */
export const MAX_SEARCH_NODES = 5_000;
export const MAX_PLAN_CHAPTERS = 8;

/** Background enrichment: at most this many missing cost cells per execution (PM). */
export const MAX_FILL_CELLS = 5;

/** tour_plans.expires_at (PM: 30 days). */
export const PLAN_TTL_DAYS = 30;
