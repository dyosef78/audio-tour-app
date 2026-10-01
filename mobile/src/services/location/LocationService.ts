import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import { samplingFor, type GpsSampling } from '../../config/transitProfiles';
import type { GpsFix } from '../../engine/types';
import type { LatLng, TransitMode } from '../../types/domain';

/**
 * LocationService - GPS transport for the loose-sequence engine (Epic 15).
 *
 * It delivers fixes and nothing else. Every decision that used to live here -
 * geofence containment, the strict StopSequence, Adaptive GPS tiers - moved
 * to engine/reduce.ts, which tests every rule without a device. What remains
 * is what only the native layer can do: permissions, opening and closing the
 * right OS transport, and handing each fix on with everything the OS
 * reported (its own timestamp, speed, course, accuracy).
 *
 * SAMPLING. One setting per chapter (transitProfiles.ts), pinned, and
 * distanceInterval 0: a fix every timeInterval even standing still. The
 * swept test cannot step over a zone whatever the interval, and the steady
 * stream is the engine's clock in the background, where Android pauses JS
 * timers (React Native's JavaTimerManager).
 *
 * ANDROID (Epic 13) - ONE TASK FOR THE WHOLE SESSION. expo-location refuses to
 * start its location foreground service unless the app is in the foreground
 * (LocationModule.kt throws ForegroundServiceStartNotAllowedException), and
 * stopping the task tears that service down. So start() opens the background
 * task while the user is still looking at the screen, and nothing restarts it
 * except retune() - a chapter tap, in the foreground. Fixes arrive through the
 * task in the foreground too.
 *
 * iOS hands over between a foreground watcher and the background task as the
 * app moves (TourSessionController.handleAppStateChange).
 */

/** Task name registered with TaskManager for background fixes. */
export const LOCATION_TASK_NAME = 'audio-tour-background-location';

export interface LocationServiceCallbacks {
  /** Every fix - drives the map's blue dot. */
  onLocation?: (fix: LatLng, accuracyMeters: number | null) => void;
  /** Every fix with everything the OS reported - the engine's input. */
  onGpsFix?: (fix: GpsFix) => void;
  /** Sampling in force, for the debug overlay. Always the pinned tier. */
  onSamplingChange?: (tier: 'fine', sampling: GpsSampling) => void;
}

export class LocationService {
  private sampling: GpsSampling;
  private callbacks: LocationServiceCallbacks = {};
  private watcher: Location.LocationSubscription | null = null;

  /**
   * Which transport is live, so a retune reopens the RIGHT one - without it
   * a retune would either restart nothing or restart the thing that is not
   * running.
   */
  private trackingMode: 'idle' | 'foreground' | 'background' = 'idle';

  /** Serialises transport restarts so overlapping ones cannot interleave. */
  private applying: Promise<void> = Promise.resolve();

  /**
   * Android: the background task is the only transport, opened once by
   * start() (see the header). TourSessionController reads this to skip the
   * iOS app-state handoff.
   */
  readonly persistentTask: boolean;

  /** Whether the app is in the foreground - the only place Android may start its task. */
  private readonly isForeground: () => boolean;

  /** `platform` and `isForeground` are injectable so the Node tests can drive the Android path. */
  constructor(
    mode: TransitMode = 'walking',
    platform: string = Platform.OS,
    options: { isForeground?: () => boolean } = {},
  ) {
    this.sampling = samplingFor(mode);
    this.persistentTask = platform === 'android';
    this.isForeground = options.isForeground ?? (() => AppState.currentState === 'active');
  }

  /**
   * Android may only START its location foreground service in the
   * foreground, and replacing the task means stopping it first. Checked
   * BEFORE the stop: doing it the other way round leaves the tour with no
   * tracking at all when the start is refused.
   */
  private assertCanRestartTask(what: string): void {
    if (this.persistentTask && !this.isForeground()) {
      throw new Error(`${what} on Android needs the app in the foreground; the running task was left untouched`);
    }
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
   * background permission the tour still works with the screen on.
   *
   * Android 13+ (Epic 13): notifications are asked for last, before start()
   * opens the location foreground service, so its "Audio Tour in progress"
   * notice is visible. Below Android 13, and on iOS, the permission does not
   * exist here: true.
   */
  async requestPermissions(): Promise<{ foreground: boolean; background: boolean; notifications: boolean }> {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return { foreground: false, background: false, notifications: false };

    const bg = await Location.requestBackgroundPermissionsAsync();
    return { foreground: true, background: bg.status === 'granted', notifications: await this.requestNotifications() };
  }

  private async requestNotifications(): Promise<boolean> {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return true;
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  // ---------------------------------------------------------------------------
  // Tracking
  // ---------------------------------------------------------------------------

  /**
   * Start tracking.
   *
   * iOS: the foreground watcher. Android: the persistent background task,
   * which MUST be opened while the app is in the foreground - it throws
   * otherwise, loudly, rather than start a tour that cannot track. A task
   * already registered (a previous process, another tour's options) is
   * replaced, because a running task keeps the options it was started with.
   */
  async start(): Promise<void> {
    if (this.persistentTask) {
      this.assertCanRestartTask('start()');
      this.trackingMode = 'background';
      const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
      if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
      await this.openBackgroundUpdates();
      this.callbacks.onSamplingChange?.('fine', this.sampling);
      return;
    }
    this.trackingMode = 'foreground';
    await this.openWatcher();
    this.callbacks.onSamplingChange?.('fine', this.sampling);
  }

  private async openWatcher(): Promise<void> {
    this.watcher?.remove();
    this.watcher = null;
    this.watcher = await Location.watchPositionAsync(this.locationOptions(), (loc) => this.onGpsFix(toGpsFix(loc)));
  }

  async stop(): Promise<void> {
    // Go idle first so a restart already queued becomes a no-op, drain the
    // queue, then drop the watcher - otherwise a restart in flight would hand
    // back a fresh watcher after the caller believes tracking has stopped.
    if (this.trackingMode === 'foreground') this.trackingMode = 'idle';
    await this.applying;
    this.watcher?.remove();
    this.watcher = null;
  }

  /**
   * Resume tracking for a session rebuilt from a checkpoint (Epic 13).
   *
   * Android: if the tracking task is still registered - the OS restarted it
   * after killing the process - ADOPT it without touching it: restarting it
   * from the background would throw. Otherwise start() as normal, which only
   * succeeds in the foreground; the caller handles the throw.
   */
  async resumeTracking(): Promise<void> {
    if (this.persistentTask && (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME))) {
      this.trackingMode = 'background';
      this.callbacks.onSamplingChange?.('fine', this.sampling);
      return;
    }
    await this.start();
  }

  /**
   * iOS only: move to the background task when the app is backgrounded.
   * Requires a development build - background location does NOT work in
   * Expo Go (Expo SDK 57 docs).
   */
  async startBackground(): Promise<void> {
    // Android opens its task in start(); from here the app may already be in
    // the background, where the start would throw. A caller reaching this on
    // Android has bypassed the persistentTask contract - say so.
    if (this.persistentTask) {
      throw new Error('startBackground() is not used on Android: start() opens the persistent task');
    }
    this.trackingMode = 'background';
    const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (already) return;
    await this.openBackgroundUpdates();
  }

  private async openBackgroundUpdates(): Promise<void> {
    await Location.startLocationUpdatesAsync(LOCATION_TASK_NAME, {
      ...this.locationOptions(),
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
    // Same ordering as stop(): a late restart would leave a task running with
    // no session behind it - the battery drain stopOrphanedLocationUpdates()
    // exists to clean up on the next cold start.
    if (this.trackingMode === 'background') this.trackingMode = 'idle';
    await this.applying;
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
  }

  /**
   * A new chapter's transit mode: adopt its sampling and reopen whichever
   * transport is live. On Android that restarts the persistent task, which
   * only works in the foreground - the caller is a chapter tap, so it is; if
   * not, this throws and the caller reports it. Idle (not tracking): the next
   * start() picks the new sampling up.
   */
  async retune(mode: TransitMode): Promise<void> {
    if (this.trackingMode === 'background') this.assertCanRestartTask('retune()');
    this.sampling = samplingFor(mode);
    const run = this.applying.then(async () => {
      if (this.trackingMode === 'foreground') {
        await this.openWatcher();
      } else if (this.trackingMode === 'background') {
        // startLocationUpdatesAsync does not reconfigure a running task, so
        // the stop is mandatory rather than defensive.
        const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
        if (running) await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
        await this.openBackgroundUpdates();
      }
    });
    // The CALLER gets the failure; the chain does not keep it. A rejected
    // `applying` would make every later stop() throw and wedge teardown.
    this.applying = run.catch(() => undefined);
    await run;
    this.callbacks.onSamplingChange?.('fine', this.sampling);
  }

  // ---------------------------------------------------------------------------
  // Fixes
  // ---------------------------------------------------------------------------

  /** Every fix, foreground or background: hand it on. No decisions here. */
  onGpsFix(fix: GpsFix): void {
    this.callbacks.onLocation?.(fix.coordinate, fix.accuracyM);
    this.callbacks.onGpsFix?.(fix);
  }

  private locationOptions(): Location.LocationOptions {
    return {
      accuracy: this.sampling.accuracy,
      timeInterval: this.sampling.timeInterval,
      // A fix every timeInterval, moving or not - the engine's background clock.
      distanceInterval: 0,
    };
  }
}

/**
 * Stop background location updates left registered by a previous app process.
 *
 * If the app is force-killed mid-tour the OS keeps the task alive, so on the
 * next cold start location updates can be running with no session in memory -
 * battery drain for a tour that no longer exists, invisible in the UI. Module
 * level because at reconciliation time there is no LocationService yet.
 *
 * @returns true if an orphaned task was found and stopped.
 */
export async function stopOrphanedLocationUpdates(): Promise<boolean> {
  try {
    const running = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK_NAME);
    if (!running) return false;
    await Location.stopLocationUpdatesAsync(LOCATION_TASK_NAME);
    return true;
  } catch (err) {
    // Startup must not fail over cleanup of a task that may not exist - but
    // a failure here is a task that may still be draining the battery.
    console.warn('[LocationService] could not check for or stop an orphaned location task:', err);
    return false;
  }
}

/**
 * Registers the background location task. Import this module for its side
 * effect at app entry, BEFORE any tracking starts - TaskManager requires the
 * task to be defined at module scope so the OS can revive it into a
 * cold-started JS context.
 */
export function registerBackgroundLocationTask(handler: (fixes: GpsFix[]) => void): void {
  if (TaskManager.isTaskDefined(LOCATION_TASK_NAME)) return;

  TaskManager.defineTask<{ locations: Location.LocationObject[] }>(
    LOCATION_TASK_NAME,
    async ({ data, error }) => {
      if (error) {
        console.error('[LocationService] background location task reported an error:', error);
        return;
      }
      if (!data?.locations?.length) return;
      // Each fix keeps ITS OWN timestamp (Epic 15). Stamping a batch with one
      // Date.now() made the time between its fixes zero.
      handler(data.locations.map(toGpsFix));
    },
  );
}

/**
 * The OS fix as the engine needs it. Values are passed through raw - iOS
 * reports -1 for an invalid speed or course - and judged by the engine
 * (geo/bearing.ts), the one place that knows what counts as valid.
 */
export function toGpsFix(l: Location.LocationObject): GpsFix {
  return {
    coordinate: { latitude: l.coords.latitude, longitude: l.coords.longitude },
    timestamp: l.timestamp,
    accuracyM: l.coords.accuracy ?? null,
    speedMps: l.coords.speed ?? null,
    headingDeg: l.coords.heading ?? null,
  };
}
