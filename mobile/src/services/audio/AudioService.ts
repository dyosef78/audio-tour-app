import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { Platform } from 'react-native';

import type { AudioTrack, Waypoint } from '../../types/domain';
import type {
  AudioEventContext,
  AudioTelemetrySink,
  AudioTelemetryType,
} from '../telemetry/TelemetryService';

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
 * AudioService - narration playback and fades (TASK-103).
 *
 * SKELETON. Built on `expo-audio`, NOT `expo-av`: expo-av was removed from the
 * SDK and has no SDK 57 release. See the handover report - the API is different
 * (players are objects with settable properties, not Sound.createAsync).
 *
 * PRD v2.0.0 Screen 4 requires:
 *   - background playback with the screen locked
 *   - a gradual fade-out when the user leaves a zone
 *
 * NO DUCKING (PM decision, TASK-502). Screen 4 originally asked for a duck to
 * 20% under OS navigation alerts. Delivering that requires a mixable audio
 * session, and a mixable session loses the exclusive focus that keeps narration
 * alive with the phone locked and pocketed - which is the product. So the OS
 * PAUSES us during a maps instruction and resumes afterwards, and this service
 * never lowers a volume. duck()/unduck() were removed rather than left as dead
 * code that implies a behaviour we deliberately do not have.
 */

/**
 * The one and only volume this app ever sets.
 *
 * Level is decided entirely by the ingest pipeline, which normalises every track
 * to -16 LUFS. The client applies no replay gain, no per-track trim, no boost
 * and - since the decision above - no duck. Unity, always. Anything that scaled
 * by a measured loudness here would double-correct audio that is already matched
 * and re-introduce exactly the level jumps between waypoints that -16 LUFS
 * exists to remove.
 */
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

  // --- telemetry (TASK-506) --------------------------------------------------
  //
  // A narrow sink rather than the TelemetryService itself, so the player can be
  // driven by a recording double in a test and never touches AsyncStorage.
  private telemetry: AudioTelemetrySink | null = null;
  /** Where the current track sits in the catalogue, for the event's FKs. */
  private trackContext: {
    tourId: string | null;
    waypointId: string | null;
    audioTrackId: string | null;
  } | null = null;
  /** Track length at the time of play, denormalised into every event. */
  private trackSeconds: number | null = null;
  /**
   * Whether the current track already reported a terminal event.
   *
   * Completion arrives via didJustFinish, and the stop() that follows would
   * otherwise report the SAME track as skipped a moment later - inflating the
   * skip rate by exactly the completion rate, which would have made the headline
   * KPI read as its own opposite.
   */
  private terminalReported = false;

  /**
   * Attach the telemetry sink. Optional: with none set, playback is silent to
   * analytics and behaves identically otherwise.
   */
  setTelemetry(sink: AudioTelemetrySink | null): void {
    this.telemetry = sink;
  }

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
   * The accepted trade-off, RATIFIED by the PM in TASK-502: 'doNotMix' requests
   * exclusive audio focus, so a maps instruction PAUSES our narration rather
   * than talking over it. That is the intended behaviour, not a gap - locked
   * screen playback is non-negotiable for a pocketed walking tour, and custom
   * ducking has been abandoned rather than carried as an unimplemented promise.
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
  async play(track: AudioTrack, uri: string, waypoint: Waypoint): Promise<void> {
    if (this.currentTrackId === track.id && this.player?.playing) return;

    // Whatever is playing is being abandoned mid-track for a new waypoint. That
    // is the product's definition of a skip, so it must be recorded BEFORE the
    // context is overwritten below.
    await this.stop('audio_skipped');

    // Fail fast on a container this platform cannot decode, rather than letting
    // the watchdog discover it five seconds later.
    const unplayable = unplayableReason(uri);
    if (unplayable) {
      this.fail({ reason: 'unsupported-format', message: unplayable, storagePath: track.storagePath });
      return;
    }

    this.currentStoragePath = track.storagePath;
    this.trackContext = {
      tourId: waypoint.tourId,
      waypointId: waypoint.id,
      audioTrackId: track.audioTrackId,
    };
    this.trackSeconds = track.durationSeconds;
    this.terminalReported = false;

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

    // Emitted here, not on the first status update: audio_started is the
    // denominator of the Audio Completion Rate, so it must be recorded even for
    // a track that never produces a single status event.
    this.emit('audio_started', 0);

    this.statusSub = this.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      // isLoaded is the only positive signal that the source decoded at all.
      if (status.isLoaded) this.clearTimer('load');

      // Position advancing proves audio is genuinely flowing, not just flagged
      // as playing - which is exactly the state the .opus file got stuck in.
      if (status.currentTime > this.lastPosition) {
        this.lastPosition = status.currentTime;
        this.armStallWatchdog();
      }

      // The numerator of the Audio Completion Rate. Guarded by terminalReported
      // because didJustFinish can repeat on a status feed that keeps ticking
      // after the end of the track.
      if (status.didJustFinish && !this.terminalReported) {
        this.terminalReported = true;
        // Prefer the real duration over the manifest's: this is the length that
        // was actually played, and track_seconds is denormalised precisely so a
        // later re-cut cannot rewrite history.
        if (status.duration > 0) this.trackSeconds = status.duration;
        this.emit('audio_completed', status.duration > 0 ? status.duration : status.currentTime);
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
    this.player.setActiveForLockScreen(true, { title: waypoint.name });

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

    // 'audio_stopped', never 'audio_skipped'. A track that could not be decoded
    // was never abandoned by the user, and counting it as a skip would blame the
    // tourist for a content pipeline problem.
    void this.stop('audio_stopped');
    this.onError?.(error);
  }

  /**
   * Pause without tearing the player down, so resume() continues in place.
   *
   * Records audio_paused (TASK-507). Non-terminal on purpose: terminalReported
   * stays false, so a track paused and then abandoned still reports its skip or
   * stop, and one paused and resumed still reports its completion.
   */
  pause(): void {
    if (this.player === null) return;
    this.player.pause();
    this.emit('audio_paused', this.lastPosition);
  }

  /**
   * Resume in place.
   *
   * Emits NOTHING. audio_started is the denominator of the Audio Completion
   * Rate, so re-emitting it here would count one listen as two starts and
   * halve the reported completion rate for every track a user ever paused.
   */
  resume(): void {
    this.player?.play();
  }

  /** True while a player exists and is actually producing audio. */
  get isPlaying(): boolean {
    return this.player?.playing ?? false;
  }

  /**
   * Fade out and stop - the zone-exit behaviour from PRD Screen 4.
   *
   * TODO(TASK-103): expo-audio has no built-in fade ramp, so this needs a
   * stepped interval on `player.volume`. Implemented as an abrupt stop for now
   * rather than a fake fade, so the gap is visible instead of hidden.
   */
  async fadeOutAndStop(_durationMs: number = EXIT_FADE_MS): Promise<void> {
    // Walking out of a zone mid-narration is a drop-off, which the schema calls
    // audio_stopped - distinct from audio_skipped, which is one waypoint's
    // narration being displaced by the next. v_kpi_audio_dropoff reads both.
    await this.stop('audio_stopped');
  }

  /**
   * Tear down the player.
   *
   * `reason` is the telemetry verdict for a track that had not finished. It is
   * only emitted when playback was genuinely underway and no terminal event has
   * been reported yet, so a completion is never double-counted as a stop and an
   * idle teardown records nothing at all.
   */
  async stop(reason: 'audio_skipped' | 'audio_stopped' | null = null): Promise<void> {
    // Watchdogs first: a timer firing after teardown would report a phantom
    // failure for a track the user already stopped.
    this.clearTimer('both');

    // Before anything is cleared: emit() reads lastPosition and trackContext,
    // and both are about to be reset.
    if (reason !== null && this.player !== null && !this.terminalReported) {
      this.terminalReported = true;
      this.emit(reason, this.lastPosition);
    }

    // Then the status listener, or removing the player can emit a final update
    // into a UI that has already been told playback ended.
    this.statusSub?.remove();
    this.statusSub = null;
    this.lastPosition = 0;
    this.currentStoragePath = undefined;

    if (!this.player) {
      this.trackContext = null;
      this.trackSeconds = null;
      return;
    }
    this.player.pause();
    this.player.remove();
    this.player = null;
    this.currentTrackId = null;
    this.trackContext = null;
    this.trackSeconds = null;
    this.onStatus?.({ isPlaying: false, positionSeconds: 0, durationSeconds: 0, didJustFinish: false });
  }

  /**
   * Hand one audio event to the sink.
   *
   * Swallows everything. Analytics must never be able to break playback, and a
   * sink that throws is a bug in the sink, not a reason to stop a tour.
   */
  private emit(type: AudioTelemetryType, position: number): void {
    const sink = this.telemetry;
    if (sink === null) return;

    const context: AudioEventContext = {
      tourId: this.trackContext?.tourId ?? null,
      waypointId: this.trackContext?.waypointId ?? null,
      audioTrackId: this.trackContext?.audioTrackId ?? null,
      positionSeconds: position,
      trackSeconds: this.trackSeconds,
    };

    try {
      sink.recordAudio(type, context);
    } catch (err) {
      console.warn('[AudioService] telemetry sink threw:', err);
    }
  }

  get playingTrackId(): string | null {
    return this.currentTrackId;
  }
}
