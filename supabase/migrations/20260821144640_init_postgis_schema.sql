-- =============================================================================
-- TASK-303 : Initial schema (was backend/database/01_init_postgis_schema.sql)
-- Source   : docs/architecture_schema.md - Section 1
--
-- SUPABASE ADAPTATIONS vs. the original standalone file:
--   1. No explicit BEGIN/COMMIT - the Supabase CLI already wraps each migration
--      in a transaction, and a nested BEGIN emits a warning.
--   2. PostGIS is installed into the `extensions` schema rather than `public`,
--      per Supabase convention. Dumping ~1,000 PostGIS objects into `public`
--      would otherwise expose them all through the auto-generated Data API.
--   3. pgcrypto dropped - Supabase runs PostgreSQL 15+, where gen_random_uuid()
--      lives in pg_catalog and needs no extension.
--   4. RLS is applied separately, in the enable_rls_policies migration.
-- =============================================================================

-- `extensions` exists on every Supabase project; the guard is for bare Postgres.
CREATE SCHEMA IF NOT EXISTS extensions;

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

-- Required so the unqualified `geometry` type below resolves during this
-- migration. At runtime PostgREST gets the same from config.toml via
-- api.extra_search_path = ["public", "extensions"].
SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- tours
--   topology     : in_city | point_to_point | star_loop   (PRD Screen 1)
--   transit_mode : walking | biking | driving             (PRD Section 3)
-- -----------------------------------------------------------------------------
CREATE TABLE public.tours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    topology VARCHAR(50) NOT NULL,
    transit_mode VARCHAR(50) NOT NULL,
    duration_minutes INT NOT NULL
);

-- -----------------------------------------------------------------------------
-- waypoints
--   geom       : Point in WGS84 (SRID 4326), matching raw GPS fixes.
--   sort_order : chronological position, reordered by drag & drop (Screen 3).
-- -----------------------------------------------------------------------------
CREATE TABLE public.waypoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tour_id UUID REFERENCES public.tours(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    poi_type VARCHAR(50) NOT NULL,
    geom geometry(Point, 4326) NOT NULL,
    sort_order INT NOT NULL
);

CREATE INDEX idx_waypoints_geom ON public.waypoints USING GIST (geom);

-- -----------------------------------------------------------------------------
-- geofence_zones
--   trigger_radius_meters follows the transit envelope (PRD Section 3):
--     walking 15-30 m | biking 50-80 m | driving 150-300 m (early trigger).
-- -----------------------------------------------------------------------------
CREATE TABLE public.geofence_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    waypoint_id UUID REFERENCES public.waypoints(id) ON DELETE CASCADE,
    zone_type VARCHAR(50) NOT NULL,
    trigger_radius_meters INT,
    geom geometry(Polygon, 4326) NOT NULL
);

-- Hot path: ST_Contains against the incoming GPS stream during an active tour.
CREATE INDEX idx_geofence_zones_geom ON public.geofence_zones USING GIST (geom);

-- -----------------------------------------------------------------------------
-- audio_tracks
--   size_bytes         : drives the offline bundle progress meter (Screen 4).
--   lufs_normalization : loudness target, -16 LUFS for mobile playback.
-- -----------------------------------------------------------------------------
CREATE TABLE public.audio_tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    waypoint_id UUID REFERENCES public.waypoints(id) ON DELETE CASCADE,
    file_url VARCHAR(512) NOT NULL,
    format VARCHAR(20) DEFAULT 'Opus',
    size_bytes BIGINT NOT NULL,
    lufs_normalization INT DEFAULT -16
);

-- -----------------------------------------------------------------------------
-- Foreign key indexes (carried over from TASK-302).
-- Postgres indexes the parent side of an FK via its primary key but never the
-- child side; without these, every cascade delete and every per-tour bundle
-- query degrades to a sequential scan.
-- -----------------------------------------------------------------------------
CREATE INDEX idx_waypoints_tour_id            ON public.waypoints (tour_id);
CREATE INDEX idx_geofence_zones_waypoint_id   ON public.geofence_zones (waypoint_id);
CREATE INDEX idx_audio_tracks_waypoint_id     ON public.audio_tracks (waypoint_id);
