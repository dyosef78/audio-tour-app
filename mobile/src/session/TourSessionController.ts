import Constants from 'expo-constants';
import { AppState, type AppStateStatus } from 'react-native';

import { AudioService } from '../services/audio/AudioService';
import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import {
  LocationService,
  registerBackgroundLocationTask,
  stopOrphanedLocationUpdates,
  type GeofenceEvent,
} from '../services/location/LocationService';
import { telemetry } from '../services/telemetry/TelemetryService';
import { useTourSession } from './tourSessionStore';
import type { LatLng } from '../types/domain';

/**
 * TourSessionController - the single owner of the running tour.
 *
 * The rule from the approved TASK-202 proposal: screens observe, they never own.
 * This module holds the one LocationService and the one AudioService, and
 * exposes exactly two lifecycle transitions. Nothing else may start or stop the
 * GPS.
 *
 * Lifecycle decisions, per PM:
 *   - The session survives navigating back to Discovery. It is not tied to any
 *     component mount.
 *   - A tour ends ONLY on an explicit endSession(). Reaching the final waypoint
 *     sets a prompt flag and nothing more.
 *   - On cold start, orphaned background tasks are stopped silently and never
 *     resumed, so a killed app cannot leave a ghost draining battery.
 */
/**
 * Stamped onto every telemetry event.
 *
 * Read from the Expo manifest rather than hardcoded, so a KPI regression can be
 * attributed to a specific build. Falls back to 'unknown' rather than throwing:
 * expo-constants shapes differ between dev client and release, and telemetry
 * must never be able to prevent an app from starting.
 */
const APP_VERSION: string = (() => {
  try {
    return Constants.expoConfig?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

class TourSessionController {
  private location: LocationService | null = null;
  private readonly audio = new AudioService();
  private appStateSub: { remove: () => void } | null = null;
  /** Serialises start/end so overlapping calls cannot interleave teardown. */
  private transition: Promise<void> = Promise.resolve();

  // ---------------------------------------------------------------------------
  // Cold start
  // ---------------------------------------------------------------------------

  /**
   * Call once at app entry, before any screen renders.
   * Clears anything a previous process left running.
   */
  async reconcileOnColdStart(): Promise<void> {
    const stopped = await stopOrphanedLocationUpdates();
    if (stopped) {
      console.warn('[TourSession] stopped orphaned background location task from a previous run');
    }
    useTourSession.getState().reset();

    // Telemetry starts with the app, not with a tour (TASK-506). The commonest
    // delivery moment is an app opened on hotel WiFi hours AFTER the walk, so a
    // queue that only drained during a session would strand exactly the events
    // a dead-zone tour produced. start() flushes immediately and then listens
    // for foreground transitions.
    void telemetry.start(APP_VERSION);
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  /**
   * Start a tour from its downloaded bundle.
   *
   * Idempotent: calling it for the tour already running is a no-op. That single
   * property is what makes it safe to call from a component effect despite
   * React 19 StrictMode mounting, unmounting and remounting in development.
   */
  async startSession(tourId: string, tourTitle: string): Promise<void> {
    this.transition = this.transition.then(() => this.doStart(tourId, tourTitle));
    return this.transition;
  }

  private async doStart(tourId: string, tourTitle: string): Promise<void> {
    const store = useTourSession.getState();

    // Already running this exact tour - nothing to do.
    if (store.tourId === tourId && (store.status === 'active' || store.status === 'starting')) {
      return;
    }

    // Switching tours: tear the old one down first, or we leak a watcher.
    if (store.tourId && store.tourId !== tourId) {
      await this.doEnd();
    }

    useTourSession.getState().beginStart(tourId, tourTitle);

    const waypoints = TourBundleRepository.loadWaypoints(tourId);
    const transitMode = TourBundleRepository.loadTransitMode(tourId);

    if (!waypoints || !transitMode) {
      useTourSession
        .getState()
        .sessionFailed('This tour is not downloaded. Download it before starting.');
      return;
    }

    const service = new LocationService(transitMode);
    service.loadTour(waypoints, transitMode);
    service.setCallbacks({
      onLocation: (fix, accuracy) => useTourSession.getState().setFix(fix, accuracy),
      onSamplingChange: (tier) => useTourSession.getState().setSamplingTier(tier),
      onGeofence: (event) => {
        void this.handleGeofence(event);
      },
    });

    const permissions = await service.requestPermissions();
    if (!permissions.foreground) {
      useTourSession
        .getState()
        .sessionFailed('Location permission is required to run a tour.');
      return;
    }

    this.location = service;

    // Mirror the player's own status into the store so the transport UI is
    // honest about state we did not initiate - a track ending, or the OS
    // pausing us for an interruption.
    this.audio.setOnStatus(({ isPlaying, positionSeconds, durationSeconds }) => {
      useTourSession.getState().setPlayback({ isPlaying, positionSeconds, durationSeconds });
    });

    // A decode failure must reach the UI, not just the console. setPlaybackError
    // resets the transport as well, so the panel cannot keep claiming "playing".
    this.audio.setOnError((err) => {
      useTourSession.getState().setPlaybackError(err.message);
    });

    // Telemetry is attached before the first geofence can fire, and detached in
    // doEnd(). audio_started is the denominator of the completion KPI, so a
    // waypoint triggering between start() and this line would skew the rate.
    this.audio.setTelemetry(telemetry);
    void telemetry.record('tour_started', { tourId });

    await this.audio.configureSession();
    await service.start();

    this.appStateSub = AppState.addEventListener('change', (next) => {
      void this.handleAppStateChange(next);
    });

    useTourSession.getState().sessionStarted({
      waypoints,
      transitMode,
      backgroundPermission: permissions.background,
    });
  }

  // ---------------------------------------------------------------------------
  // Geofence -> audio
  // ---------------------------------------------------------------------------

  private async handleGeofence(event: GeofenceEvent): Promise<void> {
    const { waypoint } = event;

    if (event.type === 'enter') {
      useTourSession.getState().markEntered(waypoint.id);

      const track = waypoint.audio;
      // localUri is derived at read time by the bundle repository, never stored.
      const uri = track?.localUri;
      if (!track || !uri) return;

      try {
        await this.audio.play(track, uri, waypoint);
        // Report playing immediately rather than waiting for the first
        // playbackStatusUpdate. Otherwise the transport button shows "paused"
        // for the gap between tapping and the first event - and stays wrong if
        // that event is delayed. The status feed corrects this either way.
        const s = useTourSession.getState();
        s.setPlayback({
          isPlaying: true,
          positionSeconds: 0,
          durationSeconds: track.durationSeconds ?? 0,
        });
      } catch (err) {
        // A missing or unplayable file must not kill the tour - the user keeps
        // walking and the next waypoint still triggers.
        console.warn(`[TourSession] playback failed for ${waypoint.name}:`, err);
        useTourSession
          .getState()
          .setPlaybackError(err instanceof Error ? err.message : 'Could not play this track.');
      }
      return;
    }

    useTourSession.getState().markExited(waypoint.id);

    // Only silence the track THIS waypoint owns.
    //
    // fadeOutAndStop() used to be unconditional, which made an exit stop
    // whatever happened to be playing. That is wrong whenever one fix both
    // enters a zone and exits another - and with exit hysteresis, that is
    // reachable on the shipped test tour: the entry radii (20 m + 25 m = 45 m)
    // clear the 58.7 m gap, but the EXIT radii (x1.6, so 32 m + 40 m = 72 m) do
    // not. evaluateGeofences() walks waypoints in sort order, so arriving at
    // stop 1 from stop 2 emitted enter(1) then exit(2), and exit(2) cut off the
    // narration enter(1) had just started. The user stands at Jaffa Gate in
    // silence. Reproduced by Phase E of npm run sim:walk.
    const exiting = waypoint.audio;
    if (exiting && this.audio.playingTrackId === exiting.id) {
      // Zone exit fades out rather than cutting (PRD Screen 4).
      await this.audio.fadeOutAndStop();
    }
  }

  // ---------------------------------------------------------------------------
  // Manual trigger - for testing without walking to Jerusalem
  // ---------------------------------------------------------------------------

  /**
   * Fire a waypoint's narration by hand, bypassing the distance check.
   *
   * Deliberately synthesises the exact event a real zone entry would produce and
   * pushes it through the SAME handler, rather than calling the audio service
   * directly. Everything downstream of the event runs for real: visit tracking,
   * the completion prompt, local-file resolution, lock-screen metadata and the
   * playback status feed.
   *
   * What it skips, precisely: this never reaches LocationService, so the
   * distance test, the re-trigger cooldown and the exit hysteresis are all
   * bypassed. Repeat taps therefore replay immediately rather than being
   * suppressed by the cooldown - convenient for testing, but it means this is
   * not a test of the debounce logic. LocationService's own zone state is
   * untouched, so a genuine entry later still behaves normally.
   */
  async triggerWaypoint(waypointId: string): Promise<void> {
    const waypoint = useTourSession.getState().waypoints.find((w) => w.id === waypointId);
    if (!waypoint) return;

    await this.handleGeofence({
      type: 'enter',
      waypoint,
      at: waypoint.coordinate,
      timestamp: Date.now(),
    });
  }

  /** Stop narration as a zone exit would, with the same fade-out. */
  async releaseWaypoint(waypointId: string): Promise<void> {
    const waypoint = useTourSession.getState().waypoints.find((w) => w.id === waypointId);
    if (!waypoint) return;

    await this.handleGeofence({
      type: 'exit',
      waypoint,
      at: waypoint.coordinate,
      timestamp: Date.now(),
    });
  }

  /** Transport control for the on-screen player. */
  togglePlayPause(): void {
    if (this.audio.isPlaying) {
      this.audio.pause();
      const s = useTourSession.getState();
      s.setPlayback({ isPlaying: false, positionSeconds: s.positionSeconds, durationSeconds: s.durationSeconds });
    } else {
      this.audio.resume();
      const s = useTourSession.getState();
      s.setPlayback({
        isPlaying: true,
        positionSeconds: s.positionSeconds,
        durationSeconds: s.durationSeconds,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // App state - exactly one location subscription at a time
  // ---------------------------------------------------------------------------

  /**
   * Swap the foreground watcher for the background task and back.
   *
   * Running both would double GPS wake-ups and deliver every fix twice, which
   * the debounce would mask rather than fix. Backgrounding deliberately does
   * NOT stop tracking - hands-free playback with the phone pocketed is the
   * product.
   *
   * ANDROID: startBackground() has no effect while the app is backgrounded
   * until the deferred unified foreground service lands, so tracking pauses
   * there. iOS continues via the default background session type.
   */
  private async handleAppStateChange(next: AppStateStatus): Promise<void> {
    const service = this.location;
    if (!service) return;
    if (useTourSession.getState().status !== 'active') return;

    try {
      if (next === 'background' || next === 'inactive') {
        if (!useTourSession.getState().backgroundPermission) return;
        await service.stop();
        await service.startBackground();
      } else if (next === 'active') {
        await service.stopBackground();
        await service.start();
      }
    } catch (err) {
      console.warn('[TourSession] app-state transition failed:', err);
    }
  }

  /** Background task fixes, delivered outside React entirely. */
  onBackgroundFixes(fixes: LatLng[], timestamp: number): void {
    const service = this.location;
    if (!service) return;
    for (const fix of fixes) service.onFix(fix, null, timestamp);
  }

  // ---------------------------------------------------------------------------
  // End
  // ---------------------------------------------------------------------------

  /** The only way a tour ends. Releases every native resource it owns. */
  async endSession(): Promise<void> {
    this.transition = this.transition.then(() => this.doEnd());
    return this.transition;
  }

  private async doEnd(): Promise<void> {
    this.appStateSub?.remove();
    this.appStateSub = null;

    const service = this.location;
    this.location = null;

    if (service) {
      // Both, unconditionally: whichever was not running is a cheap no-op, and
      // guessing wrong is how a watcher survives the session that owned it.
      await service.stop();
      await service.stopBackground();
    }

    // createAudioPlayer holds native resources until remove(); stop() does that.
    // 'audio_stopped' so a tour ended mid-narration is recorded as a drop-off
    // rather than vanishing from the funnel.
    await this.audio.stop('audio_stopped');
    this.audio.setTelemetry(null);
    this.audio.setOnStatus(null);
    this.audio.setOnError(null);

    useTourSession.getState().reset();
  }

  /** True while hardware is held. Used by tests and debug UI. */
  get isRunning(): boolean {
    return this.location !== null;
  }
}

export const tourSession = new TourSessionController();

/**
 * Registered at module scope, not inside an effect: TaskManager needs the task
 * defined before the OS revives a cold-started JS context, and a component may
 * never have mounted at that point.
 */
registerBackgroundLocationTask((fixes, timestamp) => {
  tourSession.onBackgroundFixes(fixes, timestamp);
});
