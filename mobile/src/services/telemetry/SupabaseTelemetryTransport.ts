import { supabase } from '../supabase/client';

import type { TelemetryEvent, TelemetryTransport, TransportOutcome } from './types';

/**
 * TASK-506 - the Supabase half of the telemetry pipeline.
 *
 * Small on purpose: its entire job is turning a PostgREST failure into one of
 * three verdicts the queue can act on - delivered, never going to work, try
 * again later. Every rule below was checked against the live table rather than
 * inferred from the migration, because two of them are surprising.
 *
 * WHY .insert() AND NOT .upsert()
 * The obvious implementation of an idempotent write is
 *
 *     .upsert(rows, { onConflict: 'client_event_id', ignoreDuplicates: true })
 *
 * and it DOES NOT WORK on this table. PostgREST's upsert path requires the
 * UPDATE privilege, and migration 20260827170100 ends with
 *
 *     REVOKE UPDATE, DELETE ON public.telemetry_events FROM anon, authenticated;
 *
 * so the request comes back 401 before it reaches the constraint at all. Plain
 * INSERT succeeds and a replay returns 23505, which is why idempotency is
 * handled here as "a duplicate is a success" rather than in the statement.
 *
 * WHY THERE IS NO .select()
 * There is no SELECT policy for anon, so asking for the inserted row back turns
 * a valid write into 42501 "new row violates row-level security policy" - a
 * message that reads like a broken INSERT policy and is nothing of the kind.
 * supabase-js returns nothing by default, so the correct code is the code that
 * does not reach for the result. Flagged in the migration; confirmed by probe.
 */

const TABLE = 'telemetry_events';

/** Unique violation - the row is already there. Postgres 23505. */
const DUPLICATE_KEY = '23505';
/** CHECK violation - the row is malformed and always will be. Postgres 23514. */
const CHECK_VIOLATION = '23514';
/** FK violation - names content that does not exist. Postgres 23503. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Not-null violation. Postgres 23502. */
const NOT_NULL_VIOLATION = '23502';

/**
 * Failures that no amount of retrying will fix.
 *
 * Kept narrow deliberately. Anything not listed here - including an RLS denial,
 * which is usually a deployment problem rather than a bad event - stays
 * retryable, and the queue's attempt counter is what stops it looping forever.
 */
const PERMANENT = new Set([CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, NOT_NULL_VIOLATION]);

export class SupabaseTelemetryTransport implements TelemetryTransport {
  async send(events: readonly TelemetryEvent[]): Promise<TransportOutcome> {
    if (events.length === 0) return { kind: 'accepted' };

    try {
      // No .select(). See the header - chaining it is a 42501, not a result set.
      const { error } = await supabase.from(TABLE).insert(events as TelemetryEvent[]);

      if (error === null) return { kind: 'accepted' };

      if (error.code === DUPLICATE_KEY) {
        // For a single event this means "already delivered". For a batch it
        // means the whole statement rolled back and the queue must retry one at
        // a time to find out which member was the replay.
        return { kind: 'conflict' };
      }

      if (error.code !== undefined && PERMANENT.has(error.code)) {
        return { kind: 'rejected', reason: `${error.code}: ${error.message}` };
      }

      return { kind: 'unavailable', reason: `${error.code ?? 'unknown'}: ${error.message}` };
    } catch (err) {
      // A thrown error here is a dead network, not a rejected row: supabase-js
      // resolves protocol-level failures into `error` and only throws when the
      // request could not be made at all.
      return {
        kind: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
