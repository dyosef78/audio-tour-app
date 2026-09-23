import { smartSort, type SortablePoi } from '../../../shared/src/smartSorter';
import type { Waypoint } from '../types/domain';
import type { RouteCriteria } from '../personalization/options';
import type { DynamicRouteRequest, RoutePreferences } from './routeDecision';

/**
 * The route-stops wire format, both directions (TASK-901 / TASK-902).
 *
 * Pure, so `npm run test:ui` can check the exact body the phone sends and the
 * order it adopts without a network or a device. DynamicRouteClient does the
 * sending; handler.ts in supabase/functions/route-stops is the other side.
 */

/**
 * "2026-09-17T18:40:05+03:00" for an instant and the UTC offset in force there.
 *
 * `offsetMinutesEast` is the sign convention of the ISO string (+03:00 = 180),
 * the OPPOSITE of Date.getTimezoneOffset(). Seconds are kept, milliseconds are
 * not: the server's rules work in minutes and a shorter string is easier to
 * read in the function's logs.
 */
export function formatLocalTime(epochMs: number, offsetMinutesEast: number): string {
  const offset = Math.round(offsetMinutesEast);
  // Shift the instant by the offset, then read it with UTC getters: that is the
  // wall clock at that offset, independent of the time zone running this code.
  const wall = new Date(epochMs + offset * 60_000);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}` +
    `T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * The device's wall-clock time WITH its UTC offset.
 *
 * Never toISOString(): that is UTC ("...Z"), which the server would accept and
 * then score as if the visitor stood in Greenwich - morning in Tel Aviv would
 * be read as 3 hours earlier. The offset is taken for `now` itself, so a walk
 * that starts the night the clocks change gets the offset actually in force.
 */
export function deviceLocalTime(now: Date = new Date()): string {
  return formatLocalTime(now.getTime(), -now.getTimezoneOffset());
}

/**
 * The onboarding answers route-stops scores with, from the criteria a session
 * snapshots at start (TASK-1103). Group type and interests only: the time
 * budget chose the TOUR in Discovery and the city is implied by tour_id, so
 * neither has a field in the request. Null - and so no `preferences` key -
 * until onboarding has produced complete criteria.
 */
export function routePreferencesOf(criteria: RouteCriteria | null): RoutePreferences | null {
  return criteria ? { groupType: criteria.groupType, interests: criteria.interests } : null;
}

/** The JSON body POSTed to route-stops. */
export function routeRequestBody(request: DynamicRouteRequest): Record<string, unknown> {
  return {
    tour_id: request.tourId,
    waypoint_ids: request.waypointIds,
    transit_mode: request.transitMode,
    // Omitted, not sent empty, before onboarding: the server then scores on
    // time alone, and predictStopOrder does exactly the same.
    ...(request.preferences
      ? { preferences: { group_type: request.preferences.groupType, interests: [...request.preferences.interests] } }
      : {}),
    // Its presence opts the request in to the scored sort (smartSorter.ts).
    context: { local_time: request.localTime },
  };
}

/**
 * The order route-stops WOULD answer for this request, computed on the device
 * with the server's own sorter (TASK-903). Used only to find a cached route
 * while offline; the server's answer always wins once it arrives.
 *
 * Mirrors handler.ts: stops mapped as parseBundle maps the bundle (ids lower-
 * cased - the sorter breaks ties on them), given in request order, with
 * `preferences` exactly as parseRequest would read the body above. A
 * divergence (a server on a newer SORTER_VERSION, a tag this build drops)
 * yields a different order, which only misses the cache: an entry is stored
 * under the order the server actually routed, so a hit can never pair a route
 * with the wrong narration order. Null when the sorter refuses the input.
 */
export function predictStopOrder(
  stops: readonly Waypoint[],
  preferences: DynamicRouteRequest['preferences'],
  localTime: string,
): string[] | null {
  const pois: SortablePoi[] = stops.map((s) => ({
    id: s.id.toLowerCase(),
    lon: s.coordinate.longitude,
    lat: s.coordinate.latitude,
    orderIndex: s.sortOrder,
    poiType: s.poiType,
    audiences: s.audiences ?? [],
    interests: s.interests ?? [],
  }));
  try {
    const { ordered } = smartSort(
      pois,
      preferences ? { groupType: preferences.groupType, interests: preferences.interests } : {},
      { localTime },
    );
    return adoptableStopOrder(ordered.map((p) => p.id), stops);
  } catch {
    return null;
  }
}

/** `waypoint_ids` from a route-stops response, or null when absent or malformed. */
export function parseRouteOrder(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const ids = (value as Record<string, unknown>)['waypoint_ids'];
  if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === 'string')) return null;
  return ids;
}

/**
 * The server's order, in the session's own ids - or null when it is not
 * exactly a reordering of `stops`.
 *
 * Null leaves narration on the authored order. A partial order cannot be
 * adopted safely: a stop missing from it would never be armed, and one the
 * server added would arm a geofence the session does not run. Compared
 * case-insensitively because Postgres and the bundle may disagree on uuid case.
 */
export function adoptableStopOrder(order: readonly string[], stops: readonly Waypoint[]): string[] | null {
  if (order.length !== stops.length) return null;
  const byKey = new Map(stops.map((s) => [s.id.toLowerCase(), s.id]));
  const seen = new Set<string>();
  const adopted: string[] = [];
  for (const id of order) {
    const key = id.toLowerCase();
    const own = byKey.get(key);
    if (own === undefined || seen.has(key)) return null;
    seen.add(key);
    adopted.push(own);
  }
  return adopted;
}
