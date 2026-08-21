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
INSERT INTO public.tours (id, title, topology, transit_mode, duration_minutes) VALUES
    ('eeeeeeee-0000-4000-8000-000000000001',
     '[TEST] Jerusalem Gate Walk - delete after TASK-202',
     'in_city',
     'walking',
     15);

-- --- Waypoints ----------------------------------------------------------------
-- Jaffa Gate and the Tower of David: 58.7 m apart, which matters. Their trigger
-- radii (20 m + 25 m = 45 m) stay clear of each other, so the two zones cannot
-- both fire from one GPS fix. That makes enter/exit unambiguous when testing.
INSERT INTO public.waypoints (id, tour_id, name, poi_type, geom, sort_order) VALUES
    ('eeeeeeee-0001-4000-8000-000000000001',
     'eeeeeeee-0000-4000-8000-000000000001',
     'Jaffa Gate',
     'historic_site',
     ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326),
     1),

    ('eeeeeeee-0001-4000-8000-000000000002',
     'eeeeeeee-0000-4000-8000-000000000001',
     'Tower of David Citadel',
     'historic_site',
     ST_SetSRID(ST_MakePoint(35.2281, 31.7761), 4326),
     2);

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
     'tours/eeeeeeee-0000-4000-8000-000000000001/wp01_jaffa_gate.opus',
     'Opus',
     6,      -- PLACEHOLDER - correct with the real byte size
     15,
     -16),

    ('eeeeeeee-0003-4000-8000-000000000002',
     'eeeeeeee-0001-4000-8000-000000000002',
     'tours/eeeeeeee-0000-4000-8000-000000000001/wp02_tower_of_david.opus',
     'Opus',
     6,      -- PLACEHOLDER - correct with the real byte size
     15,
     -16);

-- =============================================================================
-- STEP 2 - upload the audio, then correct size_bytes
--
-- The rows above are useless on their own: Screen 2 will not unlock "Start Tour"
-- until every track downloads AND matches its recorded size. Two short .opus
-- files (any content) are enough.
--
--   Dashboard > Storage > audio-tracks, create this folder path and upload:
--     tours/eeeeeeee-0000-4000-8000-000000000001/wp01_jaffa_gate.opus
--     tours/eeeeeeee-0000-4000-8000-000000000001/wp02_tower_of_david.opus
--
-- Then run this, substituting the real size in bytes for each file (Storage shows it):
--
--   UPDATE public.audio_tracks SET size_bytes = <bytes>
--    WHERE id = 'eeeeeeee-0003-4000-8000-000000000001';
--   UPDATE public.audio_tracks SET size_bytes = <bytes>
--    WHERE id = 'eeeeeeee-0003-4000-8000-000000000002';
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
