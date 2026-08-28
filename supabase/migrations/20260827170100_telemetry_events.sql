-- =============================================================================
-- TASK-304 (2 of 2) : Telemetry
--
-- STATUS: APPROVED and applied to the linked project (TASK-507).
--
-- Insert-only event log, keyed by a client-generated device UUID rather than by
-- auth context. That is the right call for an offline-first app - events are
-- queued on a phone with no connection and flushed hours or days later, long
-- after any session would have expired, and a tourist who never signs in still
-- generates the KPIs we care about.
--
-- IT ALSO MEANS THIS DATA IS UNAUTHENTICATED.
--
-- device_id is whatever the client says it is. Anyone holding the anon key -
-- which ships in the app - can post arbitrary events under any device id they
-- invent. That is acceptable for product KPIs and unacceptable for anything
-- that must be trusted. Do not bill on it, do not pay partners from it, and do
-- not use it as evidence of anything. See the handover report for the
-- mitigations that are in here and the ones that are not.
--
-- KPIs this is shaped to answer:
--   Audio Completion Rate  - completed / started, per waypoint and per tour
--   Skip / Drop-off Rate   - skipped / started, and where in the track people
--                            stop
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. The table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_events (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Idempotency. An offline queue that retries WILL deliver duplicates: the
    -- request succeeds, the response is lost, the client retries. Without a
    -- client-side event id there is no way to tell a retry from a genuine
    -- second play, and every KPI inflates by the flakiness of the network -
    -- worst exactly where reception is poor, which is where tours happen.
    client_event_id  uuid NOT NULL,

    device_id        uuid NOT NULL,

    event_type       text NOT NULL,

    -- ON DELETE SET NULL, not CASCADE: deleting a waypoint must not silently
    -- rewrite history. The FKs also mean an event cannot name content that does
    -- not exist, which filters out most casual junk.
    tour_id          uuid REFERENCES public.tours(id)        ON DELETE SET NULL,
    waypoint_id      uuid REFERENCES public.waypoints(id)    ON DELETE SET NULL,
    audio_track_id   uuid REFERENCES public.audio_tracks(id) ON DELETE SET NULL,

    -- Drop-off maths. position_seconds is where playback stopped;
    -- track_seconds is how long the track was at the time, denormalised on
    -- purpose so a re-cut track does not retroactively change past events.
    position_seconds numeric(10,2),
    track_seconds    numeric(10,2),

    -- TWO CLOCKS, DELIBERATELY.
    --   occurred_at - the device's clock, when it happened
    --   received_at - the server's clock, when it arrived
    -- Events may arrive days late, and device clocks are wrong often enough to
    -- matter (manual time changes, dead batteries, timezone bugs). Reporting on
    -- occurred_at alone produces events "before" the tour existed; on
    -- received_at alone it smears a whole tour into the moment someone found
    -- WiFi. Store both and let the analysis choose.
    occurred_at      timestamptz NOT NULL,
    received_at      timestamptz NOT NULL DEFAULT now(),

    app_version      text,
    platform         text,
    meta             jsonb,

    CONSTRAINT telemetry_events_event_type_check CHECK (event_type IN (
        'tour_started',
        'tour_completed',
        'bundle_downloaded',
        'geofence_entered',
        'audio_started',
        'audio_completed',
        'audio_skipped',
        'audio_stopped'
    )),
    CONSTRAINT telemetry_events_platform_check CHECK (
        platform IS NULL OR platform IN ('ios', 'android')),
    CONSTRAINT telemetry_events_position_check CHECK (
        position_seconds IS NULL OR position_seconds >= 0),
    CONSTRAINT telemetry_events_track_seconds_check CHECK (
        track_seconds IS NULL OR track_seconds > 0),
    -- Bounds the damage a bad device clock can do. A year of slack in either
    -- direction still lets a genuinely stale offline queue through.
    CONSTRAINT telemetry_events_occurred_at_sane CHECK (
        occurred_at > timestamptz '2026-01-01'
        AND occurred_at < now() + interval '1 year'),
    CONSTRAINT telemetry_events_meta_size CHECK (
        meta IS NULL OR length(meta::text) <= 2048)
);

COMMENT ON TABLE public.telemetry_events IS
    'Append-only product analytics keyed by a client-generated device UUID. UNAUTHENTICATED: device_id is self-asserted and anyone with the anon key can post events. Good enough for KPIs, not evidence of anything.';

-- The idempotency key. ON CONFLICT (client_event_id) DO NOTHING on the client
-- side turns a retry into a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_events_client_event_id_key
    ON public.telemetry_events (client_event_id);

-- The KPI access path: group by tour and event type over a time window.
CREATE INDEX IF NOT EXISTS idx_telemetry_tour_event_time
    ON public.telemetry_events (tour_id, event_type, occurred_at);

-- Funnel work joins started/completed/skipped for the same waypoint.
CREATE INDEX IF NOT EXISTS idx_telemetry_waypoint_event
    ON public.telemetry_events (waypoint_id, event_type);

-- Retention sweeps and "what arrived today" both scan on arrival order.
CREATE INDEX IF NOT EXISTS idx_telemetry_received_at
    ON public.telemetry_events (received_at);

-- -----------------------------------------------------------------------------
-- 2. RLS - insert-only for everyone, read for admins
--
-- Writers get INSERT and nothing else. With no SELECT policy for anon, a client
-- can write events and can never read them back - so the table cannot be used
-- to enumerate other people's behaviour, and a leaked anon key buys the holder
-- write-only noise.
--
-- POSTGREST GOTCHA WORTH KNOWING: an INSERT that asks for the inserted row back
-- needs SELECT as well, and there is deliberately no SELECT policy here. The
-- client must not chain .select() on the insert; supabase-js already defaults
-- to returning nothing, so the default path is correct and the mistake is
-- adding .select() rather than omitting it.
--
-- Admins can read, or the data would be write-only in the useless sense.
-- -----------------------------------------------------------------------------
ALTER TABLE public.telemetry_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "telemetry_insert_any_client"
    ON public.telemetry_events FOR INSERT
    TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "telemetry_admin_read"
    ON public.telemetry_events FOR SELECT
    TO authenticated
    USING ((SELECT public.is_cms_admin()));

-- No UPDATE or DELETE policy for anyone. Append-only is a property worth having
-- in the schema rather than in a convention: nobody can quietly revise history,
-- and retention sweeps run as service_role, which bypasses RLS.
REVOKE UPDATE, DELETE ON public.telemetry_events FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. KPI views
--
-- security_invoker = true is load-bearing. Views default to running with the
-- OWNER's privileges, which would bypass the RLS above and hand every signed-in
-- tourist the complete analytics set. With security_invoker the telemetry
-- policies apply, so these resolve to "admins only" exactly like the table.
--
-- Completion is counted per (device, waypoint) rather than per event, so that
-- someone replaying a track five times does not read as five completions of a
-- one-completion waypoint.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_kpi_audio_completion
WITH (security_invoker = true) AS
SELECT
    e.tour_id,
    t.title AS tour_title,
    e.waypoint_id,
    w.name  AS waypoint_name,
    w.sort_order,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started')   AS devices_started,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_completed') AS devices_completed,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_skipped')   AS devices_skipped,
    round(
        count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_completed')::numeric
        / nullif(count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started'), 0)
    , 4) AS completion_rate,
    round(
        count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_skipped')::numeric
        / nullif(count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started'), 0)
    , 4) AS skip_rate
FROM public.telemetry_events e
LEFT JOIN public.tours t     ON t.id = e.tour_id
LEFT JOIN public.waypoints w ON w.id = e.waypoint_id
WHERE e.event_type IN ('audio_started', 'audio_completed', 'audio_skipped')
GROUP BY e.tour_id, t.title, e.waypoint_id, w.name, w.sort_order;

COMMENT ON VIEW public.v_kpi_audio_completion IS
    'Audio Completion Rate and Skip Rate per waypoint. Counts distinct devices, not events, so a replay is not a second completion. security_invoker = true, so it is admin-only like the underlying table.';

-- Where people actually stop. Averaging the raw position would make long tracks
-- look better than short ones, so this works in fraction-of-track.
CREATE OR REPLACE VIEW public.v_kpi_audio_dropoff
WITH (security_invoker = true) AS
SELECT
    e.tour_id,
    t.title AS tour_title,
    e.waypoint_id,
    w.name  AS waypoint_name,
    count(*)                                       AS stop_events,
    round(avg(e.position_seconds / e.track_seconds), 4) AS avg_progress_at_stop,
    round(percentile_cont(0.5) WITHIN GROUP (
              ORDER BY e.position_seconds / e.track_seconds)::numeric, 4) AS median_progress_at_stop,
    -- Stopping in the first 10% is a different behaviour from drifting off near
    -- the end: it usually means the wrong track fired, or the audio did not
    -- start. Worth separating rather than averaging away.
    count(*) FILTER (WHERE e.position_seconds / e.track_seconds < 0.1) AS abandoned_early
FROM public.telemetry_events e
LEFT JOIN public.tours t     ON t.id = e.tour_id
LEFT JOIN public.waypoints w ON w.id = e.waypoint_id
WHERE e.event_type IN ('audio_stopped', 'audio_skipped')
  AND e.position_seconds IS NOT NULL
  AND e.track_seconds IS NOT NULL
  AND e.track_seconds > 0
GROUP BY e.tour_id, t.title, e.waypoint_id, w.name;

COMMENT ON VIEW public.v_kpi_audio_dropoff IS
    'Where playback stops, as a fraction of track length so long and short tracks compare. abandoned_early (under 10%) is separated because it usually means the wrong track fired rather than genuine drop-off.';

GRANT SELECT ON public.v_kpi_audio_completion TO authenticated;
GRANT SELECT ON public.v_kpi_audio_dropoff    TO authenticated;
