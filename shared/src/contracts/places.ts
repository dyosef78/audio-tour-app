/**
 * Epic 16 Part 5 - places-search contract: the planner's origin search
 * (PM: Google Places Autocomplete, behind our proxy so the key never ships).
 *
 *   POST /functions/v1/places-search
 *     { action: 'autocomplete', input, session_token, city_id, language? }
 *     { action: 'details', place_id, session_token }
 *
 * SESSION TOKENS. The app makes a fresh UUID v4 when the search field gains
 * focus, sends it with every autocomplete request AND with the one details
 * request that ends the session, then discards it. Google then bills the
 * session as one Place Details call; autocomplete requests that never end in
 * details are billed one by one - which is why the proxy is rate limited.
 *
 * Runtime-neutral, no imports beyond types.
 */

export type PlacesRequest =
  | { action: 'autocomplete'; input: string; session_token: string; city_id: string; language?: string }
  | { action: 'details'; place_id: string; session_token: string };

export interface PlaceSuggestion {
  place_id: string;
  /** "Dizengoff Center" */
  primary: string;
  /** "Dizengoff St, Tel Aviv-Yafo, Israel" - null when Google gives none. */
  secondary: string | null;
}

export type PlacesOk =
  | { status: 'ok'; action: 'autocomplete'; suggestions: PlaceSuggestion[] }
  /** The chosen place as a planning origin. `label` is Google's formatted address. */
  | { status: 'ok'; action: 'details'; place_id: string; lon: number; lat: number; label: string };

export type PlacesErrorCode =
  /** 400 */
  | 'invalid_request'
  /** 404 - Google does not know the place id (expired, or forged). */
  | 'place_not_found'
  /** 429 - ours or Google's; retry_after_s set when known. */
  | 'rate_limited'
  /** 502 - Google failed or answered in a shape we do not recognise. */
  | 'upstream_error'
  /** 503 - no GOOGLE_PLACES_API_KEY, or Google refused the key. */
  | 'not_configured'
  /** 504 */
  | 'timeout'
  /** 500 */
  | 'internal';

export interface PlacesError {
  status: 'error';
  code: PlacesErrorCode;
  detail: string;
  retryable: boolean;
  retry_after_s?: number;
  request_id: string;
}

export const PLACES_INPUT_MIN = 2;
export const PLACES_INPUT_MAX = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Google place ids: URL-safe base64-ish, tens to a few hundred characters. */
const PLACE_ID = /^[A-Za-z0-9_-]{10,300}$/;
const LANGUAGE = /^[a-z]{2}(-[A-Z]{2})?$/;

export type PlacesCheck = { ok: true; request: PlacesRequest } | { ok: false; detail: string };

/** The proxy's input check - and the app's, before it spends a request. */
export function checkPlacesRequest(body: unknown): PlacesCheck {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, detail: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b.session_token !== 'string' || !UUID.test(b.session_token)) return { ok: false, detail: 'session_token must be a UUID v4' };
  if (b.action === 'autocomplete') {
    if (typeof b.input !== 'string') return { ok: false, detail: 'input is required' };
    const input = b.input.trim();
    if (input.length < PLACES_INPUT_MIN || input.length > PLACES_INPUT_MAX) return { ok: false, detail: `input must be ${PLACES_INPUT_MIN}..${PLACES_INPUT_MAX} characters` };
    if (typeof b.city_id !== 'string' || !ANY_UUID.test(b.city_id)) return { ok: false, detail: 'city_id must be a uuid' };
    if (b.language !== undefined && (typeof b.language !== 'string' || !LANGUAGE.test(b.language))) return { ok: false, detail: 'language must look like "en" or "he-IL"' };
    return {
      ok: true,
      request: { action: 'autocomplete', input, session_token: b.session_token.toLowerCase(), city_id: b.city_id.toLowerCase(), ...(typeof b.language === 'string' ? { language: b.language } : {}) },
    };
  }
  if (b.action === 'details') {
    if (typeof b.place_id !== 'string' || !PLACE_ID.test(b.place_id)) return { ok: false, detail: 'place_id is not a Google place id' };
    return { ok: true, request: { action: 'details', place_id: b.place_id, session_token: b.session_token.toLowerCase() } };
  }
  return { ok: false, detail: "action must be 'autocomplete' or 'details'" };
}
