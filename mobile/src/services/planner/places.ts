import { checkPlacesRequest, type PlaceSuggestion, type PlacesRequest } from '../../../../shared/src/contracts/places.ts';

/**
 * Origin search for the planner (Epic 16 final slice): a client for the
 * places-search proxy, and PlacesSession - the framework-free state machine
 * behind the search field. The React hook (usePlacesSearch) only subscribes.
 *
 * What PlacesSession owns, because each is a way to leak state or money when
 * the visitor types fast, picks, backgrounds the app or leaves the screen:
 *
 *   ONE SESSION TOKEN per search, created lazily on the first query, ended by
 *   the details call (Google bills the session as one Place Details), then
 *   ROTATED - reusing it would make the next search bill per keystroke.
 *   A token idle past SESSION_IDLE_MS is rotated too (Google sessions are
 *   short-lived; a stale token silently degrades to per-request billing).
 *
 *   DEBOUNCE (300 ms) and a minimum length: most keystrokes never leave the phone.
 *
 *   LATEST WINS: every request carries a sequence number and its own
 *   AbortController; a slower, older answer can never overwrite a newer one.
 *
 *   A PER-SESSION CAP (MAX_REQUESTS_PER_SESSION): past it, the field asks the
 *   visitor to pick or refine instead of spending more.
 *
 *   dispose(): aborts in-flight requests, clears the debounce timer, and
 *   silences every later callback - the screen unmounting can never receive a
 *   stale result or set an origin afterwards. An abandoned session's
 *   autocomplete calls are billed one by one: a cost, not a correctness bug,
 *   and bounded by the cap.
 */

export const DEBOUNCE_MS = 300;
export const MIN_QUERY = 3;
export const MAX_REQUESTS_PER_SESSION = 20;
export const SESSION_IDLE_MS = 3 * 60 * 1000;
const TIMEOUT_MS = 6_000;

export type PlacesCallResult<T> = { ok: true; value: T } | { ok: false; code: string; retryable: boolean };

export interface PlacesClient {
  autocomplete(input: string, sessionToken: string, cityId: string, signal: AbortSignal): Promise<PlacesCallResult<PlaceSuggestion[]>>;
  details(placeId: string, sessionToken: string, signal: AbortSignal): Promise<PlacesCallResult<{ lon: number; lat: number; label: string }>>;
}

export interface PlacesClientDeps {
  baseUrl: string;
  anonKey: string;
  accessToken(): Promise<string | null>;
  fetch?: typeof fetch;
}

/** Pure: the proxy over fetch, every response shape-checked. */
export function createPlacesClient(deps: PlacesClientDeps): PlacesClient {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  async function post(body: PlacesRequest, signal: AbortSignal): Promise<PlacesCallResult<Record<string, unknown>>> {
    const check = checkPlacesRequest(body);
    if (!check.ok) return { ok: false, code: 'invalid_request', retryable: false };
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    signal.addEventListener('abort', onAbort);
    try {
      const token = await deps.accessToken();
      const res = await doFetch(`${deps.baseUrl}/functions/v1/places-search`, {
        method: 'POST',
        headers: { apikey: deps.anonKey, Authorization: `Bearer ${token ?? deps.anonKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(check.request),
        signal: timeout.signal,
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.status === 200 && json?.status === 'ok') return { ok: true, value: json };
      const code = typeof json?.code === 'string' ? json.code : `http_${res.status}`;
      return { ok: false, code, retryable: json?.retryable === true || res.status >= 500 };
    } catch {
      return { ok: false, code: signal.aborted ? 'aborted' : timeout.signal.aborted ? 'timeout' : 'network', retryable: true };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  return {
    async autocomplete(input, sessionToken, cityId, signal) {
      const r = await post({ action: 'autocomplete', input, session_token: sessionToken, city_id: cityId }, signal);
      if (!r.ok) return r;
      const list = Array.isArray(r.value.suggestions) ? r.value.suggestions : null;
      const ok = list?.every((s) => isObj(s) && typeof s.place_id === 'string' && typeof s.primary === 'string' && (s.secondary === null || typeof s.secondary === 'string'));
      return ok ? { ok: true, value: list as PlaceSuggestion[] } : { ok: false, code: 'bad_response', retryable: false };
    },
    async details(placeId, sessionToken, signal) {
      const r = await post({ action: 'details', place_id: placeId, session_token: sessionToken }, signal);
      if (!r.ok) return r;
      const { lon, lat, label } = r.value;
      return typeof lon === 'number' && typeof lat === 'number' && typeof label === 'string' && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
        ? { ok: true, value: { lon, lat, label } }
        : { ok: false, code: 'bad_response', retryable: false };
    },
  };
}

export type PlacesStatus = 'idle' | 'searching' | 'results' | 'empty' | 'refine' | 'error' | 'resolving';

export interface PlacesView {
  query: string;
  suggestions: readonly PlaceSuggestion[];
  status: PlacesStatus;
  /** Machine code of the last failure, for the copy. */
  error: string | null;
}

export interface PlacesSessionDeps {
  client: PlacesClient;
  cityId: string;
  uuid(): string;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The pick, resolved to coordinates. Never called after dispose(). */
  onSelected(origin: { lon: number; lat: number; label: string }): void;
}

export class PlacesSession {
  #view: PlacesView = { query: '', suggestions: [], status: 'idle', error: null };
  #listeners = new Set<() => void>();
  #token: string | null = null;
  #tokenUsedAt = 0;
  #requests = 0;
  #seq = 0;
  #inflight: AbortController | null = null;
  #timer: unknown = null;
  #disposed = false;

  readonly #deps: PlacesSessionDeps;

  constructor(deps: PlacesSessionDeps) {
    this.#deps = deps;
  }

  get view(): PlacesView {
    return this.#view;
  }
  /** Diagnostics for tests: the token the next request would carry. */
  get token(): string | null {
    return this.#token;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setQuery(text: string): void {
    if (this.#disposed) return;
    this.#cancelPending();
    const query = text;
    if (query.trim().length < MIN_QUERY) {
      this.#set({ query, suggestions: [], status: 'idle', error: null });
      return;
    }
    if (this.#requests >= MAX_REQUESTS_PER_SESSION) {
      this.#set({ ...this.#view, query, status: 'refine' });
      return;
    }
    this.#set({ ...this.#view, query, status: 'searching', error: null });
    this.#timer = this.#deps.setTimeout(() => {
      this.#timer = null;
      void this.#search(query.trim());
    }, DEBOUNCE_MS);
  }

  async select(s: PlaceSuggestion): Promise<void> {
    if (this.#disposed) return;
    this.#cancelPending();
    const token = this.#sessionToken();
    const seq = ++this.#seq;
    const ctrl = new AbortController();
    this.#inflight = ctrl;
    this.#set({ ...this.#view, status: 'resolving', error: null });
    const r = await this.#deps.client.details(s.place_id, token, ctrl.signal);
    if (this.#disposed || seq !== this.#seq) return;
    this.#inflight = null;
    // The details call ENDS the billing session, success or not: never reuse the token.
    this.#rotate();
    if (!r.ok) {
      this.#set({ ...this.#view, status: 'error', error: r.code });
      return;
    }
    this.#set({ query: r.value.label, suggestions: [], status: 'idle', error: null });
    this.#deps.onSelected(r.value);
  }

  /** The screen is going away: abort everything, silence everything. */
  dispose(): void {
    this.#disposed = true;
    this.#cancelPending();
    this.#listeners.clear();
  }

  async #search(input: string): Promise<void> {
    const token = this.#sessionToken();
    const seq = ++this.#seq;
    const ctrl = new AbortController();
    this.#inflight = ctrl;
    this.#requests++;
    const r = await this.#deps.client.autocomplete(input, token, this.#deps.cityId, ctrl.signal);
    // Latest wins: an older answer arriving late is dropped.
    if (this.#disposed || seq !== this.#seq) return;
    this.#inflight = null;
    if (!r.ok) {
      if (r.code !== 'aborted') this.#set({ ...this.#view, status: 'error', error: r.code });
      return;
    }
    this.#set({ ...this.#view, suggestions: r.value, status: r.value.length === 0 ? 'empty' : 'results', error: null });
  }

  #sessionToken(): string {
    const now = this.#deps.now();
    if (this.#token === null || now - this.#tokenUsedAt > SESSION_IDLE_MS) this.#rotate();
    this.#tokenUsedAt = now;
    return this.#token!;
  }

  #rotate(): void {
    this.#token = this.#deps.uuid();
    this.#tokenUsedAt = this.#deps.now();
    this.#requests = 0;
  }

  #cancelPending(): void {
    if (this.#timer !== null) {
      this.#deps.clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#inflight?.abort();
    this.#inflight = null;
    this.#seq++;
  }

  #set(next: PlacesView): void {
    this.#view = next;
    for (const l of [...this.#listeners]) l();
  }
}
