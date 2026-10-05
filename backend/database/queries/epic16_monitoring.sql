-- =============================================================================
-- Epic 16 production monitoring - Supabase SQL Editor (runs as postgres).
-- Window: last 30 days; change the interval to taste. Device clocks drive
-- occurred_at; received_at is the server's.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1a. Optimistic-handoff outcomes per day, platform and session kind.
--     late      tracking restart finished after Maps opened (meta.waited_ms)
--     lost      the OS refused the restart in the background: tracking OFF
--     recovered tracking restarted when the visitor came back to the app
-- -----------------------------------------------------------------------------
SELECT
    date_trunc('day', occurred_at)                                   AS day,
    platform,
    CASE WHEN plan_id IS NULL THEN 'catalogue' ELSE 'planned' END   AS session,
    count(*) FILTER (WHERE meta->>'outcome' = 'late')                AS late,
    count(*) FILTER (WHERE meta->>'outcome' = 'lost')                AS lost,
    count(*) FILTER (WHERE meta->>'outcome' = 'recovered')           AS recovered,
    round(avg((meta->>'waited_ms')::numeric) FILTER (WHERE meta->>'outcome' = 'late') / 1000, 1) AS late_avg_s
FROM public.telemetry_events
WHERE event_type = 'handoff_tracking_late'
  AND occurred_at > now() - interval '30 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

-- -----------------------------------------------------------------------------
-- 1b. EXACT handoff health (navigation_handoff, migration 20261010120100;
--     builds with TELEMETRY_HANDOFF_EVENT_LIVE). One navigation_handoff row
--     per opened Maps/Waze; meta.wait = 'timed_out' when the 1.5 s optimistic
--     bound fired.
-- -----------------------------------------------------------------------------
WITH hand AS (
    SELECT platform,
           CASE WHEN plan_id IS NULL THEN 'catalogue' ELSE 'planned' END AS session,
           count(*)                                                AS handoffs,
           count(*) FILTER (WHERE meta->>'wait' = 'timed_out')     AS optimistic,
           round(avg((meta->>'waited_ms')::numeric))               AS avg_wait_ms,
           round((percentile_cont(0.95) WITHIN GROUP (ORDER BY (meta->>'waited_ms')::numeric))::numeric) AS p95_wait_ms
    FROM public.telemetry_events
    WHERE event_type = 'navigation_handoff' AND occurred_at > now() - interval '30 days'
    GROUP BY 1, 2
), issues AS (
    SELECT platform,
           CASE WHEN plan_id IS NULL THEN 'catalogue' ELSE 'planned' END AS session,
           count(*) FILTER (WHERE meta->>'outcome' = 'late') AS late,
           count(*) FILTER (WHERE meta->>'outcome' = 'lost') AS lost
    FROM public.telemetry_events
    WHERE event_type = 'handoff_tracking_late' AND occurred_at > now() - interval '30 days'
    GROUP BY 1, 2
)
SELECT h.platform, h.session, h.handoffs, h.optimistic, h.avg_wait_ms, h.p95_wait_ms,
       coalesce(i.late, 0)                                                   AS late,
       coalesce(i.lost, 0)                                                   AS lost,
       round(100.0 * h.optimistic / nullif(h.handoffs, 0), 2)                AS optimistic_pct,
       round(100.0 * coalesce(i.lost, 0) / nullif(h.handoffs, 0), 2)         AS lost_pct,
       round(100.0 * (h.handoffs - coalesce(i.lost, 0)) / nullif(h.handoffs, 0), 2) AS tracked_pct
FROM hand h
LEFT JOIN issues i USING (platform, session)
ORDER BY h.platform, h.session;

-- -----------------------------------------------------------------------------
-- 1b'. Each TIMED-OUT handoff and how its tracking restart ended: the first
--      late/lost of the same device within 10 minutes. 'none' = the restart
--      finished in the background without incident, or the app was killed.
-- -----------------------------------------------------------------------------
WITH t AS (
    SELECT device_id, platform, occurred_at
    FROM public.telemetry_events
    WHERE event_type = 'navigation_handoff' AND meta->>'wait' = 'timed_out'
      AND occurred_at > now() - interval '30 days'
), o AS (
    SELECT device_id, occurred_at, meta->>'outcome' AS outcome
    FROM public.telemetry_events
    WHERE event_type = 'handoff_tracking_late' AND meta->>'outcome' IN ('late', 'lost')
)
SELECT t.platform,
       count(*)                                        AS timed_out,
       count(*) FILTER (WHERE x.outcome = 'late')      AS ended_late,
       count(*) FILTER (WHERE x.outcome = 'lost')      AS ended_lost,
       count(*) FILTER (WHERE x.outcome IS NULL)       AS ended_none
FROM t
LEFT JOIN LATERAL (
    SELECT o.outcome FROM o
    WHERE o.device_id = t.device_id
      AND o.occurred_at >= t.occurred_at
      AND o.occurred_at < t.occurred_at + interval '10 minutes'
    ORDER BY o.occurred_at
    LIMIT 1
) x ON true
GROUP BY t.platform
ORDER BY t.platform;

-- -----------------------------------------------------------------------------
-- 1c. Planned sessions: travel segments planned vs arrivals detected, per
--     plan (plans are purged after 30 days, so only recent plans join). A
--     shortfall is not proof of failure - visitors stop early - but a plan
--     with handoff_tracking_late AND missing arrivals is worth a look.
-- -----------------------------------------------------------------------------
SELECT
    p.id                                                             AS plan_id,
    p.planner_version,
    (SELECT count(*) FROM jsonb_array_elements(p.plan->'segments') s WHERE s->>'kind' = 'transfer') AS transfers_planned,
    count(e.*) FILTER (WHERE e.event_type = 'chapter_arrived')       AS arrivals_detected,
    count(e.*) FILTER (WHERE e.event_type = 'handoff_tracking_late') AS handoff_issues,
    min(e.occurred_at)                                               AS first_event
FROM public.tour_plans p
JOIN public.telemetry_events e ON e.plan_id = p.id
WHERE e.occurred_at > now() - interval '30 days'
GROUP BY p.id, p.planner_version, p.plan
ORDER BY first_event DESC;

-- -----------------------------------------------------------------------------
-- 2. Android: how long tracking stayed OFF after a refused restart.
--    Each 'lost' is paired with the NEXT handoff event of the same device;
--    it recovered iff that next event is 'recovered'. Recovery happens on
--    the visitor's return to the app, so this measures time-without-
--    tracking, not service start latency (that is 1a's late_avg_s).
-- -----------------------------------------------------------------------------
WITH h AS (
    SELECT device_id, plan_id, occurred_at, meta->>'outcome' AS outcome
    FROM public.telemetry_events
    WHERE event_type = 'handoff_tracking_late'
      AND platform = 'android'
      AND meta->>'outcome' IN ('lost', 'recovered')
      AND occurred_at > now() - interval '30 days'
), seq AS (
    SELECT *,
           lead(outcome)     OVER w AS next_outcome,
           lead(occurred_at) OVER w AS next_at
    FROM h
    WINDOW w AS (PARTITION BY device_id ORDER BY occurred_at)
), losses AS (
    SELECT plan_id,
           CASE WHEN next_outcome = 'recovered' THEN extract(epoch FROM next_at - occurred_at) END AS off_s
    FROM seq
    WHERE outcome = 'lost'
)
SELECT
    count(*)                                                         AS losses,
    count(off_s)                                                     AS recovered,
    count(*) - count(off_s)                                          AS not_recovered_yet,
    round(avg(off_s)::numeric, 1)                                    AS avg_off_s,
    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY off_s))::numeric, 1) AS median_off_s,
    round((percentile_cont(0.9) WITHIN GROUP (ORDER BY off_s))::numeric, 1) AS p90_off_s,
    count(*) FILTER (WHERE plan_id IS NOT NULL)                      AS in_planned_sessions
FROM losses;

-- -----------------------------------------------------------------------------
-- 3a. Option E in production: silent stops fired per day (planned sessions).
--     The engine records a silent zone entry as geofence_entered with
--     meta.silent = 1 (a number), and plays nothing.
-- -----------------------------------------------------------------------------
SELECT
    date_trunc('day', occurred_at)                                   AS day,
    count(*) FILTER (WHERE meta->>'silent' = '1')                    AS silent_stops,
    count(*)                                                         AS stops_fired_in_plans,
    round(100.0 * count(*) FILTER (WHERE meta->>'silent' = '1') / nullif(count(*), 0), 2) AS silent_pct,
    count(DISTINCT plan_id) FILTER (WHERE meta->>'silent' = '1')     AS plans_with_a_silent_stop
FROM public.telemetry_events
WHERE event_type = 'geofence_entered'
  AND plan_id IS NOT NULL
  AND occurred_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;

-- -----------------------------------------------------------------------------
-- 3b. Planner vs device: silent stops PLANNED (tour_plans) vs silent stops
--     FIRED (telemetry), for plans that were walked. Fired <= planned; a
--     fired silent stop the planner never listed would be a bug.
-- -----------------------------------------------------------------------------
WITH planned AS (
    SELECT p.id AS plan_id, sid.value #>> '{}' AS waypoint_id
    FROM public.tour_plans p,
         jsonb_array_elements(p.plan->'segments') seg,
         jsonb_array_elements(coalesce(seg->'silent_stop_ids', '[]'::jsonb)) sid
    WHERE seg->>'kind' = 'chapter'
), fired AS (
    SELECT DISTINCT plan_id, waypoint_id::text AS waypoint_id
    FROM public.telemetry_events
    WHERE event_type = 'geofence_entered' AND meta->>'silent' = '1' AND plan_id IS NOT NULL
)
SELECT
    (SELECT count(*) FROM planned WHERE plan_id IN (SELECT plan_id FROM fired)) AS planned_in_walked_plans,
    (SELECT count(*) FROM fired)                                                AS fired,
    (SELECT count(*) FROM fired f WHERE NOT EXISTS (
        SELECT 1 FROM planned p WHERE p.plan_id = f.plan_id AND p.waypoint_id = f.waypoint_id)) AS fired_but_not_planned_MUST_BE_0;

-- -----------------------------------------------------------------------------
-- 3c. Silence means silence: audio for a stop that fired silently, in the
--     same plan on the same device. Expected 0 - except a visitor who taps
--     the stop's play button (a manual play is allowed; check meta if > 0).
-- -----------------------------------------------------------------------------
SELECT count(*) AS audio_events_on_silent_stops
FROM public.telemetry_events a
JOIN public.telemetry_events g
  ON g.plan_id = a.plan_id AND g.device_id = a.device_id AND g.waypoint_id = a.waypoint_id
WHERE g.event_type = 'geofence_entered' AND g.meta->>'silent' = '1'
  AND a.event_type IN ('audio_started', 'audio_completed')
  AND a.occurred_at > now() - interval '30 days';
