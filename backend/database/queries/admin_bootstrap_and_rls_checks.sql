-- =============================================================================
-- TASK-302 : Admin bootstrap + RLS verification
--
-- Run these in the Supabase SQL editor, which executes as `postgres` and so
-- bypasses RLS. None of this belongs in a migration: the bootstrap needs a real
-- user id that does not exist until someone is invited, and the checks are
-- diagnostics rather than schema.
-- =============================================================================


-- =============================================================================
-- PART 1 - CREATING THE FIRST ADMIN
--
-- There is deliberately no self-service path into app_admins. That is the point
-- of the table: if a user could add themselves, it would be worth exactly as
-- much as the user_metadata claim it replaced.
--
-- Step 1. Create the account. Dashboard > Authentication > Users > "Invite
--         user" (or the admin API). This works even with enable_signup = false,
--         because it runs with service_role - which is how admin accounts
--         should be created in any case.
--
-- Step 2. Grant. Below.
-- =============================================================================

-- Look up the id of the invited account first.
SELECT id, email, created_at, last_sign_in_at
FROM auth.users
ORDER BY created_at DESC
LIMIT 10;

-- Then grant, by email rather than by pasting a uuid - fewer ways to grant the
-- wrong person. granted_by is NULL for the first admin, which is accurate:
-- nobody with an account authorised it.
INSERT INTO public.app_admins (user_id, email, granted_by, note)
SELECT u.id, u.email, NULL, 'Founding CMS admin - TASK-302 bootstrap'
FROM auth.users u
WHERE u.email = 'REPLACE_ME@example.com'
ON CONFLICT (user_id) DO NOTHING;

-- Subsequent admins, attributed to whoever authorised them.
-- INSERT INTO public.app_admins (user_id, email, granted_by, note)
-- SELECT u.id, u.email,
--        (SELECT id FROM auth.users WHERE email = 'granting.admin@example.com'),
--        'Content editor - approved by PM 2026-08-27'
-- FROM auth.users u
-- WHERE u.email = 'new.admin@example.com'
-- ON CONFLICT (user_id) DO NOTHING;

-- Revoking. Takes effect on the admin's NEXT REQUEST, not at token expiry -
-- that immediacy is the whole reason this is a table rather than a JWT claim.
-- DELETE FROM public.app_admins WHERE email = 'former.admin@example.com';

-- The current roster. Worth reviewing on a schedule; this is the list of
-- accounts that can delete the catalogue.
SELECT a.email, a.granted_at, g.email AS granted_by, a.note
FROM public.app_admins a
LEFT JOIN auth.users g ON g.id = a.granted_by
ORDER BY a.granted_at;


-- =============================================================================
-- PART 2 - VERIFYING THE POLICIES
--
-- RLS bugs are quiet. A policy that is too permissive returns MORE rows and
-- looks like everything is working, so it is never noticed by ordinary use.
-- These checks assert the negative case, which is the one that matters.
--
-- Run as `postgres`; the role is switched explicitly inside each transaction.
-- =============================================================================

-- --- Setup: one draft tour to probe with -------------------------------------
-- Run once, then the checks below, then the teardown at the end.
INSERT INTO public.tours (id, title, topology, transit_mode, duration_minutes, status)
VALUES ('00000000-dead-4000-8000-000000000001',
        '[RLS PROBE] draft tour - delete me',
        'in_city', 'walking', 30, 'draft')
ON CONFLICT (id) DO UPDATE SET status = 'draft';

INSERT INTO public.waypoints (id, tour_id, name, poi_type, geom, sort_order)
VALUES ('00000000-dead-4000-8000-000000000002',
        '00000000-dead-4000-8000-000000000001',
        '[RLS PROBE] secret waypoint', 'anchor',
        ST_SetSRID(ST_MakePoint(35.2279, 31.7766), 4326), 1)
ON CONFLICT (id) DO NOTHING;


-- --- Check 1: anon cannot see draft tours ------------------------------------
-- EXPECT: 0 rows.
BEGIN;
  SET LOCAL ROLE anon;
  SELECT count(*) AS should_be_zero
  FROM public.tours WHERE status <> 'published';
ROLLBACK;


-- --- Check 2: anon cannot see a draft tour's waypoints ------------------------
-- This is the one that catches the nearest_waypoints() leak. A policy that
-- gates only `tours` on status passes Check 1 and FAILS here.
-- EXPECT: 0 rows.
BEGIN;
  SET LOCAL ROLE anon;
  SELECT count(*) AS should_be_zero
  FROM public.waypoints
  WHERE tour_id = '00000000-dead-4000-8000-000000000001';
ROLLBACK;


-- --- Check 3: the same leak through the RPC ----------------------------------
-- Queries waypoints directly, so it is the realistic attack path rather than a
-- hand-written SELECT.
-- EXPECT: no row named '[RLS PROBE] secret waypoint'.
BEGIN;
  SET LOCAL ROLE anon;
  SELECT * FROM public.nearest_waypoints(35.2279, 31.7766, 1000, 50);
ROLLBACK;


-- --- Check 4: anon cannot write ----------------------------------------------
-- EXPECT: "new row violates row-level security policy".
BEGIN;
  SET LOCAL ROLE anon;
  INSERT INTO public.tours (title, topology, transit_mode, duration_minutes)
  VALUES ('anon should not manage this', 'in_city', 'walking', 10);
ROLLBACK;


-- --- Check 5: a signed-up non-admin cannot write ------------------------------
-- THE IMPORTANT ONE. Anyone can obtain this role by calling signUp(), so this
-- asserts that `authenticated` on its own grants nothing.
--
-- request.jwt.claims is what auth.uid() reads; setting it impersonates a signed
-- -in user with no app_admins row.
-- EXPECT: the SELECT sees only published rows, and the INSERT is refused.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
      '{"sub":"11111111-2222-4000-8000-000000000000","role":"authenticated"}';

  SELECT count(*) AS should_be_zero
  FROM public.tours WHERE status <> 'published';

  INSERT INTO public.tours (title, topology, transit_mode, duration_minutes)
  VALUES ('a random signup should not manage this', 'in_city', 'walking', 10);
ROLLBACK;


-- --- Check 6: is_cms_admin() cannot be spoofed from the client ----------------
-- user_metadata is client-writable, so a policy trusting it would be a privilege
-- escalation. Assert that stuffing a role claim there changes nothing.
-- EXPECT: false.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{
      "sub":"11111111-2222-4000-8000-000000000000",
      "role":"authenticated",
      "user_metadata":{"role":"admin","is_admin":true}
  }';
  SELECT public.is_cms_admin() AS should_be_false;
ROLLBACK;


-- --- Check 7: a real admin CAN see drafts and write ---------------------------
-- Replace the sub with a uuid that actually exists in app_admins, or this
-- reports a false failure.
-- EXPECT: at least 1 draft visible, and the INSERT succeeds.
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims =
--       '{"sub":"<REAL-ADMIN-UUID>","role":"authenticated"}';
--   SELECT count(*) AS should_be_at_least_one
--   FROM public.tours WHERE status <> 'published';
--   INSERT INTO public.tours (title, topology, transit_mode, duration_minutes)
--   VALUES ('admin write probe', 'in_city', 'walking', 10);
-- ROLLBACK;


-- --- Check 8: storage enumeration is closed -----------------------------------
-- EXPECT: 0 rows. Before this migration, anon saw every object in the bucket.
BEGIN;
  SET LOCAL ROLE anon;
  SELECT count(*) AS should_be_zero
  FROM storage.objects WHERE bucket_id = 'audio-tracks';
ROLLBACK;


-- --- Teardown ----------------------------------------------------------------
DELETE FROM public.tours WHERE id = '00000000-dead-4000-8000-000000000001';


-- =============================================================================
-- PART 3 - STANDING AUDIT
--
-- Run after any migration that touches policies. Both queries should return
-- nothing; anything they do return is a finding.
-- =============================================================================

-- Any RLS-enabled table in `public` with NO policies at all is either
-- deliberately deny-all (app_admins) or an accident. Anything else here is a
-- table the CMS silently cannot write.
SELECT c.relname AS table_with_rls_but_no_policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relrowsecurity
  AND NOT EXISTS (SELECT 1 FROM pg_policies p
                  WHERE p.schemaname = 'public' AND p.tablename = c.relname)
ORDER BY 1;

-- Any table in `public` published through PostgREST with RLS switched OFF.
-- Every row of this result is world-readable and world-writable via the anon
-- key. This should always be empty.
SELECT c.relname AS table_without_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND NOT c.relrowsecurity
ORDER BY 1;

-- Any policy that references user_metadata - client-writable, therefore a
-- privilege-escalation bug wherever it appears in a USING or WITH CHECK clause.
-- This should always be empty.
SELECT schemaname, tablename, policyname
FROM pg_policies
WHERE coalesce(qual, '') LIKE '%user_metadata%'
   OR coalesce(with_check, '') LIKE '%user_metadata%';
