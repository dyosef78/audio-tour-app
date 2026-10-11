-- =============================================================================
-- Epic 17 (TASK-1701): make the Tel Aviv QA walk a planner candidate.
--
-- DATA ONLY. No schema, function or grant changes.
--
-- THE BUG: the plan wizard answers "no plans" (422 no_candidates) for Tel Aviv.
-- get_planner_candidates reads only chapters with plannable = true, and
-- 20261005120000 defaulted every existing chapter to false by design (opt-in
-- per chapter). The only Tel Aviv tour, the TASK-508 QA walk seeded through
-- the CMS before Epic 16, was never opted in, so `considered` is 0 before any
-- pruning runs. Verified live 11 Oct 2026: pruned = {} for every request.
--
-- Nothing else blocks it: tour and waypoint audiences/interests are empty,
-- which the RPC treats as unrestricted, and a walking chapter is eligible for
-- walking, biking and driving visitors. A zero interest score does not stop
-- the planner choosing it (sequence.ts accepts any feasible plan over none).
-- There is no "transit-mode weight" column in the schema; mode eligibility is
-- the CASE in get_planner_candidates.
--
-- WHAT THIS DOES TO EXISTING ROWS (exactly one row, when present):
--   tour_chapters a1d4a9cd-...: plannable = true, entry_point = first core stop,
--   exit_point = last core stop (the CMS's documented pre-fill). The tour is a
--   pedestrian walk with no car park, so the first/last stop IS the right
--   arrival/departure point.
--   * bundle_version_hash: UNCHANGED. plannable/entry/exit are not hashed
--     (see 20261005120100 section 1), so no device re-fetches the bundle.
--   * trg_tour_chapters_invalidate_planning_costs fires (entry/exit change
--     from NULL) and deletes cached costs for this chapter. There are none:
--     a non-plannable chapter is never warmed.
--
-- ENVIRONMENTS: the tour exists only in production (created by
-- seed-tel-aviv-qa.ts, never by a SQL seed). On `db reset` (CI, local) it is
-- absent and this migration does nothing, saying so. When it IS present, every
-- precondition is asserted and a violated one aborts the push.
--
-- SELF-CHECK: after the update, get_planner_candidates must return this
-- chapter for every visitor mode x audience x single interest, from the tour's
-- start, at the wizard's smallest budget (60 min). Any miss aborts the push.
-- =============================================================================

SET search_path = public, extensions;

DO $fix$
DECLARE
    c_tour_id    CONSTANT uuid    := 'a1d4a9cd-940e-41bd-8f0c-732f962ee899';
    c_city_slug  CONSTANT text    := 'tel-aviv';
    -- PLAN_MINUTE_CHOICES[0] in mobile/src/services/planner/planForm.ts.
    c_budget_s   CONSTANT integer := 3600;

    v_city_id    uuid;
    v_status     text;
    v_chapter_id uuid;
    v_mode       text;
    v_entry      geometry;
    v_exit       geometry;
    v_n          integer;
    v_answer     jsonb;
    v_found      jsonb;
    v_lower      integer;
    v_checks     integer := 0;
    m            text;
    g            text;
    i            text;
BEGIN
    SELECT t.status, t.city_id INTO v_status, v_city_id
      FROM public.tours t WHERE t.id = c_tour_id;
    IF NOT FOUND THEN
        RAISE NOTICE 'TASK-1701: tour % is not in this database (expected outside production); nothing to do.', c_tour_id;
        RETURN;
    END IF;

    -- --- preconditions: the row must still be the one this was written for ---
    IF v_status <> 'published' THEN
        RAISE EXCEPTION 'TASK-1701: tour % is %, expected published; the planner reads published tours only.', c_tour_id, v_status;
    END IF;
    IF v_city_id IS DISTINCT FROM (SELECT c.id FROM public.cities c WHERE c.slug = c_city_slug) THEN
        RAISE EXCEPTION 'TASK-1701: tour % has city_id %, expected the % city.', c_tour_id, v_city_id, c_city_slug;
    END IF;

    SELECT count(*) INTO v_n FROM public.tour_chapters c WHERE c.tour_id = c_tour_id;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TASK-1701: tour % has % chapters, expected 1; endpoints below assume a single chapter.', c_tour_id, v_n;
    END IF;
    SELECT c.id, c.transit_mode INTO v_chapter_id, v_mode
      FROM public.tour_chapters c WHERE c.tour_id = c_tour_id;
    IF v_mode <> 'walking' THEN
        RAISE EXCEPTION 'TASK-1701: chapter % is %, expected walking; a non-walking chapter needs a real car-park entry point.', v_chapter_id, v_mode;
    END IF;

    -- First and last CORE stop in authored order (ties by id, as the RPC orders).
    SELECT w.geom INTO v_entry FROM public.waypoints w
     WHERE w.chapter_id = v_chapter_id AND w.stop_role = 'core'
     ORDER BY w.sort_order, w.id LIMIT 1;
    SELECT w.geom INTO v_exit FROM public.waypoints w
     WHERE w.chapter_id = v_chapter_id AND w.stop_role = 'core'
     ORDER BY w.sort_order DESC, w.id DESC LIMIT 1;
    IF v_entry IS NULL OR v_exit IS NULL THEN
        RAISE EXCEPTION 'TASK-1701: chapter % has no core stop; it cannot be plannable.', v_chapter_id;
    END IF;

    -- --- the fix (one UPDATE, so tour_chapters_plannable_endpoints_check
    -- judges the end state) -------------------------------------------------
    UPDATE public.tour_chapters
       SET plannable   = true,
           entry_point = v_entry,
           exit_point  = v_exit
     WHERE id = v_chapter_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TASK-1701: updated % chapter rows, expected 1.', v_n;
    END IF;

    -- --- self-check through the planner's own read -------------------------
    FOREACH m IN ARRAY ARRAY['walking', 'biking', 'driving'] LOOP
        FOREACH g IN ARRAY public.audience_tag_vocabulary() LOOP
            FOREACH i IN ARRAY public.interest_tag_vocabulary() LOOP
                v_answer := public.get_planner_candidates(
                    v_city_id, ST_X(v_entry), ST_Y(v_entry), m, g, ARRAY[i], c_budget_s, false);
                SELECT x INTO v_found
                  FROM jsonb_array_elements(v_answer -> 'candidates') x
                 WHERE x ->> 'chapter_id' = v_chapter_id::text;
                IF v_found IS NULL THEN
                    RAISE EXCEPTION 'TASK-1701: chapter % is still not a candidate for mode %, group %, interest % (considered %, pruned %).',
                        v_chapter_id, m, g, i, v_answer -> 'considered', v_answer -> 'pruned';
                END IF;
                v_lower := (v_found ->> 'lower_bound_s')::int;
                v_checks := v_checks + 1;
            END LOOP;
        END LOOP;
    END LOOP;

    RAISE NOTICE 'TASK-1701 applied: chapter % plannable, entry %, exit %; candidate in %/% requests; lower_bound_s % of % budget.',
        v_chapter_id, ST_AsText(v_entry), ST_AsText(v_exit), v_checks, v_checks, v_lower, c_budget_s;
END;
$fix$;
