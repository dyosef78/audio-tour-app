/**
 * expo-network state -> the one question routing asks: can we try the network?
 *
 * Pure and structurally typed, so it runs in the Node harness without the
 * native module.
 *
 * Reachability wins when it is known. When it is not, a connection counts as
 * online: a request that then fails costs one timed-out attempt and a retry,
 * whereas treating "unknown" as offline would never try at all. Note that on
 * iOS isInternetReachable merely mirrors isConnected, so captive-portal Wi-Fi
 * reads as online there - which is exactly the failed-attempt path above.
 */

export interface NetworkSnapshot {
  isConnected?: boolean;
  isInternetReachable?: boolean;
}

export type Connectivity = 'online' | 'offline' | 'unknown';

export function connectivityOf(state: NetworkSnapshot): Connectivity {
  if (state.isInternetReachable === true) return 'online';
  if (state.isInternetReachable === false || state.isConnected === false) return 'offline';
  if (state.isConnected === true) return 'online';
  return 'unknown';
}
