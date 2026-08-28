/**
 * Minimal `react-native` for the Node test harness (TASK-506).
 *
 * Only what the services under test actually touch: Platform.OS (the telemetry
 * platform tag and the iOS-only codec guard) and AppState (the sync loop's
 * foreground trigger). Listeners are exposed so a test can fire a transition
 * without a device.
 */

export const Platform = { OS: 'ios' as 'ios' | 'android' };

type AppStateListener = (status: string) => void;

const listeners = new Set<AppStateListener>();

export const AppState = {
  addEventListener: (_event: string, listener: AppStateListener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
};

/** Drive a foreground/background transition from a test. */
export function __emitAppState(status: string): void {
  for (const listener of [...listeners]) listener(status);
}

export function __listenerCount(): number {
  return listeners.size;
}

export type AppStateStatus = string;
