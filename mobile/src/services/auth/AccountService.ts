import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as AppleAuthentication from 'expo-apple-authentication';
import { Platform } from 'react-native';

import { raceTimeout } from '../../lib/timeout';
import { isSupabaseConfigured, supabase, supabaseEndpoint } from '../supabase/client';
import { runAccountDeletion, type AppleReauthentication, type DeleteAccountOutcome, type InvokeResult } from './accountDeletion';
import { configureGoogle, isGoogleSignInConfigured } from './AuthService';
import { lastKnownAccessToken, markSignedOutLocally, useAuth } from './authStore';
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

async function reauthenticateWithApple(): Promise<AppleReauthentication> {
  if (Platform.OS !== 'ios') return 'unavailable';
  try {
    if (!(await AppleAuthentication.isAvailableAsync())) return 'unavailable';
    // No scopes: this is a confirmation, and Apple would not resend the name anyway.
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    return credential.authorizationCode ? { authorizationCode: credential.authorizationCode } : 'unavailable';
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    // Backing out of the Apple sheet backs out of deleting.
    return code === 'ERR_REQUEST_CANCELED' ? 'cancelled' : 'unavailable';
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

/** Drops the stored session without supabase-js - no auth lock, no network. */
async function forceLocalSignOut(): Promise<void> {
  // storageKey is a public property at runtime; supabase-js only types it protected.
  const storageKey = (supabase.auth as unknown as { storageKey: string }).storageKey;
  try {
    await secureSessionStorage.removeItem(storageKey);
  } finally {
    // supabase-js re-reads storage on every getSession(), so with the item gone
    // it sees no session; the mirror is updated here because no event will fire.
    markSignedOutLocally();
  }
}

export function deleteAccount(): Promise<DeleteAccountOutcome> {
  return runAccountDeletion({
    provider: useAuth.getState().account?.provider ?? null,
    reauthenticateWithApple,
    invokeDelete,
    // `local`: the server session died with the user. supabase-js removes the
    // stored session even though the revoke call is now refused.
    signOutLocally: async () => {
      await supabase.auth.signOut({ scope: 'local' });
    },
    forceLocalSignOut,
    revokeGoogleAccess: async () => {
      if (!isGoogleSignInConfigured()) return;
      configureGoogle();
      // Ends this app's grant with Google, not just the local Google session.
      await GoogleSignin.revokeAccess();
    },
  });
}
