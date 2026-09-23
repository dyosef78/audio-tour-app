import type { AuthStatus } from '../services/auth/authStore';
import type { RootStackParamList } from './types';

/**
 * Auth-driven navigation for account-only screens (Epic 11 device QA, 23 Sep).
 *
 * The UI reacts to the auth state, not the other way round: when the state goes
 * from signed_in to signed_out - for ANY reason (deletion, session expiry, a
 * failed refresh, a sign-out on another device) - a screen that only makes
 * sense with an account is left immediately. RootNavigator applies this inside
 * a zustand subscription, which runs synchronously within the setState that
 * signed the user out, so there is no frame in which such a screen shows a
 * signed-out user as if signed in.
 *
 * Deliberately NOT React Navigation's "conditional screens" auth flow: almost
 * every screen here serves guests too, so swapping whole stacks on an auth
 * change would remount Discovery and lose a running tour's navigation state.
 * Settings is not listed: it renders the guest view from the same state.
 *
 * Pure, so test:auth drives it without a navigator.
 */

export const ACCOUNT_ONLY_ROUTES: ReadonlySet<keyof RootStackParamList> = new Set(['DeleteAccount']);

/** Where to go, or null to stay. Only a real sign-out moves anyone - never boot restoring. */
export function routeAfterAuthChange(
  previous: AuthStatus,
  next: AuthStatus,
  currentRoute: string | undefined,
): 'Discovery' | null {
  if (previous !== 'signed_in' || next !== 'signed_out') return null;
  if (currentRoute === undefined) return null;
  return ACCOUNT_ONLY_ROUTES.has(currentRoute as keyof RootStackParamList) ? 'Discovery' : null;
}
