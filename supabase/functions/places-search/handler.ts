/**
 * Epic 16 Part 5 - Edge Function `places-search`: the planner's origin search,
 * proxying Google Places API (New). Contract: shared/src/contracts/places.ts.
 *
 * WHY A PROXY (PM, 4 Oct 2026): a Places key inside the app binary is
 * extractable, and Places bills per request - a billing-fraud vector. The key
 * lives only in this function's environment (GOOGLE_PLACES_API_KEY).
 *
 * WHAT IT SPENDS, AND THE CAPS:
 *   * autocomplete -> places:autocomplete, biased to the city's centre;
 *     details -> places/{id} with field mask id,location,formattedAddress only
 *     (the cheapest Place Details tier; no displayName, no photos)
 *   * the session token is passed through on both, so a search that ends in a
 *     pick is billed as one session
 *   * rate limited per client IP and globally (its own buckets). The anon key
 *     ships in the app, so ANYONE can call this: the global bucket is the
 *     spend ceiling. A daily quota in Google Cloud is the hard backstop.
 *
 * PRIVACY: what the visitor types is never logged - only its length.
 *
 *   200 ok   400 invalid_request   404 place_not_found   429 rate_limited
 *   502 upstream_error   503 not_configured   504 timeout   500 internal
 */

import {
  checkPlacesRequest,
  type PlacesErrorCode,
  type PlacesError,
  type PlacesOk,
  type PlaceSuggestion,
} from '@shared/contracts/places.ts';
import type { RateLimiter } from '../_shared/rateLimit.ts';

export interface PlacesDeps {
  apiKey: string | null;
  requestId(): string;
  rateLimit: RateLimiter | null;
  /** [lon, lat] of a city's centre, or null for an unknown city. */
  cityCenter(cityId: string): Promise<readonly [number, number] | null>;
  fetch: typeof fetch;
  log(event: Record<string, unknown>): void;
  now(): number;
  timeoutMs?: number;
}

export const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
export const DETAILS_URL = 'https://places.googleapis.com/v1/places/';
/** Bias, not restriction: a hotel just outside the city still matches. Google's maximum is 50 km. */
export const BIAS_RADIUS_M = 30_000;
export const DETAILS_FIELD_MASK = 'id,location,formattedAddress';
export const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_SUGGESTIONS = 5;

const RETRYABLE: ReadonlySet<PlacesErrorCode> = new Set(['rate_limited', 'upstream_error', 'timeout', 'internal']);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}

function fail(status: number, code: PlacesErrorCode, detail: string, requestId: string, retryAfterS?: number): Response {
  const body: PlacesError = { status: 'error', code, detail, retryable: RETRYABLE.has(code), request_id: requestId, ...(retryAfterS !== undefined ? { retry_after_s: retryAfterS } : {}) };
  return json(status, body, retryAfterS !== undefined ? { 'Retry-After': String(retryAfterS) } : {});
}

type Upstream = { status: number; body: unknown; retryAfter: string | null } | { timeout: true } | { network: string };

async function callGoogle(deps: PlacesDeps, url: string, init: RequestInit): Promise<Upstream> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await deps.fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Not JSON: judged by status below.
    }
    return { status: res.status, body, retryAfter: res.headers.get('retry-after') };
  } catch (cause) {
    return controller.signal.aborted ? { timeout: true } : { network: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    clearTimeout(timer);
  }
}

/** Google's error -> ours. The key is never echoed. */
function upstreamFailure(u: Upstream, requestId: string, log: PlacesDeps['log'], action: string): Response {
  if ('timeout' in u) {
    log({ event: 'places_search_upstream', action, outcome: 'timeout' });
    return fail(504, 'timeout', 'Place search took too long.', requestId);
  }
  if ('network' in u) {
    log({ event: 'places_search_upstream', action, outcome: 'network' });
    return fail(502, 'upstream_error', 'Place search is unreachable.', requestId);
  }
  log({ event: 'places_search_upstream', action, outcome: 'http', status: u.status });
  if (u.status === 429) {
    const s = Number(u.retryAfter);
    return fail(429, 'rate_limited', 'Place search is busy.', requestId, Number.isFinite(s) && s > 0 ? Math.ceil(s) : 30);
  }
  if (u.status === 404) return fail(404, 'place_not_found', 'That place could not be found.', requestId);
  // 401/403: the key is wrong, restricted, or the API is not enabled - a
  // deployment problem, not the visitor's.
  if (u.status === 401 || u.status === 403) return fail(503, 'not_configured', 'Place search is not configured.', requestId);
  if (u.status === 400) return fail(400, 'invalid_request', 'Place search rejected the request.', requestId);
  return fail(502, 'upstream_error', 'Place search failed.', requestId);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOf = (v: unknown): string | null => (isObj(v) && typeof v.text === 'string' && v.text.trim() !== '' ? v.text : null);

export async function handlePlacesSearch(request: Request, deps: PlacesDeps): Promise<Response> {
  const requestId = deps.requestId();
  const started = deps.now();
  try {
    if (request.method !== 'POST') return fail(400, 'invalid_request', 'POST a places request.', requestId);
    if (!deps.apiKey) return fail(503, 'not_configured', 'Place search is not configured.', requestId);

    if (deps.rateLimit) {
      const decision = await deps.rateLimit(request);
      if (!decision.allowed) {
        deps.log({ event: 'places_search_rate_limited', scope: decision.scope });
        return fail(429, 'rate_limited', 'Too many searches; slow down.', requestId, decision.retryAfterSeconds);
      }
    }

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return fail(400, 'invalid_request', 'Body is not JSON.', requestId);
    }
    const check = checkPlacesRequest(body);
    if (!check.ok) return fail(400, 'invalid_request', check.detail, requestId);
    const req = check.request;
    const headers = { 'Content-Type': 'application/json', 'X-Goog-Api-Key': deps.apiKey };

    if (req.action === 'autocomplete') {
      const center = await deps.cityCenter(req.city_id);
      if (!center) return fail(400, 'invalid_request', 'Unknown city.', requestId);
      const u = await callGoogle(deps, AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: { ...headers, 'X-Goog-FieldMask': AUTOCOMPLETE_FIELD_MASK },
        body: JSON.stringify({
          input: req.input,
          sessionToken: req.session_token,
          locationBias: { circle: { center: { latitude: center[1], longitude: center[0] }, radius: BIAS_RADIUS_M } },
          ...(req.language ? { languageCode: req.language } : {}),
        }),
      });
      if (!('status' in u) || u.status !== 200) return upstreamFailure(u, requestId, deps.log, 'autocomplete');
      if (!isObj(u.body)) return upstreamFailure({ status: 502, body: null, retryAfter: null }, requestId, deps.log, 'autocomplete');
      const raw = Array.isArray(u.body.suggestions) ? u.body.suggestions : [];
      const suggestions: PlaceSuggestion[] = [];
      for (const s of raw) {
        // Query predictions ("pizza near me") have no placeId and cannot be an origin.
        const p = isObj(s) && isObj(s.placePrediction) ? s.placePrediction : null;
        if (!p || typeof p.placeId !== 'string') continue;
        const fmt = isObj(p.structuredFormat) ? p.structuredFormat : null;
        const primary = textOf(fmt?.mainText) ?? textOf(p.text);
        if (!primary) continue;
        suggestions.push({ place_id: p.placeId, primary, secondary: textOf(fmt?.secondaryText) });
        if (suggestions.length === MAX_SUGGESTIONS) break;
      }
      deps.log({ event: 'places_search_ok', action: 'autocomplete', input_length: req.input.length, results: suggestions.length, ms: deps.now() - started });
      const ok: PlacesOk = { status: 'ok', action: 'autocomplete', suggestions };
      return json(200, ok);
    }

    const url = `${DETAILS_URL}${encodeURIComponent(req.place_id)}?sessionToken=${encodeURIComponent(req.session_token)}`;
    const u = await callGoogle(deps, url, { method: 'GET', headers: { ...headers, 'X-Goog-FieldMask': DETAILS_FIELD_MASK } });
    if (!('status' in u) || u.status !== 200) return upstreamFailure(u, requestId, deps.log, 'details');
    const b = u.body;
    const loc = isObj(b) && isObj(b.location) ? b.location : null;
    const lat = loc?.latitude;
    const lon = loc?.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return upstreamFailure({ status: 502, body: null, retryAfter: null }, requestId, deps.log, 'details');
    }
    const label = isObj(b) && typeof b.formattedAddress === 'string' ? b.formattedAddress : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    deps.log({ event: 'places_search_ok', action: 'details', ms: deps.now() - started });
    const ok: PlacesOk = { status: 'ok', action: 'details', place_id: req.place_id, lon, lat, label };
    return json(200, ok);
  } catch (cause) {
    deps.log({ event: 'places_search_internal_error', request_id: requestId, message: cause instanceof Error ? cause.message : String(cause) });
    return fail(500, 'internal', 'Place search failed; see the server log for this request_id.', requestId);
  }
}
