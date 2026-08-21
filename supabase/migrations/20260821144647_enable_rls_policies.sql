-- =============================================================================
-- TASK-303 : Row Level Security
--
-- NOT IN THE ORIGINAL SPEC - added because the move to Supabase changes the
-- threat model. Under the previous architecture these tables sat behind our own
-- API server. On Supabase they are published through PostgREST and reachable by
-- anyone holding the anon key - and the anon key ships inside the mobile app,
-- so it must be treated as public.
--
-- With RLS disabled, that key grants full SELECT/INSERT/UPDATE/DELETE on every
-- table here. `DELETE FROM tours` from a phone would wipe the catalogue.
--
-- Posture chosen:
--   * Tour content is a public catalogue -> anon and authenticated may SELECT.
--   * No write policies at all. service_role bypasses RLS, so the content
--     pipeline still writes freely, while clients cannot.
--
-- If the PM wants tours to be private, or per-user owned, this is the file to
-- change - drop the anon grant and add an owner_id column + auth.uid() check.
-- Delete this migration entirely if you disagree with the posture; nothing else
-- depends on it.
-- =============================================================================

ALTER TABLE public.tours          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.waypoints      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.geofence_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_tracks   ENABLE ROW LEVEL SECURITY;

-- --- Public read access -------------------------------------------------------
-- TO anon, authenticated: named roles keep the policy from applying to
-- postgres/service_role, and make the intent explicit in the dashboard.

CREATE POLICY "Public read access to tours"
    ON public.tours FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Public read access to waypoints"
    ON public.waypoints FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Public read access to geofence zones"
    ON public.geofence_zones FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Public read access to audio tracks"
    ON public.audio_tracks FOR SELECT
    TO anon, authenticated
    USING (true);

-- No INSERT / UPDATE / DELETE policies are defined. RLS denies by default, so
-- writes are impossible for anon and authenticated while remaining unrestricted
-- for service_role.
