/**
 * Epic 13 - the shared logger: PII sanitising, batching, background shipping
 * to Axiom, and failure reporting. Axiom is faked; no network.
 *
 * Run:  npm run test:edge
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';

import { axiomConfigFromEnv, createLogger, USER_REF_HASH_FAILED, USER_REF_UNCONFIGURED, type LoggerOptions } from './logger.ts';
import { createUserRef, userRefFromEnv } from './userRef.ts';

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const KEY = 'test-log-pseudonym-key-0123456789abcdef';
const AXIOM = { ingestUrl: 'https://us-east-1.aws.edge.axiom.co/v1/ingest/audio-tour', token: 'xaat-test' };

interface Sent {
  url: string;
  init: RequestInit;
  lines: Record<string, unknown>[];
}

function rig(overrides: Partial<LoggerOptions> & { respond?: (sent: Sent) => Promise<Response> } = {}) {
  const console: string[] = [];
  const sent: Sent[] = [];
  const background: Promise<unknown>[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    const s: Sent = { url: String(url), init: init ?? {}, lines: body.split('\n').map((l) => JSON.parse(l)) };
    sent.push(s);
    return overrides.respond ? overrides.respond(s) : new Response('{}', { status: 200 });
  }) as typeof fetch;
  const logger = createLogger({
    service: 'test-fn',
    userRef: createUserRef(KEY),
    axiom: AXIOM,
    runInBackground: (task) => void background.push(task),
    fetch: fakeFetch,
    write: (line) => console.push(line),
    now: () => new Date('2026-09-24T12:00:00.000Z'),
    ...overrides,
  });
  const consoleEvents = () => console.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { logger, console, consoleEvents, sent, background };
}

Deno.test('user_id never leaves the logger - console and Axiom both get the keyed user_ref', async () => {
  const r = rig();
  r.logger.log({ event: 'account_deleted', user_id: USER, elapsed_ms: 12 });
  await r.logger.flush();
  const everything = JSON.stringify(r.console) + JSON.stringify(r.sent.map((s) => s.init.body));
  assert(!everything.includes(USER), everything);
  const expected = await createUserRef(KEY)(USER);
  assertEquals(r.consoleEvents()[0], {
    _time: '2026-09-24T12:00:00.000Z',
    service: 'test-fn',
    event: 'account_deleted',
    elapsed_ms: 12,
    user_ref: expected,
  });
  assertEquals(r.sent[0].lines, r.consoleEvents(), 'Axiom gets exactly the console lines');
});

Deno.test('no key -> "unconfigured"; a hash that throws -> "hash_failed"; never the raw id', async () => {
  const none = rig({ userRef: null });
  none.logger.log({ event: 'e', user_id: USER });
  await none.logger.flush();
  assertEquals(none.consoleEvents()[0].user_ref, USER_REF_UNCONFIGURED);

  const broken = rig({ userRef: () => Promise.reject(new Error('subtle down')) });
  broken.logger.log({ event: 'e', user_id: USER });
  await broken.logger.flush();
  assertEquals(broken.consoleEvents()[0].user_ref, USER_REF_HASH_FAILED);
  assert(!JSON.stringify([none.console, broken.console, none.sent, broken.sent.map((s) => s.init.body)]).includes(USER));
});

Deno.test('lines without user_id get no user_ref', async () => {
  const r = rig();
  r.logger.log({ event: 'apple_revoke_disabled', reason: 'x' });
  await r.logger.flush();
  assertEquals('user_ref' in r.consoleEvents()[0], false);
});

Deno.test('one tick of events is one ingest request: NDJSON, Bearer token, the configured URL', async () => {
  const r = rig();
  r.logger.log({ event: 'a' });
  r.logger.log({ event: 'b', user_id: USER });
  r.logger.log({ event: 'c' });
  await r.logger.flush();
  assertEquals(r.sent.length, 1);
  assertEquals(r.sent[0].url, AXIOM.ingestUrl);
  assertEquals(r.sent[0].init.method, 'POST');
  const headers = r.sent[0].init.headers as Record<string, string>;
  assertEquals(headers.Authorization, 'Bearer xaat-test');
  assertEquals(headers['Content-Type'], 'application/x-ndjson');
  assertEquals(r.sent[0].lines.map((l) => l.event), ['a', 'b', 'c']);
  assertEquals(r.background.length, 1, 'one waitUntil per batch');
});

Deno.test('a line logged after a batch shipped - a background revocation - starts its own batch', async () => {
  const r = rig();
  r.logger.log({ event: 'account_deleted', user_id: USER });
  await r.logger.flush();
  r.logger.log({ event: 'apple_revocation_finished', user_id: USER, result: 'revoked' });
  await r.logger.flush();
  assertEquals(r.sent.map((s) => s.lines.map((l) => l.event)), [['account_deleted'], ['apple_revocation_finished']]);
  assertEquals(r.background.length, 2);
});

Deno.test('log() never waits for Axiom: it returns at once and hands the work to waitUntil', async () => {
  const r = rig({ respond: () => new Promise<Response>(() => {}) }); // Axiom hangs forever
  const started = performance.now();
  r.logger.log({ event: 'a', user_id: USER });
  assert(performance.now() - started < 5, 'synchronous');
  assertEquals(r.background.length, 1, 'the shipping task went to runInBackground');
  // The console copy is written before the ingest is even attempted.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assertEquals(r.console.length, 1);
});

Deno.test('Axiom refusing, unreachable or hung is reported on the console, never thrown', async () => {
  const refused = rig({ respond: () => Promise.resolve(new Response('bad token', { status: 403 })) });
  refused.logger.log({ event: 'a' });
  refused.logger.log({ event: 'b' });
  await refused.logger.flush();
  const failure = refused.consoleEvents().find((e) => e.event === 'axiom_ingest_failed');
  assertEquals([failure?.status, failure?.dropped, failure?.body], [403, 2, 'bad token']);

  const down = rig({ respond: () => Promise.reject(new TypeError('network down')) });
  down.logger.log({ event: 'a' });
  await down.logger.flush();
  assert(down.consoleEvents().some((e) => e.event === 'axiom_ingest_failed' && String(e.message).includes('network down')));

  // A hung Axiom is cut off by the timeout, so waitUntil is not held open.
  const hung = rig({
    ingestTimeoutMs: 20,
    respond: (s) =>
      new Promise<Response>((_, reject) => s.init.signal?.addEventListener('abort', () => reject(s.init.signal?.reason))),
  });
  hung.logger.log({ event: 'a' });
  await hung.logger.flush();
  assert(hung.consoleEvents().some((e) => e.event === 'axiom_ingest_failed'), 'timed out and reported');
});

Deno.test('without Axiom configured, lines still reach the console and nothing is fetched', async () => {
  const r = rig({ axiom: null });
  r.logger.log({ event: 'a', user_id: USER });
  await r.logger.flush();
  assertEquals(r.sent.length, 0);
  assertEquals(r.console.length, 1);
});

Deno.test('AXIOM_*: all three or none; the domain must be a bare host, so logs cannot be redirected by a pasted URL', () => {
  assertEquals(axiomConfigFromEnv({}), { axiom: null, reason: 'AXIOM_* secrets not set' });
  assert(axiomConfigFromEnv({ AXIOM_TOKEN: 't', AXIOM_DATASET: 'd' }).axiom === null);
  for (const domain of ['https://api.axiom.co', 'api.axiom.co/v1', 'evil.com/x?', 'localhost']) {
    assert(axiomConfigFromEnv({ AXIOM_TOKEN: 't', AXIOM_DATASET: 'd', AXIOM_DOMAIN: domain }).axiom === null, domain);
  }
  assert(axiomConfigFromEnv({ AXIOM_TOKEN: 't', AXIOM_DATASET: 'a/b', AXIOM_DOMAIN: 'api.axiom.co' }).axiom === null);
  assertEquals(axiomConfigFromEnv({ AXIOM_TOKEN: 't', AXIOM_DATASET: 'audio-tour', AXIOM_DOMAIN: 'EU-Central-1.aws.edge.axiom.co' }), {
    axiom: { ingestUrl: 'https://eu-central-1.aws.edge.axiom.co/v1/ingest/audio-tour', token: 't' },
  });
});

Deno.test('the ref is keyed, deterministic and per-user - not a plain SHA-256 of the id', async () => {
  const a = await createUserRef(KEY)(USER);
  const plain = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(USER))), (x) =>
    x.toString(16).padStart(2, '0')).join('');
  assert(/^[0-9a-f]{64}$/.test(a));
  assert(a !== plain);
  assert(a !== (await createUserRef(`${KEY}-rotated`)(USER)), 'another key, another ref');
  assert(a !== (await createUserRef(KEY)(OTHER)), 'another user, another ref');
  assertEquals(a, await createUserRef(KEY)(USER));
});

Deno.test('LOG_PSEUDONYM_KEY: missing or under 32 characters is refused with a reason', () => {
  assertEquals(userRefFromEnv({}), { userRef: null, reason: 'LOG_PSEUDONYM_KEY not set' });
  const short = userRefFromEnv({ LOG_PSEUDONYM_KEY: 'x'.repeat(31) });
  assert(short.userRef === null && /shorter than 32/.test(short.reason));
  assert(userRefFromEnv({ LOG_PSEUDONYM_KEY: KEY }).userRef !== null);
});
