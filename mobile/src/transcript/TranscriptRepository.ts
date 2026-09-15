import { bundleDir, mediaFile } from '../services/bundle/paths';
import type { AudioTrack } from '../types/domain';
import { parseVtt, type Cue } from './vtt';

export type TranscriptLoad =
  | { status: 'ready'; cues: Cue[]; source: 'bundle' | 'dev-sample' }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

/**
 * Where a track's transcript would live: beside the audio, same name, `.vtt`.
 *
 * PROVISIONAL CONTRACT (TASK-602). No transcript exists anywhere in the system
 * yet - not in the schema, the bundle RPC, the bucket, or the downloader. This
 * sidecar convention is the smallest thing the UI can be built against, and it
 * stays inside the bundle directory so it inherits the derive-never-store rule
 * from paths.ts. The handover report proposes the backend side.
 */
export function sidecarPath(storagePath: string): string | null {
  return /\.m4a$/i.test(storagePath) ? storagePath.replace(/\.m4a$/i, '.vtt') : null;
}

export class TranscriptRepository {
  /**
   * Load a track's transcript from the downloaded bundle.
   *
   * Synchronous: a sentence-level VTT for a few minutes of narration is a few
   * kilobytes, and it is read once when the player is expanded.
   */
  static load(tourId: string, track: AudioTrack): TranscriptLoad {
    const path = sidecarPath(track.storagePath);

    let text: string | null = null;
    if (path !== null) {
      try {
        const file = mediaFile(bundleDir(tourId), path);
        if (file.exists) text = file.textSync();
      } catch (err) {
        // mediaFile() throws on an unsafe storage_path; a read can fail on a
        // file removed mid-session. Either way there is no transcript to show.
        console.warn('[Transcript] could not read', path, err);
      }
    }

    if (text !== null) {
      try {
        const { cues } = parseVtt(text);
        return cues.length > 0
          ? { status: 'ready', cues, source: 'bundle' }
          : { status: 'invalid', message: 'The transcript has no readable lines.' };
      } catch (err) {
        return {
          status: 'invalid',
          message: err instanceof Error ? err.message : 'The transcript could not be read.',
        };
      }
    }

    // Development builds only, so the karaoke view can be reviewed before any
    // real transcript exists. Visibly badged in the UI as a sample.
    if (__DEV__) return { status: 'ready', cues: devSampleCues(track.durationSeconds), source: 'dev-sample' };

    return { status: 'missing' };
  }
}

const SAMPLE_LINES = [
  'This is a sample transcript, shown only in development builds.',
  'No transcript file was found for this stop in the downloaded bundle.',
  'Each line lights up as the narration reaches it.',
  'Lines already heard fade back, and upcoming ones wait below.',
  'Tap any line to jump the audio to that point.',
  'Scroll freely; a button brings you back to the current line.',
  'Real transcripts will be WebVTT files delivered with the tour.',
  'Until then, these timings are spread evenly across the track.',
];

/** Evenly spaced placeholder cues across the track, so highlighting visibly moves. */
function devSampleCues(durationSeconds: number | null): Cue[] {
  const total = durationSeconds !== null && durationSeconds > 0 ? durationSeconds : 60;
  const step = total / SAMPLE_LINES.length;
  return SAMPLE_LINES.map((text, i) => ({ start: i * step, end: (i + 1) * step, text }));
}
