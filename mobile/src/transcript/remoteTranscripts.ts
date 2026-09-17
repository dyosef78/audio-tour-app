import { transcriptPathFor } from './sidecar';
import { parseVtt, type Cue } from './vtt';

/*
 * Transcripts for STREAMED tracks (TASK-1003, closing a TASK-605 gap).
 *
 * TranscriptRepository reads transcripts from the downloaded bundle. When an
 * audio file is missing from disk and TourSessionController streams it through
 * a signed URL instead, its `.vtt` is usually missing too, so the listener
 * got the narration but lost the synchronised text. That is an accessibility
 * regression during exactly the recovery path meant to prevent a silent stop.
 *
 * So when the controller streams a track, it also calls prefetch(). The
 * transcript is signed through the same storage policy as the audio,
 * downloaded, parsed with the same parser as bundled files, and held here.
 *
 * MEMORY ONLY, deliberately. Streaming means the device is online, and writing
 * into the bundle directory would put a file there that the bundle's own size
 * accounting never promised. The next download restores both files properly.
 *
 * Imports nothing from React Native, so the Node harness runs it (test:ui).
 */

export type RemoteTranscriptState =
  | { status: 'loading' }
  | { status: 'ready'; cues: Cue[] }
  /** No transcript is published for this track, or it could not be fetched or read. */
  | { status: 'unavailable' };

export interface RemoteTranscriptDeps {
  /** Signed URLs by path; a path that cannot be signed (no such object) is absent. */
  sign: (paths: readonly string[]) => Promise<Map<string, string>>;
  fetch: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  timeoutMs?: number;
}

/**
 * Same ceiling the CMS enforces on upload (backend/cms MAX_TRANSCRIPT_BYTES).
 * An object bigger than this was never accepted by the CMS, so it is not read.
 */
export const MAX_REMOTE_TRANSCRIPT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export class RemoteTranscriptStore {
  private readonly entries = new Map<string, RemoteTranscriptState>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  private readonly deps: RemoteTranscriptDeps;

  constructor(deps: RemoteTranscriptDeps) {
    this.deps = deps;
  }

  /** The state for an AUDIO storage path, or undefined if it was never requested. */
  get(audioStoragePath: string): RemoteTranscriptState | undefined {
    return this.entries.get(audioStoragePath);
  }

  /** Changes whenever any entry does. For useSyncExternalStore. */
  getRevision = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Fetch the transcript beside a streamed audio track. Never throws: a
   * transcript is an extra, and its failure must not touch playback.
   *
   * Idempotent. A transcript already loading or loaded is not fetched again,
   * but an `unavailable` one is retried, since the likeliest cause was the
   * connection the stream has just recovered.
   */
  async prefetch(audioStoragePath: string): Promise<RemoteTranscriptState> {
    const existing = this.entries.get(audioStoragePath);
    if (existing && existing.status !== 'unavailable') return existing;

    const path = transcriptPathFor(audioStoragePath);
    if (path === null) return this.set(audioStoragePath, { status: 'unavailable' });

    this.set(audioStoragePath, { status: 'loading' });
    try {
      const url = (await this.deps.sign([path])).get(path);
      // Unsignable = no transcript published beside this track. Normal, not an error.
      if (!url) return this.set(audioStoragePath, { status: 'unavailable' });

      const response = await this.deps.fetch(url, {
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_REMOTE_TRANSCRIPT_BYTES) {
        throw new Error(`transcript is ${declared} bytes, over the limit`);
      }
      const text = await response.text();
      if (text.length > MAX_REMOTE_TRANSCRIPT_BYTES) throw new Error('transcript over the limit');

      const { cues } = parseVtt(text);
      if (cues.length === 0) throw new Error('transcript has no readable lines');
      return this.set(audioStoragePath, { status: 'ready', cues });
    } catch (err) {
      console.warn('[Transcript] could not stream the transcript for', audioStoragePath, err);
      return this.set(audioStoragePath, { status: 'unavailable' });
    }
  }

  private set(audioStoragePath: string, state: RemoteTranscriptState): RemoteTranscriptState {
    this.entries.set(audioStoragePath, state);
    this.revision++;
    for (const listener of this.listeners) listener();
    return state;
  }
}
