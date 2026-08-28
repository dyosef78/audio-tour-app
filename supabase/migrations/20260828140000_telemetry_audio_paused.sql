-- =============================================================================
-- TASK-507 (1 of 2) : allow 'audio_paused' telemetry
--
-- PM decision. The client wanted to record pauses from the start; the CHECK
-- constraint in 20260827170100 did not permit it, and posting one came back
--
--     new row for relation "telemetry_events"
--     violates check constraint "telemetry_events_event_type_check"
--
-- which for an offline queue is worse than it sounds: the event is accepted
-- locally, fails permanently on every sync, and is eventually discarded as
-- poison. Silent data loss wearing the costume of working analytics. So the
-- vocabulary is widened here rather than worked around on the device.
--
-- A NEW MIGRATION RATHER THAN AN EDIT. 20260827170100 is already applied to the
-- remote project; editing an applied migration changes nothing there and would
-- leave a fresh `db reset` producing a schema that no deployed environment ever
-- passed through.
-- =============================================================================

SET search_path = public, extensions;

-- DROP + ADD rather than an in-place edit: Postgres has no ALTER CONSTRAINT for
-- a CHECK expression. IF EXISTS keeps this re-runnable against a database where
-- an earlier attempt got half way.
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
        -- NEW. Distinct from audio_stopped on purpose - see the note below.
        'audio_paused'
    ));

-- -----------------------------------------------------------------------------
-- WHY THE KPI VIEWS ARE DELIBERATELY NOT CHANGED
--
-- v_kpi_audio_dropoff reads ('audio_stopped', 'audio_skipped') and must keep
-- doing so. A pause is not a drop-off: the overwhelmingly common case is a
-- tourist pausing to cross a road and resuming ten seconds later. Folding
-- audio_paused into that view would count every one of those as an abandonment
-- and make the drop-off rate a measure of traffic lights.
--
-- Nor does it touch v_kpi_audio_completion, which is started/completed/skipped -
-- a paused track is still on its way to one of those outcomes, so counting it
-- anywhere in that funnel would double-count the same listen.
--
-- Pauses are therefore recorded for their own sake: pause frequency and pause
-- position are interesting on their own (they say where narration is too long,
-- or where a stop is too busy to listen), and they belong in a view built for
-- that question rather than smuggled into two that answer different ones.
-- -----------------------------------------------------------------------------

COMMENT ON CONSTRAINT telemetry_events_event_type_check ON public.telemetry_events IS
    'Closed event vocabulary. The mobile client mirrors this union in mobile/src/services/telemetry/types.ts - widening one without the other means events that queue locally and can never be delivered.';
