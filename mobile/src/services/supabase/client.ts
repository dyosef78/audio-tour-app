import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

import { secureSessionStorage } from '../auth/secureSessionStorage';

/**
 * Supabase client for the mobile app.
 *
 * EXPO_PUBLIC_* variables are inlined into the JS bundle at build time, so they
 * are public by definition. That is correct for the anon key and is exactly why
 * the backend's RLS policies matter. The service_role key must never be here.
 */
const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Whether real credentials were supplied.
 *
 * This module deliberately does NOT throw when they are missing. createClient()
 * rejects empty strings, so we hand it inert placeholders and let the UI render
 * a readable "not configured" state instead of a red box at startup. A dev who
 * has just cloned the repo should see instructions, not a stack trace.
 */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/**
 * For the rare call that must NOT go through supabase-js's fetch wrapper, which
 * waits on the auth lock before sending anything (see AccountService). Both
 * values are public - they are inlined into the bundle regardless.
 */
export const supabaseEndpoint = { url: supabaseUrl, anonKey: supabaseAnonKey } as const;

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      // Encrypted, keyed from the Keychain / Keystore (TASK-1102). A guest has
      // no session, so for most users this is never written at all.
      storage: secureSessionStorage,
      // On a phone this ticker would otherwise run for as long as the process
      // does, background included; authStore pauses it with AppState.
      autoRefreshToken: true,
      persistSession: true,
      // No URL-based session detection in a native app.
      detectSessionInUrl: false,
    },
  },
);

/** Bucket holding narration audio; audio_tracks.storage_path is relative to it. */
export const AUDIO_BUCKET = 'audio-tracks';

/**
 * Lifetime of a minted audio URL, in seconds.
 *
 * The bucket went private in migration 20260827180000, so a URL is now a
 * short-lived capability rather than a permanent address. One hour is the whole
 * window a bundle download has to finish in.
 *
 * That window is survivable only because nothing depends on the URL after the
 * bytes land: the app is offline-first and plays from local disk. A transfer
 * that outlives its token is re-signed on the next download() call - see the
 * expiry note in DownloadManager.downloadOne().
 */
export const AUDIO_URL_TTL_SECONDS = 3600;

/**
 * Mint playable URLs for a batch of bucket-relative storage paths.
 *
 * ONE round trip for the whole bundle. Per-path createSignedUrl() would issue N
 * requests at the exact moment the user is already waiting on a download, and
 * every one of them re-evaluates the same RLS policy against the same tour.
 *
 * Returns a Map rather than a parallel array because the Storage API does not
 * promise response order, and pairing by index would hand track 3's URL to
 * track 1. The size check in DownloadManager would catch that only by luck,
 * since two narration tracks can easily share a byte count.
 *
 * A path absent from the returned Map is not thrown on here. The usual cause is
 * that its tour is not published - audio_object_is_published() gates signed-URL
 * issuance on tours.status, which is the whole point of the private bucket. The
 * caller decides whether that is fatal; TourBundleRepository decides it is.
 */
export async function signedAudioUrls(
  storagePaths: readonly string[],
  expiresIn: number = AUDIO_URL_TTL_SECONDS,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();

  // Deduplicated: two waypoints may legitimately share one recording, and the
  // sign endpoint returns one row per requested path, duplicates included.
  const paths = [...new Set(storagePaths)];

  // An empty `paths` array is a 400 from the Storage API, not an empty result.
  if (paths.length === 0) return resolved;

  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrls(paths, expiresIn);

  if (error) throw new Error(`Could not sign audio URLs: ${error.message}`);
  if (!data) throw new Error('Could not sign audio URLs: the response held no data.');

  for (const row of data) {
    // Per-path failures arrive INSIDE a 200 response, not as the `error` above.
    // Dropping them here is what turns "one unpublished track" into a named
    // missing path downstream, instead of `undefined` being fetched as a URL.
    if (row.error !== null || row.path === null || row.signedUrl === null) continue;
    resolved.set(row.path, row.signedUrl);
  }

  return resolved;
}
