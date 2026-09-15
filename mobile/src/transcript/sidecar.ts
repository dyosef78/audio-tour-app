/**
 * Where a track's WebVTT transcript lives: beside the audio, same path, `.vtt`.
 *
 * PM decision (TASK-603): a naming convention, not a registered row. This is
 * the ONE TypeScript definition of it - the device reads transcripts through
 * it, the downloader checks the server's claim against it, and backend/cms
 * uploads with it. It must stay identical to public.transcript_path_for() in
 * migration 20260915120000; `npm run test:cms` pins the two together.
 *
 * Imports nothing, so both Metro and plain Node type-stripping can load it.
 *
 * Null for a path without a recognised audio extension. Replacing blindly would
 * return the audio path itself when nothing matched.
 */
const AUDIO_EXTENSION = /\.(m4a|mp3)$/i;

export function transcriptPathFor(storagePath: string): string | null {
  return AUDIO_EXTENSION.test(storagePath) ? storagePath.replace(AUDIO_EXTENSION, '.vtt') : null;
}
