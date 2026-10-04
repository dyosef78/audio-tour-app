/**
 * Epic 16 Part 4 - ONE Valhalla (Stadia) budget for every caller (PM, 4 Oct 2026).
 *
 * Three functions call Valhalla: route-stops (legacy app builds, on leg-cache
 * misses), plan-tour's background fill, and warm-costs. Each already limits
 * itself; together they could still exceed the Stadia plan and get the key
 * banned. So every Valhalla request first takes a token from the shared
 * bucket VALHALLA_GLOBAL_BUCKET - in the SAME atomic consume_rate_limit call
 * as the caller's own sub-bucket (all or nothing, keys locked in order).
 *
 * FAILURE POLICY, per caller:
 *   fail-open    route-stops: a visitor is waiting, and the bucket store being
 *                down is not a reason to break their route
 *   fail-closed  plan-tour fill, warm-costs: enrichment is optional, and an
 *                unmetered Valhalla is exactly what this module prevents
 */

import { RoutingError, type LonLat, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';
import type { BucketOutcome, BucketRequest } from './rateLimit.ts';

export type BucketStore = (buckets: BucketRequest[]) => Promise<BucketOutcome>;

const DEFAULT_GLOBAL = { burst: 120, perMinute: 120 };

/** The shared bucket. VALHALLA_BUDGET_BURST / VALHALLA_BUDGET_PER_MINUTE override it in every function. */
export function valhallaGlobalBucket(env: Readonly<Record<string, string | undefined>> = {}): BucketRequest {
  const read = (name: string, fallback: number): number => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v >= 1 && v <= 100_000 ? v : fallback;
  };
  const burst = read('VALHALLA_BUDGET_BURST', DEFAULT_GLOBAL.burst);
  const perMinute = read('VALHALLA_BUDGET_PER_MINUTE', DEFAULT_GLOBAL.perMinute);
  return { key: 'valhalla:global', capacity: burst, refillPerSecond: perMinute / 60 };
}

export type TokenDecision = { ok: true } | { ok: false; retryAfterSeconds: number; reason: 'budget' | 'store_unavailable' };

/** One Valhalla request's worth of tokens: the caller's sub-bucket (if any) AND the global one. */
export async function takeValhallaToken(
  store: BucketStore,
  buckets: BucketRequest[],
  policy: 'fail-open' | 'fail-closed',
  log: (event: Record<string, unknown>) => void,
): Promise<TokenDecision> {
  try {
    const outcome = await store(buckets);
    if (outcome.allowed) return { ok: true };
    log({ event: 'valhalla_budget_exhausted', exhausted: outcome.exhausted, retry_after_seconds: outcome.retryAfterSeconds });
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(outcome.retryAfterSeconds)), reason: 'budget' };
  } catch (cause) {
    log({ event: 'valhalla_budget_unavailable', policy, message: String(cause) });
    return policy === 'fail-open' ? { ok: true } : { ok: false, retryAfterSeconds: 60, reason: 'store_unavailable' };
  }
}

export interface Router {
  route(locations: readonly LonLat[], profile: ValhallaProfile): Promise<ValhallaRoute>;
}

/**
 * A router that spends a budget token before every request. Out of budget, it
 * throws RoutingError('rate_limited') - which route-stops already answers as
 * 429 + Retry-After, a status every app build retries with backoff.
 */
export function budgetedRouter(router: Router, take: () => Promise<TokenDecision>): Router {
  return {
    async route(locations, profile) {
      const decision = await take();
      if (!decision.ok) {
        throw new RoutingError('rate_limited', 'The shared Valhalla budget is exhausted.', { retryAfterMs: decision.retryAfterSeconds * 1000 });
      }
      return router.route(locations, profile);
    },
  };
}
