/**
 * TASK-1104 - delete-account handler and Apple token revocation, with GoTrue,
 * the database and Apple faked. No network, no Supabase, no Apple key.
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
import { handleDeleteAccount, type AuthenticatedUser, type DeleteAccountDeps } from './handler.ts';

const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';

interface Harness {
  deps: DeleteAccountDeps;
  deleted: string[];
  revokes: { code: string; subjects: readonly string[] }[];
  logs: Record<string, unknown>[];
}

function harness(
  options: {
    user?: AuthenticatedUser | null;
    admins?: string[];
    deleteResult?: 'deleted' | 'not_found' | Error;
    revoker?: 'revoked' | 'failed' | 'subject_mismatch' | null;
  } = {},
): Harness {
  const deleted: string[] = [];
  const revokes: Harness['revokes'] = [];
  const logs: Record<string, unknown>[] = [];
  const user = options.user === undefined ? { id: USER, appleSubjects: [] } : options.user;
  const revoker: AppleRevoker | null =
    options.revoker === null || options.revoker === undefined
      ? null
      : {
          revoke: async (code, subjects) => {
            revokes.push({ code, subjects });
            return options.revoker as 'revoked' | 'failed' | 'subject_mismatch';
          },
        };
  const deps: DeleteAccountDeps = {
    authenticate: async (request) => (request.headers.get('Authorization') === 'Bearer user-token' ? user : null),
    isCmsAdmin: async (id) => (options.admins ?? []).includes(id),
    deleteUser: async (id) => {
      if (options.deleteResult instanceof Error) throw options.deleteResult;
      deleted.push(id);
      return options.deleteResult ?? 'deleted';
    },
    appleRevoker: revoker,
    log: (e) => logs.push(e),
  };
  return { deps, deleted, revokes, logs };
}

const post = (body?: unknown, token = 'user-token'): Request =>
  new Request('http://localhost/delete-account', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

// -----------------------------------------------------------------------------
// Handler

Deno.test('a signed-in user deletes their own account', async () => {
  const h = harness();
  const res = await handleDeleteAccount(post(), h.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { deleted: true, apple_token_revoked: null });
  assertEquals(h.deleted, [USER]);
  assertEquals(res.headers.get('Cache-Control'), 'no-store');
});

Deno.test('the account deleted is the TOKEN\'s, whatever the body says', async () => {
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
  const h = harness({ admins: [USER], revoker: 'revoked', user: { id: USER, appleSubjects: ['apple-sub'] } });
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

Deno.test('Apple: revoked before deletion, against the account\'s own Apple identities', async () => {
  const h = harness({ revoker: 'revoked', user: { id: USER, appleSubjects: ['apple-sub'] } });
  const res = await handleDeleteAccount(post({ apple_authorization_code: 'fresh-code' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).apple_token_revoked, true);
  assertEquals(h.revokes, [{ code: 'fresh-code', subjects: ['apple-sub'] }]);
  assertEquals(h.deleted, [USER]);
});

Deno.test('Apple: a failed or mismatched revocation still deletes the account', async () => {
  for (const outcome of ['failed', 'subject_mismatch'] as const) {
    const h = harness({ revoker: outcome, user: { id: USER, appleSubjects: ['apple-sub'] } });
    const res = await handleDeleteAccount(post({ apple_authorization_code: 'code' }), h.deps);
    assertEquals(res.status, 200, outcome);
    assertEquals((await res.json()).apple_token_revoked, false, outcome);
    assertEquals(h.deleted, [USER], outcome);
  }
});

Deno.test('Apple: not attempted without a code, a revoker, or an Apple identity', async () => {
  const cases: [string, Harness, unknown][] = [
    ['no code', harness({ revoker: 'revoked', user: { id: USER, appleSubjects: ['s'] } }), {}],
    ['not configured', harness({ revoker: null, user: { id: USER, appleSubjects: ['s'] } }), { apple_authorization_code: 'c' }],
    ['google user', harness({ revoker: 'revoked', user: { id: USER, appleSubjects: [] } }), { apple_authorization_code: 'c' }],
  ];
  for (const [label, h, body] of cases) {
    const res = await handleDeleteAccount(post(body), h.deps);
    assertEquals(res.status, 200, label);
    assertEquals((await res.json()).apple_token_revoked, null, label);
    assertEquals(h.revokes, [], label);
  }
});

Deno.test('malformed bodies -> 400 without deleting; method and CORS', async () => {
  for (const body of ['{', '[]', '"x"', { apple_authorization_code: 42 }, { apple_authorization_code: '' }, 'x'.repeat(9000)]) {
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

Deno.test('the log never carries an email, name or token', async () => {
  const h = harness({ revoker: 'revoked', user: { id: USER, appleSubjects: ['apple-sub'] } });
  await handleDeleteAccount(post({ apple_authorization_code: 'secret-code' }), h.deps);
  const text = JSON.stringify(h.logs);
  assert(!text.includes('secret-code') && !text.includes('user-token') && !text.includes('apple-sub'), text);
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
