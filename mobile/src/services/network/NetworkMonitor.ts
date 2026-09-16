import { addNetworkStateListener, getNetworkStateAsync, type NetworkState } from 'expo-network';

import { connectivityOf } from './connectivity';

/**
 * App-wide connectivity, from expo-network (TASK-604).
 *
 * A single listener for the life of the process: it costs nothing while idle,
 * and a per-session subscription would miss the state change that happens
 * between two tours.
 *
 * ASYMMETRIC SETTLING. Going offline is reported immediately - an in-flight
 * request should be abandoned the moment the radio is gone. Coming back online
 * is reported only once it has held for ONLINE_SETTLE_MS: walking under a
 * bridge or along a narrow street flaps between the two, and a request fired on
 * each brief reconnect would spend the session's attempts on connections that
 * last a second. The very first reading is taken as-is, so a session started on
 * good WiFi does not wait.
 *
 * Unknown connectivity is treated as offline here; routing only needs to know
 * whether trying is worthwhile.
 */

const ONLINE_SETTLE_MS = 2_000;

class NetworkMonitor {
  private online = false;
  private known = false;
  private started = false;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(online: boolean) => void>();

  isOnline(): boolean {
    this.start();
    return this.online;
  }

  subscribe(listener: (online: boolean) => void): () => void {
    this.start();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    addNetworkStateListener((state) => this.onState(state));
    getNetworkStateAsync()
      .then((state) => this.onState(state))
      .catch((err: unknown) => console.warn('[Network] could not read initial state:', err));
  }

  private onState(state: NetworkState): void {
    const next = connectivityOf(state) === 'online';

    if (!this.known) {
      this.known = true;
      this.setOnline(next);
      return;
    }

    if (!next) {
      if (this.settleTimer) clearTimeout(this.settleTimer);
      this.settleTimer = null;
      this.setOnline(false);
      return;
    }

    if (this.online || this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.setOnline(true);
    }, ONLINE_SETTLE_MS);
  }

  private setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    for (const listener of [...this.listeners]) listener(online);
  }
}

export const networkMonitor = new NetworkMonitor();
