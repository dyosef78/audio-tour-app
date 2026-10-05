/**
 * Epic 16 Part 5 - CMS admin sign-in for command-line tools, by EMAIL OTP.
 *
 * PM decision (4 Oct 2026): no static passwords for production admin access.
 * Every admin CLI (cms:ingest, seed:telaviv, planner:warm, test:db --admin)
 * signs in like this:
 *
 *   1. signInWithOtp({ email, shouldCreateUser: false }) - Supabase emails a
 *      one-time code. shouldCreateUser:false: an unknown address gets an error,
 *      never a new account.
 *   2. The CLI asks the admin for the code (interactive terminal only - there
 *      is deliberately no environment-variable bypass).
 *   3. verifyOtp({ email, token, type: 'email' }) -> a session, in memory only.
 *      Nothing is written to disk: a cached refresh token would be a
 *      long-lived credential at rest, which is what removing passwords was for.
 *   4. is_cms_admin() under that session must be true, or the CLI stops before
 *      doing anything.
 *
 * A wrong code can be re-entered (up to MAX_CODE_ATTEMPTS) without sending a
 * new email, because Supabase refuses a second send for about a minute.
 *
 * SUPABASE_ADMIN_PASSWORD is no longer read; if it is still set, the CLI says
 * so, because a password lying in an env file is exactly the leak to avoid.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const MAX_CODE_ATTEMPTS = 3;
/** Supabase codes are 6 digits by default and configurable up to 10. */
const CODE = /^\d{6,10}$/;

/** The parts of a Supabase client this flow touches - so tests can fake them. */
export interface OtpAuthClient {
  auth: {
    signInWithOtp(args: { email: string; options: { shouldCreateUser: boolean } }): Promise<{ error: { message: string; status?: number } | null }>;
    verifyOtp(args: { email: string; token: string; type: 'email' }): Promise<{ data: { session: { access_token: string } | null }; error: { message: string } | null }>;
  };
  rpc(fn: 'is_cms_admin'): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export interface OtpIo {
  /** Ask a question on the terminal; resolves with the answer. */
  ask(question: string): Promise<string>;
  say(line: string): void;
  interactive: boolean;
}

export class AdminSignInError extends Error {
  override readonly name = 'AdminSignInError';
}

/** a***@example.com - enough to recognise, not enough to harvest from a screen recording. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return '***';
  return `${user[0]}${'*'.repeat(Math.max(2, user.length - 1))}@${domain}`;
}

/** Turn Supabase's sign-in errors into instructions. */
function explain(message: string): string {
  if (/email logins are disabled/i.test(message)) {
    return 'Email sign-in is disabled for this project. Enable the Email provider (sign-up stays OFF) - see the Epic 16 handover.';
  }
  if (/signups? not allowed/i.test(message)) {
    return 'No account exists for this address, and sign-up is closed. Use an address that is in public.app_admins.';
  }
  if (/security purposes|rate limit|too many/i.test(message)) {
    return `Supabase is rate-limiting codes for this address: ${message}`;
  }
  return message;
}

export async function signInAdminWithOtp(client: OtpAuthClient, email: string, io: OtpIo): Promise<{ accessToken: string }> {
  if (!io.interactive) {
    throw new AdminSignInError('Admin sign-in needs an interactive terminal: the one-time code is typed by a person. There is no bypass.');
  }
  const { error: sendError } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (sendError) throw new AdminSignInError(`Could not send a sign-in code to ${maskEmail(email)}: ${explain(sendError.message)}`);
  io.say(`A sign-in code was sent to ${maskEmail(email)}. It can take a minute to arrive.`);

  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
    const code = (await io.ask(`Code (attempt ${attempt}/${MAX_CODE_ATTEMPTS}): `)).trim();
    if (!CODE.test(code)) {
      io.say('That is not a code - it is the 6-digit number in the email.');
      continue;
    }
    const { data, error } = await client.auth.verifyOtp({ email, token: code, type: 'email' });
    if (!error && data.session) {
      const { data: isAdmin, error: adminError } = await client.rpc('is_cms_admin');
      if (adminError) throw new AdminSignInError(`Signed in, but is_cms_admin() failed: ${adminError.message}`);
      // Since 20261008120000 there are two reasons: no app_admins row, or a
      // token whose amr lacks "otp" (npm run auth:inspect-amr shows which).
      if (isAdmin !== true) throw new AdminSignInError(`${maskEmail(email)} signed in but is not a CMS admin: no row in public.app_admins, or the session token does not record an email-code sign-in (run npm run auth:inspect-amr).`);
      return { accessToken: data.session.access_token };
    }
    io.say(`That code was not accepted (${error?.message ?? 'no session'}).`);
  }
  throw new AdminSignInError(`No valid code after ${MAX_CODE_ATTEMPTS} attempts. Run the command again for a new code.`);
}

/** The terminal, for real CLIs. */
export async function terminalIo(): Promise<OtpIo & { close(): void }> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => rl.question(q),
    say: (line) => console.log(line),
    interactive: process.stdin.isTTY === true,
    close: () => rl.close(),
  };
}

/**
 * The whole flow for a CLI: environment, client, OTP, admin check. Returns a
 * client signed in as the admin (session in memory only) and its token.
 */
export async function adminSessionFromEnv(): Promise<{ supabase: SupabaseClient; accessToken: string; email: string }> {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const email = process.env['SUPABASE_ADMIN_EMAIL'];
  if (!url || !anonKey) throw new AdminSignInError('SUPABASE_URL and SUPABASE_ANON_KEY must be set (see .env.example).');
  if (!email) throw new AdminSignInError('SUPABASE_ADMIN_EMAIL must name an account in public.app_admins.');
  if (process.env['SUPABASE_ADMIN_PASSWORD']) {
    console.warn('SUPABASE_ADMIN_PASSWORD is set but no longer used (email codes only, PM 4 Oct 2026). Delete it from your env file.');
  }

  // No persisted session, no auto-refresh timer: the session lives exactly as
  // long as this process. Long runs refresh explicitly (refreshSession()).
  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const io = await terminalIo();
  try {
    const { accessToken } = await signInAdminWithOtp(supabase, email, io);
    return { supabase, accessToken, email };
  } finally {
    io.close();
  }
}
