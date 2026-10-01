-- =============================================================================
-- Epic 15 (security): seal every CMS RPC from anon at the GRANT layer
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
--
-- WHY. Supabase's default privileges GRANT EXECUTE on every new function in
-- public to anon and authenticated BY NAME. `REVOKE ... FROM PUBLIC`, which
-- every cms_* migration ran, does not touch a by-name grant - so anon could
-- call all of them, and assert_cms_admin() inside each body was the only
-- barrier. One forgotten assert in a future RPC would have been a public write.
--
--   1. REVOKE from PUBLIC and anon on the CMS surface (10 cms_* RPCs and the
--      two admin checks). authenticated keeps EXECUTE: a CMS admin IS an
--      authenticated user, and the database cannot tell an admin from a
--      tourist by role - assert_cms_admin() stays the authority for them.
--   2. Default privileges: functions created by postgres from now on are NOT
--      executable by anon, authenticated or PUBLIC until a migration GRANTs it.
--      Forgetting a GRANT fails loudly ("permission denied"); forgetting a
--      REVOKE, which is what happened here, fails silently.
--   3. Self-check: the migration aborts unless both took effect.
--
-- DELIBERATELY STILL EXECUTABLE BY anon - RLS and Storage policies, or the
-- anon bundle download, call these:
--   get_tour_bundle, transcript_path_for, tour_is_published,
--   waypoint_is_published, chapter_is_published, audio_object_is_published,
--   audience_tag_vocabulary, interest_tag_vocabulary (CHECK constraints)
-- Every policy that calls is_cms_admin() is TO authenticated, so anon never
-- evaluates it.
--
-- Trigger functions are unaffected: a trigger fires whatever EXECUTE the
-- writing role holds (privilege is checked only at CREATE TRIGGER).
--
-- WHAT THIS DOES TO EXISTING ROWS: nothing. Privileges only.
--
-- CLIENT-VISIBLE CHANGE: anon calling a cms_* RPC is now refused before the
-- function runs. backend/scripts/verify-bundle.ts asserts that, and test-cms
-- fails if a future cms_* function is created without being sealed.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. The CMS surface
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.cms_normalise_tags(text[], text[], text)                             FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_publish_tour(uuid)                                               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, integer, integer, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb)                               FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_replace_tour_waypoints(uuid, jsonb)                              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_set_tour_city(uuid, uuid)                                        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_set_tour_route(uuid, text, integer)                              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_set_tour_status(uuid, text)                                      FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, integer, text[], text[])     FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.cms_validate_tour(uuid)                                              FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.assert_cms_admin()                                                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_cms_admin()                                                       FROM PUBLIC, anon;

-- What the CMS admin's role must keep. Already true; stated so this file is
-- the whole truth about who may call these.
GRANT EXECUTE ON FUNCTION public.cms_normalise_tags(text[], text[], text)                             TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_publish_tour(uuid)                                               TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, integer, integer, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb)                               TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_replace_tour_waypoints(uuid, jsonb)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_set_tour_city(uuid, uuid)                                        TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_set_tour_route(uuid, text, integer)                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_set_tour_status(uuid, text)                                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, integer, text[], text[])     TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_validate_tour(uuid)                                              TO authenticated;
GRANT EXECUTE ON FUNCTION public.assert_cms_admin()                                                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_cms_admin()                                                       TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Default privileges for functions created from now on
--
-- The per-schema form can only remove what a per-schema default ADDED (the
-- by-name anon/authenticated grants). The built-in EXECUTE-to-PUBLIC default
-- is global, so it needs the second, schema-less statement.
--
-- From here on a migration that creates a function must GRANT it. A
-- CREATE OR REPLACE keeps the existing ACL; DROP + CREATE does not.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
    REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- 3. Self-check. Aborts the migration (and with it this transaction) rather
--    than report success over an open grant.
--
--    (a) No CMS function - including any overload or cms_* added since this
--        file was written - is executable by anon.
--    (b) A function created now, by the role running this migration, is born
--        closed. This fails if migrations run as a role other than postgres,
--        for which section 2 would silently do nothing.
-- -----------------------------------------------------------------------------
DO $check$
DECLARE
    v_open text;
BEGIN
    SELECT string_agg(p.oid::regprocedure::text, ', ')
      INTO v_open
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'cms\_%' OR p.proname IN ('assert_cms_admin', 'is_cms_admin'))
       AND has_function_privilege('anon', p.oid, 'EXECUTE');

    IF v_open IS NOT NULL THEN
        RAISE EXCEPTION 'CMS functions still executable by anon: %', v_open;
    END IF;

    CREATE FUNCTION public.zz_default_acl_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
    IF has_function_privilege('anon', 'public.zz_default_acl_probe()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.zz_default_acl_probe()', 'EXECUTE') THEN
        RAISE EXCEPTION 'Default privileges did not apply: a new function created by % is still executable by anon/authenticated.',
            current_user;
    END IF;
    DROP FUNCTION public.zz_default_acl_probe();
END;
$check$;

-- PostgREST caches the schema; make it see the new privileges now.
NOTIFY pgrst, 'reload schema';
