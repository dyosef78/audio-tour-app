/**
 * PlanTourRequest validation (shared/src/contracts/planTour.ts). Every
 * malformed field is a reason string, never a silent default: a plan for a
 * request we guessed at is a plan nobody asked for.
 */

import { PLAN_CONTRACT_VERSION, type PlanTourRequest, type TransitMode } from '../contracts/planTour.ts';
import { GROUP_TYPE_IDS, INTEREST_IDS, type GroupType, type Interest } from '../vocabulary.ts';

export type RequestCheck =
  | { ok: true; request: PlanTourRequest }
  | { ok: false; code: 'invalid_request' | 'unsupported_contract'; detail: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** ISO 8601 with an explicit offset - time-of-day belongs to the visitor's clock. */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:\d{2})$/;
const MODES: readonly TransitMode[] = ['walking', 'biking', 'driving'];

export const MIN_AVAILABLE_MINUTES = 15;
export const MAX_AVAILABLE_MINUTES = 1440;
export const MAX_EXCLUDED_CHAPTERS = 50;

export function checkPlanRequest(body: unknown): RequestCheck {
  const bad = (detail: string): RequestCheck => ({ ok: false, code: 'invalid_request', detail });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return bad('body must be a JSON object');
  const b = body as Record<string, unknown>;

  if (b.contract_version !== PLAN_CONTRACT_VERSION) {
    return { ok: false, code: 'unsupported_contract', detail: `contract_version must be ${PLAN_CONTRACT_VERSION}` };
  }
  if (typeof b.city_id !== 'string' || !UUID.test(b.city_id)) return bad('city_id must be a uuid');

  const o = b.origin as Record<string, unknown> | null;
  if (typeof o !== 'object' || o === null) return bad('origin is required');
  const { lon, lat, source } = o;
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)
      || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    return bad('origin needs lon and lat in range');
  }
  if (source !== 'gps' && source !== 'address') return bad("origin.source must be 'gps' or 'address'");

  const minutes = b.available_minutes;
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_AVAILABLE_MINUTES || minutes > MAX_AVAILABLE_MINUTES) {
    return bad(`available_minutes must be a whole number ${MIN_AVAILABLE_MINUTES}..${MAX_AVAILABLE_MINUTES}`);
  }
  if (!MODES.includes(b.transit_mode as TransitMode)) return bad('transit_mode must be walking, biking or driving');
  if (!(GROUP_TYPE_IDS as readonly unknown[]).includes(b.group_type)) return bad('group_type is not in the vocabulary');

  const interests = b.interests;
  if (!Array.isArray(interests) || interests.length === 0
      || !interests.every((i) => (INTEREST_IDS as readonly unknown[]).includes(i))) {
    return bad('interests must be a non-empty list of vocabulary ids');
  }
  if (new Set(interests).size !== interests.length) return bad('interests must not repeat');

  const ctx = b.context as Record<string, unknown> | null;
  if (typeof ctx !== 'object' || ctx === null || typeof ctx.local_time !== 'string' || !LOCAL_TIME.test(ctx.local_time)) {
    return bad('context.local_time must be ISO 8601 with a UTC offset');
  }
  if (typeof b.include_deep_dives !== 'boolean') return bad('include_deep_dives must be true or false');

  const excl = b.exclude_chapter_ids ?? [];
  if (!Array.isArray(excl) || excl.length > MAX_EXCLUDED_CHAPTERS || !excl.every((x) => typeof x === 'string' && UUID.test(x))) {
    return bad(`exclude_chapter_ids must be at most ${MAX_EXCLUDED_CHAPTERS} uuids`);
  }

  return {
    ok: true,
    request: {
      contract_version: PLAN_CONTRACT_VERSION,
      city_id: (b.city_id as string).toLowerCase(),
      origin: { lon, lat, source },
      available_minutes: minutes,
      transit_mode: b.transit_mode as TransitMode,
      group_type: b.group_type as GroupType,
      interests: interests as Interest[],
      context: { local_time: ctx.local_time },
      include_deep_dives: b.include_deep_dives,
      exclude_chapter_ids: (excl as string[]).map((x) => x.toLowerCase()),
    },
  };
}

/**
 * The origin the planner actually plans from: 3 decimals (~110 m). It is the
 * only form stored (tour_plans.origin_approx) and part of request_hash, so the
 * plan is a pure function of the hash. The rounding is noise next to the
 * detour factor on the one leg it affects.
 */
export function roundOrigin(lon: number, lat: number): readonly [number, number] {
  return [Number(lon.toFixed(3)), Number(lat.toFixed(3))];
}
