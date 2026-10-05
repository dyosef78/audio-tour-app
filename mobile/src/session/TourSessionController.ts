import Constants from 'expo-constants';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import type { PlanTourOk } from '../../../shared/src/contracts/planTour';
import { chaptersOf, engineTourFromManifest } from '../engine/fromManifest';
import { engineTourFromPlan, planChapters } from '../engine/fromPlan';
import { allStopsResolved, createEngineState, freshProgress, nextChapterOf, progressProblem } from '../engine/reduce';
import { planHandoff, type HandoffPlan, type HandoffProvider, type HandoffSpec } from '../handoff/handoffLinks';
import type { Effect, EngineState, EngineTour, Progress, TrackKind } from '../engine/types';
import { AudioActor } from '../services/audio/AudioActor';
import { AudioService } from '../services/audio/AudioService';
import { interruptionModeFor } from '../services/audio/sessionMode';
import { finestMode } from '../config/transitProfiles';
import { TourBundleRepository } from '../services/bundle/TourBundleRepository';
import { isGoogleMapsInstalled, openNavigationUrl } from '../services/handoff/navigationApps';
import {
  dismissTourNotification,
  notifyChapterArrived,
  notifyTourSuspended,
  requestTourNotificationPermission,
} from '../services/notifications/tourNotifications';
import {
  LocationService,
  registerBackgroundLocationTask,
  stopOrphanedLocationUpdates,
  TrackingLostError,
} from '../services/location/LocationService';
import { savedPlans } from '../services/planner/planRepositoryFile';
import { telemetry } from '../services/telemetry/TelemetryService';
import { networkMonitor } from '../services/network/NetworkMonitor';
import { signedAudioUrls } from '../services/supabase/client';
import { decodeRoute } from '../routing/routeGeometry';
import { sessionStops, type SessionStops } from '../routing/stopSelection';
import { remoteTranscripts } from '../transcript/TranscriptRepository';
import { EngineRunner, type EngineRunnerPorts } from './EngineRunner';
import { optimisticHandoff } from './optimisticHandoff';
import { decideSnapshotResume, type SessionSource, type TourProgressSnapshot } from './progressRepository';
import { planSessionKey } from './sessionKey';
import { engineEventTourId } from './telemetryAttribution';
import { tourProgress } from './sessionCheckpointFile';
import { useTourSession, type ChapterView } from './tourSessionStore';
import type { GpsFix } from '../engine/types';
import type { WireBundle, WireChapter } from '../services/bundle/types';
import type { AudioTrack, LatLng, TransitMode, Waypoint } from '../types/domain';

/**
 * TourSessionController - the single owner of the running tour.
 *
 * The rule from the approved TASK-202 proposal: screens observe, they never own.
 * This module holds the one LocationService, the one AudioService and - since
 * Epic 15 - the one loose-sequence engine. Nothing else may start or stop the
 * GPS.
 *
 * EPIC 15: THE CONTROLLER IS A SHELL AROUND A PURE ENGINE.
 *
 *   LocationService (engine mode) --GpsFix--+
 *   AudioActor (audio callbacks) ----------+--> EngineRunner.dispatch --> reduce()
 *   1 Hz heartbeat, the listener's taps ---+          |
 *                                                     v   (one drain, fixed order)
 *                       persist (TourProgressRepository, sync) -> publish (store)
 *                       -> effects: AudioActor PLAY/STOP/RESUME, transit mode,
 *                          telemetry
 *
 * Every decision - which stop fires, what plays, what waits, what expires - is
 * engine/reduce.ts. This file adapts: it starts and ends sessions, maps the
 * bundle into the engine's tour, resolves audio files, and projects the
 * engine's state into the store. The event loop's ordering and failure rules
 * live in EngineRunner.
 *
 * Lifecycle decisions, per PM:
 *   - The session survives navigating back to Discovery. It is not tied to any
 *     component mount.
 *   - A tour ends ONLY on an explicit endSession(). Every stop being settled
 *     raises a prompt and nothing more.
 *   - A tour SURVIVES THE PROCESS (Epic 13). The engine's progress is persisted
 *     synchronously, before any audio effect, at every change. When Android
 *     restarts the tracking service after killing the process, the first batch
 *     of fixes rebuilds the session from it - no UI needed. An app opened by
 *     the user does the same.
 *   - Navigation is the navigation app's job (Epic 15, decision 5): the map
 *     shows the bundled route; nothing on the device routes or reorders.
 *
 * THE DEAD ZONE (Epic 13, Directive 1.3) is unchanged: fixes during the
 * service restart do not exist; fixes during JS boot and the resume are queued
 * and replayed. What is new is what a gap COSTS: a stop walked through during
 * it no longer blocks the tour - the window and re-anchor carry on past it.
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

/** Everything about the running session that is not engine state. */
interface SessionMeta {
  /** The session key (sessionKey.ts) - a tour id, or plan:<planId>. NEVER a telemetry tour_id as such. */
  tourId: string;
  /** Epic 16: a catalogue tour, or a saved plan (id + content hash). */
  source: SessionSource;
  /**
   * Epic 16: tracking sampling fixed for the whole session (a plan, at
   * finestMode of its chapters). Chapter changes then never restart tracking;
   * only the audio mode follows the chapter.
   */
  pinnedTracking: TransitMode | null;
  tourTitle: string;
  activeIds: string[];
  backgroundPermission: boolean;
  notificationPermission: boolean;
  startedAt: number;
  waypointsById: Map<string, Waypoint>;
  /** The manifest's chapters (titles, handoff), sorted - for the panel and the handoff. */
  chapters: WireChapter[];
}

/** What resume rebuilt from the bundles, or why it cannot. */
type Rebuilt =
  | { kind: 'ok'; tour: EngineTour; active: Waypoint[]; chapters: WireChapter[]; staticRouteTourId: string | null; sourceTourIds: string[] }
  | { kind: 'discard'; reason: string };

class TourSessionController {
  private location: LocationService | null = null;
  private readonly audio = new AudioService();
  private actor: AudioActor | null = null;
  private runner: EngineRunner | null = null;
  private session: SessionMeta | null = null;
  private appStateSub: { remove: () => void } | null = null;
  /** Serialises start/end/resume so overlapping calls cannot interleave teardown. */
  private transition: Promise<void> = Promise.resolve();
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

    // Telemetry starts with the app, not with a tour (TASK-506), and is
    // attached to the network first so a queue drains the moment signal
    // returns mid-walk (TASK-605).
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
   * outcome, error included; the queue itself continues past a failure.
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
    const manifest = TourBundleRepository.readManifest(tourId);
    if (!waypoints || !manifest) {
      useTourSession.getState().sessionFailed('This tour is not downloaded. Download it before starting.');
      return;
    }

    // Epic 16: a catalogue session runs every core stop in authored order and
    // nothing else - no extensions, and no preference filtering (TASK-604 is
    // retired: it could drop a stop while keeping the transition that leads
    // to it). A manifest the engine cannot represent faithfully (a newer
    // server's mode, a malformed zone, a transition marked optional) is
    // refused, not approximated.
    let selection: SessionStops;
    let tour: EngineTour;
    try {
      selection = sessionStops(waypoints, { kind: 'catalogue' });
      tour = engineTourFromManifest(manifest, selection.active.map((w) => w.id));
    } catch (err) {
      return this.failStart('unexpected', err);
    }

    await this.launch({
      key: tourId,
      title: tourTitle,
      source: { kind: 'tour' },
      sourceTourIds: [tourId],
      active: selection.active,
      tour,
      chapters: chaptersOf(manifest),
      staticRouteTourId: tourId,
    });
  }

  /**
   * Epic 16: start a SAVED plan - chapters from several tours, joined by
   * synthetic travel chapters (engine/fromPlan.ts). Everything after the
   * tour is built is the catalogue path (launch()): one engine, one audio
   * lane, one tracker. Idempotent like startSession().
   */
  async startPlannedSession(planId: string, title: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.doStartPlan(planId, title);
      } catch (err) {
        if (err instanceof SessionStartError) throw err;
        await this.failStart('unexpected', err);
      }
    });
  }

  private async doStartPlan(planId: string, title: string): Promise<void> {
    const key = planSessionKey(planId);
    const store = useTourSession.getState();
    if (store.tourId === key && (store.status === 'active' || store.status === 'starting')) return;
    if (store.tourId && store.tourId !== key) await this.doEnd();

    const entry = savedPlans.get(planId);
    useTourSession.getState().beginStart(key, title, entry?.plan.sources.map((s) => s.tour_id) ?? []);
    // A draft pins nothing: its tours may change under it. Only a plan whose
    // every bundle was verified on this device may run (PlanPreview saves it).
    if (entry === null) {
      useTourSession.getState().sessionFailed('This plan is gone. Plan again from Discovery.');
      return;
    }
    if (entry.status !== 'saved') {
      useTourSession.getState().sessionFailed('Download and save this plan before starting it.');
      return;
    }

    const pieces = this.planPieces(entry.plan);
    if (pieces.kind === 'not_runnable') {
      // Expected, not a crash: the reconciler normally catches this first.
      useTourSession.getState().sessionFailed(`This plan no longer matches the tours on this device (${pieces.reason}). Plan again.`);
      return;
    }

    await this.launch({
      key,
      title,
      source: { kind: 'plan', planId, contentHash: entry.plan.content_hash },
      sourceTourIds: entry.plan.sources.map((s) => s.tour_id),
      active: pieces.active,
      tour: pieces.tour,
      chapters: pieces.chapters,
      staticRouteTourId: null,
    });
  }

  /**
   * A plan, as the engine and the panel need it, from the bundles on disk.
   *
   * STOP IDS ARE NOT NAMESPACED. A stop id is waypoints.id - a uuid primary
   * key - and every row has exactly one tour_id. Two tours that both visit a
   * plaza have two rows, two ids, two zones; the engine arms only the active
   * chapter's stops, so their overlap never collides. The same id in two
   * manifests is therefore impossible without corruption, and is refused
   * loudly (thrown -> failStart), never merged or renamed.
   */
  private planPieces(plan: PlanTourOk):
    | { kind: 'ok'; tour: EngineTour; active: Waypoint[]; chapters: WireChapter[] }
    | { kind: 'not_runnable'; reason: string } {
    const manifests = new Map<string, WireBundle>();
    const byId = new Map<string, Waypoint>();
    for (const s of plan.sources) {
      const manifest = TourBundleRepository.readManifest(s.tour_id);
      const waypoints = TourBundleRepository.loadWaypoints(s.tour_id);
      if (!manifest || !waypoints) return { kind: 'not_runnable', reason: `tour ${s.tour_id} is not downloaded` };
      manifests.set(s.tour_id, manifest);
      for (const w of waypoints) {
        const other = byId.get(w.id);
        if (other) throw new Error(`stop ${w.id} is in two tours (${other.tourId} and ${s.tour_id}): stop ids are primary keys - a corrupt bundle`);
        byId.set(w.id, w);
      }
    }
    let tour: EngineTour;
    try {
      // Runs planProblem(): pins, chapters, every core stop, extension sets.
      tour = engineTourFromPlan(plan, manifests);
    } catch (err) {
      if (err instanceof RangeError) return { kind: 'not_runnable', reason: err.message };
      throw err;
    }
    const active = plan.segments.flatMap((seg) =>
      seg.kind === 'chapter'
        ? seg.waypoint_ids.map((id) => {
            const w = byId.get(id);
            if (!w) throw new Error(`plan stop ${id} passed planProblem but is not in the bundle`);
            return w;
          })
        : [],
    );
    return { kind: 'ok', tour, active, chapters: planChapters(plan, manifests) };
  }

  /**
   * Everything after the tour is built, shared by catalogue and planned
   * sessions: tracking permissions, the audio session, the engine, tracking,
   * the store, the checkpoint. Each native stage guarded (Epic 13, Directive 2).
   */
  private async launch(spec: {
    key: string;
    title: string;
    source: SessionSource;
    sourceTourIds: string[];
    active: Waypoint[];
    tour: EngineTour;
    chapters: WireChapter[];
    /** The tour whose bundled route the map draws; null draws straight lines (a plan spans tours). */
    staticRouteTourId: string | null;
  }): Promise<void> {
    const firstChapter = spec.tour.chapters[0];
    if (!firstChapter) return this.failStart('unexpected', new Error('the tour has no chapters'));

    const pinnedTracking = spec.source.kind === 'plan' ? finestMode(spec.tour.chapters.map((c) => c.transitMode)) : null;
    const service = new LocationService(pinnedTracking ?? firstChapter.transitMode, Platform.OS);

    // Each native stage is guarded (Epic 13, Directive 2): a bridge that throws
    // must end in failStart - teardown, an error the screen shows, a rethrow.
    let permissions: Awaited<ReturnType<LocationService['requestPermissions']>>;
    try {
      permissions = await service.requestPermissions();
    } catch (err) {
      return this.failStart('permissions', err);
    }
    if (!permissions.foreground) {
      // An answer, not a failure: the person said no. Nothing was started.
      useTourSession.getState().sessionFailed('Location permission is required to run a tour.');
      return;
    }

    this.location = service;
    const meta: SessionMeta = {
      tourId: spec.key,
      source: spec.source,
      pinnedTracking,
      tourTitle: spec.title,
      activeIds: spec.active.map((w) => w.id),
      backgroundPermission: permissions.background,
      notificationPermission: permissions.notifications,
      startedAt: Date.now(),
      waypointsById: new Map(spec.active.map((w) => [w.id, w])),
      chapters: spec.chapters,
    };
    // Every event from here to doEnd carries the plan (audio events included).
    telemetry.setPlan(spec.source.kind === 'plan' ? spec.source.planId : null);
    // tour_id is a tours.id foreign key: a plan session's key must never go there.
    void telemetry.record('tour_started', spec.source.kind === 'tour' ? { tourId: spec.key } : { meta: { source_tour_ids: spec.sourceTourIds } });

    try {
      await this.audio.configureSession(interruptionModeFor(Platform.OS, firstChapter.transitMode));
    } catch (err) {
      return this.failStart('audio', err);
    }

    // The engine exists before tracking starts, so no fix can arrive unheard.
    const runner = this.openEngine(meta, createEngineState(spec.tour, freshProgress(spec.tour, firstChapter.id)));

    try {
      await service.start();
    } catch (err) {
      // Android can refuse here: its location foreground service only starts
      // while the app is in the foreground (LocationService header).
      return this.failStart('location', err);
    }

    this.attachAppState();

    useTourSession.getState().sessionStarted({
      waypoints: spec.active,
      transitMode: firstChapter.transitMode,
      backgroundPermission: permissions.background,
      notificationPermission: permissions.notifications,
    });
    if (spec.staticRouteTourId !== null) this.publishStaticRoute(spec.staticRouteTourId, spec.active, firstChapter.transitMode);
    else useTourSession.getState().setRoute({ source: 'straight', points: null });

    runner.start();
    // The checkpoint describes a session that has fully started.
    this.persistNow();
  }

  // ---------------------------------------------------------------------------
  // The engine
  // ---------------------------------------------------------------------------

  /**
   * Build the runner and the audio actor around an engine state, and route
   * fixes into it. Does not start the heartbeat - start()/doResume do, once
   * tracking is up.
   */
  private openEngine(meta: SessionMeta, initial: EngineState): EngineRunner {
    const ports: EngineRunnerPorts = {
      persist: (progress) => tourProgress.save(this.snapshot(meta, progress)),
      audio: (fx) => this.runAudioEffect(fx),
      applyTransitMode: (mode) => {
        void this.serialTracking(() => this.applyTransitMode(mode));
      },
      telemetry: (fx) => this.recordEngineTelemetry(meta, fx),
      tracking: (fx) => {
        void this.serialTracking(() => (fx.type === 'SUSPEND_TRACKING' ? this.suspendTracking(meta) : this.restartTrackingAfterIdle()));
      },
      chapterArrived: (fx) => {
        void this.announceArrival(meta, fx.chapterId, fx.nextChapterId);
      },
      publish: (next, prev) => this.publish(next, prev),
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
      reportError: (context, error, detail) => console.error(`[Engine] ${context} failed (${detail}):`, error),
    };
    const runner = new EngineRunner(initial, ports);

    const actor = new AudioActor({
      player: this.audio,
      source: { resolve: (stopId, track) => this.resolvePlayable(meta, stopId, track) },
      sink: (event) => runner.dispatch(event),
      now: () => Date.now(),
      onSnapshot: ({ isPlaying, positionSeconds, durationSeconds }) =>
        useTourSession.getState().setPlayback({ isPlaying, positionSeconds, durationSeconds }),
      onError: (err) => useTourSession.getState().setPlaybackError(err.message),
      reportError: (err, detail) => console.error(`[AudioActor] ${detail} failed:`, err),
    });

    // audio_started is the denominator of the completion KPI: telemetry is
    // attached before the first stop can fire, and detached in doEnd().
    this.audio.setTelemetry(telemetry);

    this.location?.setCallbacks({
      onLocation: (fix, accuracy) => useTourSession.getState().setFix(fix, accuracy),
      onSamplingChange: (tier) => useTourSession.getState().setSamplingTier(tier),
      onGpsFix: (fix) => runner.fixes([fix]),
    });

    this.runner = runner;
    this.actor = actor;
    this.session = meta;
    useTourSession.getState().applyEngineView({ visitedWaypointIds: Object.keys(initial.progress.played) });
    useTourSession
      .getState()
      .setChapters(meta.chapters.map(toChapterView), initial.progress.chapterId, [...(initial.progress.arrivedChapterIds ?? [])]);
    return runner;
  }

  /**
   * Audio effects go to the actor; the card the player shows follows them. A
   * PLAY puts its stop on air; a zone exit or the listener's skip takes it
   * off. Displacement (the next PLAY replaces it) and failures (the error
   * shows on the card) leave it alone.
   */
  private runAudioEffect(fx: Extract<Effect, { type: 'PLAY' | 'STOP' | 'RESUME' }>): void {
    const actor = this.actor;
    if (actor === null) throw new Error(`audio effect ${fx.type} with no audio actor`);
    if (fx.type === 'PLAY') useTourSession.getState().setOnAir(fx.stopId, fx.track === 'deep_dive');
    if (fx.type === 'STOP' && (fx.reason === 'zone_exit' || fx.reason === 'user_skip')) {
      useTourSession.getState().setOnAir(null, false);
    }
    actor.execute(fx);
  }

  /** The engine's state, projected for the screens. Once per drain. */
  private publish(next: EngineState, prev: EngineState): void {
    if (next.progress.played !== prev.progress.played) {
      useTourSession.getState().applyEngineView({ visitedWaypointIds: Object.keys(next.progress.played) });
    }
    if (next.progress.fired !== prev.progress.fired && allStopsResolved(next) && !allStopsResolved(prev)) {
      useTourSession.getState().promptCompletion();
    }
    if (next.progress.chapterId !== prev.progress.chapterId) {
      useTourSession.getState().setActiveChapter(next.progress.chapterId);
      // The arrival that prompted it is acted on: its notification is stale.
      void dismissTourNotification('chapter_arrived').catch((err) => console.warn('[TourSession] arrival notification not dismissed:', err));
    }
    if (next.progress.arrivedChapterIds !== prev.progress.arrivedChapterIds) {
      useTourSession.getState().setArrivedChapters([...(next.progress.arrivedChapterIds ?? [])]);
    }
  }

  /**
   * Engine telemetry, with the engine's detail in meta. trigger_fired travels
   * as geofence_entered (the vocabulary always had it); every other kind is
   * its own type since migration 20261003120000 - applied to production
   * BEFORE this build could send them (a refused type poisons its batch).
   */
  private recordEngineTelemetry(meta: SessionMeta, fx: Extract<Effect, { type: 'TELEMETRY' }>): void {
    const type = fx.kind === 'trigger_fired' ? 'geofence_entered' : fx.kind;
    // tour_id is the tour that OWNS the stop (Epic 16: a plan spans tours).
    // Without a stop: the catalogue tour, or none - a plan key is not a tours.id.
    const tourId = engineEventTourId(meta.source, meta.tourId, fx.stopId ? meta.waypointsById.get(fx.stopId)?.tourId : undefined);
    void telemetry.record(type, { tourId, waypointId: fx.stopId ?? undefined, meta: { ...fx.detail } });
  }

  /**
   * Tracking changes run one at a time, in effect order. "Start next chapter"
   * while idle-suspended emits RESUME_TRACKING then APPLY_TRANSIT_MODE: run
   * concurrently, LocationService.start() and retune() would each open a
   * watcher (start() is outside retune's chain) and one would leak - double
   * fixes, the battery drain the pause exists to stop. Every op catches its
   * own failures, so the chain never wedges; the catch below is belt and braces
   * for a bug, logged loudly.
   */
  private trackingOps: Promise<void> = Promise.resolve();
  private serialTracking(op: () => Promise<void>): Promise<void> {
    const run = this.trackingOps.then(op);
    this.trackingOps = run.catch((err) => console.error('[TourSession] tracking operation threw (a bug: each op reports its own failures):', err));
    return run;
  }

  /** A chapter's mode: tracking sampling and the audio session. Reported, never thrown. */
  private async applyTransitMode(mode: TransitMode): Promise<void> {
    try {
      // Skipped when unchanged - always on iOS (AudioService.ensureSessionMode).
      await this.audio.ensureSessionMode(interruptionModeFor(Platform.OS, mode));
    } catch (err) {
      console.error(`[TourSession] audio session not switched to ${mode}:`, err);
    }
    // A plan's tracking is pinned (finestMode): no restart, so no race with
    // the handoff and nothing the OS can refuse from the background.
    if (this.session?.pinnedTracking) return;
    try {
      await this.location?.retune(mode);
    } catch (err) {
      if (err instanceof TrackingLostError) {
        // Epic 16: the restart stopped the task and the OS refused the start -
        // the app left the foreground in between (an optimistic handoff). OFF,
        // not merely mistuned: arrival cannot be detected until recovery.
        console.error(`[TourSession] tracking is OFF for this ${mode} segment - it restarts when the visitor returns to the app:`, err);
        void telemetry.record('handoff_tracking_late', { meta: { outcome: 'lost', mode } });
        return;
      }
      console.error(`[TourSession] tracking not retuned for ${mode} - sampling stays on the previous chapter's:`, err);
    }
  }

  private async resolvePlayable(
    meta: SessionMeta,
    stopId: string,
    track: TrackKind,
  ): Promise<{ track: AudioTrack; uri: string; waypoint: Waypoint } | null> {
    const waypoint = meta.waypointsById.get(stopId);
    if (!waypoint) return null;
    const audioTrack = track === 'deep_dive' ? waypoint.deepDive ?? null : waypoint.audio;
    if (!audioTrack) return null;
    const uri = await this.playableUri(audioTrack);
    return uri === null ? null : { track: audioTrack, uri, waypoint };
  }

  // ---------------------------------------------------------------------------
  // Idle timeout (Epic 15 - battery)
  // ---------------------------------------------------------------------------

  /**
   * The engine saw 15 minutes without movement: stop tracking - the battery
   * cost this exists to end - and tell the listener. Stopping is allowed from
   * the background on both platforms (only STARTING is restricted). Failures
   * are reported: a tracker that could not stop is the battery drain itself.
   */
  private async suspendTracking(meta: SessionMeta): Promise<void> {
    useTourSession.getState().setPaused(true);
    const service = this.location;
    try {
      if (service) {
        await service.stop();
        await service.stopBackground();
      }
    } catch (err) {
      console.error('[TourSession] tracking could NOT be stopped for the idle pause - the battery is still being drained:', err);
    }
    try {
      await notifyTourSuspended(meta.tourId, meta.tourTitle);
    } catch (err) {
      console.error('[TourSession] the inactivity notification was not shown:', err);
    }
  }

  /**
   * Start tracking again after an idle pause. Always from an in-app tap - the
   * Resume button, or a stop's play button - so the app is in the foreground,
   * which Android requires to start its task.
   */
  private async restartTrackingAfterIdle(): Promise<void> {
    try {
      await dismissTourNotification('tour_suspended');
    } catch (err) {
      console.warn('[TourSession] the inactivity notification could not be dismissed:', err);
    }
    const service = this.location;
    if (!service) return;
    try {
      await service.start();
      useTourSession.getState().setPaused(false);
    } catch (err) {
      // Stays 'paused' in the store, so Resume is still offered (resumeTour).
      console.error('[TourSession] tracking could not restart after the pause; tap Resume again:', err);
    }
  }

  /**
   * The paused banner's Resume button.
   *
   * Normally the engine is still suspended and RESUME_REQUESTED does the rest.
   * But if an earlier restart failed, the engine already counts the tour as
   * resumed while tracking is off - a second RESUME_REQUESTED would be a no-op
   * and the listener would be stuck. So then: retry the tracking directly.
   */
  resumeTour(): void {
    const runner = this.runner;
    if (!runner) return;
    if (runner.state.progress.suspendedAt !== undefined) {
      runner.dispatch({ type: 'RESUME_REQUESTED', at: Date.now() });
    } else if (useTourSession.getState().status === 'paused') {
      void this.serialTracking(() => this.restartTrackingAfterIdle());
    }
  }

  // ---------------------------------------------------------------------------
  // Chapters and the navigation handoff (Epic 15, Slice 5)
  // ---------------------------------------------------------------------------

  /**
   * The engine saw the active chapter's destination reached. Notify - the one
   * way to come forward over Google Maps - and let the store highlight the
   * "start next chapter" button (publish does that from the progress).
   */
  private async announceArrival(meta: SessionMeta, chapterId: string, nextChapterId: string | null): Promise<void> {
    const chapter = meta.chapters.find((c) => c.chapter_id === chapterId);
    const next = nextChapterId === null ? null : meta.chapters.find((c) => c.chapter_id === nextChapterId);
    try {
      await notifyChapterArrived({
        tourId: meta.tourId,
        chapterId,
        nextChapterId,
        destinationLabel: chapter?.handoff?.destination_label ?? null,
        nextChapterTitle: next?.title ?? null,
      });
    } catch (err) {
      console.error('[TourSession] the arrival notification was not shown (the in-app button still is):', err);
    }
  }

  /**
   * "Navigate with Google Maps / Waze" for the active chapter.
   *
   * The notification permission is asked HERE, lazily (PM): the moment the
   * listener is about to leave the app is when an arrival notice will matter.
   * Returns the plan: 'open' was opened; 'needs_app' is for the screen to ask
   * (install Google Maps, or go without the scenic route - never silently).
   */
  async navigateWith(provider: HandoffProvider): Promise<HandoffPlan | null> {
    const meta = this.session;
    const runner = this.runner;
    if (!meta || !runner) return null;
    const chapter = meta.chapters.find((c) => c.chapter_id === runner.state.progress.chapterId);
    if (!chapter?.handoff) throw new Error(`chapter ${runner.state.progress.chapterId} has no navigation handoff`);

    try {
      await requestTourNotificationPermission();
    } catch (err) {
      console.warn('[TourSession] notification permission could not be requested; arrival will only show in the app:', err);
    }

    const spec: HandoffSpec = {
      destination: { latitude: chapter.handoff.destination[1], longitude: chapter.handoff.destination[0] },
      destinationLabel: chapter.handoff.destination_label,
      anchors: chapter.handoff.anchors.map(([longitude, latitude]) => ({ latitude, longitude })),
      providers: chapter.handoff.providers.filter((p): p is HandoffProvider => p === 'google_maps' || p === 'waze'),
    };
    const plan = planHandoff(
      provider,
      spec,
      chapter.transit_mode as TransitMode,
      { googleMaps: await isGoogleMapsInstalled() },
      Platform.OS === 'ios' ? 'ios' : 'android',
    );
    if (plan.kind === 'open') await this.handOff(plan.url);
    return plan;
  }

  /**
   * Open the navigation app AFTER the tracking restart a chapter change
   * queued - but never more than HANDOFF_TRACKING_TIMEOUT_MS after the tap
   * (PM, Epic 16: optimistic handoff). On Android the restart may only START
   * the location service in the foreground, so waiting is what keeps the
   * travel segment tracked; the bound is what keeps the button answering.
   * The panel shows its spinner meanwhile - nothing blocks a thread.
   *
   * After a timeout the restart goes on: finishing late is reported here
   * ('late'); failing because Maps had backgrounded the app is reported by
   * applyTransitMode ('lost') and repaired on the next return to the app
   * (handleAppStateChange -> recoverTracking, 'recovered').
   */
  private async handOff(url: string): Promise<void> {
    const service = this.location;
    const result = await optimisticHandoff({
      trackingWork: this.trackingOps,
      trackingLost: () => service?.trackingLost ?? false,
      open: () => openNavigationUrl(url),
      onLate: (outcome, waitedMs) => {
        if (outcome === 'lost') return; // applyTransitMode reported it, where it happened
        console.warn(`[TourSession] the tracking restart finished ${waitedMs} ms after an optimistic handoff`);
        void telemetry.record('handoff_tracking_late', { meta: { outcome: 'late', waited_ms: waitedMs } });
      },
      timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      now: Date.now,
    });
    if (result.kind === 'timed_out') console.warn('[TourSession] optimistic handoff: the tracking restart had not finished; navigation opened anyway');
  }

  /** Open a URL the screen chose after a 'needs_app' plan (store page, or no scenic route). */
  async openHandoffUrl(url: string): Promise<void> {
    await openNavigationUrl(url);
  }

  /**
   * "I'm here - start the next chapter" (PM): always offered, so a car park
   * far from the pin never strands the listener. The same CHAPTER_SELECTED the
   * arrival notification leads to. An in-app tap, so the app is foregrounded -
   * which Android needs to restart tracking for the new mode.
   */
  startNextChapter(): void {
    const runner = this.runner;
    if (!runner) return;
    const next = nextChapterOf(runner.state.tour, runner.state.progress.chapterId);
    if (next === null) throw new Error('startNextChapter: this is the last chapter');
    runner.dispatch({ type: 'CHAPTER_SELECTED', chapterId: next.id, at: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // Persistence and resume
  // ---------------------------------------------------------------------------

  private snapshot(meta: SessionMeta, progress: Progress): TourProgressSnapshot {
    return {
      v: 3,
      tourId: meta.tourId,
      source: meta.source,
      tourTitle: meta.tourTitle,
      activeIds: meta.activeIds,
      // TASK-604's preference skips, retired in Epic 16. Still written so a v2
      // checkpoint keeps one shape (a version bump would discard walks in
      // progress on update); never read.
      skippedIds: [],
      backgroundPermission: meta.backgroundPermission,
      notificationPermission: meta.notificationPermission,
      startedAt: meta.startedAt,
      savedAt: Date.now(),
      progress,
    };
  }

  /**
   * Write the checkpoint now, outside a drain (start, resume). Never throws:
   * a disk that refuses must not stop a tour - reported instead, because the
   * consequence (no resume after a kill) is real.
   */
  private persistNow(): void {
    const runner = this.runner;
    const meta = this.session;
    if (!runner || !meta) return;
    try {
      tourProgress.save(this.snapshot(meta, runner.state.progress));
    } catch (err) {
      console.error('[TourSession] checkpoint NOT written - this tour cannot resume after a process kill:', err);
    }
  }

  private clearCheckpoint(): void {
    try {
      tourProgress.clear();
    } catch (err) {
      // Reported, not thrown: teardown must finish. The age limit stops a
      // stale checkpoint resuming forever.
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

    const decision = decideSnapshotResume(tourProgress.load(), Date.now());
    if (decision.kind === 'nothing') return false;
    const discard = (reason: string): false => {
      console.warn(`[TourSession] saved tour not resumed (${origin}): ${reason}`);
      this.clearCheckpoint();
      return false;
    };
    if (decision.kind === 'discard') return discard(decision.reason);
    const snap = decision.snapshot;

    const rebuilt = snap.source.kind === 'plan' ? this.rebuildPlan(snap, snap.source) : this.rebuildTour(snap);
    if (rebuilt.kind === 'discard') return discard(rebuilt.reason);
    const { tour, active, chapters, staticRouteTourId, sourceTourIds } = rebuilt;

    const problem = progressProblem(tour, snap.progress);
    if (problem !== null) return discard(`saved progress does not fit the tour (${problem})`);
    const chapter = tour.chapters.find((c) => c.id === snap.progress.chapterId);
    if (!chapter) return discard(`unknown chapter ${snap.progress.chapterId}`);

    useTourSession.getState().beginStart(snap.tourId, snap.tourTitle, sourceTourIds);
    const pinnedTracking = snap.source.kind === 'plan' ? finestMode(tour.chapters.map((c) => c.transitMode)) : null;
    const service = new LocationService(pinnedTracking ?? chapter.transitMode, Platform.OS);
    this.location = service;
    const meta: SessionMeta = {
      tourId: snap.tourId,
      source: snap.source,
      pinnedTracking,
      tourTitle: snap.tourTitle,
      activeIds: snap.activeIds,
      backgroundPermission: snap.backgroundPermission,
      notificationPermission: snap.notificationPermission,
      startedAt: snap.startedAt,
      waypointsById: new Map(active.map((w) => [w.id, w])),
      chapters,
    };
    telemetry.setPlan(snap.source.kind === 'plan' ? snap.source.planId : null);

    const fail = async (stage: 'audio' | 'location', err: unknown): Promise<false> => {
      console.error(`[TourSession] resume (${origin}) failed at ${stage}:`, err);
      await this.doEnd({ keepCheckpoint: origin === 'background_task' });
      return false;
    };
    try {
      await this.audio.configureSession(interruptionModeFor(Platform.OS, chapter.transitMode));
    } catch (err) {
      return fail('audio', err);
    }
    const runner = this.openEngine(meta, createEngineState(tour, snap.progress));
    // A tour suspended for inactivity comes back suspended: tracking stays
    // off until the listener taps Resume. A task still registered (the OS
    // restarted it) is stopped - that is the battery the pause was saving.
    const suspended = snap.progress.suspendedAt !== undefined;
    if (suspended) {
      try {
        await service.stopBackground();
      } catch (err) {
        console.error('[TourSession] a suspended tour still had a tracking task that could not be stopped:', err);
      }
    } else {
      try {
        await service.resumeTracking();
      } catch (err) {
        return fail('location', err);
      }
    }
    // Both platforms since Epic 16: Android listens only to recover tracking a
    // failed restart lost (handleAppStateChange); iOS also swaps transports.
    this.attachAppState();

    useTourSession.getState().sessionStarted({
      waypoints: active,
      transitMode: chapter.transitMode,
      backgroundPermission: snap.backgroundPermission,
      notificationPermission: snap.notificationPermission,
    });
    if (staticRouteTourId !== null) this.publishStaticRoute(staticRouteTourId, active, chapter.transitMode);
    if (suspended) useTourSession.getState().setPaused(true);

    // SESSION_STARTED replays a restored queue - what fired but had not been heard.
    runner.start();
    this.persistNow();
    console.warn(
      `[TourSession] resumed ${snap.tourId} (${origin}): ${Object.keys(snap.progress.played).length}/${snap.activeIds.length} stops heard, ${snap.progress.queue.length} waiting`,
    );
    return true;
  }

  /** A catalogue checkpoint against its downloaded tour (the pre-Epic-16 resume, unchanged). */
  private rebuildTour(snap: TourProgressSnapshot): Rebuilt {
    const waypoints = TourBundleRepository.loadWaypoints(snap.tourId);
    const manifest = TourBundleRepository.readManifest(snap.tourId);
    if (!waypoints || !manifest) return { kind: 'discard', reason: 'the tour is no longer downloaded' };
    const byId = new Map(waypoints.map((w) => [w.id, w]));
    const active = snap.activeIds.map((id) => byId.get(id));
    if (!active.every((w): w is Waypoint => w !== undefined)) {
      return { kind: 'discard', reason: 'the downloaded tour no longer has every stop (updated since?)' };
    }
    // Epic 16: a catalogue session never runs an extension. A saved session
    // naming one means the bundle was updated mid-walk and a stop became
    // optional; replaying it would narrate a detour Discovery must not play.
    const nowExtension = active.find((w) => w.stopRole !== 'core');
    if (nowExtension) return { kind: 'discard', reason: `stop ${nowExtension.id} is now an extension (updated since?)` };
    try {
      const tour = engineTourFromManifest(manifest, snap.activeIds);
      return { kind: 'ok', tour, active, chapters: chaptersOf(manifest), staticRouteTourId: snap.tourId, sourceTourIds: [snap.tourId] };
    } catch (err) {
      return { kind: 'discard', reason: `the downloaded tour cannot run (${err instanceof Error ? err.message : String(err)})` };
    }
  }

  /**
   * A plan checkpoint: the plan is re-read from the plan store (never from the
   * checkpoint) and must be the SAME plan - still saved, same content_hash,
   * same stops - against bundles that still fit it. Anything else is
   * discarded with its reason: resuming a different plan than the one
   * walked would replay progress against the wrong stops.
   */
  private rebuildPlan(snap: TourProgressSnapshot, source: Extract<SessionSource, { kind: 'plan' }>): Rebuilt {
    const entry = savedPlans.get(source.planId);
    if (entry === null) return { kind: 'discard', reason: `plan ${source.planId} was deleted` };
    if (entry.status !== 'saved') return { kind: 'discard', reason: `plan ${source.planId} is not saved` };
    if (entry.plan.content_hash !== source.contentHash) return { kind: 'discard', reason: `plan ${source.planId} changed since the walk started` };
    let pieces: ReturnType<TourSessionController['planPieces']>;
    try {
      pieces = this.planPieces(entry.plan);
    } catch (err) {
      return { kind: 'discard', reason: `plan ${source.planId} cannot run (${err instanceof Error ? err.message : String(err)})` };
    }
    if (pieces.kind === 'not_runnable') return { kind: 'discard', reason: `plan ${source.planId} no longer fits the tours on this device (${pieces.reason})` };
    const ids = pieces.active.map((w) => w.id);
    if (ids.length !== snap.activeIds.length || ids.some((id, i) => id !== snap.activeIds[i])) {
      return { kind: 'discard', reason: `plan ${source.planId} runs different stops than the saved walk` };
    }
    return { kind: 'ok', tour: pieces.tour, active: pieces.active, chapters: pieces.chapters, staticRouteTourId: null, sourceTourIds: entry.plan.sources.map((s) => s.tour_id) };
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

  // ---------------------------------------------------------------------------
  // Map and audio sources
  // ---------------------------------------------------------------------------

  /**
   * The bundled route, validated against the stops this session runs. Epic 15
   * (decision 5): nothing on the device routes or reorders any more - the
   * navigation app routes, and stops run in their authored chapter order.
   */
  private publishStaticRoute(tourId: string, stops: Waypoint[], transitMode: TransitMode): void {
    const route = this.loadStaticRoute(tourId, stops, transitMode);
    useTourSession.getState().setRoute(route ? { source: 'static', points: route } : { source: 'straight', points: null });
  }

  /**
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

  /**
   * What to hand the player (TASK-605, Hybrid Offline-First).
   *
   * The bundled file, whenever it is on disk - the normal case, and fast. If
   * it is NOT and the device is online, a signed stream of the same object.
   * NOTE (Epic 15): signing plus loading must fit inside the engine's 5 s
   * PLAY timeout, or the stop is abandoned as failed - the case to watch on a
   * slow network.
   *
   * Offline with no file, the local path is returned unchanged so AudioService
   * fails loudly exactly as it did before, rather than silently.
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
  // The listener's controls - all become engine events
  // ---------------------------------------------------------------------------

  /**
   * Play a stop's narration now: the debug trigger, and "replay". Must be a
   * stop of the active chapter (anything else is reported by the engine as a
   * caller bug). Firing it moves the window past any stop before it.
   */
  async triggerWaypoint(waypointId: string): Promise<void> {
    this.runner?.dispatch({ type: 'MANUAL_TRIGGER', stopId: waypointId, at: Date.now() });
  }

  /** Leave a Deep Dive and replay the stop's own narration. */
  async playNarration(waypointId: string): Promise<void> {
    await this.triggerWaypoint(waypointId);
  }

  /** Play a stop's Deep Dive in place of whatever is on air (TASK-602). */
  async playDeepDive(waypointId: string): Promise<void> {
    this.runner?.dispatch({ type: 'DEEP_DIVE_REQUESTED', stopId: waypointId, at: Date.now() });
  }

  /** The listener dismissed the stop's card: stop it; the next waiting stop follows. */
  async releaseWaypoint(waypointId: string): Promise<void> {
    if (useTourSession.getState().activeWaypointId !== waypointId) return;
    const runner = this.runner;
    if (runner && runner.state.audio.kind !== 'idle') {
      runner.dispatch({ type: 'USER_SKIP', at: Date.now() });
    } else {
      // Nothing on air (a finished narration's card): just take the card down.
      useTourSession.getState().setOnAir(null, false);
    }
  }

  /** Manual chapter advance (PM: manual only for MVP). For the chapter UI. */
  selectChapter(chapterId: string): void {
    this.runner?.dispatch({ type: 'CHAPTER_SELECTED', chapterId, at: Date.now() });
  }

  /** Transport control for the on-screen player. Reported to the engine as by:user. */
  togglePlayPause(): void {
    const actor = this.actor;
    if (actor === null) return;
    const s = useTourSession.getState();
    if (this.audio.isPlaying) {
      actor.pauseByUser();
      s.setPlayback({ isPlaying: false, positionSeconds: s.positionSeconds, durationSeconds: s.durationSeconds });
    } else {
      actor.resumeByUser();
      s.setPlayback({ isPlaying: true, positionSeconds: s.positionSeconds, durationSeconds: s.durationSeconds });
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

  // ---------------------------------------------------------------------------
  // App state - iOS hands tracking between the foreground watcher and the task
  // ---------------------------------------------------------------------------

  private attachAppState(): void {
    this.appStateSub?.remove();
    this.appStateSub = AppState.addEventListener('change', (next) => {
      void this.handleAppStateChange(next);
    });
  }

  /**
   * Swap the foreground watcher for the background task and back (iOS).
   * Running both would double GPS wake-ups and deliver every fix twice - the
   * engine's monotonic-time guard would drop the duplicates, but the wake-ups
   * would still cost battery.
   *
   * ANDROID: no handoff at all. The task opened by start() already runs
   * across foreground and background, and starting one from here would throw
   * (Epic 13).
   */
  private async handleAppStateChange(next: AppStateStatus): Promise<void> {
    const service = this.location;
    if (!service) return;
    // Epic 16: a restart the OS refused while the app was in the background
    // (an optimistic handoff) left tracking OFF. Back in the foreground - the
    // only place Android allows a start - start it again. Not while paused:
    // the idle pause turned tracking off on purpose.
    if (next === 'active' && service.trackingLost && useTourSession.getState().status === 'active') {
      void this.serialTracking(() => this.recoverTracking());
    }
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

  /** Restart tracking a refused restart lost. Reported either way; retried on the next return. */
  private async recoverTracking(): Promise<void> {
    const service = this.location;
    if (!service?.trackingLost) return;
    try {
      await service.recover();
      console.warn('[TourSession] tracking restarted on return to the app, after a restart the OS had refused');
      void telemetry.record('handoff_tracking_late', { meta: { outcome: 'recovered' } });
    } catch (err) {
      console.error('[TourSession] tracking could still not restart; it will be tried on the next return to the app:', err);
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

    // The engine stops before anything native: no heartbeat, no further
    // effects, and late callbacks from the player or the GPS are ignored.
    this.runner?.stop();
    this.runner = null;
    const actor = this.actor;
    this.actor = null;
    this.session = null;

    const service = this.location;
    this.location = null;
    if (service) {
      // Both, unconditionally: whichever was not running is a cheap no-op, and
      // guessing wrong is how a watcher survives the session that owned it.
      await service.stop();
      await service.stopBackground();
    }

    // createAudioPlayer holds native resources until remove(); stop() does that.
    // 'audio_stopped' so a tour ended mid-narration is recorded as a drop-off.
    if (actor) await actor.dispose();
    else await this.audio.stop('audio_stopped');
    this.audio.setTelemetry(null);
    // After the audio stop: a plan's last audio_stopped still carries its plan_id.
    telemetry.setPlan(null);

    try {
      await dismissTourNotification('tour_suspended');
      await dismissTourNotification('chapter_arrived');
    } catch (err) {
      console.warn('[TourSession] tour notifications could not be dismissed:', err);
    }

    useTourSession.getState().reset();
  }

  /** True while hardware is held. Used by tests and debug UI. */
  get isRunning(): boolean {
    return this.location !== null;
  }
}

/** A manifest chapter as the chapter panel shows it. */
function toChapterView(c: WireChapter): ChapterView {
  return {
    id: c.chapter_id,
    title: c.title,
    transitMode: c.transit_mode as TransitMode,
    handoff:
      c.handoff === null
        ? null
        : {
            destinationLabel: c.handoff.destination_label,
            anchorCount: c.handoff.anchors.length,
            providers: c.handoff.providers.filter((p): p is 'google_maps' | 'waze' => p === 'google_maps' || p === 'waze'),
          },
  };
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
