/**
 * TASK-506 - telemetry wire and queue types.
 *
 * The event vocabulary is NOT free-form: migration 20260827170100 puts a CHECK
 * constraint on `event_type`, and Postgres rejects anything outside it with
 * 23514. Verified against the live table - posting `pause` returns
 *
 *     new row for relation "telemetry_events"
 *     violates check constraint "telemetry_events_event_type_check"
 *
 * so this union is the schema, transcribed. Widening it here without the
 * matching migration produces events that queue locally, fail permanently on
 * sync, and are eventually dropped as poison - i.e. silent data loss.
 */

/** Exactly the values telemetry_events_event_type_check permits. */
export type TelemetryEventType =
  | 'tour_started'
  | 'tour_completed'
  | 'bundle_downloaded'
  | 'geofence_entered'
  | 'audio_started'
  | 'audio_completed'
  | 'audio_skipped'
  | 'audio_stopped'
  /** Added by migration 20260828140000 (TASK-507). */
  | 'audio_paused';

/**
 * One row of public.telemetry_events, as the client posts it.
 *
 * Column names are snake_case because this object is handed to PostgREST
 * verbatim. `received_at` and `id` are server-side and deliberately absent.
 */
export interface TelemetryEvent {
  /**
   * Idempotency key, generated once when the event is enqueued and never
   * regenerated on retry. This is the entire defence against an offline queue
   * inflating every KPI by the flakiness of the network: the request succeeds,
   * the response is lost, the client retries, and the unique index turns the
   * replay into a no-op.
   */
  client_event_id: string;
  /** Self-asserted, persisted once per install. Not an identity - see the migration. */
  device_id: string;
  event_type: TelemetryEventType;

  tour_id: string | null;
  waypoint_id: string | null;
  /**
   * The audio_tracks row that was played.
   *
   * Populated since TASK-507, when get_tour_bundle() started returning the id.
   * Still null for bundles downloaded before that migration - the id was kept
   * out of bundle_version_hash so existing bundles were not invalidated, so
   * coverage improves as bundles refresh rather than all at once. Nullable in
   * the schema, and the KPI views group by waypoint_id regardless.
   */
  audio_track_id: string | null;

  /** Where playback stopped, and how long the track was AT THE TIME. */
  position_seconds: number | null;
  track_seconds: number | null;

  /** Device clock, ISO 8601. The server stamps received_at itself. */
  occurred_at: string;

  app_version: string | null;
  platform: 'ios' | 'android' | null;
  meta: Record<string, unknown> | null;
}

/**
 * A queued event plus the bookkeeping the sync loop needs.
 *
 * `attempts` exists so a permanently unacceptable event cannot occupy the head
 * of the queue forever. Telemetry is lossy by nature and must never be the
 * reason a tour misbehaves, so the queue is allowed to give up on a row.
 */
export interface QueuedEvent {
  event: TelemetryEvent;
  /** Device clock at enqueue, for age-based eviction. */
  queuedAt: number;
  attempts: number;
}

/** What the sync loop did, for logging and for the tests. */
export interface FlushResult {
  /** Accepted by the server, or already there (a duplicate is a success). */
  delivered: number;
  /** Permanently unacceptable and discarded rather than retried forever. */
  dropped: number;
  /** Still queued - the network or the server was unavailable. */
  retained: number;
  /** True when the flush ended because the transport failed. */
  offline: boolean;
}

/**
 * The transport, abstracted so the queue can be driven without a network.
 *
 * Returns per-event outcomes rather than throwing, because the whole design
 * turns on distinguishing three cases that look identical from a caught error:
 * delivered, permanently rejected, and try again later.
 */
export interface TelemetryTransport {
  send: (events: readonly TelemetryEvent[]) => Promise<TransportOutcome>;
}

export type TransportOutcome =
  /** Every event in the batch landed. */
  | { kind: 'accepted' }
  /**
   * The batch was rejected as a unit and must be retried one event at a time.
   *
   * PostgREST inserts a batch in ONE statement, so a single duplicate rolls the
   * whole thing back - verified: a 3-event batch containing one replay left all
   * three unwritten. Without this fallback a queue that ever retried a partly
   * delivered batch would wedge permanently, which is the exact opposite of what
   * the idempotency key is for.
   */
  | { kind: 'conflict' }
  /** This event will never be accepted - a CHECK violation, a bad FK. */
  | { kind: 'rejected'; reason: string }
  /** Transport failure. Keep the events and back off. */
  | { kind: 'unavailable'; reason: string };
