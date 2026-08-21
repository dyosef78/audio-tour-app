import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { profileFor, type GpsSampling, type TransitProfile } from '../../config/transitProfiles';
import type { LatLng, TransitMode, Waypoint } from '../../types/domain';
import { distanceMeters, distanceToZone, isInsideZone } from './geometry';

/**
 * LocationService - Adaptive GPS + local geofencing (TASK-101 / TASK-102).
 *
 * SKELETON: the pure decision logic is implemented and unit-testable; the parts
 * that touch the OS are marked TODO and throw or no-op rather than pretending
 * to work. Nothing here has run on a device yet.
 *
 * Two responsibilities, deliberately kept separate:
 *
 *   1. ADAPTIVE GPS - trade battery against precision. Sampling stays coarse
 *      while the user is far from every waypoint, and escalates to fine as they
 *      approach one (PRD v2.0.0 Screen 3).
 *
 *   2. LOCAL GEOFENCING - decide, per fix, which zones were entered or exited,
 *      applying debounce/cooldown and exit hysteresis (PRD v2.0.0 Screen 4).
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
  private currentTier: 'coarse' | 'fine' = 'coarse';
  private watcher: Location.LocationSubscription | null = null;

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
    this.currentTier = 'coarse';
  }

  setCallbacks(callbacks: LocationServiceCallbacks): void {
    this.callbacks = callbacks;
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
    await this.stop();
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
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (already) return;

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
    void this.applyAdaptiveGps(fix);
  }

  private evaluateGeofences(fix: LatLng, timestamp: number): void {
    for (const waypoint of this.waypoints) {
      const zone = waypoint.geofence;
      if (!zone) continue;

      const state = this.zoneStates.get(waypoint.id);
      if (!state) continue;

      // Asymmetric boundaries: enter on the true zone, exit only once clearly
      // outside a widened one. A fix jittering on the edge therefore cannot
      // produce an enter/exit storm.
      const inside = state.inside
        ? isInsideZone(fix, zone, this.profile.exitHysteresisFactor)
        : isInsideZone(fix, zone);

      if (inside === state.inside) continue;

      if (inside) {
        // Debounce: suppress a re-entry inside the cooldown window, but still
        // record the state change so the matching exit is not lost.
        const last = state.lastTriggeredAt;
        const cooling = last !== null && timestamp - last < this.profile.retriggerCooldownMs;

        state.inside = true;
        if (cooling) continue;

        state.lastTriggeredAt = timestamp;
        this.callbacks.onGeofence?.({ type: 'enter', waypoint, at: fix, timestamp });
      } else {
        state.inside = false;
        // Consumed by the audio layer as the cue to fade out (PRD Screen 4).
        this.callbacks.onGeofence?.({ type: 'exit', waypoint, at: fix, timestamp });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Adaptive GPS
  // ---------------------------------------------------------------------------

  /**
   * Escalate to fine sampling near a waypoint, fall back to coarse when clear
   * of all of them. Restarting the watcher is not free, so the tier is only
   * re-applied when it actually changes.
   */
  private async applyAdaptiveGps(fix: LatLng): Promise<void> {
    const tier = this.desiredTier(fix);
    if (tier === this.currentTier) return;

    this.currentTier = tier;
    const sampling = this.profile[tier];
    this.callbacks.onSamplingChange?.(tier, sampling);

    // TODO(TASK-102): re-apply to the live subscription. watchPositionAsync has
    // no mutate-in-place, so this means tearing down and restarting the watcher
    // - and doing the same for the background task via
    // stopLocationUpdatesAsync + startLocationUpdatesAsync. Both need to be
    // debounced so a user pacing the escalation boundary cannot thrash the GPS
    // subsystem. Not wired up until it can be measured on a real device.
  }

  /** Fine when the nearest zone is within the profile's escalation range. */
  private desiredTier(fix: LatLng): 'coarse' | 'fine' {
    const nearest = this.distanceToNearestZone(fix);
    return nearest !== null && nearest <= this.profile.escalateWithinMeters ? 'fine' : 'coarse';
  }

  /** Metres to the closest zone edge, or null when the tour has no zones. */
  distanceToNearestZone(fix: LatLng): number | null {
    let nearest: number | null = null;
    for (const w of this.waypoints) {
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
