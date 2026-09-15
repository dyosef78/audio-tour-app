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
-- SPACING RULE (TASK-505): waypoint gaps must clear the sum of the EXIT radii,
-- not the entry radii. Exit hysteresis widens every zone by
-- exitHysteresisFactor (walking x1.6 - see mobile/src/config/transitProfiles.ts),
-- so zones whose trigger radii are comfortably clear can still overlap on exit.
--
-- This seed contains such a pair, deliberately left in place because it is
-- useful coverage: Jaffa Gate and the Tower of David sit 58.7 m apart, entry
-- radii sum to 45 m (clear) but exit radii sum to 72 m (overlapping). One GPS
-- fix can therefore enter one zone and exit the other in the same evaluation.
-- The engine handles it - TourSessionController stops only the track the
-- exiting waypoint owns - and Phase E of `npm run sim:walk` regression-tests it.
-- When adding NEW waypoints, require gap > (r_a + r_b) * exitHysteresisFactor.
--
-- Trigger radii follow the PRD walking envelope (15-30 m). Names are
-- transliterated rather than Hebrew to stay encoding-safe on Windows clients.
-- Coordinates approximate the real landmarks: fine for exercising the spatial
-- indexes, NOT survey-grade.
-- -----------------------------------------------------------------------------

-- Idempotency guard: removes the previous run of this seed and nothing else.
DELETE FROM public.tours WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- --- Tour ---------------------------------------------------------------------
-- audiences/interests (TASK-603) must come from audience_tag_vocabulary() and
-- interest_tag_vocabulary(). A typo fails `db reset` on the CHECK constraint,
-- which is exactly the drift this file has caught before.
INSERT INTO public.tours (id, title, topology, transit_mode, duration_minutes, status, audiences, interests) VALUES
    ('aaaaaaaa-0000-4000-8000-000000000001',
     'Jerusalem Old City - Historic Morning Walk',
     'in_city',
     'walking',
     90,
     'published',
     ARRAY['couple', 'friends', 'solo'],
     ARRAY['architecture', 'history']);

-- --- Waypoints ----------------------------------------------------------------
-- Mixed anchors and one transition. sort_order drives the Screen 3 timeline.
INSERT INTO public.waypoints (id, tour_id, name, poi_type, geom, sort_order) VALUES
    -- 1. Anchor - trailhead. Coordinates match the manifest example in
    --    architecture_schema.md so the two documents line up.
    ('bbbbbbbb-0000-4000-8000-000000000001',
     'aaaaaaaa-0000-4000-8000-000000000001',
     'Jaffa Gate',
     'anchor',
     ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326),
     1),

    -- 2. Anchor - the "must-have historic site" from PRD Screen 2.
    ('bbbbbbbb-0000-4000-8000-000000000002',
     'aaaaaaaa-0000-4000-8000-000000000001',
     'Tower of David Citadel',
     'anchor',
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
     'anchor',
     ST_SetSRID(ST_MakePoint(35.2344, 31.7767), 4326),
     4);

-- --- Waypoint tags (TASK-603) -------------------------------------------------
-- UPDATEs rather than extra VALUES columns, so the tuples above stay readable.
-- The Cardo transition is left untagged on purpose: empty means "not
-- restricted", and the bundle verifier should see both shapes.
UPDATE public.waypoints
   SET interests = ARRAY['architecture', 'history']
 WHERE id IN ('bbbbbbbb-0000-4000-8000-000000000001',
              'bbbbbbbb-0000-4000-8000-000000000002');

UPDATE public.waypoints
   SET interests = ARRAY['history'],
       audiences = ARRAY['couple', 'family_kids', 'friends', 'solo']
 WHERE id = 'bbbbbbbb-0000-4000-8000-000000000004';

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
-- size_bytes assume AAC-LC mono voice at ~64 kbps (8,000 bytes/sec) and are
-- consistent with duration_seconds: 1160000 / 8000 = 145 s, and so on. Both feed
-- the Screen 4 bundle estimate. Anchors get the 90-150 s deep dive from PRD
-- Section 3; the transition gets a short cue.
--
-- storage_path is RELATIVE to the `audio-tracks` bucket - no host, no project
-- ref, so these rows are environment-agnostic. The bucket is PRIVATE, so
-- clients mint a short-lived URL at download time:
--   supabase.storage.from('audio-tracks').createSignedUrls([storage_path], 3600)
--
-- Signing fails with "Object not found" until audio is actually uploaded to the
-- bucket; these rows exist to exercise the schema, not to stream.
INSERT INTO public.audio_tracks (id, waypoint_id, storage_path, format, size_bytes, duration_seconds, lufs_normalization) VALUES
    ('dddddddd-0000-4000-8000-000000000001',
     'bbbbbbbb-0000-4000-8000-000000000001',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp01_jaffa_gate.m4a',
     'AAC', 1160000, 145, -16),

    ('dddddddd-0000-4000-8000-000000000002',
     'bbbbbbbb-0000-4000-8000-000000000002',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp02_tower_of_david.m4a',
     'AAC',  960000, 120, -16),

    ('dddddddd-0000-4000-8000-000000000003',
     'bbbbbbbb-0000-4000-8000-000000000003',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp03_cardo_transition.m4a',
     'AAC',  280000,  35, -16),

    ('dddddddd-0000-4000-8000-000000000004',
     'bbbbbbbb-0000-4000-8000-000000000004',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp04_western_wall.m4a',
     'AAC', 1200000, 150, -16);

-- --- Deep Dive (TASK-603) -----------------------------------------------------
-- A SECOND track on the Tower of David, which is what the new
-- (waypoint_id, track_kind) unique index permits and the old one did not. It
-- makes every `db reset` exercise the paths a Deep Dive changes: the bundle
-- must still serve the NARRATION as `media` and this row as `deep_dive`.
-- The `.deep_dive` path segment matches backend/cms/storage-path.ts.
INSERT INTO public.audio_tracks
    (id, waypoint_id, track_kind, storage_path, format, size_bytes, duration_seconds, lufs_normalization) VALUES
    ('dddddddd-0000-4000-8000-000000000005',
     'bbbbbbbb-0000-4000-8000-000000000002',
     'deep_dive',
     'tours/aaaaaaaa-0000-4000-8000-000000000001/wp02_tower_of_david.deep_dive.m4a',
     'AAC', 2880000, 360, -16);
