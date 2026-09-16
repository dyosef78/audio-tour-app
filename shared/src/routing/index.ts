/**
 * TASK-701 - public surface of the routing service.
 *
 * Import from here. Typical use (CMS script or, later, the route-stops Edge
 * Function):
 *
 *   const client = new ValhallaClient(valhallaConfigFromEnv(process.env));
 *   const route = await client.route(
 *     stops.map((s) => [s.lon, s.lat] as const),      // visiting order, lon first
 *     PROFILE_FOR_TRANSIT_MODE[tour.transit_mode],
 *   );
 *   // route.polyline / route.precision go straight to cms_set_tour_route().
 *
 * On failure every path throws RoutingError; branch on `code`, and retry only
 * when `retryable` is true (honouring `retryAfterMs` if set).
 */

export { RoutingError, isRoutingError } from './errors.ts';
export type { RoutingErrorCode, RoutingErrorOptions } from './errors.ts';

export {
  DEFAULT_MAX_LOCATIONS,
  DEFAULT_TIMEOUT_MS,
  PROFILE_FOR_TRANSIT_MODE,
  STADIA_ROUTE_URL,
  ValhallaClient,
  joinLegPolylines,
  parseRetryAfter,
  valhallaConfigFromEnv,
} from './valhalla.ts';
export type {
  LonLat,
  RouteLeg,
  RouteOptions,
  ValhallaClientConfig,
  ValhallaProfile,
  ValhallaRoute,
} from './valhalla.ts';
