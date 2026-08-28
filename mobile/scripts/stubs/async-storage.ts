/**
 * In-memory AsyncStorage for the Node test harness (TASK-506).
 *
 * Deliberately a real store rather than a mock returning null: the telemetry
 * queue's whole contract is durability across restarts, and `reset()` plus a
 * fresh TelemetryQueue over the SAME map is how a test simulates an app relaunch
 * with a queue still on disk.
 */

const store = new Map<string, string>();

export function __reset(): void {
  store.clear();
}

export function __dump(): Record<string, string> {
  return Object.fromEntries(store);
}

/** Force the next write to throw, to exercise the "never break a tour" paths. */
export let __failWrites = false;
export function __setFailWrites(fail: boolean): void {
  __failWrites = fail;
}

const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> => store.get(key) ?? null,
  setItem: async (key: string, value: string): Promise<void> => {
    if (__failWrites) throw new Error('simulated storage failure');
    store.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    store.delete(key);
  },
};

export default AsyncStorage;
