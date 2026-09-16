/**
 * TASK-702 - Edge Function `route-stops`: a route through a subset of a tour's
 * stops, for the device's hybrid offline-first RouteManager.
 *
 * Wiring only; behaviour and the HTTP contract are in handler.ts.
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the Edge Runtime
 *   SUPABASE_SERVICE_ROLE_KEY         provided by the Edge Runtime; the leg cache
 *                                     (TASK-801) is off without it, routing still works
 *   STADIA_API_KEY                    `supabase secrets set STADIA_API_KEY=...`
 *   VALHALLA_ROUTE_URL                optional; defaults to Stadia Maps
 *
 * `@shared/` resolves through supabase/functions/import_map.json, which
 * supabase/config.toml names for this function.
 */

import { createClient } from '@supabase/supabase-js';
import { ValhallaClient, isRoutingError, valhallaConfigFromEnv } from '@shared/routing/index.ts';

import { handleRouteStops, type RouteStopsDeps } from './handler.ts';
import type { CachedLeg, LegStore } from './legCache.ts';
import { RouteMemoryCache } from './routeCache.ts';

const env = Deno.env.toObject();

let router: RouteStopsDeps['router'] = null;
let routerUnavailableReason: string | undefined;
try {
  router = new ValhallaClient(valhallaConfigFromEnv(env));
} catch (cause) {
  // Served as 501 per request rather than crashing the isolate at boot, so the
  // app sees "unavailable" and stops asking instead of retrying a 5xx.
  routerUnavailableReason = isRoutingError(cause) ? cause.message : String(cause);
}

const supabaseUrl = env.SUPABASE_URL;
const anonKey = env.SUPABASE_ANON_KEY;

const loadTour: RouteStopsDeps['loadTour'] =
  supabaseUrl && anonKey
    ? async (tourId, request) => {
        // The CALLER's token, not the service role: RLS is the authorisation.
        const supabase = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: request.headers.get('Authorization') ?? `Bearer ${anonKey}` } },
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const { data, error } = await supabase.rpc('get_tour_bundle', { p_tour_id: tourId });
        if (error) throw new Error(`get_tour_bundle: ${error.message}`);
        return data;
      }
    : null;

// -----------------------------------------------------------------------------
// route_legs_cache (TASK-801)
//
// SERVICE ROLE, deliberately: anon and authenticated have no privilege on the
// table, because a cache any signed-in user could write is a way to draw a
// forged route on every phone. handleRouteStops only reaches the store after
// get_tour_bundle, run as the caller, has proved the stops are visible.

/** A slow cache must not eat the phone's 10 s budget; past this, route uncached. */
const LEG_READ_TIMEOUT_MS = 1_500;
const LEG_COLUMNS = 'start_poi_id,end_poi_id,profile,polyline,distance_meters,duration_seconds,coords_key,updated_at';

const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const admin =
  supabaseUrl && serviceKey
    ? createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      })
    : null;

const legStore: LegStore | null = admin
  ? {
      async find(profile, pairs, since) {
        // Two IN lists over-select (every start x every end); the caller
        // matches exact pairs. At most MAX_STOPS^2 rows, on the primary key.
        const { data, error } = await admin
          .from('route_legs_cache')
          .select(LEG_COLUMNS)
          .eq('profile', profile)
          .in('start_poi_id', [...new Set(pairs.map((p) => p.startId))])
          .in('end_poi_id', [...new Set(pairs.map((p) => p.endId))])
          .gte('updated_at', since.toISOString())
          .abortSignal(AbortSignal.timeout(LEG_READ_TIMEOUT_MS));
        if (error) throw new Error(`route_legs_cache read: ${error.message}`);
        return (data ?? []).map(
          (r): CachedLeg => ({
            startId: r.start_poi_id,
            endId: r.end_poi_id,
            profile: r.profile,
            polyline: r.polyline,
            distanceMeters: r.distance_meters,
            durationSeconds: r.duration_seconds,
            coordsKey: r.coords_key,
            updatedAt: r.updated_at,
          }),
        );
      },
      async save(legs) {
        // updated_at is not sent: the column default stamps an insert and
        // trg_route_legs_cache_updated_at restamps a conflict update.
        const { error } = await admin.from('route_legs_cache').upsert(
          legs.map((l) => ({
            start_poi_id: l.startId,
            end_poi_id: l.endId,
            profile: l.profile,
            polyline: l.polyline,
            distance_meters: l.distanceMeters,
            duration_seconds: l.durationSeconds,
            coords_key: l.coordsKey,
          })),
          // No .select(): nothing is read back, so the response carries no rows.
          { onConflict: 'start_poi_id,end_poi_id,profile' },
        );
        if (error) throw new Error(`route_legs_cache write: ${error.message}`);
      },
    }
  : null;

if (!legStore) console.log(JSON.stringify({ event: 'route_legs_cache_disabled', reason: 'SUPABASE_SERVICE_ROLE_KEY missing' }));

// The response is sent before the cache write finishes. waitUntil keeps the
// isolate alive for it; without it the write can be cut off mid-flight.
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil(work: Promise<unknown>): void } }).EdgeRuntime;
const defer: RouteStopsDeps['defer'] = (work) => edgeRuntime?.waitUntil(work);

// Module scope: shared by every request this isolate serves.
const cache = new RouteMemoryCache();

Deno.serve((request) =>
  handleRouteStops(request, { loadTour, router, routerUnavailableReason, cache, legStore, defer }),
);
