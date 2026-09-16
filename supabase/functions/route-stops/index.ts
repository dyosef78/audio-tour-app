/**
 * TASK-702 - Edge Function `route-stops`: a route through a subset of a tour's
 * stops, for the device's hybrid offline-first RouteManager.
 *
 * Wiring only; behaviour and the HTTP contract are in handler.ts.
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the Edge Runtime
 *   STADIA_API_KEY                    `supabase secrets set STADIA_API_KEY=...`
 *   VALHALLA_ROUTE_URL                optional; defaults to Stadia Maps
 *
 * `@shared/` resolves through supabase/functions/import_map.json, which
 * supabase/config.toml names for this function.
 */

import { createClient } from '@supabase/supabase-js';
import { ValhallaClient, isRoutingError, valhallaConfigFromEnv } from '@shared/routing/index.ts';

import { handleRouteStops, type RouteStopsDeps } from './handler.ts';
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

// Module scope: shared by every request this isolate serves.
const cache = new RouteMemoryCache();

Deno.serve((request) => handleRouteStops(request, { loadTour, router, routerUnavailableReason, cache }));
