-- =============================================================================
-- LOCAL DEVELOPMENT SEED DATA
--
-- Runs ONLY against the local stack, on `supabase db reset`, via config.toml:
--   [db.seed] enabled = true, sql_paths = ["./seed.sql"]
--
-- This file is NOT a migration and is NOT applied by `supabase db push`, which
-- is the point - per the PM/Architect decision in TASK-304, dummy data must
-- never reach production.
--
-- Re-runnable: deletes its own tour by fixed UUID first, cascading to
-- waypoints -> geofence_zones + audio_tracks.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Seed: "Jerusalem Old City - Historic Morning Walk"
--   Topology     : in_city
--   Transit mode : walking
--   Duration     : 90 minutes
--   Route        : Jaffa Gate -> Tower of David -> Cardo -> Western Wall
--                  (677 m total, ~9 min moving time)
--
-- Trigger radii follow the PRD walking envelope (15-30 m). Names are
-- transliterated rather than Hebrew to stay encoding-safe on Windows clients.
-- Coordinates approximate the real landmarks: fine for exercising the spatial
-- indexes, NOT survey-grade.
-- -----------------------------------------------------------------------------

-- Idempotency guard: removes the previous run of this seed and nothing else.
DELETE FROM public.tours WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- --- Tour ---------------------------------------------------------------------
INSERT INTO public.tours (id, title, topology, transit_mode, duration_minutes) VALUES
    ('aaaaaaaa-0000-4000-8000-000000000001',
     'Jerusalem Old City - Historic Morning Walk',
     'in_city',
     'walking',
     90);

-- --- Waypoints ----------------------------------------------------------------
-- Mixed anchors and one transition. sort_order drives the Screen 3 timeline.
INSERT INTO public.waypoints (id, tour_id, name, poi_type, geom, sort_order) VALUES
    -- 1. Anchor - trailhead. Coordinates match the manifest example in
    --    architecture_schema.md so the two documents line up.
    ('bbbbbbbb-0000-4000-8000-000000000001',
     'aaaaaaaa-0000-4000-8000-000000000001',
     'Jaffa Gate',
     'historic_site',
     ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326),
     1),

    -- 2. Anchor - the "must-have historic site" from PRD Screen 2.
    ('bbbbbbbb-0000-4000-8000-000000000002',
     'aaaaaaaa-0000-4000-8000-000000000001',
     'Tower of David Citadel',
     'historic_site',
     ST_SetSRID(ST_MakePoint(35.2281, 31.7761), 4326),
     2),

    -- 3. Transition - routing hint through the Cardo, short nav cue only.
    ('bbbbbbbb-0000-4000-8000-000000000003',
     'aaaaaaaa-0000-4000-8000-000000000001',
     'The Cardo - Jewish Quarter Passage',
     'transition',
     ST_SetSRID(ST_MakePoint(35.2312, 31.7757), 4326),
     3),

    -- 4. Anchor - terminal stop, opens onto a large plaza.
    ('bbbbbbbb-0000-4000-8000-000000000004',
     'aaaaaaaa-0000-4000-8000-000000000001',
     'Western Wall Plaza',
     'historic_site',
     ST_SetSRID(ST_MakePoint(35.2344, 31.7767), 4326),
     4);

-- --- Geofence zones -----------------------------------------------------------
-- geom is NOT NULL geometry(Polygon, 4326), so radius-type zones still need a
-- materialised polygon. The ::geography cast is load-bearing: buffering the raw
-- geometry would treat the radius as degrees, not metres.
INSERT INTO public.geofence_zones (id, waypoint_id, zone_type, trigger_radius_meters, geom) VALUES
    -- Narrow street approach - tight 20 m radius.
    ('cccccccc-0000-4000-8000-000000000001',
     'bbbbbbbb-0000-4000-8000-000000000001',
     'radius',
     20,
     ST_Buffer(ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography, 20)::geometry),

    -- Open courtyard - 25 m, the walking default used in the manifest example.
    ('cccccccc-0000-4000-8000-000000000002',
     'bbbbbbbb-0000-4000-8000-000000000002',
     'radius',
     25,
     ST_Buffer(ST_SetSRID(ST_MakePoint(35.2281, 31.7761), 4326)::geography, 25)::geometry),

    -- Covered colonnade, poor GPS - widened to 30 m, top of the walking range.
    ('cccccccc-0000-4000-8000-000000000003',
     'bbbbbbbb-0000-4000-8000-000000000003',
     'radius',
     30,
     ST_Buffer(ST_SetSRID(ST_MakePoint(35.2312, 31.7757), 4326)::geography, 30)::geometry),

    -- Hand-drawn plaza footprint (~85 x 84 m): an irregular open space is
    -- modelled better by its outline than a circle, so zone_type is 'polygon'
    -- and trigger_radius_meters is legitimately NULL.
    ('cccccccc-0000-4000-8000-000000000004',
     'bbbbbbbb-0000-4000-8000-000000000004',
     'polygon',
     NULL,
     ST_GeomFromText(
         'POLYGON((35.23400 31.77630, 35.23490 31.77635, 35.23485 31.77712, 35.23395 31.77705, 35.23400 31.77630))',
         4326));

-- --- Audio tracks -------------------------------------------------------------
-- size_bytes assume Opus mono voice at ~48 kbps (6,000 bytes/sec) and are
-- consistent with duration_seconds: 870000 / 6000 = 145 s, and so on. Both feed
-- the Screen 4 bundle estimate. Anchors get the 90-150 s deep dive from PRD
-- Section 3; the transition gets a short cue.
--
-- storage_path is RELATIVE to the `audio-tracks` bucket - no host, no project
-- ref, so these rows are environment-agnostic. Clients resolve a playable URL
-- at read time:
--   supabase.storage.from('audio-tracks').getPublicUrl(storage_path)
--
-- Paths resolve to 404 until audio is actually uploaded to the bucket; the rows
-- exist to exercise the schema, not to stream.
INSERT INTO public.audio_tracks (id, waypoint_id, storage_path, format, size_bytes, duration_seconds, lufs_normalization) VALUES
    ('dddddddd-0000-4000-8000-000000000001',
     'bbbbbbbb-0000-4000-8000-000000000001',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp01_jaffa_gate.opus',
     'Opus', 870000, 145, -16),

    ('dddddddd-0000-4000-8000-000000000002',
     'bbbbbbbb-0000-4000-8000-000000000002',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp02_tower_of_david.opus',
     'Opus', 720000, 120, -16),

    ('dddddddd-0000-4000-8000-000000000003',
     'bbbbbbbb-0000-4000-8000-000000000003',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp03_cardo_transition.opus',
     'Opus', 210000,  35, -16),

    ('dddddddd-0000-4000-8000-000000000004',
     'bbbbbbbb-0000-4000-8000-000000000004',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp04_western_wall.opus',
     'Opus', 900000, 150, -16);
