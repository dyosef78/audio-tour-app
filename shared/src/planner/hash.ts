/**
 * request_hash and content_hash (20261005120000, tour_plans 6c/6f).
 *
 * Canonical JSON: object keys sorted, arrays in order, numbers as JSON prints
 * them. Two runtimes (Deno in production, Node in tests) must agree byte for
 * byte, so nothing here depends on property insertion order.
 * Web Crypto only (globalThis.crypto.subtle: Deno, Node 20+). It has no MD5,
 * so content_hash is the first 128 bits of SHA-256, which the tour_plans
 * CHECK (32 hex) accepts.
 */

import type { PlanTourRequest } from '../contracts/planTour.ts';
import type { Pair } from './candidates.ts';
import { PLANNER_VERSION } from './constants.ts';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError('canonicalJson: non-finite number');
    if (value === undefined) throw new RangeError('canonicalJson: undefined');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * One hash per plan. `candidatesRaw` is get_planner_candidates' answer as
 * received: any change to content or costs (a CMS edit, a filled cell) makes
 * a new key, so a cached plan is never stale by construction. local_time is
 * NOT in it: planner v1 has no time-of-day rules.
 */
export async function requestHash(
  request: PlanTourRequest,
  origin: Pair,
  userId: string | null,
  candidatesRaw: unknown,
): Promise<string> {
  return sha256Hex(canonicalJson({
    planner_version: PLANNER_VERSION,
    contract_version: request.contract_version,
    city_id: request.city_id,
    origin: [origin[0], origin[1]],
    transit_mode: request.transit_mode,
    group_type: request.group_type,
    interests: [...request.interests].sort(),
    available_minutes: request.available_minutes,
    include_deep_dives: request.include_deep_dives,
    exclude_chapter_ids: [...(request.exclude_chapter_ids ?? [])].sort(),
    user_id: userId,
    candidates: await sha256Hex(canonicalJson(candidatesRaw)),
  }));
}

export interface HashedChapter {
  chapterId: string;
  waypointIds: readonly string[];
  entry: Pair;
  exit: Pair;
}

/** Recomputed on every GET: a moved entry/exit or a changed bundle is plan_stale. */
export async function contentHash(chapters: readonly HashedChapter[], sourceTourHashes: Readonly<Record<string, string>>): Promise<string> {
  const full = await sha256Hex(canonicalJson({
    planner_version: PLANNER_VERSION,
    chapters: chapters.map((c) => ({ chapter_id: c.chapterId, waypoint_ids: c.waypointIds, entry: [c.entry[0], c.entry[1]], exit: [c.exit[0], c.exit[1]] })),
    sources: sourceTourHashes,
  }));
  return full.slice(0, 32);
}
