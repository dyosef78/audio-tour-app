import type { Session } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';

import { supabase } from '../supabase/client';
import { utf8Decode } from './utf8';

/**
 * Who is signed in, if anyone (TASK-1102).
 *
 * Guest is the default and a first-class state, not an error (PM, Epic 11):
 * every grant and policy the app touches is written TO anon, authenticated, and
 * telemetry is keyed by device, so a guest can do everything a signed-in user
 * can. Nothing here gates navigation for that reason - the navigator waits on
 * preferences (one AsyncStorage read), never on a Keychain read and a decrypt.
 *
 * Not persisted by zustand: supabase-js owns the session and its storage
 * (secureSessionStorage.ts). This is only a render-friendly mirror of it.
 *
 * NOT AUTHORISATION. The account below is for display. "Signed in" grants
 * nothing on the server - see ARCHITECTURE.md on the `authenticated` role - and
 * user_metadata, where the display name lives, is writable by its own user.
 */

export type AuthStatus = 'restoring' | 'signed_out' | 'signed_in';

export interface Account {
  id: string;
  email: string | null;
  /**
   * app_metadata.provider: the provider the account was FIRST created with.
   * For display only - see `providers` for what the account can sign in with.
   */
  provider: string | null;
  /**
   * app_metadata.providers: every provider linked to the account. Supabase
   * links identities that share an email, so an account created with Google
   * and later used with Apple has provider 'google' but providers
   * ['google', 'apple']. Decisions about Apple/Google (deletion) use this.
   */
  providers: readonly string[];
  displayName: string | null;
}

/** Whether the account has an identity with this provider (primary or linked). */
export function hasProvider(account: Account | null, provider: string): boolean {
  return account !== null && (account.provider === provider || account.providers.includes(provider));
}

export interface AuthState {
  status: AuthStatus;
  account: Account | null;
}

export const useAuth = create<AuthState>(() => ({ status: 'restoring', account: null }));

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Pure. The fields the UI may show, from a session or its absence. */
export function accountFromSession(session: Session | null): Account | null {
  if (session === null) return null;
  const { user } = session;
  const meta: Record<string, unknown> = user.user_metadata ?? {};
  return {
    id: user.id,
    email: nonEmptyString(user.email),
    provider: nonEmptyString(user.app_metadata?.provider),
    providers: Array.isArray(user.app_metadata?.providers)
      ? (user.app_metadata.providers as unknown[]).filter((p): p is string => typeof p === 'string' && p !== '')
      : [],
    displayName: nonEmptyString(meta['full_name']) ?? nonEmptyString(meta['name']),
  };
}

/**
 * The access token from the last auth event, kept OUT of the zustand state so
 * it never reaches a render or a devtools dump.
 *
 * Why it exists (Epic 11 device-QA fix): supabase-js hands out tokens through
 * getSession(), which queues behind its auth lock - and a token refresh holds
 * that lock across network retries with no timeout. AccountService uses this
 * as the fallback when getSession() does not answer in time, so a stuck refresh
 * cannot stop an account from being deleted. The server re-verifies it anyway.
 */
let lastAccessToken: string | null = null;

export function lastKnownAccessToken(): string | null {
  return lastAccessToken;
}

/**
 * Accounts deleted in this process. A session for one of them is never applied
 * again - see markSignedOutLocally. User ids are uuids and never reused, so a
 * person who signs in again after deleting gets a new id and is unaffected.
 */
const tombstonedUserIds = new Set<string>();

/**
 * Sessions signed out in this process (Epic 12). Keyed by SESSION, not user:
 * the same person signing in again keeps their user id, and a user tombstone
 * would silently ignore that new sign-in for the rest of the process. GoTrue's
 * `session_id` claim survives token refreshes of one session and is new for
 * every sign-in, which is exactly the line between "late event for the session
 * we just ended" and "the user signed in again".
 */
const tombstonedSessionIds = new Set<string>();

/**
 * Pure. The `session_id` claim of a Supabase access token, or null. Decoded,
 * NOT verified - it only decides whether to IGNORE a session locally, which
 * grants nothing.
 */
export function sessionIdOf(accessToken: string | null | undefined): string | null {
  const payload = accessToken?.split('.')[1];
  if (!payload) return null;
  try {
    const binary = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const claims: unknown = JSON.parse(utf8Decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
    const id = (claims as { session_id?: unknown } | null)?.session_id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/** The session_id of the session the UI currently shows, if any. */
export function currentSessionId(): string | null {
  return sessionIdOf(lastAccessToken);
}

/**
 * Purge everything the UI reads about the session - SYNCHRONOUSLY, with no I/O.
 *
 * Why synchronous (Epic 11 device QA, 23 Sep): the UI reads this store, and
 * the account-route guard in RootNavigator subscribes to it. zustand notifies
 * subscribers inside setState, so when this returns, every screen and the guard
 * have already seen `signed_out`. Nothing can be rendered, or navigated to, in
 * between. The session on disk and inside supabase-js is dropped afterwards by
 * the caller; that part is async and may lag, but nothing the UI reads does.
 *
 * `tombstoneUserId` (account deletion): a token refresh that already held the
 * auth-js lock when the account was deleted still completes, saves a session
 * and emits TOKEN_REFRESHED before signOut() can run. Without the tombstone
 * that event would put the deleted account back on screen.
 *
 * `tombstoneSessionId` (sign-out, Epic 12): the same race, for a user who
 * still exists - so only that one session is refused, never a new sign-in.
 */
export function markSignedOutLocally(options: { tombstoneUserId?: string; tombstoneSessionId?: string } = {}): void {
  if (options.tombstoneUserId) tombstonedUserIds.add(options.tombstoneUserId);
  if (options.tombstoneSessionId) tombstonedSessionIds.add(options.tombstoneSessionId);
  lastAccessToken = null;
  useAuth.setState({ status: 'signed_out', account: null });
}

function apply(session: Session | null): void {
  let live = session;
  if (session !== null && tombstonedUserIds.has(session.user.id)) {
    // Loud, not silent: this is supabase-js still holding a deleted account.
    console.warn('[Auth] ignored a session for an account deleted on this device');
    live = null;
  } else if (session !== null && tombstonedSessionIds.has(sessionIdOf(session.access_token) ?? '')) {
    // Loud, not silent: a late event (e.g. TOKEN_REFRESHED) for a session signed out here.
    console.warn('[Auth] ignored a session that was signed out on this device');
    live = null;
  }
  lastAccessToken = live?.access_token ?? null;
  const account = accountFromSession(live);
  useAuth.setState({ status: account ? 'signed_in' : 'signed_out', account });
}

/**
 * Re-read the stored session and adopt it - but only on a clean answer.
 *
 * This is how a restore that failed transiently heals: a phone rebooted and
 * still locked makes the Keychain read throw, supabase-js reports no session
 * without deleting it, and the next foreground finds it. An `error` is ignored
 * rather than applied, or a walker offline with an expired access token would be
 * shown as signed out on every return to the app.
 */
async function recheck(): Promise<void> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return;
    apply(data.session);
  } catch (err) {
    console.warn('[Auth] could not re-read the session:', err);
  }
}

let stopAuth: (() => void) | null = null;

/**
 * Subscribe once, for the life of the process. Idempotent; returns the stopper.
 *
 * AppState drives the token ticker, as supabase-js asks of non-browser hosts:
 * left alone it refreshes forever, background included. Pausing it does not
 * strand a background request - getSession() refreshes an expired token on
 * demand - it only stops the idle wake-ups.
 */
export function startAuth(): () => void {
  if (stopAuth !== null) return stopAuth;

  // INITIAL_SESSION arrives once supabase-js has read storage, as null if that
  // read failed. The callback stays synchronous: supabase-js awaits it while
  // holding its session lock.
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => apply(session));

  const onAppState = (state: AppStateStatus): void => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
      void recheck();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  };
  const appStateSubscription = AppState.addEventListener('change', onAppState);

  stopAuth = () => {
    subscription.unsubscribe();
    appStateSubscription.remove();
    stopAuth = null;
  };
  return stopAuth;
}
