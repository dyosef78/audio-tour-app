/**
 * Epic 16 Part 5 - Edge Function `places-search`. Wiring only; see handler.ts.
 *
 * Environment:
 *   GOOGLE_PLACES_API_KEY       server-only key, Places API (New) enabled and
 *                               restricted to that API. Missing -> 503.
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   runtime-provided: city centres
 *                               and the rate-limit buckets (service role only)
 *   LOG_PSEUDONYM_KEY, AXIOM_*  optional log shipping (_shared/logger.ts)
 */

import { createClient } from '@supabase/supabase-js';

import { handlePlacesSearch, type PlacesDeps } from './handler.ts';
import { createRateLimiter, type BucketOutcome, type BucketRequest } from '../_shared/rateLimit.ts';
import { loggerFromEnv } from '../_shared/logger.ts';

const env = Deno.env.toObject();
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(work: Promise<unknown>): void } }).EdgeRuntime;
const log = loggerFromEnv('places-search', env, edgeRuntime ? (work) => edgeRuntime.waitUntil(work) : null).log;

const supabaseUrl = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;

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

/**
 * Typing bursts: 30 at once, 60 a minute per client (the app debounces to
 * one request per 300 ms pause). The GLOBAL bucket is the spend ceiling -
 * 300 a minute across everyone - because anyone holding the public anon key
 * can call this function.
 */
const POLICY = { client: { burst: 30, perMinute: 60 }, global: { burst: 300, perMinute: 300 } };

/** City centres barely ever change: one read per city per isolate per 10 minutes. */
const CENTER_TTL_MS = 10 * 60 * 1000;
const centers = new Map<string, { at: number; value: readonly [number, number] | null }>();

const deps: PlacesDeps = {
  apiKey: env.GOOGLE_PLACES_API_KEY?.trim() || null,
  requestId: () => crypto.randomUUID(),
  rateLimit: admin ? createRateLimiter({ name: 'places-search', policy: POLICY, secret: serviceKey as string, log, store: consume }) : null,
  async cityCenter(cityId) {
    const hit = centers.get(cityId);
    if (hit && Date.now() - hit.at < CENTER_TTL_MS) return hit.value;
    if (!admin) throw new Error('places-search: SUPABASE_SERVICE_ROLE_KEY missing');
    const { data, error } = await admin.from('cities').select('center_lon,center_lat').eq('id', cityId)
      .abortSignal(AbortSignal.timeout(2_000)).maybeSingle();
    if (error) throw new Error(`cities read: ${error.message}`);
    const row = data as { center_lon: number | null; center_lat: number | null } | null;
    const value = row && row.center_lon !== null && row.center_lat !== null ? ([row.center_lon, row.center_lat] as const) : null;
    centers.set(cityId, { at: Date.now(), value });
    return value;
  },
  fetch: globalThis.fetch.bind(globalThis),
  log,
  now: () => Date.now(),
};

if (!deps.apiKey) log({ event: 'places_search_disabled', reason: 'GOOGLE_PLACES_API_KEY missing' });

Deno.serve((request) => handlePlacesSearch(request, deps));
