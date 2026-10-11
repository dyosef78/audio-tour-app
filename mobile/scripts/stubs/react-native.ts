/**
 * Minimal `react-native` for the Node test harness (TASK-506).
 *
 * Only what the services under test actually touch: Platform.OS (the telemetry
 * platform tag and the iOS-only codec guard) and AppState (the sync loop's
 * foreground trigger). Listeners are exposed so a test can fire a transition
 * without a device.
 */

export const Platform = { OS: 'ios' as 'ios' | 'android', Version: 17 as number | string };

/** Android runtime permissions; only reached on the Android path. */
export const PermissionsAndroid = {
  PERMISSIONS: { POST_NOTIFICATIONS: 'android.permission.POST_NOTIFICATIONS' },
  RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
  request: async (_permission: string): Promise<string> => 'granted',
};

/** Navigation handoff (navigationApps.ts). Opened URLs are recorded. */
export const openedUrls: string[] = [];
export const Linking = {
  canOpenURL: async (_url: string): Promise<boolean> => true,
  openURL: async (url: string): Promise<void> => {
    openedUrls.push(url);
  },
};

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

/** A killed process takes its listeners with it (controller harness). */
export function __resetAppState(): void {
  listeners.clear();
}

export function __listenerCount(): number {
  return listeners.size;
}

export type AppStateStatus = string;
