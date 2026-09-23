import { GoogleSignin } from '@react-native-google-signin/google-signin';

import { supabase } from '../supabase/client';
import { configureGoogle, isGoogleSignInConfigured } from './AuthService';
import { currentSessionId, markSignedOutLocally, useAuth } from './authStore';
import { TEARDOWN_TIMEOUTS, tearDownLocalSession, type LocalTeardown, type TeardownSteps } from './localTeardown';
import { secureSessionStorage } from './secureSessionStorage';

/**
 * The real platform calls behind localTeardown.ts, and the Settings sign-out
 * (Epic 12). Account deletion (AccountService.ts) uses the same steps with a
 * USER tombstone; sign-out tombstones only the SESSION, because the person may
 * sign straight back in.
 */

/**
 * supabase-js sign-out, `local` scope: signing out on a phone should not end
 * the user's other sessions. supabase-js RETURNS its error rather than
 * throwing; ignoring it is what let a failed sign-out look successful (device
 * QA, 23 Sep), so it is thrown here and the teardown drops the session anyway.
 */
export async function signOutLocally(): Promise<void> {
  const { error } = await supabase.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

/**
 * Removes the stored session without supabase-js - no auth lock, no network.
 * Storage only: the UI state is purged separately and synchronously first, so
 * a slow Keychain can never keep an old session on screen.
 */
export async function dropStoredSession(): Promise<void> {
  // storageKey is a public property at runtime; supabase-js only types it protected.
  const storageKey = (supabase.auth as unknown as { storageKey: string }).storageKey;
  // supabase-js re-reads storage on every getSession(), so with the item gone
  // it sees no session.
  await secureSessionStorage.removeItem(storageKey);
}

/** So the next Google sign-in offers the account chooser. Local to the SDK; no grant is touched. */
export async function signOutProviders(): Promise<void> {
  if (!isGoogleSignInConfigured()) return;
  configureGoogle();
  await GoogleSignin.signOut();
}

export function teardownSteps(tombstone: { userId?: string; sessionId?: string }): TeardownSteps {
  return {
    purgeAuthState: () => markSignedOutLocally({ tombstoneUserId: tombstone.userId, tombstoneSessionId: tombstone.sessionId }),
    signOutLocally,
    dropStoredSession,
    signOutProviders,
  };
}

/**
 * Signs out THIS device and returns the app to guest, in bounded time
 * (at most 2 x TEARDOWN_TIMEOUTS.signOutMs) and without ever rejecting.
 *
 * The UI is signed out before this function's first await, so the caller's
 * screen re-renders as guest immediately; the promise only reports how cleanly
 * the rest went. 'incomplete' means the stored session may still be on disk and
 * could reappear at the next launch - the caller must say so.
 *
 * When supabase-js cannot reach the server, the refresh token is forgotten on
 * this device but not revoked, until it expires server-side.
 */
export async function signOut(): Promise<LocalTeardown> {
  const signedIn = useAuth.getState().status === 'signed_in';
  const sessionId = currentSessionId();
  if (signedIn && sessionId === null) {
    // Without a session id a late TOKEN_REFRESHED could still reach the UI.
    console.warn('[Auth] signing out a session with no session_id claim; it is not tombstoned');
  }
  const outcome = await tearDownLocalSession(teardownSteps({ sessionId: sessionId ?? undefined }), TEARDOWN_TIMEOUTS, (message) =>
    console.warn(`[Auth] sign-out: ${message}`),
  );
  if (outcome !== 'clean') console.warn(`[Auth] sign-out finished ${outcome}`);
  return outcome;
}
