/**
 * TASK-702 / TASK-801 / TASK-802 - route-stops handler, sorter, memory cache and
 * leg cache, with the database and Valhalla faked. No network, no Supabase, no key.
 *
 * Run:  npm run test:edge
 *       (deno test --import-map=supabase/functions/import_map.json supabase/functions/)
 */

import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';

import { decodePolyline, encodePolyline } from '@shared/polyline.ts';
import {
  RoutingError,
  ValhallaClient,
  type LonLat,
  type ValhallaProfile,
  type ValhallaRoute,
} from '@shared/routing/index.ts';

import {
  GOLDEN_HOUR,
  SCORE_WEIGHTS,
  parseLocalTime,
  scorePois,
  smartSort,
  sunsetUtcMs,
  type SortablePoi,
} from '@shared/smartSorter.ts';

import { handleRouteStops, type RouteStopsDeps } from './handler.ts';
import { LEG_TTL_MS, legCoordsKey, type CachedLeg, type LegStore, type NewLeg } from './legCache.ts';
import { RouteMemoryCache, routeCacheKey } from './routeCache.ts';

// -----------------------------------------------------------------------------
// Fixtures

const TOUR = 'aaaaaaaa-0000-4000-8000-000000000001';
const W1 = 'aaaaaaaa-0001-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0001-4000-8000-000000000002';
const W3 = 'aaaaaaaa-0001-4000-8000-000000000003';
const OTHER = 'bbbbbbbb-0001-4000-8000-000000000001';

const STOP_COORDS: Record<string, LonLat> = {
  [W1]: [35.2290, 31.7767],
  [W2]: [35.2310, 31.7760],
  [W3]: [35.2330, 31.7780],
};

function bundle(transitMode = 'walking'): unknown {
  return {
    bundle_version_hash: 'x',
    tour_metadata: { tour_id: TOUR, transit_mode: transitMode },
    waypoints: [
      // Deliberately not in sort_order.
      { waypoint_id: W3, sort_order: 3, poi_type: 'landmark', coordinates: STOP_COORDS[W3], audiences: [], interests: ['food'] },
      { waypoint_id: W1, sort_order: 1, poi_type: 'landmark', coordinates: STOP_COORDS[W1], audiences: [], interests: [] },
      { waypoint_id: W2, sort_order: 2, poi_type: 'landmark', coordinates: STOP_COORDS[W2], audiences: [], interests: [] },
    ],
    route: null,
  };
}

function fakeRoute(locations: readonly LonLat[], profile: ValhallaProfile): ValhallaRoute {
  return {
    profile,
    encoding: 'polyline',
    precision: 6,
    polyline: encodePolyline(locations.map(([lng, lat]) => ({ lat, lng })), 6),
    distanceMeters: 400,
    durationSeconds: 300,
    legs: locations.slice(1).map((to, i) => ({
      polyline: encodePolyline([locations[i] as LonLat, to].map(([lng, lat]) => ({ lat, lng })), 6),
      distanceMeters: 200,
      durationSeconds: 150,
    })),
    locationOffsetsMeters: locations.map(() => 0),
  };
}

interface Harness {
  deps: RouteStopsDeps;
  calls: { locations: readonly LonLat[]; profile: ValhallaProfile }[];
  lookups: string[];
  logs: Record<string, unknown>[];
}

function harness(overrides: Partial<RouteStopsDeps> & { routeImpl?: Harness['deps']['router'] } = {}): Harness {
  const calls: Harness['calls'] = [];
  const lookups: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const impl = overrides.routeImpl ?? { route: async (l: readonly LonLat[], p: ValhallaProfile) => fakeRoute(l, p) };
  const deps: RouteStopsDeps = {
    loadTour: async (tourId) => {
      lookups.push(tourId);
      return tourId === TOUR ? bundle() : null;
    },
    router: {
      route: (locations, profile) => {
        calls.push({ locations, profile });
        return impl!.route(locations, profile);
      },
    },
    cache: new RouteMemoryCache(),
    log: (e) => logs.push(e),
    ...overrides,
  };
  return { deps, calls, lookups, logs };
}

const post = (body: unknown): Request =>
  new Request('http://localhost/route-stops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anon' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const valid = (extra: Record<string, unknown> = {}) => ({
  tour_id: TOUR,
  waypoint_ids: [W1, W3],
  transit_mode: 'walking',
  ...extra,
});

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

// -----------------------------------------------------------------------------
// Happy path

Deno.test('routes the stops in sort_order and says so', async () => {
  const h = harness();
  const response = await handleRouteStops(post(valid({ waypoint_ids: [W3, W1, W2] })), h.deps);
  assertEquals(response.status, 200);
  const body = await response.json();

  assertEquals(body.waypoint_ids, [W1, W2, W3]);
  assertEquals(body.sort_strategy, 'order_index');
  assertEquals(h.calls[0]?.locations, [STOP_COORDS[W1], STOP_COORDS[W2], STOP_COORDS[W3]]);
  assertEquals(h.calls[0]?.profile, 'pedestrian');

  // The fields mobile/src/routing/routeGeometry.ts parseEncodedRoute requires.
  assertEquals([body.encoding, body.precision], ['polyline', 6]);
  assert(typeof body.polyline === 'string' && body.polyline.length > 0);
  assertEquals(body.length_meters, 400);
  assertEquals(body.duration_seconds, 300);
  assertEquals(body.legs.length, 2);

  assertEquals(response.headers.get('Cache-Control'), 'private, max-age=86400');
  assertEquals(response.headers.get('X-Route-Cache'), 'miss');
  assert(/^"[0-9a-f]{32}"$/.test(response.headers.get('ETag') ?? ''));
});

Deno.test("the tour's transit mode picks the profile", async () => {
  const h = harness({ loadTour: async () => bundle('biking') });
  const response = await handleRouteStops(post(valid({ transit_mode: undefined })), h.deps);
  assertEquals(response.status, 200);
  assertEquals(h.calls[0]?.profile, 'bicycle');
});

Deno.test('uppercase uuids match the lowercase ids the database returns', async () => {
  const h = harness();
  const response = await handleRouteStops(post(valid({ waypoint_ids: [W1.toUpperCase(), W2] })), h.deps);
  assertEquals(response.status, 200);
});

Deno.test('end to end through the real ValhallaClient and a stubbed provider', async () => {
  const leg = (a: LonLat, b: LonLat) => encodePolyline([{ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] }], 6);
  let sentBody: { locations: { lon: number; lat: number }[]; costing: string } | undefined;
  const client = new ValhallaClient({
    routeUrl: 'https://valhalla.test/route',
    apiKey: 'k',
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      const [a, b, c] = [STOP_COORDS[W1], STOP_COORDS[W2], STOP_COORDS[W3]] as LonLat[];
      return Response.json({
        trip: {
          status: 0,
          units: 'kilometers',
          legs: [
            { shape: leg(a!, b!), summary: { length: 0.2, time: 150 } },
            { shape: leg(b!, c!), summary: { length: 0.3, time: 200 } },
          ],
          summary: { length: 0.5, time: 350 },
        },
      });
    }) as typeof fetch,
  });
  const h = harness({ router: client });
  const response = await handleRouteStops(post(valid({ waypoint_ids: [W2, W3, W1] })), h.deps);
  assertEquals(response.status, 200);
  const body = await response.json();

  assertEquals(sentBody?.costing, 'pedestrian');
  assertEquals(sentBody?.locations.map((l): LonLat => [l.lon, l.lat]), [STOP_COORDS[W1], STOP_COORDS[W2], STOP_COORDS[W3]]);
  assertEquals(decodePolyline(body.polyline, 6).length, 3);
  assertEquals([body.length_meters, body.duration_seconds], [500, 350]);
});

// -----------------------------------------------------------------------------
// Caching

Deno.test('an identical stop set is served from the cache, whatever order it was sent in', async () => {
  const h = harness();
  await handleRouteStops(post(valid({ waypoint_ids: [W1, W3] })), h.deps);
  const second = await handleRouteStops(post(valid({ waypoint_ids: [W3, W1] })), h.deps);
  assertEquals(second.status, 200);
  assertEquals(second.headers.get('X-Route-Cache'), 'hit');
  assertEquals(h.calls.length, 1);
});

Deno.test('authorisation runs before the cache: a cached route is not served for an invisible tour', async () => {
  let visible = true;
  const h = harness({ loadTour: async () => (visible ? bundle() : null) });
  assertEquals((await handleRouteStops(post(valid()), h.deps)).status, 200);
  visible = false;
  const response = await handleRouteStops(post(valid()), h.deps);
  assertEquals(response.status, 404);
  assertEquals(h.calls.length, 1);
});

Deno.test('concurrent identical requests make one provider call', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness({
    routeImpl: {
      route: async (l, p) => {
        await gate;
        return fakeRoute(l, p);
      },
    },
  });
  const pending = [1, 2, 3].map(() => handleRouteStops(post(valid()), h.deps));
  await new Promise((r) => setTimeout(r, 10));
  release();
  const responses = await Promise.all(pending);
  assertEquals(responses.map((r) => r.status), [200, 200, 200]);
  assertEquals(h.calls.length, 1);
});

Deno.test('unroutable is cached; rate limiting is not', async () => {
  const unroutable = harness({
    routeImpl: { route: () => Promise.reject(new RoutingError('unroutable', 'no route', { providerCode: 442 })) },
  });
  const firstFailure = await handleRouteStops(post(valid()), unroutable.deps);
  assertEquals([firstFailure.status, firstFailure.headers.get('X-Route-Cache')], [422, 'miss']);
  const again = await handleRouteStops(post(valid()), unroutable.deps);
  assertEquals([again.status, again.headers.get('X-Route-Cache')], [422, 'hit']);
  assertEquals(unroutable.calls.length, 1);

  const limited = harness({
    routeImpl: { route: () => Promise.reject(new RoutingError('rate_limited', 'slow', { retryAfterMs: 1500 })) },
  });
  const first = await handleRouteStops(post(valid()), limited.deps);
  assertEquals([first.status, first.headers.get('Retry-After')], [429, '2']);
  await handleRouteStops(post(valid()), limited.deps);
  assertEquals(limited.calls.length, 2);
});

Deno.test('cache entries expire and the least recently used is evicted', async () => {
  let now = 0;
  const cache = new RouteMemoryCache({ maxEntries: 2, ttlMs: 1000, now: () => now });
  let computed = 0;
  const compute = () => {
    computed++;
    return Promise.resolve(fakeRoute([[0, 0], [1, 1]], 'auto'));
  };
  await cache.getOrCompute('a', compute);
  assertEquals((await cache.getOrCompute('a', compute)).hit, true);
  now = 1001;
  assertEquals((await cache.getOrCompute('a', compute)).hit, false);

  await cache.getOrCompute('b', compute);
  await cache.getOrCompute('a', compute); // touch a, so b is least recent
  await cache.getOrCompute('c', compute);
  assertEquals(cache.size, 2);
  assertEquals((await cache.getOrCompute('a', compute)).hit, true);
  assertEquals((await cache.getOrCompute('b', compute)).hit, false);
  assertEquals(computed, 5);
});

Deno.test('an unexpected exception propagates and is not cached', async () => {
  const cache = new RouteMemoryCache();
  await assertRejects(() => cache.getOrCompute('k', () => Promise.reject(new TypeError('bug'))), TypeError);
  assertEquals(cache.size, 0);
});

Deno.test('cache key follows coordinates to six decimals', () => {
  assertEquals(routeCacheKey('auto', [[1.0000001, 2], [3, 4]]), routeCacheKey('auto', [[1, 2], [3, 4]]));
  assert(routeCacheKey('auto', [[1, 2], [3, 4]]) !== routeCacheKey('pedestrian', [[1, 2], [3, 4]]));
  assert(routeCacheKey('auto', [[1, 2], [3, 4]]) !== routeCacheKey('auto', [[3, 4], [1, 2]]));
});

// -----------------------------------------------------------------------------
// Rejections

Deno.test('method and CORS', async () => {
  const h = harness();
  assertEquals((await handleRouteStops(new Request('http://x', { method: 'OPTIONS' }), h.deps)).status, 204);
  assertEquals((await handleRouteStops(new Request('http://x'), h.deps)).status, 405);
});

Deno.test('routing not configured -> 501, before any lookup', async () => {
  const h = harness({ router: null, routerUnavailableReason: 'STADIA_API_KEY is not set' });
  const response = await handleRouteStops(post(valid()), h.deps);
  assertEquals([response.status, await errorCode(response)], [501, 'routing_not_configured']);
  assertEquals(h.lookups.length, 0);
});

Deno.test('malformed requests -> 400 without touching the database', async () => {
  const h = harness();
  const bad: unknown[] = [
    'not json',
    '[]',
    { ...valid(), tour_id: 'nope' },
    { ...valid(), waypoint_ids: [W1] },
    { ...valid(), waypoint_ids: [W1, W1] },
    { ...valid(), waypoint_ids: [W1, 'x'] },
    { ...valid(), waypoint_ids: Array.from({ length: 21 }, (_, i) => `aaaaaaaa-0001-4000-8000-${String(i).padStart(12, '0')}`) },
    { ...valid(), transit_mode: 'flying' },
    { ...valid(), transit_mode: 'toString' },
    { ...valid(), preferences: 'food' },
    { ...valid(), preferences: { interests: 'food' } },
    { ...valid(), preferences: { start: { lon: 200, lat: 0 } } },
    { ...valid(), preferences: { start: { lon: Number.NaN, lat: 0 } } },
    'x'.repeat(20_000),
  ];
  for (const body of bad) {
    const response = await handleRouteStops(post(body), h.deps);
    assertEquals(response.status, 400, `body ${JSON.stringify(body).slice(0, 80)}`);
    assertEquals(response.headers.get('Cache-Control'), 'no-store');
  }
  assertEquals(h.lookups.length, 0);
});

Deno.test('tour not visible -> 404; lookup failure -> 500', async () => {
  const hidden = harness();
  assertEquals((await handleRouteStops(post(valid({ tour_id: OTHER })), hidden.deps)).status, 404);

  const broken = harness({ loadTour: () => Promise.reject(new Error('connection refused')) });
  const response = await handleRouteStops(post(valid()), broken.deps);
  assertEquals([response.status, await errorCode(response)], [500, 'tour_lookup_failed']);
  assertEquals(broken.logs[0]?.event, 'route_stops_lookup_failed');
});

Deno.test('a stop from another tour, or the wrong transit mode -> 400, no provider call', async () => {
  const h = harness();
  const foreign = await handleRouteStops(post(valid({ waypoint_ids: [W1, OTHER] })), h.deps);
  assertEquals([foreign.status, await errorCode(foreign)], [400, 'unknown_waypoint']);
  const mode = await handleRouteStops(post(valid({ transit_mode: 'driving' })), h.deps);
  assertEquals([mode.status, await errorCode(mode)], [400, 'transit_mode_mismatch']);
  assertEquals(h.calls.length, 0);
});

Deno.test('provider failures map to the statuses the app understands', async () => {
  const cases: [RoutingError, number][] = [
    [new RoutingError('distance_exceeded', 'far'), 422],
    [new RoutingError('too_many_locations', 'many'), 422],
    [new RoutingError('unauthorized', 'key', { status: 401 }), 501],
    [new RoutingError('timeout', 'slow'), 504],
    [new RoutingError('network', 'dns'), 502],
    [new RoutingError('upstream_error', '503', { status: 503 }), 502],
    [new RoutingError('invalid_response', 'html'), 502],
    [new RoutingError('invalid_request', 'ours', { status: 400, providerCode: 125 }), 502],
  ];
  for (const [error, status] of cases) {
    const h = harness({ routeImpl: { route: () => Promise.reject(error) } });
    const response = await handleRouteStops(post(valid()), h.deps);
    assertEquals(response.status, status, error.code);
    assertEquals(h.logs.at(-1)?.code, error.code);
  }
});

// -----------------------------------------------------------------------------
// Smart Sorter

const poi = (id: string, lon: number, lat: number, orderIndex?: number): SortablePoi => ({ id, lon, lat, orderIndex });

Deno.test('sorter: order_index wins, ties broken by id', () => {
  const result = smartSort([poi('c', 0, 0, 2), poi('b', 0, 0, 1), poi('a', 0, 0, 2)]);
  assertEquals(result.strategy, 'order_index');
  assertEquals(result.ordered.map((p) => p.id), ['b', 'a', 'c']);
});

Deno.test('sorter: nearest neighbour when any order_index is missing', () => {
  // On a line: 0, 3, 1, 2 (km-ish apart). Starting at the lowest order_index.
  const pois = [poi('far', 0.03, 0), poi('start', 0, 0, 1), poi('mid', 0.02, 0), poi('near', 0.01, 0)];
  const result = smartSort(pois);
  assertEquals(result.strategy, 'nearest_neighbour');
  assertEquals(result.ordered.map((p) => p.id), ['start', 'near', 'mid', 'far']);
});

Deno.test('sorter: a start preference picks the first stop', () => {
  const pois = [poi('a', 0, 0), poi('b', 0.01, 0), poi('c', 0.02, 0)];
  assertEquals(smartSort(pois, { start: { lon: 0.021, lat: 0 } }).ordered.map((p) => p.id), ['c', 'b', 'a']);
});

Deno.test('sorter: deterministic under input permutation (the cache depends on it)', () => {
  const pois = [poi('a', 0, 0), poi('b', 0.01, 0), poi('c', -0.01, 0), poi('d', 0.02, 0.01)];
  const start = { lon: 0, lat: 0 };
  const expected = smartSort(pois, { start }).ordered.map((p) => p.id);
  for (const perm of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
    const shuffled = perm.map((i) => pois[i] as SortablePoi);
    assertEquals(smartSort(shuffled, { start }).ordered.map((p) => p.id), expected);
  }
  // Equidistant from the start: the lower id goes first, not the earlier input.
  assertEquals(smartSort([poi('z', 0.01, 0), poi('y', -0.01, 0)], { start }).ordered[0]?.id, 'y');
});

// -----------------------------------------------------------------------------
// Leg cache (TASK-801)

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-17T12:00:00Z');

interface FakeStore extends LegStore {
  rows: Map<string, CachedLeg>;
  finds: number;
  saves: NewLeg[][];
}

function fakeStore(options: { failRead?: boolean; failWrite?: boolean } = {}): FakeStore {
  const rows = new Map<string, CachedLeg>();
  const store: FakeStore = {
    rows,
    finds: 0,
    saves: [],
    find(profile, _pairs, since) {
      store.finds++;
      if (options.failRead) return Promise.reject(new Error('read timeout'));
      return Promise.resolve([...rows.values()].filter((r) => r.profile === profile && Date.parse(r.updatedAt) >= since.getTime()));
    },
    save(legs) {
      store.saves.push([...legs]);
      if (options.failWrite) return Promise.reject(new Error('23503 fk'));
      for (const l of legs) rows.set(`${l.startId}|${l.endId}|${l.profile}`, { ...l, updatedAt: new Date(NOW).toISOString() });
      return Promise.resolve();
    },
  };
  return store;
}

const stop = (id: string) => ({ id, lon: (STOP_COORDS[id] as LonLat)[0], lat: (STOP_COORDS[id] as LonLat)[1] });

/** A cached leg as route-stops would have written it, `ageMs` ago. */
function seedLeg(store: FakeStore, from: string, to: string, ageMs = 0, overrides: Partial<CachedLeg> = {}): void {
  const leg = fakeRoute([STOP_COORDS[from] as LonLat, STOP_COORDS[to] as LonLat], 'pedestrian').legs[0]!;
  store.rows.set(`${from}|${to}|pedestrian`, {
    startId: from,
    endId: to,
    profile: 'pedestrian',
    polyline: leg.polyline,
    distanceMeters: 111,
    durationSeconds: 77,
    coordsKey: legCoordsKey(stop(from), stop(to)),
    updatedAt: new Date(NOW - ageMs).toISOString(),
    ...overrides,
  });
}

function legHarness(store: FakeStore, overrides: Partial<RouteStopsDeps> = {}) {
  const deferred: Promise<unknown>[] = [];
  const h = harness({ legStore: store, now: () => NOW, defer: (p) => deferred.push(p), ...overrides });
  // A fresh isolate per request: only the durable cache can hit.
  const request = async (ids: string[]) => {
    h.deps.cache = new RouteMemoryCache();
    const response = await handleRouteStops(post(valid({ waypoint_ids: ids })), h.deps);
    await Promise.all(deferred);
    return response;
  };
  return { h, request, deferred };
}

Deno.test('legs: a cold route is fetched once and every hop is cached for the next isolate', async () => {
  const store = fakeStore();
  const { h, request, deferred } = legHarness(store);

  const first = await request([W1, W2, W3]);
  assertEquals([first.status, first.headers.get('X-Route-Cache')], [200, 'miss']);
  assertEquals(deferred.length, 1, 'the write is handed to waitUntil');
  assertEquals(store.saves[0]?.map((l) => [l.startId, l.endId]), [[W1, W2], [W2, W3]]);
  const firstBody = await first.json();

  const second = await request([W1, W2, W3]);
  assertEquals([second.status, second.headers.get('X-Route-Cache')], [200, 'legs']);
  assertEquals(h.calls.length, 1, 'no provider call when every hop is cached');
  const secondBody = await second.json();
  assertEquals(secondBody.polyline, firstBody.polyline, 'joined legs rebuild the same line');
  assertEquals([secondBody.length_meters, secondBody.duration_seconds], [400, 300]);
  assertEquals(secondBody.legs.length, 2);
});

Deno.test('legs: only the missing hop goes to the provider', async () => {
  const store = fakeStore();
  seedLeg(store, W1, W2);
  const { h, request } = legHarness(store);

  const response = await request([W1, W2, W3]);
  assertEquals([response.status, response.headers.get('X-Route-Cache')], [200, 'partial']);
  assertEquals(h.calls.map((c) => c.locations), [[STOP_COORDS[W2], STOP_COORDS[W3]]]);
  assertEquals(store.saves[0]?.map((l) => [l.startId, l.endId]), [[W2, W3]]);

  const body = await response.json();
  assertEquals(body.legs, [{ length_meters: 111, duration_seconds: 77 }, { length_meters: 200, duration_seconds: 150 }]);
  assertEquals([body.length_meters, body.duration_seconds], [311, 227]);
  // Three distinct points: the shared joint at W2 is not duplicated.
  assertEquals(decodePolyline(body.polyline, 6).length, 3);
});

Deno.test('legs: scattered misses still cost ONE provider call, spanning first to last miss', async () => {
  const W4 = 'aaaaaaaa-0001-4000-8000-000000000004';
  STOP_COORDS[W4] = [35.2350, 31.7790];
  try {
    const store = fakeStore();
    seedLeg(store, W2, W3); // middle hop cached; W1->W2 and W3->W4 missing
    const { h, request } = legHarness(store, {
      loadTour: async () => {
        const b = bundle() as { waypoints: unknown[] };
        b.waypoints.push({ waypoint_id: W4, sort_order: 4, poi_type: 'landmark', coordinates: STOP_COORDS[W4], audiences: [], interests: [] });
        return b;
      },
    });
    const response = await request([W1, W2, W3, W4]);
    assertEquals(response.status, 200);
    assertEquals(h.calls.length, 1);
    assertEquals(h.calls[0]?.locations.length, 4);
    assertEquals(store.saves[0]?.length, 3, 'the re-fetched middle hop is refreshed too');
  } finally {
    delete STOP_COORDS[W4];
  }
});

Deno.test('legs: an expired, moved or corrupt leg is not served', async () => {
  const cases: [string, number, Partial<CachedLeg>][] = [
    ['older than 14 days', LEG_TTL_MS + 1000, {}],
    ['stop moved since it was cached', 0, { coordsKey: '0.000000,0.000000;1.000000,1.000000' }],
    ['polyline does not decode', 0, { polyline: '' }],
  ];
  for (const [label, age, overrides] of cases) {
    const store = fakeStore();
    seedLeg(store, W1, W2, age, overrides);
    seedLeg(store, W2, W3);
    const { h, request } = legHarness(store);
    const response = await request([W1, W2, W3]);
    assertEquals([response.status, response.headers.get('X-Route-Cache')], [200, 'partial'], label);
    assertEquals(h.calls[0]?.locations, [STOP_COORDS[W1], STOP_COORDS[W2]], label);
  }

  // 13 days old is still good.
  const store = fakeStore();
  seedLeg(store, W1, W2, 13 * DAY_MS);
  const { h, request } = legHarness(store);
  assertEquals((await request([W1, W2])).headers.get('X-Route-Cache'), 'legs');
  assertEquals(h.calls.length, 0);
});

Deno.test('legs: a failing cache never fails the route', async () => {
  const a = legHarness(fakeStore({ failRead: true }));
  const readFail = await a.request([W1, W3]);
  assertEquals([readFail.status, readFail.headers.get('X-Route-Cache')], [200, 'miss']);
  assert(a.h.logs.some((e) => e.event === 'route_legs_cache_read_failed'));

  const b = legHarness(fakeStore({ failWrite: true }));
  assertEquals((await b.request([W1, W3])).status, 200);
  assert(b.h.logs.some((e) => e.event === 'route_legs_cache_write_failed'));
});

Deno.test('legs: authorisation runs before the leg store is touched', async () => {
  const store = fakeStore();
  seedLeg(store, W1, W3);
  const h = harness({ legStore: store, now: () => NOW, loadTour: async () => null });
  assertEquals((await handleRouteStops(post(valid()), h.deps)).status, 404);
  assertEquals(store.finds, 0);
});

Deno.test('legs: a cached leg is only used in its own direction', async () => {
  const store = fakeStore();
  seedLeg(store, W3, W1);
  const { h, request } = legHarness(store);
  // Sorted by sort_order -> W1 then W3, which is not the cached W3 -> W1.
  assertEquals((await request([W3, W1])).headers.get('X-Route-Cache'), 'miss');
  assertEquals(h.calls.length, 1);
});

// -----------------------------------------------------------------------------
// Weight engine (TASK-802)

const TLV = { lon: 34.7818, lat: 32.0853 };
const tagged = (id: string, orderIndex: number, extra: Partial<SortablePoi> = {}): SortablePoi => ({
  id,
  lon: TLV.lon,
  lat: TLV.lat,
  orderIndex,
  poiType: 'anchor',
  audiences: [],
  interests: [],
  ...extra,
});

Deno.test('scored: without a context the authored order stands (shipped apps send none)', () => {
  const pois = [tagged('a', 1), tagged('b', 2, { interests: ['culinary'] })];
  assertEquals(smartSort(pois, { interests: ['culinary'] }).strategy, 'order_index');
});

/** A stop `metres` east of TLV along one street. */
const east = (id: string, orderIndex: number, metres: number, extra: Partial<SortablePoi> = {}): SortablePoi =>
  tagged(id, orderIndex, {
    lon: TLV.lon + (metres * 360) / (2 * Math.PI * 6_371_008.8 * Math.cos((TLV.lat * Math.PI) / 180)),
    ...extra,
  });

/** Metres walked along one east-west street, in the given order. */
const walked = (ordered: readonly SortablePoi[]): number =>
  ordered.slice(1).reduce((sum, p, i) => {
    const q = ordered[i] as SortablePoi;
    return sum + Math.abs(p.lon - q.lon) * Math.cos((TLV.lat * Math.PI) / 180) * 111_195;
  }, 0);

const NIGHT = { localTime: '2026-09-17T03:00:00+03:00' }; // no time rule fires

Deno.test('scored: starts at the first authored stop, or the one nearest the visitor', () => {
  const pois = [east('b', 2, 100), east('a', 1, 500), east('c', 3, 900)];
  assertEquals(smartSort(pois, {}, NIGHT).ordered[0]?.id, 'a');
  const start = { lon: east('x', 0, 950).lon, lat: TLV.lat };
  assertEquals(smartSort(pois, { start }, NIGHT).ordered.map((p) => p.id), ['c', 'a', 'b']);
});

Deno.test('scored: with no scores it is plain nearest neighbour (base keeps distance in play)', () => {
  const pois = [east('a', 1, 0), east('far', 2, 900), east('near', 3, 100), east('mid', 4, 400)];
  assertEquals(smartSort(pois, {}, NIGHT).ordered.map((p) => p.id), ['a', 'near', 'mid', 'far']);
});

Deno.test('scored: a matched stop is worth up to twice the walk, not more', () => {
  const prefs = { interests: ['history'] };
  // From a: plain b at 100 m = 10/100 = 0.100; matched at 150 m = 20/150 = 0.133 -> detour.
  const worth = smartSort([east('a', 1, 0), east('b', 2, 100), east('hist', 3, 150, { interests: ['history'] })], prefs, NIGHT);
  assertEquals(worth.ordered.map((p) => p.id), ['a', 'hist', 'b']);
  // Matched at 250 m = 20/250 = 0.080 < 0.100 -> the plain stop first.
  const notWorth = smartSort([east('a', 1, 0), east('b', 2, 100), east('hist', 3, 250, { interests: ['history'] })], prefs, NIGHT);
  assertEquals(notWorth.ordered.map((p) => p.id), ['a', 'b', 'hist']);
  assertEquals(notWorth.scores?.find((s) => s.id === 'hist'), { id: 'hist', score: SCORE_WEIGHTS.interestMatch, reasons: ['interest:history'] });
});

Deno.test('scored: does not zig-zag the way "highest score first" would', () => {
  // Scores alternate along the street: 0, 10, 0, 10, 0, 10.
  const pois = [0, 200, 400, 600, 800, 1000].map((m, i) => east(`s${i}`, i + 1, m, i % 2 ? { interests: ['culinary'] } : {}));
  const result = smartSort(pois, { interests: ['culinary'] }, NIGHT);
  assertEquals(result.ordered.map((p) => p.id), ['s0', 's1', 's2', 's3', 's4', 's5']);
  const highestFirst = [0, 1, 3, 5, 2, 4].map((i) => pois[i] as SortablePoi);
  assertEquals(Math.round(walked(result.ordered)), 1000);
  assert(walked(result.ordered) < walked(highestFirst) * 0.6, `${walked(result.ordered)} vs ${walked(highestFirst)}`);
});

Deno.test('scored: known limitation - a matched stop under 2x the distance is leapfrogged to', () => {
  // From a: b plain at 200 m = 0.050; hist at 300 m = 20/300 = 0.067. The walk doubles back 100 m to b.
  const pois = [east('a', 1, 0), east('b', 2, 200), east('hist', 3, 300, { interests: ['history'] })];
  const result = smartSort(pois, { interests: ['history'] }, NIGHT);
  assertEquals(result.ordered.map((p) => p.id), ['a', 'hist', 'b']);
  assertEquals(Math.round(walked(result.ordered)), 400); // vs 300 in authored order
});

Deno.test('scored: co-located stops do not divide by zero; ties keep the authored order', () => {
  const pois = [tagged('a', 1), tagged('c', 3), tagged('b', 2), tagged('food', 4, { interests: ['culinary'] })];
  const result = smartSort(pois, { interests: ['culinary'] }, NIGHT);
  assertEquals(result.ordered.map((p) => p.id), ['a', 'food', 'b', 'c']);
});

Deno.test('scored: culinary gets the morning boost, and only in the morning', () => {
  // From a: plain b at 100 m = 0.100; cafe at 150 m = (10 + 8) / 150 = 0.120 at 08:15, 10/150 = 0.067 at 14:00.
  const pois = [east('a', 1, 0), east('b', 2, 100), east('cafe', 3, 150, { interests: ['culinary'] })];
  const morning = smartSort(pois, {}, { localTime: '2026-09-17T08:15:00+03:00' });
  assertEquals(morning.ordered.map((p) => p.id), ['a', 'cafe', 'b']);
  assertEquals(morning.scores?.[1]?.reasons, ['time:morning_culinary']);
  assertEquals(smartSort(pois, {}, { localTime: '2026-09-17T14:00:00+03:00' }).ordered.map((p) => p.id), ['a', 'b', 'cafe']);
});

Deno.test('scored: near sunset a viewpoint is worth a long detour', () => {
  // Viewpoint at 350 m: (10 + 30) / 350 = 0.114 beats a matched museum at 200 m: 20/200 = 0.100.
  const pois = [
    east('a', 1, 0),
    east('museum', 2, 200, { interests: ['art_culture'] }),
    east('promenade', 3, 350, { poiType: 'viewpoint' }),
  ];
  const prefs = { interests: ['art_culture'] };
  // Tel Aviv sunset on 17 Sep 2026 is ~18:40 IDT.
  const evening = smartSort(pois, prefs, { localTime: '2026-09-17T18:00:00+03:00' });
  assertEquals(evening.ordered.map((p) => p.id), ['a', 'promenade', 'museum']);
  assertEquals(evening.scores?.[1]?.reasons, ['time:sunset_viewpoint']);
  assertEquals(smartSort(pois, prefs, { localTime: '2026-09-17T12:00:00+03:00' }).ordered.map((p) => p.id), ['a', 'museum', 'promenade']);
});

Deno.test('scored: "evening" follows the season, not the clock', () => {
  const view = [tagged('v', 1, { poiType: 'viewpoint' })];
  const at = (localTime: string) => scorePois(view, {}, parseLocalTime(localTime)!)[0]?.reasons;
  // 18:30 local is golden hour in June (sunset 19:50) and after dark in December (16:40).
  assertEquals(at('2026-06-21T18:30:00+03:00'), ['time:sunset_viewpoint']);
  assertEquals(at('2026-12-21T18:30:00+02:00'), []);
  assertEquals(at('2026-12-21T15:30:00+02:00'), ['time:sunset_viewpoint']);
  // Shoulder: two hours before a June sunset.
  assertEquals(at('2026-06-21T17:50:00+03:00'), ['time:sunset_viewpoint_shoulder']);
  assert(GOLDEN_HOUR.shoulderFrom > GOLDEN_HOUR.fullFrom);
});

Deno.test('scored: deterministic under input permutation, co-located ties included', () => {
  const pois = [
    east('a', 1, 0, { interests: ['nature'] }),
    east('b', 2, 300, { poiType: 'viewpoint' }),
    east('c', 3, 120),
    east('d', 3, 120, { interests: ['nature'] }),
    east('e', 5, 120),
  ];
  const ctx = { localTime: '2026-09-17T18:10:00+03:00' };
  const expected = smartSort(pois, { interests: ['nature'] }, ctx).ordered.map((p) => p.id);
  for (const perm of [[4, 3, 2, 1, 0], [1, 3, 0, 4, 2], [2, 0, 4, 3, 1]]) {
    const shuffled = perm.map((i) => pois[i] as SortablePoi);
    assertEquals(smartSort(shuffled, { interests: ['nature'] }, ctx).ordered.map((p) => p.id), expected);
  }
});

Deno.test('scored: local time must carry its offset', () => {
  assertEquals(parseLocalTime('2026-09-17T18:40:00'), null);
  assertEquals(parseLocalTime('2026-02-30T10:00:00Z'), null);
  assertEquals(parseLocalTime('2026-09-17T24:00:00Z'), null);
  assertEquals(parseLocalTime('2026-09-17T18:40:00+03:00')?.localMinute, 18 * 60 + 40);
  assertEquals(parseLocalTime('2026-09-17T18:40:00.123-04:30')?.instantMs, Date.parse('2026-09-17T23:10:00.000Z'));
});

Deno.test('sunset matches published times to within a few minutes; none in polar day', () => {
  const near = (actual: number | null, iso: string) =>
    assert(actual !== null && Math.abs(actual - Date.parse(iso)) < 4 * 60_000, `${actual && new Date(actual).toISOString()} vs ${iso}`);
  near(sunsetUtcMs(2026, 6, 21, 32.0853, 34.7818), '2026-06-21T16:50:00Z'); // Tel Aviv 19:50 IDT
  near(sunsetUtcMs(2026, 12, 21, 32.0853, 34.7818), '2026-12-21T14:40:00Z'); // Tel Aviv 16:40 IST
  near(sunsetUtcMs(2026, 9, 17, 40.7128, -74.006), '2026-09-17T23:02:00Z'); // New York 19:02 EDT
  assertEquals(sunsetUtcMs(2026, 6, 21, 69.65, 18.96), null); // Tromso, midnight sun
});

Deno.test('route-stops: a context opts in to scoring; a bad one is a 400', async () => {
  const h = harness();
  assertEquals((await handleRouteStops(post(valid({ context: { local_time: '2026-09-17T18:40:00' } })), h.deps)).status, 400);
  assertEquals((await handleRouteStops(post(valid({ context: 'evening' })), h.deps)).status, 400);
  assertEquals(h.lookups.length, 0);

  const ok = await handleRouteStops(
    post(valid({ waypoint_ids: [W1, W2, W3], preferences: { interests: ['food'] }, context: { local_time: '2026-09-17T03:00:00+03:00' } })),
    h.deps,
  );
  assertEquals(ok.status, 200);
  const body = await ok.json();
  assertEquals([body.sort_strategy, body.sorter_version], ['scored', 'v2']);
  // Starts at the first authored stop; the order returned is the order routed.
  assertEquals(body.waypoint_ids[0], W1);
  assertEquals([...body.waypoint_ids].sort(), [W1, W2, W3]);
  assertEquals(h.calls[0]?.locations, (body.waypoint_ids as string[]).map((id) => STOP_COORDS[id]));
});
