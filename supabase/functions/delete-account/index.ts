/**
 * TASK-1104 - Edge Function `delete-account`: a signed-in user deletes their
 * own account (App Store Review Guideline 5.1.1(v)).
 *
 * Wiring only; behaviour and the HTTP contract are in handler.ts.
 *
 * Environment:
 *   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the Edge Runtime
 *   SUPABASE_SERVICE_ROLE_KEY         provided by the Edge Runtime; REQUIRED -
 *                                     deleting an auth user is an admin API call
 *   APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID, APPLE_PRIVATE_KEY
 *                                     optional, all four or none; enables Sign in
 *                                     with Apple token revocation (appleRevoke.ts)
 *   GOOGLE_CLIENT_IDS                 optional, comma-separated: our web, iOS and
 *                                     Android OAuth client ids (the same list as
 *                                     Supabase's Google "Authorized Client IDs");
 *                                     enables Google grant revocation (googleRevoke.ts)
 *   LOG_PSEUDONYM_KEY                 32+ random characters; keys the user_ref that
 *                                     replaces user_id on every log line
 *                                     (_shared/userRef.ts). Without it: "unconfigured"
 *   AXIOM_TOKEN, AXIOM_DATASET, AXIOM_DOMAIN
 *                                     optional, all three or none; ships every log
 *                                     line to Axiom (_shared/logger.ts)
 *
 * The SERVICE ROLE is used for exactly two things, both only after the caller's
 * own token has been verified: the app_admins check and auth.admin.deleteUser
 * on that caller's id.
 */

import { createClient } from '@supabase/supabase-js';

import { appleRevokeConfigFromEnv, createAppleRevoker } from './appleRevoke.ts';
import { createGoogleRevoker, googleRevokeConfigFromEnv } from './googleRevoke.ts';
import { DEFAULT_DEADLINES, handleDeleteAccount, type DeleteAccountDeps } from './handler.ts';
import { loggerFromEnv } from '../_shared/logger.ts';

const env = Deno.env.toObject();
const supabaseUrl = env.SUPABASE_URL;
const anonKey = env.SUPABASE_ANON_KEY;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const admin = supabaseUrl && serviceKey ? createClient(supabaseUrl, serviceKey, clientOptions) : null;

const authenticate: DeleteAccountDeps['authenticate'] = async (request) => {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  if (!supabaseUrl || !anonKey || token === '' || token === anonKey) return null;

  // getUser(jwt) asks GoTrue, so a revoked session or an already deleted user
  // is refused here - not just a token with a valid signature.
  const client = createClient(supabaseUrl, anonKey, clientOptions);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;

  const subjectsFor = (provider: string): string[] =>
    (data.user.identities ?? [])
      .filter((identity) => identity.provider === provider)
      .map((identity) => (identity.identity_data?.sub as string | undefined) ?? identity.id)
      .filter((sub): sub is string => typeof sub === 'string' && sub !== '');

  return { id: data.user.id, appleSubjects: subjectsFor('apple'), googleSubjects: subjectsFor('google') };
};

const isCmsAdmin: DeleteAccountDeps['isCmsAdmin'] = admin
  ? async (userId) => {
      const { count, error } = await admin
        .from('app_admins')
        .select('user_id', { count: 'exact', head: true })
        .eq('user_id', userId)
        // Cancels the query itself at the handler's deadline, not just the wait.
        .abortSignal(AbortSignal.timeout(DEFAULT_DEADLINES.adminCheckMs));
      if (error) throw new Error(`app_admins lookup: ${error.message}`);
      return (count ?? 0) > 0;
    }
  : null;

const deleteUser: DeleteAccountDeps['deleteUser'] = admin
  ? async (userId) => {
      // Hard delete: a soft delete keeps the row, which is not what Apple's
      // guidance, or the user, means by deleting an account.
      const { error } = await admin.auth.admin.deleteUser(userId, false);
      if (!error) return 'deleted';
      if (error.status === 404) return 'not_found';
      throw new Error(`auth.admin.deleteUser: ${error.message}`);
    }
  : null;

// Supabase's Edge Runtime keeps a promise alive after the response with
// EdgeRuntime.waitUntil, so revocation - and log shipping - never delays the
// answer. Read off globalThis: under `deno test` or a plain Deno the global
// does not exist.
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (task: Promise<unknown>) => void } }).EdgeRuntime;
const runInBackground =
  typeof edgeRuntime?.waitUntil === 'function' ? (task: Promise<unknown>) => edgeRuntime.waitUntil!(task) : null;

// Every line - handler, revokers, boot - goes through the one logger, which
// swaps user_id for user_ref before anything is written (_shared/logger.ts).
const logger = loggerFromEnv('delete-account', env, runInBackground);
const log = logger.log;

const appleConfig = appleRevokeConfigFromEnv(env);
const appleRevoker = appleConfig ? createAppleRevoker(appleConfig, { log }) : null;
if (!appleRevoker) log({ event: 'apple_revoke_disabled', reason: 'APPLE_* secrets not set' });
const googleConfig = googleRevokeConfigFromEnv(env);
const googleRevoker = googleConfig ? createGoogleRevoker(googleConfig, { log }) : null;
if (!googleRevoker) log({ event: 'google_revoke_disabled', reason: 'GOOGLE_CLIENT_IDS not set' });
if (!admin) log({ event: 'delete_account_disabled', reason: 'SUPABASE_SERVICE_ROLE_KEY missing' });

Deno.serve((request) =>
  handleDeleteAccount(request, { authenticate, isCmsAdmin, deleteUser, appleRevoker, googleRevoker, runInBackground, log }),
);
