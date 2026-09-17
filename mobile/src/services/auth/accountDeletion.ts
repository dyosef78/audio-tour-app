/**
 * Account deletion, as a sequence of decisions (TASK-1104).
 *
 * Pure: every platform call is injected, so `npm run test:auth` walks each
 * branch. AccountService.ts supplies the real ones. The server half is
 * supabase/functions/delete-account.
 *
 *   1. Apple users confirm with Apple once more. That is both the "are you
 *      sure" of a destructive action and the source of the authorization code
 *      the server needs to revoke their Apple tokens. Backing out cancels.
 *   2. The server deletes the account the SESSION belongs to.
 *   3. Only then is this device signed out, and Google access revoked.
 *
 * Nothing on the device is wiped beyond the session: downloaded tours,
 * preferences and the city belong to the phone, not the account, and a guest
 * keeps all of them.
 */

export type DeleteAccountOutcome =
  | { kind: 'deleted'; appleTokenRevoked: boolean | null }
  | { kind: 'cancelled' }
  | {
      kind: 'failed';
      /**
       * offline          - never reached the server; nothing changed
       * session_expired  - the server did not accept the session; the device is now signed out
       * admin_account    - a CMS administrator; removed by the team instead
       * server           - the server failed; nothing was deleted, safe to retry
       */
      reason: 'offline' | 'session_expired' | 'admin_account' | 'server';
    };

export type AppleReauthentication = { authorizationCode: string } | 'cancelled' | 'unavailable';

export type InvokeResult = { status: number; data: unknown } | { networkError: string };

export interface AccountDeletionDeps {
  /** app_metadata.provider of the signed-in account. */
  provider: string | null;
  reauthenticateWithApple: () => Promise<AppleReauthentication>;
  invokeDelete: (body: Record<string, unknown>) => Promise<InvokeResult>;
  signOutLocally: () => Promise<void>;
  revokeGoogleAccess: () => Promise<void>;
  log?: (message: string) => void;
}

export async function runAccountDeletion(deps: AccountDeletionDeps): Promise<DeleteAccountOutcome> {
  const log = deps.log ?? ((message) => console.warn(`[Account] ${message}`));
  const body: Record<string, unknown> = {};

  if (deps.provider === 'apple') {
    const reauth = await deps.reauthenticateWithApple();
    if (reauth === 'cancelled') return { kind: 'cancelled' };
    // 'unavailable': an Apple account opened on Android. Deletion does not
    // depend on revocation, so it proceeds without a code.
    if (reauth !== 'unavailable') body.apple_authorization_code = reauth.authorizationCode;
  }

  const result = await deps.invokeDelete(body);
  if ('networkError' in result) {
    log(`delete-account unreachable: ${result.networkError}`);
    return { kind: 'failed', reason: 'offline' };
  }

  if (result.status === 401) {
    // The server does not recognise this session - most often because the
    // account is already gone (a retry after a lost response). Either way the
    // local session is useless, so it goes.
    await signOutQuietly(deps, log);
    return { kind: 'failed', reason: 'session_expired' };
  }
  if (result.status === 403) return { kind: 'failed', reason: 'admin_account' };
  if (result.status !== 200 || !isDeleted(result.data)) {
    log(`delete-account answered HTTP ${result.status}`);
    return { kind: 'failed', reason: 'server' };
  }

  await signOutQuietly(deps, log);
  if (deps.provider === 'google') {
    try {
      await deps.revokeGoogleAccess();
    } catch (err) {
      log(`Google access could not be revoked: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const revoked = (result.data as { apple_token_revoked?: unknown }).apple_token_revoked;
  return { kind: 'deleted', appleTokenRevoked: typeof revoked === 'boolean' ? revoked : null };
}

function isDeleted(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { deleted?: unknown }).deleted === true;
}

/** The account is already gone server-side; a sign-out error must not turn that into a failure. */
async function signOutQuietly(deps: AccountDeletionDeps, log: (message: string) => void): Promise<void> {
  try {
    await deps.signOutLocally();
  } catch (err) {
    log(`local sign-out failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
