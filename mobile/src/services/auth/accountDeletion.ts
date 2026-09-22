import { raceTimeout } from '../../lib/timeout';

/**
 * Account deletion, as a sequence of decisions (TASK-1104; hardened after the
 * Epic 11 device-QA failure, where the screen froze and nothing was deleted).
 *
 * Pure: every platform call is injected, so `npm run test:auth` walks each
 * branch, including every dependency hanging forever. AccountService.ts
 * supplies the real ones. The server half is supabase/functions/delete-account.
 *
 *   1. Apple users confirm with Apple once more. That is the "are you sure" of a
 *      destructive action and the source of the authorization code the server
 *      uses to revoke their Apple tokens. If the sheet produces no code - backed
 *      out or failed, which iOS does not always distinguish - the flow stops
 *      BEFORE any request with `apple_confirmation`, and the screen offers
 *      "delete without Apple" (options.skipAppleConfirmation). Deliberately NOT
 *      time-limited: it is the user reading a system sheet.
 *   2. The server deletes the account the SESSION belongs to - within
 *      `requestMs`, or the request is aborted and reported as `timeout`.
 *   3. Only then is this device signed out - within `signOutMs`, or the stored
 *      session is dropped directly - and Google access revoked in the background.
 *
 * INVARIANT: runAccountDeletion always settles, in bounded time, and never
 * rejects. Worst case after the Apple sheet: requestMs + 2 x signOutMs (13 s
 * of which the last 3 s is a local-storage fallback that is normally instant).
 * The screen that awaits it can therefore always unlock.
 *
 * Nothing on the device is wiped beyond the session: downloaded tours,
 * preferences and the city belong to the phone, not the account.
 */

export const DELETION_TIMEOUTS = {
  /** Getting the token AND the round trip. The server answers inside ~9.5 s at worst. */
  requestMs: 10_000,
  /** supabase-js signOut holds the auth lock around a network call with no timeout. */
  signOutMs: 3_000,
  /** Google's revoke is cosmetic for us; it must never hold the screen. */
  googleRevokeMs: 3_000,
};

export type DeletionFailureReason =
  /** Never reached the server; nothing changed. */
  | 'offline'
  /** The server did not accept the session; the device is now signed out. */
  | 'session_expired'
  /** A CMS administrator; removed by the team instead. */
  | 'admin_account'
  /** The server failed before deleting; nothing changed. Safe to retry. */
  | 'server'
  /**
   * The Apple confirmation did not produce an authorization code - the user
   * backed out, or iOS failed the request. Nothing was sent; the account is
   * intact and the device still signed in. The screen must say so and offer
   * "delete without Apple" (skipAppleConfirmation), never silently return.
   */
  | 'apple_confirmation'
  /**
   * No answer in time, or the server could not confirm the delete. The account
   * may or may not be gone. A retry is safe: the server is idempotent, and a
   * deleted account's session is refused (-> session_expired).
   */
  | 'timeout';

/**
 * There is deliberately NO silent outcome (Epic 11 device QA, second pass).
 * b89da6c had `{ kind: 'cancelled' }`, which the screen rendered as nothing:
 * iOS reports some of its own failures as ASAuthorizationError.canceled, so a
 * failed Apple sheet looked like a tap that did nothing, the user tapped again,
 * and got the sheet again. Every outcome now carries something to show.
 */
export type DeleteAccountOutcome =
  | { kind: 'deleted' }
  | { kind: 'failed'; reason: DeletionFailureReason; detail?: string };

export type AppleReauthentication =
  | { authorizationCode: string }
  /**
   * `cancelled`: iOS said ASAuthorizationError.canceled - the user backing out
   * OR a system failure iOS reports the same way; they cannot be told apart.
   * `error`: any other failure, or a credential without an authorization code.
   * `code` is the native code, kept for the screen's reference line.
   */
  | { failure: 'cancelled' | 'error'; code: string }
  /** No Apple sheet on this device (e.g. an Apple account opened on Android). */
  | 'unavailable';

export interface DeletionOptions {
  /**
   * Skip the Apple sheet entirely. Offered only AFTER an Apple confirmation
   * failed, so a person can always delete in one more tap instead of being sent
   * back to a sheet that keeps failing. Costs the Apple token revocation only.
   */
  skipAppleConfirmation?: boolean;
}

export type InvokeResult = { status: number; data: unknown } | { networkError: string };

export interface AccountDeletionDeps {
  /** app_metadata.provider of the signed-in account. */
  provider: string | null;
  reauthenticateWithApple: () => Promise<AppleReauthentication>;
  /** Must honour `signal`: it is aborted when the request runs out of time. */
  invokeDelete: (body: Record<string, unknown>, signal: AbortSignal) => Promise<InvokeResult>;
  signOutLocally: () => Promise<void>;
  /** Drops the stored session without the network or the auth lock. The fallback when signOutLocally stalls. */
  forceLocalSignOut: () => Promise<void>;
  revokeGoogleAccess: () => Promise<void>;
  options?: DeletionOptions;
  timeouts?: Partial<typeof DELETION_TIMEOUTS>;
  log?: (message: string) => void;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runAccountDeletion(deps: AccountDeletionDeps): Promise<DeleteAccountOutcome> {
  const log = deps.log ?? ((message) => console.warn(`[Account] ${message}`));
  try {
    return await deletionFlow(deps, { ...DELETION_TIMEOUTS, ...deps.timeouts }, log);
  } catch (err) {
    // Unreachable by design - every step below catches - but the invariant is
    // that this function never rejects, so it is enforced rather than assumed.
    log(`deletion flow threw: ${describe(err)}`);
    return { kind: 'failed', reason: 'server' };
  }
}

async function deletionFlow(
  deps: AccountDeletionDeps,
  timeouts: typeof DELETION_TIMEOUTS,
  log: (message: string) => void,
): Promise<DeleteAccountOutcome> {
  const body: Record<string, unknown> = {};

  // 1. Apple confirmation - unless the person already chose to skip it.
  if (deps.provider === 'apple' && !deps.options?.skipAppleConfirmation) {
    let reauth: AppleReauthentication;
    try {
      reauth = await deps.reauthenticateWithApple();
    } catch (err) {
      reauth = { failure: 'error', code: `EXCEPTION: ${describe(err)}` };
    }
    if (reauth !== 'unavailable') {
      if ('failure' in reauth) {
        // Stop BEFORE the request, and say so. Never proceed silently without
        // the code (that hid the failure and skipped revocation), and never
        // return nothing (that looked like a dead button and invited the loop).
        log(`Apple confirmation did not complete (${reauth.failure}: ${reauth.code}); nothing sent`);
        return { kind: 'failed', reason: 'apple_confirmation', detail: reauth.code };
      }
      body.apple_authorization_code = reauth.authorizationCode;
    }
  }

  // 2. The request, bounded and abortable.
  const controller = new AbortController();
  let raced;
  try {
    raced = await raceTimeout(deps.invokeDelete(body, controller.signal), timeouts.requestMs);
  } catch (err) {
    log(`delete-account request threw: ${describe(err)}`);
    return { kind: 'failed', reason: 'server' };
  }
  if (raced.timedOut) {
    controller.abort();
    log(`delete-account gave no answer within ${timeouts.requestMs} ms`);
    return { kind: 'failed', reason: 'timeout' };
  }
  const result = raced.value;

  if ('networkError' in result) {
    log(`delete-account unreachable: ${result.networkError}`);
    return { kind: 'failed', reason: 'offline' };
  }

  switch (result.status) {
    case 401:
      // Most often: the account is already gone (a retry after a lost answer).
      await signOutBounded(deps, timeouts, log);
      return { kind: 'failed', reason: 'session_expired' };
    case 403:
      return { kind: 'failed', reason: 'admin_account' };
    case 504:
      return { kind: 'failed', reason: 'timeout' };
  }
  if (result.status !== 200 || !isDeleted(result.data)) {
    log(`delete-account answered HTTP ${result.status}`);
    return { kind: 'failed', reason: 'server' };
  }

  // 3. The account is gone. Local clean-up must not be able to hide that.
  await signOutBounded(deps, timeouts, log);
  if (deps.provider === 'google') {
    // Not awaited: the answer to the user does not depend on Google.
    void raceTimeout(
      deps.revokeGoogleAccess().catch((err) => log(`Google access could not be revoked: ${describe(err)}`)),
      timeouts.googleRevokeMs,
    );
  }
  return { kind: 'deleted' };
}

function isDeleted(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { deleted?: unknown }).deleted === true;
}

/**
 * Sign out through supabase-js, and if that does not finish in time - it waits
 * on the auth lock and then on a network call with no timeout - drop the stored
 * session directly. Either way the device ends up signed out.
 */
async function signOutBounded(
  deps: AccountDeletionDeps,
  timeouts: typeof DELETION_TIMEOUTS,
  log: (message: string) => void,
): Promise<void> {
  let clean = false;
  try {
    const raced = await raceTimeout(deps.signOutLocally(), timeouts.signOutMs);
    clean = !raced.timedOut;
    if (raced.timedOut) log(`sign-out did not finish within ${timeouts.signOutMs} ms; dropping the session directly`);
  } catch (err) {
    log(`sign-out failed: ${describe(err)}; dropping the session directly`);
  }
  if (clean) return;
  try {
    await raceTimeout(deps.forceLocalSignOut(), timeouts.signOutMs);
  } catch (err) {
    log(`forced sign-out failed: ${describe(err)}`);
  }
}
