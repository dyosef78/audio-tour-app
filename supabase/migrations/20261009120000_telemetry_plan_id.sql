-- =============================================================================
-- Epic 16: telemetry_events.plan_id, and the handoff_tracking_late event
--
-- STATUS: approved by the PM 5 Oct 2026 (plan_id: "nullable UUID column
-- without a foreign key"). NOT APPLIED. Push BEFORE shipping a build with
-- TELEMETRY_PLAN_FIELDS_LIVE = true (mobile/src/config/features.ts): a row
-- naming a column or an event type the server lacks is refused, and the
-- client posts in all-or-nothing batches - one refused row fails every event
-- queued with it, on every retry.
--
-- plan_id: which plan a planned session's events belong to (tour_plans.id).
--   NO FOREIGN KEY, deliberately: tour_plans rows are deleted after 30 days
--   (Epic 16 retention) and telemetry outlives them. A FK with ON DELETE SET
--   NULL would erase the attribution the column exists for; a FK without it
--   would block the retention purge. Unverified by design - like device_id,
--   it is a self-asserted label, never an authorisation input.
--   tour_id keeps meaning "the tour that owns this stop": in a plan it is the
--   stop's own tour, and NULL for events in a travel segment.
--
-- handoff_tracking_late: the optimistic navigation handoff (PM, 5 Oct 2026)
--   opened Google Maps before the tracking restart finished. meta.outcome:
--   'late' (restarted after Maps opened), 'lost' (the OS refused it in the
--   background - no tracking until the visitor came back) or 'recovered'
--   (restarted on that return). How often the accepted trade-off bites.
--
-- WHAT THIS DOES TO EXISTING DATA: adds a NULL column (no rewrite) and
-- replaces the event-type CHECK with a superset, whose validation scan passes
-- every stored row. Policies unchanged: telemetry_insert_any_client is
-- WITH CHECK (true); admins still read through telemetry_admin_read. KPI
-- views name their columns, so they are unchanged.
-- =============================================================================

SET search_path = public, extensions;

ALTER TABLE public.telemetry_events
    ADD COLUMN IF NOT EXISTS plan_id uuid;

COMMENT ON COLUMN public.telemetry_events.plan_id IS
    'tour_plans.id of the planned session this event came from; NULL for catalogue sessions and app-level events. No foreign key: plans are purged after 30 days, telemetry is kept (migration 20261009120000).';

CREATE INDEX IF NOT EXISTS telemetry_events_plan_idx
    ON public.telemetry_events (plan_id, event_type, occurred_at)
    WHERE plan_id IS NOT NULL;

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
        'trigger_reanchored',
        'trigger_rejected_bearing',
        'trigger_expired',
        'trigger_missed',
        'audio_watchdog',
        'tour_suspended',
        'tour_resumed',
        'chapter_arrived',
        -- NEW (Epic 16).
        'handoff_tracking_late'
    ));

COMMENT ON CONSTRAINT telemetry_events_event_type_check ON public.telemetry_events IS
    'Closed event vocabulary. The mobile client mirrors this union in mobile/src/services/telemetry/types.ts (test-cms pins the two) - widening one without the other means events that queue locally and can never be delivered. Push a widening BEFORE shipping a client that sends the new types.';
