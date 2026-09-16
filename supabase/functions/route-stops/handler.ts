/**
 * TASK-702 - route-stops request handling, free of Deno and Supabase globals.
 *
 * index.ts wires the real database, Valhalla client and cache; the tests inject
 * fakes. Everything that decides a status code is in this file.
 *
 * CONTRACT (extends the one in mobile/src/services/routing/DynamicRouteClient.ts)
 *
 *   POST { "tour_id": uuid,
 *          "waypoint_ids": [uuid, ...],          2..MAX_STOPS, unique
 *          "transit_mode"?: "walking" | "biking" | "driving",
 *          "preferences"?: { "group_type"?: string, "interests"?: string[],
 *                            "start"?: { "lon": number, "lat": number } } }
 *
 *   200  { "encoding": "polyline", "precision": 6, "polyline": "...",
 *          "length_meters": int, "duration_seconds": int,
 *          "legs": [{ "length_meters", "duration_seconds" }],
 *          "waypoint_ids": [uuid, ...],           THE ORDER ROUTED - see smartSorter.ts
 *          "sort_strategy": "order_index" | "nearest_neighbour", "sorter_version": "v1" }
 *
 *   400  malformed body, a stop not in the tour, transit_mode not the tour's
 *   404  tour not visible to the caller (unpublished, or no such id)
 *   405  not POST
 *   422  Valhalla cannot route these stops (unroutable, too far, too many)
 *   429  provider rate limit; Retry-After passed through
 *   500  database lookup failed
 *   501  routing not configured, or the provider rejected our key
 *   502  provider unreachable, 5xx, or an unusable response
 *   504  provider timeout
 *
 * The app treats 404 and 501 as "unavailable, stop asking" and anything else as
 * retryable, so a 501 for a bad key is deliberate: retrying cannot fix it.
 *
 * AUTHORISATION is the database's: loadTour runs get_tour_bundle AS THE CALLER,
 * so RLS decides which stops exist (published tours for everyone, drafts for CMS
 * admins). The lookup runs BEFORE the cache, so a cached route is never served
 * to a caller who could not see the tour.
 */

import { PROFILE_FOR_TRANSIT_MODE, type LonLat, type RoutingError, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';

import { RouteMemoryCache, routeCacheKey, routeEtag } from './routeCache.ts';
import { SORTER_VERSION, smartSort, type SortablePoi, type SortPreferences } from './smartSorter.ts';

/** Matches DEFAULT_MAX_LOCATIONS; also bounds the work a single anonymous request can cause. */
export const MAX_STOPS = 20;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PREFERENCE_ITEMS = 32;

type TransitMode = keyof typeof PROFILE_FOR_TRANSIT_MODE;

export interface Router {
  route(locations: readonly LonLat[], profile: ValhallaProfile): Promise<ValhallaRoute>;
}

export interface RouteStopsDeps {
  /** get_tour_bundle as the caller. null = not visible. Throws on a database failure. */
  loadTour: ((tourId: string, request: Request) => Promise<unknown>) | null;
  /** null = routing not configured; carries the reason for the log. */
  router: Router | null;
  routerUnavailableReason?: string;
  cache: RouteMemoryCache;
  log?: (event: Record<string, unknown>) => void;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handleRouteStops(request: Request, deps: RouteStopsDeps): Promise<Response> {
  const log = deps.log ?? ((event) => console.log(JSON.stringify(event)));

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') {
    return error(405, 'method_not_allowed', 'Use POST.', { Allow: 'POST, OPTIONS' });
  }

  if (!deps.router || !deps.loadTour) {
    log({ event: 'route_stops_not_configured', reason: deps.routerUnavailableReason ?? 'database client missing' });
    return error(501, 'routing_not_configured', 'Routing is not configured on this server.');
  }

  const parsed = await parseRequest(request);
  if (!parsed.ok) return error(400, 'invalid_request', parsed.message);
  const body = parsed.value;

  let bundle: unknown;
  try {
    bundle = await deps.loadTour(body.tourId, request);
  } catch (cause) {
    log({ event: 'route_stops_lookup_failed', tour_id: body.tourId, message: String(cause) });
    return error(500, 'tour_lookup_failed', 'Could not load the tour.');
  }
  const tour = parseBundle(bundle);
  if (!tour) return error(404, 'tour_not_found', 'No such tour, or it is not published.');

  if (body.transitMode && body.transitMode !== tour.transitMode) {
    return error(400, 'transit_mode_mismatch', `This tour is a ${tour.transitMode} tour, not ${body.transitMode}.`);
  }

  const byId = new Map(tour.stops.map((s) => [s.id, s]));
  const unknown = body.waypointIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return error(400, 'unknown_waypoint', `Not stops of this tour: ${unknown.join(', ')}.`);
  }

  const { ordered, strategy } = smartSort(
    body.waypointIds.map((id) => byId.get(id) as SortablePoi),
    body.preferences,
  );
  const locations: LonLat[] = ordered.map((s) => [s.lon, s.lat]);
  const profile = PROFILE_FOR_TRANSIT_MODE[tour.transitMode];
  const key = routeCacheKey(profile, locations);

  // Not the request's signal: other requests may join this computation, and a
  // result that lands after this caller hung up still serves their retry.
  const router = deps.router;
  const { outcome, hit } = await deps.cache.getOrCompute(key, () => router.route(locations, profile));
  const cacheHeader = { 'X-Route-Cache': hit ? 'hit' : 'miss' };

  if (!outcome.ok) {
    log({
      event: 'route_stops_routing_failed',
      tour_id: body.tourId,
      code: outcome.error.code,
      status: outcome.error.status,
      provider_code: outcome.error.providerCode,
      detail: outcome.error.detail,
      cache: cacheHeader['X-Route-Cache'],
    });
    return routingError(outcome.error, cacheHeader);
  }

  const route = outcome.route;
  return json(
    200,
    {
      encoding: route.encoding,
      precision: route.precision,
      polyline: route.polyline,
      length_meters: route.distanceMeters,
      duration_seconds: route.durationSeconds,
      legs: route.legs.map((l) => ({ length_meters: l.distanceMeters, duration_seconds: l.durationSeconds })),
      waypoint_ids: ordered.map((s) => s.id),
      sort_strategy: strategy,
      sorter_version: SORTER_VERSION,
    },
    {
      ...cacheHeader,
      // `private`, never `public`: every tour's request is a POST to this same
      // URL, so a shared cache that did store it would hand one tour's route
      // to every other. The device may keep it for a day.
      'Cache-Control': 'private, max-age=86400',
      ETag: await routeEtag(key),
    },
  );
}

// -----------------------------------------------------------------------------
// Request

interface RouteStopsRequest {
  tourId: string;
  waypointIds: string[];
  transitMode: TransitMode | undefined;
  preferences: SortPreferences;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function parseRequest(request: Request): Promise<Parsed<RouteStopsRequest>> {
  const fail = (message: string): Parsed<RouteStopsRequest> => ({ ok: false, message });

  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail('Body could not be read.');
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail('Body too large.');

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('Body is not JSON.');
  }
  if (!isRecord(raw)) return fail('Body must be a JSON object.');

  if (typeof raw.tour_id !== 'string' || !UUID.test(raw.tour_id)) return fail('tour_id must be a uuid.');

  const ids = raw.waypoint_ids;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_STOPS) {
    return fail(`waypoint_ids must be an array of 2 to ${MAX_STOPS} uuids.`);
  }
  if (!ids.every((id): id is string => typeof id === 'string' && UUID.test(id))) {
    return fail('waypoint_ids must contain only uuids.');
  }
  const waypointIds = ids.map((id) => id.toLowerCase());
  if (new Set(waypointIds).size !== waypointIds.length) return fail('waypoint_ids must not repeat.');

  let transitMode: TransitMode | undefined;
  if (raw.transit_mode !== undefined) {
    if (typeof raw.transit_mode !== 'string' || !Object.hasOwn(PROFILE_FOR_TRANSIT_MODE, raw.transit_mode)) {
      return fail('transit_mode must be walking, biking or driving.');
    }
    transitMode = raw.transit_mode as TransitMode;
  }

  const preferences: SortPreferences = {};
  const prefs = raw.preferences;
  if (prefs !== undefined && prefs !== null) {
    if (!isRecord(prefs)) return fail('preferences must be an object.');
    if (prefs.group_type !== undefined) {
      if (typeof prefs.group_type !== 'string' || prefs.group_type.length > 64) return fail('preferences.group_type must be a short string.');
      preferences.groupType = prefs.group_type;
    }
    if (prefs.interests !== undefined) {
      const interests = prefs.interests;
      if (
        !Array.isArray(interests) ||
        interests.length > MAX_PREFERENCE_ITEMS ||
        !interests.every((i) => typeof i === 'string' && i.length <= 64)
      ) {
        return fail('preferences.interests must be an array of short strings.');
      }
      preferences.interests = interests as string[];
    }
    if (prefs.start !== undefined) {
      const s = prefs.start;
      if (
        !isRecord(s) ||
        typeof s.lon !== 'number' || typeof s.lat !== 'number' ||
        !(Math.abs(s.lon) <= 180) || !(Math.abs(s.lat) <= 90)
      ) {
        return fail('preferences.start must be { lon, lat } in range.');
      }
      preferences.start = { lon: s.lon, lat: s.lat };
    }
  }

  return { ok: true, value: { tourId: raw.tour_id.toLowerCase(), waypointIds, transitMode, preferences } };
}

// -----------------------------------------------------------------------------
// get_tour_bundle -> stops

interface TourStops {
  transitMode: TransitMode;
  stops: SortablePoi[];
}

/** Null for anything that is not a bundle of a visible tour. */
export function parseBundle(bundle: unknown): TourStops | null {
  if (!isRecord(bundle) || !isRecord(bundle.tour_metadata) || !Array.isArray(bundle.waypoints)) return null;
  const mode = bundle.tour_metadata.transit_mode;
  if (typeof mode !== 'string' || !Object.hasOwn(PROFILE_FOR_TRANSIT_MODE, mode)) return null;

  const stops: SortablePoi[] = [];
  for (const w of bundle.waypoints) {
    if (!isRecord(w) || typeof w.waypoint_id !== 'string' || !Array.isArray(w.coordinates)) continue;
    const [lon, lat] = w.coordinates;
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    stops.push({
      id: w.waypoint_id.toLowerCase(),
      lon,
      lat,
      orderIndex: typeof w.sort_order === 'number' ? w.sort_order : null,
      poiType: typeof w.poi_type === 'string' ? w.poi_type : null,
      audiences: stringArray(w.audiences),
      interests: stringArray(w.interests),
    });
  }
  return { transitMode: mode as TransitMode, stops };
}

// -----------------------------------------------------------------------------
// Responses

function routingError(e: RoutingError, headers: Record<string, string>): Response {
  switch (e.code) {
    case 'unroutable':
    case 'distance_exceeded':
    case 'too_many_locations':
      return error(422, e.code, e.message, headers);
    case 'rate_limited': {
      const withRetry: Record<string, string> = { ...headers };
      if (e.retryAfterMs !== undefined) withRetry['Retry-After'] = String(Math.ceil(e.retryAfterMs / 1000));
      return error(429, e.code, 'Routing is busy; try again later.', withRetry);
    }
    case 'not_configured':
    case 'unauthorized':
      return error(501, 'routing_not_configured', 'Routing is not configured on this server.', headers);
    case 'timeout':
      return error(504, e.code, 'Routing provider timed out.', headers);
    case 'invalid_request':
      // Our request was wrong, not the caller's: every input was validated first.
      return error(502, 'routing_rejected', 'Routing provider rejected the request.', headers);
    default:
      return error(502, e.code, 'Routing provider failed.', headers);
  }
}

function error(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: code, message }, { 'Cache-Control': 'no-store', ...headers });
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...headers },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
