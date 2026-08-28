import AsyncStorage from '@react-native-async-storage/async-storage';
import { DownloadTask, File, type DownloadPauseState } from 'expo-file-system';

import type { BundleProgress } from './types';

/**
 * DownloadManager - Approach B from the TASK-201 proposal.
 *
 * A bounded-concurrency queue of `DownloadTask`s with pause/resume state
 * persisted across app launches.
 *
 * Progress is computed against a denominator taken from `audio_tracks.size_bytes`
 * rather than from `Content-Length`, because `onProgress` reports `totalBytes`
 * as -1 whenever the server omits that header. Using the database figure means
 * the bar is accurate from the first byte and never jumps.
 *
 * PLATFORM NOTE: `sessionType` defaults to 'background', which lets iOS continue
 * a transfer while the app is suspended. Android ignores the option entirely -
 * the installed type definition says so - so on Android a backgrounded download
 * stalls until the app returns. Persisted resume is what makes that survivable.
 *
 * URL NOTE (TASK-400): `DownloadItem.url` is a SIGNED, EXPIRING URL, because the
 * audio bucket is private. It is a capability with an hour's life, not a stable
 * address - so it must never be persisted as identity (`storagePath` is that),
 * and a resume that fails on a dead token falls back to a fresh transfer rather
 * than failing the bundle. See downloadOne().
 */

export interface DownloadItem {
  /** Bucket-relative path; also the stable identity of this item. */
  storagePath: string;
  url: string;
  destination: File;
  /** Expected size from the database, used for progress and validation. */
  sizeBytes: number;
}

export interface DownloadManagerOptions {
  /** Parallel transfers. Three keeps a small bundle brisk without hammering the CDN. */
  concurrency?: number;
  onProgress?: (progress: BundleProgress) => void;
}

type ResumeRecord = { storagePath: string; state: DownloadPauseState };

const RESUME_KEY = (tourId: string): string => `bundle:resume:${tourId}`;

export class DownloadManager {
  private readonly concurrency: number;
  private readonly onProgress?: (p: BundleProgress) => void;

  private items: DownloadItem[] = [];
  private active = new Map<string, DownloadTask>();
  /** Bytes written per item; completed items hold their full expected size. */
  private written = new Map<string, number>();
  private completed = new Set<string>();
  /** Resume points for items paused during this run, keyed by storagePath. */
  private captured = new Map<string, DownloadPauseState>();
  private paused = false;
  private cancelled = false;

  private readonly tourId: string;

  // Explicit field assignment rather than a TypeScript parameter property:
  // parameter properties are non-erasable syntax, and avoiding them keeps this
  // module runnable under plain type-stripping, which is what lets the queue
  // logic be tested without a bundler or a device.
  constructor(tourId: string, options: DownloadManagerOptions = {}) {
    this.tourId = tourId;
    this.concurrency = Math.max(1, options.concurrency ?? 3);
    this.onProgress = options.onProgress;
  }

  // ---------------------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------------------

  private totalBytes(): number {
    return this.items.reduce((sum, i) => sum + i.sizeBytes, 0);
  }

  private snapshot(): BundleProgress {
    const total = this.totalBytes();
    let bytes = 0;
    for (const v of this.written.values()) bytes += v;
    // Clamp: a server file slightly larger than size_bytes must not push the
    // bar past 100%, which looks broken even though the download is healthy.
    const capped = Math.min(bytes, total);
    return {
      bytesWritten: capped,
      totalBytes: total,
      filesCompleted: this.completed.size,
      filesTotal: this.items.length,
      fraction: total > 0 ? capped / total : this.items.length === 0 ? 1 : 0,
    };
  }

  private emit(): void {
    this.onProgress?.(this.snapshot());
  }

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  /**
   * Download every item, resuming any that were persisted from a previous run.
   * Resolves once all have completed and passed size validation.
   */
  async run(items: DownloadItem[]): Promise<void> {
    this.items = items;
    this.cancelled = false;
    this.paused = false;
    this.written.clear();
    this.completed.clear();
    this.captured.clear();

    const resumable = await this.loadResumeState();
    this.emit();

    const queue = [...items];
    const workers = Array.from({ length: Math.min(this.concurrency, queue.length) }, () =>
      this.worker(queue, resumable),
    );

    try {
      await Promise.all(workers);
    } finally {
      // Whatever happened, do not leave live native tasks behind.
      for (const task of this.active.values()) task.release();
      this.active.clear();
    }

    if (this.cancelled) throw new Error('Download cancelled');

    // A paused item leaves the queue without completing. Resolving normally
    // here would let TourBundleRepository write the manifest and commit a
    // bundle with a missing track - the manifest is the completion marker, so
    // it must never be reached unless every item verified.
    if (this.completed.size < this.items.length) {
      await this.persistCaptured();
      throw new Error(
        `Download incomplete: ${this.completed.size} of ${this.items.length} tracks finished. Resume to continue.`,
      );
    }

    await this.clearResumeState();
  }

  /**
   * Record a paused task's resume point.
   *
   * Called both from pause() and from transfer() when a download resolves
   * null. The latter matters: the download promise resolving removes the task
   * from `active`, so waiting for pause() to capture it races with that and
   * would silently lose the resume point.
   */
  private capturePause(storagePath: string, task: DownloadTask): void {
    try {
      const state = task.savable();
      // Only a state carrying resumeData can actually be restored.
      if (state.resumeData) this.captured.set(storagePath, state);
    } catch {
      // savable() asserts the task is paused; anything else has nothing to save.
    }
  }

  private async worker(queue: DownloadItem[], resumable: Map<string, DownloadPauseState>): Promise<void> {
    for (;;) {
      if (this.cancelled || this.paused) return;
      const item = queue.shift();
      if (!item) return;
      await this.downloadOne(item, resumable.get(item.storagePath));
    }
  }

  private async downloadOne(item: DownloadItem, resume?: DownloadPauseState): Promise<void> {
    // Already on disk and the right size: skip. This is what makes a re-run
    // after a partial download cheap rather than starting over.
    if (item.destination.exists && this.sizeMatches(item)) {
      this.markComplete(item);
      return;
    }

    item.destination.parentDirectory.create({ intermediates: true, idempotent: true });

    // EXPIRED-TOKEN FALLBACK (TASK-400).
    //
    // A persisted resume point carries the URL that was live when the transfer
    // first started, baked into native resumeData where nothing can rewrite it.
    // Now that the audio bucket is private that URL is a signed token with an
    // hour to live, so a download paused overnight resumes against a dead one.
    // Storage answers 400 with a small JSON body, the transfer "completes", and
    // the size check in transfer() rejects those few hundred bytes.
    //
    // Without this fallback that state is PERMANENT: the resume record outlives
    // the failure in AsyncStorage, so every retry replays the same expired
    // token and the bundle can never be downloaded again. So a failed resume
    // gets exactly one clean attempt on `item.url`, which TourBundleRepository
    // re-signs on every download() call.
    if (resume?.resumeData) {
      try {
        await this.transfer(item, resume);
        return;
      } catch {
        // Swallowed on purpose - the fresh attempt below is the real verdict.
        // A cancel or a pause is not a stale token, so do not burn the retry.
        if (this.cancelled || this.paused) return;
      }

      // Whatever the dead resume appended is not part of the file we want.
      if (item.destination.exists) item.destination.delete();
      this.written.set(item.storagePath, 0);
      this.emit();
    }

    await this.transfer(item, undefined);
  }

  /**
   * A single transfer attempt.
   *
   * Resolves when the file is complete and has passed size validation, or when
   * the task was paused - having captured its resume point first. Throws on a
   * size mismatch, which is what catches both a truncated transfer and an error
   * body written to disk in place of audio.
   */
  private async transfer(
    item: DownloadItem,
    resume: DownloadPauseState | undefined,
  ): Promise<void> {
    const onProgress = ({ bytesWritten }: { bytesWritten: number }): void => {
      this.written.set(item.storagePath, bytesWritten);
      this.emit();
    };

    // Restoring a pause requires native resumeData. fromSavable() throws
    // without it - which happens when a task was paused before any bytes
    // arrived - so fall back to a fresh download rather than failing the bundle.
    let task: DownloadTask;
    if (resume?.resumeData) {
      try {
        task = DownloadTask.fromSavable(resume, { onProgress });
      } catch {
        task = File.createDownloadTask(item.url, item.destination, { onProgress });
      }
    } else {
      task = File.createDownloadTask(item.url, item.destination, { onProgress });
    }

    this.active.set(item.storagePath, task);

    // The native task is a strict state machine and asserts on entry:
    //   downloadAsync() requires state 'idle'   - starts a fresh transfer
    //   resumeAsync()   requires state 'paused' - continues a saved one
    // Calling the wrong one throws `Cannot call X() in state "Y"`, which is a
    // hard native crash rather than a rejected promise on iOS.
    //
    // Both resolve with the File on completion, or with null if the task was
    // paused first. Treating null as "done" would fail the size check below and
    // report spurious corruption every time the user pauses.
    let result: File | null;
    try {
      result = task.state === 'paused' ? await task.resumeAsync() : await task.downloadAsync();
    } finally {
      this.active.delete(item.storagePath);
    }

    if (this.cancelled) return;

    // null means the transfer was paused before finishing. Capture the resume
    // point now: this promise resolving is what removes the task from `active`,
    // so leaving it to pause() would race with that and lose the resume data.
    if (result === null) {
      this.capturePause(item.storagePath, task);
      return;
    }

    // PM decision (TASK-201): size validation only, no MD5. A truncated file is
    // the overwhelmingly common corruption mode and this catches it for one
    // stat call. Anything else is a hard failure - a half-written track that
    // silently "succeeds" would fail later, offline, mid-walk.
    if (!this.sizeMatches(item)) {
      const actual = item.destination.exists ? item.destination.info().size : 0;
      throw new Error(
        `Size mismatch for ${item.storagePath}: expected ${item.sizeBytes} bytes, got ${actual ?? 0}`,
      );
    }

    this.markComplete(item);
  }

  private sizeMatches(item: DownloadItem): boolean {
    if (!item.destination.exists) return false;
    return item.destination.info().size === item.sizeBytes;
  }

  private markComplete(item: DownloadItem): void {
    this.written.set(item.storagePath, item.sizeBytes);
    this.completed.add(item.storagePath);
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Pause / resume / cancel
  // ---------------------------------------------------------------------------

  /**
   * Pause every active transfer and persist its resume state.
   *
   * `savable()` is only legal while a task is actually paused, so the await on
   * `pauseAsync()` is load-bearing - calling it on an active task loses the
   * native resumeData and forces a restart from zero.
   */
  async pause(): Promise<void> {
    this.paused = true;

    for (const [storagePath, task] of this.active) {
      try {
        await task.pauseAsync();
      } catch {
        // Finished or errored between the loop starting and here; nothing to
        // pause, and capturePause below will find nothing to save either.
      }
      this.capturePause(storagePath, task);
    }

    await this.persistCaptured();
  }

  /** Abort everything and discard partial state. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    for (const task of this.active.values()) {
      try {
        task.cancel();
      } catch {
        /* already finished */
      }
    }
    this.active.clear();
    await this.clearResumeState();
  }

  // ---------------------------------------------------------------------------
  // Resume persistence
  // ---------------------------------------------------------------------------

  /** Write every captured resume point for this tour. */
  private async persistCaptured(): Promise<void> {
    if (this.captured.size === 0) return;
    const records: ResumeRecord[] = [...this.captured].map(([storagePath, state]) => ({
      storagePath,
      state,
    }));
    await AsyncStorage.setItem(RESUME_KEY(this.tourId), JSON.stringify(records));
  }

  private async loadResumeState(): Promise<Map<string, DownloadPauseState>> {
    const map = new Map<string, DownloadPauseState>();
    try {
      const raw = await AsyncStorage.getItem(RESUME_KEY(this.tourId));
      if (!raw) return map;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return map;
      for (const rec of parsed as ResumeRecord[]) {
        // resumeData is mandatory: DownloadTask.fromSavable() throws without it.
        // A record lacking it is not a usable resume point, so drop it here and
        // let the item restart cleanly.
        if (rec?.storagePath && rec?.state?.url && rec.state.resumeData) {
          map.set(rec.storagePath, rec.state);
        }
      }
    } catch {
      // Corrupt resume state is not worth failing a download over - the worst
      // case is re-downloading from zero, which is what we would do anyway.
    }
    return map;
  }

  private async clearResumeState(): Promise<void> {
    await AsyncStorage.removeItem(RESUME_KEY(this.tourId));
  }
}
