/**
 * What identifies a running session (Epic 16). A catalogue session is keyed by
 * its tour id, as before; a planned session spans several tours and is keyed
 * `plan:<planId>`. The key is what the session store, the ActiveTour route and
 * the tour notifications carry.
 *
 * A KEY IS NOT A TOUR ID. Nothing that expects a tours.id (telemetry's
 * tour_id is a uuid foreign key, and one refused row fails its whole batch;
 * TourBundleRepository) may be handed a key - use the stop's own tourId, or
 * the session's sourceTourIds.
 */

export const PLAN_SESSION_PREFIX = 'plan:';

export const planSessionKey = (planId: string): string => `${PLAN_SESSION_PREFIX}${planId}`;

/** The plan id in a plan session key, or null for a tour id. */
export function planIdOfSessionKey(key: string): string | null {
  return key.startsWith(PLAN_SESSION_PREFIX) ? key.slice(PLAN_SESSION_PREFIX.length) : null;
}
