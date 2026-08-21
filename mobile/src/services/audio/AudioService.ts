import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';

import type { AudioTrack } from '../../types/domain';

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
    this.player = createAudioPlayer({ uri });
    this.currentTrackId = track.id;
    this.player.volume = FULL_VOLUME;

    // Required alongside 'doNotMix' for sustained Android background playback,
    // and it populates the lock-screen controls with the stop being narrated.
    this.player.setActiveForLockScreen(true, { title: waypointName });

    this.player.play();
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
    if (!this.player) return;
    this.player.pause();
    this.player.remove();
    this.player = null;
    this.currentTrackId = null;
  }

  get playingTrackId(): string | null {
    return this.currentTrackId;
  }
}
