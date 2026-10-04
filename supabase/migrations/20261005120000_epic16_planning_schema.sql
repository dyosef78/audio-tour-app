-- =============================================================================
-- Epic 16 (Part 1 of 2): Geospatial Planning Engine - SCHEMA
--
-- STATUS: design APPROVED by the PM (2 Oct 2026). NOT APPLIED to the linked
-- project. Push together with 20261005120100 (one `db push`).
--
-- A bespoke plan is an ordered chain of whole CHAPTERS (PM decision 1). Inside
-- a chapter, CORE stops are the fixed narrative backbone and EXTENSION stops
-- are optional detours the planner may keep or drop (PM decision 2).
--
--   1. waypoints                  + stop_role, + dwell_seconds
--   2. waypoint_interest_weights  NEW: optional weights over waypoints.interests
--   3. tour_chapters              + plannable, + entry_point, + exit_point
--   4. chapter_travel_matrix      NEW: exit(A) -> entry(B), per transfer profile
--   5. chapter_leg_costs          NEW: entry/stop/exit legs INSIDE a chapter
--   6. tour_plans                 NEW: persisted plan, identity + content_hash
--   7. invalidation triggers      geometry changes delete cached costs
--
-- WHAT THIS MIGRATION DOES TO EXISTING ROWS
--
--   * waypoints: every row becomes 'core' (constant default: metadata-only, no
--     rewrite). Core is today's behaviour - nothing becomes skippable until an
--     editor marks it.
--   * tour_chapters: every row becomes plannable = false. A chapter enters the
--     planner only when an editor opts it in and sets its entry/exit points.
--     Epic 15's "Drive to the site" chapters are transport, not content, and
--     must never be chained by the planner.
--   * bundle_version_hash: UNCHANGED. get_tour_bundle builds explicit keys and
--     reads none of these columns. 20261005120100 then exposes stop_role
--     (hash term NULL while 'core', so still no hash moves).
--   * Seeds: unchanged. Both insert named columns, so the defaults apply.
--
-- ACCESS SUMMARY (see authenticated-role-authorises-nothing)
--
--   waypoint_interest_weights   public content (published) + admin write
--   chapter_travel_matrix       service_role only  (route-poisoning primitive)
--   chapter_leg_costs           service_role only  (same)
--   tour_plans                  owner SELECT; writes service_role only
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. waypoints: Core / Extension
--
-- An extension's SLOT is not stored. It is derived from sort_order: an
-- extension sits between the nearest core before it and the nearest core after
-- it in its chapter (or the chapter's entry/exit point). Reasons:
--   * The editor already places every stop in sort_order; a second "slot"
--     column would be a second source of truth for the same fact.
--   * A shipped app that knows nothing about stop_role plays the FULL tour in
--     authored order, which is a valid tour. A device that falls back degrades
--     to "everything included", never to a nonsense order.
--
-- Transition stops are narrative glue between core stops (PM decision 2), so
-- they can never be skipped.
--
-- dwell_seconds: an editor's override for time spent AT the stop. NULL = the
-- planner derives it (narration length on foot, 0 for a drive-by).
-- -----------------------------------------------------------------------------
ALTER TABLE public.waypoints
    ADD COLUMN IF NOT EXISTS stop_role text NOT NULL DEFAULT 'core'
        CONSTRAINT waypoints_stop_role_check
            CHECK (stop_role IN ('core', 'extension')),
    ADD COLUMN IF NOT EXISTS dwell_seconds integer
        CONSTRAINT waypoints_dwell_seconds_check
            CHECK (dwell_seconds IS NULL OR dwell_seconds BETWEEN 0 AND 7200);

ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_transition_is_core_check
        CHECK (stop_role = 'core' OR poi_type <> 'transition');

COMMENT ON COLUMN public.waypoints.stop_role IS
    'Epic 16. core: always played, the chapter''s narrative backbone. extension: optional, kept by the planner when the visitor''s interests and time allow. An extension''s slot is its position in sort_order between the surrounding core stops.';
COMMENT ON COLUMN public.waypoints.dwell_seconds IS
    'Epic 16. Editor override for time spent at the stop. NULL = derived by the planner from narration length and the chapter''s transit mode.';

-- -----------------------------------------------------------------------------
-- 2. waypoint_interest_weights
--
-- An OVERLAY, not a replacement for waypoints.interests. The array stays the
-- authority on WHICH interests a stop serves: get_tour_bundle, the device's
-- selectStops, the route_legs_cache trigger, cms_replace_tour_waypoints, both
-- seeds and seed-tel-aviv-qa.ts all read or write it. Moving membership into a
-- junction table would mean migrating all of those at once, and seed drift has
-- already shipped three times.
--
-- This table adds only HOW STRONGLY: 1 minor, 2 relevant, 3 primary. A missing
-- row means weight 2. Three steps, because editors can apply a 3-point scale
-- consistently and a float would be false precision.
--
-- Invariant: (waypoint_id, interest) exists only while interest is in that
-- waypoint's array. Enforced on write (2a), and on removal from the array (2b).
-- -----------------------------------------------------------------------------
CREATE TABLE public.waypoint_interest_weights (
    waypoint_id uuid        NOT NULL REFERENCES public.waypoints (id) ON DELETE CASCADE,
    interest    text        NOT NULL
                CONSTRAINT waypoint_interest_weights_vocabulary_check
                    CHECK (interest = ANY (public.interest_tag_vocabulary())),
    weight      smallint    NOT NULL
                CONSTRAINT waypoint_interest_weights_weight_check
                    CHECK (weight BETWEEN 1 AND 3),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (waypoint_id, interest)
);

COMMENT ON TABLE public.waypoint_interest_weights IS
    'Epic 16: optional strength (1 minor, 2 relevant, 3 primary) of an interest a waypoint already lists in waypoints.interests. No row = 2. Membership stays in the array.';

CREATE TRIGGER trg_waypoint_interest_weights_updated_at
    BEFORE UPDATE ON public.waypoint_interest_weights
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 2a. A weight for an interest the stop does not list is a contradiction.
CREATE OR REPLACE FUNCTION public.assert_weighted_interest_listed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.waypoints w
         WHERE w.id = NEW.waypoint_id
           AND NEW.interest = ANY (w.interests)
    ) THEN
        RAISE EXCEPTION 'Waypoint % does not list interest "%"; add it to waypoints.interests before weighting it.',
            NEW.waypoint_id, NEW.interest
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_waypoint_interest_weights_listed
    BEFORE INSERT OR UPDATE OF waypoint_id, interest ON public.waypoint_interest_weights
    FOR EACH ROW EXECUTE FUNCTION public.assert_weighted_interest_listed();

-- 2b. Removing an interest from the array removes its weight.
-- SECURITY DEFINER for the Epic 8 reason: it fires inside CMS and seed writes
-- whatever their role; it deletes only rows of the waypoint being written.
CREATE OR REPLACE FUNCTION public.prune_interest_weights()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
    DELETE FROM public.waypoint_interest_weights x
     WHERE x.waypoint_id = NEW.id
       AND NOT (x.interest = ANY (NEW.interests));
    RETURN NULL;
END;
$fn$;

REVOKE ALL ON FUNCTION public.prune_interest_weights() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_waypoints_prune_interest_weights
    AFTER UPDATE OF interests ON public.waypoints
    FOR EACH ROW
    WHEN (OLD.interests IS DISTINCT FROM NEW.interests)
    EXECUTE FUNCTION public.prune_interest_weights();

-- RLS: public content (published), admin write.
ALTER TABLE public.waypoint_interest_weights ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.waypoint_interest_weights FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.waypoint_interest_weights TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.waypoint_interest_weights TO authenticated;
GRANT ALL ON TABLE public.waypoint_interest_weights TO service_role;

CREATE POLICY "waypoint_interest_weights_read_published"
    ON public.waypoint_interest_weights FOR SELECT
    TO anon, authenticated
    USING (public.waypoint_is_published(waypoint_id));

CREATE POLICY "waypoint_interest_weights_admin_write"
    ON public.waypoint_interest_weights FOR ALL
    TO authenticated
    USING      ((SELECT public.is_cms_admin()))
    WITH CHECK ((SELECT public.is_cms_admin()));

-- -----------------------------------------------------------------------------
-- 3. tour_chapters: plannable, entry_point, exit_point
--
-- plannable: the editor's statement that this chapter stands alone and can be
-- chained after any other. Default false (see header).
--
-- entry_point / exit_point: where a transfer INTO this chapter navigates to,
-- and where the visitor is when the chapter ends. Explicit rather than "the
-- first/last core stop" because the right place to arrive by car is the car
-- park, not the first stop inside a pedestrian old city. The CMS should
-- pre-fill them from the first/last core stop.
--
-- Distinct from Epic 15's `destination`, which is where THIS chapter's own
-- navigation handoff routes to (a driving chapter's end). For a plannable
-- driving chapter with a destination, exit_point will usually equal it;
-- cms_validate_tour (Part 2) warns when they are far apart.
-- -----------------------------------------------------------------------------
ALTER TABLE public.tour_chapters
    ADD COLUMN IF NOT EXISTS plannable   boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS entry_point geometry(Point, 4326),
    ADD COLUMN IF NOT EXISTS exit_point  geometry(Point, 4326);

ALTER TABLE public.tour_chapters
    ADD CONSTRAINT tour_chapters_plannable_endpoints_check
        CHECK (NOT plannable OR (entry_point IS NOT NULL AND exit_point IS NOT NULL));

COMMENT ON COLUMN public.tour_chapters.plannable IS
    'Epic 16: the planner may chain this chapter into a bespoke plan. Requires entry_point and exit_point.';
COMMENT ON COLUMN public.tour_chapters.entry_point IS
    'Epic 16: where a planned transfer into this chapter navigates to (e.g. the car park), not necessarily the first stop.';
COMMENT ON COLUMN public.tour_chapters.exit_point IS
    'Epic 16: where the visitor is when the chapter ends; the origin of the next planned transfer.';

-- -----------------------------------------------------------------------------
-- 4. chapter_travel_matrix
--
-- Transfer cost from the END of chapter A (exit_point) to the START of chapter
-- B (entry_point), in the transfer profile. Directional (one-way streets).
--
-- Row semantics, deliberately three-valued:
--   no row                      never computed  -> planner estimates, flags it,
--                                                  and requests a fill
--   row, duration NULL          Valhalla found no route -> never chain A->B
--                                                  (until the points move)
--   row, duration NOT NULL      a real cost
-- Estimates are NEVER stored: a stored estimate is indistinguishable from the
-- truth on the next read.
--
-- Sparse: the writer computes only pairs within a per-profile radius and only
-- between plannable chapters of the same city. Size bound: 50 chapters x 49 x
-- 3 profiles = 7,350 rows per city.
--
-- coords_key: "lon,lat;lon,lat" (exit of A; entry of B) to 6 decimals, as in
-- route_legs_cache. A reader ignores a row whose key no longer matches the
-- chapters it just loaded - closes the race the invalidation trigger cannot
-- (request loads old points, CMS moves them, request's background write lands).
-- -----------------------------------------------------------------------------
CREATE TABLE public.chapter_travel_matrix (
    from_chapter_id  uuid        NOT NULL REFERENCES public.tour_chapters (id) ON DELETE CASCADE,
    to_chapter_id    uuid        NOT NULL REFERENCES public.tour_chapters (id) ON DELETE CASCADE,
    profile          text        NOT NULL
                     CONSTRAINT chapter_travel_matrix_profile_check
                         CHECK (profile IN ('pedestrian', 'bicycle', 'auto')),
    duration_seconds integer,
    distance_meters  integer,
    coords_key       text        NOT NULL,
    computed_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (from_chapter_id, to_chapter_id, profile),

    CONSTRAINT chapter_travel_matrix_distinct_check
        CHECK (from_chapter_id <> to_chapter_id),
    CONSTRAINT chapter_travel_matrix_unroutable_pairing_check
        CHECK ((duration_seconds IS NULL) = (distance_meters IS NULL)),
    CONSTRAINT chapter_travel_matrix_figures_check
        CHECK (duration_seconds IS NULL OR (duration_seconds >= 0 AND distance_meters >= 0)),
    CONSTRAINT chapter_travel_matrix_coords_key_check
        CHECK (coords_key ~ '^-?[0-9]+\.[0-9]{6},-?[0-9]+\.[0-9]{6};-?[0-9]+\.[0-9]{6},-?[0-9]+\.[0-9]{6}$')
);

-- PK leads with from_chapter_id; this serves "transfers INTO B" and the
-- to_chapter_id cascade.
CREATE INDEX idx_chapter_travel_matrix_to ON public.chapter_travel_matrix (to_chapter_id);

COMMENT ON TABLE public.chapter_travel_matrix IS
    'Epic 16: Valhalla transfer cost exit(from) -> entry(to) per profile. duration NULL = unroutable. No row = not computed. Service role only. Rows whose coords_key no longer matches are ignored by the reader.';

ALTER TABLE public.chapter_travel_matrix ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chapter_travel_matrix FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chapter_travel_matrix TO service_role;

-- -----------------------------------------------------------------------------
-- 5. chapter_leg_costs
--
-- The PM's list stops at the chapter matrix, but the time budget cannot be
-- computed without what happens INSIDE a chapter: keeping extension E between
-- cores A and B costs (A->E + E->B) - (A->B), so the planner needs legs that
-- SKIP stops, which no visitor has ever routed and route_legs_cache therefore
-- never holds (and its polylines carry a 14-day TTL the planner does not want).
--
-- Nodes are 'entry', 'exit' or a waypoint id, because the entry/exit points are
-- not waypoints. Forward-only in authored order: the writer fills every pair
-- (i, j) with i before j that lies inside one slot window - from a node to
-- each later node up to and including the next core. One Valhalla matrix call
-- per chapter at publish; ~25 nodes -> at most ~300 rows.
--
-- profile = the chapter's transit mode. A transit_mode change makes old rows
-- unreachable by key; the trigger deletes them anyway.
-- -----------------------------------------------------------------------------
CREATE TABLE public.chapter_leg_costs (
    chapter_id       uuid        NOT NULL REFERENCES public.tour_chapters (id) ON DELETE CASCADE,
    from_node        text        NOT NULL
                     CONSTRAINT chapter_leg_costs_from_node_check
                         CHECK (from_node ~ '^(entry|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
    to_node          text        NOT NULL
                     CONSTRAINT chapter_leg_costs_to_node_check
                         CHECK (to_node ~ '^(exit|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
    profile          text        NOT NULL
                     CONSTRAINT chapter_leg_costs_profile_check
                         CHECK (profile IN ('pedestrian', 'bicycle', 'auto')),
    duration_seconds integer,
    distance_meters  integer,
    coords_key       text        NOT NULL,
    computed_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (chapter_id, from_node, to_node, profile),

    CONSTRAINT chapter_leg_costs_distinct_check
        CHECK (from_node <> to_node),
    CONSTRAINT chapter_leg_costs_unroutable_pairing_check
        CHECK ((duration_seconds IS NULL) = (distance_meters IS NULL)),
    CONSTRAINT chapter_leg_costs_figures_check
        CHECK (duration_seconds IS NULL OR (duration_seconds >= 0 AND distance_meters >= 0)),
    CONSTRAINT chapter_leg_costs_coords_key_check
        CHECK (coords_key ~ '^-?[0-9]+\.[0-9]{6},-?[0-9]+\.[0-9]{6};-?[0-9]+\.[0-9]{6},-?[0-9]+\.[0-9]{6}$')
);

COMMENT ON TABLE public.chapter_leg_costs IS
    'Epic 16: Valhalla cost of every forward leg inside a plannable chapter that the planner may need, including legs that skip extensions. Nodes: entry | exit | waypoint uuid. Service role only. Same NULL/no-row/coords_key semantics as chapter_travel_matrix.';

ALTER TABLE public.chapter_leg_costs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chapter_leg_costs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.chapter_leg_costs TO service_role;

-- -----------------------------------------------------------------------------
-- 6. tour_plans
--
-- Written ONLY by the plan-tour Edge Function (service role), for anonymous
-- and signed-in callers alike (PM decision 4). Fetched back through the same
-- function, which recomputes content_hash before serving (6c), so no anon
-- table or function access exists at all.
--
-- 6a. Snapshot, not foreign keys. A plan names chapters and waypoints that the
--     CMS may later delete. Every FK option is wrong here:
--       NO ACTION/RESTRICT  an anonymous visitor's plan would block an editor
--                           from deleting a chapter
--       CASCADE             silently deletes the plan from under the device
--       SET NULL            silently mutates it
--     So the plan is a JSON snapshot plus content_hash, and staleness is
--     detected and reported (plan_stale), never repaired in place.
--     chapter_ids is denormalised (uuid[], no FK) for analytics only.
--
-- 6b. Privacy. The request's exact origin is the visitor's live location. It is
--     used in memory to route and never stored: `request` may not carry it
--     (CHECK), and origin_approx is rounded to 3 decimals (~110 m), also
--     CHECKed so a writer bug fails loudly instead of storing a precise fix.
--
-- 6c. content_hash = the first 128 bits of SHA-256 (32 hex: Web Crypto has
--     no MD5) over planner_version, the ordered (chapter_id, [waypoint_id...])
--     list, each chapter's entry/exit point, and each source tour's
--     bundle_version_hash (also stored in source_tour_hashes, so a stale plan
--     can say WHICH tour changed). Computed in shared TypeScript.
--
-- 6d. Feasibility is an invariant, not a hope: a plan whose estimate exceeds
--     its budget cannot be stored.
--
-- 6f. request_hash (PM, 4 Oct 2026): sha256 of the canonical plan request -
--     rounded origin, preferences, user_id, planner version, and a hash of
--     the get_planner_candidates answer. The planner is a pure function of
--     exactly those inputs, so one hash is one plan. UNIQUE makes plan-tour's
--     write an idempotent upsert: a double tap or a retry after a timeout gets
--     the same plan_id, race-free, and repeats do not grow the table.
--
-- 6e. Retention: expires_at is enforced by the reader (410 plan_expired).
--     There is no pg_cron in this project yet; a purge job is a follow-up.
-- -----------------------------------------------------------------------------
CREATE TABLE public.tour_plans (
    id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = anonymous. CASCADE: delete-account must take the user's plans.
    user_id            uuid        REFERENCES auth.users (id) ON DELETE CASCADE,
    city_id            uuid        NOT NULL REFERENCES public.cities (id) ON DELETE RESTRICT,
    contract_version   smallint    NOT NULL
                       CONSTRAINT tour_plans_contract_version_check CHECK (contract_version >= 1),
    planner_version    text        NOT NULL
                       CONSTRAINT tour_plans_planner_version_check CHECK (planner_version ~ '^v[0-9]+$'),
    request            jsonb       NOT NULL
                       CONSTRAINT tour_plans_request_check
                           CHECK (jsonb_typeof(request) = 'object' AND NOT (request ? 'origin')),
    origin_approx      geography(Point, 4326) NOT NULL,
    plan               jsonb       NOT NULL
                       CONSTRAINT tour_plans_plan_check CHECK (jsonb_typeof(plan) = 'object'),
    chapter_ids        uuid[]      NOT NULL
                       CONSTRAINT tour_plans_chapter_ids_check CHECK (cardinality(chapter_ids) >= 1),
    source_tour_hashes jsonb       NOT NULL
                       CONSTRAINT tour_plans_source_tour_hashes_check
                           CHECK (jsonb_typeof(source_tour_hashes) = 'object'),
    content_hash       text        NOT NULL
                       CONSTRAINT tour_plans_content_hash_check CHECK (content_hash ~ '^[0-9a-f]{32}$'),
    request_hash       text        NOT NULL
                       CONSTRAINT tour_plans_request_hash_check CHECK (request_hash ~ '^[0-9a-f]{64}$')
                       CONSTRAINT tour_plans_request_hash_key UNIQUE,
    budget_seconds     integer     NOT NULL
                       CONSTRAINT tour_plans_budget_check CHECK (budget_seconds BETWEEN 900 AND 86400),
    estimated_seconds  integer     NOT NULL
                       CONSTRAINT tour_plans_estimate_check CHECK (estimated_seconds > 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    expires_at         timestamptz NOT NULL,

    CONSTRAINT tour_plans_feasible_check
        CHECK (estimated_seconds <= budget_seconds),
    CONSTRAINT tour_plans_expiry_check
        CHECK (expires_at > created_at),
    CONSTRAINT tour_plans_origin_rounded_check
        CHECK (    ST_X(origin_approx::geometry) = round(ST_X(origin_approx::geometry)::numeric, 3)::double precision
               AND ST_Y(origin_approx::geometry) = round(ST_Y(origin_approx::geometry)::numeric, 3)::double precision)
);

COMMENT ON TABLE public.tour_plans IS
    'Epic 16: a bespoke plan (ordered chapters, kept extensions, transfers, estimate). Written and served only by the plan-tour Edge Function; owners may list their own. A JSON snapshot validated by content_hash, never by FKs. The exact origin is never stored.';

-- "My plans" for a signed-in visitor.
CREATE INDEX idx_tour_plans_user ON public.tour_plans (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
-- The future purge job.
CREATE INDEX idx_tour_plans_expires_at ON public.tour_plans (expires_at);

ALTER TABLE public.tour_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tour_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.tour_plans TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tour_plans TO service_role;

-- Owner pattern. No INSERT/UPDATE/DELETE policy: a client-written plan would
-- let anyone store an "estimate" the planner never produced.
CREATE POLICY "tour_plans_owner_select"
    ON public.tour_plans FOR SELECT
    TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- -----------------------------------------------------------------------------
-- 7. Invalidation
--
-- Storage hygiene on top of coords_key, exactly as route_legs_cache (TASK-801):
-- the trigger deletes what it can see, coords_key catches the race it cannot.
-- SECURITY DEFINER for the same reason: CMS writes run as `authenticated`,
-- which has no privilege on either cost table.
--
-- Only GEOMETRY invalidates. A cost is a function of two points and a profile;
-- sort_order and stop_role change which legs the planner NEEDS, not what any
-- stored leg costs, so a missing leg is computed and nothing is deleted.
-- Values are compared (IS DISTINCT FROM, geom as WKB) because
-- cms_replace_tour_waypoints rewrites every column on every Save.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invalidate_planning_costs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
BEGIN
    IF TG_TABLE_NAME = 'waypoints' THEN
        -- Fires on geom change, chapter move, or delete: drop this stop's legs
        -- from the chapter it was in.
        DELETE FROM public.chapter_leg_costs c
         WHERE c.chapter_id = OLD.chapter_id
           AND (c.from_node = OLD.id::text OR c.to_node = OLD.id::text);

    ELSIF TG_TABLE_NAME = 'tour_chapters' THEN
        IF OLD.transit_mode IS DISTINCT FROM NEW.transit_mode THEN
            DELETE FROM public.chapter_leg_costs c WHERE c.chapter_id = OLD.id;
        ELSE
            IF ST_AsBinary(OLD.entry_point) IS DISTINCT FROM ST_AsBinary(NEW.entry_point) THEN
                DELETE FROM public.chapter_leg_costs c
                 WHERE c.chapter_id = OLD.id AND c.from_node = 'entry';
            END IF;
            IF ST_AsBinary(OLD.exit_point) IS DISTINCT FROM ST_AsBinary(NEW.exit_point) THEN
                DELETE FROM public.chapter_leg_costs c
                 WHERE c.chapter_id = OLD.id AND c.to_node = 'exit';
            END IF;
        END IF;

        IF ST_AsBinary(OLD.exit_point) IS DISTINCT FROM ST_AsBinary(NEW.exit_point) THEN
            DELETE FROM public.chapter_travel_matrix m WHERE m.from_chapter_id = OLD.id;
        END IF;
        IF ST_AsBinary(OLD.entry_point) IS DISTINCT FROM ST_AsBinary(NEW.entry_point) THEN
            DELETE FROM public.chapter_travel_matrix m WHERE m.to_chapter_id = OLD.id;
        END IF;
    END IF;
    RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.invalidate_planning_costs() IS
    'Epic 16: deletes cached planning costs whose endpoints moved (waypoint geom/chapter, chapter entry/exit/transit mode). SECURITY DEFINER because CMS writes run as authenticated, which has no privilege on the cost tables.';

REVOKE ALL ON FUNCTION public.invalidate_planning_costs() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_waypoints_invalidate_planning_costs
    AFTER UPDATE OF geom, chapter_id ON public.waypoints
    FOR EACH ROW
    WHEN (   ST_AsBinary(OLD.geom) IS DISTINCT FROM ST_AsBinary(NEW.geom)
          OR OLD.chapter_id IS DISTINCT FROM NEW.chapter_id)
    EXECUTE FUNCTION public.invalidate_planning_costs();

CREATE TRIGGER trg_waypoints_delete_planning_costs
    AFTER DELETE ON public.waypoints
    FOR EACH ROW
    EXECUTE FUNCTION public.invalidate_planning_costs();

CREATE TRIGGER trg_tour_chapters_invalidate_planning_costs
    AFTER UPDATE OF entry_point, exit_point, transit_mode ON public.tour_chapters
    FOR EACH ROW
    WHEN (   ST_AsBinary(OLD.entry_point) IS DISTINCT FROM ST_AsBinary(NEW.entry_point)
          OR ST_AsBinary(OLD.exit_point)  IS DISTINCT FROM ST_AsBinary(NEW.exit_point)
          OR OLD.transit_mode IS DISTINCT FROM NEW.transit_mode)
    EXECUTE FUNCTION public.invalidate_planning_costs();
