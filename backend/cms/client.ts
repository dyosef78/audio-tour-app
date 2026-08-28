/**
 * TASK-402 - the Supabase client the ingest service acts through.
 *
 * WHY THERE IS NO SERVICE_ROLE KEY IN THIS FILE
 *
 * The obvious way to build an upload service is to hand it a service_role key
 * and let it do as it pleases. That would be wrong here, and it would not even
 * work:
 *
 *   It would not work, because cms_register_audio_track() calls
 *   assert_cms_admin(), which resolves is_cms_admin(), which reads
 *   auth.uid() - NULL under service_role. The guard rejects the call. Every
 *   cms_* function behaves the same way. The API was built on the premise that
 *   the CMS authorises through app_admins rather than around RLS, and a service
 *   key is precisely "around".
 *
 *   It would be wrong, because a service_role key on the CMS box is a
 *   credential that bypasses every policy in the project, sitting on the one
 *   machine that accepts file uploads from the internet. And nothing it did
 *   would be attributable to a person.
 *
 * So the service carries the SIGNED-IN ADMIN'S ACCESS TOKEN instead. RLS stays
 * the enforcement layer, the storage admin_insert policy and the RPC guard both
 * see a real auth.uid(), and every registered track traces back to whoever was
 * logged into the CMS. The anon key plus a user JWT is strictly more
 * constrained than a service key, and here it is also the only thing that works.
 *
 * The token comes from the CMS session - `supabase.auth.getSession()` in the
 * browser, forwarded as a bearer token, or read from the request by whatever
 * session middleware the CMS ends up using.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { CmsIngestError } from './errors.ts';

/** The one bucket. Private since migration 20260827180000. */
export const AUDIO_BUCKET = 'audio-tracks';

/**
 * A client bound to one admin's session, for one request.
 *
 * Deliberately NOT a module-level singleton. A server handles many admins, and
 * a shared client would leak whichever session happened to be set last into the
 * next person's request - a bug that only shows up under concurrency, which is
 * to say in production and never in testing.
 */
export function createAdminScopedClient(accessToken: string): SupabaseClient {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];

  if (!url || !anonKey) {
    throw new CmsIngestError(
      'not_configured',
      'SUPABASE_URL and SUPABASE_ANON_KEY must be set.',
      { detail: 'See .env.example. The service_role key is deliberately not used here.' },
    );
  }

  if (!accessToken) {
    throw new CmsIngestError(
      'invalid_request',
      'An admin access token is required.',
      { detail: 'Forward the CMS session token; there is no service-key fallback by design.' },
    );
  }

  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: {
      // A server process must not write a session to disk, refresh it in the
      // background, or read one back on the next request. The token supplied
      // above is the entire identity of this client.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
