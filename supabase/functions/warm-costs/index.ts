/**
 * Epic 16 Part 4 - Edge Function `warm-costs`. Wiring only; see handler.ts.
 *
 * Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * (runtime-provided; service role REQUIRED), STADIA_API_KEY /
 * VALHALLA_ROUTE_URL (without them only dry runs work),
 * VALHALLA_BUDGET_BURST / _PER_MINUTE (the budget shared with route-stops and
 * plan-tour), LOG_PSEUDONYM_KEY / AXIOM_* (optional log shipping).
 *
 * Driven by `npm run planner:warm -- --city <slug>` (backend/scripts/warm-planner.ts).
 */

import { createClient } from '@supabase/supabase-js';
import { ValhallaClient, isRoutingError, valhallaConfigFromEnv } from '@shared/routing/index.ts';

import { handleWarmCosts, type WarmDeps } from './handler.ts';
import type { FillDeps } from '../_shared/costFill.ts';
import { costWriters } from '../_shared/costWriters.ts';
import type { BucketOutcome, BucketRequest } from '../_shared/rateLimit.ts';
import { takeValhallaToken, valhallaGlobalBucket } from '../_shared/valhallaBudget.ts';
import { loggerFromEnv } from '../_shared/logger.ts';

const env = Deno.env.toObject();
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(work: Promise<unknown>): void } }).EdgeRuntime;
const log = loggerFromEnv('warm-costs', env, edgeRuntime ? (work) => edgeRuntime.waitUntil(work) : null).log;

const supabaseUrl = env.SUPABASE_URL;
const anonKey = env.SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const DB_TIMEOUT_MS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;

/**
 * Warming's own share: at most 30 Valhalla requests a minute (each <= 5
 * cells), AND the valhalla:global token every caller pays - so the live
 * route-stops traffic of legacy builds always keeps most of the budget.
 */
const WARM_BUCKET: BucketRequest = { key: 'warm-costs:valhalla', capacity: 30, refillPerSecond: 30 / 60 };
const VALHALLA_GLOBAL = valhallaGlobalBucket(env);

async function consume(buckets: BucketRequest[]): Promise<BucketOutcome> {
  const { data, error } = await admin!
    .rpc('consume_rate_limit', {
      p_keys: buckets.map((b) => b.key),
      p_capacities: buckets.map((b) => b.capacity),
      p_refill_per_second: buckets.map((b) => b.refillPerSecond),
    })
    .abortSignal(AbortSignal.timeout(1_000));
  if (error) throw new Error(`consume_rate_limit: ${error.message}`);
  const r = data as { allowed: boolean; retry_after_seconds: number; remaining: number; exhausted: string[] };
  return { allowed: r.allowed, retryAfterSeconds: r.retry_after_seconds, remaining: r.remaining, exhausted: r.exhausted };
}

let fill: FillDeps | null = null;
if (admin) {
  try {
    const router = new ValhallaClient(valhallaConfigFromEnv(env));
    fill = {
      takeToken: async () => (await takeValhallaToken(consume, [WARM_BUCKET, VALHALLA_GLOBAL], 'fail-closed', log)).ok,
      route: (locations, profile) => router.route(locations, profile),
      ...costWriters(admin),
    };
  } catch (cause) {
    log({ event: 'warm_costs_fill_disabled', reason: isRoutingError(cause) ? cause.message : String(cause) });
  }
}

const deps: WarmDeps | null = admin && supabaseUrl && anonKey
  ? {
      requestId: () => crypto.randomUUID(),

      async callerRole(request) {
        const auth = request.headers.get('Authorization') ?? '';
        const token = auth.replace(/^Bearer\s+/i, '');
        if (!token || token === anonKey) return 'anonymous';
        // is_cms_admin() under the CALLER's token: app_admins membership, the
        // project's one authority for admin (never a JWT claim).
        const asCaller = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const { data, error } = await asCaller.rpc('is_cms_admin').abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
        if (error) return 'anonymous';
        return data === true ? 'admin' : 'not_admin';
      },

      async resolveCity(city) {
        const q = admin.from('cities').select('id');
        const { data, error } = await (UUID.test(city) ? q.eq('id', city.toLowerCase()) : q.eq('slug', city))
          .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS)).maybeSingle();
        if (error) throw new Error(`cities read: ${error.message}`);
        return (data as { id: string } | null)?.id ?? null;
      },

      async warmState(cityId) {
        const { data, error } = await admin.rpc('get_warm_state', { p_city_id: cityId }).abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
        if (error) throw new Error(`get_warm_state: ${error.message}`);
        return data;
      },

      fill,
      log,
    }
  : null;

if (!deps) log({ event: 'warm_costs_disabled', reason: 'SUPABASE_URL, SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY missing' });

Deno.serve((request) =>
  deps
    ? handleWarmCosts(request, deps)
    : new Response(JSON.stringify({ status: 'error', code: 'internal', detail: 'warm-costs is not configured.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
);
