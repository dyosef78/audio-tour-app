-- =============================================================================
-- TASK-301 : Nearest-POI reference queries
--
-- Sample coordinate throughout: Jaffa Gate, Jerusalem (35.2279 E, 31.7766 N).
-- Note the argument order - ST_MakePoint takes (longitude, latitude), which is
-- the reverse of how GPS fixes are usually spoken and written. Swapping them
-- puts the point in Somalia, and PostGIS will not complain.
--
-- THE ONE THING THAT MATTERS HERE
--
-- waypoints.geom is geometry(Point, 4326). Distance on a `geometry` in 4326 is
-- computed in DEGREES OF ARC, not metres. Every query below therefore casts to
-- `geography`, which computes true spheroidal distance in metres.
--
-- The cast is not a formatting detail - at Jerusalem's latitude one degree of
-- longitude spans ~94.5 km while one degree of latitude spans ~111 km, so a
-- planar ordering can rank a genuinely-further POI as nearer. Against the 15-30
-- m walking geofences in PRD section 3, that is a wrong answer, not an
-- imprecise one.
--
-- The cast requires the expression index added in
-- 20260827120000_harden_spatial_schema.sql:
--     CREATE INDEX idx_waypoints_geog ON waypoints USING GIST ((geom::geography));
-- Without it these queries are correct but sequential-scan.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Query 1 - THE ANSWER: single nearest POI, index-assisted KNN
--
-- `<->` between two geography values returns distance in metres and is served
-- directly by the GiST index, which walks the tree in distance order and stops
-- as soon as it has the LIMIT. Cost does not grow with table size the way a
-- sort-everything-then-truncate plan does.
--
-- ST_Distance is called separately in the SELECT list to report the distance.
-- That is a second computation, but only for the rows that survive the LIMIT -
-- do NOT move it into ORDER BY, because an ORDER BY on a function result cannot
-- use the KNN index and silently degrades to a full scan plus sort.
-- -----------------------------------------------------------------------------
SELECT
    w.id,
    w.name,
    w.poi_type,
    w.tour_id,
    ST_Y(w.geom) AS latitude,
    ST_X(w.geom) AS longitude,
    ST_Distance(
        w.geom::geography,
        ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
    ) AS distance_meters
FROM public.waypoints w
ORDER BY w.geom::geography <-> ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
LIMIT 1;


-- -----------------------------------------------------------------------------
-- Query 2 - nearest N within a hard radius
--
-- ST_DWithin, not ST_Distance(...) < n. ST_DWithin is index-aware: it prefilters
-- on the bounding box before computing exact distance. A bare comparison against
-- ST_Distance computes the exact spheroidal distance for every row in the table
-- first, then discards most of them.
--
-- ST_DWithin on geography is also the correct spelling of "within 500 metres".
-- ST_DWithin(geom, pt, 500) without the cast means 500 DEGREES - roughly half
-- the planet - and quietly returns the entire table.
--
-- Both the WHERE and the ORDER BY use the same geography index here.
-- -----------------------------------------------------------------------------
SELECT
    w.id,
    w.name,
    w.poi_type,
    t.title AS tour_title,
    ST_Distance(
        w.geom::geography,
        ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
    ) AS distance_meters
FROM public.waypoints w
JOIN public.tours t ON t.id = w.tour_id
WHERE ST_DWithin(
        w.geom::geography,
        ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography,
        500  -- metres
      )
ORDER BY w.geom::geography <-> ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
LIMIT 5;


-- -----------------------------------------------------------------------------
-- Query 3 - which geofence zones does this fix actually sit inside?
--
-- Distinct from "nearest POI" and worth keeping separate. This is the hot path
-- during an active tour, and it is a containment test, not a distance test:
-- ST_Contains in 4326 is exact and needs no geography cast, so it runs against
-- the plain geometry GIST index on geofence_zones.geom.
--
-- Overlapping zones are possible by design, hence the ordering - the tightest
-- zone wins, which is the one whose audio is most specific to where the user is
-- standing.
-- -----------------------------------------------------------------------------
SELECT
    z.id AS zone_id,
    z.zone_type,
    z.trigger_radius_meters,
    w.id AS waypoint_id,
    w.name,
    a.storage_path,
    a.duration_seconds
FROM public.geofence_zones z
JOIN public.waypoints w ON w.id = z.waypoint_id
LEFT JOIN public.audio_tracks a ON a.waypoint_id = w.id
WHERE ST_Contains(z.geom, ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326))
ORDER BY ST_Area(z.geom::geography) ASC;


-- -----------------------------------------------------------------------------
-- Query 4 - tours near me                   (catalogue browse, not in-tour)
--
-- Note what is NOT here: no ::geography cast. tours.start_point is already
-- geography, so metres are the native unit and idx_tours_start_point applies
-- directly. That is the reason for the type choice - it removes the cast that
-- everything else in this file has to remember.
--
-- start_point is NULL for a tour with no waypoints yet. ST_DWithin returns NULL
-- for a NULL input, and a NULL WHERE clause is not true, so draft tours drop
-- out of the catalogue without needing an explicit filter.
-- -----------------------------------------------------------------------------
SELECT
    t.id,
    t.title,
    t.topology,
    t.transit_mode,
    t.duration_minutes,
    ST_Distance(
        t.start_point,
        ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
    ) AS distance_to_start_meters
FROM public.tours t
WHERE ST_DWithin(
        t.start_point,
        ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography,
        5000  -- metres
      )
ORDER BY t.start_point <-> ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
LIMIT 20;


-- =============================================================================
-- RPC WRAPPER
--
-- PostgREST cannot express a KNN ordering through its query string, so the
-- nearest-POI lookup has to be a function to stay index-assisted. Calling it
-- from the client:
--
--     supabase.rpc('nearest_waypoints', {
--       p_lon: 35.2279, p_lat: 31.7766, p_radius_meters: 500, p_limit: 5
--     })
--
-- SECURITY INVOKER (the default, stated explicitly) matches get_tour_bundle():
-- the function runs as the caller, so the public-read RLS policies still apply
-- and it grants no access the caller did not already have.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.nearest_waypoints(
    p_lon            double precision,
    p_lat            double precision,
    p_radius_meters  double precision DEFAULT 500,
    p_limit          integer          DEFAULT 5,
    p_tour_id        uuid             DEFAULT NULL
)
RETURNS TABLE (
    waypoint_id     uuid,
    tour_id         uuid,
    name            varchar,
    poi_type        varchar,
    latitude        double precision,
    longitude       double precision,
    distance_meters double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
    SELECT
        w.id,
        w.tour_id,
        w.name,
        w.poi_type,
        ST_Y(w.geom),
        ST_X(w.geom),
        ST_Distance(
            w.geom::geography,
            ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
        )
    FROM public.waypoints w
    WHERE ST_DWithin(
            w.geom::geography,
            ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
            p_radius_meters
          )
      -- Optional scoping: during an active tour the client only cares about
      -- waypoints on the tour in hand. NULL means search the whole catalogue,
      -- which is what the "what's near me" browse case wants.
      AND (p_tour_id IS NULL OR w.tour_id = p_tour_id)
    ORDER BY w.geom::geography <-> ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
    LIMIT p_limit;
$fn$;

COMMENT ON FUNCTION public.nearest_waypoints(double precision, double precision, double precision, integer, uuid) IS
    'Nearest waypoints to a GPS fix, ordered by true spheroidal distance in metres. Index-assisted KNN via idx_waypoints_geog. Runs as the caller, so RLS still applies.';

GRANT EXECUTE ON FUNCTION public.nearest_waypoints(double precision, double precision, double precision, integer, uuid)
    TO anon, authenticated;


-- =============================================================================
-- VERIFYING THE PLAN
--
-- The whole point of the geography index is that these queries do not scan.
-- Confirm with:
--
--     EXPLAIN (ANALYZE, BUFFERS)
--     SELECT w.id
--     FROM public.waypoints w
--     ORDER BY w.geom::geography <-> ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography
--     LIMIT 1;
--
-- Want:  Index Scan using idx_waypoints_geog
-- Not:   Seq Scan on waypoints  ->  Sort
--
-- CAVEAT ON A SMALL TABLE: with only a handful of seeded waypoints the planner
-- will legitimately prefer a sequential scan, because scanning four rows beats
-- descending an index. That is not a broken index. To actually exercise the
-- index path, either load a realistic number of rows or force it for the
-- duration of a session with:
--
--     SET enable_seqscan = off;
--
-- and remember to reset it. A plan measured on four rows says nothing about the
-- plan you will get on four thousand.
-- =============================================================================
