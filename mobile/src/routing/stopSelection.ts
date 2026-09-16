import type { RouteCriteria } from '../personalization/options';
import type { Waypoint } from '../types/domain';

/**
 * Which stops a session runs, from the onboarding preferences (TASK-604).
 *
 * Pure. The rule, per stop:
 *   audiences empty OR includes the group type
 *   AND interests empty OR shares at least one interest
 * Empty tags mean "not restricted" (TASK-603), so an untagged catalogue - every
 * tour in production today - filters nothing.
 *
 * Skipped stops leave the SESSION, not just the map: the geofence engine never
 * sees them, so a hidden stop cannot start narrating as someone walks past it
 * along the route. The time budget is not applied per stop; it selects tours.
 */

export interface StopSelection {
  active: Waypoint[];
  skippedIds: string[];
  /** True only when at least one stop was actually removed. */
  filtered: boolean;
}

/** Below this the preference is ignored rather than the tour. */
export const MIN_ACTIVE_STOPS = 2;

export function stopMatches(stop: Waypoint, criteria: RouteCriteria): boolean {
  const audiences = stop.audiences ?? [];
  const interests = stop.interests ?? [];
  const audienceOk = audiences.length === 0 || audiences.includes(criteria.groupType);
  const interestOk = interests.length === 0 || interests.some((i) => criteria.interests.includes(i));
  return audienceOk && interestOk;
}

export function selectStops(waypoints: readonly Waypoint[], criteria: RouteCriteria | null): StopSelection {
  const everything: StopSelection = { active: [...waypoints], skippedIds: [], filtered: false };
  if (criteria === null) return everything;

  const active = waypoints.filter((w) => stopMatches(w, criteria));
  if (active.length === waypoints.length) return everything;

  // A tour narrowed to one stop, or none, is not a tour. Better to run it whole
  // than to hand someone an empty map.
  if (active.length < MIN_ACTIVE_STOPS) return everything;

  const kept = new Set(active.map((w) => w.id));
  return { active, skippedIds: waypoints.filter((w) => !kept.has(w.id)).map((w) => w.id), filtered: true };
}
