-- =============================================================================
-- TASK-1101 (Epic 11): cities
--
-- Onboarding asks which city the visitor is touring, and Discovery lists that
-- city's tours. Until now the schema had no notion of a city at all.
--
--   1. public.cities        - reference data: slug, display name, country, centre
--   2. tours.city_id        - nullable FK, backfilled by distance
--   3. RLS                  - a city is public only while it has a published tour
--   4. cms_set_tour_city()  - the CMS write path
--   5. cms_validate_tour()  - publishing now requires a city
--
-- Offline bundles are untouched: get_tour_bundle() does not return the city, so
-- bundle_version_hash is unchanged for every existing tour.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. cities
--
-- `center` is geography, like tours.start_point: it exists to answer distance
-- questions (the backfill below, "cities near me" later) in metres.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cities (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug         text NOT NULL UNIQUE
                 CONSTRAINT cities_slug_format_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    name         text NOT NULL
                 CONSTRAINT cities_name_length_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
    country_code text NOT NULL
                 CONSTRAINT cities_country_code_check CHECK (country_code ~ '^[A-Z]{2}$'),
    center       geography(Point, 4326) NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.cities IS
    'Cities a visitor can choose in onboarding. Public only while at least one of its tours is published (cities_read_with_published_tour).';
COMMENT ON COLUMN public.cities.slug IS
    'Stable, URL-safe identifier (e.g. tel-aviv). Rename `name` freely; never the slug.';

-- The one city in production today. Reference data rather than a seed, because
-- the backfill below and the live Tel Aviv tour depend on it.
INSERT INTO public.cities (slug, name, country_code, center)
VALUES ('tel-aviv', 'Tel Aviv', 'IL', ST_SetSRID(ST_MakePoint(34.7818, 32.0853), 4326)::geography)
ON CONFLICT (slug) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. tours.city_id
--
-- NULLABLE, deliberately. cms_upsert_tour() creates tours without one, and its
-- signature is left alone: adding a parameter makes an overload, which is
-- PGRST203 for every existing caller. Publication is where a city becomes
-- mandatory (section 5).
--
-- ON DELETE RESTRICT: deleting a city that still has tours is a mistake, not a
-- cleanup.
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD COLUMN IF NOT EXISTS city_id uuid REFERENCES public.cities (id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_tours_city_id ON public.tours (city_id);

COMMENT ON COLUMN public.tours.city_id IS
    'The city this tour is listed under. NULL only for drafts: cms_validate_tour() refuses to publish without one.';

-- Backfill: the nearest city within 25 km of the tour's start. 25 km keeps Tel
-- Aviv and Jerusalem (~54 km apart) from ever claiming each other's tours. A
-- tour with no start_point (no waypoints) stays NULL, which is correct.
UPDATE public.tours t
   SET city_id = (
         SELECT c.id
           FROM public.cities c
          WHERE ST_DWithin(c.center, t.start_point, 25000)
          ORDER BY ST_Distance(c.center, t.start_point), c.id
          LIMIT 1
       )
 WHERE t.city_id IS NULL
   AND t.start_point IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. RLS
--
-- Public-content pattern: visibility follows publication, never identity. A
-- city with only drafts would put an empty choice in front of visitors, so it
-- stays hidden until its first tour is published. The EXISTS reads tours under
-- the caller's own RLS, which already limits anon to published tours.
-- -----------------------------------------------------------------------------
ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cities_read_with_published_tour"
    ON public.cities FOR SELECT
    TO anon, authenticated
    USING (EXISTS (
        SELECT 1 FROM public.tours t
         WHERE t.city_id = cities.id
           AND t.status = 'published'
    ));

CREATE POLICY "cities_admin_write"
    ON public.cities FOR ALL
    TO authenticated
    USING      ((SELECT public.is_cms_admin()))
    WITH CHECK ((SELECT public.is_cms_admin()));

-- -----------------------------------------------------------------------------
-- 4. cms_set_tour_city()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_set_tour_city(
    p_tour_id uuid,
    p_city_id uuid
)
RETURNS public.tours
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_row public.tours;
BEGIN
    PERFORM public.assert_cms_admin();

    -- No clearing: a published tour with no city would be listed everywhere.
    IF p_city_id IS NULL THEN
        RAISE EXCEPTION 'p_city_id is required.' USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.cities WHERE id = p_city_id) THEN
        RAISE EXCEPTION 'City % not found.', p_city_id USING ERRCODE = 'no_data_found';
    END IF;

    UPDATE public.tours SET city_id = p_city_id WHERE id = p_tour_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_row;
END;
$fn$;

COMMENT ON FUNCTION public.cms_set_tour_city(uuid, uuid) IS
    'Assigns a tour to a city. Required before cms_publish_tour(); cannot be cleared.';

REVOKE ALL ON FUNCTION public.cms_set_tour_city(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_set_tour_city(uuid, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. cms_validate_tour(): the body from 20260916090000 verbatim, plus check 0.
--    Same signature, so CREATE OR REPLACE keeps its grants and adds no overload.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_validate_tour(p_tour_id uuid)
RETURNS TABLE (
    severity    text,
    code        text,
    waypoint_id uuid,
    detail      text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
    -- 0. NEW (TASK-1101). A published tour with no city would be listed under
    --    every city by the app, which cannot know where it belongs. Set one
    --    with cms_set_tour_city() first.
    SELECT 'error'::text, 'tour_without_city'::text, NULL::uuid,
           'Tour has no city; set one with cms_set_tour_city() before publishing.'::text
    FROM public.tours t
    WHERE t.id = p_tour_id
      AND t.city_id IS NULL

    UNION ALL

    -- 1. A tour with no waypoints is not a tour.
    SELECT 'error', 'no_waypoints', NULL::uuid,
           'Tour has no waypoints.'
    FROM public.tours t
    WHERE t.id = p_tour_id
      AND NOT EXISTS (SELECT 1 FROM public.waypoints w WHERE w.tour_id = t.id)

    UNION ALL

    -- 2. A waypoint with no NARRATION is a silent stop.
    SELECT 'error', 'waypoint_without_audio', w.id,
           format('Waypoint %s (sort_order %s) has no narration track.', w.name, w.sort_order)
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
      AND NOT EXISTS (
            SELECT 1 FROM public.audio_tracks a
             WHERE a.waypoint_id = w.id
               AND a.track_kind  = 'narration'
      )

    UNION ALL

    -- 3. A row is a CLAIM that a file exists; this join is the verification.
    SELECT 'error', 'audio_object_missing', a.waypoint_id,
           format('audio_tracks %s (%s) claims %s, which does not exist in storage.',
                  a.id, a.track_kind, a.storage_path)
    FROM public.audio_tracks a
    JOIN public.waypoints w ON w.id = a.waypoint_id
    WHERE w.tour_id = p_tour_id
      AND NOT EXISTS (
            SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = 'audio-tracks'
              AND o.name      = a.storage_path
      )

    UNION ALL

    -- 4. A waypoint with no geofence never triggers.
    SELECT 'error', 'waypoint_without_geofence', w.id,
           format('Waypoint %s has no geofence zone; its audio can never trigger.', w.name)
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
      AND NOT EXISTS (SELECT 1 FROM public.geofence_zones g WHERE g.waypoint_id = w.id)

    UNION ALL

    -- 5. A Deep Dive the app will never offer.
    SELECT 'error', 'deep_dive_on_transition', w.id,
           format('Waypoint %s is a transition stop but has a Deep Dive; the app only offers Deep Dives on anchor stops.', w.name)
    FROM public.waypoints w
    JOIN public.audio_tracks a ON a.waypoint_id = w.id AND a.track_kind = 'deep_dive'
    WHERE w.tour_id = p_tour_id
      AND w.poi_type = 'transition'

    UNION ALL

    -- 5a. NEW. A stop the route does not reach.
    SELECT 'error', 'route_far_from_waypoint', w.id,
           format('Waypoint %s is %s m from the tour route (limit %s m for %s). Following the route will not reach it: re-route, or check the polyline precision.',
                  w.name, round(ST_Distance(w.geom::geography, t.route::geography)),
                  public.route_tolerance_meters(t.transit_mode), t.transit_mode)
    FROM public.tours t
    JOIN public.waypoints w ON w.tour_id = t.id
    WHERE t.id = p_tour_id
      AND t.route IS NOT NULL
      AND NOT ST_DWithin(w.geom::geography, t.route::geography,
                         public.route_tolerance_meters(t.transit_mode))

    UNION ALL

    -- 5b. NEW. Warning. Near the stop, but never inside its trigger zone.
    SELECT 'warning', 'route_misses_geofence', w.id,
           format('The route passes waypoint %s but never enters its geofence, so someone following the route may not trigger its narration.', w.name)
    FROM public.tours t
    JOIN public.waypoints w      ON w.tour_id = t.id
    JOIN public.geofence_zones g ON g.waypoint_id = w.id
    WHERE t.id = p_tour_id
      AND t.route IS NOT NULL
      AND ST_DWithin(w.geom::geography, t.route::geography,
                     public.route_tolerance_meters(t.transit_mode))
      AND NOT ST_Intersects(t.route, g.geom)

    UNION ALL

    -- 5c. NEW. Warning. The route meets the stops out of sort_order.
    SELECT 'warning', 'route_order_mismatch', o.id,
           format('Waypoint %s (sort_order %s) lies earlier along the route than the stop before it, so walking the route reaches the stops out of order.',
                  o.name, o.sort_order)
    FROM (
        SELECT w.id, w.name, w.sort_order,
               ST_LineLocatePoint(t.route, w.geom) AS pos,
               lag(ST_LineLocatePoint(t.route, w.geom)) OVER (ORDER BY w.sort_order) AS prev_pos
        FROM public.tours t
        JOIN public.waypoints w ON w.tour_id = t.id
        WHERE t.id = p_tour_id
          AND t.route IS NOT NULL
    ) o
    WHERE o.prev_pos IS NOT NULL
      AND o.pos + 0.001 < o.prev_pos

    UNION ALL

    -- 5d. NEW. Warning. No route at all.
    SELECT 'warning', 'route_missing', NULL::uuid,
           'Tour has no route; the map will join its stops with straight lines.'
    FROM public.tours t
    WHERE t.id = p_tour_id
      AND t.route IS NULL
      AND (SELECT count(*) FROM public.waypoints w WHERE w.tour_id = t.id) >= 2

    UNION ALL

    -- 6. Warning. A transcript with no audio beside it.
    SELECT 'warning', 'transcript_orphaned', NULL::uuid,
           format('%s is not the transcript of any registered track; no device will download it.', o.name)
    FROM storage.objects o
    WHERE o.bucket_id = 'audio-tracks'
      AND o.name LIKE 'tours/' || p_tour_id::text || '/%'
      AND o.name ~* '[.]vtt$'
      AND NOT EXISTS (
            SELECT 1
              FROM public.audio_tracks a
              JOIN public.waypoints w ON w.id = a.waypoint_id
             WHERE w.tour_id = p_tour_id
               AND public.transcript_path_for(a.storage_path) = o.name
      )

    UNION ALL

    -- 7. Warning. Untagged content cannot be personalised.
    SELECT 'warning', 'tour_untagged', NULL::uuid,
           format('Tour has no %s tags, so onboarding preferences cannot narrow it: it is shown to everyone.',
                  concat_ws(' or ',
                            CASE WHEN cardinality(t.audiences) = 0 THEN 'audience' END,
                            CASE WHEN cardinality(t.interests) = 0 THEN 'interest' END))
    FROM public.tours t
    WHERE t.id = p_tour_id
      AND (cardinality(t.audiences) = 0 OR cardinality(t.interests) = 0)

    UNION ALL

    -- 8. Warning. Gaps in sort_order usually mean an unnoticed deletion.
    SELECT 'warning', 'sort_order_gap', NULL::uuid,
           format('sort_order is not contiguous: %s waypoints spanning %s..%s.',
                  count(*), min(w.sort_order), max(w.sort_order))
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
    HAVING count(*) > 0
       AND (max(w.sort_order) - min(w.sort_order) + 1) <> count(*)

    UNION ALL

    -- 9. Warning. Claimed duration vs NARRATION actually recorded.
    SELECT 'warning', 'duration_implausible', NULL::uuid,
           format('Tour claims %s min but holds only %s s of narration.',
                  t.duration_minutes, coalesce(sum(a.duration_seconds), 0))
    FROM public.tours t
    JOIN public.waypoints w         ON w.tour_id = t.id
    LEFT JOIN public.audio_tracks a ON a.waypoint_id = w.id AND a.track_kind = 'narration'
    WHERE t.id = p_tour_id
    GROUP BY t.id, t.duration_minutes
    HAVING coalesce(sum(a.duration_seconds), 0) < (t.duration_minutes * 60) * 0.1;
$fn$;

COMMENT ON FUNCTION public.cms_validate_tour(uuid) IS
    'Pre-flight checks for publishing. One row per problem; errors block publication, warnings do not. Covers missing narration, missing storage objects, unreachable Deep Dives, route coverage and order, orphaned transcripts, untagged tours and tours with no city.';
