/**
 * places-search - Deno tests against a fake Google: request shape (key header,
 * field masks, session token, city bias), response mapping, error mapping,
 * and that the visitor's text never reaches a log line.
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';

import { AUTOCOMPLETE_URL, BIAS_RADIUS_M, DETAILS_FIELD_MASK, handlePlacesSearch, type PlacesDeps } from './handler.ts';

const CITY = '00000000-0000-4000-8000-000000000001';
const TOKEN = '8f1d2c3b-4a5e-4f60-9a7b-1c2d3e4f5a6b';
const SECRET_INPUT = 'Rothschild 22 my hotel';

interface Seen { url: string; init: RequestInit }

function deps(google: (url: string, init: RequestInit) => Response | Promise<Response>, over: Partial<PlacesDeps> = {}) {
  const seen: Seen[] = [];
  const logs: Record<string, unknown>[] = [];
  const d: PlacesDeps = {
    apiKey: 'SERVER-KEY',
    requestId: () => 'req-p',
    rateLimit: null,
    cityCenter: (id) => Promise.resolve(id === CITY ? ([34.7818, 32.0853] as const) : null),
    fetch: (async (u: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(u), init: init ?? {} });
      return google(String(u), init ?? {});
    }) as typeof fetch,
    log: (e) => { logs.push(e); },
    now: () => 0,
    ...over,
  };
  return { d, seen, logs };
}
const call = async (d: PlacesDeps, body: unknown) => {
  const res = await handlePlacesSearch(new Request('https://x/functions/v1/places-search', { method: 'POST', body: JSON.stringify(body) }), d);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- either shape, asserted field by field
  return { status: res.status, headers: res.headers, body: await res.json() as any };
};
const google = (status: number, body: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers });
const auto = { action: 'autocomplete', input: SECRET_INPUT, session_token: TOKEN, city_id: CITY };

Deno.test('autocomplete: key in a header, field mask, session token, bias on the city', async () => {
  const { d, seen } = deps(google(200, { suggestions: [] }));
  await call(d, auto);
  const s = seen[0]!;
  const h = s.init.headers as Record<string, string>;
  assertEquals(s.url, AUTOCOMPLETE_URL, 'the key never rides in the URL');
  assertEquals(h['X-Goog-Api-Key'], 'SERVER-KEY');
  assert(h['X-Goog-FieldMask']!.includes('suggestions.placePrediction.placeId'));
  const body = JSON.parse(String(s.init.body));
  assertEquals(body.sessionToken, TOKEN);
  assertEquals(body.locationBias, { circle: { center: { latitude: 32.0853, longitude: 34.7818 }, radius: BIAS_RADIUS_M } });
});

Deno.test('autocomplete: place predictions only, at most 5, primary + secondary', async () => {
  const pred = (id: string, main: string, second?: string) => ({ placePrediction: { placeId: id, text: { text: `${main}, x` }, structuredFormat: { mainText: { text: main }, ...(second ? { secondaryText: { text: second } } : {}) } } });
  const { d } = deps(google(200, { suggestions: [
    { queryPrediction: { text: { text: 'pizza near me' } } },
    pred('ChIJ_aaaaaaaaaa', 'Dizengoff Center', 'Tel Aviv'), pred('ChIJ_bbbbbbbbbb', 'Hotel B'),
    pred('ChIJ_cccccccccc', 'C'), pred('ChIJ_dddddddddd', 'D'), pred('ChIJ_eeeeeeeeee', 'E'), pred('ChIJ_ffffffffff', 'F'),
  ] }));
  const { status, body } = await call(d, auto);
  assertEquals(status, 200);
  assertEquals(body.action === 'autocomplete' && body.suggestions.length, 5);
  assertEquals(body.action === 'autocomplete' && body.suggestions[0], { place_id: 'ChIJ_aaaaaaaaaa', primary: 'Dizengoff Center', secondary: 'Tel Aviv' });
  assertEquals(body.action === 'autocomplete' && body.suggestions[1]!.secondary, null);
});

Deno.test('details: cheapest field mask, same session token, coordinates + label', async () => {
  const { d, seen } = deps(google(200, { id: 'ChIJ_aaaaaaaaaa', location: { latitude: 32.0775, longitude: 34.7748 }, formattedAddress: 'Dizengoff St 50, Tel Aviv' }));
  const { status, body } = await call(d, { action: 'details', place_id: 'ChIJ_aaaaaaaaaa', session_token: TOKEN });
  assertEquals(status, 200);
  assertEquals(body.action === 'details' && [body.lon, body.lat, body.label], [34.7748, 32.0775, 'Dizengoff St 50, Tel Aviv']);
  assertEquals((seen[0]!.init.headers as Record<string, string>)['X-Goog-FieldMask'], DETAILS_FIELD_MASK);
  assert(seen[0]!.url.endsWith(`?sessionToken=${TOKEN}`), 'the session ends with the token it began with');
});

Deno.test('the visitor\'s text never reaches a log line', async () => {
  const { d, logs } = deps(google(200, { suggestions: [] }));
  await call(d, auto);
  const fail = deps(() => { throw new Error('boom'); });
  await call(fail.d, auto);
  const all = JSON.stringify([...logs, ...fail.logs]);
  assert(!all.includes('Rothschild') && !all.includes('hotel'), all);
  assert(logs.some((e) => e.input_length === SECRET_INPUT.length));
});

Deno.test('errors are mapped, never passed through', async () => {
  const run = async (g: Parameters<typeof deps>[0], body: unknown = auto) => (await call(deps(g).d, body));
  const limited = await run(google(429, {}, { 'retry-after': '12' }));
  assertEquals([limited.status, limited.body.code, limited.headers.get('Retry-After')], [429, 'rate_limited', '12']);
  assertEquals((await run(google(403, { error: { message: 'API key not valid' } }))).body.code, 'not_configured');
  assertEquals((await run(google(404, {}), { action: 'details', place_id: 'ChIJ_zzzzzzzzzz', session_token: TOKEN })).body.code, 'place_not_found');
  assertEquals((await run(google(500, {}))).body.code, 'upstream_error');
  assertEquals((await run(google(200, { id: 'x' }), { action: 'details', place_id: 'ChIJ_zzzzzzzzzz', session_token: TOKEN })).body.code, 'upstream_error', 'no location = a shape we do not recognise');
  const hang = deps((_u, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))), { timeoutMs: 20 });
  assertEquals((await call(hang.d, auto)).body.code, 'timeout');
  const leaked = await run(google(403, { error: { message: 'key SERVER-KEY bad' } }));
  assert(!JSON.stringify(leaked.body).includes('SERVER-KEY'), 'the key is never echoed');
});

Deno.test('input is checked before anything is spent', async () => {
  const { d, seen } = deps(google(200, { suggestions: [] }));
  const bad = async (body: unknown) => (await call(d, body)).status;
  assertEquals(await bad({ ...auto, input: 'a' }), 400);
  assertEquals(await bad({ ...auto, session_token: 'not-a-uuid' }), 400);
  assertEquals(await bad({ ...auto, session_token: '00000000-0000-1000-8000-000000000001' }), 400, 'v4 only');
  assertEquals(await bad({ ...auto, city_id: '00000000-0000-4000-8000-000000000099' }), 400, 'unknown city');
  assertEquals(await bad({ action: 'details', place_id: '../../etc', session_token: TOKEN }), 400);
  assertEquals(await bad({ action: 'search', session_token: TOKEN }), 400);
  assertEquals(seen.length, 0);
});

Deno.test('no key -> 503, and rate limits apply before Google is called', async () => {
  assertEquals((await call(deps(google(200, {}), { apiKey: null }).d, auto)).body.code, 'not_configured');
  const limited = deps(google(200, { suggestions: [] }), { rateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 4, scope: 'global' }) });
  const r = await call(limited.d, auto);
  assertEquals([r.status, r.body.retry_after_s, limited.seen.length], [429, 4, 0]);
});
