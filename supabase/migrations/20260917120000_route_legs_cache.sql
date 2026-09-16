-- =============================================================================
-- TASK-801 - Segment-based route cache (route_legs_cache) and its invalidation
--
-- STATUS: APPROVED 17 Sep 2026 (PM, Epic 8 close). Safe to push.
--
-- WHY LEGS, NOT ROUTES
--
-- route-stops' per-isolate memory cache hits ~1 request in 6 on hosted Supabase
-- (measured 17 Sep 2026): requests fan out across isolates that each start
-- empty. A durable cache fixes that, and caching HOPS rather than whole routes
-- lets two visitors who picked different stop subsets, or whose Smart Sorter
-- produced different orders, still share every pair of consecutive stops they
-- have in common.
--
-- WHAT THIS MIGRATION DOES TO EXISTING DATA: nothing. It adds one empty table,
-- one function and two triggers. The bundle hash is untouched (the table is not
-- read by get_tour_bundle), and no seed file needs a row.
--
-- ACCESS - NOBODY BUT THE EDGE FUNCTION'S SERVICE ROLE
--
-- A cached leg is served to every visitor of the tour, so a writable cache is a
-- route-poisoning primitive: one forged polyline, drawn on every phone for 14
-- days. `TO authenticated` would be a public grant (anyone can sign in with
-- Google), so anon and authenticated get NO privileges and there are no
-- policies. RLS is still enabled so an accidental GRANT exposes nothing.
-- route-stops authorises the caller through get_tour_bundle (RLS, as the
-- caller) BEFORE it touches this table with the service role.
--
-- INVALIDATION - TWO LAYERS, ON PURPOSE
--
--   1. Triggers (below) delete a waypoint's legs the moment its location or
--      tags change, and a tour's legs when its status or transit mode changes.
--   2. coords_key: each row records the exact coordinates it was routed
--      between, and route-stops ignores a row whose coordinates no longer match
--      the bundle it just loaded. This is what closes the race the trigger
--      cannot: a request loads the OLD location, the CMS moves the stop and the
--      trigger deletes the leg, and the request's background write then lands
--      a leg for the old location. Without (2) that stale leg would be served
--      for 14 days.
--
-- The 14-day TTL is enforced by the reader (route-stops), not here.
--
-- FOLLOW-UP REQUIRED AFTER PUSHING
--
--   npm run types:generate   (backend/types/supabase.ts was hand-edited to match)
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_legs_cache (
    -- ON DELETE CASCADE: a deleted stop's legs go with it, including when
    -- cms_replace_tour_waypoints drops stops omitted from a Save.
    start_poi_id     uuid        NOT NULL REFERENCES public.waypoints(id) ON DELETE CASCADE,
    end_poi_id       uuid        NOT NULL REFERENCES public.waypoints(id) ON DELETE CASCADE,
    -- Valhalla costing, not transit_mode: it is what the geometry depends on.
    profile          text        NOT NULL,
    -- Precision 6, this hop only. Its first point repeats the previous hop's
    -- last; route-stops joins legs with joinLegPolylines().
    polyline         text        NOT NULL,
    distance_meters  integer     NOT NULL,
    duration_seconds integer     NOT NULL,
    -- "lon,lat;lon,lat" to 6 decimals, the coordinates this hop was routed
    -- between. See INVALIDATION (2) above.
    coords_key       text        NOT NULL,
    updated_at       timestamptz NOT NULL DEFAULT now(),

    -- Directional: A->B and B->A differ wherever there are one-way streets.
    PRIMARY KEY (start_poi_id, end_poi_id, profile),

    CONSTRAINT route_legs_cache_profile_check
        CHECK (profile IN ('pedestrian', 'bicycle', 'auto')),
    CONSTRAINT route_legs_cache_distinct_stops_check
        CHECK (start_poi_id <> end_poi_id),
    CONSTRAINT route_legs_cache_polyline_check
        CHECK (length(polyline) > 0),
    CONSTRAINT route_legs_cache_figures_check
        CHECK (distance_meters >= 0 AND duration_seconds >= 0)
);

-- The primary key's leading column serves "legs starting at X". This serves
-- "legs ending at X", which the invalidation trigger and the end_poi_id
-- cascade both need - without it every waypoint update scans the table.
CREATE INDEX IF NOT EXISTS idx_route_legs_cache_end_poi_id
    ON public.route_legs_cache (end_poi_id);

COMMENT ON TABLE public.route_legs_cache IS
    'TASK-801: Valhalla hops between consecutive stops, shared across visitors. Written and read only by the route-stops Edge Function (service role). Rows older than 14 days are ignored by the reader; rows whose coords_key no longer matches the stops are ignored too.';

-- updated_at is the TTL clock, so an upsert that refreshes a row must restamp
-- it. PostgREST's ON CONFLICT DO UPDATE only sets the columns it was sent;
-- the database clock sets this one.
DROP TRIGGER IF EXISTS trg_route_legs_cache_updated_at ON public.route_legs_cache;
CREATE TRIGGER trg_route_legs_cache_updated_at
    BEFORE UPDATE ON public.route_legs_cache
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Privileges
-- -----------------------------------------------------------------------------
ALTER TABLE public.route_legs_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.route_legs_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.route_legs_cache TO service_role;

-- -----------------------------------------------------------------------------
-- 3. Invalidation
--
-- SECURITY DEFINER IS REQUIRED, NOT A CONVENIENCE. These triggers fire inside
-- cms_replace_tour_waypoints / cms_set_tour_status, which are SECURITY INVOKER
-- and run as the CMS admin's `authenticated` role - which has no privilege on
-- this table. An invoker trigger would fail every CMS Save with 42501. The
-- function takes no input but the row being written, and only deletes.
--
-- WHAT COUNTS AS A CHANGE
--
--   waypoints  geom, poi_type, audiences, interests.  geom decides the leg's
--              geometry. Tags do not, but the PM's rule is that a changed POI
--              must not keep cached routes, and a delete costs one Valhalla
--              call at most. name and sort_order are deliberately excluded:
--              neither moves a hop, and sort_order changes on every drag.
--   tours      status, transit_mode.  "The POI closed" is modelled today as
--              archiving/unpublishing its tour; waypoints have no status column.
--
-- Compared with IS DISTINCT FROM, not "the column was in the SET list":
-- cms_replace_tour_waypoints rewrites every column of every kept waypoint on
-- each Save, so an UPDATE OF trigger alone would empty the cache on every Save.
-- geom is compared as WKB bytes - exact, and independent of which equality
-- operator the installed PostGIS version gives geometry.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invalidate_route_legs_cache()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
    IF TG_TABLE_NAME = 'waypoints' THEN
        DELETE FROM public.route_legs_cache
         WHERE start_poi_id = OLD.id
            OR end_poi_id   = OLD.id;
    ELSIF TG_TABLE_NAME = 'tours' THEN
        DELETE FROM public.route_legs_cache
         WHERE start_poi_id IN (SELECT id FROM public.waypoints WHERE tour_id = OLD.id)
            OR end_poi_id   IN (SELECT id FROM public.waypoints WHERE tour_id = OLD.id);
    END IF;
    RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.invalidate_route_legs_cache() IS
    'TASK-801: deletes cached route legs touching a waypoint whose location/tags changed, or any waypoint of a tour whose status/transit mode changed. SECURITY DEFINER because CMS writes run as authenticated, which has no privilege on route_legs_cache.';

REVOKE ALL ON FUNCTION public.invalidate_route_legs_cache() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_waypoints_invalidate_route_legs ON public.waypoints;
CREATE TRIGGER trg_waypoints_invalidate_route_legs
    AFTER UPDATE OF geom, poi_type, audiences, interests ON public.waypoints
    FOR EACH ROW
    WHEN (   ST_AsBinary(OLD.geom) IS DISTINCT FROM ST_AsBinary(NEW.geom)
          OR OLD.poi_type  IS DISTINCT FROM NEW.poi_type
          OR OLD.audiences IS DISTINCT FROM NEW.audiences
          OR OLD.interests IS DISTINCT FROM NEW.interests)
    EXECUTE FUNCTION public.invalidate_route_legs_cache();

DROP TRIGGER IF EXISTS trg_tours_invalidate_route_legs ON public.tours;
CREATE TRIGGER trg_tours_invalidate_route_legs
    AFTER UPDATE OF status, transit_mode ON public.tours
    FOR EACH ROW
    WHEN (   OLD.status       IS DISTINCT FROM NEW.status
          OR OLD.transit_mode IS DISTINCT FROM NEW.transit_mode)
    EXECUTE FUNCTION public.invalidate_route_legs_cache();
