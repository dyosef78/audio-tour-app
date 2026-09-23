/**
 * TASK-1104 - revoke a user's Sign in with Apple tokens when they delete their
 * account.
 *
 * Apple's account-deletion guidance says apps offering Sign in with Apple
 * SHOULD revoke the user's tokens through the REST API. A native sign-in gives
 * Supabase an identity token only, so there is no stored refresh token to
 * revoke. The app therefore asks the user to confirm with Apple once more and
 * sends the fresh `authorizationCode`; this module exchanges that code for a
 * refresh token and revokes it:
 *
 *   POST https://appleid.apple.com/auth/token    grant_type=authorization_code
 *   POST https://appleid.apple.com/auth/revoke   token_type_hint=refresh_token
 *
 * Both need a `client_secret`: an ES256 JWT signed with the team's Sign in with
 * Apple key (.p8). Without the four APPLE_* secrets the revoker is null and
 * deletion proceeds without it - revocation is recommended, deleting the
 * account is required.
 *
 * The identity token Apple returns from the exchange is checked against the
 * Apple identities on the account being deleted, so one account's deletion
 * cannot be used to revoke a different Apple ID's consent.
 *
 * Deno and WebCrypto only; no npm imports.
 */

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const TOKEN_URL = 'https://appleid.apple.com/auth/token';
const REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
/** Apple allows up to six months; minutes is all a single deletion needs. */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;
const APPLE_TIMEOUT_MS = 5_000;

export interface AppleRevokeConfig {
  teamId: string;
  keyId: string;
  /** The App ID (bundle identifier) the native sign-in was issued to. */
  clientId: string;
  /** Contents of the .p8 key, PEM. Literal "\n" sequences are accepted. */
  privateKeyPem: string;
}

export type AppleRevokeResult = 'revoked' | 'failed' | 'subject_mismatch';

export interface AppleRevoker {
  revoke(authorizationCode: string, appleSubjects: readonly string[]): Promise<AppleRevokeResult>;
}

/** Null unless every secret is present: half a configuration is no configuration. */
export function appleRevokeConfigFromEnv(env: Record<string, string | undefined>): AppleRevokeConfig | null {
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_KEY_ID?.trim();
  const clientId = env.APPLE_CLIENT_ID?.trim();
  const privateKeyPem = env.APPLE_PRIVATE_KEY?.replaceAll('\\n', '\n').trim();
  if (!teamId || !keyId || !clientId || !privateKeyPem) return null;
  return { teamId, keyId, clientId, privateKeyPem };
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64urlJson(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/**
 * The ES256 `client_secret` Apple's token and revoke endpoints require.
 * WebCrypto's ECDSA signature is already the raw r||s form JWS expects.
 */
export async function appleClientSecret(config: AppleRevokeConfig, nowSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(config.privateKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signingInput = `${base64urlJson({ alg: 'ES256', kid: config.keyId, typ: 'JWT' })}.${base64urlJson({
    iss: config.teamId,
    iat: nowSeconds,
    exp: nowSeconds + CLIENT_SECRET_TTL_SECONDS,
    aud: APPLE_AUDIENCE,
    sub: config.clientId,
  })}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

/** The `sub` of a JWT we received straight from Apple over TLS; not a verification. */
function jwtSubject(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/')));
    return typeof json?.sub === 'string' ? json.sub : null;
  } catch {
    return null;
  }
}

export function createAppleRevoker(
  config: AppleRevokeConfig,
  options: { fetch?: typeof fetch; now?: () => number; log?: (event: Record<string, unknown>) => void } = {},
): AppleRevoker {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event) => console.log(JSON.stringify(event)));

  const post = (url: string, form: Record<string, string>) =>
    doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(APPLE_TIMEOUT_MS),
    });

  return {
    async revoke(authorizationCode, appleSubjects) {
      try {
        const clientSecret = await appleClientSecret(config, Math.floor(now() / 1000));

        const tokenRes = await post(TOKEN_URL, {
          grant_type: 'authorization_code',
          code: authorizationCode,
          client_id: config.clientId,
          client_secret: clientSecret,
        });
        if (!tokenRes.ok) {
          // Apple's error body names the problem (invalid_grant, invalid_client);
          // it carries no token, so it is safe to log.
          log({ event: 'apple_token_exchange_failed', status: tokenRes.status, body: (await tokenRes.text()).slice(0, 200) });
          return 'failed';
        }
        const tokens = (await tokenRes.json()) as { refresh_token?: unknown; id_token?: unknown };

        const subject = jwtSubject(tokens.id_token);
        if (subject === null || !appleSubjects.includes(subject)) {
          log({ event: 'apple_revoke_subject_mismatch' });
          return 'subject_mismatch';
        }
        if (typeof tokens.refresh_token !== 'string') {
          log({ event: 'apple_token_exchange_failed', status: tokenRes.status, body: 'no refresh_token' });
          return 'failed';
        }

        const revokeRes = await post(REVOKE_URL, {
          client_id: config.clientId,
          client_secret: clientSecret,
          token: tokens.refresh_token,
          token_type_hint: 'refresh_token',
        });
        if (!revokeRes.ok) {
          log({ event: 'apple_revoke_failed', status: revokeRes.status });
          return 'failed';
        }
        return 'revoked';
      } catch (cause) {
        log({ event: 'apple_revoke_failed', message: String(cause) });
        return 'failed';
      }
    },
  };
}
