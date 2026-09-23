import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { AppState, InteractionManager, Platform } from 'react-native';

import { describeError } from '../../lib/describeError';
import { raceTimeout } from '../../lib/timeout';
import { isSupabaseConfigured, supabase, supabaseEndpoint } from '../supabase/client';
import {
  runAccountDeletion,
  type AppleReauthentication,
  type DeleteAccountOutcome,
  type DeletionOptions,
  type InvokeResult,
} from './accountDeletion';
import { configureGoogle, isGoogleSignInConfigured } from './AuthService';
import { hasProvider, lastKnownAccessToken, markSignedOutLocally, useAuth } from './authStore';
import { secureSessionStorage } from './secureSessionStorage';

/**
 * Account deletion with the real platform calls (TASK-1104). The decisions,
 * and the timeouts that make them safe, are in accountDeletion.ts.
 *
 * WHY THE REQUEST DOES NOT USE supabase.functions.invoke (Epic 11 device QA).
 * invoke() sends through supabase-js's fetch wrapper, which first awaits
 * auth.getSession(). That queues behind the auth lock, and a token refresh
 * holds the lock across up to 30 s of network retries with no request timeout
 * - and closing the Apple sheet flips AppState back to active, which is exactly
 * when authStore asks for a session check. invoke()'s own `timeout` only arms
 * the fetch, which never starts while the lock is held. So the phone could wait
 * indefinitely without the request ever leaving it: a frozen screen and an
 * account that still exists.
 *
 * Here the token comes from getSession() only if it answers quickly, else from
 * the last auth event, and the request goes out with plain fetch and a real
 * AbortSignal.
 */

const DELETE_FUNCTION = 'delete-account';
/** How long getSession() gets before the last known token is used instead. */
const SESSION_LOOKUP_MS = 2_500;

/** How long to wait for the app to be active and idle before presenting the Apple sheet. */
const PRESENT_READY_MS = 1_500;

/**
 * Resolve once nothing native is mid-transition: the app is `active` (not
 * `inactive` behind a system UI) and React Native has finished pending
 * interactions and animations. Bounded - a stuck AppState must not block the
 * sheet forever; it is presented anyway after PRESENT_READY_MS.
 *
 * Replaces a fixed 300 ms wait after a UIAlertController. The initial Apple
 * sign-in - which works - is presented from a plain button tap; the failing
 * re-auth was presented straight after an alert's dismissal. Device QA,
 * 23 Sep: sheet hung or re-prompted after Face ID on that path.
 */
async function readyToPresentSystemSheet(): Promise<void> {
  if (AppState.currentState !== 'active') {
    let sub: { remove: () => void } | undefined;
    try {
      await raceTimeout(
        new Promise<void>((resolve) => {
          sub = AppState.addEventListener('change', (state) => {
            if (state === 'active') resolve();
          });
        }),
        PRESENT_READY_MS,
      );
    } finally {
      // Removed on success AND on timeout, so a stuck wait leaves no listener behind.
      sub?.remove();
    }
  }
  await raceTimeout(
    new Promise<void>((resolve) => {
      InteractionManager.runAfterInteractions(() => resolve());
    }),
    PRESENT_READY_MS,
  );
}

/**
 * One Apple sheet, one answer. Only "this device has no Apple sheet" is
 * 'unavailable' (the flow then proceeds without a code, as on Android). Every
 * failure of a sheet that WAS shown carries iOS's code, its message, and how
 * long the sheet was up.
 *
 * The request itself is deliberately minimal and is the SAME native call as
 * the working sign-in (signInAsync -> requestAsync, operation LOGIN):
 * - requestedScopes: [] - an existing authorisation never re-sends name or
 *   email, and asking for nothing cannot be an "invalid scope".
 * - no nonce - it binds an ID token to a server-side check; the code exchange
 *   in delete-account does not use it, and it has no effect on the sheet.
 */
async function reauthenticateWithApple(): Promise<AppleReauthentication> {
  if (Platform.OS !== 'ios') return 'unavailable';
  let available: boolean;
  try {
    available = await AppleAuthentication.isAvailableAsync();
  } catch {
    available = false;
  }
  if (!available) return 'unavailable';

  await readyToPresentSystemSheet();
  const started = Date.now();
  try {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return credential.authorizationCode
      ? { authorizationCode: credential.authorizationCode }
      : { failure: 'error', code: 'NO_AUTHORIZATION_CODE', elapsedMs: Date.now() - started };
  } catch (err) {
    const { code, message } = describeError(err);
    // iOS reports some system failures as .canceled too, so this is NOT treated
    // as the user's final word - the screen explains and offers a way forward.
    return {
      failure: code === 'ERR_REQUEST_CANCELED' ? 'cancelled' : 'error',
      code,
      message,
      elapsedMs: Date.now() - started,
    };
  }
}

/** A token for the request, without ever waiting indefinitely on the auth lock. */
async function accessTokenForRequest(): Promise<string | null> {
  const raced = await raceTimeout(supabase.auth.getSession(), SESSION_LOOKUP_MS);
  if (!raced.timedOut) {
    const { data, error } = raced.value;
    if (!error) return data.session?.access_token ?? null;
  }
  // Lock busy or storage unreadable: use what the last auth event carried. If it
  // has expired, the server says 401 and the flow signs out cleanly.
  return lastKnownAccessToken();
}

async function invokeDelete(body: Record<string, unknown>, signal: AbortSignal): Promise<InvokeResult> {
  if (!isSupabaseConfigured) return { networkError: 'Supabase is not configured' };
  const token = await accessTokenForRequest();
  if (!token) return { status: 401, data: null };

  try {
    const response = await fetch(`${supabaseEndpoint.url}/functions/v1/${DELETE_FUNCTION}`, {
      method: 'POST',
      headers: {
        apikey: supabaseEndpoint.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      // A gateway error page is not JSON; the status still says what happened.
    }
    const requestId = response.headers.get('x-request-id');
    if (response.status !== 200 && requestId) console.warn(`[Account] delete-account ${response.status}, request ${requestId}`);
    return { status: response.status, data };
  } catch (err) {
    // An abort lands here too; runAccountDeletion has already answered `timeout`.
    return { networkError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Removes the stored session without supabase-js - no auth lock, no network.
 * Storage only: the UI state is purged separately and synchronously first
 * (purgeAuthState), so a slow Keychain can never keep a deleted account on screen.
 */
async function dropStoredSession(): Promise<void> {
  // storageKey is a public property at runtime; supabase-js only types it protected.
  const storageKey = (supabase.auth as unknown as { storageKey: string }).storageKey;
  // supabase-js re-reads storage on every getSession(), so with the item gone
  // it sees no session.
  await secureSessionStorage.removeItem(storageKey);
}

export function deleteAccount(options: DeletionOptions = {}): Promise<DeleteAccountOutcome> {
  const account = useAuth.getState().account;
  return runAccountDeletion({
    // Linked identities count: see AccountDeletionDeps.appleIdentity.
    appleIdentity: hasProvider(account, 'apple'),
    googleIdentity: hasProvider(account, 'google'),
    options,
    reauthenticateWithApple,
    invokeDelete,
    // `local`: the server session died with the user. supabase-js removes the
    // stored session even though the revoke call is now refused.
    // Captured NOW: by the time the purge runs, the store no longer holds the account.
    purgeAuthState: () => markSignedOutLocally({ tombstoneUserId: account?.id }),
    signOutLocally: async () => {
      // supabase-js RETURNS its error rather than throwing. Ignoring it is what
      // let a failed sign-out look successful (device QA, 23 Sep); the flow now
      // drops the session directly afterwards regardless.
      const { error } = await supabase.auth.signOut({ scope: 'local' });
      if (error) throw error;
    },
    dropStoredSession,
    revokeGoogleAccess: async () => {
      if (!isGoogleSignInConfigured()) return;
      configureGoogle();
      // Ends this app's grant with Google, not just the local Google session.
      await GoogleSignin.revokeAccess();
    },
  });
}
