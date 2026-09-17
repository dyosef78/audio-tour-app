-- =============================================================================
-- TASK-1001 - Rate limiting for route-stops ("The Shield")
--
-- STATUS: DRAFT - awaiting PM approval. Do not push.
--
-- WHY THE STATE LIVES IN POSTGRES, NOT IN THE FUNCTION
--
-- Hosted Edge Functions spread requests across isolates: route-stops' memory
-- cache hit 1 request in 6 when it was measured on 17 Sep 2026. A counter kept
-- in isolate memory has the same problem. Six isolates each allowing N
-- requests is a limit of 6N that moves as the platform scales. The count has
-- to be shared, and Postgres is the one shared store the function already
-- reaches with the service role. There is no Redis in this stack, and adding
-- one for a single counter is not "lightweight".
--
-- ALGORITHM - TOKEN BUCKET
--
-- Each bucket holds up to `capacity` tokens (the burst) and refills at
-- `refill_per_second`. A request spends one token from EVERY bucket it names,
-- or from none of them:
--
--   * route-stops names two: one per client IP (the abuser) and one global
--     (the provider budget, which rotating IPs cannot get around).
--   * All-or-nothing, so a request refused by its IP bucket does not drain the
--     global bucket. Otherwise one abuser could exhaust the budget for everyone
--     with requests that were refused anyway.
--
-- A bucket is stored as (tokens, updated_at) and refilled lazily when it is
-- read. No timer or job keeps it running.
--
-- WHAT THIS MIGRATION DOES TO EXISTING DATA: nothing. One empty table and one
-- function. get_tour_bundle and the bundle hash do not read either, and no
-- seed file needs a row.
--
-- ACCESS - SERVICE ROLE ONLY
--
-- Same reasoning as route_legs_cache. If anon could call this function, anyone
-- could drain the global bucket or reset their own. `TO authenticated` would be
-- a public grant, because Google sign-in is open. RLS is on, with no policies.
--
-- UNLOGGED, ON PURPOSE
--
-- The rows are short-lived counters, not records. UNLOGGED skips WAL for a
-- write on every route request. A crash truncates the table, which leaves every
-- bucket full: a few seconds of looser limiting, and nothing lost that
-- mattered.
--
-- FOLLOW-UP REQUIRED AFTER PUSHING
--
--   npm run types:generate   (backend/types/supabase.ts was hand-edited to match)
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------
CREATE UNLOGGED TABLE IF NOT EXISTS public.rate_limit_buckets (
    -- `route-stops:ip:<hmac>` or `route-stops:global`. The IP is HMACed by the
    -- function before it gets here, so no raw address is ever stored.
    bucket_key  text             PRIMARY KEY
                                 CONSTRAINT rate_limit_buckets_key_length_check
                                 CHECK (char_length(bucket_key) BETWEEN 1 AND 128),
    tokens      double precision NOT NULL,
    updated_at  timestamptz      NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.rate_limit_buckets IS
    'TASK-1001: token buckets for Edge Function rate limiting. Service role only. UNLOGGED: a crash leaves every bucket full.';

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limit_buckets TO service_role;

-- -----------------------------------------------------------------------------
-- 2. consume_rate_limit
--
-- Returns { allowed, retry_after_seconds, remaining, exhausted[] }:
--   retry_after_seconds  0 when allowed; otherwise the time until EVERY
--                        exhausted bucket holds a token again
--   remaining            whole tokens left in the emptiest bucket
--   exhausted            the keys that refused the request
--
-- SECURITY INVOKER. Only service_role may execute it, and service_role already
-- has the table privileges above, so it needs no elevation.
--
-- CONCURRENCY. Rows are locked in key order, so two requests that share buckets
-- cannot deadlock. The INSERT ... ON CONFLICT DO NOTHING waits for an
-- uncommitted insert of the same key, so the locking SELECT always finds the
-- row. The clock is read AFTER the locks are held. Read before, a request that
-- queued behind another would refill from a timestamp older than the one it is
-- about to overwrite.
--
-- HOUSEKEEPING. One call in a hundred deletes buckets idle for a day. That loses
-- nothing: a refill time over a day is refused below, so a bucket idle that
-- long is full, and a missing row is created full.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
    p_keys              text[],
    p_capacities        double precision[],
    p_refill_per_second double precision[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_n          integer := coalesce(array_length(p_keys, 1), 0);
    v_now        timestamptz;
    v_keys       text[] := '{}';
    v_levels     double precision[] := '{}';
    v_allowed    boolean := true;
    v_retry      double precision := 0;
    v_exhausted  text[] := '{}';
    v_remaining  double precision;
    v_level      double precision;
    r            record;
BEGIN
    IF v_n = 0 OR v_n > 4
       OR coalesce(array_length(p_capacities, 1), 0) <> v_n
       OR coalesce(array_length(p_refill_per_second, 1), 0) <> v_n THEN
        RAISE EXCEPTION 'consume_rate_limit: pass 1 to 4 keys, each with a capacity and a refill rate.'
            USING ERRCODE = '22023';
    END IF;

    IF (SELECT count(DISTINCT k) FROM unnest(p_keys) AS k) <> v_n THEN
        RAISE EXCEPTION 'consume_rate_limit: keys must not repeat.' USING ERRCODE = '22023';
    END IF;

    FOR i IN 1 .. v_n LOOP
        IF p_keys[i] IS NULL OR char_length(p_keys[i]) NOT BETWEEN 1 AND 128
           OR p_capacities[i] IS NULL OR p_capacities[i] < 1
           OR p_refill_per_second[i] IS NULL OR p_refill_per_second[i] <= 0
           -- Bounds the refill time, which is what makes housekeeping lossless.
           OR p_capacities[i] / p_refill_per_second[i] > 86400 THEN
            RAISE EXCEPTION 'consume_rate_limit: bucket % needs a 1-128 character key, capacity >= 1 and a refill rate that fills it within a day.', i
                USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- New buckets start full.
    INSERT INTO public.rate_limit_buckets (bucket_key, tokens, updated_at)
    SELECT u.k, u.c, clock_timestamp()
      FROM unnest(p_keys, p_capacities) AS u(k, c)
     ORDER BY u.k
    ON CONFLICT (bucket_key) DO NOTHING;

    PERFORM 1
       FROM public.rate_limit_buckets b
      WHERE b.bucket_key = ANY (p_keys)
      ORDER BY b.bucket_key
        FOR UPDATE;

    v_now := clock_timestamp();

    FOR r IN
        SELECT b.bucket_key, b.tokens, b.updated_at, u.capacity, u.refill
          FROM unnest(p_keys, p_capacities, p_refill_per_second) AS u(k, capacity, refill)
          JOIN public.rate_limit_buckets b ON b.bucket_key = u.k
         ORDER BY b.bucket_key
    LOOP
        v_level := least(
            r.capacity,
            r.tokens + greatest(0, extract(epoch FROM v_now - r.updated_at)) * r.refill
        );
        IF v_level < 1 THEN
            v_allowed   := false;
            v_exhausted := v_exhausted || r.bucket_key;
            v_retry     := greatest(v_retry, (1 - v_level) / r.refill);
        END IF;
        v_keys   := v_keys || r.bucket_key;
        v_levels := v_levels || v_level;
    END LOOP;

    FOR i IN 1 .. coalesce(array_length(v_keys, 1), 0) LOOP
        v_level := v_levels[i] - CASE WHEN v_allowed THEN 1 ELSE 0 END;
        UPDATE public.rate_limit_buckets
           SET tokens = v_level, updated_at = v_now
         WHERE bucket_key = v_keys[i];
        v_remaining := least(coalesce(v_remaining, v_level), v_level);
    END LOOP;

    IF random() < 0.01 THEN
        DELETE FROM public.rate_limit_buckets
         WHERE bucket_key IN (
               SELECT bucket_key
                 FROM public.rate_limit_buckets
                WHERE updated_at < v_now - interval '1 day'
                LIMIT 1000
                  FOR UPDATE SKIP LOCKED);
    END IF;

    RETURN jsonb_build_object(
        'allowed', v_allowed,
        'retry_after_seconds', CASE WHEN v_allowed THEN 0 ELSE ceil(v_retry)::integer END,
        'remaining', greatest(0, floor(coalesce(v_remaining, 0)))::integer,
        'exhausted', to_jsonb(v_exhausted)
    );
END;
$fn$;

COMMENT ON FUNCTION public.consume_rate_limit(text[], double precision[], double precision[]) IS
    'TASK-1001: spend one token from every named bucket, or from none. Returns {allowed, retry_after_seconds, remaining, exhausted}. Service role only.';

REVOKE ALL ON FUNCTION public.consume_rate_limit(text[], double precision[], double precision[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(text[], double precision[], double precision[])
    TO service_role;
