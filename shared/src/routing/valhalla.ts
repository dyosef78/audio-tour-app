/**
 * TASK-701 - Valhalla `/route` client.
 *
 * Turns an ORDERED list of stops into one precision-6 encoded polyline, with its
 * length and duration. Order is the caller's: this calls `/route`, never
 * `/optimized_route`, because stop order is decided upstream (the "Smart Guide"
 * sorts by hours, scenery, food) and the route must not second-guess it.
 *
 * RUNTIME-NEUTRAL ON PURPOSE. No `node:` imports and no `process.env` - config
 * comes in as an object (see valhallaConfigFromEnv). The expected consumer is
 * the `route-stops` Edge Function, which runs on Deno, and the CMS scripts,
 * which run on Node. Both have fetch and AbortSignal.any/timeout.
 *
 * THREE THINGS THE VALHALLA RESPONSE DOES THAT ARE EASY TO GET WRONG:
 *
 *   1. There is no trip-level shape. Every `break` location starts a new leg and
 *      each leg carries its own polyline, whose first point repeats the previous
 *      leg's last. Taking legs[0].shape draws the first hop only; concatenating
 *      the strings produces garbage (each string's deltas restart from 0,0).
 *      Legs are decoded, joined without the duplicate, and re-encoded.
 *
 *   2. `length` is in the request's `units`, not metres. This asks for
 *      kilometres and still honours the response's `units` field.
 *
 *   3. The shape is precision 6. The same precision-5/6 trap documented in
 *      shared/src/polyline.ts applies - hence `precision: 6` on the result,
 *      which is what cms_set_tour_route() and the route-stops contract require.
 */

import {
  PolylineError,
  decodePolyline,
  distanceToRouteMeters,
  encodePolyline,
  type RoutePoint,
} from '../polyline.ts';
import { RoutingError, type RoutingErrorCode } from './errors.ts';

/** GeoJSON order: longitude first. The order the task, PostGIS and GeoJSON all use. */
export type LonLat = readonly [lon: number, lat: number];

export type ValhallaProfile = 'pedestrian' | 'bicycle' | 'auto';

/** The database's transit_mode (tours CHECK constraint) -> Valhalla costing. */
export const PROFILE_FOR_TRANSIT_MODE = {
  walking: 'pedestrian',
  biking: 'bicycle',
  driving: 'auto',
} as const satisfies Record<'walking' | 'biking' | 'driving', ValhallaProfile>;

const PROFILES: ReadonlySet<string> = new Set<ValhallaProfile>(['pedestrian', 'bicycle', 'auto']);

export const STADIA_ROUTE_URL = 'https://api.stadiamaps.com/route/v1';

/**
 * Inside the device's 10 s ROUTE_REQUEST_TIMEOUT_MS (DynamicRouteClient.ts),
 * leaving the Edge Function time to load stops and answer before the phone
 * gives up and a routing request we paid for is thrown away.
 */
export const DEFAULT_TIMEOUT_MS = 7_000;

/**
 * Valhalla's stock service_limits allow 20 locations for `auto` and 50 for
 * pedestrian/bicycle; hosted providers may set lower. 20 is safe for all three
 * profiles; raise it per deployment once the provider's real limit is known.
 */
export const DEFAULT_MAX_LOCATIONS = 20;

export interface ValhallaClientConfig {
  /** Full URL of the route endpoint: `https://host/route` or Stadia's `/route/v1`. */
  routeUrl: string;
  /** Sent as `api_key`. Optional for a self-hosted Valhalla. */
  apiKey?: string | undefined;
  timeoutMs?: number;
  maxLocations?: number;
  /** Injection point for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

export interface RouteOptions {
  /** Cancels the request - e.g. the Edge Function's client disconnected. */
  signal?: AbortSignal;
}

export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}

export interface ValhallaRoute {
  profile: ValhallaProfile;
  encoding: 'polyline';
  precision: 6;
  polyline: string;
  /** Whole metres. */
  distanceMeters: number;
  /** Whole seconds, Valhalla's estimate for the profile. No live traffic. */
  durationSeconds: number;
  /** One per hop: legs[i] runs from locations[i] to locations[i + 1]. */
  legs: RouteLeg[];
  /**
   * Metres from each input location to the returned line, in input order.
   * Valhalla snaps a stop to the nearest usable edge, which may be far away
   * (a viewpoint on a hill with no path to it). Not an error here - the
   * tolerance is per transit mode and belongs to routeToleranceMeters() and
   * cms_validate_tour - but a large value is also the signature of lon/lat
   * passed the wrong way round, so callers should look.
   */
  locationOffsetsMeters: number[];
}

/**
 * Build a config from environment variables. Pass `process.env` on Node or
 * `Deno.env.toObject()` in an Edge Function.
 *
 *   VALHALLA_ROUTE_URL  defaults to Stadia Maps
 *   STADIA_API_KEY      required when the URL is on stadiamaps.com
 */
export function valhallaConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ValhallaClientConfig {
  const routeUrl = env.VALHALLA_ROUTE_URL?.trim() || STADIA_ROUTE_URL;
  const apiKey = env.STADIA_API_KEY?.trim() || undefined;

  let host: string;
  try {
    const url = new URL(routeUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(url.protocol);
    host = url.hostname;
  } catch (cause) {
    throw new RoutingError('not_configured', 'VALHALLA_ROUTE_URL is not an http(s) URL.', { cause });
  }
  if (!apiKey && (host === 'stadiamaps.com' || host.endsWith('.stadiamaps.com'))) {
    throw new RoutingError('not_configured', 'STADIA_API_KEY is not set, and the routing URL is Stadia Maps.');
  }
  return { routeUrl, apiKey };
}

export class ValhallaClient {
  readonly #routeUrl: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #maxLocations: number;
  readonly #fetch: typeof fetch;

  constructor(config: ValhallaClientConfig) {
    this.#routeUrl = config.routeUrl;
    this.#apiKey = config.apiKey;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxLocations = config.maxLocations ?? DEFAULT_MAX_LOCATIONS;
    // Bound: an unbound global fetch throws "Illegal invocation" on some runtimes.
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Route through `locations` in the order given. Throws RoutingError and
   * nothing else.
   */
  async route(locations: readonly LonLat[], profile: ValhallaProfile, options: RouteOptions = {}): Promise<ValhallaRoute> {
    this.#validate(locations, profile);

    const body = {
      locations: locations.map(([lon, lat]) => ({ lon, lat, type: 'break' })),
      costing: profile,
      units: 'kilometers',
      // Maneuvers and narrative are most of the payload and we draw a line.
      directions_type: 'none',
    };

    const url = new URL(this.#routeUrl);
    if (this.#apiKey) url.searchParams.set('api_key', this.#apiKey);

    // Not AbortSignal.timeout(): Node unrefs that timer, so a CLI script with
    // nothing else pending exits mid-request and the promise never settles.
    const timeoutController = new AbortController();
    const timeout = timeoutController.signal;
    const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

    let status: number;
    let headers: Headers;
    let text: string;
    try {
      if (options.signal?.aborted) throw options.signal.reason;
      const response = await this.#fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      status = response.status;
      headers = response.headers;
      // Inside the try: the timeout covers a body that stalls mid-stream too.
      text = await response.text();
    } catch (cause) {
      // Never put `url` in a message: it carries the key.
      if (options.signal?.aborted) {
        throw new RoutingError('aborted', 'Routing request was cancelled by the caller.', { cause });
      }
      if (timeout.aborted) {
        throw new RoutingError('timeout', `Routing provider did not answer within ${this.#timeoutMs} ms.`, { cause });
      }
      throw new RoutingError('network', 'Routing provider could not be reached.', {
        detail: cause instanceof Error ? redact(cause.message, this.#apiKey) : String(cause),
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) throw httpError(status, headers, text);
    return parseTrip(text, profile, locations);
  }

  #validate(locations: readonly LonLat[], profile: ValhallaProfile): void {
    if (!PROFILES.has(profile)) {
      throw new RoutingError('invalid_request', `Unknown routing profile ${JSON.stringify(profile)}.`);
    }
    if (!Array.isArray(locations) || locations.length < 2) {
      throw new RoutingError('invalid_request', 'A route needs at least two locations.');
    }
    if (locations.length > this.#maxLocations) {
      throw new RoutingError(
        'too_many_locations',
        `${locations.length} locations exceeds the limit of ${this.#maxLocations} per request.`,
      );
    }
    locations.forEach((location, i) => {
      const isPair = Array.isArray(location) && location.length === 2;
      const [lon, lat] = isPair ? location : [];
      const ok =
        isPair &&
        Number.isFinite(lon) &&
        Number.isFinite(lat) &&
        Math.abs(lon as number) <= 180 &&
        Math.abs(lat as number) <= 90;
      if (!ok) {
        throw new RoutingError(
          'invalid_request',
          `Location ${i} is not a [lon, lat] pair in range: ${JSON.stringify(location)}.`,
        );
      }
    });
  }
}

// -----------------------------------------------------------------------------
// Errors

/**
 * Valhalla's `error_code` values that mean "these stops, this profile, no route".
 *   170 locations are in unconnected regions
 *   171 no suitable edges near location
 *   442 no path could be found for input
 *   443 exact route match algorithm failed to find path
 */
const UNROUTABLE_CODES: ReadonlySet<number> = new Set([170, 171, 442, 443]);
/** 154 path distance exceeds the max distance limit; 172 exceeded breakage distance. */
const DISTANCE_CODES: ReadonlySet<number> = new Set([154, 172]);
/** 150 exceeded max locations. */
const LOCATION_LIMIT_CODES: ReadonlySet<number> = new Set([150]);

function httpError(status: number, headers: Headers, text: string): RoutingError {
  const json = tryParseJson(text);
  const providerCode = isRecord(json) && typeof json.error_code === 'number' ? json.error_code : undefined;
  const providerMessage = isRecord(json) && typeof json.error === 'string' ? json.error : undefined;
  const detail = providerMessage ?? truncate(text);
  const base = { status, providerCode, detail };

  if (status === 429) {
    return new RoutingError('rate_limited', 'Routing provider rate limit reached.', {
      ...base,
      retryAfterMs: parseRetryAfter(headers.get('retry-after')),
    });
  }
  if (status === 401 || status === 403) {
    return new RoutingError('unauthorized', `Routing provider refused the credentials (HTTP ${status}).`, base);
  }

  let code: RoutingErrorCode = status >= 400 && status < 500 ? 'invalid_request' : 'upstream_error';
  if (providerCode !== undefined) {
    if (UNROUTABLE_CODES.has(providerCode)) code = 'unroutable';
    else if (DISTANCE_CODES.has(providerCode)) code = 'distance_exceeded';
    else if (LOCATION_LIMIT_CODES.has(providerCode)) code = 'too_many_locations';
  }
  const message =
    code === 'unroutable'
      ? 'No route connects these locations for this profile.'
      : `Routing provider answered HTTP ${status}${providerCode !== undefined ? ` (Valhalla error ${providerCode})` : ''}.`;
  return new RoutingError(code, message, base);
}

/** Seconds or an HTTP-date. Undefined when absent or unparsable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

// -----------------------------------------------------------------------------
// Response

function parseTrip(text: string, profile: ValhallaProfile, locations: readonly LonLat[]): ValhallaRoute {
  const invalid = (message: string, cause?: unknown): RoutingError =>
    new RoutingError('invalid_response', message, { detail: truncate(text), cause });

  const json = tryParseJson(text);
  const trip = isRecord(json) ? json.trip : undefined;
  if (!isRecord(trip)) throw invalid('Routing response has no trip.');
  if (trip.status !== undefined && trip.status !== 0) {
    throw invalid(`Routing trip status ${String(trip.status)}: ${String(trip.status_message ?? '')}`);
  }

  const toMeters = unitsToMeters(trip.units);
  if (toMeters === undefined) throw invalid(`Routing response uses unknown units ${JSON.stringify(trip.units)}.`);

  const rawLegs = trip.legs;
  if (!Array.isArray(rawLegs) || rawLegs.length !== locations.length - 1) {
    throw invalid(
      `Expected ${locations.length - 1} legs for ${locations.length} locations, got ${Array.isArray(rawLegs) ? rawLegs.length : 'none'}.`,
    );
  }

  const points: RoutePoint[] = [];
  const legs: RouteLeg[] = [];
  for (const [i, leg] of rawLegs.entries()) {
    if (!isRecord(leg) || typeof leg.shape !== 'string' || leg.shape === '') {
      throw invalid(`Leg ${i} has no shape.`);
    }
    let legPoints: RoutePoint[];
    try {
      legPoints = decodePolyline(leg.shape, 6);
    } catch (cause) {
      if (cause instanceof PolylineError) throw invalid(`Leg ${i} shape is not a polyline: ${cause.message}`, cause);
      throw cause;
    }
    if (legPoints.length === 0) throw invalid(`Leg ${i} shape is empty.`);
    for (const p of legPoints) {
      if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
        throw invalid(`Leg ${i} shape leaves the coordinate range - not a precision-6 polyline.`);
      }
    }

    // Exact comparison is sound: both came from dividing the same integers by 1e6.
    const last = points[points.length - 1];
    const first = legPoints[0] as RoutePoint;
    const start = last && last.lat === first.lat && last.lng === first.lng ? 1 : 0;
    for (let k = start; k < legPoints.length; k++) points.push(legPoints[k] as RoutePoint);

    const summary = leg.summary;
    if (!isRecord(summary) || !isNonNegative(summary.length) || !isNonNegative(summary.time)) {
      throw invalid(`Leg ${i} has no usable summary.`);
    }
    legs.push({ distanceMeters: Math.round(summary.length * toMeters), durationSeconds: Math.round(summary.time) });
  }

  // A route of one point can't be drawn, and cms_set_tour_route rejects it.
  if (points.length < 2) throw invalid('Routing response shape has fewer than two points.');

  const summary = trip.summary;
  if (!isRecord(summary) || !isNonNegative(summary.length) || !isNonNegative(summary.time)) {
    throw invalid('Routing trip has no usable summary.');
  }

  return {
    profile,
    encoding: 'polyline',
    precision: 6,
    polyline: encodePolyline(points, 6),
    distanceMeters: Math.round(summary.length * toMeters),
    durationSeconds: Math.round(summary.time),
    legs,
    locationOffsetsMeters: locations.map(([lng, lat]) => Math.round(distanceToRouteMeters({ lat, lng }, points))),
  };
}

function unitsToMeters(units: unknown): number | undefined {
  // Absent means the request's units, which is kilometres.
  if (units === undefined || units === 'kilometers' || units === 'km') return 1000;
  if (units === 'miles' || units === 'mi') return 1609.344;
  return undefined;
}

// -----------------------------------------------------------------------------

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Runtimes differ on whether a fetch error quotes the URL; ours carries the key. */
function redact(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join('[redacted]') : text;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
