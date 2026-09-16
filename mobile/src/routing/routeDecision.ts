import type { EncodedRoute, LatLng, TransitMode } from '../types/domain';

/**
 * The route-selection rule, as one pure function (TASK-604).
 *
 * Three things can be drawn, best first:
 *
 *   dynamic   a route through ONLY the active stops, fetched while online.
 *             Considered only when stops were filtered out; otherwise the
 *             bundled route already is the right route.
 *   static    the route from the offline bundle, through every stop. When
 *             stops were filtered it still passes the skipped ones - the
 *             "physical backbone" - and only their pins disappear.
 *   straight  no route at all (every production tour today): stops joined by
 *             lines, drawn dashed so nobody mistakes them for a path.
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

export interface DynamicRouteRequest {
  tourId: string;
  /** In visiting (sort) order. */
  waypointIds: string[];
  transitMode: TransitMode;
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
  | { kind: 'ok'; route: EncodedRoute }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string };

export interface RouteInputs {
  filtered: boolean;
  staticRoute: LatLng[] | null;
  dynamicRoute: LatLng[] | null;
  online: boolean;
  fetchState: FetchState;
  attempts: number;
  /** The disk cache has been consulted. Fetching before that could pay for a route already stored. */
  cacheChecked: boolean;
}

export interface RouteDecision extends RouteDisplay {
  shouldFetch: boolean;
}

export function decideRoute(i: RouteInputs): RouteDecision {
  const display: RouteDisplay =
    i.filtered && i.dynamicRoute !== null
      ? { source: 'dynamic', points: i.dynamicRoute }
      : i.staticRoute !== null
        ? { source: 'static', points: i.staticRoute }
        : { source: 'straight', points: null };

  const shouldFetch =
    i.filtered &&
    i.dynamicRoute === null &&
    i.cacheChecked &&
    i.online &&
    i.fetchState === 'idle' &&
    i.attempts < MAX_FETCH_ATTEMPTS;

  return { ...display, shouldFetch };
}

/**
 * Where a dynamic route is cached. Null disables caching.
 *
 * The bundle hash is part of the key: if stops move, the tour's hash changes
 * and a route drawn for the old positions is never reused. Stop ids are sorted
 * because the set, not the argument order, decides the route - visiting order
 * always follows sort_order.
 */
export function routeCacheKey(
  tourId: string,
  bundleHash: string | null,
  stopIds: readonly string[],
): string | null {
  if (!bundleHash) return null;
  return `route:dynamic:v1:${tourId}:${bundleHash}:${[...stopIds].sort().join(',')}`;
}
