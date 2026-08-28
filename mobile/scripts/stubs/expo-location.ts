/**
 * Node stub for `expo-location` (TASK-504 / TASK-505).
 *
 * The simulator drives the REAL LocationService, because a reimplementation of
 * the geofence engine would only ever prove that the reimplementation works. The
 * real module cannot load outside a device - it binds native modules at import -
 * so the handful of symbols LocationService touches are supplied here.
 *
 * Since TASK-505 this stub also RECORDS. Adaptive GPS is only meaningful if the
 * chosen tier actually reaches the OS, and the only way to observe that from
 * Node is to capture the options the service hands to watchPositionAsync. The
 * recorded calls are what the simulator's Adaptive GPS phase asserts against, so
 * an escalation that updates bookkeeping but never reconfigures the hardware -
 * precisely the bug TASK-505 exists to fix - fails the run rather than passing
 * it.
 */

export const Accuracy = {
  Lowest: 1,
  Low: 2,
  Balanced: 3,
  High: 4,
  Highest: 5,
  BestForNavigation: 6,
} as const;

// A const object rather than an `enum`: enums are non-erasable syntax and Node's
// type stripper refuses them, which is the whole reason this stub exists in .ts.
export type Accuracy = (typeof Accuracy)[keyof typeof Accuracy];

export interface LocationOptions {
  accuracy?: Accuracy;
  timeInterval?: number;
  distanceInterval?: number;
}

export interface LocationSubscription {
  remove: () => void;
}

export interface LocationObject {
  coords: { latitude: number; longitude: number; accuracy: number | null };
  timestamp: number;
}

// -----------------------------------------------------------------------------
// Recording
// -----------------------------------------------------------------------------

export interface RecordedCall {
  kind: 'watch' | 'watch-remove' | 'background-start' | 'background-stop';
  options?: LocationOptions;
}

/** Every OS-facing call the service has made, in order. */
export const calls: RecordedCall[] = [];

export function resetCalls(): void {
  calls.length = 0;
  backgroundRunning = false;
}

/** The sampling options of the most recent watcher, or undefined if none. */
export function currentWatchOptions(): LocationOptions | undefined {
  return calls.filter((c) => c.kind === 'watch').at(-1)?.options;
}

/** How many times a transport has been (re)started - the thrash counter. */
export function restartCount(): number {
  return calls.filter((c) => c.kind === 'watch' || c.kind === 'background-start').length;
}

// -----------------------------------------------------------------------------
// The stubbed API
// -----------------------------------------------------------------------------

let backgroundRunning = false;

export const requestForegroundPermissionsAsync = async (): Promise<{ status: string }> => ({
  status: 'granted',
});

export const requestBackgroundPermissionsAsync = async (): Promise<{ status: string }> => ({
  status: 'granted',
});

export const watchPositionAsync = async (
  options: LocationOptions,
  _callback: (location: LocationObject) => void,
): Promise<LocationSubscription> => {
  calls.push({ kind: 'watch', options });
  return {
    remove: () => {
      calls.push({ kind: 'watch-remove' });
    },
  };
};

export const startLocationUpdatesAsync = async (
  _task: string,
  options: LocationOptions,
): Promise<void> => {
  backgroundRunning = true;
  calls.push({ kind: 'background-start', options });
};

export const stopLocationUpdatesAsync = async (): Promise<void> => {
  backgroundRunning = false;
  calls.push({ kind: 'background-stop' });
};

export const hasStartedLocationUpdatesAsync = async (): Promise<boolean> => backgroundRunning;
