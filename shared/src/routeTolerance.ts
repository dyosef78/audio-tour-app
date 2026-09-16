/**
 * How far a stop may sit from its route before the route is treated as wrong.
 *
 * Mirrors public.route_tolerance_meters() in migration 20260916090000, which
 * uses the same numbers to block publishing. The device applies it to every
 * route before drawing one - bundled or fetched live - so a route the CMS would
 * refuse is never shown on a map either.
 *
 * Import-free: shared with backend/scripts/verify-bundle.ts and the Edge Functions.
 */
export function routeToleranceMeters(transitMode: string | null | undefined): number {
  return transitMode === 'driving' ? 500 : transitMode === 'biking' ? 250 : 150;
}
