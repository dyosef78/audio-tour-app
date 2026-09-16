import type { EncodedRoute, LatLng, TransitMode } from '../types/domain';

/**
 * The route-selection rule, as one pure function (TASK-604, TASK-903).
 *
 * Three things can be drawn, best first:
 *
 *   dynamic   a route through the session's stops IN THE ORDER THEY NARRATE,
 *             from route-stops or from the disk cache. Requested for every
 *             session since TASK-903, filtered or not: it is the only route
 *             that follows the Smart Sorter's order.
 *   static    the route from the offline bundle, through every stop in
 *             authored order. When stops were filtered it still passes the
 *             skipped ones - the "physical backbone" - and only their pins
 *             disappear.
 *   straight  no route at all: stops joined by lines in narration order,
 *             drawn dashed so nobody mistakes them for a path.
 *
 * Once a dynamic route is in hand it is never given up for connectivity
 * reasons: it is already on the device (memory and disk), and swapping back
 * to the backbone the moment a tunnel starts would be worse, not safer.
 */

export type RouteSource = 'dynamic' | 'static' | 'straight';

export interface RouteDisplay {
  source: RouteSource;
  /** Null for 'straight': the map joins the stops itself. */
  points: LatLng[] | null;
}

export type FetchState =
  /** Nothing pending; may fetch when the other conditions allow. */
  | 'idle'
  | 'in_flight'
  /** Last attempt failed; waiting for the retry timer or a reconnect. */
  | 'failed'
  /** Endpoint absent, or it returned a route that failed validation. Not retried this session. */
  | 'unavailable';

/** Fetch attempts per session. A connection DROPPED mid-request does not spend one. */
export const MAX_FETCH_ATTEMPTS = 3;
/** Wait before attempt 2, then 3. A reconnect skips the wait. */
export const RETRY_DELAYS_MS: readonly number[] = [5_000, 20_000];

/**
 * The onboarding answers the Smart Sorter scores with (TASK-903): route-stops'
 * `preferences`. Ids from personalization/options.ts, which are also the
 * database tag vocabulary. Null when onboarding is not complete.
 */
export interface RoutePreferences {
  groupType: string;
  interests: readonly string[];
}

export interface DynamicRouteRequest {
  tourId: string;
  /** In authored (sort) order. The server answers with the order it routed. */
  waypointIds: string[];
  transitMode: TransitMode;
  /** The device's wall clock with its UTC offset, stamped per attempt (TASK-901). */
  localTime: string;
  /** Snapshotted when the session started, like the stop selection. */
  preferences: RoutePreferences | null;
}

/**
 * Whether an HTTP status from route-stops means "stop asking this session".
 *
 * 404/501 mean the function or its routing is absent. Other 4xx mean THIS
 * request can never succeed - a stop the server does not know (400), a stop
 * set Valhalla cannot route (422) - so retrying only spends routing calls.
 * Still retried: 401 (the session token may have been refreshed), 408 and 429
 * (transient by definition), and every 5xx.
 */
export function isPermanentRouteStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 501) return true;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

export type DynamicRouteResult =
  | {
      kind: 'ok';
      route: EncodedRoute;
      /**
       * The order the route visits the stops (TASK-902): the server's
       * `waypoint_ids`, unvalidated. Null when the response had none.
       */
      waypointIds: string[] | null;
    }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string };

export interface RouteInputs {
  staticRoute: LatLng[] | null;
  dynamicRoute: LatLng[] | null;
  /** A route-stops answer has been drawn this session. A cached route does not count. */
  liveRouteReceived: boolean;
  online: boolean;
  fetchState: FetchState;
  attempts: number;
  /**
   * The disk cache has been consulted. Waiting for it (milliseconds) means a
   * cached route is on screen while the request runs, and cannot land AFTER
   * the live one and replace it.
   */
  cacheChecked: boolean;
}

export interface RouteDecision extends RouteDisplay {
  shouldFetch: boolean;
}

export function decideRoute(i: RouteInputs): RouteDecision {
  const display: RouteDisplay =
    i.dynamicRoute !== null
      ? { source: 'dynamic', points: i.dynamicRoute }
      : i.staticRoute !== null
        ? { source: 'static', points: i.staticRoute }
        : { source: 'straight', points: null };

  // Every session asks once it can, even with a cached route drawn: the cache
  // answers for the order predicted on the device, the server decides the
  // order actually walked (TASK-903).
  const shouldFetch =
    !i.liveRouteReceived &&
    i.cacheChecked &&
    i.online &&
    i.fetchState === 'idle' &&
    i.attempts < MAX_FETCH_ATTEMPTS;

  return { ...display, shouldFetch };
}

/**
 * Where a dynamic route is cached. Null disables caching.
 *
 * Keyed on the ORDERED stop ids (TASK-903, v2): the same stops walked in the
 * morning order and in the sunset order are two routes, and neither may
 * overwrite the other. An entry is only ever written under the order its
 * polyline actually visits, so a hit is a route and a narration order that
 * agree by construction.
 *
 * The bundle hash is part of the key: if stops move, the tour's hash changes
 * and a route drawn for the old positions is never reused. v1 keys (the
 * unordered set) are never read again; they carry no order.
 */
export function routeCacheKey(
  tourId: string,
  bundleHash: string | null,
  orderedStopIds: readonly string[],
): string | null {
  if (!bundleHash) return null;
  return `route:dynamic:v2:${tourId}:${bundleHash}:${orderedStopIds.join(',')}`;
}
