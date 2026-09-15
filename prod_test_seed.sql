-- =============================================================================
-- prod_test_seed.sql  --  MANUAL RUN ONLY (Supabase Dashboard > SQL Editor)
--
-- A minimal, deliberately labelled test tour so TASK-202 can be exercised
-- against production. This is NOT a migration and NOT supabase/seed.sql - it is
-- run by hand and removed by hand.
--
-- Contents: 1 tour, 2 waypoints, 2 geofence zones, 2 audio tracks.
--
-- The geofence zones were not in the brief. I added them because without a zone
-- there is nothing for the engine to trigger on, and triggering is the entire
-- thing TASK-202 is meant to prove. Two rows; drop them if you disagree.
--
-- Every id starts with `eeeeeeee` so this data is trivially greppable and
-- distinguishable from the old `aaaaaaaa` dummy tour. Cleanup is at the bottom.
-- =============================================================================

SET search_path = public, extensions;

-- Re-runnable: removes only this test tour, cascading to its children.
DELETE FROM public.tours WHERE id = 'eeeeeeee-0000-4000-8000-000000000001';

-- --- Tour ---------------------------------------------------------------------
-- audiences/interests need migrations 20260915120000+ (TASK-603). Run against a
-- database without them and this INSERT fails on the unknown column - loudly,
-- which is the right way round.
INSERT INTO public.tours (id, title, topology, transit_mode, duration_minutes, status, audiences, interests) VALUES
    ('eeeeeeee-0000-4000-8000-000000000001',
     '[TEST] Jerusalem Gate Walk - delete after TASK-202',
     'in_city',
     'walking',
     15,
     'published',
     ARRAY['solo'],
     ARRAY['history']);

-- --- Waypoints ----------------------------------------------------------------
-- Jaffa Gate and the Tower of David: 58.7 m apart, which matters.
--
-- !! SPACING RULE - the obvious version of this is WRONG (TASK-505) !!
--
-- This comment used to read "trigger radii (20 + 25 = 45 m) stay clear of each
-- other, so the two zones cannot both fire from one GPS fix". The arithmetic is
-- right and the conclusion is wrong, because entry is not the boundary that
-- governs overlap.
--
-- The engine uses EXIT HYSTERESIS: once inside, a zone is only left past
-- trigger_radius_meters * exitHysteresisFactor (walking x1.6, biking x1.5,
-- driving x1.4 - see mobile/src/config/transitProfiles.ts). So the boundaries
-- that actually matter here are:
--
--     entry:  20 + 25            = 45 m   <- clear of the 58.7 m gap
--     exit:   20*1.6 + 25*1.6    = 72 m   <- OVERLAPS the 58.7 m gap
--
-- One GPS fix can therefore be inside Jaffa Gate and simultaneously outside the
-- Tower of David's widened exit boundary, emitting enter(1) and exit(2) together.
-- That is a real code path, not a curiosity: it silenced narration in the field
-- until TourSessionController learned to stop only the track the exiting
-- waypoint owns. Phase E of `npm run sim:walk` regression-tests it.
--
-- WHEN ADDING WAYPOINTS, require:
--     gap > (radius_a + radius_b) * exitHysteresisFactor
-- Comparing against the bare radii will let overlapping zones through.
INSERT INTO public.waypoints (id, tour_id, name, poi_type, geom, sort_order) VALUES
    ('eeeeeeee-0001-4000-8000-000000000001',
     'eeeeeeee-0000-4000-8000-000000000001',
     'Jaffa Gate',
     'anchor',
     ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326),
     1),

    ('eeeeeeee-0001-4000-8000-000000000002',
     'eeeeeeee-0000-4000-8000-000000000001',
     'Tower of David Citadel',
     'anchor',
     ST_SetSRID(ST_MakePoint(35.2281, 31.7761), 4326),
     2);

-- Waypoint tags (TASK-603); values from interest_tag_vocabulary().
UPDATE public.waypoints
   SET interests = ARRAY['architecture', 'history']
 WHERE tour_id = 'eeeeeeee-0000-4000-8000-000000000001';

-- --- Geofence zones -----------------------------------------------------------
-- geom is NOT NULL geometry(Polygon, 4326), so a radius zone still needs a real
-- polygon. The ::geography cast is load-bearing - buffering the raw geometry
-- would treat the radius as degrees, not metres.
INSERT INTO public.geofence_zones (id, waypoint_id, zone_type, trigger_radius_meters, geom) VALUES
    ('eeeeeeee-0002-4000-8000-000000000001',
     'eeeeeeee-0001-4000-8000-000000000001',
     'radius',
     20,
     ST_Buffer(ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326)::geography, 20)::geometry),

    ('eeeeeeee-0002-4000-8000-000000000002',
     'eeeeeeee-0001-4000-8000-000000000002',
     'radius',
     25,
     ST_Buffer(ST_SetSRID(ST_MakePoint(35.2281, 31.7761), 4326)::geography, 25)::geometry);

-- --- Audio tracks -------------------------------------------------------------
-- !! size_bytes MUST match the real uploaded files. See step 2 below. !!
-- The download manager validates size and hard-fails a mismatch, by design:
-- that is what catches truncation. A wrong value here reads as corruption.
INSERT INTO public.audio_tracks
    (id, waypoint_id, storage_path, format, size_bytes, duration_seconds, lufs_normalization) VALUES
    ('eeeeeeee-0003-4000-8000-000000000001',
     'eeeeeeee-0001-4000-8000-000000000001',
     'tours/eeeeeeee-0000-4000-8000-000000000001/wp01_jaffa_gate.m4a',
     'AAC',
     6,      -- PLACEHOLDER - correct with the real byte size
     15,
     -16),

    ('eeeeeeee-0003-4000-8000-000000000002',
     'eeeeeeee-0001-4000-8000-000000000002',
     'tours/eeeeeeee-0000-4000-8000-000000000001/wp02_tower_of_david.m4a',
     'AAC',
     6,      -- PLACEHOLDER - correct with the real byte size
     15,
     -16);

-- =============================================================================
-- STEP 2 - ingest the audio
--
-- The rows above are useless on their own: Screen 2 will not unlock "Start Tour"
-- until every track downloads AND matches its recorded size. The size_bytes and
-- duration_seconds values above are PLACEHOLDERS and are meant to be replaced.
--
-- SINCE TASK-402, DO NOT DO THIS BY HAND. One command per waypoint normalises
-- the audio to -16 LUFS, encodes AAC-LC, uploads it, and writes the true
-- size_bytes and duration_seconds through cms_register_audio_track():
--
--   npm run cms:ingest -- ./raw/jaffa_gate.wav \
--     --tour     eeeeeeee-0000-4000-8000-000000000001 \
--     --waypoint eeeeeeee-0001-4000-8000-000000000001 \
--     --sort 1 --name "Jaffa Gate"
--
--   npm run cms:ingest -- ./raw/tower_of_david.wav \
--     --tour     eeeeeeee-0000-4000-8000-000000000001 \
--     --waypoint eeeeeeee-0001-4000-8000-000000000002 \
--     --sort 2 --name "Tower of David"
--
-- It needs SUPABASE_ADMIN_EMAIL / SUPABASE_ADMIN_PASSWORD for an app_admins
-- account - there is no service_role path - and ffmpeg on PATH or FFMPEG_PATH.
-- Any format ffmpeg can decode works as the source; WAV or FLAC is preferred,
-- since re-encoding an already-lossy file loses a second generation.
--
-- The old procedure - upload through the dashboard, then UPDATE size_bytes by
-- hand from the figure Storage displays - is why this file carried placeholder
-- sizes in the first place, and is now actively discouraged. A hand-typed byte
-- count that is wrong by one makes the tour undownloadable, because the offline
-- downloader compares it exactly. cms_register_audio_track() refuses a size
-- that disagrees with the stored object; a raw UPDATE does not.
--
-- FORMAT: AAC-LC in .m4a only, which the pipeline guarantees. iOS cannot decode
-- Opus and fails silently - the player reports "playing" while stuck at 0:00.
-- See architecture_schema.md section 2.
--
-- Sanity check - should return one row with waypoints: 2
--   SELECT jsonb_pretty(get_tour_bundle('eeeeeeee-0000-4000-8000-000000000001'));
-- =============================================================================

-- =============================================================================
-- CLEANUP - run when TASK-202 sign-off is done
--   DELETE FROM public.tours WHERE id = 'eeeeeeee-0000-4000-8000-000000000001';
-- Storage objects are not cascaded by that delete; remove the folder in the
-- Storage UI as well.
-- =============================================================================
