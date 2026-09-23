import { describeError } from '../../lib/describeError';
import { raceTimeout } from '../../lib/timeout';
import { TEARDOWN_TIMEOUTS, tearDownLocalSession, type LocalTeardown, type TeardownSteps } from './localTeardown';

export type { LocalTeardown } from './localTeardown';

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
 *   2. Google users' grant is revoked by the SERVER (Epic 12, option B), so the
 *      app fetches a Google access token for it - within `googleTokenMs` (2 s,
 *      PM constraint), or not at all. No token (timeout, cold start with no
 *      Google session, any error) is never a reason to stop: the request goes
 *      out with `google_token_unavailable: <reason>` instead, and the server
 *      logs google_revocation_skipped with that reason.
 *   3. The server deletes the account the SESSION belongs to - within
 *      `requestMs`, or the request is aborted and reported as `timeout`.
 *   4. Only then is this device signed out (localTeardown.ts): UI purged
 *      synchronously first, supabase-js and storage each within `signOutMs`.
 *
 * INVARIANT: runAccountDeletion always settles, in bounded time, and never
 * rejects. Worst case after the Apple sheet: googleTokenMs + requestMs +
 * 2 x signOutMs (18 s; the last 3 s is a local-storage drop that is normally
 * instant).
 * The screen that awaits it can therefore always unlock.
 *
 * Nothing on the device is wiped beyond the session: downloaded tours,
 * preferences and the city belong to the phone, not the account.
 */

export const DELETION_TIMEOUTS = {
  /**
   * The WHOLE Google token step - silent session restore plus getTokens() -
   * not just getTokens(): on a cold start the restore is where it would stall.
   * PM constraint, Epic 12: strict and short; on expiry deletion proceeds.
   */
  googleTokenMs: 2_000,
  /** Getting the Supabase token AND the round trip. The server answers inside ~9.5 s at worst. */
  requestMs: 10_000,
  ...TEARDOWN_TIMEOUTS,
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
  | {
      kind: 'deleted';
      /** Whether this request carried an Apple authorization code - QA evidence. */
      appleCodeSent: boolean;
      /** The server's apple_revocation_reason ('scheduled', 'no_code_in_request', ...), or null if absent. */
      appleRevocation: string | null;
      /**
       * Google accounts only (null otherwise): 'sent', or why no token went
       * with the request - QA evidence, like appleCodeSent.
       */
      googleToken: 'sent' | GoogleTokenUnavailable | null;
      /** The server's google_revocation_reason, or null if absent. */
      googleRevocation: string | null;
      /** How cleanly the local session was removed. Anything but 'clean' is shown to QA. */
      localTeardown: LocalTeardown;
    }
  | { kind: 'failed'; reason: DeletionFailureReason; detail?: string };

export type AppleReauthentication =
  | { authorizationCode: string }
  /**
   * `cancelled`: iOS said ASAuthorizationError.canceled - the user backing out
   * OR a system failure iOS reports the same way; they cannot be told apart.
   * `error`: any other failure, or a credential without an authorization code.
   * `code` / `message` come from describeError, so no failure shape loses
   * them; `elapsedMs` is how long the sheet was up - a sheet closed by hand
   * after 20 s is a hang, one refused in 50 ms never showed (device QA, 23 Sep).
   */
  | { failure: 'cancelled' | 'error'; code: string; message?: string; elapsedMs?: number }
  /** No Apple sheet on this device (e.g. an Apple account opened on Android). */
  | 'unavailable';

/**
 * Why no Google access token went with the request. Sent to the server as
 * `google_token_unavailable`, which logs it; it never stops the deletion.
 *   timeout            the token step did not finish within googleTokenMs
 *   no_google_session  this device holds no Google sign-in to restore (e.g. the
 *                      account's Google identity is linked, but this phone
 *                      signed in with Apple)
 *   not_configured     this build has no Google client IDs
 *   error              the Google SDK failed, or returned no token
 */
export type GoogleTokenUnavailable = 'timeout' | 'no_google_session' | 'not_configured' | 'error';

export type GoogleTokenResult =
  | { accessToken: string }
  | { unavailable: Exclude<GoogleTokenUnavailable, 'timeout'>; detail?: string };

export interface DeletionOptions {
  /**
   * Skip the Apple sheet entirely. Offered only AFTER an Apple confirmation
   * failed, so a person can always delete in one more tap instead of being sent
   * back to a sheet that keeps failing. Costs the Apple token revocation only.
   */
  skipAppleConfirmation?: boolean;
}

export type InvokeResult = { status: number; data: unknown } | { networkError: string };

export interface AccountDeletionDeps extends TeardownSteps {
  /**
   * Whether the account has an Apple / Google identity - PRIMARY OR LINKED
   * (authStore.hasProvider). b89da6c/dfa1dc9 looked only at app_metadata.provider,
   * the first provider, so an account created with Google and later linked to
   * Apple skipped the Apple sheet and sent no code (device QA, 23 Sep).
   */
  appleIdentity: boolean;
  googleIdentity: boolean;
  reauthenticateWithApple: () => Promise<AppleReauthentication>;
  /** A Google access token for the server to revoke. May hang or throw: the flow bounds it. */
  getGoogleAccessToken: () => Promise<GoogleTokenResult>;
  /** Must honour `signal`: it is aborted when the request runs out of time. */
  invokeDelete: (body: Record<string, unknown>, signal: AbortSignal) => Promise<InvokeResult>;
  options?: DeletionOptions;
  timeouts?: Partial<typeof DELETION_TIMEOUTS>;
  log?: (message: string) => void;
}

const describe = (err: unknown): string => {
  const { code, message } = describeError(err);
  return `${code}: ${message}`;
};

/** "ERR_REQUEST_CANCELED after 21400 ms: The user canceled the authorization attempt" */
export function appleFailureDetail(failure: { code: string; message?: string; elapsedMs?: number }): string {
  const after = failure.elapsedMs !== undefined ? ` after ${failure.elapsedMs} ms` : '';
  const why = failure.message ? `: ${failure.message}` : '';
  return `${failure.code}${after}${why}`;
}

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
  if (deps.appleIdentity && !deps.options?.skipAppleConfirmation) {
    let reauth: AppleReauthentication;
    try {
      reauth = await deps.reauthenticateWithApple();
    } catch (err) {
      const { code, message } = describeError(err);
      reauth = { failure: 'error', code: `EXCEPTION ${code}`, message };
    }
    if (reauth !== 'unavailable') {
      if ('failure' in reauth) {
        // Stop BEFORE the request, and say so. Never proceed silently without
        // the code (that hid the failure and skipped revocation), and never
        // return nothing (that looked like a dead button and invited the loop).
        const detail = appleFailureDetail(reauth);
        log(`Apple confirmation did not complete (${reauth.failure}): ${detail}; nothing sent`);
        return { kind: 'failed', reason: 'apple_confirmation', detail };
      }
      body.apple_authorization_code = reauth.authorizationCode;
    }
  }

  // 2. A Google token for the server's revocation - bounded, and never a reason to stop.
  let googleToken: 'sent' | GoogleTokenUnavailable | null = null;
  if (deps.googleIdentity) {
    googleToken = await googleTokenStep(deps, timeouts.googleTokenMs, log, body);
  }

  // 3. The request, bounded and abortable.
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
      {
        const teardown = await tearDownLocalSession(deps, timeouts, log);
        return teardown === 'clean'
          ? { kind: 'failed', reason: 'session_expired' }
          : { kind: 'failed', reason: 'session_expired', detail: `local teardown ${teardown}` };
      }
    case 403:
      return { kind: 'failed', reason: 'admin_account' };
    case 504:
      return { kind: 'failed', reason: 'timeout' };
  }
  if (result.status !== 200 || !isDeleted(result.data)) {
    log(`delete-account answered HTTP ${result.status}`);
    return { kind: 'failed', reason: 'server' };
  }

  // 4. The account is gone. Local clean-up must not be able to hide that.
  const localTeardown = await tearDownLocalSession(deps, timeouts, log);
  const data = result.data as { apple_revocation_reason?: unknown; google_revocation_reason?: unknown };
  return {
    kind: 'deleted',
    appleCodeSent: typeof body.apple_authorization_code === 'string',
    appleRevocation: typeof data.apple_revocation_reason === 'string' ? data.apple_revocation_reason : null,
    googleToken,
    googleRevocation: typeof data.google_revocation_reason === 'string' ? data.google_revocation_reason : null,
    localTeardown,
  };
}

/**
 * Puts `google_access_token` or `google_token_unavailable` in the body, and
 * says which. Never throws, never exceeds `ms`: a hang, a throw and an empty
 * answer all become a reason, and the deletion carries on (PM, Epic 12).
 * The native call is not cancelled on timeout - it has no signal - but nothing
 * waits for it and its late answer is discarded.
 */
async function googleTokenStep(
  deps: AccountDeletionDeps,
  ms: number,
  log: (message: string) => void,
  body: Record<string, unknown>,
): Promise<'sent' | GoogleTokenUnavailable> {
  let reason: GoogleTokenUnavailable;
  const started = Date.now();
  try {
    // Invoked inside the try: a synchronous throw from a native module is caught too.
    const raced = await raceTimeout(Promise.resolve().then(deps.getGoogleAccessToken), ms);
    if (raced.timedOut) {
      reason = 'timeout';
      log(`Google token step did not finish within ${ms} ms; deleting without it`);
    } else if ('accessToken' in raced.value && raced.value.accessToken !== '') {
      body.google_access_token = raced.value.accessToken;
      return 'sent';
    } else {
      reason = 'unavailable' in raced.value ? raced.value.unavailable : 'error';
      const detail = 'unavailable' in raced.value && raced.value.detail ? `: ${raced.value.detail}` : '';
      log(`no Google token (${reason}${detail}) after ${Date.now() - started} ms; deleting without it`);
    }
  } catch (err) {
    reason = 'error';
    log(`Google token step threw: ${describe(err)}; deleting without it`);
  }
  body.google_token_unavailable = reason;
  return reason;
}

function isDeleted(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { deleted?: unknown }).deleted === true;
}
