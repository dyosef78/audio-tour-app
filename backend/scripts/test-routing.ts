/**
 * TASK-701 - Valhalla routing client, against a stubbed provider.
 *
 * No network and no key: every response is canned, in the shapes Valhalla and
 * Stadia actually return. What this guards is the parsing and the error
 * mapping - the multi-leg join, the units, the key never reaching a message,
 * and that each failure gets the code (and retryability) callers branch on.
 *
 * Run:  npm run test:routing
 */

import { encodePolyline, decodePolyline, type RoutePoint } from '../../shared/src/polyline.ts';
import {
  RoutingError,
  ValhallaClient,
  parseRetryAfter,
  valhallaConfigFromEnv,
  type LonLat,
  type RoutingErrorCode,
  type ValhallaClientConfig,
} from '../../shared/src/routing/index.ts';

let failures = 0;
let checks = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, `got ${a}, expected ${e}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

async function rejectsCode(label: string, code: RoutingErrorCode, run: () => Promise<unknown>): Promise<RoutingError | undefined> {
  try {
    await run();
    assert(label, false, 'did not throw');
  } catch (error) {
    const ok = error instanceof RoutingError && error.code === code;
    assert(label, ok, error instanceof RoutingError ? `code ${error.code}: ${error.message}` : String(error));
    if (error instanceof RoutingError) return error;
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Stub provider

interface Sent {
  url: URL;
  body: Record<string, unknown>;
}

const KEY = 'sk-secret-test-key';

function stub(
  respond: (sent: Sent, signal: AbortSignal) => Response | Promise<Response>,
  config: Partial<ValhallaClientConfig> = {},
): { client: ValhallaClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry = { url: new URL(String(input)), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    sent.push(entry);
    return respond(entry, init?.signal as AbortSignal);
  }) as typeof fetch;
  const client = new ValhallaClient({ routeUrl: 'https://valhalla.test/route', apiKey: KEY, fetch: fetchStub, ...config });
  return { client, sent };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Resolves only when the signal aborts, then rejects like fetch does. */
const hang = (_: Sent, signal: AbortSignal): Promise<Response> =>
  new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));

// Three stops in Jaffa, and legs whose shapes share their joints the way
// Valhalla's do.
const STOPS: LonLat[] = [
  [34.7519, 32.0543],
  [34.7532, 32.0551],
  [34.7548, 32.0538],
];
const LEG_A: RoutePoint[] = [
  { lat: 32.0543, lng: 34.7519 },
  { lat: 32.0547, lng: 34.7525 },
  { lat: 32.0551, lng: 34.7532 },
];
const LEG_B: RoutePoint[] = [
  { lat: 32.0551, lng: 34.7532 },
  { lat: 32.0545, lng: 34.7541 },
  { lat: 32.0538, lng: 34.7548 },
];

function trip(overrides: Record<string, unknown> = {}): unknown {
  return {
    trip: {
      status: 0,
      status_message: 'Found route between points',
      units: 'kilometers',
      legs: [
        { shape: encodePolyline(LEG_A, 6), summary: { length: 0.152, time: 110.4 } },
        { shape: encodePolyline(LEG_B, 6), summary: { length: 0.213, time: 150.7 } },
      ],
      summary: { length: 0.365, time: 261.1 },
      ...overrides,
    },
  };
}

// -----------------------------------------------------------------------------

heading('Request');

{
  const { client, sent } = stub(() => json(200, trip()));
  await client.route(STOPS, 'pedestrian');
  const req = sent[0] as Sent;
  eq('POSTs to the configured endpoint', `${req.url.origin}${req.url.pathname}`, 'https://valhalla.test/route');
  eq('key travels as api_key', req.url.searchParams.get('api_key'), KEY);
  eq('costing is the profile', req.body.costing, 'pedestrian');
  eq(
    'locations keep caller order, lon/lat unswapped, as breaks',
    req.body.locations,
    STOPS.map(([lon, lat]) => ({ lon, lat, type: 'break' })),
  );
  eq('asks for kilometres', req.body.units, 'kilometers');
  eq('skips maneuvers', req.body.directions_type, 'none');
}

{
  const { client, sent } = stub(() => json(200, trip()), { apiKey: undefined });
  await client.route(STOPS, 'bicycle');
  eq('no key, no api_key parameter (self-hosted)', (sent[0] as Sent).url.searchParams.has('api_key'), false);
}

// -----------------------------------------------------------------------------

heading('Response');

{
  const { client } = stub(() => json(200, trip()));
  const route = await client.route(STOPS, 'auto');
  const points = decodePolyline(route.polyline, 6);
  eq('legs joined without the duplicate joint', points, [...LEG_A, ...LEG_B.slice(1)]);
  eq('declares precision 6', [route.encoding, route.precision], ['polyline', 6]);
  eq('distance in whole metres', route.distanceMeters, 365);
  eq('duration in whole seconds', route.durationSeconds, 261);
  eq('per-leg figures', route.legs, [
    { distanceMeters: 152, durationSeconds: 110 },
    { distanceMeters: 213, durationSeconds: 151 },
  ]);
  eq('stops on the line are 0 m off it', route.locationOffsetsMeters, [0, 0, 0]);
  eq('echoes the profile', route.profile, 'auto');
}

{
  const { client } = stub(() => json(200, trip({ units: 'miles', summary: { length: 1, time: 60 } })));
  eq('honours units: miles in the response', (await client.route(STOPS, 'auto')).distanceMeters, 1609);
}

{
  // Legs whose joints do NOT repeat must keep every point.
  const gap = { lat: 32.056, lng: 34.754 };
  const { client } = stub(() =>
    json(200, trip({ legs: [
      { shape: encodePolyline(LEG_A, 6), summary: { length: 0.1, time: 1 } },
      { shape: encodePolyline([gap, ...LEG_B.slice(1)], 6), summary: { length: 0.1, time: 1 } },
    ] })),
  );
  eq('distinct joints are kept', decodePolyline((await client.route(STOPS, 'auto')).polyline, 6).length, 6);
}

{
  const { client } = stub(() => json(200, trip()));
  const swapped = STOPS.map(([lon, lat]) => [lat, lon] as const);
  const route = await client.route(swapped, 'pedestrian');
  assert('swapped lon/lat shows up as a huge offset', route.locationOffsetsMeters.every((m) => m > 100_000));
}

// -----------------------------------------------------------------------------

heading('Invalid input - nothing is sent');

{
  const { client, sent } = stub(() => json(200, trip()), { maxLocations: 3 });
  await rejectsCode('one location', 'invalid_request', () => client.route([STOPS[0] as LonLat], 'pedestrian'));
  await rejectsCode('latitude 91', 'invalid_request', () => client.route([[34, 91], [34, 32]], 'pedestrian'));
  await rejectsCode('NaN', 'invalid_request', () => client.route([[Number.NaN, 32], [34, 32]], 'pedestrian'));
  await rejectsCode('null entry', 'invalid_request', () => client.route([null as never, [34, 32]], 'pedestrian'));
  await rejectsCode('three numbers', 'invalid_request', () => client.route([[34, 32, 0] as never, [34, 32]], 'pedestrian'));
  await rejectsCode('unknown profile', 'invalid_request', () => client.route(STOPS, 'walking' as never));
  await rejectsCode('over maxLocations', 'too_many_locations', () => client.route([...STOPS, [34, 32]], 'pedestrian'));
  eq('no request reached the provider', sent.length, 0);
}

// -----------------------------------------------------------------------------

heading('Provider errors');

const valhallaError = (status: number, error_code: number, error: string): Response =>
  json(status, { error_code, error, status_code: status, status: 'Bad Request' });

const cases: [string, () => Response, RoutingErrorCode, boolean][] = [
  ['171 no edges near a stop', () => valhallaError(400, 171, 'No suitable edges near location'), 'unroutable', false],
  ['442 no path', () => valhallaError(400, 442, 'No path could be found for input'), 'unroutable', false],
  ['170 unconnected regions', () => valhallaError(400, 170, 'Locations are in unconnected regions'), 'unroutable', false],
  ['154 distance limit', () => valhallaError(400, 154, 'Path distance exceeds the max distance limit'), 'distance_exceeded', false],
  ['150 location limit', () => valhallaError(400, 150, 'Exceeded max locations'), 'too_many_locations', false],
  ['other 4xx code', () => valhallaError(400, 125, 'No costing method found'), 'invalid_request', false],
  ['401', () => json(401, { message: 'Invalid API key' }), 'unauthorized', false],
  ['403', () => new Response('Forbidden', { status: 403 }), 'unauthorized', false],
  ['429', () => new Response('Too Many Requests', { status: 429 }), 'rate_limited', true],
  ['502 HTML', () => new Response('<html>Bad Gateway</html>', { status: 502 }), 'upstream_error', true],
  ['200 not JSON', () => new Response('<html>captive portal</html>', { status: 200 }), 'invalid_response', false],
  ['200 no trip', () => json(200, { id: 'x' }), 'invalid_response', false],
  ['200 leg count mismatch', () => json(200, trip({ legs: [] })), 'invalid_response', false],
  ['200 undecodable shape', () => json(200, trip({ legs: [{ shape: 'bad shape', summary: { length: 1, time: 1 } }, { shape: '??', summary: { length: 1, time: 1 } }] })), 'invalid_response', false],
  ['200 unknown units', () => json(200, trip({ units: 'furlongs' })), 'invalid_response', false],
  ['200 no summary', () => json(200, trip({ summary: undefined })), 'invalid_response', false],
];

for (const [label, respond, code, retryable] of cases) {
  const { client } = stub(respond);
  const error = await rejectsCode(label, code, () => client.route(STOPS, 'pedestrian'));
  if (error) {
    assert(`${label}: retryable=${retryable}`, error.retryable === retryable);
    assert(`${label}: key not in message or detail`, !`${error.message} ${error.detail}`.includes(KEY));
  }
}

{
  const { client } = stub(() => valhallaError(400, 171, 'No suitable edges near location'));
  const error = await rejectsCode('provider code and message are kept', 'unroutable', () => client.route(STOPS, 'auto'));
  eq('providerCode', error?.providerCode, 171);
  eq('detail', error?.detail, 'No suitable edges near location');
  eq('status', error?.status, 400);
}

{
  const { client } = stub(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }));
  const error = await rejectsCode('429 with Retry-After', 'rate_limited', () => client.route(STOPS, 'auto'));
  eq('retryAfterMs from seconds', error?.retryAfterMs, 30_000);
}

const NOW = Date.parse('2026-09-16T12:00:00Z');
eq('Retry-After as HTTP-date', parseRetryAfter('Wed, 16 Sep 2026 12:00:05 GMT', NOW), 5000);
eq('Retry-After in the past clamps to 0', parseRetryAfter('Wed, 16 Sep 2026 11:00:00 GMT', NOW), 0);
eq('Retry-After garbage is ignored', parseRetryAfter('soon', NOW), undefined);

// -----------------------------------------------------------------------------

heading('Timeouts, cancellation, network');

{
  const { client } = stub(hang, { timeoutMs: 50 });
  const error = await rejectsCode('no answer -> timeout', 'timeout', () => client.route(STOPS, 'pedestrian'));
  assert('timeout is retryable', error?.retryable === true);
}

{
  // Headers arrive, the body never does.
  const { client } = stub((_, signal) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  })), { timeoutMs: 50 });
  await rejectsCode('stalled body -> timeout', 'timeout', () => client.route(STOPS, 'pedestrian'));
}

{
  const { client } = stub(hang, { timeoutMs: 5_000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const error = await rejectsCode('caller abort -> aborted', 'aborted', () =>
    client.route(STOPS, 'pedestrian', { signal: controller.signal }),
  );
  assert('aborted is not retryable', error?.retryable === false);
}

{
  const { client, sent } = stub(() => json(200, trip()));
  await rejectsCode('already-aborted signal', 'aborted', () =>
    client.route(STOPS, 'pedestrian', { signal: AbortSignal.abort() }),
  );
  eq('...sends nothing', sent.length, 0);
}

{
  const { client } = stub(() => {
    throw new TypeError(`fetch failed: getaddrinfo ENOTFOUND valhalla.test ?api_key=${KEY}`);
  });
  const error = await rejectsCode('fetch throws -> network', 'network', () => client.route(STOPS, 'pedestrian'));
  assert('network is retryable', error?.retryable === true);
  assert(
    'key redacted from the runtime error text',
    error?.detail?.includes('[redacted]') === true && !error.detail.includes(KEY),
  );
}

// -----------------------------------------------------------------------------

heading('Configuration from environment');

eq('defaults to Stadia with the key', valhallaConfigFromEnv({ STADIA_API_KEY: ' k ' }), {
  routeUrl: 'https://api.stadiamaps.com/route/v1',
  apiKey: 'k',
});
eq('self-hosted needs no key', valhallaConfigFromEnv({ VALHALLA_ROUTE_URL: 'http://localhost:8002/route' }), {
  routeUrl: 'http://localhost:8002/route',
  apiKey: undefined,
});

for (const [label, env] of [
  ['Stadia without a key', {}],
  ['Stadia with a blank key', { STADIA_API_KEY: '  ' }],
  ['not a URL', { VALHALLA_ROUTE_URL: 'valhalla', STADIA_API_KEY: 'k' }],
  ['not http(s)', { VALHALLA_ROUTE_URL: 'ftp://valhalla.test/route', STADIA_API_KEY: 'k' }],
] as const) {
  try {
    valhallaConfigFromEnv(env);
    assert(`${label} -> not_configured`, false, 'did not throw');
  } catch (error) {
    assert(`${label} -> not_configured`, error instanceof RoutingError && error.code === 'not_configured', String(error));
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
