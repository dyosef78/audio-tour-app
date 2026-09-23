/**
 * Epic 12 - revoke a user's Google grant to this app when they delete their
 * account. The Google counterpart of appleRevoke.ts, and deliberately shaped
 * like it: after the delete, in the background, every outcome logged.
 *
 * A native Google sign-in gives Supabase an ID token only, so the server holds
 * nothing it could revoke. The app therefore sends a Google ACCESS token with
 * the deletion request (AccountService.ts). Revoking an access token revokes
 * the whole grant - its refresh tokens included - so one call is enough:
 *
 *   GET  https://oauth2.googleapis.com/tokeninfo?access_token=...   who/what is it
 *   POST https://oauth2.googleapis.com/revoke                       token=...
 *
 * The tokeninfo check comes first, and both halves matter:
 *   - `sub` must be a Google identity on the account being deleted, so one
 *     account's deletion cannot revoke a different Google account's grant;
 *   - `aud`/`azp` must be one of OUR OAuth clients. Without this, a token the
 *     same person issued to some OTHER app would revoke their grant to that app.
 *
 * Unlike Apple's single-use authorization code, an access token can be used
 * again until it expires (~1 h), so a failed revoke is retryable in principle
 * (see the Apple revocation retry ticket in ARCHITECTURE.md). Not built here.
 *
 * Configuration: GOOGLE_CLIENT_IDS, comma-separated - the web, iOS and Android
 * client ids, the same list as Supabase's Google "Authorized Client IDs".
 * Without it the revoker is null and deletion proceeds without revocation:
 * revoking is good practice, deleting the account is the requirement.
 *
 * Deno and fetch only; no npm imports.
 */

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_TIMEOUT_MS = 5_000;

export interface GoogleRevokeConfig {
  /** Our OAuth client ids. A token issued to anything else is not revoked. */
  clientIds: readonly string[];
}

export type GoogleRevokeResult = 'revoked' | 'failed' | 'subject_mismatch' | 'client_mismatch';

export interface GoogleRevoker {
  revoke(accessToken: string, googleSubjects: readonly string[]): Promise<GoogleRevokeResult>;
}

/** Null unless at least one client id is configured. */
export function googleRevokeConfigFromEnv(env: Record<string, string | undefined>): GoogleRevokeConfig | null {
  const clientIds = (env.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return clientIds.length > 0 ? { clientIds } : null;
}

export function createGoogleRevoker(
  config: GoogleRevokeConfig,
  options: { fetch?: typeof fetch; log?: (event: Record<string, unknown>) => void } = {},
): GoogleRevoker {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));

  return {
    async revoke(accessToken, googleSubjects) {
      try {
        const infoRes = await doFetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`, {
          signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        });
        if (!infoRes.ok) {
          // Google's error body ("invalid_token") carries no token; safe to log.
          log({ event: 'google_tokeninfo_failed', status: infoRes.status, body: (await infoRes.text()).slice(0, 200) });
          return 'failed';
        }
        const info = (await infoRes.json()) as { sub?: unknown; aud?: unknown; azp?: unknown };

        const audiences = [info.aud, info.azp].filter((v): v is string => typeof v === 'string');
        if (!audiences.some((aud) => config.clientIds.includes(aud))) {
          log({ event: 'google_revoke_client_mismatch' });
          return 'client_mismatch';
        }
        if (typeof info.sub !== 'string' || !googleSubjects.includes(info.sub)) {
          log({ event: 'google_revoke_subject_mismatch' });
          return 'subject_mismatch';
        }

        const revokeRes = await doFetch(REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: accessToken }),
          signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        });
        if (!revokeRes.ok) {
          log({ event: 'google_revoke_failed', status: revokeRes.status, body: (await revokeRes.text()).slice(0, 200) });
          return 'failed';
        }
        return 'revoked';
      } catch (cause) {
        log({ event: 'google_revoke_failed', message: String(cause) });
        return 'failed';
      }
    },
  };
}
