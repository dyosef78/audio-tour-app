import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { profileFor, type GpsSampling, type TransitProfile } from '../../config/transitProfiles';
import type { LatLng, TransitMode, Waypoint } from '../../types/domain';
import { distanceMeters, distanceToZone, isInsideZone } from './geometry';
import { StopSequence } from './stopSequence';

/**
 * LocationService - Adaptive GPS + local geofencing (TASK-101 / TASK-102).
 *
 * The pure decision logic is unit-testable and is exercised end to end by
 * `npm run sim:walk`, which drives this class directly. The OS-facing parts -
 * watcher restarts, the background task - are implemented but have NOT yet run
 * on a device; the sampling intervals in transitProfiles.ts are due to be tuned
 * during field QA.
 *
 * Two responsibilities, deliberately kept separate:
 *
 *   1. ADAPTIVE GPS - trade battery against precision. Sampling stays coarse
 *      while the user is far from every waypoint, and escalates to fine as they
 *      approach one (PRD v2.0.0 Screen 3).
 *
 *   2. LOCAL GEOFENCING - decide, per fix, which zones were entered or exited,
 *      applying debounce/cooldown and exit hysteresis (PRD v2.0.0 Screen 4).
 *      Entry is SEQUENCED (TASK-902): only the next stop in the visiting order
 *      is armed - see StopSequence and evaluateGeofences().
 *
 * Why not expo-location's built-in `startGeofencingAsync`? It caps at 20 regions
 * on iOS, gives no polygon support, and hands back enter/exit events we cannot
 * tune for cooldown or hysteresis. Our zones include polygons and per-mode
 * radii, so containment is computed here instead. See the handover report.
 */

/** Task name registered with TaskManager for background fixes. */
export const LOCATION_TASK_NAME = 'audio-tour-background-location';

export type GeofenceEventType = 'enter' | 'exit';

export interface GeofenceEvent {
  type: GeofenceEventType;
  waypoint: Waypoint;
  /** The fix that produced this event. */
  at: LatLng;
  timestamp: number;
}

export interface LocationServiceCallbacks {
  /** Fired for every accepted fix - drives the map's blue dot. */
  onLocation?: (fix: LatLng, accuracyMeters: number | null) => void;
  /** Fired when a zone is entered or exited, after debounce/hysteresis. */
  onGeofence?: (event: GeofenceEvent) => void;
  /** Fired when Adaptive GPS changes sampling tier. */
  onSamplingChange?: (tier: 'coarse' | 'fine', sampling: GpsSampling) => void;
}

/**
 * Minimum time between two APPLIED tier changes (TASK-505).
 *
 * Restarting a native watcher is not free - it drops the current fix stream and
 * re-acquires - so a change requested inside this window is deferred rather than
 * applied. Paired with the distance hysteresis below, not a substitute for it:
 * this bounds how OFTEN the hardware can be reconfigured, while the hysteresis
 * bounds how often a change is asked for at all.
 */
const TIER_DWELL_MS = 20_000;

/**
 * De-escalation needs this much more distance than escalation did.
 *
 * The same asymmetry the geofences themselves use. Escalate at
 * escalateWithinMeters, but do not fall back until 25% beyond it, so a user
 * pacing the escalation boundary - or a fix jittering across it - cannot flip
 * the GPS between tiers on alternate samples.
 */
const TIER_DEESCALATE_FACTOR = 1.25;

/** Per-waypoint bookkeeping for debounce and hysteresis. */
interface ZoneState {
  inside: boolean;
  /** When audio for this zone last fired, for the cooldown check. */
  lastTriggeredAt: number | null;
}

export class LocationService {
  private waypoints: Waypoint[] = [];
  private profile: TransitProfile;
  private callbacks: LocationServiceCallbacks = {};

  private zoneStates = new Map<string, ZoneState>();
  private sequence = new StopSequence([]);
  private currentTier: 'coarse' | 'fine' = 'coarse';
  private watcher: Location.LocationSubscription | null = null;

  /**
   * Which transport is live, so a tier change reconfigures the RIGHT one.
   *
   * Without this the service cannot tell a foreground watcher from a background
   * task, and an escalation would either restart nothing or restart the thing
   * that is not running - silently leaving the user on coarse.
   */
  private trackingMode: 'idle' | 'foreground' | 'background' = 'idle';

  /** Last fix seen, so a deferred tier change re-decides rather than replays. */
  private lastFix: LatLng | null = null;
  /** Timestamp of the last APPLIED tier change, for the dwell check. */
  private lastTierChangeAt = 0;
  private tierTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialises watcher restarts so overlapping changes cannot interleave. */
  private applying: Promise<void> = Promise.resolve();

  constructor(mode: TransitMode = 'walking') {
    this.profile = profileFor(mode);
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  /** Load a downloaded bundle's waypoints and reset all zone state. */
  loadTour(waypoints: Waypoint[], mode: TransitMode): void {
    this.waypoints = [...waypoints].sort((a, b) => a.sortOrder - b.sortOrder);
    this.profile = profileFor(mode);
    this.zoneStates = new Map(
      this.waypoints.map((w) => [w.id, { inside: false, lastTriggeredAt: null }]),
    );
    // Authored order until the routing provider says otherwise (setStopOrder).
    this.sequence = new StopSequence(this.waypoints.map((w) => w.id));
    this.currentTier = 'coarse';

    // Adaptive GPS state belongs to the tour that is loaded, not to the service.
    this.clearTierTimer();
    this.lastFix = null;
    this.lastTierChangeAt = 0;
  }

  setCallbacks(callbacks: LocationServiceCallbacks): void {
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // Visiting order (TASK-902)
  // ---------------------------------------------------------------------------

  /**
   * Narrate in this order from now on - the `waypoint_ids` route-stops routed.
   *
   * Refused (false) unless it holds exactly the loaded stops. Stops already
   * passed stay passed; the armed zone becomes the first unpassed stop of the
   * new order. Zone state is untouched: a stop the user is inside keeps its
   * exit hysteresis, and a newly armed stop they already stand in fires on the
   * next fix, because an unarmed zone is never marked inside.
   */
  setStopOrder(waypointIds: readonly string[]): boolean {
    return this.sequence.reorder(waypointIds);
  }

  /**
   * Record a stop as reached without a zone entry - the manual trigger.
   * Skips every unpassed stop scheduled before it (StopSequence.reach), which
   * is the only way past a stop whose zone was never entered.
   */
  markReached(waypointId: string): void {
    this.sequence.reach(waypointId);
  }

  /** The stop whose zone is armed for entry, or null when the tour is done. */
  nextWaypointId(): string | null {
    return this.armedZoneId();
  }

  /** The current visiting order. */
  stopOrder(): readonly string[] {
    return this.sequence.ids();
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  /**
   * Foreground first, then background - the OS rejects a background request
   * that has not been preceded by a granted foreground one.
   *
   * Returns what was actually granted so the UI can degrade honestly: without
   * background permission the tour still works with the screen on, which is
   * worth saying rather than silently half-failing.
   */
  async requestPermissions(): Promise<{ foreground: boolean; background: boolean }> {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return { foreground: false, background: false };

    const bg = await Location.requestBackgroundPermissionsAsync();
    return { foreground: true, background: bg.status === 'granted' };
  }

  // ---------------------------------------------------------------------------
  // Foreground tracking
  // ---------------------------------------------------------------------------

  /** Start watching in the foreground at the current sampling tier. */
  async start(): Promise<void> {
    this.trackingMode = 'foreground';
    await this.openWatcher();
  }

  /**
   * (Re)open the foreground watcher at whatever tier is current.
   *
   * Separate from start() because an Adaptive GPS escalation has to reopen the
   * watcher WITHOUT changing trackingMode - going through start() would be
   * harmless today but would silently resurrect a foreground watcher if the tier
   * changed while the app was backgrounded.
   */
  private async openWatcher(): Promise<void> {
    this.watcher?.remove();
    this.watcher = null;
    this.watcher = await Location.watchPositionAsync(
      this.samplingOptions(this.currentTier),
      (loc) => {
        this.onFix(
          { latitude: loc.coords.latitude, longitude: loc.coords.longitude },
          loc.coords.accuracy,
          loc.timestamp,
        );
      },
    );
  }

  async stop(): Promise<void> {
    // Order matters. Cancel the deferred escalation, go idle so any restart
    // already queued becomes a no-op, drain the queue, and only then drop the
    // watcher - otherwise a restart in flight would hand back a fresh watcher
    // after the caller believes tracking has stopped.
    this.clearTierTimer();
    if (this.trackingMode === 'foreground') this.trackingMode = 'idle';
    await this.settled();
    this.watcher?.remove();
    this.watcher = null;
  }

  /**
   * Start background updates. Requires a development build - background
   * location does NOT work in Expo Go (Expo SDK 57 docs). The task itself is
   * registered in backgroundLocationTask.ts, which must be imported at module
   * scope before this runs.
   */
  async startBackground(): Promise<void> {
    this.trackingMode = 'background';
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (already) return;
    await this.openBackgroundUpdates();
  }

  /** (Re)start the background task at whatever tier is current. See openWatcher. */
  private async openBackgroundUpdates(): Promise<void> {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      ...this.samplingOptions(this.currentTier),
      // Android requires a visible notification for a foreground service.
      foregroundService: {
        notificationTitle: 'Audio Tour in progress',
        notificationBody: 'Narration will play automatically as you reach each stop.',
      },
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
    });
  }

  async stopBackground(): Promise<void> {
    // Same ordering as stop(), and for the same reason - except here a late
    // restart would leave a background task running with no session behind it,
    // which is the exact battery drain stopOrphanedLocationUpdates() exists to
    // clean up on the next cold start.
    this.clearTierTimer();
    if (this.trackingMode === 'background') this.trackingMode = 'idle';
    await this.settled();
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }

  // ---------------------------------------------------------------------------
  // Core: one GPS fix in, geofence events out
  // ---------------------------------------------------------------------------

  /**
   * Entry point for every fix, foreground or background.
   *
   * Deliberately synchronous and side-effect-light: it mutates zone state and
   * invokes callbacks, but does no I/O. That keeps it unit-testable by feeding
   * it a scripted list of coordinates - which is how this should be verified
   * before anyone walks around Jerusalem with a phone.
   */
  onFix(fix: LatLng, accuracyMeters: number | null, timestamp: number = Date.now()): void {
    this.callbacks.onLocation?.(fix, accuracyMeters);
    this.evaluateGeofences(fix, timestamp);
    this.applyAdaptiveGps(fix, timestamp);
  }

  /**
   * Exits first, then at most one entry: the armed stop's.
   *
   * EXITS are checked for every zone the user is inside, whatever the order -
   * a stop already narrated still has to fade out when they walk away. Only an
   * armed zone is ever marked inside, so "inside" means "entered in sequence".
   *
   * ENTRY is checked for the armed stop alone (StopSequence.next()). A
   * boundary crossing at any other stop is ignored and leaves no state behind,
   * so that stop still fires normally once its turn comes, even if the user is
   * already standing in it. Entering the armed stop passes it and arms the next
   * one, which is first evaluated on the FOLLOWING fix: one fix, one narration.
   *
   * Exits go before the entry so that on a fix that leaves one zone and enters
   * the next, the listener hears the handover in the order it happened.
   */
  private evaluateGeofences(fix: LatLng, timestamp: number): void {
    for (const waypoint of this.waypoints) {
      const zone = waypoint.geofence;
      const state = this.zoneStates.get(waypoint.id);
      if (!zone || !state?.inside) continue;

      // Asymmetric boundaries: enter on the true zone, exit only once clearly
      // outside a widened one. A fix jittering on the edge therefore cannot
      // produce an enter/exit storm.
      if (isInsideZone(fix, zone, this.profile.exitHysteresisFactor)) continue;

      state.inside = false;
      // Consumed by the audio layer as the cue to fade out (PRD Screen 4).
      this.callbacks.onGeofence?.({ type: 'exit', waypoint, at: fix, timestamp });
    }

    const armedId = this.armedZoneId();
    if (armedId === null) return;
    const waypoint = this.waypoints.find((w) => w.id === armedId);
    const zone = waypoint?.geofence;
    const state = this.zoneStates.get(armedId);
    if (!waypoint || !zone || !state || state.inside) return;
    if (!isInsideZone(fix, zone)) return;

    state.inside = true;

    // Debounce. Unreachable through the sequence alone - a stop is passed the
    // moment it fires and is never re-armed - but kept so that no future path
    // that re-arms a stop (a replay, a reorder rule) can bypass the cooldown.
    const last = state.lastTriggeredAt;
    if (last !== null && timestamp - last < this.profile.retriggerCooldownMs) return;

    state.lastTriggeredAt = timestamp;
    this.sequence.reach(armedId);
    this.callbacks.onGeofence?.({ type: 'enter', waypoint, at: fix, timestamp });
  }

  /**
   * The armed stop, after passing any stop with no geofence at the head of the
   * order. Such a stop can never be entered - before TASK-902 it simply never
   * fired - and leaving it armed would silence every stop after it.
   */
  private armedZoneId(): string | null {
    let id = this.sequence.next();
    while (id !== null && !this.waypoints.find((w) => w.id === id)?.geofence) {
      this.sequence.reach(id);
      id = this.sequence.next();
    }
    return id;
  }

  // ---------------------------------------------------------------------------
  // Adaptive GPS
  // ---------------------------------------------------------------------------

  /**
   * Escalate to fine sampling near a waypoint, fall back to coarse when clear
   * (TASK-505 - this was the TODO(TASK-102) stub).
   *
   * Three defences against thrashing the GPS subsystem, because reconfiguring it
   * is the expensive part and a walker pacing a boundary is the realistic case:
   *
   *   1. DISTANCE HYSTERESIS - desiredTier() widens the fall-back threshold by
   *      TIER_DEESCALATE_FACTOR, so the tier cannot flip on jitter alone.
   *   2. DWELL TIME - a change requested within TIER_DWELL_MS of the last
   *      applied one is deferred, not applied.
   *   3. SERIALISED RESTARTS - every restart is chained onto `applying`, so two
   *      changes in flight cannot interleave a stop with the wrong start.
   *
   * A deferred change re-decides from the latest fix when its timer fires rather
   * than replaying a stale decision, which matters because the user has usually
   * kept walking in the meantime.
   */
  private applyAdaptiveGps(fix: LatLng, timestamp: number): void {
    this.lastFix = fix;

    const tier = this.desiredTier(fix);

    if (tier === this.currentTier) {
      // The user came back before a pending change fired, so it is no longer
      // wanted. Dropping it here is what stops a boundary-pacer queueing an
      // endless chain of restarts.
      this.clearTierTimer();
      return;
    }

    const sinceLastChange = timestamp - this.lastTierChangeAt;
    if (sinceLastChange >= TIER_DWELL_MS) {
      this.commitTier(tier, timestamp);
      return;
    }

    this.scheduleTierChange(TIER_DWELL_MS - sinceLastChange);
  }

  /**
   * Adopt a tier and push it to whichever transport is actually running.
   *
   * onSamplingChange fires before the restart, not after: the debug overlay
   * should show the tier the service has decided on, and awaiting a native
   * restart before reporting it would make the UI lag the engine.
   */
  private commitTier(tier: 'coarse' | 'fine', timestamp: number): void {
    this.clearTierTimer();
    this.currentTier = tier;
    this.lastTierChangeAt = timestamp;
    this.callbacks.onSamplingChange?.(tier, this.profile[tier]);

    this.applying = this.applying
      .then(() => this.restartTracking())
      .catch((err: unknown) => {
        // A failed restart must not kill the tour. The previous watcher is gone,
        // so this is reported loudly - but the session survives, and the next
        // tier change gets another attempt.
        console.warn('[LocationService] could not re-apply sampling tier:', err);
      });
  }

  /** Re-open whichever transport is live so the new tier reaches the OS. */
  private async restartTracking(): Promise<void> {
    if (this.trackingMode === 'foreground') {
      await this.openWatcher();
      return;
    }

    if (this.trackingMode === 'background') {
      // startLocationUpdatesAsync does not reconfigure a running task, so the
      // stop is mandatory rather than defensive.
      const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      await this.openBackgroundUpdates();
    }

    // 'idle': nothing is tracking, and the tier will be picked up by whichever
    // start() runs next - both read currentTier.
  }

  private scheduleTierChange(delayMs: number): void {
    // An existing timer is already going to re-decide, so leave it alone rather
    // than pushing the deadline out on every fix - that would starve the change.
    if (this.tierTimer !== null) return;

    this.tierTimer = setTimeout(() => {
      this.tierTimer = null;
      const fix = this.lastFix;
      if (fix === null) return;

      // Re-decide from the newest fix. The user has been walking.
      const tier = this.desiredTier(fix);
      if (tier !== this.currentTier) this.commitTier(tier, Date.now());
    }, delayMs);
  }

  private clearTierTimer(): void {
    if (this.tierTimer === null) return;
    clearTimeout(this.tierTimer);
    this.tierTimer = null;
  }

  /**
   * Fine when the nearest zone is within the profile's escalation range.
   *
   * Asymmetric on purpose: once fine, the fall-back threshold is widened by
   * TIER_DEESCALATE_FACTOR. Escalating at 120 m but de-escalating only past
   * 150 m means a fix wandering either side of 120 m holds its tier instead of
   * alternating - the same trick that keeps zone entry and exit stable.
   */
  private desiredTier(fix: LatLng): 'coarse' | 'fine' {
    const nearest = this.distanceToNearestZone(fix);
    if (nearest === null) return 'coarse';

    const threshold =
      this.currentTier === 'fine'
        ? this.profile.escalateWithinMeters * TIER_DEESCALATE_FACTOR
        : this.profile.escalateWithinMeters;

    return nearest <= threshold ? 'fine' : 'coarse';
  }

  /**
   * Metres to the closest zone that can still produce an event, or null when
   * there is none.
   *
   * Since TASK-902 that is the armed stop plus any zone the user is inside (its
   * exit). Walking past a stop scheduled for later no longer escalates the GPS:
   * fine sampling there would buy precision for a boundary the engine ignores.
   */
  distanceToNearestZone(fix: LatLng): number | null {
    const armedId = this.armedZoneId();
    let nearest: number | null = null;
    for (const w of this.waypoints) {
      if (w.id !== armedId && !this.zoneStates.get(w.id)?.inside) continue;
      const d = w.geofence
        ? distanceToZone(fix, w.geofence)
        : distanceMeters(fix, w.coordinate);
      if (nearest === null || d < nearest) nearest = d;
    }
    return nearest;
  }

  private samplingOptions(tier: 'coarse' | 'fine'): Location.LocationOptions {
    const s = this.profile[tier];
    return {
      accuracy: s.accuracy,
      timeInterval: s.timeInterval,
      distanceInterval: s.distanceInterval,
    };
  }

  // ---------------------------------------------------------------------------
  // Introspection - for the debug geofence visualiser (PRD Screen 3)
  // ---------------------------------------------------------------------------

  /**
   * Resolves once every queued sampling restart has finished.
   *
   * Tier changes are fire-and-forget from onFix()'s point of view - a GPS fix
   * must never block on a native restart - so this is the seam that lets a test,
   * or an orderly teardown, wait for the hardware to have caught up.
   */
  async settled(): Promise<void> {
    await this.applying;
  }

  getTier(): 'coarse' | 'fine' {
    return this.currentTier;
  }

  isInside(waypointId: string): boolean {
    return this.zoneStates.get(waypointId)?.inside ?? false;
  }
}

/**
 * Stop background location updates left registered by a previous app process.
 *
 * If the app is force-killed mid-tour the OS keeps the task alive, so on the
 * next cold start location updates can be running with no session in memory -
 * battery drain for a tour that no longer exists, invisible in the UI. This is
 * module-level rather than a method because at reconciliation time there is no
 * LocationService instance yet, and deliberately does not resume anything.
 *
 * @returns true if an orphaned task was found and stopped.
 */
export async function stopOrphanedLocationUpdates(): Promise<boolean> {
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!running) return false;
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    return true;
  } catch {
    // Never let startup fail over cleanup of a task that may not exist.
    return false;
  }
}

/**
 * Registers the background location task. Import this module for its side
 * effect at app entry, BEFORE any call to startBackground() - TaskManager
 * requires the task to be defined at module scope so the OS can revive it into
 * a cold-started JS context.
 */
export function registerBackgroundLocationTask(
  handler: (fixes: LatLng[], timestamp: number) => void,
): void {
  if (TaskManager.isTaskDefined(LOCATION_TASK_NAME)) return;

  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
    LOCATION_TASK_NAME,
    async ({ data, error }) => {
      if (error || !data?.locations?.length) return;
      handler(
        data.locations.map((l) => ({
          latitude: l.coords.latitude,
          longitude: l.coords.longitude,
        })),
        Date.now(),
      );
    },
  );
}
