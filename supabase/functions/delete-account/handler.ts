/**
 * TASK-1104 - delete-account request handling, free of Deno and Supabase globals.
 *
 * App Store Review Guideline 5.1.1(v): an app that lets people create an
 * account must let them delete it, from inside the app, completely.
 *
 * CONTRACT
 *
 *   POST   Authorization: Bearer <the user's access token>
 *          { "apple_authorization_code"?: string }   optional; see appleRevoke.ts
 *
 *   200  { "deleted": true, "apple_token_revoked": true | false | null }
 *        null = not attempted (not an Apple user, no code, or revocation not configured)
 *   400  malformed body
 *   401  not_signed_in        no valid user session (the anon key is not one)
 *   403  admin_account        CMS administrators are removed by the team, not from the app
 *   405  not POST
 *   500  delete_failed        nothing was deleted; safe to retry
 *   501  not_configured       the function has no service role
 *
 * WHO IS DELETED comes from the verified token and nothing else. The body never
 * names a user, so there is no id to swap.
 *
 * WHAT IS DELETED: the auth.users row, and with it everything that references
 * it - identities, sessions and refresh tokens (auth schema), user_itineraries
 * and their waypoints (ON DELETE CASCADE). Name and email live only in that row.
 *
 * WHAT IS NOT: telemetry_events. They carry a random device id and no user id,
 * so no event is linked to an account in the first place. Published tour
 * content is not the user's.
 *
 * CMS ADMINS ARE REFUSED. app_admins would cascade too, so an admin deleting
 * their tourist account from a phone would silently lose CMS access and orphan
 * the audio they uploaded. Admin offboarding is a team action.
 *
 * IDEMPOTENT: a user already gone (a retry after a lost response) is reported
 * as deleted, not as an error. The token check still has to pass first, and a
 * deleted user's token does not - so in practice a retry sees 401, which the
 * app handles by signing out.
 */

import type { AppleRevoker } from './appleRevoke.ts';

export interface AuthenticatedUser {
  id: string;
  /** Apple `sub` values from the user's Apple identities; empty for other providers. */
  appleSubjects: readonly string[];
}

export interface DeleteAccountDeps {
  /** The user the request's bearer token belongs to, or null if it is not a valid user session. */
  authenticate: (request: Request) => Promise<AuthenticatedUser | null>;
  isCmsAdmin: ((userId: string) => Promise<boolean>) | null;
  deleteUser: ((userId: string) => Promise<'deleted' | 'not_found'>) | null;
  appleRevoker: AppleRevoker | null;
  log?: (event: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 8 * 1024;
const MAX_CODE_LENGTH = 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function handleDeleteAccount(request: Request, deps: DeleteAccountDeps): Promise<Response> {
  const log = deps.log ?? ((event) => console.log(JSON.stringify(event)));

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return error(405, 'method_not_allowed', 'Use POST.', { Allow: 'POST, OPTIONS' });

  if (!deps.deleteUser || !deps.isCmsAdmin) {
    log({ event: 'delete_account_not_configured' });
    return error(501, 'not_configured', 'Account deletion is not configured on this server.');
  }

  let user: AuthenticatedUser | null;
  try {
    user = await deps.authenticate(request);
  } catch (cause) {
    log({ event: 'delete_account_auth_failed', message: String(cause) });
    user = null;
  }
  if (!user) return error(401, 'not_signed_in', 'Sign in to delete your account.');

  const parsed = await parseBody(request);
  if (!parsed.ok) return error(400, 'invalid_request', parsed.message);

  let admin: boolean;
  try {
    admin = await deps.isCmsAdmin(user.id);
  } catch (cause) {
    log({ event: 'delete_account_admin_check_failed', message: String(cause) });
    return error(500, 'delete_failed', 'Your account could not be deleted. Nothing was removed; please try again.');
  }
  if (admin) {
    log({ event: 'delete_account_refused_admin', user_id: user.id });
    return error(403, 'admin_account', 'This is a CMS administrator account. Ask the team to remove it.');
  }

  // Before the delete: afterwards the Apple identities to check against are gone.
  let appleTokenRevoked: boolean | null = null;
  if (parsed.appleAuthorizationCode !== null && deps.appleRevoker && user.appleSubjects.length > 0) {
    const result = await deps.appleRevoker.revoke(parsed.appleAuthorizationCode, user.appleSubjects);
    appleTokenRevoked = result === 'revoked';
  }

  try {
    const outcome = await deps.deleteUser(user.id);
    // Never the email or name - the id is what support would need, and it is
    // meaningless once the row is gone.
    log({ event: 'account_deleted', user_id: user.id, already_gone: outcome === 'not_found', apple_token_revoked: appleTokenRevoked });
  } catch (cause) {
    log({ event: 'delete_account_failed', user_id: user.id, message: String(cause) });
    return error(500, 'delete_failed', 'Your account could not be deleted. Nothing was removed; please try again.');
  }

  return json(200, { deleted: true, apple_token_revoked: appleTokenRevoked });
}

type ParsedBody = { ok: true; appleAuthorizationCode: string | null } | { ok: false; message: string };

async function parseBody(request: Request): Promise<ParsedBody> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, message: 'Body could not be read.' };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, message: 'Body too large.' };
  if (text.trim() === '') return { ok: true, appleAuthorizationCode: null };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Body is not JSON.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: 'Body must be a JSON object.' };

  const code = (raw as Record<string, unknown>).apple_authorization_code;
  if (code === undefined || code === null) return { ok: true, appleAuthorizationCode: null };
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
    return { ok: false, message: 'apple_authorization_code must be a non-empty string.' };
  }
  return { ok: true, appleAuthorizationCode: code };
}

function error(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: code, message }, headers);
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
