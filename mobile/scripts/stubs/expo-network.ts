/** `expo-network` for the Node harness (Epic 17, TASK-1702): always online, never changes. */

export interface NetworkState {
  isConnected?: boolean;
  isInternetReachable?: boolean | null;
  type?: string;
}

export function addNetworkStateListener(_listener: (state: NetworkState) => void): { remove: () => void } {
  return { remove: () => {} };
}

export async function getNetworkStateAsync(): Promise<NetworkState> {
  return { isConnected: true, isInternetReachable: true, type: 'WIFI' };
}
