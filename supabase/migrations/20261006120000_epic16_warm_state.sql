-- =============================================================================
-- Epic 16 Part 4: get_warm_state - the cost reconciler's one read
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
--
-- warm-costs (Edge Function) keeps chapter_leg_costs and chapter_travel_matrix
-- warm by RECONCILING, not by reacting to events (PM, 4 Oct 2026): it computes
-- the cells a city needs from current state, compares them with the rows that
-- exist (coords_key checked in TypeScript, by the one shared formatter), and
-- fills a bounded batch. Nothing to enqueue, so nothing can be missed: a CMS
-- edit, a cascade or an invalidation trigger simply shows up as missing.
--
-- get_planner_candidates cannot serve this: it prunes by one visitor's origin,
-- budget, mode, audience and interests. The reconciler needs EVERY plannable
-- chapter of every published tour in the city, and every cached row for them.
--
-- WHAT THIS MIGRATION DOES TO EXISTING DATA: nothing. One function.
-- ACCESS: service_role only (it reads the service-role-only cost tables).
-- =============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.get_warm_state(p_city_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_result jsonb;
BEGIN
    IF p_city_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.cities c WHERE c.id = p_city_id) THEN
        RAISE EXCEPTION 'City % not found.', p_city_id USING ERRCODE = 'no_data_found';
    END IF;

    -- Plannable chapters of PUBLISHED tours (service_role bypasses RLS, so
    -- the status predicate is the authority, as in get_planner_candidates).
    WITH chapters AS (
        SELECT c.id, c.tour_id, c.transit_mode, c.entry_point, c.exit_point,
               CASE c.transit_mode WHEN 'walking' THEN 'pedestrian' WHEN 'biking' THEN 'bicycle' ELSE 'auto' END AS profile
          FROM public.tour_chapters c
          JOIN public.tours t ON t.id = c.tour_id
         WHERE t.city_id = p_city_id
           AND t.status = 'published'
           AND c.plannable
    )
    SELECT jsonb_build_object(
        'chapters', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'chapter_id',   ch.id,
                'tour_id',      ch.tour_id,
                'transit_mode', ch.transit_mode,
                'profile',      ch.profile,
                'entry',        jsonb_build_array(ST_X(ch.entry_point), ST_Y(ch.entry_point)),
                'exit',         jsonb_build_array(ST_X(ch.exit_point),  ST_Y(ch.exit_point)),
                'stops', coalesce((
                    SELECT jsonb_agg(jsonb_build_object(
                        'waypoint_id', w.id,
                        'sort_order',  w.sort_order,
                        'stop_role',   w.stop_role,
                        'coordinates', jsonb_build_array(ST_X(w.geom), ST_Y(w.geom))
                    ) ORDER BY w.sort_order, w.id)
                    FROM public.waypoints w
                    WHERE w.chapter_id = ch.id
                ), '[]'::jsonb)
            ) ORDER BY ch.id)
            FROM chapters ch
        ), '[]'::jsonb),
        -- Every cached leg of these chapters, in the chapter's own profile.
        'legs', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'chapter_id', l.chapter_id, 'from_node', l.from_node, 'to_node', l.to_node,
                'profile', l.profile, 'unroutable', l.duration_seconds IS NULL, 'coords_key', l.coords_key
            ) ORDER BY l.chapter_id, l.from_node, l.to_node)
            FROM public.chapter_leg_costs l
            JOIN chapters ch ON ch.id = l.chapter_id AND ch.profile = l.profile
        ), '[]'::jsonb),
        -- Every cached transfer between them, any profile.
        'transfers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'from_chapter_id', m.from_chapter_id, 'to_chapter_id', m.to_chapter_id,
                'profile', m.profile, 'unroutable', m.duration_seconds IS NULL, 'coords_key', m.coords_key
            ) ORDER BY m.from_chapter_id, m.to_chapter_id, m.profile)
            FROM public.chapter_travel_matrix m
            WHERE m.from_chapter_id IN (SELECT id FROM chapters)
              AND m.to_chapter_id   IN (SELECT id FROM chapters)
        ), '[]'::jsonb)
    )
    INTO v_result;

    RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION public.get_warm_state(uuid) IS
    'Epic 16 Part 4: every plannable chapter of every published tour in a city (stops, entry/exit) and every cached leg/transfer for them - the warm-costs reconciler''s one read. service_role only.';

REVOKE ALL ON FUNCTION public.get_warm_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_warm_state(uuid) TO service_role;

DO $check$
BEGIN
    IF has_function_privilege('anon', 'public.get_warm_state(uuid)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.get_warm_state(uuid)', 'EXECUTE') THEN
        RAISE EXCEPTION 'get_warm_state is executable by anon or authenticated; it must be service_role only.';
    END IF;
END
$check$;
