/**
 * TASK-1104 - delete-account request handling, free of Deno and Supabase globals.
 * Hardened after the Epic 11 device-QA failure (hang, account not deleted).
 *
 * App Store Review Guideline 5.1.1(v): an app that lets people create an
 * account must let them delete it, from inside the app, completely.
 *
 * CONTRACT
 *
 *   POST   Authorization: Bearer <the user's access token>
 *          { "apple_authorization_code"?: string,    optional; see appleRevoke.ts
 *            "google_access_token"?: string,         optional; see googleRevoke.ts
 *            "google_token_unavailable"?: string }   why the app sent no Google token
 *                                                    (e.g. "timeout"); logged, never trusted
 *
 *   200  { "deleted": true, "apple_revocation": "scheduled" | "not_attempted",
 *          "apple_revocation_reason": "scheduled" | "no_code_in_request"
 *                                     | "revocation_not_configured" | "no_apple_identity_on_account",
 *          "google_revocation": "scheduled" | "not_attempted",
 *          "google_revocation_reason": "scheduled" | "no_token_in_request"
 *                                      | "revocation_not_configured" | "no_google_identity_on_account" }
 *   400  malformed body
 *   401  not_signed_in          no valid user session (the anon key is not one)
 *   403  admin_account          CMS administrators are removed by the team, not from the app
 *   405  not POST
 *   500  delete_failed          nothing was deleted; safe to retry
 *   501  not_configured         the function has no service role
 *   503  try_again              a step BEFORE the delete timed out; nothing was deleted
 *   504  deletion_unconfirmed   the delete itself did not answer in time; it may
 *                               still complete. A retry is safe (see IDEMPOTENT)
 *
 *   Every response carries X-Request-Id, which is also on every log line, so a
 *   report from a phone can be matched to the function's logs.
 *
 * ORDER - THE DELETE IS THE CRITICAL PATH, NOTHING ELSE IS
 *   1. authenticate   (GoTrue)            deadline 3 s
 *   2. admin check    (Postgres)          deadline 2.5 s
 *   3. deleteUser     (GoTrue admin)      deadline 4 s
 *   4. Apple and Google revocation - AFTER the delete, in the background. Apple
 *      used to run before the delete, so a slow appleid.apple.com held the
 *      account hostage and ate the phone's time budget. The Apple and Google
 *      subjects they check against are captured in step 1, so they survive the
 *      delete.
 *   Worst case before responding: ~9.5 s, inside the app's 10 s budget; the
 *   usual case is well under 2 s.
 *
 * WHO IS DELETED comes from the verified token and nothing else. The body never
 * names a user, so there is no id to swap.
 *
 * WHAT IS DELETED: the auth.users row, and with it everything that references
 * it - identities, sessions and refresh tokens (auth schema), user_itineraries
 * and their waypoints (ON DELETE CASCADE; test:cms asserts every FK to
 * auth.users cascades or nulls). Name and email live only in that row.
 *
 * WHAT IS NOT: telemetry_events. They carry a random device id and no user id,
 * so no event is linked to an account in the first place.
 *
 * CMS ADMINS ARE REFUSED. app_admins would cascade too, so an admin deleting
 * their tourist account from a phone would silently lose CMS access. Admin
 * offboarding is a team action.
 *
 * IDEMPOTENT: a user already gone is reported as deleted. In practice a retry
 * after a lost response sees 401 (a deleted user's token is refused), which the
 * app handles by signing out.
 */

import type { AppleRevoker } from './appleRevoke.ts';
import type { GoogleRevoker } from './googleRevoke.ts';

export interface AuthenticatedUser {
  id: string;
  /** Apple `sub` values from the user's Apple identities; empty for other providers. */
  appleSubjects: readonly string[];
  /** Google `sub` values from the user's Google identities; empty for other providers. */
  googleSubjects: readonly string[];
}

export interface StepDeadlines {
  authenticateMs: number;
  adminCheckMs: number;
  deleteMs: number;
  /** Only when the runtime cannot run work after responding (see runInBackground). */
  revocationFallbackMs: number;
}

export const DEFAULT_DEADLINES: StepDeadlines = {
  authenticateMs: 3_000,
  adminCheckMs: 2_500,
  deleteMs: 4_000,
  revocationFallbackMs: 1_500,
};

export interface DeleteAccountDeps {
  /** The user the request's bearer token belongs to, or null if it is not a valid user session. */
  authenticate: (request: Request) => Promise<AuthenticatedUser | null>;
  isCmsAdmin: ((userId: string) => Promise<boolean>) | null;
  deleteUser: ((userId: string) => Promise<'deleted' | 'not_found'>) | null;
  appleRevoker: AppleRevoker | null;
  googleRevoker: GoogleRevoker | null;
  /**
   * Keeps a task alive after the response is sent - EdgeRuntime.waitUntil on
   * Supabase. Without it the revocation is awaited, capped at
   * revocationFallbackMs, so it can never hold the response for long.
   */
  runInBackground?: ((task: Promise<unknown>) => void) | null;
  deadlines?: Partial<StepDeadlines>;
  log?: (event: Record<string, unknown>) => void;
}

const MAX_BODY_BYTES = 8 * 1024;
const MAX_CODE_LENGTH = 1024;
/** Google documents access tokens as up to 2048 bytes. */
const MAX_GOOGLE_TOKEN_LENGTH = 4096;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'x-request-id',
};

class StepTimeout extends Error {
  constructor(readonly step: string) {
    super(`${step} timed out`);
  }
}

/**
 * `promise`, or StepTimeout after `ms`. The timer is always cleared, so a fast
 * step leaves nothing pending. The underlying call is NOT cancelled - supabase-js
 * takes no signal here - which is why a timed-out delete is reported as
 * unconfirmed rather than failed.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeout(step)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function handleDeleteAccount(request: Request, deps: DeleteAccountDeps): Promise<Response> {
  const requestId = crypto.randomUUID();
  const baseLog = deps.log ?? ((event) => console.log(JSON.stringify(event)));
  const log = (event: Record<string, unknown>) => baseLog({ request_id: requestId, ...event });
  const deadlines = { ...DEFAULT_DEADLINES, ...deps.deadlines };
  const idHeader = { 'X-Request-Id': requestId };
  const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
    error(status, code, message, { ...idHeader, ...headers });
  const startedAt = Date.now();

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', 'Use POST.', { Allow: 'POST, OPTIONS' });

  if (!deps.deleteUser || !deps.isCmsAdmin) {
    log({ event: 'delete_account_not_configured' });
    return fail(501, 'not_configured', 'Account deletion is not configured on this server.');
  }

  // 1. Who is asking.
  let user: AuthenticatedUser | null;
  try {
    user = await withDeadline(deps.authenticate(request), deadlines.authenticateMs, 'authenticate');
  } catch (cause) {
    if (cause instanceof StepTimeout) {
      log({ event: 'delete_account_step_timeout', step: cause.step });
      return fail(503, 'try_again', 'We could not verify your sign-in in time. Nothing was deleted; please try again.');
    }
    log({ event: 'delete_account_auth_failed', message: String(cause) });
    user = null;
  }
  if (!user) return fail(401, 'not_signed_in', 'Sign in to delete your account.');
  const parsed = await parseBody(request);
  if (!parsed.ok) return fail(400, 'invalid_request', parsed.message);
  // Both halves of each revocation decision on one line: whether the account
  // has the identity, and what the phone sent. Never the code or token itself.
  log({
    event: 'delete_account_authenticated',
    user_id: user.id,
    apple_identities: user.appleSubjects.length,
    apple_code_present: parsed.appleAuthorizationCode !== null,
    google_identities: user.googleSubjects.length,
    google_token_present: parsed.googleAccessToken !== null,
  });

  // 2. Admins are removed by the team. Fails CLOSED: no answer, no delete.
  let admin: boolean;
  try {
    admin = await withDeadline(deps.isCmsAdmin(user.id), deadlines.adminCheckMs, 'admin_check');
  } catch (cause) {
    if (cause instanceof StepTimeout) {
      log({ event: 'delete_account_step_timeout', step: cause.step, user_id: user.id });
      return fail(503, 'try_again', 'Your account could not be deleted right now. Nothing was removed; please try again.');
    }
    log({ event: 'delete_account_admin_check_failed', user_id: user.id, message: String(cause) });
    return fail(500, 'delete_failed', 'Your account could not be deleted. Nothing was removed; please try again.');
  }
  if (admin) {
    log({ event: 'delete_account_refused_admin', user_id: user.id });
    return fail(403, 'admin_account', 'This is a CMS administrator account. Ask the team to remove it.');
  }

  // 3. The delete - the only step the user is waiting for.
  try {
    const outcome = await withDeadline(deps.deleteUser(user.id), deadlines.deleteMs, 'delete_user');
    // Never the email or name - the id is what support would need.
    log({ event: 'account_deleted', user_id: user.id, already_gone: outcome === 'not_found', elapsed_ms: Date.now() - startedAt });
  } catch (cause) {
    if (cause instanceof StepTimeout) {
      log({ event: 'delete_account_unconfirmed', user_id: user.id, elapsed_ms: Date.now() - startedAt });
      return fail(504, 'deletion_unconfirmed', 'We could not confirm the deletion in time. It is safe to try again.');
    }
    log({ event: 'delete_account_failed', user_id: user.id, message: String(cause) });
    return fail(500, 'delete_failed', 'Your account could not be deleted. Nothing was removed; please try again.');
  }

  // 4. Best-effort revocation, off the critical path. Every outcome is logged
  // with its reason: "no apple_revocation_finished line" used to mean any of
  // three different things (device QA, 23 Sep). Google follows the same rule.
  const background: Promise<unknown>[] = [];

  const appleSkip =
    parsed.appleAuthorizationCode === null
      ? 'no_code_in_request'
      : !deps.appleRevoker
        ? 'revocation_not_configured'
        : user.appleSubjects.length === 0
          ? 'no_apple_identity_on_account'
          : null;
  if (appleSkip !== null) {
    // Silent for plain Google accounts; logged whenever Apple is involved at all.
    if (user.appleSubjects.length > 0 || parsed.appleAuthorizationCode !== null) {
      log({ event: 'apple_revocation_skipped', user_id: user.id, reason: appleSkip });
    }
  } else if (parsed.appleAuthorizationCode !== null && deps.appleRevoker) {
    log({ event: 'apple_revocation_scheduled', user_id: user.id, background: Boolean(deps.runInBackground) });
    background.push(
      deps.appleRevoker
        .revoke(parsed.appleAuthorizationCode, user.appleSubjects)
        .then((result) => log({ event: 'apple_revocation_finished', user_id: user.id, result }))
        .catch((cause) => log({ event: 'apple_revocation_finished', user_id: user.id, result: 'failed', message: String(cause) })),
    );
  }

  const googleSkip =
    parsed.googleAccessToken === null
      ? 'no_token_in_request'
      : !deps.googleRevoker
        ? 'revocation_not_configured'
        : user.googleSubjects.length === 0
          ? 'no_google_identity_on_account'
          : null;
  if (googleSkip !== null) {
    // Silent for plain Apple accounts; logged whenever Google is involved at all.
    // `client_reason` is the phone's account of why it sent no token (the
    // Epic 12 fallback: the 2 s cap, a cold start, no Google session on the
    // device). It feeds this log line and decides nothing.
    if (user.googleSubjects.length > 0 || parsed.googleAccessToken !== null || parsed.googleTokenUnavailable !== null) {
      log({ event: 'google_revocation_skipped', user_id: user.id, reason: googleSkip, client_reason: parsed.googleTokenUnavailable });
    }
  } else if (parsed.googleAccessToken !== null && deps.googleRevoker) {
    log({ event: 'google_revocation_scheduled', user_id: user.id, background: Boolean(deps.runInBackground) });
    background.push(
      deps.googleRevoker
        .revoke(parsed.googleAccessToken, user.googleSubjects)
        .then((result) => log({ event: 'google_revocation_finished', user_id: user.id, result }))
        .catch((cause) => log({ event: 'google_revocation_finished', user_id: user.id, result: 'failed', message: String(cause) })),
    );
  }

  if (background.length > 0) {
    if (deps.runInBackground) {
      for (const task of background) deps.runInBackground(task);
    } else {
      // Both in parallel under one cap: the response waits at most this long.
      await withDeadline(Promise.all(background), deadlines.revocationFallbackMs, 'revocation').catch(() =>
        log({ event: 'revocation_abandoned', user_id: user.id }),
      );
    }
  }

  return json(
    200,
    {
      deleted: true,
      apple_revocation: appleSkip === null ? 'scheduled' : 'not_attempted',
      apple_revocation_reason: appleSkip ?? 'scheduled',
      google_revocation: googleSkip === null ? 'scheduled' : 'not_attempted',
      google_revocation_reason: googleSkip ?? 'scheduled',
    },
    idHeader,
  );
}

type ParsedBody =
  | {
      ok: true;
      appleAuthorizationCode: string | null;
      googleAccessToken: string | null;
      /** The phone's reason for sending no Google token, or 'unrecognised'. Log-only. */
      googleTokenUnavailable: string | null;
    }
  | { ok: false; message: string };

const EMPTY_BODY: ParsedBody = { ok: true, appleAuthorizationCode: null, googleAccessToken: null, googleTokenUnavailable: null };
const REASON_PATTERN = /^[a-z0-9_]{1,64}$/;

async function parseBody(request: Request): Promise<ParsedBody> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, message: 'Body could not be read.' };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, message: 'Body too large.' };
  if (text.trim() === '') return EMPTY_BODY;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'Body is not JSON.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, message: 'Body must be a JSON object.' };
  const body = raw as Record<string, unknown>;

  const code = body.apple_authorization_code;
  if (code !== undefined && code !== null && (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH)) {
    return { ok: false, message: 'apple_authorization_code must be a non-empty string.' };
  }
  const token = body.google_access_token;
  if (token !== undefined && token !== null && (typeof token !== 'string' || token.length === 0 || token.length > MAX_GOOGLE_TOKEN_LENGTH)) {
    return { ok: false, message: 'google_access_token must be a non-empty string.' };
  }
  // Never a 400: the flag only feeds a log line, and the PM's rule for Epic 12
  // is that nothing about Google may stop a deletion. A value that is not a
  // short snake_case reason is recorded as 'unrecognised'.
  const unavailable = body.google_token_unavailable;
  const googleTokenUnavailable =
    unavailable === undefined || unavailable === null
      ? null
      : typeof unavailable === 'string' && REASON_PATTERN.test(unavailable)
        ? unavailable
        : 'unrecognised';

  return {
    ok: true,
    appleAuthorizationCode: typeof code === 'string' ? code : null,
    googleAccessToken: typeof token === 'string' ? token : null,
    googleTokenUnavailable,
  };
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
