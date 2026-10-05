-- =============================================================================
-- Epic 16: the navigation_handoff baseline event
--
-- STATUS: approved by the PM 6 Oct 2026. Push BEFORE any build with
-- TELEMETRY_HANDOFF_EVENT_LIVE = true (mobile/src/config/features.ts): an
-- event type the CHECK lacks fails its whole all-or-nothing batch.
--
-- WHY. handoff_tracking_late records only what went wrong (late / lost /
-- recovered). Without a row for every handoff there is no denominator, so no
-- failure RATE - only counts. navigation_handoff is written each time the app
-- opens Google Maps or Waze, with:
--   meta.wait       'settled' (tracking restart done first) | 'timed_out'
--                   (the 1.5 s optimistic bound fired; a late/lost may follow)
--   meta.waited_ms  how long the handoff waited for tracking
--   meta.provider   'google_maps' | 'waze'
--   meta.mode       the chapter's transit mode
--   meta.segment    'transfer' (a planned travel segment) | 'chapter'
--
-- WHAT THIS DOES TO EXISTING DATA: replaces the CHECK with a superset; its
-- validation scan passes every stored row.
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
        'trigger_reanchored',
        'trigger_rejected_bearing',
        'trigger_expired',
        'trigger_missed',
        'audio_watchdog',
        'tour_suspended',
        'tour_resumed',
        'chapter_arrived',
        'handoff_tracking_late',
        -- NEW (Epic 16 cleanup).
        'navigation_handoff'
    ));

COMMENT ON CONSTRAINT telemetry_events_event_type_check ON public.telemetry_events IS
    'Closed event vocabulary. The mobile client mirrors this union in mobile/src/services/telemetry/types.ts (test-cms pins the two) - widening one without the other means events that queue locally and can never be delivered. Push a widening BEFORE shipping a client that sends the new types.';
