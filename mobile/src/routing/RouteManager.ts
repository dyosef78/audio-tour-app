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
  type RoutePreferences,
} from './routeDecision';
import { decodeRoute } from './routeGeometry';
import { adoptableStopOrder, predictStopOrder } from './routeRequest';

/**
 * RouteManager - keeps the map's route right as connectivity comes and goes
 * (TASK-604, hybrid offline-first).
 *
 * Owns no hardware and imports nothing native: network, fetcher, cache, clock,
 * timers and the store are injected, so every transition below is exercised by
 * `npm run test:ui` without a device. session/routing.ts wires the real ones.
 *
 * LIFECYCLE, per tour session:
 *
 *   start()   publishes the best route available RIGHT NOW (static or
 *             straight) synchronously, so the first map frame is never empty;
 *             then reads the disk cache; then fetches whenever online - every
 *             session, filtered or not (TASK-903) - until one live route
 *             arrives.
 *   network   offline -> online   retries a failed or dropped request at once
 *             online -> offline   aborts an in-flight request; the displayed
 *                                 route does not change
 *   stop()    aborts, unsubscribes, cancels timers, and discards any late
 *             result from the session that just ended.
 *
 * VISITING ORDER (TASK-902/903): whatever route is drawn, `onStopOrder`
 * receives the order it visits the stops, so the geofences are sequenced by
 * the line on the map and never by a route that is not drawn.
 *
 *   live     the response's `waypoint_ids`, once the route validates. Written
 *            to the cache under THAT order.
 *   cached   the device cannot know the server's order before asking, so it
 *            predicts it with the same Smart Sorter (shared/src/smartSorter.ts)
 *            and looks up that order's key. A hit is a route for exactly that
 *            order. A miss - a new time window, preferences changed, a server
 *            on a newer sorter - costs only the cached route: the static
 *            route and the authored order stay until the live answer.
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
  /** The device's wall clock with its UTC offset - deviceLocalTime() in the app. */
  localTime(): string;
  /** Returns a cancel function. */
  schedule(fn: () => void, delayMs: number): () => void;
  log?(message: string): void;
}

export interface RouteSessionContext {
  tourId: string;
  transitMode: TransitMode;
  /** The ACTIVE stops, in sort order. */
  stops: Waypoint[];
  /** Onboarding answers, snapshotted with the stop selection. Null = not onboarded. */
  preferences: RoutePreferences | null;
  /** The bundle's route, already validated against `stops`. */
  staticRoute: LatLng[] | null;
  bundleHash: string | null;
  /**
   * The order the drawn dynamic route visits `stops`, already checked to be
   * exactly a reordering of them. Called once per dynamic route drawn.
   */
  onStopOrder?(waypointIds: string[]): void;
}

export class RouteManager {
  private readonly deps: RouteManagerDeps;

  private ctx: RouteSessionContext | null = null;
  /** Bumped on every start/stop; a result from an older generation is ignored. */
  private generation = 0;

  private dynamicRoute: LatLng[] | null = null;
  /** Bumped per dynamic route, so a live route replacing a cached one is published. */
  private dynamicRevision = 0;
  private liveRouteReceived = false;
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

    const predicted = ctx.bundleHash
      ? predictStopOrder(ctx.stops, ctx.preferences, this.deps.localTime())
      : null;
    const key = predicted ? routeCacheKey(ctx.tourId, ctx.bundleHash, predicted) : null;
    // Nothing to look up: allow a fetch decision immediately.
    this.cacheChecked = key === null;

    this.apply();
    this.unsubscribe = this.deps.network.subscribe((online) => this.onNetwork(online));

    if (key === null || predicted === null) return;

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
        this.showDynamic(checked.points);
        ctx.onStopOrder?.(predicted);
        this.log('using a cached route for the predicted visiting order');
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
    this.liveRouteReceived = false;
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

  private showDynamic(points: LatLng[]): void {
    this.dynamicRoute = points;
    this.dynamicRevision++;
  }

  private apply(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const decision = decideRoute({
      staticRoute: ctx.staticRoute,
      dynamicRoute: this.dynamicRoute,
      liveRouteReceived: this.liveRouteReceived,
      online: this.deps.network.isOnline(),
      fetchState: this.fetchState,
      attempts: this.attempts,
      cacheChecked: this.cacheChecked,
    });

    // Static and straight are fixed for a session; a dynamic route can be
    // replaced (cached, then live), so its revision is part of what is on screen.
    const signature =
      decision.source === 'dynamic' ? `dynamic:${this.dynamicRevision}` : decision.source;
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
        {
          tourId: ctx.tourId,
          waypointIds: ctx.stops.map((s) => s.id),
          transitMode: ctx.transitMode,
          // Per attempt: a retry after a dead zone is scored at the time it is sent.
          localTime: this.deps.localTime(),
          preferences: ctx.preferences,
        },
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
      const order = this.routedOrder(ctx, result.waypointIds);
      if (checked.ok && order) {
        this.showDynamic(checked.points);
        this.liveRouteReceived = true;
        this.fetchState = 'idle';
        const key = routeCacheKey(ctx.tourId, ctx.bundleHash, order);
        if (key) void this.deps.cache.set(key, result.route).catch(() => undefined);
        ctx.onStopOrder?.(order);
        this.log('using a live route');
        this.apply();
        return;
      }
      // The server answered, but with a route that does not reach the stops or
      // an order that is not theirs. Asking again would get the same answer.
      result = {
        kind: 'unavailable',
        reason: checked.ok
          ? `rejected the returned order: it does not name exactly the ${ctx.stops.length} stops`
          : `rejected the returned route: ${checked.reason}`,
      };
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
   * The order a live route visits the stops, in the session's own ids.
   *
   * No `waypoint_ids` means a server from before Epic 8, which routes in the
   * order it was given: the authored order we sent. An order that is not
   * exactly the session's stops is null - the route cannot be matched to the
   * narration, so it is not drawn or cached.
   */
  private routedOrder(ctx: RouteSessionContext, order: string[] | null): string[] | null {
    if (order === null) return ctx.stops.map((s) => s.id);
    return adoptableStopOrder(order, ctx.stops);
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

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
