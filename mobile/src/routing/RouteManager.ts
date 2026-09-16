import type { EncodedRoute, LatLng, TransitMode, Waypoint } from '../types/domain';
import {
  decideRoute,
  MAX_FETCH_ATTEMPTS,
  RETRY_DELAYS_MS,
  routeCacheKey,
  type DynamicRouteRequest,
  type DynamicRouteResult,
  type FetchState,
  type RouteDisplay,
} from './routeDecision';
import { decodeRoute } from './routeGeometry';
import { adoptableStopOrder } from './routeRequest';

/**
 * RouteManager - keeps the map's route right as connectivity comes and goes
 * (TASK-604, hybrid offline-first).
 *
 * Owns no hardware and imports nothing native: network, fetcher, cache,
 * timers and the store are injected, so every transition below is exercised by
 * `npm run test:ui` without a device. session/routing.ts wires the real ones.
 *
 * LIFECYCLE, per tour session:
 *
 *   start()   publishes the best route available RIGHT NOW (static or
 *             straight) synchronously, so the first map frame is never empty;
 *             then reads the disk cache; then fetches if everything allows.
 *   network   offline -> online   retries a failed or dropped request at once
 *             online -> offline   aborts an in-flight request; the displayed
 *                                 route does not change
 *   stop()    aborts, unsubscribes, cancels timers, and discards any late
 *             result from the session that just ended.
 *
 * VISITING ORDER (TASK-902): a live route arrives with the order it visits the
 * stops. That order goes to `onStopOrder` only together with a route that
 * validated, so the geofences are never sequenced by a route that is not drawn.
 * A route read from the disk cache carries no order (TASK-903) and leaves
 * narration on the authored order.
 */

export interface RouteNetwork {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface RouteCacheStore {
  get(key: string): Promise<EncodedRoute | null>;
  set(key: string, route: EncodedRoute): Promise<void>;
}

export interface RouteManagerDeps {
  network: RouteNetwork;
  fetchRoute(request: DynamicRouteRequest, signal: AbortSignal): Promise<DynamicRouteResult>;
  cache: RouteCacheStore;
  publish(route: RouteDisplay): void;
  /** Returns a cancel function. */
  schedule(fn: () => void, delayMs: number): () => void;
  log?(message: string): void;
}

export interface RouteSessionContext {
  tourId: string;
  transitMode: TransitMode;
  /** The ACTIVE stops, in sort order. */
  stops: Waypoint[];
  filtered: boolean;
  /** The bundle's route, already validated against `stops`. */
  staticRoute: LatLng[] | null;
  bundleHash: string | null;
  /**
   * The order the drawn live route visits `stops`, already checked to be
   * exactly a reordering of them. Called at most once per live route.
   */
  onStopOrder?(waypointIds: string[]): void;
}

export class RouteManager {
  private readonly deps: RouteManagerDeps;

  private ctx: RouteSessionContext | null = null;
  /** Bumped on every start/stop; a result from an older generation is ignored. */
  private generation = 0;

  private dynamicRoute: LatLng[] | null = null;
  private fetchState: FetchState = 'idle';
  private attempts = 0;
  private cacheChecked = false;
  private inFlight: AbortController | null = null;

  private unsubscribe: (() => void) | null = null;
  private cancelRetry: (() => void) | null = null;
  private lastPublished: string | null = null;

  constructor(deps: RouteManagerDeps) {
    this.deps = deps;
  }

  async start(ctx: RouteSessionContext): Promise<void> {
    this.stop();
    const generation = this.generation;
    this.ctx = ctx;

    const key = this.cacheKey();
    // Nothing to look up: allow a fetch decision immediately.
    this.cacheChecked = !ctx.filtered || key === null;

    this.apply();
    this.unsubscribe = this.deps.network.subscribe((online) => this.onNetwork(online));

    if (this.cacheChecked || key === null) return;

    let cached: EncodedRoute | null = null;
    try {
      cached = await this.deps.cache.get(key);
    } catch {
      cached = null;
    }
    if (generation !== this.generation) return;

    if (cached) {
      // Re-validated even from our own cache: cheap, and it keeps "every route
      // is checked before it is drawn" free of exceptions.
      const checked = decodeRoute(cached, ctx.stops, ctx.transitMode);
      if (checked.ok) {
        this.dynamicRoute = checked.points;
        this.log('using a cached route for the selected stops');
      }
    }
    this.cacheChecked = true;
    this.apply();
  }

  stop(): void {
    this.generation++;
    const inFlight = this.inFlight;
    this.inFlight = null;
    inFlight?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelRetry?.();
    this.cancelRetry = null;
    this.ctx = null;
    this.dynamicRoute = null;
    this.fetchState = 'idle';
    this.attempts = 0;
    this.cacheChecked = false;
    this.lastPublished = null;
  }

  // ---------------------------------------------------------------------------

  private onNetwork(online: boolean): void {
    if (!this.ctx) return;

    if (!online && this.inFlight) {
      this.log('connection lost; abandoning the route request');
      const controller = this.inFlight;
      this.inFlight = null;
      controller.abort();
    }

    // A reconnect is the best moment to retry: the likeliest cause of the last
    // failure was the connection itself. Skip the backoff.
    if (online && this.fetchState === 'failed') {
      this.cancelRetry?.();
      this.cancelRetry = null;
      this.fetchState = 'idle';
    }

    this.apply();
  }

  private apply(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const decision = decideRoute({
      filtered: ctx.filtered,
      staticRoute: ctx.staticRoute,
      dynamicRoute: this.dynamicRoute,
      online: this.deps.network.isOnline(),
      fetchState: this.fetchState,
      attempts: this.attempts,
      cacheChecked: this.cacheChecked,
    });

    // One session has at most one route per source, so source + length
    // identifies what is on screen and spares the store redundant writes.
    const signature = `${decision.source}:${decision.points?.length ?? 0}`;
    if (signature !== this.lastPublished) {
      this.lastPublished = signature;
      this.deps.publish({ source: decision.source, points: decision.points });
    }

    if (decision.shouldFetch) void this.fetch(ctx);
  }

  private async fetch(ctx: RouteSessionContext): Promise<void> {
    const generation = this.generation;
    const controller = new AbortController();
    this.inFlight = controller;
    this.fetchState = 'in_flight';
    const attempt = ++this.attempts;
    this.log(`requesting a route through ${ctx.stops.length} stops (attempt ${attempt})`);

    let result: DynamicRouteResult;
    try {
      result = await this.deps.fetchRoute(
        { tourId: ctx.tourId, waypointIds: ctx.stops.map((s) => s.id), transitMode: ctx.transitMode },
        controller.signal,
      );
    } catch (err) {
      result = { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }

    // The session ended or restarted while we waited.
    if (generation !== this.generation || this.ctx !== ctx) return;
    if (this.inFlight === controller) this.inFlight = null;

    if (controller.signal.aborted) {
      // We cancelled it because the connection dropped. That is not the
      // endpoint's failure, so it does not spend one of the session's attempts.
      this.attempts = attempt - 1;
      this.fetchState = 'idle';
      this.apply();
      return;
    }

    if (result.kind === 'ok') {
      const checked = decodeRoute(result.route, ctx.stops, ctx.transitMode);
      if (checked.ok) {
        this.dynamicRoute = checked.points;
        this.fetchState = 'idle';
        const key = this.cacheKey();
        if (key) void this.deps.cache.set(key, result.route).catch(() => undefined);
        this.log('using a live route for the selected stops');
        this.adoptOrder(ctx, result.waypointIds);
        this.apply();
        return;
      }
      // The server answered, but with a route that does not reach the stops.
      // Asking again would get the same route, so stop asking this session.
      result = { kind: 'unavailable', reason: `rejected the returned route: ${checked.reason}` };
    }

    if (result.kind === 'unavailable') {
      this.fetchState = 'unavailable';
      this.log(`no live route this session: ${result.reason}`);
      this.apply();
      return;
    }

    this.fetchState = 'failed';
    this.log(`route request failed: ${result.reason}`);
    this.scheduleRetry(attempt);
    this.apply();
  }

  /**
   * An order that is not exactly the session's stops is dropped, not the
   * route: the line on the map is still right, and narration falls back to the
   * authored order rather than arming stops the session does not run.
   */
  private adoptOrder(ctx: RouteSessionContext, order: string[] | null): void {
    if (order === null) {
      this.log('live route carried no visiting order; narration keeps the authored order');
      return;
    }
    const adopted = adoptableStopOrder(order, ctx.stops);
    if (adopted === null) {
      this.log(`ignored a visiting order that does not match the ${ctx.stops.length} selected stops`);
      return;
    }
    ctx.onStopOrder?.(adopted);
  }

  private scheduleRetry(attempt: number): void {
    if (attempt >= MAX_FETCH_ATTEMPTS) {
      this.log('giving up on a live route for this session');
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ?? 20_000;
    const generation = this.generation;

    this.cancelRetry?.();
    this.cancelRetry = this.deps.schedule(() => {
      this.cancelRetry = null;
      if (generation !== this.generation) return;
      if (this.fetchState === 'failed') this.fetchState = 'idle';
      // Offline now? Then nothing happens here, and the reconnect fetches.
      this.apply();
    }, delay);
  }

  private cacheKey(): string | null {
    const ctx = this.ctx;
    if (!ctx || !ctx.filtered) return null;
    return routeCacheKey(ctx.tourId, ctx.bundleHash, ctx.stops.map((s) => s.id));
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
