/**
 * TASK-1001 - route-stops rate limiting: address parsing, the limiter's
 * decisions, and where the handler applies it. The bucket store is faked here;
 * its SQL (public.consume_rate_limit) is exercised by the db-verify workflow.
 *
 * Run:  npm run test:edge
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';

import { handleRouteStops, type RouteStopsDeps } from './handler.ts';
import {
  DEFAULT_RATE_LIMIT_POLICY,
  GLOBAL_BUCKET_KEY,
  clientAddress,
  createRateLimiter,
  normaliseAddress,
  rateLimitPolicyFromEnv,
  type BucketOutcome,
  type BucketRequest,
  type BucketStore,
} from './rateLimit.ts';
import { RouteMemoryCache } from './routeCache.ts';

const TOUR = 'aaaaaaaa-0000-4000-8000-000000000001';
const W1 = 'aaaaaaaa-0001-4000-8000-000000000001';
const W2 = 'aaaaaaaa-0001-4000-8000-000000000002';

const post = (headers: Record<string, string> = {}, body: unknown = { tour_id: TOUR, waypoint_ids: [W1, W2] }) =>
  new Request('http://localhost/route-stops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anon', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

/** An in-memory token bucket store with the database function's all-or-nothing semantics. */
function memoryStore(): { store: BucketStore; calls: BucketRequest[][]; levels: Map<string, number> } {
  const levels = new Map<string, number>();
  const calls: BucketRequest[][] = [];
  const store: BucketStore = async (buckets) => {
    calls.push(buckets);
    const exhausted = buckets.filter((b) => (levels.get(b.key) ?? b.capacity) < 1).map((b) => b.key);
    const allowed = exhausted.length === 0;
    for (const b of buckets) levels.set(b.key, (levels.get(b.key) ?? b.capacity) - (allowed ? 1 : 0));
    return {
      allowed,
      retryAfterSeconds: allowed ? 0 : 6,
      remaining: Math.min(...buckets.map((b) => levels.get(b.key) as number)),
      exhausted,
    } satisfies BucketOutcome;
  };
  return { store, calls, levels };
}

// -----------------------------------------------------------------------------
// Addresses

Deno.test('address: IPv4 as-is, ports and IPv4-mapped IPv6 unwrapped', () => {
  assertEquals(normaliseAddress('203.0.113.7'), '203.0.113.7');
  assertEquals(normaliseAddress(' 203.0.113.7:51234 '), '203.0.113.7');
  assertEquals(normaliseAddress('::ffff:203.0.113.7'), '203.0.113.7');
});

Deno.test('address: every IPv6 address in one /64 shares a key', () => {
  const key = '2001:db8:abcd:12::/64';
  assertEquals(normaliseAddress('2001:db8:abcd:12::1'), key);
  assertEquals(normaliseAddress('2001:0DB8:ABCD:0012:ffff:1:2:3'), key);
  assertEquals(normaliseAddress('[2001:db8:abcd:12:1::9]:443'), key);
  assertEquals(normaliseAddress('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert(normaliseAddress('2001:db8:abcd:13::1') !== key);
});

Deno.test('address: garbage cannot mint keys', () => {
  for (const bad of ['', 'unknown', '999.1.1.1', '1.2.3', '1:2:3', '2001:db8::1::2', 'g::1', '1:2:3:4:5:6:7:8:9', '<script>']) {
    assertEquals(normaliseAddress(bad), null, bad);
  }
});

Deno.test('address: Cloudflare header wins over a client-supplied X-Forwarded-For', () => {
  const h = new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1', 'cf-connecting-ip': '203.0.113.7' });
  assertEquals(clientAddress(h), { key: '203.0.113.7', header: 'cf-connecting-ip' });
  assertEquals(clientAddress(new Headers({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' }))?.key, '198.51.100.1');
  assertEquals(clientAddress(new Headers({ 'cf-connecting-ip': 'nonsense', 'x-real-ip': '198.51.100.2' }))?.key, '198.51.100.2');
  assertEquals(clientAddress(new Headers()), null);
});

// -----------------------------------------------------------------------------
// Policy

Deno.test('policy: env overrides, and a bad value keeps the default instead of disabling the limit', () => {
  assertEquals(rateLimitPolicyFromEnv({}), DEFAULT_RATE_LIMIT_POLICY);
  const p = rateLimitPolicyFromEnv({
    ROUTE_RATE_LIMIT_CLIENT_BURST: '5',
    ROUTE_RATE_LIMIT_CLIENT_PER_MINUTE: 'ten',
    ROUTE_RATE_LIMIT_GLOBAL_BURST: '0',
    ROUTE_RATE_LIMIT_GLOBAL_PER_MINUTE: '600',
  });
  assertEquals(p, { client: { burst: 5, perMinute: 10 }, global: { burst: 300, perMinute: 600 } });
});

// -----------------------------------------------------------------------------
// Limiter

Deno.test('limiter: a burst from one address is refused once its bucket is empty; another address is not', async () => {
  const m = memoryStore();
  const limit = createRateLimiter({ store: m.store, secret: 's', policy: { client: { burst: 2, perMinute: 6 }, global: { burst: 100, perMinute: 60 } } });
  const a = { 'cf-connecting-ip': '203.0.113.7' };

  assertEquals((await limit(post(a))).allowed, true);
  assertEquals((await limit(post(a))).allowed, true);
  assertEquals(await limit(post(a)), { allowed: false, retryAfterSeconds: 6, scope: 'client' });
  assertEquals((await limit(post({ 'cf-connecting-ip': '203.0.113.8' }))).allowed, true);

  // The refused request spent nothing from the global bucket (3 allowed of 100).
  assertEquals(m.levels.get(GLOBAL_BUCKET_KEY), 97);
  // Refill rate is per second.
  assertEquals(m.calls[0]?.find((b) => b.key !== GLOBAL_BUCKET_KEY)?.refillPerSecond, 0.1);
});

Deno.test('limiter: the global bucket refuses rotating addresses', async () => {
  const m = memoryStore();
  const limit = createRateLimiter({ store: m.store, secret: 's', policy: { client: { burst: 10, perMinute: 10 }, global: { burst: 3, perMinute: 1 } } });
  const results = [];
  for (let i = 1; i <= 4; i++) results.push(await limit(post({ 'cf-connecting-ip': `198.51.100.${i}` })));
  assertEquals(results.map((r) => r.allowed), [true, true, true, false]);
  assertEquals(results[3], { allowed: false, retryAfterSeconds: 6, scope: 'global' });
});

Deno.test('limiter: no raw address reaches the store, and keys are stable per address', async () => {
  const m = memoryStore();
  const limit = createRateLimiter({ store: m.store, secret: 'server-secret' });
  await limit(post({ 'cf-connecting-ip': '203.0.113.7' }));
  await limit(post({ 'cf-connecting-ip': '203.0.113.7' }));
  const keys = m.calls.map((c) => c.map((b) => b.key).find((k) => k !== GLOBAL_BUCKET_KEY));
  assert(/^route-stops:ip:[0-9a-f]{32}$/.test(keys[0] ?? ''), keys[0]);
  assertEquals(keys[0], keys[1]);
  assert(!JSON.stringify(m.calls).includes('203.0.113'));

  // A different secret gives a different key: the table alone cannot be reversed.
  const other = memoryStore();
  await createRateLimiter({ store: other.store, secret: 'another' })(post({ 'cf-connecting-ip': '203.0.113.7' }));
  assert(other.calls[0]?.some((b) => b.key !== GLOBAL_BUCKET_KEY && b.key !== keys[0]));
});

Deno.test('limiter: no address header -> global bucket only, warned once', async () => {
  const m = memoryStore();
  const logs: Record<string, unknown>[] = [];
  const limit = createRateLimiter({ store: m.store, secret: 's', log: (e) => logs.push(e) });
  await limit(post());
  await limit(post());
  assertEquals(m.calls.map((c) => c.map((b) => b.key)), [[GLOBAL_BUCKET_KEY], [GLOBAL_BUCKET_KEY]]);
  assertEquals(logs.filter((l) => l.event === 'route_stops_rate_limit_no_client_address').length, 1);
});

Deno.test('limiter: fails open when the store is down', async () => {
  const logs: Record<string, unknown>[] = [];
  const limit = createRateLimiter({
    store: () => Promise.reject(new Error('timeout')),
    secret: 's',
    log: (e) => logs.push(e),
  });
  assertEquals((await limit(post({ 'cf-connecting-ip': '203.0.113.7' }))).allowed, true);
  assertEquals(logs[0]?.event, 'route_stops_rate_limit_unavailable');
});

// -----------------------------------------------------------------------------
// Handler

function deps(overrides: Partial<RouteStopsDeps> = {}): { deps: RouteStopsDeps; lookups: number; logs: Record<string, unknown>[] } {
  const state = { lookups: 0, logs: [] as Record<string, unknown>[] };
  const d: RouteStopsDeps = {
    loadTour: async () => {
      state.lookups++;
      return null;
    },
    router: { route: () => Promise.reject(new Error('not reached')) },
    cache: new RouteMemoryCache(),
    log: (e) => state.logs.push(e),
    ...overrides,
  };
  return {
    deps: d,
    get lookups() {
      return state.lookups;
    },
    logs: state.logs,
  };
}

Deno.test('handler: refused -> 429 with Retry-After, before the body is parsed or the tour is loaded', async () => {
  const h = deps({ rateLimit: async () => ({ allowed: false, retryAfterSeconds: 7, scope: 'client' }) });
  const response = await handleRouteStops(post({}, 'not json'), h.deps);
  assertEquals(response.status, 429);
  assertEquals(response.headers.get('Retry-After'), '7');
  assertEquals(response.headers.get('Cache-Control'), 'no-store');
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*');
  assertEquals(((await response.json()) as { error: string }).error, 'too_many_requests');
  assertEquals(h.lookups, 0);
  assertEquals(h.logs[0], { event: 'route_stops_rate_limited', scope: 'client', retry_after_seconds: 7 });
});

Deno.test('handler: allowed requests carry on; OPTIONS and non-POST are never counted', async () => {
  let counted = 0;
  const h = deps({
    rateLimit: async () => {
      counted++;
      return { allowed: true, remaining: 5 };
    },
  });
  assertEquals((await handleRouteStops(post(), h.deps)).status, 404);
  assertEquals(h.lookups, 1);
  assertEquals((await handleRouteStops(new Request('http://localhost/route-stops', { method: 'OPTIONS' }), h.deps)).status, 204);
  assertEquals((await handleRouteStops(new Request('http://localhost/route-stops'), h.deps)).status, 405);
  assertEquals(counted, 1);
});

Deno.test('handler: no limiter configured -> requests are not limited', async () => {
  const h = deps({ rateLimit: null });
  assertEquals((await handleRouteStops(post(), h.deps)).status, 404);
});
