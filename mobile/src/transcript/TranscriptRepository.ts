import { bundleDir, mediaFile } from '../services/bundle/paths';
import { signedAudioUrls } from '../services/supabase/client';
import type { AudioTrack } from '../types/domain';
import { RemoteTranscriptStore } from './remoteTranscripts';
import { transcriptPathFor } from './sidecar';
import { parseVtt, type Cue } from './vtt';

export type TranscriptLoad =
  | { status: 'ready'; cues: Cue[]; source: 'bundle' | 'stream' | 'dev-sample' }
  /** Not on disk; being fetched beside a streamed track. */
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

/*
 * Transcripts are found by convention - beside the audio, `.vtt` - through
 * transcriptPathFor(), the same function the downloader checks the server's
 * claim against (bundle/plan.ts). So a transcript is readable here exactly
 * when it was downloaded, with no path stored anywhere, which keeps the
 * derive-never-store rule from paths.ts.
 */

/**
 * Transcripts of tracks streamed because their file was missing from disk
 * (TASK-1003). TourSessionController fills it; load() reads it after the bundle.
 */
export const remoteTranscripts = new RemoteTranscriptStore({
  sign: (paths) => signedAudioUrls(paths),
  fetch: (url, init) => fetch(url, init),
});

export class TranscriptRepository {
  /**
   * Load a track's transcript from the downloaded bundle.
   *
   * Synchronous: a sentence-level VTT for a few minutes of narration is a few
   * kilobytes, and it is read once when the player is expanded.
   */
  static load(tourId: string, track: AudioTrack): TranscriptLoad {
    const path = transcriptPathFor(track.storagePath);

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

    // Not in the bundle: the track may be streaming, with its transcript
    // fetched beside it. After the disk, so a bundled file always wins.
    const remote = remoteTranscripts.get(track.storagePath);
    if (remote?.status === 'ready') return { status: 'ready', cues: remote.cues, source: 'stream' };
    if (remote?.status === 'loading') return { status: 'loading' };

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
