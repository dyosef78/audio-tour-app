/**
 * TASK-801 - route a stop sequence from cached legs, calling Valhalla only for
 * the hops the durable cache (public.route_legs_cache) cannot supply.
 *
 * Free of Deno and Supabase globals: index.ts supplies the real LegStore
 * (service-role PostgREST), the tests an in-memory one.
 *
 * READ RULES - a cached leg is used only when ALL hold:
 *   - updated within LEG_TTL_MS (14 days)          stale map data, seasonal closures
 *   - its coords_key equals the stops' coordinates  the stop has not moved since,
 *                                                   including the write race the
 *                                                   invalidation trigger cannot see
 *   - its polyline decodes                          never let a bad row fail a route
 *
 * ONE PROVIDER CALL AT MOST. Missing legs are fetched in a single Valhalla
 * request spanning the first missing hop to the last. Fetching each missing run
 * separately would cost one billed request per run - more than the uncached
 * path whenever the misses are scattered. Cached legs inside the span are
 * re-fetched and refreshed rather than paying for a second request.
 *
 * THE CACHE NEVER FAILS A REQUEST. A read error routes as if nothing were
 * cached; a write error is logged. Writes run after the response via `defer`
 * (EdgeRuntime.waitUntil) - a bare un-awaited promise can be killed with the
 * isolate once the response is sent.
 */

import { PolylineError, decodePolyline, distanceToRouteMeters } from '@shared/polyline.ts';
import { RoutingError, joinLegPolylines, type LonLat, type RouteLeg, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';

export const LEG_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface LegKey {
  startId: string;
  endId: string;
}

export interface CachedLeg extends LegKey {
  profile: ValhallaProfile;
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
  coordsKey: string;
  /** ISO timestamp, the database's clock. */
  updatedAt: string;
}

export type NewLeg = Omit<CachedLeg, 'updatedAt'>;

export interface LegStore {
  /** Legs for these pairs updated at or after `since`. May return extra rows; throws on failure. */
  find(profile: ValhallaProfile, pairs: readonly LegKey[], since: Date): Promise<CachedLeg[]>;
  /** Upsert on (startId, endId, profile). Throws on failure. */
  save(legs: readonly NewLeg[]): Promise<void>;
}

export interface LegStop {
  id: string;
  lon: number;
  lat: number;
}

export interface LegRouter {
  route(locations: readonly LonLat[], profile: ValhallaProfile): Promise<ValhallaRoute>;
}

export interface LegRouteOptions {
  store: LegStore | null;
  now?: () => number;
  defer?: (work: Promise<unknown>) => void;
  log?: (event: Record<string, unknown>) => void;
}

export interface LegRouteResult {
  route: ValhallaRoute;
  cachedLegs: number;
  fetchedLegs: number;
}

/** "lon,lat;lon,lat" to 6 decimals - the precision the polyline carries, as routeCacheKey. */
export function legCoordsKey(from: LegStop, to: LegStop): string {
  return `${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}`;
}

export async function routeViaLegCache(
  stops: readonly LegStop[],
  profile: ValhallaProfile,
  router: LegRouter,
  options: LegRouteOptions,
): Promise<LegRouteResult> {
  const { store } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const locations: LonLat[] = stops.map((s) => [s.lon, s.lat]);

  if (!store) return { route: await router.route(locations, profile), cachedLegs: 0, fetchedLegs: locations.length - 1 };

  const hops = stops.slice(1).map((to, i) => {
    const from = stops[i] as LegStop;
    return { startId: from.id, endId: to.id, coordsKey: legCoordsKey(from, to) };
  });

  const legs: (RouteLeg | undefined)[] = await readLegs(store, profile, hops, now(), log);
  const missing = legs.flatMap((leg, i) => (leg ? [] : [i]));

  if (missing.length === 0) {
    return { route: assemble(profile, legs as RouteLeg[], locations), cachedLegs: legs.length, fetchedLegs: 0 };
  }

  const first = missing[0] as number;
  const last = missing[missing.length - 1] as number;
  // Routing errors propagate: RouteMemoryCache decides what to remember.
  const fetched = await router.route(locations.slice(first, last + 2), profile);
  if (fetched.legs.length !== last - first + 1) {
    throw new RoutingError('invalid_response', `Router returned ${fetched.legs.length} legs for ${last - first + 1} hops.`);
  }

  const fresh: NewLeg[] = fetched.legs.map((leg, k) => {
    const hop = hops[first + k] as (typeof hops)[number];
    legs[first + k] = leg;
    return {
      startId: hop.startId,
      endId: hop.endId,
      profile,
      polyline: leg.polyline,
      distanceMeters: leg.distanceMeters,
      durationSeconds: leg.durationSeconds,
      coordsKey: hop.coordsKey,
    };
  });

  const write = store.save(fresh).catch((cause: unknown) => {
    log({ event: 'route_legs_cache_write_failed', legs: fresh.length, message: String(cause) });
  });
  if (options.defer) options.defer(write);

  const cachedLegs = legs.length - fresh.length;
  // The whole route in one response: Valhalla's own summary is exact.
  const route = cachedLegs === 0 ? fetched : assemble(profile, legs as RouteLeg[], locations);
  return { route, cachedLegs, fetchedLegs: fresh.length };
}

async function readLegs(
  store: LegStore,
  profile: ValhallaProfile,
  hops: readonly (LegKey & { coordsKey: string })[],
  nowMs: number,
  log: (event: Record<string, unknown>) => void,
): Promise<(RouteLeg | undefined)[]> {
  const since = nowMs - LEG_TTL_MS;
  let rows: CachedLeg[];
  try {
    rows = await store.find(profile, hops, new Date(since));
  } catch (cause) {
    log({ event: 'route_legs_cache_read_failed', message: String(cause) });
    return hops.map(() => undefined);
  }

  const byPair = new Map(rows.map((r) => [`${r.startId}|${r.endId}|${r.profile}`, r]));
  let rejected = 0;
  const legs = hops.map((hop): RouteLeg | undefined => {
    const row = byPair.get(`${hop.startId}|${hop.endId}|${profile}`);
    if (!row) return undefined;
    // Re-checked here although the query filters: the store is an interface,
    // and serving a stale or moved leg is the one thing this must not do.
    const fresh = Date.parse(row.updatedAt) >= since;
    if (!fresh || row.coordsKey !== hop.coordsKey || !decodes(row.polyline)) {
      rejected++;
      return undefined;
    }
    return { polyline: row.polyline, distanceMeters: row.distanceMeters, durationSeconds: row.durationSeconds };
  });
  if (rejected > 0) log({ event: 'route_legs_cache_rows_rejected', count: rejected });
  return legs;
}

function decodes(polyline: string): boolean {
  try {
    return decodePolyline(polyline, 6).length >= 2;
  } catch (cause) {
    if (cause instanceof PolylineError) return false;
    throw cause;
  }
}

function assemble(profile: ValhallaProfile, legs: readonly RouteLeg[], locations: readonly LonLat[]): ValhallaRoute {
  const polyline = joinLegPolylines(legs.map((l) => l.polyline));
  const points = decodePolyline(polyline, 6);
  return {
    profile,
    encoding: 'polyline',
    precision: 6,
    polyline,
    // Sums of whole-metre legs: within a metre per hop of Valhalla's trip summary.
    distanceMeters: legs.reduce((sum, l) => sum + l.distanceMeters, 0),
    durationSeconds: legs.reduce((sum, l) => sum + l.durationSeconds, 0),
    legs: [...legs],
    locationOffsetsMeters: locations.map(([lng, lat]) => Math.round(distanceToRouteMeters({ lat, lng }, points))),
  };
}
