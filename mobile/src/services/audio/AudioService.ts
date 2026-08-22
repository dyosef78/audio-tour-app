import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { Platform } from 'react-native';

import type { AudioTrack } from '../../types/domain';

/** What the UI needs to render an honest transport control. */
export interface PlaybackSnapshot {
  isPlaying: boolean;
  positionSeconds: number;
  durationSeconds: number;
  didJustFinish: boolean;
}

export type PlaybackFailureReason =
  | 'unsupported-format'
  | 'create-failed'
  | 'load-timeout'
  | 'stalled';

export interface PlaybackError {
  reason: PlaybackFailureReason;
  /** Safe to show a user. */
  message: string;
  storagePath?: string;
}

/**
 * Container/codec families AVFoundation cannot decode.
 *
 * iOS has no Ogg demuxer and no Opus or Vorbis decoder outside of specific
 * WebRTC contexts, so these fail with no error - the player simply never loads.
 * Android handles Opus-in-Ogg from API 21, so this is deliberately iOS-only
 * rather than a global rule.
 */
const IOS_UNPLAYABLE_EXTENSIONS = new Set(['opus', 'ogg', 'oga', 'ogv', 'webm']);

/** No isLoaded within this window means the source will never decode. */
const LOAD_TIMEOUT_MS = 5_000;

/** Loaded and nominally playing, but the position has not moved. */
const STALL_TIMEOUT_MS = 8_000;

function extensionOf(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? '';
  const last = withoutQuery.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot === -1 ? '' : last.slice(dot + 1).toLowerCase();
}

/**
 * Reject a source this platform provably cannot play, before creating a player.
 *
 * Turns a silent five-second stall into an immediate, explicit failure. It reads
 * the extension rather than the bytes because AVFoundation does the same for
 * local file URLs - which also means a correctly encoded AAC file named `.opus`
 * still fails, and is worth knowing when auditing the content pipeline.
 */
export function unplayableReason(uri: string): string | null {
  if (Platform.OS !== 'ios') return null;
  const ext = extensionOf(uri);
  if (!IOS_UNPLAYABLE_EXTENSIONS.has(ext)) return null;
  return `iOS cannot decode .${ext} audio. Re-encode this track as AAC-LC (.m4a) or MP3.`;
}

/**
 * AudioService - narration playback, ducking and fades (TASK-103).
 *
 * SKELETON. Built on `expo-audio`, NOT `expo-av`: expo-av was removed from the
 * SDK and has no SDK 57 release. See the handover report - the API is different
 * (players are objects with settable properties, not Sound.createAsync).
 *
 * PRD v2.0.0 Screen 4 requires:
 *   - background playback with the screen locked
 *   - ducking to 20% during OS navigation alerts
 *   - a gradual fade-out when the user leaves a zone
 */

/** Volume during a navigation alert - PRD Screen 4 specifies 20%. */
export const DUCK_VOLUME = 0.2;
export const FULL_VOLUME = 1.0;

/** Fade applied on zone exit, in ms. */
export const EXIT_FADE_MS = 2_000;

export class AudioService {
  private player: AudioPlayer | null = null;
  private currentTrackId: string | null = null;
  private statusSub: { remove: () => void } | null = null;
  private onStatus: ((snapshot: PlaybackSnapshot) => void) | null = null;
  private onError: ((error: PlaybackError) => void) | null = null;

  /** Watchdogs: expo-audio surfaces no error event, so failure is inferred. */
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPosition = 0;
  private currentStoragePath: string | undefined;

  /**
   * Subscribe to playback failures.
   *
   * Needed because `AudioEvents` exposes only `playbackStatusUpdate` and
   * `audioSampleUpdate` - there is no error event and `play()` does not throw
   * on an undecodable source. A failure therefore looks exactly like a track
   * that never starts, which is how a stuck 0:00 reached the device.
   */
  setOnError(listener: ((error: PlaybackError) => void) | null): void {
    this.onError = listener;
  }

  /**
   * Subscribe to playback state.
   *
   * Driven by the player's own `playbackStatusUpdate` event rather than by our
   * own bookkeeping, so the UI stays correct in cases we do not initiate -
   * a track ending on its own, or the OS pausing us for an interruption.
   */
  setOnStatus(listener: ((snapshot: PlaybackSnapshot) => void) | null): void {
    this.onStatus = listener;
  }

  /**
   * Configure the session once at app start.
   *
   * PM decision (TASK-104): `interruptionMode: 'doNotMix'`. Priority #1 is that
   * sustained background playback survives with the phone locked, and the SDK
   * 57 docs require 'doNotMix' + setActiveForLockScreen() for that on Android.
   *
   * The accepted trade-off: 'doNotMix' requests exclusive audio focus, so we no
   * longer duck under OS navigation alerts - a maps instruction will PAUSE our
   * narration rather than talk over it. duck()/unduck() below stay for manual
   * control, but the OS will not call them for us any more.
   */
  async configureSession(): Promise<void> {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    });
  }

  /**
   * Play a track for a waypoint.
   *
   * `track.localUri` is preferred - the tour is offline-first, so by the time
   * this runs the file should already be on disk from the bundle download.
   * Falling back to a remote URL is a degraded path, not the normal one.
   */
  async play(track: AudioTrack, uri: string, waypointName: string): Promise<void> {
    if (this.currentTrackId === track.id && this.player?.playing) return;

    await this.stop();

    // Fail fast on a container this platform cannot decode, rather than letting
    // the watchdog discover it five seconds later.
    const unplayable = unplayableReason(uri);
    if (unplayable) {
      this.fail({ reason: 'unsupported-format', message: unplayable, storagePath: track.storagePath });
      return;
    }

    this.currentStoragePath = track.storagePath;

    try {
      this.player = createAudioPlayer({ uri });
    } catch (err) {
      this.fail({
        reason: 'create-failed',
        message: `Could not open the audio file: ${err instanceof Error ? err.message : String(err)}`,
        storagePath: track.storagePath,
      });
      return;
    }

    this.currentTrackId = track.id;
    this.player.volume = FULL_VOLUME;
    this.lastPosition = 0;

    this.statusSub = this.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      // isLoaded is the only positive signal that the source decoded at all.
      if (status.isLoaded) this.clearTimer('load');

      // Position advancing proves audio is genuinely flowing, not just flagged
      // as playing - which is exactly the state the .opus file got stuck in.
      if (status.currentTime > this.lastPosition) {
        this.lastPosition = status.currentTime;
        this.armStallWatchdog();
      }

      this.onStatus?.({
        isPlaying: status.playing,
        positionSeconds: status.currentTime,
        durationSeconds: status.duration,
        didJustFinish: status.didJustFinish,
      });
    });

    this.armLoadWatchdog();

    // Required alongside 'doNotMix' for sustained Android background playback,
    // and it populates the lock-screen controls with the stop being narrated.
    this.player.setActiveForLockScreen(true, { title: waypointName });

    this.player.play();
  }

  // ---------------------------------------------------------------------------
  // Failure detection
  // ---------------------------------------------------------------------------

  private armLoadWatchdog(): void {
    this.clearTimer('load');
    this.loadTimer = setTimeout(() => {
      this.fail({
        reason: 'load-timeout',
        message:
          `Audio did not load within ${LOAD_TIMEOUT_MS / 1000}s. ` +
          'The file is most likely in a format this device cannot decode.',
        storagePath: this.currentStoragePath,
      });
    }, LOAD_TIMEOUT_MS);
  }

  private armStallWatchdog(): void {
    this.clearTimer('stall');
    this.stallTimer = setTimeout(() => {
      // Only a stall if it still claims to be playing; a user pause is not one.
      if (!this.player?.playing) return;
      this.fail({
        reason: 'stalled',
        message: `Playback stalled at ${this.lastPosition.toFixed(1)}s and stopped advancing.`,
        storagePath: this.currentStoragePath,
      });
    }, STALL_TIMEOUT_MS);
  }

  private clearTimer(which: 'load' | 'stall' | 'both' = 'both'): void {
    if (which !== 'stall' && this.loadTimer) {
      clearTimeout(this.loadTimer);
      this.loadTimer = null;
    }
    if (which !== 'load' && this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Tear the player down and report, leaving the UI in a truthful state.
   *
   * The bug this exists to prevent: a failure that leaves the transport showing
   * "playing" at 0:00 forever. Resetting playback state is as important as the
   * error message.
   */
  private fail(error: PlaybackError): void {
    console.error(
      `[AudioService] ${error.reason}: ${error.message}` +
        (error.storagePath ? `\n  storage_path: ${error.storagePath}` : ''),
    );

    void this.stop();
    this.onError?.(error);
  }

  /** Pause without tearing the player down, so resume() continues in place. */
  pause(): void {
    this.player?.pause();
  }

  resume(): void {
    this.player?.play();
  }

  /** True while a player exists and is actually producing audio. */
  get isPlaying(): boolean {
    return this.player?.playing ?? false;
  }

  /** Duck to 20% for a navigation alert, then restore. */
  duck(): void {
    if (this.player) this.player.volume = DUCK_VOLUME;
  }

  unduck(): void {
    if (this.player) this.player.volume = FULL_VOLUME;
  }

  /**
   * Fade out and stop - the zone-exit behaviour from PRD Screen 4.
   *
   * TODO(TASK-103): expo-audio has no built-in fade ramp, so this needs a
   * stepped interval on `player.volume`. Implemented as an abrupt stop for now
   * rather than a fake fade, so the gap is visible instead of hidden.
   */
  async fadeOutAndStop(_durationMs: number = EXIT_FADE_MS): Promise<void> {
    await this.stop();
  }

  async stop(): Promise<void> {
    // Watchdogs first: a timer firing after teardown would report a phantom
    // failure for a track the user already stopped.
    this.clearTimer('both');

    // Then the status listener, or removing the player can emit a final update
    // into a UI that has already been told playback ended.
    this.statusSub?.remove();
    this.statusSub = null;
    this.lastPosition = 0;
    this.currentStoragePath = undefined;

    if (!this.player) return;
    this.player.pause();
    this.player.remove();
    this.player = null;
    this.currentTrackId = null;
    this.onStatus?.({ isPlaying: false, positionSeconds: 0, durationSeconds: 0, didJustFinish: false });
  }

  get playingTrackId(): string | null {
    return this.currentTrackId;
  }
}
