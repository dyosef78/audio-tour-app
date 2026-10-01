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
import { networkMonitor } from '../services/network/NetworkMonitor';
import { signedAudioUrls } from '../services/supabase/client';
import { routeCriteria } from '../personalization/options';
import { usePreferences } from '../personalization/preferencesStore';
import { decodeRoute } from '../routing/routeGeometry';
import { routePreferencesOf } from '../routing/routeRequest';
import { selectStops } from '../routing/stopSelection';
import { remoteTranscripts } from '../transcript/TranscriptRepository';
import { routeManager } from './routing';
import { decideResume } from './sessionCheckpoint';
import { sessionCheckpoints } from './sessionCheckpointFile';
import { useTourSession } from './tourSessionStore';
import type { GpsFix } from '../engine/types';
import type { AudioTrack, LatLng, TransitMode, Waypoint } from '../types/domain';

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
 *   - A tour SURVIVES THE PROCESS (Epic 13, P0 - reverses the earlier "never
 *     resume" decision). Its progress is checkpointed synchronously at every
 *     change (sessionCheckpoint.ts). When Android restarts the tracking
 *     service after killing the process, the first batch of fixes rebuilds the
 *     session from the checkpoint - no UI needed - and tracking continues. An
 *     app opened by the user does the same. Only a tour with no usable
 *     checkpoint is stopped, so a killed app still cannot leave a ghost task.
 *
 * THE DEAD ZONE (Epic 13, Directive 1.3). Between the kill and the resumed
 * session, three gaps, in order:
 *   1. Android restarting the service. START_REDELIVER_INTENT restarts it about
 *      a second after a first kill, with exponential backoff after repeated
 *      kills, and an OEM battery manager may delay it or never do it. NO FIXES
 *      EXIST in this gap: GPS is off. This is the real blind spot.
 *   2. The JS engine cold-starting headless (bundle load and module init,
 *      typically 1-3 s). Fixes are recorded but NOT lost: expo-task-manager
 *      queues events natively until the task observer is ready
 *      (TaskManagerInternalModule.mEventsQueue), then flushes them.
 *   3. The resume itself (bundle read, audio session, one native call to adopt
 *      the task). Fixes arriving meanwhile are held in pendingFixes and
 *      replayed, in order, once the session exists.
 * So gaps 2 and 3 only DELAY a narration; nothing is dropped. What is lost is
 * the ground covered during gap 1. A walker crosses a 20 m zone in about 30 s,
 * so a restart within seconds is harmless. If the whole armed zone is walked
 * through during gap 1, that stop is missed and - strict sequencing (Epic 9) -
 * blocks the stops after it until the manual trigger. A narration that was
 * playing at the kill is not resumed.
 */

/** Stages of starting a tour that can fail for reasons outside the app. */
export type StartStage = 'permissions' | 'audio' | 'location' | 'unexpected';

const START_FAILURE_MESSAGE: Record<StartStage, string> = {
  permissions: 'The system refused the location permission request. Nothing was started. Close and reopen the app, then try again.',
  audio: 'The audio engine failed to start, so narration could not play. Nothing was started. Close and reopen the app, then try again.',
  location: 'Location tracking could not start. Keep the app open and try again.',
  unexpected: 'The tour could not start because of an unexpected error. Nothing was started. Go back and try again.',
};

/**
 * Thrown by startSession() after the controller has ALREADY torn down
 * whatever started and set the store to 'error' with `userMessage` (Epic 13,
 * Directive 2). The screen catches it; no "Starting tour..." is left behind.
 */
export class SessionStartError extends Error {
  readonly userMessage: string;
  readonly stage: StartStage;
  readonly reason: unknown;
  constructor(stage: StartStage, reason: unknown) {
    super(`tour start failed at ${stage}: ${reason instanceof Error ? reason.message : String(reason)}`);
    this.name = 'SessionStartError';
    this.stage = stage;
    this.reason = reason;
    this.userMessage = START_FAILURE_MESSAGE[stage];
  }
}

/** Fixes held while a session is being rebuilt; the oldest go first past this. */
const MAX_PENDING_FIXES = 200;

type ResumeOrigin = 'background_task' | 'cold_start';
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
  /** Serialises start/end/resume so overlapping calls cannot interleave teardown. */
  private transition: Promise<void> = Promise.resolve();
  /** When the running tour was first started; carried into every checkpoint. */
  private sessionStartedAt = 0;
  /** Background fixes that arrived with no session in memory (see onBackgroundFixes). */
  private pendingFixes: GpsFix[] = [];
  /** A background-task resume is queued; later batches only add to pendingFixes. */
  private resumeQueued = false;

  // ---------------------------------------------------------------------------
  // Cold start
  // ---------------------------------------------------------------------------

  /**
   * Call once at app entry, before any screen renders.
   *
   * Resumes a tour a previous process left running (Epic 13), or, when there is
   * none worth resuming, clears what it left behind. Queued like every other
   * transition: if the background task already resumed the tour in this
   * process, that session is kept as it is.
   */
  async reconcileOnColdStart(): Promise<void> {
    try {
      await this.enqueue(async () => {
        if (this.location) return;
        if (await this.doResume('cold_start')) return;
        const stopped = await stopOrphanedLocationUpdates();
        if (stopped) {
          console.warn('[TourSession] stopped orphaned background location task from a previous run');
        }
        useTourSession.getState().reset();
      });
    } catch (err) {
      console.error('[TourSession] cold-start reconciliation failed:', err);
    }

    // Telemetry starts with the app, not with a tour (TASK-506). The commonest
    // delivery moment is an app opened on hotel WiFi hours AFTER the walk, so a
    // queue that only drained during a session would strand exactly the events
    // a dead-zone tour produced. start() flushes immediately and then listens
    // for foreground transitions.
    //
    // Attached to the network BEFORE start() (TASK-605): a queue must drain the
    // moment signal returns mid-walk, not when a backoff that has grown to 15
    // minutes happens to expire.
    telemetry.attachNetwork(networkMonitor);
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
    return this.enqueue(async () => {
      try {
        await this.doStart(tourId, tourTitle);
      } catch (err) {
        if (err instanceof SessionStartError) throw err;
        // Anything the guarded stages did not anticipate gets the same
        // treatment: torn down, reported in the store, rethrown.
        await this.failStart('unexpected', err);
      }
    });
  }

  /**
   * Tear down, put the reason in the store, and throw (Epic 13, Directive 2).
   * The ONE way a start fails with an exception, so every such failure leaves
   * the same state: no hardware held, no checkpoint, status 'error'.
   */
  private async failStart(stage: StartStage, reason: unknown): Promise<never> {
    const error = new SessionStartError(stage, reason);
    console.error(`[TourSession] ${error.message}`, reason);
    await this.doEnd();
    useTourSession.getState().sessionFailed(error.userMessage);
    throw error;
  }

  /**
   * Run one transition after the previous one. The CALLER gets this run's
   * outcome, error included; the queue itself continues past a failure. Chaining
   * onto a rejected promise would silently skip every later start and end for
   * the life of the process.
   */
  private enqueue(run: () => Promise<void>): Promise<void> {
    const result = this.transition.then(run);
    this.transition = result.catch(() => undefined);
    return result;
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

    // TASK-604: onboarding preferences decide which stops this session RUNS.
    // Snapshotted here - editing preferences mid-walk does not reshuffle a tour
    // already under way. Skipped stops leave the geofence engine as well as the
    // map: a hidden pin whose narration still fired as you walked past it along
    // the route would be the worst of both.
    const criteria = routeCriteria(usePreferences.getState());
    const selection = selectStops(waypoints, criteria);

    const service = new LocationService(transitMode);
    service.loadTour(selection.active, transitMode);
    this.wireLocation(service);

    // Each native stage is guarded (Epic 13, Directive 2): a bridge that throws
    // must end in failStart - teardown, an error the screen shows, a rethrow -
    // never in a rejected promise nobody awaits and a spinner that never ends.
    let permissions: Awaited<ReturnType<LocationService['requestPermissions']>>;
    try {
      permissions = await service.requestPermissions();
    } catch (err) {
      return this.failStart('permissions', err);
    }
    if (!permissions.foreground) {
      // An answer, not a failure: the person said no. Nothing was started.
      useTourSession
        .getState()
        .sessionFailed('Location permission is required to run a tour.');
      return;
    }

    this.location = service;
    this.sessionStartedAt = Date.now();
    this.wireAudio();
    void telemetry.record('tour_started', { tourId });

    try {
      await this.audio.configureSession();
    } catch (err) {
      return this.failStart('audio', err);
    }
    try {
      await service.start();
    } catch (err) {
      // Android can refuse here: its location foreground service only starts
      // while the app is in the foreground, so switching away mid-start throws
      // (LocationService header). A tour that cannot track must not look like
      // one that is running.
      return this.failStart('location', err);
    }

    this.attachAppState();

    useTourSession.getState().sessionStarted({
      waypoints: selection.active,
      transitMode,
      backgroundPermission: permissions.background,
      notificationPermission: permissions.notifications,
      skippedWaypointIds: selection.skippedIds,
    });

    // Publishes the best route available offline synchronously, in the same
    // tick as sessionStarted, so the first map frame already has it; then
    // upgrades to a live route - the Smart Sorter's order - if and when it can.
    // The same preference snapshot that selected the stops scores their order
    // (TASK-903): editing preferences mid-walk reshuffles nothing.
    void routeManager.start({
      tourId,
      transitMode,
      stops: selection.active,
      preferences: routePreferencesOf(criteria),
      staticRoute: this.loadStaticRoute(tourId, selection.active, transitMode),
      bundleHash: TourBundleRepository.readManifest(tourId)?.bundle_version_hash ?? null,
      onStopOrder: (waypointIds) => this.adoptStopOrder(service, waypointIds),
    });

    // Last: the checkpoint describes a session that has fully started.
    this.saveCheckpoint();
  }

  /** The LocationService callbacks, identical for a fresh start and a resume. */
  private wireLocation(service: LocationService): void {
    service.setCallbacks({
      onLocation: (fix, accuracy) => useTourSession.getState().setFix(fix, accuracy),
      onSamplingChange: (tier) => useTourSession.getState().setSamplingTier(tier),
      onGeofence: (event) => {
        void this.handleGeofence(event);
      },
    });
  }

  /** The AudioService hooks, identical for a fresh start and a resume. */
  private wireAudio(): void {
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
  }

  private attachAppState(): void {
    this.appStateSub?.remove();
    this.appStateSub = AppState.addEventListener('change', (next) => {
      void this.handleAppStateChange(next);
    });
  }

  // ---------------------------------------------------------------------------
  // Checkpoint and resume (Epic 13)
  // ---------------------------------------------------------------------------

  /**
   * Record the running tour, synchronously, so a killed process can resume it.
   *
   * Never throws: a disk that refuses the write must not stop the narration
   * the user is standing in. It is reported as an error instead, because the
   * consequence - this tour will not survive a kill - is real.
   */
  private saveCheckpoint(): void {
    const service = this.location;
    const s = useTourSession.getState();
    if (!service || !s.tourId || !s.transitMode) return;
    const { order, passed } = service.progress();
    try {
      sessionCheckpoints.save({
        v: 1,
        tourId: s.tourId,
        tourTitle: s.tourTitle ?? 'Tour',
        transitMode: s.transitMode,
        activeIds: s.waypoints.map((w) => w.id),
        skippedIds: [...s.skippedWaypointIds],
        order,
        passed,
        visited: [...s.visitedWaypointIds],
        backgroundPermission: s.backgroundPermission,
        notificationPermission: s.notificationPermission,
        startedAt: this.sessionStartedAt,
        savedAt: Date.now(),
      });
    } catch (err) {
      console.error('[TourSession] checkpoint NOT written - this tour cannot resume after a process kill:', err);
    }
  }

  private clearCheckpoint(): void {
    try {
      sessionCheckpoints.clear();
    } catch (err) {
      // Reported, not thrown: teardown must finish. The age limit in
      // decideResume stops a stale checkpoint resuming forever.
      console.error('[TourSession] checkpoint could not be deleted; an ended tour may resume on the next launch:', err);
    }
  }

  /**
   * Rebuild the session a previous process was running. True when a session
   * is running afterwards. Never throws: every failure is logged, torn down
   * and reported as false, so the caller can stop an orphaned task.
   *
   * A background-task resume that fails KEEPS the checkpoint, so opening the
   * app can try once more in the foreground; a cold-start resume that fails
   * deletes it, so a broken checkpoint cannot fail every launch.
   */
  private async doResume(origin: ResumeOrigin): Promise<boolean> {
    if (this.location) return true;

    const decision = decideResume(sessionCheckpoints.load(), Date.now());
    if (decision.kind === 'nothing') return false;
    const discard = (reason: string): false => {
      console.warn(`[TourSession] saved tour not resumed (${origin}): ${reason}`);
      this.clearCheckpoint();
      return false;
    };
    if (decision.kind === 'discard') return discard(decision.reason);
    const cp = decision.checkpoint;

    const waypoints = TourBundleRepository.loadWaypoints(cp.tourId);
    if (!waypoints) return discard('the tour is no longer downloaded');
    const byId = new Map(waypoints.map((w) => [w.id, w]));
    const active = cp.activeIds.map((id) => byId.get(id));
    if (!active.every((w): w is Waypoint => w !== undefined)) {
      return discard('the downloaded tour no longer has every stop (updated since?)');
    }

    const service = new LocationService(cp.transitMode);
    service.loadTour(active, cp.transitMode);
    if (!service.restoreProgress(cp.order, cp.passed)) return discard('saved progress does not fit the stops');

    useTourSession.getState().beginStart(cp.tourId, cp.tourTitle);
    this.wireLocation(service);
    this.location = service;
    this.sessionStartedAt = cp.startedAt;
    this.wireAudio();

    const fail = async (stage: 'audio' | 'location', err: unknown): Promise<false> => {
      console.error(`[TourSession] resume (${origin}) failed at ${stage}:`, err);
      await this.doEnd({ keepCheckpoint: origin === 'background_task' });
      return false;
    };
    try {
      await this.audio.configureSession();
    } catch (err) {
      return fail('audio', err);
    }
    try {
      await service.resumeTracking();
    } catch (err) {
      return fail('location', err);
    }
    if (!service.persistentTask) this.attachAppState();

    const store = useTourSession.getState();
    store.sessionStarted({
      waypoints: active,
      transitMode: cp.transitMode,
      backgroundPermission: cp.backgroundPermission,
      notificationPermission: cp.notificationPermission,
      skippedWaypointIds: cp.skippedIds,
    });
    store.setStopOrder(cp.order);
    store.restoreVisited(cp.visited);
    // Offline route only: a live fetch could adopt a DIFFERENT order than the
    // one the walk has been following. The bundled line, or straight joins.
    const staticRoute = this.loadStaticRoute(cp.tourId, active, cp.transitMode);
    store.setRoute(staticRoute ? { source: 'static', points: staticRoute } : { source: 'straight', points: null });

    this.saveCheckpoint();
    console.warn(
      `[TourSession] resumed tour ${cp.tourId} (${origin}): ${cp.passed.length}/${cp.activeIds.length} stops passed, next ${service.nextWaypointId() ?? 'none'}`,
    );
    return true;
  }

  /**
   * A batch of background fixes found no session in memory: Android restarted
   * the tracking service in a new process. Rebuild the session and replay the
   * held fixes; with nothing to rebuild, stop the task - it is a zombie.
   *
   * pendingFixes is drained and resumeQueued cleared in ONE synchronous block
   * at the end, so a batch arriving at any await in between is either held
   * (and replayed here) or finds the session - never lost between the two.
   */
  private async resumeFromBackgroundTask(): Promise<void> {
    let resumed = this.location !== null;
    try {
      if (!resumed) resumed = await this.doResume('background_task');
      if (!resumed) {
        const stopped = await stopOrphanedLocationUpdates();
        console.warn(`[TourSession] background fixes with no tour to resume; tracking task ${stopped ? 'stopped' : 'was not running'}`);
      }
    } finally {
      const pending = this.pendingFixes;
      this.pendingFixes = [];
      this.resumeQueued = false;
      const service = this.location;
      if (service) for (const p of pending) service.onGpsFix(p);
    }
  }

  /**
   * Narrate in the order the live route visits the stops (TASK-902).
   *
   * The engine and the store move together or not at all, so the player's
   * "stop N of M" always counts in the order the geofences fire. Guarded on the
   * service: RouteManager already drops a late answer from an ended session,
   * and this makes a restarted one safe as well.
   */
  private adoptStopOrder(service: LocationService, waypointIds: string[]): void {
    if (this.location !== service) return;
    const before = service.stopOrder().join(',');
    if (!service.setStopOrder(waypointIds)) {
      console.warn('[TourSession] visiting order rejected by the geofence engine; keeping the current order');
      return;
    }
    useTourSession.getState().setStopOrder(waypointIds);
    this.saveCheckpoint();
    if (before !== waypointIds.join(',')) {
      console.log(`[TourSession] narration follows the routed order; next stop ${service.nextWaypointId() ?? 'none'}`);
    }
  }

  /**
   * The bundle's route, validated against the stops this session runs.
   *
   * A route that fails validation is logged and dropped: dashed straight lines
   * are honest about being approximate; a confident line that misses the stops
   * is not.
   */
  private loadStaticRoute(tourId: string, stops: Waypoint[], transitMode: TransitMode): LatLng[] | null {
    const encoded = TourBundleRepository.loadRoute(tourId);
    if (!encoded) return null;
    const checked = decodeRoute(encoded, stops, transitMode);
    if (checked.ok) return checked.points;
    console.warn(`[TourSession] bundled route ignored: ${checked.reason}`);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Geofence -> audio
  // ---------------------------------------------------------------------------

  private async handleGeofence(event: GeofenceEvent): Promise<void> {
    const { waypoint } = event;

    if (event.type === 'enter') {
      useTourSession.getState().markEntered(waypoint.id);
      // Synchronously, before any await: the stop is passed in the engine NOW,
      // and a kill during the narration below must not replay it on resume.
      this.saveCheckpoint();

      // Re-entering the stop whose Deep Dive is playing must not restart the
      // short narration over it: the listener is plainly still at that stop.
      // markEntered() keeps deepDiveWaypointId for exactly this case.
      if (useTourSession.getState().deepDiveWaypointId === waypoint.id) return;

      const track = waypoint.audio;
      if (!track) return;
      const uri = await this.playableUri(track);
      if (!uri) return;
      // Streaming takes a round trip to sign; if the listener left the stop
      // meanwhile, starting its narration now would play it in the wrong place.
      if (useTourSession.getState().activeWaypointId !== waypoint.id) return;

      try {
        await this.audio.play(track, uri, waypoint);
        // Report playing immediately rather than waiting for the first
        // playbackStatusUpdate. Otherwise the transport button shows "paused"
        // for the gap between tapping and the first event - and stays wrong if
        // that event is delayed. The status feed corrects this either way.
        //
        // Guarded: play() reports an unsupported format or a failed create
        // through onError and then RETURNS normally. Claiming "playing" after
        // that overwrote the error state setPlaybackError had just reset.
        if (this.audio.playingTrackId !== track.id) return;
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
    // not. evaluateGeofences() walked waypoints in sort order, so arriving at
    // stop 1 from stop 2 emitted enter(1) then exit(2), and exit(2) cut off the
    // narration enter(1) had just started. The user stands at Jaffa Gate in
    // silence. Since TASK-902 exits are emitted before the entry, but this check
    // stays: it is what makes the event ORDER irrelevant here. Phase E of
    // npm run sim:walk.
    const exiting = waypoint.audio;
    if (exiting && this.audio.playingTrackId === exiting.id) {
      // Zone exit fades out rather than cutting (PRD Screen 4).
      await this.audio.fadeOutAndStop();
    }
  }

  /**
   * What to hand the player (TASK-605, Hybrid Offline-First).
   *
   * The bundled file, whenever it is on disk - which is the normal case and
   * costs nothing. If it is NOT (storage cleared by the OS or the user, or the
   * download removed while a tour was open) and the device is online, a signed
   * stream of the same object instead: before this, that stop simply played
   * silence with full signal available.
   *
   * Offline with no file, the local path is returned unchanged so AudioService
   * fails loudly exactly as it did before, rather than silently.
   *
   * A streamed track's transcript is fetched alongside it (TASK-1003), so the
   * karaoke text survives the fallback too. Not awaited: playback must not
   * wait on an accessibility extra, and the view shows "loading" meanwhile.
   */
  private async playableUri(track: AudioTrack): Promise<string | null> {
    const local = track.localUri ?? null;
    if (local !== null && TourBundleRepository.localFileExists(local)) return local;
    if (!networkMonitor.isOnline()) return local;

    try {
      const remote = (await signedAudioUrls([track.storagePath])).get(track.storagePath);
      if (remote) {
        console.warn(`[TourSession] ${track.storagePath} is not on disk; streaming it instead`);
        void remoteTranscripts.prefetch(track.storagePath);
        return remote;
      }
    } catch (err) {
      console.warn(`[TourSession] could not sign a stream for ${track.storagePath}:`, err);
    }
    return local;
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
   * not a test of the debounce logic. LocationService's zone state is
   * untouched.
   *
   * It DOES advance the visiting order (TASK-902): the stop, and any stop
   * scheduled before it that was not reached, count as passed, so the engine
   * arms the stop after it. Without that, a stop triggered by hand would still
   * be armed and would narrate a second time on arrival, and a stop whose zone
   * was missed would block the rest of the tour. Replaying a stop already
   * passed (playNarration) leaves the order alone.
   */
  async triggerWaypoint(waypointId: string): Promise<void> {
    const waypoint = useTourSession.getState().waypoints.find((w) => w.id === waypointId);
    if (!waypoint) return;

    this.location?.markReached(waypointId);

    await this.handleGeofence({
      type: 'enter',
      waypoint,
      at: waypoint.coordinate,
      timestamp: Date.now(),
    });
  }

  /**
   * Stop a stop's audio as a zone exit would, with the same fade-out.
   *
   * A Deep Dive deliberately survives a zone exit, so the synthetic exit alone
   * would leave one playing behind a dismissed player. Stop means stop.
   */
  async releaseWaypoint(waypointId: string): Promise<void> {
    const waypoint = useTourSession.getState().waypoints.find((w) => w.id === waypointId);
    if (!waypoint) return;

    const store = useTourSession.getState();
    if (store.deepDiveWaypointId === waypointId) {
      store.endDeepDive();
      await this.audio.stop('audio_stopped');
    }

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

  /** Seek the current track. The store is updated at once so the highlight moves on tap. */
  async seekTo(seconds: number): Promise<void> {
    const target = Math.max(0, seconds);
    await this.audio.seekTo(target);
    const s = useTourSession.getState();
    s.setPlayback({ isPlaying: s.isPlaying, positionSeconds: target, durationSeconds: s.durationSeconds });
  }

  async rewind(seconds: number): Promise<void> {
    await this.seekTo(useTourSession.getState().positionSeconds - seconds);
  }

  /**
   * Play a stop's Deep Dive in place of its narration (TASK-602).
   *
   * Goes through the same AudioService.play() as narration, so the Deep Dive is
   * a real audio_started/completed/skipped event stream. That is a KPI problem
   * the handover flags: nothing in the event distinguishes the two kinds.
   */
  async playDeepDive(waypointId: string): Promise<void> {
    const waypoint = useTourSession.getState().waypoints.find((w) => w.id === waypointId);
    const track = waypoint?.deepDive;
    if (!waypoint || !track) return;
    const uri = await this.playableUri(track);
    if (!uri) return;

    // Before play(), not after: a synchronous failure inside play() reports
    // through setPlaybackError, and startDeepDive would clear that error.
    useTourSession.getState().startDeepDive(waypoint.id);

    try {
      await this.audio.play(track, uri, waypoint);
      if (this.audio.playingTrackId !== track.id) return;
      useTourSession.getState().setPlayback({
        isPlaying: true,
        positionSeconds: 0,
        durationSeconds: track.durationSeconds ?? 0,
      });
    } catch (err) {
      console.warn(`[TourSession] deep dive failed for ${waypoint.name}:`, err);
      useTourSession
        .getState()
        .setPlaybackError(err instanceof Error ? err.message : 'Could not play the Deep Dive.');
    }
  }

  /** Leave a Deep Dive and replay the stop's own narration. */
  async playNarration(waypointId: string): Promise<void> {
    useTourSession.getState().endDeepDive();
    await this.triggerWaypoint(waypointId);
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
   * ANDROID: no handoff at all. The task opened by start() already runs
   * across foreground and background, and starting one from here would throw -
   * the app is no longer in the foreground by the time this fires (Epic 13).
   */
  private async handleAppStateChange(next: AppStateStatus): Promise<void> {
    const service = this.location;
    if (!service) return;
    if (service.persistentTask) return;
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

  /**
   * Background task fixes, delivered outside React entirely.
   *
   * With no session in memory these are held and a resume is queued (Epic 13):
   * Android restarted the tracking service in a fresh process. See
   * resumeFromBackgroundTask for why nothing falls between the two.
   */
  onBackgroundFixes(fixes: GpsFix[]): void {
    const service = this.location;
    if (service) {
      for (const fix of fixes) service.onGpsFix(fix);
      return;
    }
    this.pendingFixes.push(...fixes);
    if (this.pendingFixes.length > MAX_PENDING_FIXES) {
      this.pendingFixes.splice(0, this.pendingFixes.length - MAX_PENDING_FIXES);
    }
    if (this.resumeQueued) return;
    this.resumeQueued = true;
    this.enqueue(() => this.resumeFromBackgroundTask()).catch((err) => {
      console.error('[TourSession] background resume failed:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // End
  // ---------------------------------------------------------------------------

  /** The only way a tour ends. Releases every native resource it owns. */
  async endSession(): Promise<void> {
    return this.enqueue(() => this.doEnd());
  }

  /**
   * `keepCheckpoint`: tear down this process's session but leave the tour
   * resumable - only for a background resume that failed (doResume).
   */
  private async doEnd(options: { keepCheckpoint?: boolean } = {}): Promise<void> {
    // FIRST, synchronously: a kill anywhere in the awaits below must not let a
    // tour the user ended come back on the next launch.
    if (!options.keepCheckpoint) this.clearCheckpoint();

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

    // Aborts any route request and ignores its late answer.
    routeManager.stop();

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
registerBackgroundLocationTask((fixes) => {
  tourSession.onBackgroundFixes(fixes);
});
// This is the entry point Android's restarted tracking service reaches: the OS
// re-runs index.ts headless, which imports this module, which registers the
// task above. The UI never mounts, so this handler - not App - resumes the
// tour (onBackgroundFixes -> resumeFromBackgroundTask).
