-- =============================================================================
-- Epic 16 cleanup: tour_plans is service-role only
--
-- STATUS: approved by the PM 6 Oct 2026 ("closing unused vectors is a security
-- priority"). Push with `npx supabase db push`.
--
-- 20261005120000 gave signed-in users SELECT on their own rows
-- (tour_plans_owner_select + GRANT SELECT TO authenticated) for a "my plans"
-- read that never shipped. Nothing uses it: the app reads plans only through
-- the plan-tour Edge Function, which runs as service_role and enforces the
-- same ownership itself (GET: a signed-in user's plan is 404 to anyone else).
-- An unused direct path to a table holding origin_approx is surface without
-- purpose, so both go.
--
-- AFTER THIS: anon and authenticated have no privilege and no policy on
-- tour_plans (RLS stays enabled - a future GRANT without a policy still reads
-- nothing). service_role is unchanged (it bypasses RLS and keeps its grant).
-- delete-account is unaffected: user rows go by ON DELETE CASCADE.
-- WHAT THIS DOES TO EXISTING DATA: nothing.
-- =============================================================================

DROP POLICY IF EXISTS "tour_plans_owner_select" ON public.tour_plans;
REVOKE SELECT ON TABLE public.tour_plans FROM authenticated;

-- Loud if anything still opens it: a later migration re-granting must also
-- change this check, deliberately.
DO $check$
BEGIN
    IF has_table_privilege('authenticated', 'public.tour_plans', 'SELECT')
       OR has_table_privilege('anon', 'public.tour_plans', 'SELECT') THEN
        RAISE EXCEPTION 'tour_plans is still readable by anon/authenticated';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'tour_plans') THEN
        RAISE EXCEPTION 'tour_plans still has a row-level policy';
    END IF;
END
$check$;
