-- =============================================================================
-- TASK-604 (Part 1) : Offline walking route per tour
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
--
-- The field QA walk drew straight lines between stops, because nothing in the
-- schema knew the streets in between. This stores one continuous route per
-- tour, accepts it from the CMS as an encoded polyline, and ships it inside the
-- offline bundle so the map never needs a network to draw it.
--
--   tours.route               geometry(LineString, 4326), nullable
--   route_tolerance_meters()  how far a stop may sit from its route
--   cms_set_tour_route()      NEW RPC: decode, validate, store
--   get_tour_bundle           + top-level `route` (precision-6 polyline)
--   cms_validate_tour         + route_far_from_waypoint, route_misses_geofence,
--                               route_order_mismatch, route_missing
--
-- WHAT THIS MIGRATION DOES TO EXISTING ROWS
--
-- Nothing is written. The column is added NULL for every tour (metadata-only,
-- no table rewrite), and bundle_version_hash is unchanged for every tour
-- without a route - which today is all of them, including the published Tel
-- Aviv QA tour. See section 3.
--
-- WHY A NEW RPC, NOT MORE PARAMETERS ON cms_upsert_tour
--
--   * Order of operations. The CMS creates a tour BEFORE its waypoints exist
--     (upsert, then cms_replace_tour_waypoints). A route arriving with the
--     upsert could not be checked against the stops it is meant to connect,
--     and that check is the only thing that catches a polyline decoded at the
--     wrong precision (section 2).
--   * Signature churn. Adding parameters to cms_upsert_tour means DROP and
--     re-CREATE again (see 20260915120100) for every client that calls it,
--     for no gain.
--
-- NO SPATIAL INDEX on tours.route: it is only ever read by primary key, one row
-- at a time, never searched spatially.
--
-- FOLLOW-UP AFTER PUSHING:  npm run types:generate
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. The column
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD COLUMN IF NOT EXISTS route geometry(LineString, 4326);

-- Backstop for writes that bypass cms_set_tour_route(). ST_IsValid rejects a
-- line whose points are all identical, which is a route of zero length.
ALTER TABLE public.tours
    ADD CONSTRAINT tours_route_sane_check
        CHECK (route IS NULL OR (ST_NPoints(route) >= 2 AND ST_IsValid(route)));

COMMENT ON COLUMN public.tours.route IS
    'The walking/riding/driving route through the tour''s stops, in sort_order. Written by cms_set_tour_route() from an encoded polyline; shipped in get_tour_bundle as a precision-6 polyline. NULL = no route, and the app joins stops with straight lines.';

-- -----------------------------------------------------------------------------
-- 2. How far a stop may be from its route
--
-- One definition for both cms_set_tour_route's report and cms_validate_tour's
-- error, per transit mode: a pedestrian route follows the pavement past a
-- stop's door; a driving route may pass a viewpoint from the road below it.
-- Mirrored in backend/scripts/verify-bundle.ts.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_tolerance_meters(p_transit_mode text)
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
    SELECT CASE p_transit_mode
        WHEN 'driving' THEN 500
        WHEN 'biking'  THEN 250
        ELSE 150
    END;
$fn$;

COMMENT ON FUNCTION public.route_tolerance_meters(text) IS
    'Maximum distance in metres between a stop and its tour route before cms_validate_tour reports route_far_from_waypoint. walking 150, biking 250, driving 500.';

-- -----------------------------------------------------------------------------
-- 2b. cms_set_tour_route
--
-- p_precision is REQUIRED. The encoded format does not record it, and both
-- values in use are called "polyline": 5 for Google Directions and OSRM
-- `polyline`, 6 for Valhalla and `polyline6`. Guessing wrong fails silently in
-- one direction, so the caller - who knows which routing service produced the
-- string - must say. The checks below, in order, are what makes a wrong guess
-- loud instead:
--
--   * decoding throws                -> not a polyline at all
--   * coordinates leave lon/lat range -> almost always polyline6 read at 5
--                                        (every coordinate x10)
--   * route is > 5 km from a stop     -> almost always polyline5 read at 6
--                                        (every coordinate /10: still valid
--                                        coordinates, near 3N 3E, in the sea)
--
-- The 5 km check is deliberately gross. It runs only when waypoints exist, and
-- it exists to catch decoding errors, which are off by hundreds of km. Whether
-- the route is GOOD - near every stop, through every geofence, in order - is
-- cms_validate_tour's job at publish time, when the stops are final.
--
-- An empty or NULL p_polyline clears the route.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_set_tour_route(
    p_tour_id   uuid,
    p_polyline  text,
    p_precision int
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_transit  text;
    v_route    geometry;
    v_points   int;
    v_length   double precision;
    v_max_gap  double precision;
    v_far      int;
BEGIN
    PERFORM public.assert_cms_admin();

    SELECT t.transit_mode INTO v_transit FROM public.tours t WHERE t.id = p_tour_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    -- --- clear ------------------------------------------------------------------
    IF p_polyline IS NULL OR btrim(p_polyline) = '' THEN
        UPDATE public.tours SET route = NULL WHERE id = p_tour_id;
        RETURN jsonb_build_object('tour_id', p_tour_id, 'cleared', true);
    END IF;

    -- --- decode -----------------------------------------------------------------
    IF p_precision IS NULL OR p_precision NOT IN (5, 6) THEN
        RAISE EXCEPTION
            'p_precision must be 5 (Google Directions, OSRM "polyline") or 6 (Valhalla, "polyline6"), got %.',
            p_precision
            USING ERRCODE = '22023';
    END IF;

    -- ~40,000 points. A tour is a few km; anything near this is the wrong input.
    IF length(p_polyline) > 262144 THEN
        RAISE EXCEPTION 'Encoded route is % characters; the limit is 262144.', length(p_polyline)
            USING ERRCODE = '22023';
    END IF;

    BEGIN
        v_route := ST_LineFromEncodedPolyline(p_polyline, p_precision);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'Not a valid encoded polyline: %', SQLERRM USING ERRCODE = '22023';
    END;

    v_points := coalesce(ST_NPoints(v_route), 0);
    IF v_points < 2 THEN
        RAISE EXCEPTION 'A route needs at least 2 points, got %.', v_points USING ERRCODE = '22023';
    END IF;

    -- Before any geography cast, which would itself reject latitude > 90 with a
    -- message that says nothing about precision.
    IF ST_XMin(v_route) < -180 OR ST_XMax(v_route) > 180
       OR ST_YMin(v_route) < -90 OR ST_YMax(v_route) > 90 THEN
        RAISE EXCEPTION
            'Decoded route leaves the valid coordinate range (lon % to %, lat % to %). That is what a precision-6 polyline read at precision 5 looks like; p_precision was %.',
            round(ST_XMin(v_route)::numeric, 3), round(ST_XMax(v_route)::numeric, 3),
            round(ST_YMin(v_route)::numeric, 3), round(ST_YMax(v_route)::numeric, 3), p_precision
            USING ERRCODE = '22023';
    END IF;

    IF NOT ST_IsValid(v_route) THEN
        RAISE EXCEPTION 'Decoded route is not a valid line (%).', ST_IsValidReason(v_route)
            USING ERRCODE = '22023';
    END IF;

    v_length := ST_Length(v_route::geography);

    -- --- gross mismatch with the tour's stops -----------------------------------
    SELECT max(ST_Distance(w.geom::geography, v_route::geography))
      INTO v_max_gap
      FROM public.waypoints w
     WHERE w.tour_id = p_tour_id;

    IF v_max_gap IS NOT NULL AND v_max_gap > 5000 THEN
        RAISE EXCEPTION
            'The route passes % km from one of this tour''s stops. That is a decoding error, not a routing one: a precision-5 polyline read at precision 6 lands ten times closer to 0,0. p_precision was %.',
            round((v_max_gap / 1000)::numeric, 1), p_precision
            USING ERRCODE = '23514';
    END IF;

    -- --- store ------------------------------------------------------------------
    UPDATE public.tours SET route = v_route WHERE id = p_tour_id;

    SELECT count(*)
      INTO v_far
      FROM public.waypoints w
     WHERE w.tour_id = p_tour_id
       AND NOT ST_DWithin(w.geom::geography, v_route::geography,
                          public.route_tolerance_meters(v_transit));

    RETURN jsonb_build_object(
        'tour_id',                 p_tour_id,
        'points',                  v_points,
        'length_meters',           round(v_length)::int,
        -- NULL when the tour has no stops yet; the route is then unchecked.
        'max_waypoint_gap_meters', round(v_max_gap)::int,
        -- Stops further than route_tolerance_meters(). Stored anyway: stops may
        -- still be edited, and cms_validate_tour blocks publishing if not.
        'waypoints_off_route',     v_far
    );
END;
$fn$;

COMMENT ON FUNCTION public.cms_set_tour_route(uuid, text, int) IS
    'Stores a tour''s route from an encoded polyline. p_precision is required: 5 (Google Directions, OSRM polyline) or 6 (Valhalla, polyline6). Rejects undecodable strings, out-of-range coordinates and routes > 5 km from any stop (wrong precision). Empty or NULL clears. Returns points, length_meters, max_waypoint_gap_meters and waypoints_off_route.';

REVOKE ALL ON FUNCTION public.cms_set_tour_route(uuid, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_set_tour_route(uuid, text, int) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. get_tour_bundle  (+ route)
--
-- Reproduced from 20260915120100 with exactly two additions, both in the final
-- SELECT. The waypoint rows, the payload and the per-waypoint signature are
-- untouched - `npm run test:cms` checks the signature block is byte-identical.
--
-- `route` is top-level:
--   { "encoding": "polyline", "precision": 6, "polyline": "...", "length_meters": n }
-- or null. ALWAYS precision 6 on the wire, whatever the CMS received: 6 holds a
-- precision-5 route losslessly, and one fixed value means the device never
-- guesses. `precision` is spelled out anyway, because every map library's
-- decoder defaults to 5 and the explicit field is what a reviewer will see.
--
-- THE HASH: the route joins the tour-level expression as one more concat_ws
-- argument that is NULL when there is no route. concat_ws skips NULLs, so
-- every tour without a route keeps its current bundle_version_hash, exactly as
-- TASK-603 did for transcripts and Deep Dives. Unlike tags, a route IS hashed:
-- a corrected route is navigation content that must reach devices. It is
-- hashed from ST_AsBinary (stable WKB) rather than from the encoded string.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_tour_bundle(p_tour_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $$
  WITH rows AS (
    SELECT
      w.id,
      w.name,
      w.poi_type,
      w.sort_order,
      w.audiences,
      w.interests,
      ST_X(w.geom) AS lon,
      ST_Y(w.geom) AS lat,
      z.zone_type,
      z.trigger_radius_meters,
      z.geom AS zone_geom,
      n.audio_track_id,
      n.storage_path,
      n.duration_seconds,
      n.size_bytes,
      n.format,
      n.transcript_path,
      n.transcript_size,
      n.transcript_etag,
      d.audio_track_id   AS dd_audio_track_id,
      d.storage_path     AS dd_storage_path,
      d.duration_seconds AS dd_duration_seconds,
      d.size_bytes       AS dd_size_bytes,
      d.format           AS dd_format,
      d.transcript_path  AS dd_transcript_path,
      d.transcript_size  AS dd_transcript_size,
      d.transcript_etag  AS dd_transcript_etag
    FROM public.waypoints w
    LEFT JOIN LATERAL (
      SELECT g.zone_type, g.trigger_radius_meters, g.geom
      FROM public.geofence_zones g
      WHERE g.waypoint_id = w.id
      ORDER BY g.id
      LIMIT 1
    ) z ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.id AS audio_track_id, a.storage_path, a.duration_seconds,
             a.size_bytes, a.format,
             o.name AS transcript_path,
             coalesce((o.metadata ->> 'size')::bigint,
                      (o.metadata ->> 'contentLength')::bigint) AS transcript_size,
             coalesce(o.metadata ->> 'eTag', o.updated_at::text) AS transcript_etag
      FROM public.audio_tracks a
      LEFT JOIN storage.objects o
             ON o.bucket_id = 'audio-tracks'
            AND o.name = public.transcript_path_for(a.storage_path)
      WHERE a.waypoint_id = w.id
        AND a.track_kind = 'narration'
      ORDER BY a.id
      LIMIT 1
    ) n ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.id AS audio_track_id, a.storage_path, a.duration_seconds,
             a.size_bytes, a.format,
             o.name AS transcript_path,
             coalesce((o.metadata ->> 'size')::bigint,
                      (o.metadata ->> 'contentLength')::bigint) AS transcript_size,
             coalesce(o.metadata ->> 'eTag', o.updated_at::text) AS transcript_etag
      FROM public.audio_tracks a
      LEFT JOIN storage.objects o
             ON o.bucket_id = 'audio-tracks'
            AND o.name = public.transcript_path_for(a.storage_path)
      WHERE a.waypoint_id = w.id
        AND a.track_kind = 'deep_dive'
      ORDER BY a.id
      LIMIT 1
    ) d ON TRUE
    WHERE w.tour_id = p_tour_id
  ),
  agg AS (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'waypoint_id', r.id,
          'name',        r.name,
          'poi_type',    r.poi_type,
          'sort_order',  r.sort_order,
          'coordinates', jsonb_build_array(r.lon, r.lat),
          'geofence',
            CASE
              WHEN r.zone_type IS NULL THEN NULL
              WHEN r.zone_type = 'polygon' THEN
                jsonb_build_object(
                  'type', 'polygon',
                  'ring', ST_AsGeoJSON(r.zone_geom)::jsonb -> 'coordinates' -> 0
                )
              ELSE
                jsonb_build_object(
                  'type', 'radius',
                  'radius_meters', r.trigger_radius_meters,
                  'center', jsonb_build_array(r.lon, r.lat)
                )
            END,
          'media',
            CASE
              WHEN r.storage_path IS NULL THEN NULL
              ELSE jsonb_build_object(
                'audio_track_id',   r.audio_track_id,
                'track_kind',       'narration',
                'storage_path',     r.storage_path,
                'duration_seconds', r.duration_seconds,
                'size_bytes',       r.size_bytes,
                'format',           r.format,
                'transcript',
                  CASE
                    WHEN r.transcript_size IS NULL THEN NULL
                    ELSE jsonb_build_object(
                      'storage_path', r.transcript_path,
                      'size_bytes',   r.transcript_size
                    )
                  END
              )
            END,
          'deep_dive',
            CASE
              WHEN r.dd_storage_path IS NULL THEN NULL
              ELSE jsonb_build_object(
                'audio_track_id',   r.dd_audio_track_id,
                'track_kind',       'deep_dive',
                'storage_path',     r.dd_storage_path,
                'duration_seconds', r.dd_duration_seconds,
                'size_bytes',       r.dd_size_bytes,
                'format',           r.dd_format,
                'transcript',
                  CASE
                    WHEN r.dd_transcript_size IS NULL THEN NULL
                    ELSE jsonb_build_object(
                      'storage_path', r.dd_transcript_path,
                      'size_bytes',   r.dd_transcript_size
                    )
                  END
              )
            END,
          'audiences', to_jsonb(r.audiences),
          'interests', to_jsonb(r.interests)
        )
        ORDER BY r.sort_order
      ) AS waypoints,
      -- Byte-identical to 20260915120100. Do not edit without reading its header.
      string_agg(
        concat_ws(':',
          r.id::text, r.sort_order::text, r.lon::text, r.lat::text,
          coalesce(r.storage_path, ''), coalesce(r.size_bytes::text, ''),
          coalesce(r.duration_seconds::text, ''), coalesce(r.zone_type, ''),
          coalesce(r.trigger_radius_meters::text, ''),
          CASE WHEN r.transcript_size IS NOT NULL
               THEN 't=' || r.transcript_path || '/' || r.transcript_size::text
                    || '/' || r.transcript_etag END,
          CASE WHEN r.dd_storage_path IS NOT NULL
               THEN 'dd=' || r.dd_storage_path || '/' || coalesce(r.dd_size_bytes::text, '')
                    || '/' || coalesce(r.dd_duration_seconds::text, '') END,
          CASE WHEN r.dd_transcript_size IS NOT NULL
               THEN 'ddt=' || r.dd_transcript_path || '/' || r.dd_transcript_size::text
                    || '/' || r.dd_transcript_etag END
        ), '|' ORDER BY r.sort_order
      ) AS signature
    FROM rows r
  )
  SELECT jsonb_build_object(
    'bundle_version_hash', md5(
      concat_ws(':', tr.id::text, tr.title, tr.topology, tr.transit_mode,
                tr.duration_minutes::text, coalesce(a.signature, ''),
                -- NEW (TASK-604). NULL without a route, so concat_ws skips it.
                CASE WHEN tr.route IS NOT NULL
                     THEN 'route=' || md5(ST_AsBinary(tr.route)) END)
    ),
    'tour_metadata', jsonb_build_object(
      'tour_id',          tr.id,
      'title',            tr.title,
      'topology',         tr.topology,
      'transit_mode',     tr.transit_mode,
      'duration_minutes', tr.duration_minutes,
      'audiences',        to_jsonb(tr.audiences),
      'interests',        to_jsonb(tr.interests)
    ),
    'waypoints', coalesce(a.waypoints, '[]'::jsonb),
    -- NEW (TASK-604).
    'route',
      CASE
        WHEN tr.route IS NULL THEN NULL
        ELSE jsonb_build_object(
          'encoding',      'polyline',
          'precision',     6,
          'polyline',      ST_AsEncodedPolyline(tr.route, 6),
          'length_meters', round(ST_Length(tr.route::geography))::int
        )
      END
  )
  FROM public.tours tr
  CROSS JOIN agg a
  WHERE tr.id = p_tour_id;
$$;

COMMENT ON FUNCTION public.get_tour_bundle(uuid) IS
  'Offline bundle payload: decoded coordinates, geofences, narration and deep_dive media, WebVTT transcript sidecars, preference tags, and the tour route as a precision-6 encoded polyline, plus a content-derived bundle_version_hash. Runs as the caller, so RLS applies. Tags and audio_track_id are excluded from the hash; the route is included.';

GRANT EXECUTE ON FUNCTION public.get_tour_bundle(uuid) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. cms_validate_tour  (+ route checks)
--
-- Reproduced from 20260915120100 with four route checks added (5a-5d). All of
-- them are silent when the tour has no route, except route_missing.
--
--   route_far_from_waypoint (error)   a stop beyond route_tolerance_meters();
--                                     following the route does not reach it
--   route_misses_geofence   (warning) the route passes near a stop but never
--                                     enters its zone, so narration may not
--                                     fire for someone walking the line
--   route_order_mismatch    (warning) the route reaches stops in a different
--                                     order from sort_order. A warning, not an
--                                     error: a loop that starts and ends at the
--                                     same place can trip it legitimately
--   route_missing           (warning) the map will draw straight lines
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
    -- 1. A tour with no waypoints is not a tour.
    SELECT 'error'::text, 'no_waypoints'::text, NULL::uuid,
           'Tour has no waypoints.'::text
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
    'Pre-flight checks for publishing. One row per problem; errors block publication, warnings do not. Covers missing narration, missing storage objects, unreachable Deep Dives, route coverage and order, orphaned transcripts and untagged tours.';
