import { describeError } from '../../lib/describeError';
import { raceTimeout } from '../../lib/timeout';

/**
 * Taking a session off this device - shared by account deletion (TASK-1104)
 * and the Settings "Sign out" button (Epic 12).
 *
 * Pure: every platform call is injected, so `npm run test:auth` walks each
 * step, including each one hanging forever. sessionTeardown.ts supplies the
 * real ones.
 *
 * Why one implementation: Epic 11 device QA found that supabase-js signOut
 * holds the auth lock around a network call with no timeout, and that it
 * RETURNS its error rather than throwing. Deletion was hardened against both;
 * the plain sign-out awaited that same call unbounded until Epic 12.
 */

/**
 * How cleanly the local session was removed. Reported, never swallowed
 * (CLAUDE.md: fail loud):
 *   clean       UI purged, supabase-js signed out, stored session removed
 *   forced      supabase-js sign-out failed or timed out; stored session removed directly
 *   incomplete  the stored session could not be confirmed removed, or the UI
 *               purge itself threw. The UI still shows signed out; the session
 *               may come back on the next launch.
 */
export type LocalTeardown = 'clean' | 'forced' | 'incomplete';

export const TEARDOWN_TIMEOUTS = {
  /** supabase-js signOut, and separately the storage drop. */
  signOutMs: 3_000,
  /** The provider SDK's own sign-out (Google). Never awaited by the caller. */
  providerSignOutMs: 3_000,
};

export interface TeardownSteps {
  /**
   * SYNCHRONOUS: purge the in-memory auth state the UI reads, and tombstone
   * what must not come back (the account on deletion, the session on sign-out).
   * Runs before the first await.
   */
  purgeAuthState: () => void;
  /** supabase-js sign-out. Must REJECT on failure - supabase-js returns its error instead of throwing. */
  signOutLocally: () => Promise<void>;
  /** Removes the stored session without the network or the auth lock. Idempotent. */
  dropStoredSession: () => Promise<void>;
  /**
   * The provider SDKs' local sign-out (GoogleSignin.signOut), so the next
   * Google sign-in offers the account chooser. Started after the purge and
   * NOT awaited: it decides nothing and must never hold the screen.
   */
  signOutProviders: () => Promise<void>;
}

const describe = (err: unknown): string => {
  const { code, message } = describeError(err);
  return `${code}: ${message}`;
};

/**
 * Four steps, ALL always run, in this order:
 *
 *   1. purgeAuthState - SYNCHRONOUS, no I/O, before the first await. When it
 *      returns, the UI and the account-route guard already see signed_out, so
 *      no screen can render the old session from here on (device QA, 23 Sep).
 *   2. signOutProviders - started, not awaited; its failure is logged.
 *   3. supabase-js signOut, bounded - so its in-memory state learns about it.
 *   4. dropStoredSession, bounded - removes the session from disk regardless of
 *      step 3, because supabase-js signOut can leave it behind.
 *
 * Settles in at most 2 x signOutMs and never rejects.
 */
export async function tearDownLocalSession(
  steps: TeardownSteps,
  timeouts: typeof TEARDOWN_TIMEOUTS,
  log: (message: string) => void,
): Promise<LocalTeardown> {
  let uiPurged = true;
  try {
    steps.purgeAuthState();
  } catch (err) {
    uiPurged = false;
    log(`UI auth purge threw: ${describe(err)}`);
  }

  void startProviderSignOut(steps, timeouts, log);

  let signedOut = false;
  try {
    const raced = await raceTimeout(steps.signOutLocally(), timeouts.signOutMs);
    signedOut = !raced.timedOut;
    if (raced.timedOut) log(`supabase-js sign-out did not finish within ${timeouts.signOutMs} ms`);
  } catch (err) {
    log(`supabase-js sign-out failed: ${describe(err)}`);
  }

  let dropped = false;
  try {
    const raced = await raceTimeout(steps.dropStoredSession(), timeouts.signOutMs);
    dropped = !raced.timedOut;
    if (raced.timedOut) log(`stored session drop did not finish within ${timeouts.signOutMs} ms`);
  } catch (err) {
    log(`stored session drop failed: ${describe(err)}`);
  }

  if (!uiPurged || !dropped) return 'incomplete';
  return signedOut ? 'clean' : 'forced';
}

async function startProviderSignOut(
  steps: TeardownSteps,
  timeouts: typeof TEARDOWN_TIMEOUTS,
  log: (message: string) => void,
): Promise<void> {
  try {
    // Invoked inside the try: a synchronous throw from a native module is caught too.
    const raced = await raceTimeout(Promise.resolve().then(steps.signOutProviders), timeouts.providerSignOutMs);
    if (raced.timedOut) log(`provider sign-out did not finish within ${timeouts.providerSignOutMs} ms`);
  } catch (err) {
    log(`provider sign-out failed: ${describe(err)}`);
  }
}
