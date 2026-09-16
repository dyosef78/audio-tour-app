/**
 * TASK-702 / TASK-802 - the "Smart Sorter": decides the order stops are visited in.
 *
 * Valhalla routes strictly in the order this returns (ValhallaClient calls
 * /route, never /optimized_route). Ordering intelligence lives here and only
 * here. Moved to shared/ in TASK-802 so the app can run the same rules offline.
 *
 * STRATEGIES, in precedence order:
 *
 *   scored              a `context` was given -> "nearest neighbour with a score
 *                       bonus". Start at the stop nearest preferences.start
 *                       (else the lowest order_index), then repeatedly go to
 *                       the stop maximising
 *                           (SCORE_WEIGHTS.base + score) / max(metres, MIN_HOP_METERS)
 *                       Score comes from the rule-based engine (scorePois); no
 *                       LLM, every weight is a constant in SCORE_WEIGHTS.
 *   order_index         every POI has one -> ascending, ties by id. For tour
 *                       stops this is waypoints.sort_order, i.e. the order the
 *                       tour was authored in.
 *   nearest_neighbour   otherwise -> greedy nearest-next from the start POI
 *                       (preferences.start, else the lowest order_index, else
 *                       the first POI given). Within ~25% of optimal for the
 *                       handful of stops a tour has; not a TSP solver.
 *
 * WHY `scored` NEEDS A CONTEXT RATHER THAN RUNNING FOR EVERYONE: contract 2.
 * No app build in the field sends `context`, so those requests keep
 * order_index, and the drawn route keeps matching the narration order.
 *
 * WHY NOT "HIGHEST SCORE FIRST" (the first TASK-802 draft): it zig-zags across
 * the city whenever high and low scores alternate along a street. Dividing by
 * distance makes a stop worth a detour in proportion to its score: with base
 * 10, an interest match (+10) is worth twice the walk, a golden-hour viewpoint
 * (+30) four times.
 *
 * TWO GUARDS THE PLAIN RATIO NEEDS:
 *   - base > 0: with every score 0 all ratios would be 0 and distance would
 *     stop mattering; with it, an unscored set degrades to nearest neighbour.
 *   - MIN_HOP_METERS: two stops at one address would divide by zero, and
 *     anything inside a geofence is "here" anyway.
 *
 * KNOWN LIMITATION - LEAPFROGGING: greedy, so a matched stop less than twice as
 * far as a plain one on the same street is visited first and the walk doubles
 * back. The detour is bounded by the ratio (at most ~2x the skipped hop for an
 * interest match), and the route-stops tests pin it.
 *
 * KNOWN LIMITATION: time rules score the REQUEST time, not the time the visitor
 * will arrive. A viewpoint is pulled earlier in the walk near sunset, not
 * scheduled for it. Arrival-time scoring needs leg durations inside the sorter.
 *
 * CONTRACTS ANY STRATEGY MUST KEEP:
 *
 *   1. PURE AND DETERMINISTIC for the same input. The route cache is keyed on
 *      the ORDER this produces, so a sorter that returns a different order for
 *      the same request simply misses the cache - it is never wrong, only
 *      expensive. Anything time-varying arrives through `context`, never from a
 *      clock in here: the Edge Function runs in UTC and does not know the
 *      visitor's time zone, so "the morning" is the device's to say.
 *   2. THE APP ADOPTS THE ORDER (TASK-901/902). App builds that send `context`
 *      also read `waypoint_ids` and arm the geofences in that order
 *      (mobile/src/services/location/stopSequence.ts). Builds before them send
 *      no context and get order_index, so their narration order still matches.
 *      Open: the device keys its route cache on the unordered set and caches no
 *      order (TASK-903), so a cached route may disagree with the authored
 *      narration order it falls back to.
 *   3. SYNCHRONOUS AND CHEAP. The whole Edge Function answers inside the
 *      phone's 10 s budget.
 *
 * Runtime-neutral (Metro, Node, Deno): relative imports only, no globals.
 */

import { distanceMeters } from './distance.ts';

/** Bumped whenever a strategy changes the order it produces for the same input. */
export const SORTER_VERSION = 'v2';

export interface SortablePoi {
  id: string;
  lon: number;
  lat: number;
  /** waypoints.sort_order for tour stops. */
  orderIndex?: number | null;
  /** waypoints.poi_type: anchor | transition | viewpoint | facility. */
  poiType?: string | null;
  /** audience_tag_vocabulary() ids. Empty = unrestricted. */
  audiences?: readonly string[];
  /** interest_tag_vocabulary() ids. Empty = unrestricted. */
  interests?: readonly string[];
  /** Future scoring inputs (opening hours, scenery rating...). Unused. */
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SortPreferences {
  /** audience_tag_vocabulary() id - options.ts GroupType. */
  groupType?: string;
  /** interest_tag_vocabulary() ids - options.ts Interest. */
  interests?: readonly string[];
  /** Where the visitor is now: picks the first stop for nearest_neighbour and scored. */
  start?: { lon: number; lat: number };
}

export interface SortContext {
  /**
   * The visitor's wall-clock time, ISO 8601 WITH its UTC offset:
   * "2026-09-17T18:40:00+03:00". The offset is what makes "morning" mean the
   * visitor's morning; see parseLocalTime.
   */
  localTime: string;
}

export type SortStrategy = 'scored' | 'order_index' | 'nearest_neighbour';

export interface SortResult<T extends SortablePoi> {
  ordered: T[];
  strategy: SortStrategy;
  /** Present for `scored`: per-POI score and the rules that produced it, in `ordered` order. */
  scores?: PoiScore[];
}

export interface PoiScore {
  id: string;
  score: number;
  /** Rule ids that fired, e.g. "interest:culinary", "time:morning_culinary". */
  reasons: string[];
}

export function smartSort<T extends SortablePoi>(
  pois: readonly T[],
  preferences: SortPreferences = {},
  context?: SortContext,
): SortResult<T> {
  // ---------------------------------------------------------------------------
  // TODO: Hard constraints (Opening Hours, Accessibility)
  //
  // Filtering, not ordering: a closed museum should leave the list before any
  // strategy runs. Needs opening-hours data the schema does not have yet.
  // ---------------------------------------------------------------------------

  if (context) {
    const time = parseLocalTime(context.localTime);
    if (!time) throw new RangeError(`context.localTime is not an ISO 8601 time with an offset: ${context.localTime}`);
    return scoredSort(pois, preferences, time);
  }

  if (pois.every((p) => typeof p.orderIndex === 'number' && Number.isFinite(p.orderIndex))) {
    const ordered = [...pois].sort(
      (a, b) => (a.orderIndex as number) - (b.orderIndex as number) || compareIds(a.id, b.id),
    );
    return { ordered, strategy: 'order_index' };
  }

  return { ordered: nearestNeighbour(pois, preferences.start), strategy: 'nearest_neighbour' };
}

// -----------------------------------------------------------------------------
// Weight engine

/**
 * Every weight in one place. Additive: a POI's score is the sum of the rules
 * that fire. Changing a number changes orders - bump SORTER_VERSION.
 */
export const SCORE_WEIGHTS = {
  /**
   * Every POI's starting value in the distance ratio. Sets how strong the rest
   * are: a POI scoring `base` more than another is worth twice the walk.
   */
  base: 10,
  /** Per preference interest the POI is tagged with. */
  interestMatch: 10,
  /** The visitor's group type is among the POI's audiences. */
  audienceMatch: 6,
  /** Morning coffee: culinary POIs between MORNING.startMinute and endMinute local. */
  morningCulinary: 8,
  /** Sunset: viewpoints inside the golden-hour window. Deliberately dominant. */
  sunsetViewpoint: 30,
  /** Sunset, shoulder: viewpoints in the hour or so before the golden window. */
  sunsetViewpointShoulder: 15,
  /** Nature POIs (parks, the sea) in the golden-hour window. */
  sunsetNature: 8,
} as const;

/** Floor on hop distance in the ratio: co-located stops, GPS/geofence scale. */
export const MIN_HOP_METERS = 30;

/** Relative difference below which two stops' ratios count as equal (1 mm per km). */
const RATIO_TIE = 1e-6;

/** Local wall-clock minutes since midnight, [start, end). */
export const MORNING = { startMinute: 6 * 60, endMinute: 11 * 60 } as const;

/**
 * Minutes RELATIVE TO SUNSET at the stops, not clock hours: sunset in Tel Aviv
 * moves from 16:40 in December to 19:50 in June, so a fixed "17:00-20:00"
 * would miss it for half the year. Negative = after sunset.
 */
export const GOLDEN_HOUR = { fullFrom: 90, fullUntil: -20, shoulderFrom: 150 } as const;

export interface LocalTime {
  /** The absolute instant, ms since the Unix epoch. */
  instantMs: number;
  /** Minutes since local midnight, as the visitor's clock reads. */
  localMinute: number;
  /** The local calendar date. */
  year: number;
  month: number;
  day: number;
  /** Offset from UTC in minutes, east positive. */
  offsetMinutes: number;
}

const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parses "YYYY-MM-DDTHH:MM[:SS[.fff]](Z|±HH:MM)". The offset is REQUIRED: a
 * bare "18:40" cannot say whose evening it is, and guessing the server's zone
 * (UTC) would schedule every sunset boost hours early in Tel Aviv.
 */
export function parseLocalTime(value: string): LocalTime | null {
  const m = LOCAL_TIME.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as number[];
  const offsetMinutes = m[7] === 'Z' ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  if (
    month! < 1 || month! > 12 || day! < 1 || day! > 31 ||
    hour! > 23 || minute! > 59 || second! > 59 || Math.abs(offsetMinutes) > 14 * 60
  ) {
    return null;
  }
  const wallClockUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
  // Date.UTC rolls 31 Feb into March; reject rather than reinterpret.
  if (new Date(wallClockUtc).getUTCDate() !== day) return null;
  return {
    instantMs: wallClockUtc - offsetMinutes * 60_000,
    localMinute: hour! * 60 + minute!,
    year: year!,
    month: month!,
    day: day!,
    offsetMinutes,
  };
}

/** Score every POI. Exported for tests and for explaining an order. */
export function scorePois(
  pois: readonly SortablePoi[],
  preferences: SortPreferences,
  time: LocalTime,
): PoiScore[] {
  const wanted = new Set(preferences.interests ?? []);
  const inMorning = time.localMinute >= MORNING.startMinute && time.localMinute < MORNING.endMinute;

  // One sunset for the whole set: stops of a tour are a few km apart, which
  // moves sunset by seconds.
  const toSunset = minutesToSunset(pois, time);
  const golden = toSunset !== null && toSunset <= GOLDEN_HOUR.fullFrom && toSunset >= GOLDEN_HOUR.fullUntil;
  const shoulder = toSunset !== null && toSunset > GOLDEN_HOUR.fullFrom && toSunset <= GOLDEN_HOUR.shoulderFrom;

  return pois.map((p) => {
    let score = 0;
    const reasons: string[] = [];
    const add = (points: number, reason: string) => {
      score += points;
      reasons.push(reason);
    };

    const interests = p.interests ?? [];
    // Sorted so `reasons` does not depend on tag order in the database.
    for (const tag of [...new Set(interests)].sort()) {
      if (wanted.has(tag)) add(SCORE_WEIGHTS.interestMatch, `interest:${tag}`);
    }
    if (preferences.groupType && (p.audiences ?? []).includes(preferences.groupType)) {
      add(SCORE_WEIGHTS.audienceMatch, `audience:${preferences.groupType}`);
    }

    if (inMorning && interests.includes('culinary')) add(SCORE_WEIGHTS.morningCulinary, 'time:morning_culinary');
    if (p.poiType === 'viewpoint') {
      if (golden) add(SCORE_WEIGHTS.sunsetViewpoint, 'time:sunset_viewpoint');
      else if (shoulder) add(SCORE_WEIGHTS.sunsetViewpointShoulder, 'time:sunset_viewpoint_shoulder');
    }
    if (golden && interests.includes('nature')) add(SCORE_WEIGHTS.sunsetNature, 'time:sunset_nature');

    return { id: p.id, score, reasons };
  });
}

function scoredSort<T extends SortablePoi>(pois: readonly T[], preferences: SortPreferences, time: LocalTime): SortResult<T> {
  const scores = scorePois(pois, preferences, time);
  const byId = new Map(scores.map((s) => [s.id, s]));
  const scoreOf = (p: T) => (byId.get(p.id) as PoiScore).score;
  const order = (p: T) => (typeof p.orderIndex === 'number' && Number.isFinite(p.orderIndex) ? p.orderIndex : Number.POSITIVE_INFINITY);
  // Deterministic tie-break everywhere: authored order, then id (contract 1).
  const before = (a: T, b: T) => order(a) - order(b) || compareIds(a.id, b.id);

  const remaining = [...pois];
  if (remaining.length === 0) return { ordered: [], strategy: 'scored', scores: [] };

  let firstIndex: number;
  if (preferences.start) {
    firstIndex = indexOfNearest(remaining, { lat: preferences.start.lat, lng: preferences.start.lon });
  } else {
    firstIndex = remaining.reduce((best, p, i) => (before(p, remaining[best] as T) < 0 ? i : best), 0);
  }

  const ordered = remaining.splice(firstIndex, 1);
  while (remaining.length > 0) {
    const here = ordered[ordered.length - 1] as T;
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    remaining.forEach((p, i) => {
      const metres = Math.max(distanceMeters({ lat: here.lat, lng: here.lon }, { lat: p.lat, lng: p.lon }), MIN_HOP_METERS);
      const value = (SCORE_WEIGHTS.base + scoreOf(p)) / metres;
      // Within RATIO_TIE of each other is a tie, decided by authored order: a
      // matched stop at exactly twice the distance must not win or lose on
      // haversine rounding (a great circle is not linear in degrees).
      const tie = Math.abs(value - bestValue) <= RATIO_TIE * bestValue;
      if ((!tie && value > bestValue) || (tie && before(p, remaining[bestIndex] as T) < 0)) {
        bestValue = value;
        bestIndex = i;
      }
    });
    ordered.push(...remaining.splice(bestIndex, 1));
  }
  return { ordered, strategy: 'scored', scores: ordered.map((p) => byId.get(p.id) as PoiScore) };
}

// -----------------------------------------------------------------------------
// Sunset

/** Minutes from `time` to sunset at the stops' centroid; null in polar day/night. */
function minutesToSunset(pois: readonly SortablePoi[], time: LocalTime): number | null {
  if (pois.length === 0) return null;
  const lat = pois.reduce((sum, p) => sum + p.lat, 0) / pois.length;
  const lon = pois.reduce((sum, p) => sum + p.lon, 0) / pois.length;
  const sunset = sunsetUtcMs(time.year, time.month, time.day, lat, lon);
  return sunset === null ? null : (sunset - time.instantMs) / 60_000;
}

/**
 * Sunset on a calendar date at a place, as ms since the epoch - the NOAA
 * "sunrise equation" (https://en.wikipedia.org/wiki/Sunrise_equation), good to
 * a minute or two away from the poles. Includes the standard -0.833 degrees
 * for refraction and the solar disc. Null when the sun does not set or rise.
 */
export function sunsetUtcMs(year: number, month: number, day: number, lat: number, lon: number): number | null {
  const DAY_MS = 86_400_000;
  const J2000 = 2451545.0;
  const toRad = Math.PI / 180;

  // Julian day of that date's local solar noon, then the whole cycle number.
  const julianNoonUtc = Date.UTC(year, month - 1, day, 12) / DAY_MS + 2440587.5;
  const n = Math.round(julianNoonUtc - J2000 - lon / 360);
  const meanSolarNoon = n - lon / 360;

  const M = (357.5291 + 0.98560028 * meanSolarNoon) % 360;
  const C = 1.9148 * Math.sin(M * toRad) + 0.02 * Math.sin(2 * M * toRad) + 0.0003 * Math.sin(3 * M * toRad);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const transit = J2000 + meanSolarNoon + 0.0053 * Math.sin(M * toRad) - 0.0069 * Math.sin(2 * lambda * toRad);

  const sinDecl = Math.sin(lambda * toRad) * Math.sin(23.4397 * toRad);
  const cosDecl = Math.cos(Math.asin(sinDecl));
  const cosHourAngle = (Math.sin(-0.833 * toRad) - Math.sin(lat * toRad) * sinDecl) / (Math.cos(lat * toRad) * cosDecl);
  if (cosHourAngle < -1 || cosHourAngle > 1) return null;

  const set = transit + Math.acos(cosHourAngle) / toRad / 360;
  return (set - 2440587.5) * DAY_MS;
}

// -----------------------------------------------------------------------------
// Nearest neighbour

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
