/**
 * TASK-1102 - encrypted session storage and the auth mirror.
 *
 * Runs the REAL SecureSessionStorage, authStore and supabase-js client in Node.
 * SecureStore is an in-memory stub that can throw like a locked Keychain;
 * expo-crypto is AES-GCM on node:crypto, so tampering fails for real. No
 * network: the one call that tries (sign-out) is meant to fail to connect.
 *
 * Run:  npm run test:auth
 */

import { mock } from 'node:test';

import type { Session } from '@supabase/supabase-js';

import {
  runAccountDeletion,
  type AccountDeletionDeps,
  type AppleReauthentication,
  type InvokeResult,
} from '../src/services/auth/accountDeletion.ts';
import { accountFromSession, startAuth, useAuth } from '../src/services/auth/authStore.ts';
import {
  ciphertextKeyFor,
  keychainKeyFor,
  SecureSessionStorage,
} from '../src/services/auth/secureSessionStorage.ts';
import { utf8Decode, utf8Encode } from '../src/services/auth/utf8.ts';
import { supabase } from '../src/services/supabase/client.ts';
import AsyncStorage, { __dump as dumpAsync, __reset as resetAsync } from './stubs/async-storage.ts';
import {
  __calls as keychainCalls,
  __dump as dumpKeychain,
  __reset as resetKeychain,
  __setFailReads as setKeychainFailReads,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  deleteItemAsync,
} from './stubs/expo-secure-store.ts';
import { __emitAppState } from './stubs/react-native.ts';

let failures = 0;
let checks = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, a === e ? undefined : `got ${a}, expected ${e}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

async function rejects(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    assert(label, false, 'resolved');
  } catch {
    assert(label, true);
  }
}

const warn = mock.method(console, 'warn', () => {});

// -----------------------------------------------------------------------------
heading('UTF-8 codec matches the platform');
// -----------------------------------------------------------------------------

const samples = ['', 'ascii', 'דוד יוסף', 'Café ☕', 'emoji 🗺️👨‍👩‍👧', 'lone \ud800 surrogate', 'tail \udc00', 'x'.repeat(5000)];
for (const text of samples) {
  const label = JSON.stringify(text.slice(0, 20));
  eq(`encode ${label}`, [...utf8Encode(text)], [...new TextEncoder().encode(text)]);
  eq(`round trip ${label}`, utf8Decode(utf8Encode(text)), new TextDecoder().decode(new TextEncoder().encode(text)));
}
eq('a truncated sequence decodes to U+FFFD, never throws', utf8Decode(Uint8Array.from([0x61, 0xe2, 0x82])), 'a�');

// -----------------------------------------------------------------------------
heading('SecureSessionStorage');
// -----------------------------------------------------------------------------

const NAME = 'sb-testproject-auth-token';
const REFRESH = 'refresh-token-that-must-never-be-stored-in-plaintext';
const bigSession = JSON.stringify({
  access_token: 'a'.repeat(1200),
  refresh_token: REFRESH,
  user: { user_metadata: { full_name: 'דוד יוסף', avatar: 'b'.repeat(1500) } },
});
assert('the fixture is past the ~2048-byte SecureStore ceiling', utf8Encode(bigSession).length > 2048);

let storage = new SecureSessionStorage();
await storage.setItem(NAME, bigSession);
eq('round trip', await storage.getItem(NAME), bigSession);

const envelope = dumpAsync()[ciphertextKeyFor(NAME)] ?? '';
assert('ciphertext is versioned', envelope.startsWith('v1:'));
assert('no plaintext token in AsyncStorage', !JSON.stringify(dumpAsync()).includes(REFRESH));
assert('no plaintext name in AsyncStorage', !JSON.stringify(dumpAsync()).includes('יוסף'));
eq('exactly one keychain entry, under a legal name', Object.keys(dumpKeychain()), [keychainKeyFor(NAME)]);
assert('keychain value is small (a key, not a session)', (dumpKeychain()[keychainKeyFor(NAME)] ?? '').length < 64);
assert(
  'EVERY keychain call uses AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (readable by the locked-phone tour)',
  keychainCalls.length > 0 &&
    keychainCalls.every((c) => c.options?.keychainAccessible === AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY),
);
eq('an illegal storage-key character is mapped, not passed to the Keychain', keychainKeyFor('sb:a/b auth'), 'session-key.sb_a_b_auth');

keychainCalls.length = 0;
await storage.setItem(NAME, bigSession);
eq('a token refresh reuses the cached key - no keychain traffic', keychainCalls.length, 0);
assert('...under a fresh IV', dumpAsync()[ciphertextKeyFor(NAME)] !== envelope);

storage = new SecureSessionStorage(); // relaunch: empty key cache
eq('a relaunch reads the session back', await storage.getItem(NAME), bigSession);

// Transient: the phone rebooted and has not been unlocked yet.
storage = new SecureSessionStorage();
setKeychainFailReads(true);
await rejects('a locked keychain REJECTS rather than reporting no session', () => storage.getItem(NAME));
setKeychainFailReads(false);
assert('...and the session is not discarded', dumpAsync()[ciphertextKeyFor(NAME)] !== undefined);
eq('...so it reads once the phone is unlocked', await storage.getItem(NAME), bigSession);

// Permanent: restored from a backup that carried AsyncStorage but not the key.
await deleteItemAsync(keychainKeyFor(NAME));
storage = new SecureSessionStorage();
eq('ciphertext without its key -> no session', await storage.getItem(NAME), null);
eq('...and the orphan ciphertext is cleared', dumpAsync()[ciphertextKeyFor(NAME)], undefined);

// Tampering.
storage = new SecureSessionStorage();
await storage.setItem(NAME, bigSession);
const sealed = dumpAsync()[ciphertextKeyFor(NAME)] ?? '';
const bytes = Buffer.from(sealed.slice(3), 'base64');
bytes[20] = (bytes[20] ?? 0) ^ 0xff;
await AsyncStorage.setItem(ciphertextKeyFor(NAME), `v1:${bytes.toString('base64')}`);
storage = new SecureSessionStorage();
eq('a flipped ciphertext byte fails authentication -> no session', await storage.getItem(NAME), null);
eq('...both halves cleared', [dumpAsync()[ciphertextKeyFor(NAME)], dumpKeychain()[keychainKeyFor(NAME)]], [undefined, undefined]);

// A blob moved under another storage key, even one sharing the same AES key, is refused.
resetAsync();
resetKeychain();
storage = new SecureSessionStorage();
await storage.setItem('other-key', 'other');
await storage.setItem(NAME, bigSession);
const otherKey = dumpKeychain()[keychainKeyFor('other-key')];
if (otherKey !== undefined) {
  const { setItemAsync } = await import('./stubs/expo-secure-store.ts');
  await setItemAsync(keychainKeyFor(NAME), otherKey);
  await AsyncStorage.setItem(ciphertextKeyFor(NAME), dumpAsync()[ciphertextKeyFor('other-key')] ?? '');
}
storage = new SecureSessionStorage();
eq('a blob replayed under another name fails the bound AAD', await storage.getItem(NAME), null);

// The pre-TASK-1102 format, and anything else unrecognised.
await AsyncStorage.setItem(ciphertextKeyFor(NAME), bigSession);
eq('an unversioned value is discarded, not guessed at', await new SecureSessionStorage().getItem(NAME), null);

// Concurrency: two first writes must not mint two keys.
resetAsync();
resetKeychain();
storage = new SecureSessionStorage();
await Promise.all([storage.setItem(NAME, 'one'), storage.setItem(NAME, 'two')]);
eq('concurrent first writes create ONE key', keychainCalls.filter((c) => c.op === 'set').length, 1);
assert('...and either write reads back', ['one', 'two'].includes((await new SecureSessionStorage().getItem(NAME)) ?? ''));

await storage.removeItem(NAME);
eq('removeItem clears both halves', [Object.keys(dumpAsync()), Object.keys(dumpKeychain())], [[], []]);
eq('a missing session is null', await storage.getItem(NAME), null);

// -----------------------------------------------------------------------------
heading('accountFromSession');
// -----------------------------------------------------------------------------

function session(overrides: { email?: string; provider?: string; meta?: Record<string, unknown> } = {}): Session {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'user-1', exp: now + 3600, role: 'authenticated' })}.sig`,
    refresh_token: 'refresh-1',
    expires_in: 3600,
    expires_at: now + 3600,
    token_type: 'bearer',
    user: {
      id: 'user-1',
      aud: 'authenticated',
      created_at: new Date().toISOString(),
      email: overrides.email,
      app_metadata: { provider: overrides.provider ?? 'apple' },
      user_metadata: overrides.meta ?? {},
    },
  } as Session;
}

eq('no session -> no account', accountFromSession(null), null);
eq(
  'Apple user with a saved name',
  accountFromSession(session({ email: 'x@privaterelay.appleid.com', meta: { full_name: 'דוד יוסף' } })),
  { id: 'user-1', email: 'x@privaterelay.appleid.com', provider: 'apple', displayName: 'דוד יוסף' },
);
eq('Google puts the name in `name`', accountFromSession(session({ provider: 'google', meta: { name: 'Dana' } }))?.displayName, 'Dana');
eq('a blank or non-string name is no name', accountFromSession(session({ meta: { full_name: '  ', name: 42 } }))?.displayName, null);

// -----------------------------------------------------------------------------
heading('authStore against the real supabase-js client');
// -----------------------------------------------------------------------------

resetAsync();
resetKeychain();
const storageKey = (supabase.auth as unknown as { storageKey: string }).storageKey;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

eq('starts as restoring', useAuth.getState().status, 'restoring');
const stop = startAuth();
assert('startAuth is idempotent', startAuth() === stop);
for (let i = 0; i < 50 && useAuth.getState().status === 'restoring'; i++) await flush();
eq('no stored session -> guest (signed_out)', useAuth.getState(), { status: 'signed_out', account: null });

// A session lands in storage while the app is backgrounded; foreground finds it.
const stopRefresh = mock.method(supabase.auth, 'stopAutoRefresh', async () => {});
const startRefresh = mock.method(supabase.auth, 'startAutoRefresh', async () => {});
__emitAppState('background');
eq('background pauses the token ticker', stopRefresh.mock.callCount(), 1);

await new SecureSessionStorage().setItem(
  storageKey,
  JSON.stringify(session({ email: 'walker@example.com', meta: { full_name: 'Walker' } })),
);
__emitAppState('active');
eq('foreground resumes the token ticker', startRefresh.mock.callCount(), 1);
for (let i = 0; i < 50 && useAuth.getState().status !== 'signed_in'; i++) await flush();
eq('...and adopts the stored session', useAuth.getState().account?.displayName, 'Walker');
assert('the session in storage is encrypted', !JSON.stringify(dumpAsync()).includes('walker@example.com'));

// A recheck that errors (offline, expired token) must not sign anyone out.
const getSession = mock.method(supabase.auth, 'getSession', async () => ({
  data: { session: null },
  error: new Error('simulated: network down during refresh'),
}));
__emitAppState('active');
await flush();
eq('an erroring recheck leaves a signed-in user signed in', useAuth.getState().status, 'signed_in');
getSession.mock.restore();

// Sign-out with no reachable server: supabase-js must still drop the session.
const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
assert('sign-out could not reach the (placeholder) server', signOutError !== null);
for (let i = 0; i < 50 && useAuth.getState().status !== 'signed_out'; i++) await flush();
eq('...yet the device is signed out', useAuth.getState(), { status: 'signed_out', account: null });
eq('...and nothing is left in either store', [Object.keys(dumpAsync()), Object.keys(dumpKeychain())], [[], []]);

// -----------------------------------------------------------------------------
heading('Account deletion flow (TASK-1104)');
// -----------------------------------------------------------------------------

function deletionHarness(opts: {
  provider: string | null;
  apple?: AppleReauthentication;
  invoke?: InvokeResult;
  signOutThrows?: boolean;
}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const deps: AccountDeletionDeps = {
    provider: opts.provider,
    reauthenticateWithApple: async () => {
      calls.push('apple');
      return opts.apple ?? { authorizationCode: 'apple-code' };
    },
    invokeDelete: async (body) => {
      calls.push('invoke');
      bodies.push(body);
      return opts.invoke ?? { status: 200, data: { deleted: true, apple_token_revoked: null } };
    },
    signOutLocally: async () => {
      calls.push('signOut');
      if (opts.signOutThrows) throw new Error('storage gone');
    },
    revokeGoogleAccess: async () => {
      calls.push('google');
    },
    log: () => {},
  };
  return { deps, calls, bodies };
}

{
  const h = deletionHarness({ provider: 'google' });
  eq('Google: deleted', await runAccountDeletion(h.deps), { kind: 'deleted', appleTokenRevoked: null });
  eq('...server FIRST, then local sign-out, then Google revoke; never Apple', h.calls, ['invoke', 'signOut', 'google']);
  eq('...and the body names no user', h.bodies, [{}]);
}
{
  const h = deletionHarness({ provider: 'apple', invoke: { status: 200, data: { deleted: true, apple_token_revoked: true } } });
  eq('Apple: deleted, revocation reported', await runAccountDeletion(h.deps), { kind: 'deleted', appleTokenRevoked: true });
  eq('...confirms with Apple before anything is sent', h.calls, ['apple', 'invoke', 'signOut']);
  eq('...and sends the fresh authorization code', h.bodies, [{ apple_authorization_code: 'apple-code' }]);
}
{
  const h = deletionHarness({ provider: 'apple', apple: 'cancelled' });
  eq('Apple: backing out of the Apple sheet cancels', await runAccountDeletion(h.deps), { kind: 'cancelled' });
  eq('...with nothing sent and nothing signed out', h.calls, ['apple']);
}
{
  const h = deletionHarness({ provider: 'apple', apple: 'unavailable' });
  eq('Apple account on Android: still deletable', (await runAccountDeletion(h.deps)).kind, 'deleted');
  eq('...without a code', h.bodies, [{}]);
}
{
  const h = deletionHarness({ provider: 'google', invoke: { networkError: 'Failed to fetch' } });
  eq('offline: failed, reason offline', await runAccountDeletion(h.deps), { kind: 'failed', reason: 'offline' });
  eq('...and still signed in - nothing changed', h.calls, ['invoke']);
}
{
  const h = deletionHarness({ provider: 'google', invoke: { status: 403, data: null } });
  eq('CMS admin: refused', await runAccountDeletion(h.deps), { kind: 'failed', reason: 'admin_account' });
  eq('...and left signed in', h.calls, ['invoke']);
}
{
  const h = deletionHarness({ provider: 'google', invoke: { status: 401, data: null } });
  eq('dead session (e.g. already deleted): session_expired', await runAccountDeletion(h.deps), { kind: 'failed', reason: 'session_expired' });
  eq('...and the useless local session is dropped, but Google is not revoked', h.calls, ['invoke', 'signOut']);
}
for (const invoke of [
  { status: 500, data: null },
  { status: 502, data: null },
  { status: 200, data: { deleted: false } },
  { status: 200, data: 'ok' },
] as InvokeResult[]) {
  const h = deletionHarness({ provider: 'google', invoke });
  eq(`server answer ${JSON.stringify(invoke)} is a failure, never "deleted"`, await runAccountDeletion(h.deps), { kind: 'failed', reason: 'server' });
  eq('...and nothing local is touched', h.calls, ['invoke']);
}
{
  const h = deletionHarness({ provider: 'google', signOutThrows: true });
  eq('a local sign-out error after a real deletion is still "deleted"', (await runAccountDeletion(h.deps)).kind, 'deleted');
}

stop();
stopRefresh.mock.restore();
startRefresh.mock.restore();
warn.mock.restore();
await supabase.auth.stopAutoRefresh();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
