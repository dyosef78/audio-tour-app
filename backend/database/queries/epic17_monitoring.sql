-- =============================================================================
-- Epic 17 production monitoring - Supabase SQL Editor (runs as postgres).
-- Window: last 30 days; change the interval to taste.
--
-- Process restarts travel as tour_resumed WITH meta.reason (no migration).
-- The engine's own idle resume is tour_resumed WITHOUT a reason - filter on
-- reason, or the two are counted together.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. How often a tour's process dies mid-tour (the Maps-era OOM concern), and
--    how it came back.
--    origin  background_task  Android restored the task headless
--            cold_start       the visitor reopened the app
--            start            a screen's Start found the saved walk first
--    task_adopted  Android only: the restored task was kept - it may have no
--                  foreground service until the next return to the app (2).
-- -----------------------------------------------------------------------------
SELECT
    date_trunc('day', occurred_at)                             AS day,
    platform,
    meta->>'origin'                                            AS origin,
    count(*)                                                   AS restarts,
    count(*) FILTER (WHERE (meta->>'task_adopted')::boolean)   AS task_adopted,
    count(*) FILTER (WHERE (meta->>'suspended')::boolean)      AS were_paused
FROM public.telemetry_events
WHERE event_type = 'tour_resumed'
  AND meta->>'reason' = 'process_restart'
  AND occurred_at > now() - interval '30 days'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;

-- -----------------------------------------------------------------------------
-- 2. Android foreground-service re-acquisition (Option A, PM 11 Oct 2026).
--    reacquired  re-registered on return to the app; background tracking whole
--    refused     the OS still refused; retried on the next return
--    A device with task_adopted in (1) and no reacquired here never came back
--    to the app during the tour: its tracking stayed throttled to the end.
-- -----------------------------------------------------------------------------
SELECT
    date_trunc('day', occurred_at)                                AS day,
    count(*) FILTER (WHERE meta->>'outcome' = 'reacquired')       AS reacquired,
    count(*) FILTER (WHERE meta->>'outcome' = 'refused')          AS refused,
    count(DISTINCT device_id)                                     AS devices
FROM public.telemetry_events
WHERE event_type = 'tour_resumed'
  AND meta->>'reason' = 'foreground_service'
  AND occurred_at > now() - interval '30 days'
GROUP BY 1
ORDER BY 1 DESC;
