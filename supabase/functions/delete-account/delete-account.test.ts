/**
 * TASK-1104 / Epic 12 - delete-account handler, Apple token revocation and
 * Google grant revocation, with GoTrue, the database, Apple and Google faked.
 * No network, no Supabase, no Apple key, no Google client.
 *
 * Run:  npm run test:edge
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';

import {
  appleClientSecret,
  appleRevokeConfigFromEnv,
  createAppleRevoker,
  type AppleRevokeConfig,
  type AppleRevoker,
} from './appleRevoke.ts';
import { createGoogleRevoker, googleRevokeConfigFromEnv, type GoogleRevoker } from './googleRevoke.ts';
import { handleDeleteAccount, type AuthenticatedUser, type DeleteAccountDeps } from './handler.ts';
import { createLogger } from '../_shared/logger.ts';
import { createUserRef } from '../_shared/userRef.ts';

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

interface Harness {
  deps: DeleteAccountDeps;
  /** Every dependency call, in order - the ORDER is part of the contract now. */
  calls: string[];
  deleted: string[];
  revokes: { code: string; subjects: readonly string[] }[];
  googleRevokes: { token: string; subjects: readonly string[] }[];
  background: Promise<unknown>[];
  logs: Record<string, unknown>[];
}

type RevokeBehaviour = 'revoked' | 'failed' | 'subject_mismatch' | 'hang' | 'throw';
type GoogleRevokeBehaviour = 'revoked' | 'failed' | 'subject_mismatch' | 'client_mismatch' | 'hang' | 'throw';
const never = <T>(): Promise<T> => new Promise<T>(() => {});

function harness(
  options: {
    user?: AuthenticatedUser | null;
    admins?: string[];
    deleteResult?: 'deleted' | 'not_found' | Error | 'hang';
    revoker?: RevokeBehaviour | null;
    googleRevoker?: GoogleRevokeBehaviour | null;
    authenticate?: 'hang';
    adminCheck?: 'hang';
    background?: boolean;
  } = {},
): Harness {
  const calls: string[] = [];
  const deleted: string[] = [];
  const revokes: Harness['revokes'] = [];
  const googleRevokes: Harness['googleRevokes'] = [];
  const background: Promise<unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const user = options.user === undefined ? { id: USER, appleSubjects: [], googleSubjects: [] } : options.user;
  const revoker: AppleRevoker | null =
    options.revoker === null || options.revoker === undefined
      ? null
      : {
          revoke: (code, subjects) => {
            calls.push('revoke');
            revokes.push({ code, subjects });
            if (options.revoker === 'hang') return never();
            if (options.revoker === 'throw') return Promise.reject(new Error('apple down'));
            return Promise.resolve(options.revoker as 'revoked' | 'failed' | 'subject_mismatch');
          },
        };
  const googleRevoker: GoogleRevoker | null =
    options.googleRevoker === null || options.googleRevoker === undefined
      ? null
      : {
          revoke: (token, subjects) => {
            calls.push('googleRevoke');
            googleRevokes.push({ token, subjects });
            if (options.googleRevoker === 'hang') return never();
            if (options.googleRevoker === 'throw') return Promise.reject(new Error('google down'));
            return Promise.resolve(options.googleRevoker as 'revoked' | 'failed' | 'subject_mismatch' | 'client_mismatch');
          },
        };
  const deps: DeleteAccountDeps = {
    authenticate: (request) => {
      calls.push('authenticate');
      if (options.authenticate === 'hang') return never();
      return Promise.resolve(request.headers.get('Authorization') === 'Bearer user-token' ? user : null);
    },
    isCmsAdmin: (id) => {
      calls.push('isCmsAdmin');
      if (options.adminCheck === 'hang') return never();
      return Promise.resolve((options.admins ?? []).includes(id));
    },
    deleteUser: (id) => {
      calls.push('deleteUser');
      if (options.deleteResult === 'hang') return never();
      if (options.deleteResult instanceof Error) return Promise.reject(options.deleteResult);
      deleted.push(id);
      return Promise.resolve(options.deleteResult ?? 'deleted');
    },
    appleRevoker: revoker,
    googleRevoker,
    runInBackground: options.background ? (task) => void background.push(task) : null,
    // Short, so the hang tests run in milliseconds. Production values: DEFAULT_DEADLINES.
    deadlines: { authenticateMs: 40, adminCheckMs: 40, deleteMs: 40, revocationFallbackMs: 40 },
    log: (e) => logs.push(e),
  };
  return { deps, calls, deleted, revokes, googleRevokes, background, logs };
}

const post = (body?: unknown, token = 'user-token'): Request =>
  new Request('http://localhost/delete-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const APPLE_USER: AuthenticatedUser = { id: USER, appleSubjects: ['apple-sub'], googleSubjects: [] };
const GOOGLE_USER: AuthenticatedUser = { id: USER, appleSubjects: [], googleSubjects: ['google-sub'] };
const NO_GOOGLE = { google_revocation: 'not_attempted', google_revocation_reason: 'no_token_in_request' };

// -----------------------------------------------------------------------------
// Handler

Deno.test('a signed-in user deletes their own account', async () => {
  const h = harness();
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, apple_revocation: 'not_attempted', apple_revocation_reason: 'no_code_in_request', ...NO_GOOGLE });
  assertEquals(h.deleted, [USER]);
  assertEquals(res.headers.get('Cache-Control'), 'no-store');
});

Deno.test("the account deleted is the TOKEN's, whatever the body says", async () => {
  const h = harness();
  const res = await handleDeleteAccount(post({ user_id: OTHER, id: OTHER }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.deleted, [USER]);
});

Deno.test('no valid user session -> 401, nothing deleted', async () => {
  for (const request of [post(undefined, 'anon-key'), new Request('http://localhost/delete-account', { method: 'POST' })]) {
    const h = harness();
    const res = await handleDeleteAccount(request, h.deps);
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, 'not_signed_in');
    assertEquals(h.deleted, []);
  }
});

Deno.test('an authentication backend that throws is a 401, not a 500 or a deletion', async () => {
  const h = harness();
  h.deps.authenticate = () => Promise.reject(new Error('GoTrue down'));
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 401);
  assertEquals(h.deleted, []);
});

Deno.test('a CMS administrator is refused, and neither deleted nor revoked', async () => {
  const h = harness({ admins: [USER], revoker: 'revoked', user: APPLE_USER });
  const res = await handleDeleteAccount(post({ apple_authorization_code: 'code' }), h.deps);
  assertEquals(res.status, 403);
  assertEquals((await res.json()).error, 'admin_account');
  assertEquals(h.deleted, []);
  assertEquals(h.revokes, []);
});

Deno.test('an admin check that fails blocks the deletion (fail closed)', async () => {
  const h = harness();
  h.deps.isCmsAdmin = () => Promise.reject(new Error('db down'));
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 500);
  assertEquals(h.deleted, []);
});

Deno.test('a user already gone counts as deleted (a retry after a lost response)', async () => {
  const h = harness({ deleteResult: 'not_found' });
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.logs.find((l) => l.event === 'account_deleted')?.already_gone, true);
});

Deno.test('a failed delete is a 500 that does not claim success', async () => {
  const h = harness({ deleteResult: new Error('boom') });
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, 'delete_failed');
});

// --- Hang resistance (Epic 11 device-QA failure) ------------------------------

Deno.test('hang: authentication that never answers -> 503 try_again, nothing deleted', async () => {
  const h = harness({ authenticate: 'hang' });
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error, 'try_again');
  assertEquals(h.deleted, []);
});

Deno.test('hang: an admin check that never answers -> 503, nothing deleted (fail closed)', async () => {
  const h = harness({ adminCheck: 'hang' });
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 503);
  assertEquals(h.calls.includes('deleteUser'), false);
});

Deno.test('hang: a delete that never answers -> 504 deletion_unconfirmed, never 200', async () => {
  const h = harness({ deleteResult: 'hang' });
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 504);
  assertEquals((await res.json()).error, 'deletion_unconfirmed');
});

// --- Apple revocation: after the delete, never in the way of it ---------------

Deno.test('Apple: the account is deleted FIRST, and revocation runs after with the captured identities', async () => {
  const h = harness({ revoker: 'revoked', user: APPLE_USER, background: true });
  const res = await handleDeleteAccount(post({ apple_authorization_code: 'fresh-code' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, apple_revocation: 'scheduled', apple_revocation_reason: 'scheduled', ...NO_GOOGLE });
  assertEquals(h.logs.find((l) => l.event === 'apple_revocation_scheduled')?.background, true);
  assertEquals(h.calls, ['authenticate', 'isCmsAdmin', 'deleteUser', 'revoke']);
  assertEquals(h.revokes, [{ code: 'fresh-code', subjects: ['apple-sub'] }]);
  assertEquals(h.background.length, 1, 'handed to the runtime to finish after the response');
  await Promise.all(h.background);
  assertEquals(h.logs.find((l) => l.event === 'apple_revocation_finished')?.result, 'revoked');
});

Deno.test('Apple: a revocation that hangs or throws cannot delay or fail the deletion', async () => {
  for (const behaviour of ['hang', 'throw', 'failed', 'subject_mismatch'] as const) {
    for (const background of [true, false]) {
      const h = harness({ revoker: behaviour, user: APPLE_USER, background });
      const started = Date.now();
      const res = await handleDeleteAccount(post({ apple_authorization_code: 'code' }), h.deps);
      const label = `${behaviour}, background=${background}`;
      assertEquals(res.status, 200, label);
      assertEquals(h.deleted, [USER], label);
      assert(Date.now() - started < 1_000, `${label}: answered promptly`);
    }
  }
});

Deno.test('Apple: every skip names its reason - in the response AND the log (device QA, 23 Sep)', async () => {
  // "No apple_revocation_finished line" used to mean any of these three.
  const cases: [string, Harness, unknown, string][] = [
    ['Apple account, phone sent no code', harness({ revoker: 'revoked', user: APPLE_USER }), {}, 'no_code_in_request'],
    ['secrets not loaded', harness({ revoker: null, user: APPLE_USER }), { apple_authorization_code: 'c' }, 'revocation_not_configured'],
    ['code sent, no Apple identity on the account', harness({ revoker: 'revoked', user: { id: USER, appleSubjects: [], googleSubjects: [] } }), { apple_authorization_code: 'c' }, 'no_apple_identity_on_account'],
  ];
  for (const [label, h, body, reason] of cases) {
    const res = await handleDeleteAccount(post(body), h.deps);
    assertEquals(res.status, 200, label);
    const json = await res.json();
    assertEquals([json.apple_revocation, json.apple_revocation_reason], ['not_attempted', reason], label);
    assertEquals(h.revokes, [], label);
    assertEquals(h.logs.find((l) => l.event === 'apple_revocation_skipped')?.reason, reason, `${label}: logged`);
  }
});

Deno.test('Apple: the authenticated log line carries both halves of the decision, never the code', async () => {
  const h = harness({ revoker: 'revoked', user: APPLE_USER, background: true });
  await handleDeleteAccount(post({ apple_authorization_code: 'secret-code' }), h.deps);
  const line = h.logs.find((l) => l.event === 'delete_account_authenticated');
  assertEquals([line?.apple_identities, line?.apple_code_present], [1, true]);
  assert(!JSON.stringify(h.logs).includes('secret-code'));
});

Deno.test('a plain Google account deletes with no Apple noise in the log', async () => {
  const h = harness({ revoker: 'revoked', user: GOOGLE_USER });
  await handleDeleteAccount(post({}), h.deps);
  assertEquals(h.logs.some((l) => String(l.event).startsWith('apple_revocation')), false);
});

Deno.test('malformed bodies -> 400 without deleting; method and CORS', async () => {
  const malformed = [
    '{', '[]', '"x"', { apple_authorization_code: 42 }, { apple_authorization_code: '' }, 'x'.repeat(9000),
    { google_access_token: 42 }, { google_access_token: '' }, { google_access_token: 'x'.repeat(4097) },
  ];
  for (const body of malformed) {
    const h = harness();
    const res = await handleDeleteAccount(post(body), h.deps);
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 40));
    assertEquals(h.deleted, []);
  }
  const h = harness();
  assertEquals((await handleDeleteAccount(new Request('http://localhost/x', { method: 'GET' }), h.deps)).status, 405);
  assertEquals((await handleDeleteAccount(new Request('http://localhost/x', { method: 'OPTIONS' }), h.deps)).status, 204);
});

Deno.test('no service role -> 501 before touching the user', async () => {
  const h = harness();
  const res = await handleDeleteAccount(post(), { ...h.deps, deleteUser: null });
  assertEquals(res.status, 501);
});

Deno.test('every response carries X-Request-Id, and every log line the same id', async () => {
  for (const h of [harness(), harness({ deleteResult: 'hang' }), harness({ admins: [USER] })]) {
    const res = await handleDeleteAccount(post(), h.deps);
    const id = res.headers.get('X-Request-Id');
    assert(id !== null && /^[0-9a-f-]{36}$/.test(id), `status ${res.status} carries an id`);
    assert(h.logs.length > 0 && h.logs.every((l) => l.request_id === id), 'logs are correlated');
  }
});

Deno.test('the log never carries an email, name or token', async () => {
  const h = harness({ revoker: 'revoked', user: APPLE_USER, background: true });
  await handleDeleteAccount(post({ apple_authorization_code: 'secret-code' }), h.deps);
  await Promise.all(h.background);
  const text = JSON.stringify(h.logs);
  assert(!text.includes('secret-code') && !text.includes('user-token') && !text.includes('apple-sub'), text);
});

Deno.test('Epic 13: wired to the real logger, no path ships the raw user id - to the console or to Axiom', async () => {
  const cases = [
    harness({ revoker: 'revoked', googleRevoker: 'revoked', user: { id: USER, appleSubjects: ['apple-sub'], googleSubjects: ['google-sub'] }, background: true }),
    harness({ revoker: 'throw', user: APPLE_USER, background: true }),
    harness({ admins: [USER] }),
    harness({ deleteResult: new Error('boom') }),
    harness({ deleteResult: 'hang' }),
    harness({ adminCheck: 'hang' }),
  ];
  const expected = await createUserRef('test-log-pseudonym-key-0123456789abcdef')(USER);
  for (const h of cases) {
    const shipped: string[] = [];
    const logger = createLogger({
      service: 'delete-account',
      userRef: createUserRef('test-log-pseudonym-key-0123456789abcdef'),
      axiom: { ingestUrl: 'https://axiom.test/v1/ingest/d', token: 't' },
      runInBackground: null,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        shipped.push(String(init?.body));
        return new Response('{}');
      }) as typeof fetch,
      write: (line) => shipped.push(line),
    });
    await handleDeleteAccount(post({ apple_authorization_code: 'c', google_access_token: 't' }), { ...h.deps, log: logger.log });
    await Promise.all(h.background);
    await logger.flush();
    const text = shipped.join(' ');
    assert(shipped.length > 0, 'something was logged');
    assert(!text.includes(USER), `raw id shipped: ${text}`);
    assert(text.includes(expected), 'user lines carry the keyed ref');
  }
});

// --- Google revocation (Epic 12): the same rules as Apple ----------------------

Deno.test('Google: deleted FIRST, then the grant is revoked in the background with the captured identities', async () => {
  const h = harness({ googleRevoker: 'revoked', user: GOOGLE_USER, background: true });
  const res = await handleDeleteAccount(post({ google_access_token: 'ya29.token' }), h.deps);
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals([json.google_revocation, json.google_revocation_reason], ['scheduled', 'scheduled']);
  assertEquals(h.calls, ['authenticate', 'isCmsAdmin', 'deleteUser', 'googleRevoke']);
  assertEquals(h.googleRevokes, [{ token: 'ya29.token', subjects: ['google-sub'] }]);
  assertEquals(h.background.length, 1, 'handed to the runtime to finish after the response');
  await Promise.all(h.background);
  assertEquals(h.logs.find((l) => l.event === 'google_revocation_finished')?.result, 'revoked');
});

Deno.test('Google: the fallback flag - no token -> still deleted, and google_revocation_skipped carries the reason', async () => {
  // The PM's Epic 12 rule: getTokens timed out (or failed) on the phone ->
  // the request goes ahead without a token, and the server says why in the log.
  const h = harness({ googleRevoker: 'revoked', user: GOOGLE_USER });
  const res = await handleDeleteAccount(post({ google_token_unavailable: 'timeout' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.deleted, [USER]);
  assertEquals(h.googleRevokes, []);
  const skipped = h.logs.find((l) => l.event === 'google_revocation_skipped');
  assertEquals([skipped?.reason, skipped?.client_reason], ['no_token_in_request', 'timeout']);
});

Deno.test('Google: a malformed flag can never block a deletion - it is logged as unrecognised', async () => {
  for (const flag of [42, '', 'Not A Reason!', 'x'.repeat(65), { nested: true }]) {
    const h = harness({ googleRevoker: 'revoked', user: GOOGLE_USER });
    const res = await handleDeleteAccount(post({ google_token_unavailable: flag }), h.deps);
    assertEquals(res.status, 200, JSON.stringify(flag));
    assertEquals(h.deleted, [USER], JSON.stringify(flag));
    assertEquals(h.logs.find((l) => l.event === 'google_revocation_skipped')?.client_reason, 'unrecognised');
  }
});

Deno.test('Google: a revocation that hangs, throws or is refused cannot delay or fail the deletion', async () => {
  for (const behaviour of ['hang', 'throw', 'failed', 'subject_mismatch', 'client_mismatch'] as const) {
    for (const background of [true, false]) {
      const h = harness({ googleRevoker: behaviour, user: GOOGLE_USER, background });
      const started = Date.now();
      const res = await handleDeleteAccount(post({ google_access_token: 't' }), h.deps);
      const label = `${behaviour}, background=${background}`;
      assertEquals(res.status, 200, label);
      assertEquals(h.deleted, [USER], label);
      assert(Date.now() - started < 1_000, `${label}: answered promptly`);
    }
  }
});

Deno.test('Google: every skip names its reason - in the response AND the log', async () => {
  const cases: [string, Harness, unknown, string][] = [
    ['Google account, phone sent no token', harness({ googleRevoker: 'revoked', user: GOOGLE_USER }), {}, 'no_token_in_request'],
    ['GOOGLE_CLIENT_IDS not set', harness({ googleRevoker: null, user: GOOGLE_USER }), { google_access_token: 't' }, 'revocation_not_configured'],
    ['token sent, no Google identity on the account', harness({ googleRevoker: 'revoked', user: APPLE_USER }), { google_access_token: 't' }, 'no_google_identity_on_account'],
  ];
  for (const [label, h, body, reason] of cases) {
    const res = await handleDeleteAccount(post(body), h.deps);
    assertEquals(res.status, 200, label);
    const json = await res.json();
    assertEquals([json.google_revocation, json.google_revocation_reason], ['not_attempted', reason], label);
    assertEquals(h.googleRevokes, [], label);
    assertEquals(h.logs.find((l) => l.event === 'google_revocation_skipped')?.reason, reason, `${label}: logged`);
  }
});

Deno.test('Apple and Google linked: both revocations run, each in the background, neither holds the response', async () => {
  const linked: AuthenticatedUser = { id: USER, appleSubjects: ['apple-sub'], googleSubjects: ['google-sub'] };
  for (const background of [true, false]) {
    const h = harness({ revoker: 'hang', googleRevoker: 'hang', user: linked, background });
    const started = Date.now();
    const res = await handleDeleteAccount(post({ apple_authorization_code: 'c', google_access_token: 't' }), h.deps);
    assertEquals(res.status, 200);
    assertEquals(h.calls.filter((c) => c.endsWith('evoke')).sort(), ['googleRevoke', 'revoke']);
    if (background) assertEquals(h.background.length, 2);
    else assertEquals(h.logs.some((l) => l.event === 'revocation_abandoned'), true, 'fallback cap logged');
    assert(Date.now() - started < 1_000, `background=${background}: answered promptly`);
  }
});

Deno.test('Google: the log never carries the access token', async () => {
  const h = harness({ googleRevoker: 'revoked', user: GOOGLE_USER, background: true });
  await handleDeleteAccount(post({ google_access_token: 'ya29.secret-token' }), h.deps);
  await Promise.all(h.background);
  const line = h.logs.find((l) => l.event === 'delete_account_authenticated');
  assertEquals([line?.google_identities, line?.google_token_present], [1, true]);
  const text = JSON.stringify(h.logs);
  assert(!text.includes('ya29.secret-token') && !text.includes('google-sub'), text);
});

Deno.test('a plain Apple account deletes with no Google noise in the log', async () => {
  const h = harness({ revoker: 'revoked', googleRevoker: 'revoked', user: APPLE_USER, background: true });
  await handleDeleteAccount(post({ apple_authorization_code: 'c' }), h.deps);
  assertEquals(h.logs.some((l) => String(l.event).startsWith('google_revocation')), false);
});

// -----------------------------------------------------------------------------
// Google revocation

type FakeGoogle = (url: string, init?: RequestInit) => Response | Promise<Response>;
const googleWith = (impl: FakeGoogle, clientIds = ['ios-client.apps.googleusercontent.com']) =>
  createGoogleRevoker({ clientIds }, { log: () => {}, fetch: (async (url: string | URL | Request, init?: RequestInit) => impl(String(url), init)) as typeof fetch });

Deno.test('Google revoke: checks the token with tokeninfo, then revokes it', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const revoker = googleWith((url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      return Response.json({ sub: 'google-sub', aud: 'ios-client.apps.googleusercontent.com', azp: 'ios-client.apps.googleusercontent.com' });
    }
    return new Response(null, { status: 200 });
  });
  assertEquals(await revoker.revoke('ya29.tok', ['google-sub']), 'revoked');
  assertEquals(calls[0]!.url, 'https://oauth2.googleapis.com/tokeninfo?access_token=ya29.tok');
  assertEquals(calls[1]!.url, 'https://oauth2.googleapis.com/revoke');
  assertEquals(calls[1]!.init?.method, 'POST');
  assertEquals(new URLSearchParams(calls[1]!.init?.body as URLSearchParams).get('token'), 'ya29.tok');
});

Deno.test("Google revoke: another Google account's token, or another app's, is NOT revoked", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['other Google account', { sub: 'someone-else', aud: 'ios-client.apps.googleusercontent.com' }, 'subject_mismatch'],
    ['token issued to another app', { sub: 'google-sub', aud: 'other-app.apps.googleusercontent.com', azp: 'other-app.apps.googleusercontent.com' }, 'client_mismatch'],
    ['no audience at all', { sub: 'google-sub' }, 'client_mismatch'],
  ];
  for (const [label, info, expected] of cases) {
    let revokeCalled = false;
    const revoker = googleWith((url) => {
      if (url.endsWith('/revoke')) revokeCalled = true;
      return Response.json(info);
    });
    assertEquals(await revoker.revoke('t', ['google-sub']), expected, label);
    assertEquals(revokeCalled, false, label);
  }
});

Deno.test('Google revoke: Google errors and dead networks are "failed", never a throw', async () => {
  const failing: FakeGoogle[] = [
    () => new Response('{"error":"invalid_token"}', { status: 400 }),
    (url) =>
      url.includes('tokeninfo')
        ? Response.json({ sub: 'google-sub', aud: 'ios-client.apps.googleusercontent.com' })
        : new Response('{"error":"invalid_token"}', { status: 400 }),
    () => {
      throw new TypeError('network down');
    },
  ];
  for (const impl of failing) assertEquals(await googleWith(impl).revoke('t', ['google-sub']), 'failed');
});

Deno.test('Google config: comma-separated client ids, blanks ignored; none -> disabled', () => {
  assertEquals(googleRevokeConfigFromEnv({}), null);
  assertEquals(googleRevokeConfigFromEnv({ GOOGLE_CLIENT_IDS: ' , ' }), null);
  assertEquals(googleRevokeConfigFromEnv({ GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com, ios.apps.googleusercontent.com,' })?.clientIds, [
    'web.apps.googleusercontent.com',
    'ios.apps.googleusercontent.com',
  ]);
});

// -----------------------------------------------------------------------------
// Apple revocation

async function testConfig(): Promise<{ config: AppleRevokeConfig; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
  return {
    config: { teamId: 'TEAM123456', keyId: 'KEY1234567', clientId: 'com.davidyosef.audiotour', privateKeyPem: pem },
    publicKey: pair.publicKey,
  };
}

const b64urlDecode = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

const fakeIdToken = (sub: string): string =>
  `${btoa('{"alg":"RS256"}')}.${btoa(JSON.stringify({ sub })).replace(/=+$/, '')}.sig`;

Deno.test('Apple client_secret is a valid ES256 JWT with the claims Apple requires', async () => {
  const { config, publicKey } = await testConfig();
  const jwt = await appleClientSecret(config, 1_800_000_000);
  const [header, payload, signature] = jwt.split('.') as [string, string, string];

  assertEquals(JSON.parse(new TextDecoder().decode(b64urlDecode(header))), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  assertEquals(claims.iss, 'TEAM123456');
  assertEquals(claims.sub, 'com.davidyosef.audiotour');
  assertEquals(claims.aud, 'https://appleid.apple.com');
  assert(claims.exp > claims.iat && claims.exp - claims.iat <= 15_777_000, 'exp within Apple\'s six months');

  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    b64urlDecode(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  assert(valid, 'signature verifies with the matching public key');
  assert(!/[=+/]/.test(jwt), 'base64url, unpadded');
});

Deno.test('Apple revoke: exchanges the code, checks the subject, revokes the refresh token', async () => {
  const { config } = await testConfig();
  const calls: { url: string; form: URLSearchParams }[] = [];
  const revoker = createAppleRevoker(config, {
    log: () => {},
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(init?.body as URLSearchParams);
      calls.push({ url: String(url), form });
      if (String(url).endsWith('/auth/token')) {
        return Response.json({ refresh_token: 'rt-1', id_token: fakeIdToken('apple-sub') });
      }
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });

  assertEquals(await revoker.revoke('code-1', ['apple-sub']), 'revoked');
  assertEquals(calls.map((c) => c.url), ['https://appleid.apple.com/auth/token', 'https://appleid.apple.com/auth/revoke']);
  assertEquals(calls[0]!.form.get('grant_type'), 'authorization_code');
  assertEquals(calls[0]!.form.get('code'), 'code-1');
  assertEquals(calls[1]!.form.get('token'), 'rt-1');
  assertEquals(calls[1]!.form.get('token_type_hint'), 'refresh_token');
  assertEquals(calls[1]!.form.get('client_id'), 'com.davidyosef.audiotour');
  assert((calls[1]!.form.get('client_secret') ?? '').split('.').length === 3);
});

Deno.test('Apple revoke: another Apple ID\'s code is not revoked', async () => {
  const { config } = await testConfig();
  let revokeCalled = false;
  const revoker = createAppleRevoker(config, {
    log: () => {},
    fetch: (async (url: string | URL | Request) => {
      if (String(url).endsWith('/auth/revoke')) revokeCalled = true;
      return Response.json({ refresh_token: 'rt', id_token: fakeIdToken('someone-else') });
    }) as typeof fetch,
  });
  assertEquals(await revoker.revoke('code', ['apple-sub']), 'subject_mismatch');
  assertEquals(revokeCalled, false);
});

Deno.test('Apple revoke: Apple errors and dead networks are "failed", never a throw', async () => {
  const { config } = await testConfig();
  const failing = [
    async () => new Response('{"error":"invalid_grant"}', { status: 400 }),
    async (url: string | URL | Request) =>
      String(url).endsWith('/auth/token')
        ? Response.json({ refresh_token: 'rt', id_token: fakeIdToken('apple-sub') })
        : new Response(null, { status: 503 }),
    async () => {
      throw new TypeError('network down');
    },
  ];
  for (const impl of failing) {
    const revoker = createAppleRevoker(config, { log: () => {}, fetch: impl as typeof fetch });
    assertEquals(await revoker.revoke('code', ['apple-sub']), 'failed');
  }
});

Deno.test('Apple config: all four secrets or none; escaped newlines in the key are restored', () => {
  assertEquals(appleRevokeConfigFromEnv({}), null);
  assertEquals(appleRevokeConfigFromEnv({ APPLE_TEAM_ID: 't', APPLE_KEY_ID: 'k', APPLE_CLIENT_ID: 'c' }), null);
  const config = appleRevokeConfigFromEnv({
    APPLE_TEAM_ID: 't', APPLE_KEY_ID: 'k', APPLE_CLIENT_ID: 'c',
    APPLE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----',
  });
  assertEquals(config?.privateKeyPem, '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----');
});
