import AsyncStorage from '@react-native-async-storage/async-storage';

import type {
  FlushResult,
  QueuedEvent,
  TelemetryEvent,
  TelemetryTransport,
  TransportOutcome,
} from './types';

/**
 * TASK-506 - the durable half of the telemetry pipeline.
 *
 * A bounded, append-only queue in AsyncStorage plus the loop that drains it.
 * Deliberately knows nothing about audio, Supabase or React: it takes events in
 * and hands them to a TelemetryTransport, which is what makes the whole thing
 * testable without a network or a device.
 *
 * WHY AsyncStorage AND NOT SQLITE
 * expo-sqlite is not a dependency of this app and telemetry is not worth adding
 * one for. The volume is tiny - a 90 minute tour with a dozen waypoints produces
 * on the order of 50 events - and the access pattern is "append, then drain from
 * the head", which needs no query engine. If telemetry ever grows to per-second
 * position sampling this decision should be revisited; MAX_QUEUED is the tripwire.
 *
 * DURABILITY MODEL
 * Every mutation is a read-modify-write of one key, serialised through a promise
 * chain. Two concurrent enqueues would otherwise interleave their reads and the
 * second write would silently discard the first event. The chain is the reason
 * this class is safe to call from a status callback firing several times a
 * second.
 *
 * The queue is LOSSY BY DESIGN and that is not a defect. Telemetry must never be
 * the reason a tour misbehaves, so it drops events rather than growing without
 * bound, blocking playback, or retrying a permanently invalid row forever.
 */

const QUEUE_KEY = 'telemetry:queue:v1';

/**
 * Hard cap on queued events; the oldest are evicted first.
 *
 * Android's AsyncStorage is a 6 MB SQLite blob by default and this queue shares
 * it with the bundle resume records. At roughly 400 bytes an event, 500 events
 * is ~200 kB - generous for a tour, nowhere near the ceiling, and bounded even
 * if a device never regains connectivity.
 */
const MAX_QUEUED = 500;

/**
 * Give up on an event after this many failed sends.
 *
 * Only reached by events the server keeps refusing for a reason the client
 * cannot see. A `rejected` outcome drops immediately; this is the backstop for
 * anything that looks retryable forever.
 */
const MAX_ATTEMPTS = 10;

/** Events per network round trip. */
const BATCH_SIZE = 50;

export class TelemetryQueue {
  private readonly transport: TelemetryTransport;
  /** Serialises every read-modify-write of the stored array. */
  private mutex: Promise<void> = Promise.resolve();

  constructor(transport: TelemetryTransport) {
    this.transport = transport;
  }

  // ---------------------------------------------------------------------------
  // Storage primitives
  // ---------------------------------------------------------------------------

  private async read(): Promise<QueuedEvent[]> {
    try {
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Shape-check rather than trust: a partial write or a schema change from a
      // previous app version must not crash a tour on the next launch.
      return parsed.filter(isQueuedEvent);
    } catch {
      // Corrupt queue costs us analytics, never the session.
      return [];
    }
  }

  private async write(events: readonly QueuedEvent[]): Promise<void> {
    try {
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(events));
    } catch (err) {
      console.warn('[Telemetry] could not persist queue:', err);
    }
  }

  /** Run `fn` with exclusive access to the stored queue. */
  private mutate<T>(fn: (events: QueuedEvent[]) => Promise<T> | T): Promise<T> {
    const run = this.mutex.then(async () => {
      const events = await this.read();
      return fn(events);
    });
    // The chain must survive a thrown fn, or every later mutation deadlocks
    // behind a rejected promise.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---------------------------------------------------------------------------
  // Producer
  // ---------------------------------------------------------------------------

  /**
   * Append an event. Never throws and never blocks the caller on the network.
   *
   * Callers are audio callbacks and geofence handlers, so this is on the hot
   * path of the product. It writes and returns; delivery is somebody else's
   * problem, which is the whole point of an offline-first queue.
   */
  async enqueue(event: TelemetryEvent): Promise<void> {
    await this.mutate(async (events) => {
      events.push({ event, queuedAt: Date.now(), attempts: 0 });

      // Evict from the HEAD: when a device has been offline for a week, the most
      // recent behaviour is the more useful sample.
      const overflow = events.length - MAX_QUEUED;
      if (overflow > 0) {
        events.splice(0, overflow);
        console.warn(`[Telemetry] queue full, dropped ${overflow} oldest event(s)`);
      }

      await this.write(events);
    });
  }

  /** How many events are waiting. Used by the debug overlay and the tests. */
  async size(): Promise<number> {
    return (await this.read()).length;
  }

  /** Drop everything. Used by "clear data" and by the tests. */
  async clear(): Promise<void> {
    await this.mutate(async () => {
      await this.write([]);
    });
  }

  // ---------------------------------------------------------------------------
  // Consumer
  // ---------------------------------------------------------------------------

  /**
   * Call the transport, converting a thrown error into 'unavailable'.
   *
   * SupabaseTelemetryTransport already catches its own failures, so this is
   * about not TRUSTING that: a transport is an injected dependency, and one that
   * throws would otherwise escape flushOnce(), reject the sync loop's promise,
   * and surface as an unhandled rejection - telemetry taking down the app it is
   * supposed to be silently observing.
   */
  private async send(events: readonly TelemetryEvent[]): Promise<TransportOutcome> {
    try {
      return await this.transport.send(events);
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Attempt one batch.
   *
   * Batch first for the round trip, then fall back to one-at-a-time if the
   * server rejects the batch as a unit. That fallback is not a nicety: PostgREST
   * inserts a batch in a single statement, so ONE already-delivered event -
   * exactly what a retry after a lost response contains - rolls back the entire
   * batch. Verified against the live table. A queue without this fallback stops
   * draining permanently the first time a response goes missing.
   *
   * Returns a summary rather than throwing; the caller decides whether to keep
   * going or back off.
   */
  async flushOnce(): Promise<FlushResult> {
    return this.mutate(async (events) => {
      const empty: FlushResult = { delivered: 0, dropped: 0, retained: 0, offline: false };
      if (events.length === 0) return empty;

      const batch = events.slice(0, BATCH_SIZE);
      const outcome = await this.send(batch.map((q) => q.event));

      if (outcome.kind === 'accepted') {
        const rest = events.slice(batch.length);
        await this.write(rest);
        return { delivered: batch.length, dropped: 0, retained: rest.length, offline: false };
      }

      if (outcome.kind === 'unavailable') {
        // Nothing landed. Count the attempt so a permanently poisonous event
        // cannot masquerade as an outage forever, then leave the queue intact.
        for (const q of batch) q.attempts++;
        const survivors = events.filter((q) => q.attempts < MAX_ATTEMPTS);
        const dropped = events.length - survivors.length;
        await this.write(survivors);
        return { delivered: 0, dropped, retained: survivors.length, offline: true };
      }

      // 'conflict' or 'rejected': the batch failed as a unit and the server will
      // not tell us which member was at fault. Re-send individually so one bad
      // or already-delivered event cannot hold the rest hostage.
      return this.flushIndividually(events, batch);
    });
  }

  /**
   * Per-event retry after a batch was rejected as a unit.
   *
   * A `conflict` on a single event means it is ALREADY IN THE TABLE - the client
   * event id did its job - so it counts as delivered and is removed. That is the
   * step that turns the idempotency key from a schema decoration into working
   * exactly-once-ish delivery.
   */
  private async flushIndividually(
    events: QueuedEvent[],
    batch: readonly QueuedEvent[],
  ): Promise<FlushResult> {
    const settled = new Set<string>();
    let delivered = 0;
    let dropped = 0;
    let offline = false;

    for (const queued of batch) {
      const outcome = await this.send([queued.event]);

      if (outcome.kind === 'accepted' || outcome.kind === 'conflict') {
        // conflict === the row is already there. Nothing left to do.
        settled.add(queued.event.client_event_id);
        delivered++;
        continue;
      }

      if (outcome.kind === 'rejected') {
        // Permanently unacceptable - a CHECK violation, or an FK naming content
        // that no longer exists. Retrying cannot help and would block the queue.
        console.warn(
          `[Telemetry] dropping ${queued.event.event_type} permanently: ${outcome.reason}`,
        );
        settled.add(queued.event.client_event_id);
        dropped++;
        continue;
      }

      // Transport failure. Stop here rather than hammering a dead network with
      // the rest of the batch; the remaining events keep their place.
      queued.attempts++;
      offline = true;
      break;
    }

    const remaining = events.filter((q) => !settled.has(q.event.client_event_id));
    const survivors = remaining.filter((q) => q.attempts < MAX_ATTEMPTS);
    dropped += remaining.length - survivors.length;

    await this.write(survivors);
    return { delivered, dropped, retained: survivors.length, offline };
  }
}

/** Structural check for one stored record. See read(). */
function isQueuedEvent(value: unknown): value is QueuedEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<QueuedEvent>;
  const event = record.event;
  if (typeof event !== 'object' || event === null) return false;
  return (
    typeof (event as TelemetryEvent).client_event_id === 'string' &&
    typeof (event as TelemetryEvent).event_type === 'string' &&
    typeof (event as TelemetryEvent).occurred_at === 'string' &&
    typeof record.attempts === 'number'
  );
}

export const TELEMETRY_QUEUE_INTERNALS = { QUEUE_KEY, MAX_QUEUED, MAX_ATTEMPTS, BATCH_SIZE };
