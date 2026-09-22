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

import { raceTimeout } from '../src/lib/timeout.ts';
import {
  runAccountDeletion,
  type AccountDeletionDeps,
  type AppleReauthentication,
  type DeleteAccountOutcome,
  type DeletionOptions,
  type InvokeResult,
} from '../src/services/auth/accountDeletion.ts';
import { accountFromSession, hasProvider, lastKnownAccessToken, startAuth, useAuth } from '../src/services/auth/authStore.ts';
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
  { id: 'user-1', email: 'x@privaterelay.appleid.com', provider: 'apple', providers: [], displayName: 'דוד יוסף' },
);
eq('Google puts the name in `name`', accountFromSession(session({ provider: 'google', meta: { name: 'Dana' } }))?.displayName, 'Dana');
{
  // Created with Google, later linked to Apple (same email): provider stays 'google'.
  const base = session({ provider: 'google' });
  const linked = accountFromSession({
    ...base,
    user: { ...base.user, app_metadata: { provider: 'google', providers: ['google', 'apple', 42] } },
  } as Session);
  eq('linked providers are read, junk dropped', linked?.providers, ['google', 'apple']);
  eq('hasProvider sees a LINKED Apple identity', [hasProvider(linked ?? null, 'apple'), hasProvider(linked ?? null, 'google')], [true, true]);
  eq('...and no identity for a guest', hasProvider(null, 'apple'), false);
}
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
assert(
  '...and remembers its access token as the lock-free fallback (device-QA fix)',
  (lastKnownAccessToken() ?? '').split('.').length === 3,
);
assert('...which is NOT in the rendered state', !JSON.stringify(useAuth.getState()).includes(lastKnownAccessToken() ?? '~'));
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
eq('...and the fallback token is forgotten with it', lastKnownAccessToken(), null);
eq('...and nothing is left in either store', [Object.keys(dumpAsync()), Object.keys(dumpKeychain())], [[], []]);

heading('raceTimeout');
{
  eq('a fast promise wins', await raceTimeout(Promise.resolve(7), 50), { timedOut: false, value: 7 });
  eq('a promise that never settles loses', await raceTimeout(new Promise(() => {}), 20), { timedOut: true });
  let rejected = false;
  try {
    await raceTimeout(Promise.reject(new Error('x')), 50);
  } catch {
    rejected = true;
  }
  assert('a rejection is passed through, not turned into a timeout', rejected);
}

// -----------------------------------------------------------------------------
heading('Account deletion flow (TASK-1104, hardened after device QA)');
// -----------------------------------------------------------------------------

type Behaviour<T> = T | 'hang' | 'throw';
const never = <T>(): Promise<T> => new Promise<T>(() => {});
/** Short budgets so the hang tests take milliseconds. Production: DELETION_TIMEOUTS. */
const FAST = { requestMs: 60, signOutMs: 40, googleRevokeMs: 40 };

function deletionHarness(opts: {
  provider: string | null;
  /** An extra LINKED identity (Supabase links identities that share an email). */
  linked?: string;
  apple?: Behaviour<AppleReauthentication>;
  invoke?: Behaviour<InvokeResult>;
  signOut?: 'ok' | 'hang' | 'throw';
  google?: 'ok' | 'hang' | 'throw';
  options?: DeletionOptions;
}) {
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const act = <T>(name: string, behaviour: Behaviour<T> | undefined, fallback: T): Promise<T> => {
    calls.push(name);
    if (behaviour === 'hang') return never<T>();
    if (behaviour === 'throw') return Promise.reject(new Error(`${name} exploded`));
    return Promise.resolve(behaviour ?? fallback);
  };
  const deps: AccountDeletionDeps = {
    appleIdentity: opts.provider === 'apple' || opts.linked === 'apple',
    googleIdentity: opts.provider === 'google' || opts.linked === 'google',
    reauthenticateWithApple: () => act('apple', opts.apple, { authorizationCode: 'apple-code' }),
    invokeDelete: (body, signal) => {
      bodies.push(body);
      signals.push(signal);
      const reason = typeof body.apple_authorization_code === 'string' ? 'scheduled' : 'no_code_in_request';
      return act('invoke', opts.invoke, {
        status: 200,
        data: { deleted: true, apple_revocation: reason === 'scheduled' ? 'scheduled' : 'not_attempted', apple_revocation_reason: reason },
      });
    },
    signOutLocally: () => act('signOut', opts.signOut === 'ok' ? undefined : opts.signOut, undefined),
    forceLocalSignOut: () => act('forceSignOut', undefined, undefined),
    revokeGoogleAccess: () => act('google', opts.google === 'ok' ? undefined : opts.google, undefined),
    options: opts.options,
    timeouts: FAST,
    log: () => {},
  };
  return { deps, calls, bodies, signals };
}

/** Runs the flow and measures it: the core property is that it always settles, fast. */
async function settle(deps: AccountDeletionDeps): Promise<{ outcome: DeleteAccountOutcome; ms: number }> {
  const started = Date.now();
  const outcome = await runAccountDeletion(deps);
  return { outcome, ms: Date.now() - started };
}

{
  const h = deletionHarness({ provider: 'google' });
  eq('Google: deleted', (await settle(h.deps)).outcome, { kind: 'deleted', appleCodeSent: false, appleRevocation: 'no_code_in_request' });
  eq('...server FIRST, then local sign-out; never Apple', h.calls.slice(0, 2), ['invoke', 'signOut']);
  eq('...and the body names no user', h.bodies, [{}]);
  await new Promise((r) => setTimeout(r, 5));
  assert('...Google access revoked afterwards, off the critical path', h.calls.includes('google'));
}
{
  const h = deletionHarness({ provider: 'apple' });
  eq('Apple: deleted, and says the code was sent', (await settle(h.deps)).outcome, { kind: 'deleted', appleCodeSent: true, appleRevocation: 'scheduled' });
  eq('...confirms with Apple before anything is sent', h.calls.slice(0, 2), ['apple', 'invoke']);
  eq('...and sends the fresh authorization code', h.bodies, [{ apple_authorization_code: 'apple-code' }]);
}
// --- SECOND DEVICE-QA PASS: a failed Apple sheet must never be silent -------------
// b89da6c returned { kind: 'cancelled' } for ERR_REQUEST_CANCELED, which the
// screen rendered as nothing: no request, no message, still signed in - and the
// next tap showed the Apple sheet again. iOS reports some of its own failures as
// .canceled, so "the user cancelled" cannot be assumed.
const APPLE_FAILURES: [string, AppleReauthentication, string][] = [
  ['canceled (user OR iOS)', { failure: 'cancelled', code: 'ERR_REQUEST_CANCELED' }, 'ERR_REQUEST_CANCELED'],
  ['failed', { failure: 'error', code: 'ERR_REQUEST_FAILED' }, 'ERR_REQUEST_FAILED'],
  ['unknown', { failure: 'error', code: 'ERR_REQUEST_UNKNOWN' }, 'ERR_REQUEST_UNKNOWN'],
  ['no authorization code', { failure: 'error', code: 'NO_AUTHORIZATION_CODE' }, 'NO_AUTHORIZATION_CODE'],
];
for (const [label, apple, code] of APPLE_FAILURES) {
  const h = deletionHarness({ provider: 'apple', apple });
  const { outcome } = await settle(h.deps);
  eq(`Apple sheet ${label}: an explicit failure, never silent`, outcome, { kind: 'failed', reason: 'apple_confirmation', detail: code });
  eq('...stopped BEFORE any request, and still signed in', h.calls, ['apple']);
}
{
  const h = deletionHarness({ provider: 'apple', apple: 'throw' });
  const { outcome } = await settle(h.deps);
  assert(
    'the Apple step throwing: apple_confirmation, not a silent skip past it',
    outcome.kind === 'failed' && outcome.reason === 'apple_confirmation' && (outcome.detail ?? '').startsWith('EXCEPTION'),
    JSON.stringify(outcome),
  );
  eq('...nothing sent', h.calls, ['apple']);
}
{
  // The way out of a sheet that keeps failing: one tap, no sheet.
  const h = deletionHarness({ provider: 'apple', apple: 'throw', options: { skipAppleConfirmation: true } });
  eq('"Delete without Apple": deleted, and says NO code was sent', (await settle(h.deps)).outcome, { kind: 'deleted', appleCodeSent: false, appleRevocation: 'no_code_in_request' });
  eq('...WITHOUT presenting the Apple sheet at all', h.calls.includes('apple'), false);
  eq('...and without a code (revocation is the only cost)', h.bodies, [{}]);
}
{
  const h = deletionHarness({ provider: 'apple', apple: 'unavailable' });
  eq('no Apple sheet on this device (Android): proceeds without a code', (await settle(h.deps)).outcome.kind, 'deleted');
  eq('...body', h.bodies, [{}]);
}
{
  // Exhaustive: whatever the Apple step does, the outcome is one the screen
  // renders - there is no outcome kind left that shows nothing.
  const kinds = new Set<string>();
  for (const apple of [...APPLE_FAILURES.map(([, a]) => a), 'unavailable', 'throw', { authorizationCode: 'c' }] as Behaviour<AppleReauthentication>[]) {
    kinds.add((await settle(deletionHarness({ provider: 'apple', apple }).deps)).outcome.kind);
  }
  eq('every Apple outcome is "deleted" or an explained "failed"', [...kinds].sort(), ['deleted', 'failed']);
}

// --- THIRD DEVICE-QA PASS (23 Sep): no Apple code, and a ghost session after 200 -----
{
  // An account created with Google and later linked to Apple: provider 'google',
  // providers ['google', 'apple']. dfa1dc9 looked only at provider -> no sheet, no code.
  const h = deletionHarness({ provider: 'google', linked: 'apple' });
  const { outcome } = await settle(h.deps);
  eq('LINKED Apple identity: the Apple sheet IS shown', h.calls[0], 'apple');
  eq('...and the code IS sent', h.bodies, [{ apple_authorization_code: 'apple-code' }]);
  eq('...and the outcome says so', outcome, { kind: 'deleted', appleCodeSent: true, appleRevocation: 'scheduled' });
}
{
  // After a 200 the session is a ghost: BOTH teardown steps must run, always.
  const h = deletionHarness({ provider: 'apple' });
  await settle(h.deps);
  eq('200: supabase-js sign-out AND the direct session drop both run, in that order', h.calls.slice(2), ['signOut', 'forceSignOut']);
}
{
  // supabase-js signOut RETURNS {error} instead of throwing; the wrapper now
  // throws it. Either way the session must still be dropped.
  const h = deletionHarness({ provider: 'google', signOut: 'throw' });
  eq('sign-out reports an error after a real deletion -> still "deleted"', (await settle(h.deps)).outcome.kind, 'deleted');
  assert('...and the session is dropped directly', h.calls.includes('forceSignOut'));
}
{
  const h = deletionHarness({ provider: 'google', invoke: { status: 401, data: null } });
  await settle(h.deps);
  eq('401 (session already dead): the same full teardown', h.calls.slice(1), ['signOut', 'forceSignOut']);
}
{
  const h = deletionHarness({ provider: 'apple', invoke: { status: 200, data: { deleted: true } } });
  eq('an older server without apple_revocation_reason -> null, not a crash', (await settle(h.deps)).outcome, { kind: 'deleted', appleCodeSent: true, appleRevocation: null });
}

// --- THE DEVICE-QA FAILURE: nothing may leave the screen waiting forever -------
{
  const h = deletionHarness({ provider: 'apple', invoke: 'hang' });
  const { outcome, ms } = await settle(h.deps);
  eq('HANG: a request that never answers -> timeout', outcome, { kind: 'failed', reason: 'timeout' });
  assert('...within the request budget', ms < FAST.requestMs + 150, `${ms} ms`);
  assert('...and the request is actually aborted, not just abandoned', h.signals[0]?.aborted === true);
  assert('...and the user stays signed in (the account may still exist)', !h.calls.includes('signOut') && !h.calls.includes('forceSignOut'));
}
{
  const h = deletionHarness({ provider: 'google', signOut: 'hang' });
  const { outcome, ms } = await settle(h.deps);
  eq('HANG: sign-out stalls after a real deletion -> still "deleted"', outcome.kind, 'deleted');
  assert('...within the sign-out budget', ms < FAST.signOutMs + 150, `${ms} ms`);
  assert('...and the session is dropped directly instead', h.calls.includes('forceSignOut'));
}
{
  const h = deletionHarness({ provider: 'google', signOut: 'throw' });
  eq('sign-out throws after a real deletion -> still "deleted"', (await settle(h.deps)).outcome.kind, 'deleted');
  assert('...session dropped directly', h.calls.includes('forceSignOut'));
}
{
  const h = deletionHarness({ provider: 'google', google: 'hang' });
  const { outcome, ms } = await settle(h.deps);
  eq('HANG: Google revoke never answers -> still "deleted"', outcome.kind, 'deleted');
  assert('...without waiting for Google at all', ms < FAST.googleRevokeMs, `${ms} ms`);
}
{
  const h = deletionHarness({ provider: 'google', invoke: { status: 401, data: null }, signOut: 'hang' });
  const { outcome, ms } = await settle(h.deps);
  eq('HANG: 401 then a stalled sign-out -> session_expired, promptly', outcome, { kind: 'failed', reason: 'session_expired' });
  assert('...bounded', ms < FAST.signOutMs * 2 + 150, `${ms} ms`);
}

// --- Every server answer maps to an outcome ------------------------------------
const cases: [string, InvokeResult | 'throw', DeleteAccountOutcome][] = [
  ['offline', { networkError: 'Network request failed' }, { kind: 'failed', reason: 'offline' }],
  ['403 admin', { status: 403, data: null }, { kind: 'failed', reason: 'admin_account' }],
  ['401 dead session', { status: 401, data: null }, { kind: 'failed', reason: 'session_expired' }],
  ['503 try_again (nothing deleted)', { status: 503, data: null }, { kind: 'failed', reason: 'server' }],
  ['504 deletion_unconfirmed', { status: 504, data: null }, { kind: 'failed', reason: 'timeout' }],
  ['500', { status: 500, data: null }, { kind: 'failed', reason: 'server' }],
  ['502 gateway', { status: 502, data: null }, { kind: 'failed', reason: 'server' }],
  ['200 but not deleted', { status: 200, data: { deleted: false } }, { kind: 'failed', reason: 'server' }],
  ['200 with a non-JSON body', { status: 200, data: null }, { kind: 'failed', reason: 'server' }],
  ['the request function throws', 'throw', { kind: 'failed', reason: 'server' }],
];
for (const [label, invoke, expected] of cases) {
  const h = deletionHarness({ provider: 'google', invoke });
  eq(`${label} -> ${expected.kind === 'failed' ? expected.reason : expected.kind}`, (await settle(h.deps)).outcome, expected);
  if (expected.kind === 'failed' && expected.reason !== 'session_expired') {
    assert('...and the device stays signed in', !h.calls.includes('signOut'));
  }
}

{
  // The invariant, bluntly: a dependency set where EVERYTHING misbehaves.
  const h = deletionHarness({ provider: 'apple', apple: 'throw', invoke: 'hang', signOut: 'throw', google: 'hang' });
  const { outcome, ms } = await settle(h.deps);
  assert('chaos: still settles, never rejects', outcome.kind === 'failed', JSON.stringify(outcome));
  assert('...inside the total budget', ms < FAST.requestMs + FAST.signOutMs * 2 + 200, `${ms} ms`);
}
{
  const throwsSync = { ...deletionHarness({ provider: 'google' }).deps, invokeDelete: () => { throw new Error('sync boom'); } };
  eq('a dependency that throws synchronously -> server, not a crash', (await settle(throwsSync as AccountDeletionDeps)).outcome, { kind: 'failed', reason: 'server' });
}

stop();
stopRefresh.mock.restore();
startRefresh.mock.restore();
warn.mock.restore();
await supabase.auth.stopAutoRefresh();

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
