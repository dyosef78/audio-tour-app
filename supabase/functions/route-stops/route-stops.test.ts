/**
 * TASK-702 - route-stops handler, sorter and cache, with the database and
 * Valhalla faked. No network, no Supabase, no key.
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

import { handleRouteStops, type RouteStopsDeps } from './handler.ts';
import { RouteMemoryCache, routeCacheKey } from './routeCache.ts';
import { smartSort, type SortablePoi } from './smartSorter.ts';

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
    legs: locations.slice(1).map(() => ({ distanceMeters: 200, durationSeconds: 150 })),
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
  assertEquals((await handleRouteStops(post(valid()), unroutable.deps)).status, 422);
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
