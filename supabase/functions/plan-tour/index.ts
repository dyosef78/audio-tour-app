/**
 * Epic 16 Part 3 - Edge Function `plan-tour`. Wiring only; behaviour and the
 * HTTP contract are in handler.ts.
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY       provided by the Edge Runtime. REQUIRED:
 *                                   get_planner_candidates, tour_plans and the
 *                                   cost tables are service_role only
 *   STADIA_API_KEY, VALHALLA_ROUTE_URL
 *                                   the background cost fill; without them the
 *                                   planner still works, on estimates only
 *   LOG_PSEUDONYM_KEY, AXIOM_*      optional log shipping (_shared/logger.ts)
 *
 * Authorisation: the planner reads only published content (the SQL's
 * explicit status predicate) and writes only plans and costs it computed, so
 * the caller's identity matters for ONE thing - whose plan it is.
 */

import { createClient } from '@supabase/supabase-js';
import { ValhallaClient, isRoutingError, valhallaConfigFromEnv } from '@shared/routing/index.ts';

import { handlePlanTour, RpcError, type ChapterState, type FillDeps, type PlanTourDeps, type StoredPlan } from './handler.ts';
import { createRateLimiter, type BucketOutcome, type BucketRequest } from '../_shared/rateLimit.ts';
import { loggerFromEnv } from '../_shared/logger.ts';

const env = Deno.env.toObject();
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(work: Promise<unknown>): void } }).EdgeRuntime;
const log = loggerFromEnv('plan-tour', env, edgeRuntime ? (work) => edgeRuntime.waitUntil(work) : null).log;

const supabaseUrl = env.SUPABASE_URL;
const anonKey = env.SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

/** One round trip may not eat the client's patience. */
const DB_TIMEOUT_MS = 5_000;
const RATE_LIMIT_TIMEOUT_MS = 1_000;

const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;

type StoredRow = {
  id: string;
  user_id: string | null;
  expires_at: string;
  content_hash: string;
  source_tour_hashes: Record<string, string>;
  plan: StoredPlan['plan'];
};
const PLAN_COLUMNS = 'id,user_id,expires_at,content_hash,source_tour_hashes,plan';
const toStored = (r: StoredRow): StoredPlan => ({
  id: r.id,
  userId: r.user_id,
  expiresAt: r.expires_at,
  contentHash: r.content_hash,
  sourceTourHashes: r.source_tour_hashes,
  plan: r.plan,
});

async function consume(buckets: BucketRequest[]): Promise<BucketOutcome> {
  const { data, error } = await admin!
    .rpc('consume_rate_limit', {
      p_keys: buckets.map((b) => b.key),
      p_capacities: buckets.map((b) => b.capacity),
      p_refill_per_second: buckets.map((b) => b.refillPerSecond),
    })
    .abortSignal(AbortSignal.timeout(RATE_LIMIT_TIMEOUT_MS));
  if (error) throw new Error(`consume_rate_limit: ${error.message}`);
  const r = data as { allowed: boolean; retry_after_seconds: number; remaining: number; exhausted: string[] };
  return { allowed: r.allowed, retryAfterSeconds: r.retry_after_seconds, remaining: r.remaining, exhausted: r.exhausted };
}

/**
 * The Valhalla budget for enrichment, across every isolate: 5 requests at
 * once, 5 per minute sustained. Each request fills at most 5 cells.
 */
const FILL_BUCKET: BucketRequest = { key: 'plan-tour:valhalla-fill', capacity: 5, refillPerSecond: 5 / 60 };

let fill: FillDeps | null = null;
if (admin) {
  try {
    const router = new ValhallaClient(valhallaConfigFromEnv(env));
    fill = {
      async takeToken() {
        try {
          return (await consume([FILL_BUCKET])).allowed;
        } catch (cause) {
          // Fail CLOSED here, unlike the request limiter: enrichment is
          // optional, and an unmetered Valhalla is what the bound prevents.
          log({ event: 'plan_tour_fill_bucket_unavailable', message: String(cause) });
          return false;
        }
      },
      route: (locations, profile) => router.route(locations, profile),
      async saveLegs(rows) {
        const { error } = await admin.from('chapter_leg_costs').upsert(
          rows.map((r) => ({
            chapter_id: r.chapterId, from_node: r.fromNode, to_node: r.toNode, profile: r.profile,
            duration_seconds: r.durationS, distance_meters: r.distanceM, coords_key: r.coordsKey,
            // An upsert that refreshes a row must restamp it; the default only fires on insert.
            computed_at: new Date().toISOString(),
          })),
          { onConflict: 'chapter_id,from_node,to_node,profile' },
        );
        if (error) throw new Error(`chapter_leg_costs write: ${error.message}`);
      },
      async saveTransfers(rows) {
        const { error } = await admin.from('chapter_travel_matrix').upsert(
          rows.map((r) => ({
            from_chapter_id: r.fromChapterId, to_chapter_id: r.toChapterId, profile: r.profile,
            duration_seconds: r.durationS, distance_meters: r.distanceM, coords_key: r.coordsKey,
            computed_at: new Date().toISOString(),
          })),
          { onConflict: 'from_chapter_id,to_chapter_id,profile' },
        );
        if (error) throw new Error(`chapter_travel_matrix write: ${error.message}`);
      },
    };
  } catch (cause) {
    log({ event: 'plan_tour_fill_disabled', reason: isRoutingError(cause) ? cause.message : String(cause) });
  }
}

const deps: PlanTourDeps | null = admin
  ? {
      now: () => Date.now(),
      requestId: () => crypto.randomUUID(),
      // Its own buckets (name), so plan-tour and route-stops never drain each other.
      rateLimit: createRateLimiter({ name: 'plan-tour', secret: serviceKey as string, log, store: consume }),

      async userIdFor(request) {
        const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (!token || token === anonKey) return null;
        const { data, error } = await admin.auth.getUser(token);
        // An expired or foreign token plans anonymously rather than failing:
        // the plan is then simply not attached to an account.
        return error ? null : (data.user?.id ?? null);
      },

      async candidates(a) {
        const { data, error } = await admin
          .rpc('get_planner_candidates', {
            p_city_id: a.cityId,
            p_origin_lon: a.lon,
            p_origin_lat: a.lat,
            p_transit_mode: a.transitMode,
            p_group_type: a.groupType,
            p_interests: a.interests,
            p_budget_seconds: a.budgetS,
            p_include_deep_dives: a.includeDeepDives,
            p_exclude_chapter_ids: a.excludeChapterIds,
          })
          .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
        if (error) throw new RpcError(`get_planner_candidates: ${error.message}`, error.code);
        return data;
      },

      async bundleHashes(tourIds) {
        // service_role bypasses RLS, so publication is checked explicitly:
        // an unpublished tour has no hash, and a plan naming it is stale.
        const { data: tours, error } = await admin.from('tours').select('id,status').in('id', tourIds)
          .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
        if (error) throw new Error(`tours read: ${error.message}`);
        const published = new Set((tours ?? []).filter((t) => t.status === 'published').map((t) => t.id as string));
        const out: Record<string, string | null> = {};
        await Promise.all(tourIds.map(async (id) => {
          if (!published.has(id)) {
            out[id] = null;
            return;
          }
          const { data, error: e } = await admin.rpc('get_tour_bundle', { p_tour_id: id }).abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
          if (e) throw new Error(`get_tour_bundle: ${e.message}`);
          out[id] = (data as { bundle_version_hash?: string } | null)?.bundle_version_hash ?? null;
        }));
        return out;
      },

      async chapterState(ids) {
        const { data, error } = await admin.rpc('get_plan_chapter_state', { p_chapter_ids: ids })
          .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
        if (error) throw new Error(`get_plan_chapter_state: ${error.message}`);
        const rows = (data ?? {}) as Record<string, { tour_id: string; tour_published: boolean; plannable: boolean; entry: [number, number] | null; exit: [number, number] | null }>;
        const out: Record<string, ChapterState> = {};
        for (const [id, r] of Object.entries(rows)) {
          out[id] = { tourId: r.tour_id, tourPublished: r.tour_published, plannable: r.plannable, entry: r.entry, exit: r.exit };
        }
        return out;
      },

      async findPlanByHash(hash) {
        const { data, error } = await admin.from('tour_plans').select(PLAN_COLUMNS).eq('request_hash', hash)
          .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).maybeSingle();
        if (error) throw new Error(`tour_plans read: ${error.message}`);
        return data ? toStored(data as StoredRow) : null;
      },

      async loadPlan(id) {
        const { data, error } = await admin.from('tour_plans').select(PLAN_COLUMNS).eq('id', id)
          .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).maybeSingle();
        if (error) throw new Error(`tour_plans read: ${error.message}`);
        return data ? toStored(data as StoredRow) : null;
      },

      async savePlan(row) {
        // ON CONFLICT (request_hash) DO UPDATE: two identical requests racing
        // both land on ONE row and both get its id back.
        const { data, error } = await admin.from('tour_plans').upsert({
          request_hash: row.requestHash,
          user_id: row.userId,
          city_id: row.cityId,
          contract_version: 1,
          planner_version: row.plan.planner_version,
          request: row.request,
          // 3 decimals, as text: tour_plans_origin_rounded_check refuses more.
          origin_approx: `SRID=4326;POINT(${row.originApprox[0].toFixed(3)} ${row.originApprox[1].toFixed(3)})`,
          plan: row.plan,
          chapter_ids: row.chapterIds,
          source_tour_hashes: row.sourceTourHashes,
          content_hash: row.contentHash,
          budget_seconds: row.budgetS,
          estimated_seconds: row.estimatedS,
          expires_at: row.expiresAt,
        }, { onConflict: 'request_hash' }).select(PLAN_COLUMNS).abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).single();
        if (error) throw new Error(`tour_plans write: ${error.message}`);
        return toStored(data as StoredRow);
      },

      fill,
      defer: (work) => edgeRuntime?.waitUntil(work),
      log,
    }
  : null;

if (!deps) log({ event: 'plan_tour_disabled', reason: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing' });

Deno.serve((request) =>
  deps
    ? handlePlanTour(request, deps)
    : new Response(JSON.stringify({ status: 'error', code: 'internal', detail: 'plan-tour is not configured.', retryable: false, request_id: crypto.randomUUID() }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
);
