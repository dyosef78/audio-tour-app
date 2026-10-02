-- =============================================================================
-- Epic 15 : telemetry vocabulary for the loose-sequence engine
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
--
-- The engine reports what it decided and why, so its tolerances can be tuned
-- from the field rather than guessed (Epic 15 architecture plan, edge case 9):
--
--   trigger_reanchored        a detour skipped the window; the cursor jumped
--                             (meta: from, to, skipped)
--   trigger_rejected_bearing  a zone was crossed against its approach bearing
--                             (meta: reason, course, approach) - one per stop
--                             per chapter, not one per fix
--   trigger_expired           a fired stop waited too long or drove too far
--                             to still make sense (meta: reason ttl | distance
--                             | queue_full | preempted | chapter_left)
--   trigger_missed            a stop the visitor will not hear: skipped by a
--                             re-anchor, or its audio failed (meta: reason)
--   audio_watchdog            the engine overrode the player: PLAY timeout,
--                             resume request, gave up on an interruption
--   tour_suspended            idle timeout: tracking stopped after 15 min
--                             without moving (Epic 15, battery)
--   tour_resumed              the listener resumed a suspended tour
--   chapter_arrived           a chapter's navigation destination was reached
--                             (meta: next chapter) - the prompt to start the next
--
-- trigger_fired is NOT added: it already travels as geofence_entered, which
-- this vocabulary has always had, with the engine's detail in meta.
--
-- WHY THIS MUST BE PUSHED BEFORE ANY BUILD THAT SENDS THEM. The client queues
-- events offline and posts them in all-or-nothing batches. A type the server
-- rejects is accepted on the device, fails every sync, and takes the valid
-- events in its batch down with it until discarded as poison (see
-- 20260828140000). So: push this, THEN ship a client that sends them. Until
-- then the client logs them locally (TourSessionController,
-- recordEngineTelemetry).
--
-- Same pattern as 20260828140000: DROP + ADD (Postgres cannot alter a CHECK
-- expression), the full list restated, the client union mirrored in
-- mobile/src/services/telemetry/types.ts - test-cms fails if the two differ.
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. The new list is a superset, so
-- the ADD's validation scan passes every row already stored.
-- KPI views: unchanged - none of these is an audio outcome.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE public.telemetry_events
    DROP CONSTRAINT IF EXISTS telemetry_events_event_type_check;

ALTER TABLE public.telemetry_events
    ADD CONSTRAINT telemetry_events_event_type_check CHECK (event_type IN (
        'tour_started',
        'tour_completed',
        'bundle_downloaded',
        'geofence_entered',
        'audio_started',
        'audio_completed',
        'audio_skipped',
        'audio_stopped',
        'audio_paused',
        -- NEW (Epic 15).
        'trigger_reanchored',
        'trigger_rejected_bearing',
        'trigger_expired',
        'trigger_missed',
        'audio_watchdog',
        'tour_suspended',
        'tour_resumed',
        'chapter_arrived'
    ));

COMMENT ON CONSTRAINT telemetry_events_event_type_check ON public.telemetry_events IS
    'Closed event vocabulary. The mobile client mirrors this union in mobile/src/services/telemetry/types.ts (test-cms pins the two) - widening one without the other means events that queue locally and can never be delivered. Push a widening BEFORE shipping a client that sends the new types.';
