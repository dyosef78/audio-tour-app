/**
 * Epic 16 Part 3 - the plan-tour Edge Function: behaviour and HTTP contract.
 * index.ts wires the real database, Valhalla and rate limiter; tests inject
 * fakes through PlanTourDeps.
 *
 *   POST /functions/v1/plan-tour            PlanTourRequest -> PlanTourResponse
 *   GET  /functions/v1/plan-tour?plan_id=   -> PlanFetchResponse
 *
 * Status codes (shared/src/contracts/planTour.ts):
 *   200  a plan
 *   400  invalid_request | unsupported_contract
 *   404  plan_not_found          (also another signed-in user's plan)
 *   409  plan_stale              (a source tour or chapter changed)
 *   410  plan_expired
 *   422  no_candidates | origin_out_of_range | plan_infeasible
 *   429  rate_limited            (Retry-After)
 *   500  internal                (logged with request_id)
 *
 * THE REQUEST PATH NEVER CALLS VALHALLA. Missing costs are estimated and
 * flagged. After the response, ONE bounded background job enriches the cache:
 * at most MAX_FILL_CELLS cells, in at most ONE Valhalla request, behind a
 * global token bucket (PM, 4 Oct 2026). Gradual enrichment across requests,
 * never a sweep.
 */

import {
  CandidatesShapeError,
  chooseFillChain,
  contentHash,
  parseCandidates,
  PLAN_TTL_DAYS,
  PLANNER_VERSION,
  planTour,
  requestHash,
  roundOrigin,
  checkPlanRequest,
  type MissingCell,
  type Pair,
} from '@shared/planner/index.ts';
import { PLANNING_MARGIN } from '@shared/planner/constants.ts';
import type {
  ChapterSegment,
  PlanFetchError,
  PlanTourError,
  PlanTourErrorCode,
  PlanTourOk,
  PlanTourRequest,
} from '@shared/contracts/planTour.ts';
import type { RateLimiter } from '../_shared/rateLimit.ts';
import { fillMissingCosts, type FillDeps } from '../_shared/costFill.ts';

export { fillMissingCosts } from '../_shared/costFill.ts';
export type { FillDeps, FillOutcome, LegCostWrite, TransferCostWrite } from '../_shared/costFill.ts';

// -----------------------------------------------------------------------------
// Ports

export interface CandidatesArgs {
  cityId: string;
  lon: number;
  lat: number;
  transitMode: string;
  groupType: string;
  interests: string[];
  budgetS: number;
  includeDeepDives: boolean;
  excludeChapterIds: string[];
}

/** A database error with Postgres' SQLSTATE, so input errors become 400s, not 500s. */
export class RpcError extends Error {
  override readonly name = 'RpcError';
  constructor(message: string, readonly code: string | undefined) {
    super(message);
  }
}

/** What tour_plans.plan holds: the response minus plan_id and expires_at. */
export type StoredPlanBody = Omit<PlanTourOk, 'plan_id' | 'expires_at'>;

export interface StoredPlan {
  id: string;
  userId: string | null;
  expiresAt: string;
  contentHash: string;
  sourceTourHashes: Record<string, string>;
  plan: StoredPlanBody;
}

export interface NewPlanRow {
  requestHash: string;
  userId: string | null;
  cityId: string;
  /** Never carries the origin (tour_plans_request_check). */
  request: Record<string, unknown>;
  originApprox: Pair;
  plan: StoredPlanBody;
  chapterIds: string[];
  sourceTourHashes: Record<string, string>;
  contentHash: string;
  budgetS: number;
  estimatedS: number;
  expiresAt: string;
}

export interface ChapterState {
  tourId: string;
  tourPublished: boolean;
  plannable: boolean;
  entry: Pair | null;
  exit: Pair | null;
}

export interface PlanTourDeps {
  now(): number;
  requestId(): string;
  rateLimit: RateLimiter | null;
  /** The signed-in caller, or null for anon. */
  userIdFor(request: Request): Promise<string | null>;
  candidates(args: CandidatesArgs): Promise<unknown>;
  /** bundle_version_hash per tour; null when the tour is gone or unpublished. */
  bundleHashes(tourIds: string[]): Promise<Record<string, string | null>>;
  chapterState(chapterIds: string[]): Promise<Record<string, ChapterState>>;
  findPlanByHash(requestHash: string): Promise<StoredPlan | null>;
  loadPlan(id: string): Promise<StoredPlan | null>;
  /** Upsert on request_hash; returns the row as stored (race-free idempotency). */
  savePlan(row: NewPlanRow): Promise<StoredPlan>;
  fill: FillDeps | null;
  defer(work: Promise<unknown>): void;
  log(event: Record<string, unknown>): void;
}

// -----------------------------------------------------------------------------
// HTTP

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A cached plan this close to expiry is re-planned rather than served. */
const REUSE_MIN_REMAINING_MS = 60 * 60 * 1000;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

const RETRYABLE: ReadonlySet<PlanTourErrorCode> = new Set(['rate_limited', 'internal']);

function planError(status: number, code: PlanTourErrorCode, detail: string, requestId: string, extra: Partial<PlanTourError> = {}, headers: Record<string, string> = {}): Response {
  const body: PlanTourError = { status: 'error', code, detail, retryable: RETRYABLE.has(code), request_id: requestId, ...extra };
  return json(status, body, headers);
}

function fetchError(status: number, code: PlanFetchError['code'], detail: string, requestId: string, extra: Partial<PlanFetchError> = {}): Response {
  const body: PlanFetchError = { status: 'error', code, detail, retryable: false, request_id: requestId, ...extra };
  return json(status, body);
}

export async function handlePlanTour(request: Request, deps: PlanTourDeps): Promise<Response> {
  const requestId = deps.requestId();
  try {
    if (request.method !== 'POST' && request.method !== 'GET') {
      return json(405, { status: 'error', code: 'invalid_request', detail: 'POST a plan request or GET ?plan_id=', retryable: false, request_id: requestId }, { Allow: 'GET, POST' });
    }
    if (deps.rateLimit) {
      const decision = await deps.rateLimit(request);
      if (!decision.allowed) {
        deps.log({ event: 'plan_tour_rate_limited', scope: decision.scope, request_id: requestId });
        return planError(429, 'rate_limited', `Too many plan requests (${decision.scope}).`, requestId,
          { retry_after_s: decision.retryAfterSeconds }, { 'Retry-After': String(decision.retryAfterSeconds) });
      }
    }
    return request.method === 'POST' ? await post(request, deps, requestId) : await get(request, deps, requestId);
  } catch (cause) {
    deps.log({ event: 'plan_tour_internal_error', request_id: requestId, message: cause instanceof Error ? cause.message : String(cause) });
    return planError(500, 'internal', 'Planning failed; see the server log for this request_id.', requestId);
  }
}

// -----------------------------------------------------------------------------
// POST: plan

async function post(request: Request, deps: PlanTourDeps, requestId: string): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return planError(400, 'invalid_request', 'Body is not JSON.', requestId);
  }
  const check = checkPlanRequest(body);
  if (!check.ok) return planError(400, check.code, check.detail, requestId);
  const req = check.request;
  const origin = roundOrigin(req.origin.lon, req.origin.lat);
  const budgetS = req.available_minutes * 60;
  const userId = await deps.userIdFor(request);

  let raw: unknown;
  try {
    raw = await deps.candidates({
      cityId: req.city_id,
      lon: origin[0],
      lat: origin[1],
      transitMode: req.transit_mode,
      groupType: req.group_type,
      interests: [...req.interests],
      budgetS,
      includeDeepDives: req.include_deep_dives,
      excludeChapterIds: [...(req.exclude_chapter_ids ?? [])],
    });
  } catch (cause) {
    // 22023 = our own input checks in the SQL; P0002 = no_data_found (unknown city).
    if (cause instanceof RpcError && (cause.code === '22023' || cause.code === 'P0002')) {
      return planError(400, 'invalid_request', cause.message, requestId);
    }
    throw cause;
  }

  let answer;
  try {
    answer = parseCandidates(raw);
  } catch (cause) {
    if (cause instanceof CandidatesShapeError) throw new Error(`candidates shape: ${cause.message}`);
    throw cause;
  }

  const capacityS = Math.floor(budgetS * (1 - PLANNING_MARGIN));
  if (answer.candidates.length === 0) {
    const pruned = answer.pruned;
    if ((pruned.over_budget ?? 0) > 0) {
      const need = answer.minPrunedLowerBoundS ?? capacityS + 1;
      return planError(422, 'plan_infeasible', 'No chapter fits the time available.', requestId, { shortfall_s: Math.max(1, need - capacityS) });
    }
    if ((pruned.origin_too_far ?? 0) > 0) {
      return planError(422, 'origin_out_of_range', 'Every chapter is too far from the starting point for the time available.', requestId);
    }
    return planError(422, 'no_candidates', `No plannable chapter matches (considered ${answer.considered}, pruned ${JSON.stringify(pruned)}).`, requestId);
  }

  const outcome = planTour(req, answer, origin);
  if (!outcome.ok) {
    scheduleFill(deps, chooseFillChain([], outcome.missing), requestId);
    return planError(422, 'plan_infeasible', 'No chapter fits the time available.', requestId, { shortfall_s: outcome.shortfallS });
  }
  const draft = outcome.draft;
  const hash = await requestHash(req, origin, userId, raw);

  const cached = await deps.findPlanByHash(hash);
  if (cached && Date.parse(cached.expiresAt) - deps.now() > REUSE_MIN_REMAINING_MS && cached.userId === userId) {
    deps.log({ event: 'plan_tour_cache_hit', request_id: requestId, plan_id: cached.id });
    scheduleFill(deps, chooseFillChain(outcome.planCells, outcome.missing), requestId);
    return json(200, respond(cached));
  }

  const sourceTourIds = [...new Set(draft.chapters.map((c) => c.tourId))];
  const hashes = await deps.bundleHashes(sourceTourIds);
  const sourceTourHashes: Record<string, string> = {};
  for (const id of sourceTourIds) {
    const h = hashes[id];
    if (!h) throw new Error(`source tour ${id} has no bundle (unpublished between read and write?)`);
    sourceTourHashes[id] = h;
  }

  const plan: StoredPlanBody = {
    status: 'ok',
    contract_version: 1,
    planner_version: PLANNER_VERSION,
    content_hash: await contentHash(draft.chapters, sourceTourHashes),
    sources: sourceTourIds.map((tour_id) => ({ tour_id, bundle_version_hash: sourceTourHashes[tour_id]! })),
    segments: draft.segments,
    estimate: draft.estimate,
    quality: {
      candidates_considered: answer.considered,
      legs_total: draft.legsTotal,
      legs_estimated: draft.legsEstimated,
      search_truncated: draft.searchTruncated,
      dropped_high_value_extensions: draft.droppedHighValueExtensions,
    },
  };

  const stored = await deps.savePlan({
    requestHash: hash,
    userId,
    cityId: req.city_id,
    request: sanitisedRequest(req),
    originApprox: origin,
    plan,
    chapterIds: draft.chapters.map((c) => c.chapterId),
    sourceTourHashes,
    contentHash: plan.content_hash,
    budgetS,
    estimatedS: draft.estimate.total_s,
    expiresAt: new Date(deps.now() + PLAN_TTL_DAYS * 86_400_000).toISOString(),
  });
  deps.log({
    event: 'plan_tour_planned', request_id: requestId, plan_id: stored.id, chapters: draft.chapters.length,
    total_s: draft.estimate.total_s, legs_estimated: draft.legsEstimated, truncated: draft.searchTruncated,
  });
  scheduleFill(deps, chooseFillChain(outcome.planCells, outcome.missing), requestId);
  return json(200, respond(stored));
}

/** tour_plans.request: everything but the origin, which is never stored. */
function sanitisedRequest(req: PlanTourRequest): Record<string, unknown> {
  return {
    contract_version: req.contract_version,
    city_id: req.city_id,
    origin_source: req.origin.source,
    available_minutes: req.available_minutes,
    transit_mode: req.transit_mode,
    group_type: req.group_type,
    interests: [...req.interests].sort(),
    context: req.context,
    include_deep_dives: req.include_deep_dives,
    exclude_chapter_ids: [...(req.exclude_chapter_ids ?? [])].sort(),
  };
}

function respond(stored: StoredPlan): PlanTourOk {
  return { ...stored.plan, plan_id: stored.id, expires_at: stored.expiresAt };
}

// -----------------------------------------------------------------------------
// GET: a stored plan, revalidated

async function get(request: Request, deps: PlanTourDeps, requestId: string): Promise<Response> {
  const id = new URL(request.url).searchParams.get('plan_id') ?? '';
  // A malformed id is indistinguishable from an unknown one, on purpose.
  if (!UUID.test(id)) return fetchError(404, 'plan_not_found', 'No such plan.', requestId);
  const stored = await deps.loadPlan(id.toLowerCase());
  if (!stored) return fetchError(404, 'plan_not_found', 'No such plan.', requestId);
  if (stored.userId !== null && stored.userId !== (await deps.userIdFor(request))) {
    return fetchError(404, 'plan_not_found', 'No such plan.', requestId);
  }
  if (Date.parse(stored.expiresAt) <= deps.now()) return fetchError(410, 'plan_expired', 'This plan has expired; plan again.', requestId);

  const chapters = stored.plan.segments.filter((s): s is ChapterSegment => s.kind === 'chapter');
  const tourIds = Object.keys(stored.sourceTourHashes).sort();
  const [hashes, state] = await Promise.all([deps.bundleHashes(tourIds), deps.chapterState(chapters.map((c) => c.chapter_id))]);

  const stale = new Set<string>();
  for (const id of tourIds) if (hashes[id] !== stored.sourceTourHashes[id]) stale.add(id);
  const current: { chapterId: string; waypointIds: readonly string[]; entry: Pair; exit: Pair }[] = [];
  for (const c of chapters) {
    const s = state[c.chapter_id];
    if (!s || !s.tourPublished || !s.plannable || !s.entry || !s.exit) {
      stale.add(c.tour_id);
      continue;
    }
    current.push({ chapterId: c.chapter_id, waypointIds: c.waypoint_ids, entry: s.entry, exit: s.exit });
  }
  if (stale.size === 0 && (await contentHash(current, stored.sourceTourHashes)) !== stored.contentHash) {
    // Same bundles, but an entry/exit point moved: we cannot tell which chapter
    // from the hash alone, so every source tour is named.
    for (const id of tourIds) stale.add(id);
  }
  if (stale.size > 0) {
    return fetchError(409, 'plan_stale', 'A tour in this plan has changed; plan again.', requestId, { stale_tour_ids: [...stale].sort() });
  }
  return json(200, respond(stored));
}

// -----------------------------------------------------------------------------
// Background enrichment, strictly bounded (PM, 4 Oct 2026)

function scheduleFill(deps: PlanTourDeps, chain: MissingCell[], requestId: string): void {
  if (!deps.fill || chain.length === 0) return;
  deps.defer(
    fillMissingCosts(chain, deps.fill, deps.log).catch((cause) =>
      deps.log({ event: 'plan_tour_fill_failed', request_id: requestId, message: cause instanceof Error ? cause.message : String(cause) })),
  );
}
