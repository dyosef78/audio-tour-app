import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import 'react-native-url-polyfill/auto';

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

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // No URL-based session detection in a native app.
      detectSessionInUrl: false,
    },
  },
);

/** Bucket holding narration audio; audio_tracks.storage_path is relative to it. */
export const AUDIO_BUCKET = 'audio-tracks';

/** Resolve a relative storage_path into a playable public CDN URL. */
export function publicAudioUrl(storagePath: string): string {
  return supabase.storage.from(AUDIO_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}
