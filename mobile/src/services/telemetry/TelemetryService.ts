import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, type AppStateStatus, Platform } from 'react-native';

import { TelemetryQueue } from './TelemetryQueue';
import { SupabaseTelemetryTransport } from './SupabaseTelemetryTransport';
import type {
  FlushResult,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryTransport,
} from './types';

/**
 * TASK-506 - the public face of telemetry.
 *
 * Owns three things the queue deliberately does not: the device identity, the
 * construction of a well-formed event, and when to try sending.
 *
 * NETWORK AWARENESS, HONESTLY DESCRIBED
 * This app has no NetInfo and no expo-network dependency, so nothing here can
 * observe the radio directly. Sync is therefore TRIGGER-DRIVEN plus backoff:
 * it flushes when something has probably changed (app foregrounded, a tour
 * started or ended, an explicit nudge) and, on failure, waits longer each time
 * up to a ceiling. The practical difference from a NetInfo build is latency, not
 * correctness - events are delivered a little later than the instant the radio
 * returns.
 *
 * `setConnectivityProbe()` is the seam for closing that gap. Hand it
 * NetInfo.fetch().then(s => s.isInternetReachable ?? false) and the loop stops
 * making pointless attempts while offline; add a NetInfo listener calling
 * flush() and delivery becomes immediate. Neither requires touching the queue.
 */

const DEVICE_ID_KEY = 'telemetry:device_id:v1';

/** First retry delay after a failed flush. */
const BACKOFF_MIN_MS = 30_000;
/** Ceiling, so a device offline all day still tries a few times an hour. */
const BACKOFF_MAX_MS = 15 * 60_000;
/** Routine flush cadence while the app is in the foreground and healthy. */
const IDLE_INTERVAL_MS = 2 * 60_000;

/** Context an audio event needs beyond the track itself. */
export interface AudioEventContext {
  tourId: string | null;
  waypointId: string | null;
  /** The real audio_tracks.id; null for bundles predating TASK-507. */
  audioTrackId: string | null;
  positionSeconds: number | null;
  trackSeconds: number | null;
}

/**
 * What AudioService talks to.
 *
 * A narrow interface rather than the concrete service, so the player can be
 * exercised with a recording double and never reaches AsyncStorage in a test.
 */
export interface AudioTelemetrySink {
  recordAudio: (type: AudioTelemetryType, context: AudioEventContext) => void;
}

/** The subset of the event vocabulary the audio layer can emit. */
export type AudioTelemetryType =
  | 'audio_started'
  | 'audio_completed'
  | 'audio_skipped'
  | 'audio_stopped'
  /**
   * TASK-507. Deliberately outside the completion and drop-off funnels: a pause
   * is usually a road crossing, not an abandonment, and folding it into either
   * KPI would make that metric a measure of traffic lights. See migration
   * 20260828140000.
   */
  | 'audio_paused';

export class TelemetryService implements AudioTelemetrySink {
  private readonly queue: TelemetryQueue;
  private deviceId: string | null = null;
  private deviceIdLoad: Promise<string> | null = null;

  private appStateSub: { remove: () => void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BACKOFF_MIN_MS;
  /** Serialises flushes so two triggers cannot drain concurrently. */
  private flushing: Promise<FlushResult | null> = Promise.resolve(null);
  private connectivityProbe: (() => Promise<boolean>) | null = null;

  private appVersion: string | null = null;

  constructor(transport: TelemetryTransport = new SupabaseTelemetryTransport()) {
    this.queue = new TelemetryQueue(transport);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Call once at app entry.
   *
   * Flushes immediately: the commonest case is an app opened at a hotel with
   * WiFi after a tour walked in a dead zone, and that queue should not wait for
   * the idle timer.
   */
  async start(appVersion?: string): Promise<void> {
    this.appVersion = appVersion ?? null;
    await this.ensureDeviceId();

    this.appStateSub ??= AppState.addEventListener('change', (next: AppStateStatus) => {
      // Returning to the foreground is the strongest signal available without
      // NetInfo that connectivity may have changed.
      if (next === 'active') this.flush();
    });

    this.flush();
  }

  /** Release the AppState listener and cancel any pending retry. */
  stop(): void {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.clearTimer();
  }

  /**
   * Supply a connectivity check so the loop can skip doomed attempts.
   *
   * Optional by design - without it the transport itself is the probe, which
   * costs one failed request per backoff window and is perfectly survivable.
   */
  setConnectivityProbe(probe: (() => Promise<boolean>) | null): void {
    this.connectivityProbe = probe;
  }

  // ---------------------------------------------------------------------------
  // Device identity
  // ---------------------------------------------------------------------------

  /**
   * A UUID minted once per install and persisted.
   *
   * Self-asserted and unauthenticated, exactly as the migration says. It exists
   * so KPIs can count distinct devices - "did THIS phone finish the track" - and
   * for nothing else. It is not an identity and must never be treated as one.
   */
  private async ensureDeviceId(): Promise<string> {
    if (this.deviceId !== null) return this.deviceId;

    // Concurrent callers share one load; two racing generates two ids and the
    // second silently overwrites the first, splitting one device's KPIs in two.
    this.deviceIdLoad ??= (async () => {
      try {
        const stored = await AsyncStorage.getItem(DEVICE_ID_KEY);
        if (stored !== null && stored.length > 0) return stored;
      } catch {
        // Fall through and mint a fresh one; a device counted twice is a much
        // smaller problem than a tour that will not start.
      }
      const minted = uuidV4();
      try {
        await AsyncStorage.setItem(DEVICE_ID_KEY, minted);
      } catch (err) {
        console.warn('[Telemetry] could not persist device id:', err);
      }
      return minted;
    })();

    this.deviceId = await this.deviceIdLoad;
    return this.deviceId;
  }

  // ---------------------------------------------------------------------------
  // Producer
  // ---------------------------------------------------------------------------

  /** Record an audio lifecycle event. Fire-and-forget by contract. */
  recordAudio(type: AudioTelemetryType, context: AudioEventContext): void {
    void this.record(type, context);
  }

  /**
   * Build and enqueue an event.
   *
   * Never throws: it is called from audio status callbacks and geofence
   * handlers, and analytics failing must not surface as a broken tour.
   */
  async record(
    type: TelemetryEventType,
    context: Partial<AudioEventContext> & { meta?: Record<string, unknown> } = {},
  ): Promise<void> {
    try {
      const deviceId = await this.ensureDeviceId();

      const event: TelemetryEvent = {
        client_event_id: uuidV4(),
        device_id: deviceId,
        event_type: type,
        tour_id: context.tourId ?? null,
        waypoint_id: context.waypointId ?? null,
        audio_track_id: context.audioTrackId ?? null,
        position_seconds: round2(context.positionSeconds),
        track_seconds: positiveOrNull(context.trackSeconds),
        occurred_at: new Date().toISOString(),
        app_version: this.appVersion,
        platform: platformTag(),
        meta: context.meta ?? null,
      };

      await this.queue.enqueue(event);
    } catch (err) {
      console.warn('[Telemetry] could not record event:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Sync loop
  // ---------------------------------------------------------------------------

  /**
   * Drain the queue, then schedule the next attempt.
   *
   * Returns the flush result so tests can await it; production callers ignore it
   * on purpose - nothing in the app should ever wait on telemetry.
   */
  flush(): Promise<FlushResult | null> {
    this.flushing = this.flushing.then(() => this.drain());
    return this.flushing;
  }

  private async drain(): Promise<FlushResult | null> {
    this.clearTimer();

    if (this.connectivityProbe !== null) {
      try {
        if (!(await this.connectivityProbe())) {
          // Known offline: skip the round trip entirely and try again later.
          this.scheduleRetry(this.backoffMs);
          return null;
        }
      } catch {
        // A broken probe must not disable telemetry - fall through and just try.
      }
    }

    let total: FlushResult = { delivered: 0, dropped: 0, retained: 0, offline: false };

    // Keep going while the queue is draining, so a large backlog clears in one
    // window rather than one batch per two minutes.
    for (;;) {
      const result = await this.queue.flushOnce();
      total = {
        delivered: total.delivered + result.delivered,
        dropped: total.dropped + result.dropped,
        retained: result.retained,
        offline: result.offline,
      };

      if (result.offline) break;
      if (result.delivered === 0 && result.dropped === 0) break;
      if (result.retained === 0) break;
    }

    if (total.offline) {
      this.scheduleRetry(this.backoffMs);
      // Exponential, capped. Doubling from 30 s reaches the 15 min ceiling in
      // five failures, which keeps a genuinely offline device cheap without
      // making a brief outage cost an hour of latency.
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    } else {
      this.backoffMs = BACKOFF_MIN_MS;
      if (total.retained > 0) this.scheduleRetry(BACKOFF_MIN_MS);
      else this.scheduleRetry(IDLE_INTERVAL_MS);
    }

    return total;
  }

  private scheduleRetry(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // Introspection - debug overlay and tests
  // ---------------------------------------------------------------------------

  pendingCount(): Promise<number> {
    return this.queue.size();
  }

  clearQueue(): Promise<void> {
    return this.queue.clear();
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** numeric(10,2) in the schema, so round rather than let PostgREST decide. */
function round2(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, value) * 100) / 100;
}

/**
 * track_seconds has a `> 0` CHECK, so a zero or unknown duration must be null.
 *
 * Sending 0 would be rejected as 23514 and the event dropped as poison - losing
 * the completion it was recording.
 */
function positiveOrNull(value: number | null | undefined): number | null {
  const rounded = round2(value);
  return rounded !== null && rounded > 0 ? rounded : null;
}

/** The platform CHECK permits only 'ios' and 'android'; anything else is null. */
function platformTag(): 'ios' | 'android' | null {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return null;
}

/**
 * RFC 4122 v4, from the best random source available.
 *
 * Hermes exposes neither `crypto.randomUUID` nor `crypto.getRandomValues`
 * universally across the platforms this app targets, and neither expo-crypto nor
 * react-native-get-random-values is a dependency. So: use the good sources when
 * present, and fall back to Math.random otherwise.
 *
 * The fallback is weaker than cryptographic randomness, and that is an accepted
 * trade rather than an oversight. These ids are idempotency keys, not secrets -
 * they are unguessable-adjacent at worst, and the property that matters is
 * uniqueness. If the unique index ever shows a collision, add expo-crypto; the
 * change is confined to this function.
 */
export function uuidV4(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;

  if (typeof cryptoRef?.randomUUID === 'function') {
    return cryptoRef.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof cryptoRef?.getRandomValues === 'function') {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  // Version 4, variant 10xx - required, or Postgres still accepts it but the id
  // is not a valid v4 and anyone reading the table would be misled.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push((bytes[i] ?? 0).toString(16).padStart(2, '0'));

  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-` +
    `${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

/** The app-wide instance. Wired into AudioService by TourSessionController. */
export const telemetry = new TelemetryService();
