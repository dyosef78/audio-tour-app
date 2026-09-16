/**
 * TASK-702 - per-isolate route cache for route-stops.
 *
 * WHY THIS EXISTS AND NOT ONLY Cache-Control: the app calls route-stops with
 * POST (supabase.functions.invoke), and shared caches do not store POST
 * responses - the URL is the same for every tour, the body is what differs. So
 * the response headers help nobody but the device; this cache is what actually
 * saves Valhalla calls between devices.
 *
 * WHAT IT IS: a Map in module scope, so it lives as long as the Edge Runtime
 * keeps the isolate warm (minutes, not days) and each isolate has its own. It
 * removes repeat requests while a tour is being used and deduplicates
 * concurrent identical requests. A durable cross-isolate cache (a Postgres
 * table) is the follow-up if the Valhalla bill says it is needed.
 *
 * WHAT IS CACHED:
 *   routes                       for `ttlMs`
 *   non-retryable routing errors for `failureTtlMs` - an unroutable stop set
 *                                stays unroutable, and the app retries 3 times
 *   retryable errors             never - the next request should try again
 *
 * KEY: the profile plus the ORDERED coordinates actually sent to Valhalla - not
 * the request. Moving a stop changes the key by itself; preferences that do
 * not change the order share an entry; and a future sorter needs no key change.
 */

import { RoutingError, type LonLat, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';

export type RouteOutcome = { ok: true; route: ValhallaRoute } | { ok: false; error: RoutingError };

export interface RouteCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
}

interface Entry {
  expiresAt: number;
  outcome: Promise<RouteOutcome>;
}

export function routeCacheKey(profile: ValhallaProfile, locations: readonly LonLat[]): string {
  // toFixed(6): the precision the polyline carries, so float noise in the
  // bundle's coordinates cannot split one route into two entries.
  return `route:v1:${profile}:${locations.map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)}`).join(';')}`;
}

/** Short, opaque, stable: used as the ETag. */
export async function routeEtag(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `"${hex.slice(0, 32)}"`;
}

export class RouteMemoryCache {
  readonly #entries = new Map<string, Entry>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;
  readonly #failureTtlMs: number;
  readonly #now: () => number;

  constructor(options: RouteCacheOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 500;
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.#failureTtlMs = options.failureTtlMs ?? 60 * 60 * 1000;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * The cached outcome for `key`, or `compute()`'s. `hit` is true when this
   * call did not start a computation - including when it joined one in flight.
   *
   * `compute` must not be tied to one caller's lifetime (no request signal):
   * other requests may be awaiting the same promise.
   */
  async getOrCompute(key: string, compute: () => Promise<ValhallaRoute>): Promise<{ outcome: RouteOutcome; hit: boolean }> {
    const now = this.#now();
    const existing = this.#entries.get(key);
    if (existing && existing.expiresAt > now) {
      // Re-insert: Map iteration order is insertion order, which makes it an LRU.
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return { outcome: await existing.outcome, hit: true };
    }

    const entry: Entry = { expiresAt: Number.POSITIVE_INFINITY, outcome: Promise.resolve(null as never) };
    entry.outcome = compute().then(
      (route): RouteOutcome => {
        entry.expiresAt = this.#now() + this.#ttlMs;
        return { ok: true, route };
      },
      (error: unknown): RouteOutcome => {
        if (!(error instanceof RoutingError) || error.retryable || error.code === 'aborted') {
          if (this.#entries.get(key) === entry) this.#entries.delete(key);
          if (!(error instanceof RoutingError)) throw error;
        } else {
          entry.expiresAt = this.#now() + this.#failureTtlMs;
        }
        return { ok: false, error };
      },
    );

    this.#entries.delete(key);
    this.#entries.set(key, entry);
    this.#evict();

    return { outcome: await entry.outcome, hit: false };
  }

  /** Least recently used first. Awaiters of an evicted in-flight entry still get their result. */
  #evict(): void {
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= this.#maxEntries) break;
      this.#entries.delete(key);
    }
  }
}
