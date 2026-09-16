import { FunctionsHttpError } from '@supabase/supabase-js';

import { isPermanentRouteStatus, type DynamicRouteRequest, type DynamicRouteResult } from '../../routing/routeDecision';
import { parseEncodedRoute } from '../../routing/routeGeometry';
import { deviceLocalTime, parseRouteOrder, routeRequestBody } from '../../routing/routeRequest';
import { isSupabaseConfigured, supabase } from '../supabase/client';

/**
 * Client for a route through a SUBSET of a tour's stops (TASK-604).
 *
 * The server side is supabase/functions/route-stops (TASK-702); its handler.ts
 * holds the full contract. Where it is not deployed, every call returns
 * `unavailable` (HTTP 404) and the app keeps the bundled route - the designed
 * fallback.
 *
 * CONTRACT - Supabase Edge Function `route-stops`
 *
 *   POST  { "tour_id": uuid, "waypoint_ids": [uuid, ...], "transit_mode": "walking",
 *           "context": { "local_time": "2026-09-17T18:40:05+03:00" } }
 *         waypoint_ids are in authored order and must all belong to tour_id.
 *         context (TASK-901) opts in to the server's scored sort; local_time is
 *         the device's wall clock WITH its UTC offset, stamped per attempt.
 *
 *   200   { "encoding": "polyline", "precision": 5 | 6,
 *           "polyline": "...", "length_meters": 1234,
 *           "waypoint_ids": [uuid, ...] }
 *         precision is REQUIRED; the client refuses a response without it.
 *         waypoint_ids is the order the polyline visits the stops. RouteManager
 *         hands it to the geofence engine once the route itself validates
 *         (TASK-902); without it narration keeps the authored order.
 *   404   function not deployed / tour not visible  -> unavailable, not retried
 *   501   routing not configured                    -> unavailable, not retried
 *   400, 422, other 4xx  request can never succeed   -> unavailable, not retried
 *   401, 408, 429, 5xx                               -> failed, retried with backoff
 *   (the rule is isPermanentRouteStatus in routing/routeDecision.ts)
 *
 * Server-side obligations the client cannot enforce: only route stops of a
 * PUBLISHED tour (anyone holding the anon key can call it); rate-limit, since
 * every call costs a routing request; and use a routing provider whose terms
 * allow the result to be cached on devices.
 *
 * Every response is validated again by RouteManager (decode + distance to each
 * stop) before it can reach the map.
 */

export const ROUTE_FUNCTION = 'route-stops';
export const ROUTE_REQUEST_TIMEOUT_MS = 10_000;

export async function fetchDynamicRoute(
  request: DynamicRouteRequest,
  signal: AbortSignal,
): Promise<DynamicRouteResult> {
  if (!isSupabaseConfigured) return { kind: 'unavailable', reason: 'Supabase is not configured' };

  try {
    const { data, error } = await supabase.functions.invoke(ROUTE_FUNCTION, {
      // Stamped here, per attempt, not when the session started: a retry after
      // a long dead zone must be scored at the time it is actually sent.
      body: routeRequestBody(request, deviceLocalTime()),
      signal,
      timeout: ROUTE_REQUEST_TIMEOUT_MS,
    });

    if (error) {
      if (error instanceof FunctionsHttpError) {
        const status = (error.context as { status?: number } | undefined)?.status;
        if (isPermanentRouteStatus(status)) {
          return { kind: 'unavailable', reason: `${ROUTE_FUNCTION} answered HTTP ${status}` };
        }
        return { kind: 'failed', reason: `${ROUTE_FUNCTION} answered HTTP ${status ?? '?'}` };
      }
      return { kind: 'failed', reason: error.message };
    }

    const route = parseEncodedRoute(data);
    return route
      ? { kind: 'ok', route, waypointIds: parseRouteOrder(data) }
      : { kind: 'failed', reason: 'response was not an encoded route with a declared precision' };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
