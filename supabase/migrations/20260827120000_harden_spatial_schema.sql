-- =============================================================================
-- TASK-301 : Spatial schema hardening
--
-- STATUS: DRAFT - awaiting approval. Do not push.
--
-- The four tables from docs/architecture_schema.md section 1 already exist and
-- have been through four rounds of amendment. This migration does not recreate
-- them; it closes the integrity and indexing gaps that Epic 1/2 surfaced but
-- never had reason to fix.
--
-- Grouped by what each change protects:
--   1.  Referential integrity - orphan rows are currently possible
--   2.  Domain constraints    - every enum in the spec is free-text VARCHAR
--   2a. poi_type taxonomy     - PM decision; REWRITES EXISTING ROWS, see below
--   2b. Codec/extension       - publish-time check from architecture doc s.2
--   3.  Ordering integrity    - sort_order has no uniqueness guarantee
--   4.  Spatial indexing      - the metric-distance index is missing entirely
--   4b. tours.start_point     - PM decision; enables catalogue proximity search
--   5.  Audit columns         - needed by the CMS in TASK-303
--
-- ONE DESTRUCTIVE STATEMENT. Section 2a rewrites every waypoint currently
-- carrying poi_type = 'historic_site' to 'anchor'. That is the whole of the
-- live content. The reasoning is in 2a; approve it consciously.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Referential integrity
--
-- Every FK in the schema is nullable. A waypoint with tour_id IS NULL belongs
-- to no tour, is returned by no bundle query, and is invisible to cascade
-- deletes - it just accumulates. Nothing in the product wants a detached
-- waypoint, zone or track.
--
-- These statements take an ACCESS EXCLUSIVE lock and scan the table. At current
-- content volume that is milliseconds. They will FAIL LOUDLY if orphans already
-- exist; see the pre-flight query in the handover report before applying.
-- -----------------------------------------------------------------------------
ALTER TABLE public.waypoints      ALTER COLUMN tour_id     SET NOT NULL;
ALTER TABLE public.geofence_zones ALTER COLUMN waypoint_id SET NOT NULL;
ALTER TABLE public.audio_tracks   ALTER COLUMN waypoint_id SET NOT NULL;

-- -----------------------------------------------------------------------------
-- 2. Domain constraints
--
-- CHECK rather than ENUM throughout. Postgres enums cannot have values removed
-- and reordering requires a type rewrite; a CHECK is dropped and recreated in
-- one statement. Given topology and poi_type are still moving, that flexibility
-- is worth more than the two bytes an enum saves.
--
-- Value lists come from docs/architecture_schema.md and docs/prd_user_flows.md,
-- except poi_type, which was supplied by the PM in the TASK-301 review and is
-- handled separately in 2a below because it needs a backfill first.
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD CONSTRAINT tours_topology_check
        CHECK (topology IN ('in_city', 'point_to_point', 'star_loop')),
    ADD CONSTRAINT tours_transit_mode_check
        CHECK (transit_mode IN ('walking', 'biking', 'driving')),
    ADD CONSTRAINT tours_duration_positive_check
        CHECK (duration_minutes > 0);

ALTER TABLE public.geofence_zones
    ADD CONSTRAINT geofence_zones_zone_type_check
        CHECK (zone_type IN ('radius', 'polygon')),
    -- A radius zone without a radius is a polygon zone wearing the wrong label.
    -- The materialised polygon in geom is only the buffer; trigger_radius_meters
    -- is what the client re-derives its native OS geofence from, so losing it
    -- breaks the offline path even though the stored polygon still looks fine.
    ADD CONSTRAINT geofence_zones_radius_present_check
        CHECK (zone_type <> 'radius' OR trigger_radius_meters IS NOT NULL),
    -- Envelope from PRD section 3 (walking 15-30 m -> driving 150-300 m), with
    -- headroom. Catches unit errors - a radius entered in kilometres, or the
    -- degrees-vs-metres slip the seed comments already warn about.
    ADD CONSTRAINT geofence_zones_radius_sane_check
        CHECK (trigger_radius_meters IS NULL
               OR trigger_radius_meters BETWEEN 5 AND 1000);

ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_sort_order_check CHECK (sort_order >= 0);

-- -----------------------------------------------------------------------------
-- 2a. poi_type taxonomy                     (PM decision, TASK-301 review)
--
-- Approved values: anchor | transition | viewpoint | facility
--
-- !! THIS MIGRATION REWRITES EXISTING DATA. READ BEFORE APPROVING. !!
--
-- Every waypoint currently live carries poi_type = 'historic_site', which is
-- not in the approved list. Both supabase/seed.sql and prod_test_seed.sql use
-- it, so a plain validating CHECK would abort the push on the first row.
--
-- Three options were on the table:
--   (a) add the CHECK as NOT VALID and leave the old rows. Rejected: a NOT
--       VALID constraint is still enforced on UPDATE, so editing any legacy
--       waypoint in the CMS would fail with a constraint error nobody expects.
--       It buys a clean push and pays for it with a landmine.
--   (b) widen the approved list to include historic_site. Rejected: that is a
--       product decision, and the PM just made the opposite one.
--   (c) backfill, then validate. Chosen.
--
-- The mapping historic_site -> anchor is not a guess. seed.sql annotates each
-- of those rows in prose - "Anchor - trailhead", "Anchor - the must-have
-- historic site", "Anchor - terminal stop" - so the intended role is recorded
-- alongside every affected row. The one waypoint already carrying 'transition'
-- is left untouched.
--
-- Anything OTHER than historic_site or an approved value is deliberately not
-- mapped: it would fail the CHECK below and abort the push, which is the right
-- outcome for a value nobody has decided the meaning of. Run the pre-flight
-- query in the handover report to confirm the live data holds nothing else.
--
-- NOTE ON THE TAXONOMY ITSELF - flagged, not blocking. The approved list mixes
-- two axes: 'anchor' and 'transition' describe a waypoint's NARRATIVE ROLE in
-- the tour, while 'viewpoint' and 'facility' describe WHAT THE PLACE IS. The
-- seed data shows the collision directly - a row commented "Anchor" and typed
-- 'historic_site' was using both axes at once, in two different fields. As
-- written, a scenic overlook that is also a tour anchor has no correct value,
-- and 'facility' (a restroom, a ticket office) is almost certainly a transition
-- in narrative terms too. If that shows up as content is authored, the fix is
-- to split this into two columns - poi_role and poi_category - rather than
-- widening the list. Cheap now, expensive after the CMS ships. Raised properly
-- in the handover report.
-- -----------------------------------------------------------------------------
UPDATE public.waypoints
   SET poi_type = 'anchor'
 WHERE poi_type = 'historic_site';

ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_poi_type_check
        CHECK (poi_type IN ('anchor', 'transition', 'viewpoint', 'facility'));

ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_size_positive_check
        CHECK (size_bytes > 0),
    ADD CONSTRAINT audio_tracks_duration_positive_check
        CHECK (duration_seconds IS NULL OR duration_seconds > 0),
    -- -16 LUFS is the mobile target; the range brackets plausible mastering
    -- choices and rejects a sign error (+16) outright.
    ADD CONSTRAINT audio_tracks_lufs_sane_check
        CHECK (lufs_normalization IS NULL
               OR lufs_normalization BETWEEN -30 AND 0);

-- -----------------------------------------------------------------------------
-- 2b. Codec / extension agreement          (architecture_schema.md section 2)
--
-- This is publish-time check #2 from that section, enforced in the database
-- instead of in a script nobody remembers to run.
--
-- AVFoundation infers container format from the URL extension for local files,
-- so AAC bytes stored as .opus fail silently on iOS - the player reports
-- `playing` while position never leaves 0:00. Binding format to the extension
-- is the cheapest place to catch that, and it fails in the CMS at write time
-- rather than on a device in the field.
--
-- NOT VALID is deliberate. The preceding migration chose to leave existing Opus
-- rows alone so they could be re-encoded deliberately rather than relabelled;
-- a validating constraint would override that decision and fail the migration.
-- NOT VALID enforces on every INSERT and UPDATE from now on while leaving the
-- backlog visible. Once re-encoding is done:
--
--     ALTER TABLE public.audio_tracks
--         VALIDATE CONSTRAINT audio_tracks_format_check;
--     ALTER TABLE public.audio_tracks
--         VALIDATE CONSTRAINT audio_tracks_extension_matches_format_check;
--
-- VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock, so it does not block
-- reads or writes.
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_format_check
        -- MP3 is the sanctioned fallback for sources that cannot be re-encoded.
        -- It still needs audio/mpeg added to the bucket allowlist separately.
        CHECK (format IN ('AAC', 'MP3')) NOT VALID;

ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_extension_matches_format_check
        CHECK (
            (format = 'AAC' AND storage_path ~* '[.]m4a$')
            OR
            (format = 'MP3' AND storage_path ~* '[.]mp3$')
        ) NOT VALID;

-- storage_path holds a bucket-relative path. An absolute URL here re-pins rows
-- to one project ref, which the previous migration went to some trouble to
-- undo; a leading slash breaks getPublicUrl() concatenation.
ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_storage_path_relative_check
        CHECK (storage_path !~ '^(https?://|/)') NOT VALID;

-- -----------------------------------------------------------------------------
-- 3. Ordering integrity
--
-- sort_order drives playback sequence and the bundle hash ordering. Two
-- waypoints sharing a value make both non-deterministic.
--
-- DEFERRABLE is load-bearing, not decoration: Screen 3 reorders by drag & drop,
-- which is a sequence of pairwise swaps. An immediate unique constraint rejects
-- the first UPDATE of any swap, because the intermediate state legitimately
-- holds a duplicate. INITIALLY IMMEDIATE keeps the normal single-row path
-- checking eagerly; the CMS wraps a reorder in
--
--     BEGIN;
--     SET CONSTRAINTS waypoints_tour_sort_order_key DEFERRED;
--     ... the UPDATEs ...
--     COMMIT;
--
-- and the check then runs once, at commit.
--
-- This creates a UNIQUE index on (tour_id, sort_order), whose leading column
-- also serves every tour_id lookup - so the single-column index is redundant.
-- -----------------------------------------------------------------------------
ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_tour_sort_order_key
        UNIQUE (tour_id, sort_order)
        DEFERRABLE INITIALLY IMMEDIATE;

DROP INDEX IF EXISTS public.idx_waypoints_tour_id;

-- -----------------------------------------------------------------------------
-- 4. Spatial indexing
--
-- The existing GIST index on waypoints.geom stays. It is the correct choice and
-- SP-GiST is not a drop-in replacement here - the full comparison is in the
-- handover report, but the short version is that the PostGIS SP-GiST opclass
-- covers the bounding-box operators only, not the `<->` distance operator, and
-- every nearest-POI query in this product is a KNN ordering query.
--
-- What IS missing is a geography index. geom is geometry(Point, 4326), so
-- distance operations on it are computed in DEGREES:
--
--     ST_DWithin(geom, pt, 500)              -- 500 DEGREES. Half the planet.
--     ST_DWithin(geom::geography, pt, 500)   -- 500 metres. Correct.
--
-- The cast is what makes the query correct, and without a matching expression
-- index it also makes the query a sequential scan. Both nearest-POI variants in
-- backend/database/queries/nearest_poi.sql depend on this index.
--
-- At Jerusalem's latitude (31.78 N) the distortion is not subtle: one degree of
-- longitude spans ~94.5 km against ~111 km for one degree of latitude, so
-- ordering by planar degree distance can rank a POI that is genuinely further
-- away as nearer. Against 25 m geofences that is not a rounding error, it is
-- the wrong POI.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_waypoints_geog
    ON public.waypoints USING GIST ((geom::geography));

COMMENT ON INDEX public.idx_waypoints_geog IS
    'Metric-distance index. Serves ST_DWithin/ST_Distance/<-> against geom::geography, where units are metres. The plain geometry GIST index cannot serve these, because its operators work in degrees.';

COMMENT ON INDEX public.idx_waypoints_geom IS
    'Planar 4326 index. Serves bounding-box containment and map-viewport queries. GiST rather than SP-GiST because it must also serve KNN <-> ordering, which the PostGIS SP-GiST opclass does not support.';

COMMENT ON INDEX public.idx_geofence_zones_geom IS
    'Hot path: ST_Contains(geom, gps_fix) on every location update during an active tour. Containment is exact in 4326 and needs no geography cast, so a plain geometry GiST index is both correct and sufficient here.';

-- -----------------------------------------------------------------------------
-- 4b. tours.start_point                     (PM decision, TASK-301 review)
--
-- "Tours near me" for the catalogue. Without a spatial column on tours, that
-- question can only be answered by aggregating over every waypoint of every
-- tour - no index helps, and the cost grows with total waypoint count rather
-- than tour count.
--
-- TYPE: geography(Point, 4326), not geometry. This is the one column in the
-- schema that exists purely to answer a distance question, so it stores the
-- type whose units are already metres. Queries need no ::geography cast, which
-- removes the single most likely way for this to be used wrongly - see the
-- degrees-vs-metres note in section 4.
--
-- NULLABLE, deliberately: a tour drafted in the CMS has no waypoints yet, and
-- there is no honest value for its start point until it does. Proximity queries
-- filter NULLs out for free, so a half-built tour simply does not appear in the
-- catalogue - which is the desired behaviour anyway.
--
-- DENORMALISATION, ACKNOWLEDGED. This duplicates the first waypoint's geom, so
-- it can go stale. A view over waypoints would stay correct by construction but
-- could not be indexed, which defeats the entire point. The trigger below is
-- the price of the index; a stale start_point is a silent wrong answer, so it
-- is not optional.
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD COLUMN IF NOT EXISTS start_point geography(Point, 4326);

COMMENT ON COLUMN public.tours.start_point IS
    'Starting location: the geom of the lowest-sort_order waypoint, cast to geography. Maintained by trg_waypoints_refresh_tour_start - do not write it directly. NULL until the tour has at least one waypoint.';

-- Backfill. Ordered by (sort_order, id): sort_order alone is not yet unique at
-- this point in the migration, and an ambiguous "first" waypoint would make the
-- backfill non-deterministic across environments.
UPDATE public.tours t
   SET start_point = (
         SELECT w.geom::geography
           FROM public.waypoints w
          WHERE w.tour_id = t.id
          ORDER BY w.sort_order, w.id
          LIMIT 1
       );

CREATE INDEX IF NOT EXISTS idx_tours_start_point
    ON public.tours USING GIST (start_point);

COMMENT ON INDEX public.idx_tours_start_point IS
    'Catalogue proximity: ST_DWithin(start_point, fix, radius) for "tours near me". Already geography, so no cast and no expression index needed.';

-- Maintenance. Row-level rather than statement-level with transition tables:
-- at this content volume the extra UPDATEs are noise, and the logic stays
-- readable. Revisit if bulk waypoint imports ever become a hot path.
--
-- TG_OP is branched explicitly instead of folded into a CASE expression,
-- because NEW is unassigned in a DELETE trigger and OLD is unassigned in an
-- INSERT trigger - referencing the wrong one raises at runtime regardless of
-- which CASE branch would have been taken.
CREATE OR REPLACE FUNCTION public.refresh_tour_start_point()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
DECLARE
    v_tour_ids uuid[];
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_tour_ids := ARRAY[NEW.tour_id];
    ELSIF TG_OP = 'DELETE' THEN
        v_tour_ids := ARRAY[OLD.tour_id];
    ELSE
        -- A waypoint moved between tours leaves BOTH tours needing a recount.
        v_tour_ids := ARRAY[OLD.tour_id, NEW.tour_id];
    END IF;

    UPDATE public.tours t
       SET start_point = (
             SELECT w.geom::geography
               FROM public.waypoints w
              WHERE w.tour_id = t.id
              ORDER BY w.sort_order, w.id
              LIMIT 1
           )
     WHERE t.id = ANY(v_tour_ids);

    RETURN NULL;  -- AFTER trigger; return value is ignored.
END;
$fn$;

COMMENT ON FUNCTION public.refresh_tour_start_point() IS
    'Keeps tours.start_point equal to the lowest-sort_order waypoint of its tour. Recomputes from scratch rather than reacting to the specific change, so it is correct regardless of which column moved.';

DROP TRIGGER IF EXISTS trg_waypoints_refresh_tour_start ON public.waypoints;

-- Fires on the three columns that can change which waypoint is first, or where
-- that waypoint is. Renaming a waypoint does not touch start_point, and there
-- is no reason to write to tours every time someone fixes a typo.
CREATE TRIGGER trg_waypoints_refresh_tour_start
    AFTER INSERT OR DELETE OR UPDATE OF tour_id, sort_order, geom
    ON public.waypoints
    FOR EACH ROW
    EXECUTE FUNCTION public.refresh_tour_start_point();

-- -----------------------------------------------------------------------------
-- 5. Audit columns
--
-- The CMS in TASK-303 needs a "last edited" column, and bundle staleness has no
-- cheap signal today - get_tour_bundle() rebuilds and re-hashes the entire
-- payload just to answer "has anything changed?". A tour-level updated_at lets
-- a client short-circuit that with a conditional request.
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.waypoints
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.geofence_zones
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.audio_tracks
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.set_updated_at() IS
    'Generic updated_at stamp. Intentionally ignores whether the row actually changed - a no-op UPDATE still bumps the timestamp, which is the conservative direction for a cache-invalidation signal.';

DROP TRIGGER IF EXISTS trg_tours_updated_at          ON public.tours;
DROP TRIGGER IF EXISTS trg_waypoints_updated_at      ON public.waypoints;
DROP TRIGGER IF EXISTS trg_geofence_zones_updated_at ON public.geofence_zones;
DROP TRIGGER IF EXISTS trg_audio_tracks_updated_at   ON public.audio_tracks;

CREATE TRIGGER trg_tours_updated_at
    BEFORE UPDATE ON public.tours
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_waypoints_updated_at
    BEFORE UPDATE ON public.waypoints
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_geofence_zones_updated_at
    BEFORE UPDATE ON public.geofence_zones
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_audio_tracks_updated_at
    BEFORE UPDATE ON public.audio_tracks
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
