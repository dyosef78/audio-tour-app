import type { Session } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';

import { supabase } from '../supabase/client';

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
  /** 'apple' | 'google' as Supabase records it; kept a string so a new provider cannot break parsing. */
  provider: string | null;
  displayName: string | null;
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

/** For a sign-out that bypassed supabase-js (see AccountService.forceLocalSignOut). */
export function markSignedOutLocally(): void {
  lastAccessToken = null;
  useAuth.setState({ status: 'signed_out', account: null });
}

function apply(session: Session | null): void {
  lastAccessToken = session?.access_token ?? null;
  const account = accountFromSession(session);
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
