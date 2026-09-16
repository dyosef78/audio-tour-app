/**
 * TASK-702 - the "Smart Sorter": decides the order stops are visited in.
 *
 * Valhalla routes strictly in the order this returns (ValhallaClient calls
 * /route, never /optimized_route). Ordering intelligence lives here and only
 * here.
 *
 * MVP STRATEGIES, in precedence order:
 *
 *   order_index         every POI has one -> ascending, ties by id. For tour
 *                       stops this is waypoints.sort_order, i.e. the order the
 *                       tour was authored in. This is what production uses.
 *   nearest_neighbour   otherwise -> greedy nearest-next from the start POI
 *                       (preferences.start, else the lowest order_index, else
 *                       the first POI given). Within ~25% of optimal for the
 *                       handful of stops a tour has; not a TSP solver.
 *
 * CONTRACTS ANY FUTURE STRATEGY MUST KEEP (read before adding AI scoring):
 *
 *   1. PURE AND DETERMINISTIC for the same input. The route cache is keyed on
 *      the ORDER this produces, so a sorter that returns a different order for
 *      the same request simply misses the cache - it is never wrong, only
 *      expensive. Anything time-varying (opening hours, time of day) must arrive
 *      through `preferences` or `context`, never read from a clock in here.
 *   2. THE APP DOES NOT YET ADOPT THE ORDER. Today the device runs stops in
 *      sort_order (mobile/src/routing/stopSelection.ts) and keys its route cache
 *      on the unordered set. A strategy that departs from order_index must ship
 *      together with an app release that reads `waypoint_ids` from the response
 *      and sequences the geofences by it; otherwise the drawn route and the
 *      narration order disagree.
 *   3. SYNCHRONOUS AND CHEAP here. An LLM call belongs in its own async step
 *      before this function with its own timeout and fallback - the whole Edge
 *      Function answers inside the phone's 10 s budget.
 */

import { distanceMeters } from '@shared/distance.ts';

/** Bumped whenever a strategy changes the order it produces for the same input. */
export const SORTER_VERSION = 'v1';

export interface SortablePoi {
  id: string;
  lon: number;
  lat: number;
  /** waypoints.sort_order for tour stops. */
  orderIndex?: number | null;
  poiType?: string | null;
  audiences?: readonly string[];
  interests?: readonly string[];
  /** Future scoring inputs (opening hours, scenery rating, cuisine...). Unused in v1. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SortPreferences {
  groupType?: string;
  interests?: readonly string[];
  /** Where the visitor is now. Only used by nearest_neighbour. */
  start?: { lon: number; lat: number };
}

export type SortStrategy = 'order_index' | 'nearest_neighbour';

export interface SortResult<T extends SortablePoi> {
  ordered: T[];
  strategy: SortStrategy;
}

export function smartSort<T extends SortablePoi>(pois: readonly T[], preferences: SortPreferences = {}): SortResult<T> {
  // ---------------------------------------------------------------------------
  // TODO: AI Scoring (Culinary, Scenery, Time of Day)
  //
  // Intended shape: score each POI against `preferences` and a request-time
  // `context` (local time, weather, opening hours from `metadata`), then order
  // by an objective that trades score against walking distance, e.g.
  //
  //   const scores = await scorePois(pois, preferences, context);  // LLM / model
  //   return { ordered: orderByScoreAndDistance(pois, scores), strategy: 'ai_scored' };
  //
  // Before enabling, see contracts 1-3 above: the async scoring call moves out
  // of this function, the result must be deterministic for its inputs, and the
  // app must adopt the returned order.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // TODO: Hard constraints (Opening Hours, Accessibility)
  //
  // Filtering, not ordering: a closed museum should leave the list before any
  // strategy runs. Needs opening-hours data the schema does not have yet.
  // ---------------------------------------------------------------------------

  if (pois.every((p) => typeof p.orderIndex === 'number' && Number.isFinite(p.orderIndex))) {
    const ordered = [...pois].sort(
      (a, b) => (a.orderIndex as number) - (b.orderIndex as number) || compareIds(a.id, b.id),
    );
    return { ordered, strategy: 'order_index' };
  }

  return { ordered: nearestNeighbour(pois, preferences.start), strategy: 'nearest_neighbour' };
}

function nearestNeighbour<T extends SortablePoi>(pois: readonly T[], start: SortPreferences['start']): T[] {
  const remaining = [...pois];
  if (remaining.length <= 1) return remaining;

  const point = (p: { lon: number; lat: number }) => ({ lat: p.lat, lng: p.lon });

  let firstIndex = 0;
  if (start) {
    firstIndex = indexOfNearest(remaining, point(start));
  } else {
    // Lowest order_index among those that have one; else the caller's first.
    let best = Number.POSITIVE_INFINITY;
    remaining.forEach((p, i) => {
      if (typeof p.orderIndex === 'number' && p.orderIndex < best) {
        best = p.orderIndex;
        firstIndex = i;
      }
    });
  }

  const ordered = remaining.splice(firstIndex, 1);
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1] as T;
    ordered.push(...remaining.splice(indexOfNearest(remaining, point(last)), 1));
  }
  return ordered;
}

function indexOfNearest(pois: readonly SortablePoi[], from: { lat: number; lng: number }): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  pois.forEach((p, i) => {
    const d = distanceMeters(from, { lat: p.lat, lng: p.lon });
    // Ties go to the lower id, not the input position: contract 1.
    if (d < bestDistance || (d === bestDistance && compareIds(p.id, (pois[bestIndex] as SortablePoi).id) < 0)) {
      bestDistance = d;
      bestIndex = i;
    }
  });
  return bestIndex;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
