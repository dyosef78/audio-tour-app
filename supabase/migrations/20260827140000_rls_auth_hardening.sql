-- =============================================================================
-- TASK-302 : Authentication and API security layer
--
-- STATUS: DRAFT - awaiting approval. Do not push.
--
-- Replaces the interim posture from 20260821144647_enable_rls_policies.sql,
-- which granted blanket public SELECT on everything and defined no writes at
-- all. That was correct for Epic 1/2, when the only client was read-only and
-- the only writer was service_role. TASK-303 introduces a CMS that writes with
-- a USER token, and the interim posture has no way to express "this user may
-- write and that one may not".
--
-- THE THREAT MODEL, RESTATED
--
-- The anon key ships inside the mobile app, so `anon` is the whole internet.
-- That much was already documented. What was NOT accounted for:
--
--   auth.enable_signup = true  AND  auth.email.enable_confirmations = false
--
-- Anyone holding the anon key can call signUp() with an unverified address and
-- hold an `authenticated` JWT one round trip later. So `authenticated` is ALSO
-- the whole internet, just one HTTP call further away.
--
-- The consequence governs this entire migration: a policy written
-- `TO authenticated` grants the public. Admin access must therefore be a
-- POSITIVE grant, recorded in a table that only service_role can write, and
-- never inferred from the mere existence of a session.
--
-- Sections:
--   1. tours.status        - "published" is a concept the schema did not have
--   2. Admin identity      - app_admins + is_cms_admin()
--   3. Publication helpers - child tables inherit their tour's visibility
--   4. Table policies      - the four content tables
--   5. Storage policies    - closes an object-enumeration hole
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. tours.status
--
-- The requirement is "public read access for ACTIVE tours". The schema has no
-- notion of active - every tour is equally visible, and the interim policy said
-- USING (true). That is fine while the only tours are ones we seeded by hand.
-- It stops being fine the moment the CMS lands: a tour is world-readable from
-- the instant it is created, so every half-written draft, every embargoed
-- opening, and every internal test tour is live to anyone with the anon key.
--
-- Default is 'draft'. Publication must be a deliberate act; the failure mode of
-- forgetting to publish is a tour nobody can see, which someone will notice and
-- report. The failure mode of the opposite default is a leak nobody notices.
--
-- 'archived' exists so unpublishing is not spelled DELETE. Archived behaves as
-- unpublished for every policy below.
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';

-- Backfill. Every tour that exists today is already world-readable under the
-- interim USING (true) policy, so marking them published changes no exposure -
-- it preserves the status quo. Without this the mobile client goes blank on
-- deploy, because every existing row would land on the 'draft' default.
UPDATE public.tours SET status = 'published' WHERE status = 'draft';

ALTER TABLE public.tours
    ADD CONSTRAINT tours_status_check
        CHECK (status IN ('draft', 'published', 'archived'));

COMMENT ON COLUMN public.tours.status IS
    'Publication state. Only published tours are visible to anon/authenticated; draft and archived are admin-only. Defaults to draft - publishing is deliberate.';

-- Partial index: the public catalogue query only ever asks for published rows,
-- and a partial index stays small as archived content accumulates.
CREATE INDEX IF NOT EXISTS idx_tours_status_published
    ON public.tours (status) WHERE status = 'published';

-- -----------------------------------------------------------------------------
-- 2. Admin identity
--
-- WHY A TABLE AND NOT A JWT CLAIM
--
-- Three options were considered:
--
--   (a) auth.jwt() -> 'user_metadata' ->> 'role'.  NEVER. user_metadata is
--       writable by the user who owns the session:
--           supabase.auth.updateUser({ data: { role: 'admin' } })
--       Any signed-up account promotes itself to admin in one client-side call.
--       This is the single most common Supabase RLS vulnerability and it is
--       spelled almost identically to the safe version below, which is exactly
--       why it keeps happening. If you see user_metadata in a policy in this
--       project, it is a bug.
--
--   (b) auth.jwt() -> 'app_metadata' ->> 'role'.  Safe from tampering -
--       app_metadata is service_role-only - but it is baked into the JWT at
--       issue time. With jwt_expiry = 3600, revoking an admin leaves them fully
--       privileged for up to an hour. For a role that can delete the entire
--       catalogue, an hour is too long.
--
--   (c) A table, consulted per request. Chosen. Revocation is immediate, the
--       grant is auditable (who granted it, when, why), and the check cannot be
--       influenced by anything the client sends.
--
-- The cost is one indexed lookup per query - not per row; see the note on
-- (SELECT ...) wrapping in section 4.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_admins (
    user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email      text,
    granted_at timestamptz NOT NULL DEFAULT now(),
    granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    note       text
);

COMMENT ON TABLE public.app_admins IS
    'CMS administrators. Writable only by service_role - there is deliberately no policy allowing a user to add themselves. Membership is checked live by is_cms_admin(), so revocation takes effect on the next request rather than at token expiry.';

-- RLS on with NO policies: denies everything to anon and authenticated. The
-- admin roster is itself sensitive - it names the accounts worth phishing.
ALTER TABLE public.app_admins ENABLE ROW LEVEL SECURITY;

-- Defence in depth. RLS already denies, but PostgREST exposes every table in
-- `public`, and a future migration that adds a policy here by mistake would
-- immediately publish the roster. With the grant removed, such a mistake fails
-- closed instead. is_cms_admin() is SECURITY DEFINER and runs as the owner, so
-- it is unaffected.
REVOKE ALL ON public.app_admins FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- is_cms_admin()
--
-- SECURITY DEFINER so it can read app_admins despite that table's deny-all RLS.
-- Without it, the policies below would evaluate against a table the caller
-- cannot see and every admin check would silently return false.
--
-- SET search_path is mandatory on a SECURITY DEFINER function, not stylistic.
-- Without it the caller controls search_path and can prepend a schema holding
-- their own app_admins table, which this function would then read while running
-- as the owner. pg_temp is pinned last for the same reason.
--
-- The is_anonymous guard is belt-and-braces. Anonymous sign-ins are disabled
-- today and a guest uuid could never appear in app_admins anyway, but see
-- section 3 of the handover: anonymous users authenticate as `authenticated`,
-- not `anon`, and that trap deserves to be visible in the code rather than
-- only in a document.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_cms_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
    SELECT
        coalesce(auth.jwt() ->> 'is_anonymous', 'false') <> 'true'
        AND EXISTS (
            SELECT 1 FROM public.app_admins a WHERE a.user_id = auth.uid()
        );
$fn$;

COMMENT ON FUNCTION public.is_cms_admin() IS
    'True when the calling user is a CMS administrator. Takes no argument and reports only on the caller, so it is not an enumeration oracle. Checked live against app_admins, so revoking admin takes effect immediately rather than at token expiry.';

-- Functions are EXECUTE-able by PUBLIC on creation. Narrow it: anon can never
-- be an admin, so anon has no reason to call this.
REVOKE ALL ON FUNCTION public.is_cms_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_cms_admin() TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Publication helpers
--
-- Child rows must inherit their tour's visibility. This is not theoretical
-- tidiness - nearest_waypoints() queries public.waypoints DIRECTLY, without
-- touching tours. If only the tours policy gated on status, that RPC would
-- happily return the name and exact coordinates of every waypoint in every
-- unpublished draft to any anonymous caller. get_tour_bundle() happens to be
-- safe because it CROSS JOINs tours, but relying on the shape of one query for
-- a security property is how the next query becomes a leak.
--
-- SECURITY DEFINER here avoids evaluating the tours policy inside the waypoints
-- policy. Nested policy evaluation is legal but it makes the effective rule
-- hard to reason about, and it is one refactor away from recursion.
--
-- Both functions require a uuid the caller already holds and return only a
-- boolean, so they disclose publication state and nothing else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tour_is_published(p_tour_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
    SELECT EXISTS (
        SELECT 1 FROM public.tours t
        WHERE t.id = p_tour_id AND t.status = 'published'
    );
$fn$;

CREATE OR REPLACE FUNCTION public.waypoint_is_published(p_waypoint_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
    SELECT EXISTS (
        SELECT 1
        FROM public.waypoints w
        JOIN public.tours t ON t.id = w.tour_id
        WHERE w.id = p_waypoint_id AND t.status = 'published'
    );
$fn$;

REVOKE ALL ON FUNCTION public.tour_is_published(uuid)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public.waypoint_is_published(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tour_is_published(uuid)     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.waypoint_is_published(uuid) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Table policies
--
-- Out with the interim blanket-read policies.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public read access to tours"          ON public.tours;
DROP POLICY IF EXISTS "Public read access to waypoints"      ON public.waypoints;
DROP POLICY IF EXISTS "Public read access to geofence zones" ON public.geofence_zones;
DROP POLICY IF EXISTS "Public read access to audio tracks"   ON public.audio_tracks;

-- NOTE ON (SELECT public.is_cms_admin())
--
-- The subquery wrapper is a performance fix, not a style choice. A bare
-- is_cms_admin() in a USING clause is evaluated ONCE PER ROW; wrapped in a
-- scalar subquery the planner hoists it into an InitPlan and evaluates it once
-- per statement. On a catalogue-wide admin query the difference is one lookup
-- versus one per row. The same applies to auth.uid() and auth.jwt().
--
-- Policies are PERMISSIVE, so they OR together: an admin reading tours matches
-- the admin policy and sees drafts; the public policy independently admits
-- published rows to everyone.

-- --- tours -------------------------------------------------------------------
CREATE POLICY "tours_read_published"
    ON public.tours FOR SELECT
    TO anon, authenticated
    USING (status = 'published');

CREATE POLICY "tours_admin_write"
    ON public.tours FOR ALL
    TO authenticated
    USING       ((SELECT public.is_cms_admin()))
    WITH CHECK  ((SELECT public.is_cms_admin()));

-- --- waypoints ---------------------------------------------------------------
CREATE POLICY "waypoints_read_published"
    ON public.waypoints FOR SELECT
    TO anon, authenticated
    USING (public.tour_is_published(tour_id));

CREATE POLICY "waypoints_admin_write"
    ON public.waypoints FOR ALL
    TO authenticated
    USING       ((SELECT public.is_cms_admin()))
    WITH CHECK  ((SELECT public.is_cms_admin()));

-- --- geofence_zones ----------------------------------------------------------
CREATE POLICY "geofence_zones_read_published"
    ON public.geofence_zones FOR SELECT
    TO anon, authenticated
    USING (public.waypoint_is_published(waypoint_id));

CREATE POLICY "geofence_zones_admin_write"
    ON public.geofence_zones FOR ALL
    TO authenticated
    USING       ((SELECT public.is_cms_admin()))
    WITH CHECK  ((SELECT public.is_cms_admin()));

-- --- audio_tracks ------------------------------------------------------------
CREATE POLICY "audio_tracks_read_published"
    ON public.audio_tracks FOR SELECT
    TO anon, authenticated
    USING (public.waypoint_is_published(waypoint_id));

CREATE POLICY "audio_tracks_admin_write"
    ON public.audio_tracks FOR ALL
    TO authenticated
    USING       ((SELECT public.is_cms_admin()))
    WITH CHECK  ((SELECT public.is_cms_admin()));

-- -----------------------------------------------------------------------------
-- 5. Storage policies
--
-- TWO SEPARATE READ PATHS, ONLY ONE OF WHICH RLS GOVERNS:
--
--   /storage/v1/object/public/audio-tracks/<path>
--       The bucket is public = true, so this path serves from the CDN with no
--       Authorization header and NO RLS EVALUATION AT ALL. Policies here cannot
--       restrict it. It is what the mobile client uses via getPublicUrl().
--
--   The Storage API - list(), download() with a session
--       This path DOES consult storage.objects policies.
--
-- The interim policy granted SELECT on this bucket to `anon`, which means
-- anyone holding the anon key could call
--     supabase.storage.from('audio-tracks').list('tours')
-- and enumerate every object in the bucket, published or not. Object paths are
-- structured (tours/<tour_id>/wpNN_name.m4a), so that listing also leaks tour
-- ids and waypoint names for unpublished content. Once the CMS starts staging
-- draft audio in this bucket, that is a straightforward content leak.
--
-- Verified before removing it: the mobile client does not use the Storage API.
-- client.ts calls getPublicUrl(), which is a pure client-side string builder
-- that makes no request and consults no policy, and the download then goes over
-- the public CDN path. The one .list() in TourBundleRepository.ts is on a local
-- expo-file-system Directory, not on Storage. So dropping this policy costs the
-- mobile client nothing.
--
-- KNOWN RESIDUAL RISK, NOT CLOSED HERE: because the bucket is public, an object
-- whose path is known stays fetchable even when its tour is unpublished. Fixing
-- that means a private bucket plus signed URLs, which changes the offline
-- download path in the mobile client. Raised as a TASK-303 decision in the
-- handover rather than smuggled into an RLS migration.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Public read access to audio-tracks objects" ON storage.objects;

-- Admins get the Storage API; everyone else keeps only the public CDN path.
CREATE POLICY "audio_tracks_admin_read"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'audio-tracks' AND (SELECT public.is_cms_admin()));

CREATE POLICY "audio_tracks_admin_insert"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'audio-tracks' AND (SELECT public.is_cms_admin()));

CREATE POLICY "audio_tracks_admin_update"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING       (bucket_id = 'audio-tracks' AND (SELECT public.is_cms_admin()))
    WITH CHECK  (bucket_id = 'audio-tracks' AND (SELECT public.is_cms_admin()));

CREATE POLICY "audio_tracks_admin_delete"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'audio-tracks' AND (SELECT public.is_cms_admin()));
