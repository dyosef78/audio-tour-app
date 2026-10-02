-- =============================================================================
-- Epic 16 (Part 2 of 2): Geospatial Planning Engine - FUNCTIONS
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
-- Requires 20261005120000 (same push).
--
--   1. get_tour_bundle             + per-waypoint `stop_role`
--   2. cms_replace_tour_chapters   items gain plannable, entry_point, exit_point
--   3. cms_replace_tour_waypoints  items gain stop_role, dwell_seconds,
--                                    interest_weights
--   4. cms_validate_tour           + 6 checks (17-22), incl. the PM's MVP rule:
--                                    no extension in an anchored driving chapter
--   5. get_planner_candidates      NEW: the plan-tour Edge Function's single
--                                    read - feasible chapters, their stops,
--                                    and the cached costs between them
--
-- 1-4 are reproduced from 20261001120100 (what production runs) with additions
-- only. No signature changes: CREATE OR REPLACE keeps their grants and adds no
-- overload (PGRST203 - see 20260915120100).
--
-- DEPLOY ORDER - THE DISCOVERY RULE (PM, 2 Oct 2026)
--
-- A catalogue session plays CORE stops only; extensions belong to planned
-- bundles. Section 1 gives the device the data (`stop_role`), but every app
-- build in the field today ignores it and plays every stop. So: no tour may
-- PUBLISH an extension until an app build that filters on stop_role is the
-- minimum supported version. Nothing in SQL can enforce that; the CMS
-- operator must.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. get_tour_bundle  (+ per-waypoint stop_role)
--
-- Reproduced from 20261001120100. Additions only:
--   rows CTE           + w.stop_role
--   waypoint payload   + 'stop_role' ('core' | 'extension'), always present
--   hash, per waypoint + 'role=<stop_role>' appended, NULL while 'core'
--
-- The role IS hashed: flipping a stop between core and extension changes what
-- a catalogue session plays, so a device holding the old bundle must re-fetch.
-- Every stop today is core, so no existing hash moves (test-cms pins the
-- expression; the PGlite check pins the values). dwell_seconds, plannable,
-- entry/exit points and interest weights are NOT in the bundle: only the
-- planner reads them, through get_planner_candidates.
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
      d.transcript_etag  AS dd_transcript_etag,
      -- NEW (Epic 15).
      w.chapter_id,
      w.approach_bearing_deg,
      w.bearing_tolerance_deg,
      w.bearing_policy,
      -- NEW (Epic 16).
      w.stop_role
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
          'interests', to_jsonb(r.interests),
          -- NEW (Epic 15).
          'chapter_id', r.chapter_id,
          'approach',
            CASE
              WHEN r.bearing_policy = 'ignore' THEN NULL
              ELSE jsonb_build_object(
                'bearing_deg',   r.approach_bearing_deg,
                'tolerance_deg', r.bearing_tolerance_deg,
                'policy',        r.bearing_policy
              )
            END,
          -- NEW (Epic 16). A catalogue session arms 'core' only.
          'stop_role', r.stop_role
        )
        ORDER BY r.sort_order
      ) AS waypoints,
      -- The production (TASK-603) fields, unchanged, then two Epic 15 terms -
      -- each NULL when absent. Do not edit without reading this file's header.
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
                    || '/' || r.dd_transcript_etag END,
          CASE WHEN r.chapter_id <> p_tour_id
               THEN 'ch=' || r.chapter_id::text END,
          CASE WHEN r.bearing_policy <> 'ignore'
               THEN 'b=' || r.bearing_policy || '/' || r.approach_bearing_deg::text
                    || '/' || r.bearing_tolerance_deg::text END,
          -- NEW (Epic 16). NULL for a core stop, so concat_ws skips it.
          CASE WHEN r.stop_role <> 'core'
               THEN 'role=' || r.stop_role END
        ), '|' ORDER BY r.sort_order
      ) AS signature
    FROM rows r
  ),
  -- NEW (Epic 15). One row per chapter, anchors folded in.
  chs AS (
    SELECT
      c.id,
      c.sort_order,
      c.title,
      c.transit_mode,
      c.sequence_policy,
      c.lookahead_stops,
      c.destination,
      c.destination_label,
      an.anchors,
      an.anchors_signature
    FROM public.tour_chapters c
    LEFT JOIN LATERAL (
      SELECT
        jsonb_agg(jsonb_build_array(ST_X(a.geom), ST_Y(a.geom)) ORDER BY a.sort_order) AS anchors,
        string_agg(ST_X(a.geom)::text || ',' || ST_Y(a.geom)::text, ';' ORDER BY a.sort_order)
          AS anchors_signature
      FROM public.chapter_route_anchors a
      WHERE a.chapter_id = c.id
    ) an ON TRUE
    WHERE c.tour_id = p_tour_id
  ),
  chagg AS (
    SELECT
      jsonb_agg(
        jsonb_build_object(
          'chapter_id',      c.id,
          'sort_order',      c.sort_order,
          'title',           c.title,
          'transit_mode',    c.transit_mode,
          'sequence_policy', c.sequence_policy,
          'lookahead_stops', c.lookahead_stops,
          'handoff',
            CASE
              WHEN c.destination IS NULL THEN NULL
              ELSE jsonb_build_object(
                'destination',       jsonb_build_array(ST_X(c.destination), ST_Y(c.destination)),
                'destination_label', c.destination_label,
                'anchors',           coalesce(c.anchors, '[]'::jsonb),
                'providers',
                  CASE
                    WHEN c.transit_mode = 'driving' AND c.anchors IS NULL
                      THEN '["google_maps", "waze"]'::jsonb
                    ELSE '["google_maps"]'::jsonb
                  END
              )
            END
        )
        ORDER BY c.sort_order
      ) AS chapters,
      -- Plain = what a device assumes for a manifest without `chapters`.
      -- 'windowed' and 3 are the column defaults in 20261001120000.
      coalesce(
        count(*) = 1
        AND bool_and(    c.id = p_tour_id
                     AND c.title IS NULL
                     AND c.destination IS NULL
                     AND c.anchors IS NULL
                     AND c.sequence_policy = 'windowed'
                     AND c.lookahead_stops = 3),
        false
      ) AS plain,
      string_agg(
        concat_ws(':',
          c.id::text, c.sort_order::text, coalesce(c.title, ''), c.transit_mode,
          c.sequence_policy, c.lookahead_stops::text,
          coalesce(ST_X(c.destination)::text || ',' || ST_Y(c.destination)::text, ''),
          coalesce(c.destination_label, ''),
          coalesce(c.anchors_signature, '')
        ), '|' ORDER BY c.sort_order
      ) AS signature
    FROM chs c
  )
  SELECT jsonb_build_object(
    'bundle_version_hash', md5(
      concat_ws(':', tr.id::text, tr.title, tr.topology, tr.transit_mode,
                tr.duration_minutes::text, coalesce(a.signature, ''),
                CASE WHEN tr.route IS NOT NULL
                     THEN 'route=' || md5(ST_AsBinary(tr.route)) END,
                -- NEW (Epic 15). NULL for a plain tour, so concat_ws skips it.
                CASE WHEN NOT ch.plain
                     THEN 'chapters=' || md5(ch.signature) END)
    ),
    'tour_metadata', jsonb_build_object(
      'tour_id',          tr.id,
      'title',            tr.title,
      'topology',         tr.topology,
      -- Derived since Epic 15 (most demanding chapter mode). Kept for old apps.
      'transit_mode',     tr.transit_mode,
      'duration_minutes', tr.duration_minutes,
      'audiences',        to_jsonb(tr.audiences),
      'interests',        to_jsonb(tr.interests)
    ),
    'waypoints', coalesce(a.waypoints, '[]'::jsonb),
    'route',
      CASE
        WHEN tr.route IS NULL THEN NULL
        ELSE jsonb_build_object(
          'encoding',      'polyline',
          'precision',     6,
          'polyline',      ST_AsEncodedPolyline(tr.route, 6),
          'length_meters', round(ST_Length(tr.route::geography))::int
        )
      END,
    -- NEW (Epic 15).
    'chapters', coalesce(ch.chapters, '[]'::jsonb)
  )
  FROM public.tours tr
  CROSS JOIN agg a
  CROSS JOIN chagg ch
  WHERE tr.id = p_tour_id;
$$;

COMMENT ON FUNCTION public.get_tour_bundle(uuid) IS
  'Offline bundle payload: decoded coordinates, geofences, narration and deep_dive media, WebVTT transcript sidecars, preference tags, the tour route, and (Epic 15) chapters with navigation handoff plus per-waypoint chapter and approach bearing, with a content-derived bundle_version_hash. Runs as the caller, so RLS applies. A plain single-chapter tour hashes exactly as before Epic 15. (Epic 16) Each waypoint carries stop_role; catalogue sessions play core stops only; an extension changes the hash, a core stop does not.';

GRANT EXECUTE ON FUNCTION public.get_tour_bundle(uuid) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. cms_replace_tour_chapters  (+ plannable, entry_point, exit_point)
--
-- Reproduced from 20261001120100. Items gain three optional keys, all
-- "absent = unchanged" like the existing optional keys:
--
--   "plannable":   boolean
--   "entry_point": { "lon", "lat" } | null      null clears
--   "exit_point":  { "lon", "lat" } | null      null clears
--
-- All three are written in ONE UPDATE, so tour_chapters_plannable_endpoints_check
-- judges the end state: { plannable: true, entry_point, exit_point } in one item
-- succeeds; plannable without points is refused by name. Coordinates are
-- validated before any write, with the same message shape as `destination`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_replace_tour_chapters(
    p_tour_id  uuid,
    p_chapters jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_item       jsonb;
    v_label      text;
    v_chapter_id uuid;
    v_kept       uuid[] := ARRAY[]::uuid[];
    v_upserted   int := 0;
    v_deleted    int;
    v_blocked    text;
    v_dest       geometry(Point, 4326);
    v_lon        double precision;
    v_lat        double precision;
    v_anchor     jsonb;
    v_ord        bigint;
    -- NEW (Epic 16).
    v_key        text;
    v_entry      geometry(Point, 4326);
    v_exit       geometry(Point, 4326);
    v_point      geometry(Point, 4326);
BEGIN
    PERFORM public.assert_cms_admin();

    IF NOT EXISTS (SELECT 1 FROM public.tours t WHERE t.id = p_tour_id) THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    IF jsonb_typeof(p_chapters) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'p_chapters must be a JSON array.' USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(p_chapters) = 0 THEN
        RAISE EXCEPTION 'A tour needs at least one chapter.' USING ERRCODE = '22023';
    END IF;

    IF (SELECT count(e ->> 'id') <> count(DISTINCT e ->> 'id')
          FROM jsonb_array_elements(p_chapters) e) THEN
        RAISE EXCEPTION 'p_chapters names the same chapter id twice.' USING ERRCODE = '22023';
    END IF;

    -- A reorder passes through duplicate sort_orders (as for waypoints).
    SET CONSTRAINTS public.tour_chapters_tour_sort_order_key,
                    public.chapter_route_anchors_chapter_sort_order_key DEFERRED;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_chapters)
    LOOP
        IF jsonb_typeof(v_item -> 'sort_order') IS DISTINCT FROM 'number' THEN
            RAISE EXCEPTION 'Chapter "%": sort_order is required.', coalesce(v_item ->> 'title', v_item ->> 'id', '(new)')
                USING ERRCODE = '22023';
        END IF;

        -- --- destination: validated before any write -------------------------
        v_dest  := NULL;
        v_label := NULL;
        IF coalesce(jsonb_typeof(v_item -> 'destination'), 'null') <> 'null' THEN
            v_lon := (v_item -> 'destination' ->> 'lon')::double precision;
            v_lat := (v_item -> 'destination' ->> 'lat')::double precision;
            IF v_lon IS NULL OR v_lat IS NULL
               OR v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
                RAISE EXCEPTION 'Chapter "%": destination needs lon and lat in range, got lon %, lat %.',
                    coalesce(v_item ->> 'title', v_item ->> 'id', '(new)'), v_lon, v_lat
                    USING ERRCODE = '22023';
            END IF;
            v_dest  := ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326);
            v_label := v_item -> 'destination' ->> 'label';
        END IF;

        -- --- planning (Epic 16): validated before any write ------------------
        IF v_item ? 'plannable' AND jsonb_typeof(v_item -> 'plannable') <> 'boolean' THEN
            RAISE EXCEPTION 'Chapter "%": plannable must be true or false.',
                coalesce(v_item ->> 'title', v_item ->> 'id', '(new)') USING ERRCODE = '22023';
        END IF;

        v_entry := NULL;
        v_exit  := NULL;
        FOREACH v_key IN ARRAY ARRAY['entry_point', 'exit_point']
        LOOP
            v_point := NULL;
            IF coalesce(jsonb_typeof(v_item -> v_key), 'null') <> 'null' THEN
                v_lon := (v_item -> v_key ->> 'lon')::double precision;
                v_lat := (v_item -> v_key ->> 'lat')::double precision;
                IF v_lon IS NULL OR v_lat IS NULL
                   OR v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
                    RAISE EXCEPTION 'Chapter "%": % needs lon and lat in range, got lon %, lat %.',
                        coalesce(v_item ->> 'title', v_item ->> 'id', '(new)'), v_key, v_lon, v_lat
                        USING ERRCODE = '22023';
                END IF;
                v_point := ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326);
            END IF;
            IF v_key = 'entry_point' THEN v_entry := v_point; ELSE v_exit := v_point; END IF;
        END LOOP;

        IF coalesce(jsonb_typeof(v_item -> 'anchors'), 'null') NOT IN ('null', 'array') THEN
            RAISE EXCEPTION 'Chapter "%": anchors must be a JSON array.',
                coalesce(v_item ->> 'title', v_item ->> 'id', '(new)') USING ERRCODE = '22023';
        END IF;

        IF jsonb_array_length(coalesce(nullif(v_item -> 'anchors', 'null'::jsonb), '[]'::jsonb))
           > public.max_route_anchors() THEN
            RAISE EXCEPTION 'Chapter "%": % routing anchors; Google Maps accepts at most %.',
                coalesce(v_item ->> 'title', v_item ->> 'id', '(new)'),
                jsonb_array_length(v_item -> 'anchors'), public.max_route_anchors()
                USING ERRCODE = '23514';
        END IF;

        -- --- the row ---------------------------------------------------------
        v_chapter_id := nullif(v_item ->> 'id', '')::uuid;

        IF v_chapter_id IS NULL THEN
            IF v_item ->> 'transit_mode' IS NULL THEN
                RAISE EXCEPTION 'Chapter "%": transit_mode is required to create a chapter.',
                    coalesce(v_item ->> 'title', '(new)') USING ERRCODE = '22023';
            END IF;

            INSERT INTO public.tour_chapters (tour_id, sort_order, transit_mode)
            VALUES (p_tour_id, (v_item ->> 'sort_order')::int, v_item ->> 'transit_mode')
            RETURNING id INTO v_chapter_id;
        ELSE
            -- tour_id in the WHERE clause: a payload must not adopt another
            -- tour's chapter by guessing its uuid.
            UPDATE public.tour_chapters c
               SET sort_order   = (v_item ->> 'sort_order')::int,
                   transit_mode = coalesce(v_item ->> 'transit_mode', c.transit_mode)
             WHERE c.id = v_chapter_id
               AND c.tour_id = p_tour_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Chapter % does not belong to tour %.', v_chapter_id, p_tour_id
                    USING ERRCODE = '23503';
            END IF;
        END IF;

        -- Optional keys: absent = unchanged (on a new row, the column default).
        UPDATE public.tour_chapters c
           SET title             = CASE WHEN v_item ? 'title' THEN v_item ->> 'title' ELSE c.title END,
               sequence_policy   = coalesce(v_item ->> 'sequence_policy', c.sequence_policy),
               lookahead_stops   = coalesce((v_item ->> 'lookahead_stops')::smallint, c.lookahead_stops),
               destination       = CASE WHEN v_item ? 'destination' THEN v_dest  ELSE c.destination END,
               destination_label = CASE WHEN v_item ? 'destination' THEN v_label ELSE c.destination_label END,
               -- NEW (Epic 16). One statement, so the endpoints CHECK sees the end state.
               plannable         = coalesce((v_item ->> 'plannable')::boolean, c.plannable),
               entry_point       = CASE WHEN v_item ? 'entry_point' THEN v_entry ELSE c.entry_point END,
               exit_point        = CASE WHEN v_item ? 'exit_point'  THEN v_exit  ELSE c.exit_point  END
         WHERE c.id = v_chapter_id;

        -- --- anchors: replace the list, in array order -----------------------
        IF coalesce(jsonb_typeof(v_item -> 'anchors'), 'null') = 'array' THEN
            DELETE FROM public.chapter_route_anchors a WHERE a.chapter_id = v_chapter_id;

            FOR v_anchor, v_ord IN
                SELECT e, o FROM jsonb_array_elements(v_item -> 'anchors') WITH ORDINALITY AS x(e, o)
            LOOP
                v_lon := (v_anchor ->> 'lon')::double precision;
                v_lat := (v_anchor ->> 'lat')::double precision;
                IF v_lon IS NULL OR v_lat IS NULL
                   OR v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
                    RAISE EXCEPTION 'Chapter "%": anchor % needs lon and lat in range, got lon %, lat %.',
                        coalesce(v_item ->> 'title', v_chapter_id::text), v_ord, v_lon, v_lat
                        USING ERRCODE = '22023';
                END IF;

                INSERT INTO public.chapter_route_anchors (chapter_id, sort_order, geom)
                VALUES (v_chapter_id, (v_ord - 1)::int, ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326));
            END LOOP;
        END IF;

        v_kept     := array_append(v_kept, v_chapter_id);
        v_upserted := v_upserted + 1;
    END LOOP;

    -- --- deletions: refused while a chapter still owns waypoints --------------
    SELECT string_agg(format('%s (%s waypoints)', coalesce(c.title, c.id::text), x.n), ', '
                      ORDER BY c.sort_order)
      INTO v_blocked
      FROM public.tour_chapters c
      CROSS JOIN LATERAL (
          SELECT count(*) AS n FROM public.waypoints w WHERE w.chapter_id = c.id
      ) x
     WHERE c.tour_id = p_tour_id
       AND NOT (c.id = ANY(v_kept))
       AND x.n > 0;

    IF v_blocked IS NOT NULL THEN
        RAISE EXCEPTION 'Cannot delete chapters that still hold waypoints: %. Move or delete those waypoints with cms_replace_tour_waypoints first.',
            v_blocked
            USING ERRCODE = '23503';
    END IF;

    DELETE FROM public.tour_chapters c
     WHERE c.tour_id = p_tour_id
       AND NOT (c.id = ANY(v_kept));

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'tour_id',     p_tour_id,
        'upserted',    v_upserted,
        'deleted',     v_deleted,
        'chapter_ids', to_jsonb(v_kept)
    );
END;
$fn$;

COMMENT ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb) IS
    'Epic 15: replaces a tour''s chapter list (transit mode, sequencing, navigation destination and routing anchors); chapters absent from the payload are deleted, unless they still hold waypoints, which is refused. Optional keys: absent leaves the stored value. Returns chapter_ids in payload order. Epic 16: optional plannable, entry_point and exit_point (planner eligibility and transfer endpoints).';

-- FROM anon explicitly: Supabase's default privileges GRANT EXECUTE on every
-- new public function to anon by name, which REVOKE ... FROM PUBLIC does not
-- touch. assert_cms_admin() is still the authority; this just stops anon
-- reaching it. (Every older cms_* RPC is anon-executable for the same reason.)
REVOKE ALL ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. cms_replace_tour_waypoints  (+ stop_role, dwell_seconds, interest_weights)
--
-- Reproduced from 20261001120100. Items gain three optional keys:
--
--   "stop_role":        "core" | "extension"   absent = unchanged ('core' on a
--                                              new stop). A transition stop
--                                              cannot be an extension: the
--                                              table's CHECK names the rule.
--   "dwell_seconds":    0..7200 | null         absent = unchanged, null = derive
--   "interest_weights": { "<interest>": 1|2|3, ... } | null
--                                              absent = unchanged. An object
--                                              REPLACES this stop's weights;
--                                              null or {} clears them (all 2).
--
-- interest_weights is applied AFTER the row's interests are written, so a
-- payload that adds an interest and weights it in the same item succeeds. A
-- weight for an interest the stop does not list is refused by
-- trg_waypoint_interest_weights_listed, which names the waypoint and interest.
-- Removing an interest prunes its weight (trg_waypoints_prune_interest_weights).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_replace_tour_waypoints(
    p_tour_id   uuid,
    p_waypoints jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_status      text;
    v_kept        uuid[];
    v_deleted     int;
    v_upserted    int := 0;
    v_orphaned    jsonb;
    v_item        jsonb;
    v_waypoint_id uuid;
    v_lon         double precision;
    v_lat         double precision;
    v_geofence    jsonb;
    v_ring        geometry;
    v_zone_geom   geometry(Polygon, 4326);
    v_audiences   text[];
    v_interests   text[];
    -- NEW (Epic 15).
    v_chapter_id  uuid;
    v_approach    jsonb;
    -- NEW (Epic 16).
    v_weights     jsonb;
    v_bad         text;
BEGIN
    PERFORM public.assert_cms_admin();

    SELECT status INTO v_status FROM public.tours WHERE id = p_tour_id;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    IF jsonb_typeof(p_waypoints) <> 'array' THEN
        RAISE EXCEPTION 'p_waypoints must be a JSON array.' USING ERRCODE = '22023';
    END IF;

    -- See 20260827160100: a reorder passes through duplicate sort_orders.
    SET CONSTRAINTS public.waypoints_tour_sort_order_key DEFERRED;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_waypoints)
    LOOP
        v_lon := (v_item ->> 'lon')::double precision;
        v_lat := (v_item ->> 'lat')::double precision;

        IF v_lon IS NULL OR v_lat IS NULL THEN
            RAISE EXCEPTION 'Waypoint "%" is missing lon or lat.', v_item ->> 'name'
                USING ERRCODE = '22023';
        END IF;

        IF v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
            RAISE EXCEPTION 'Waypoint "%" has out-of-range coordinates (lon %, lat %).',
                v_item ->> 'name', v_lon, v_lat
                USING ERRCODE = '22023';
        END IF;

        -- --- tags: absent or null = unchanged -------------------------------
        v_audiences := NULL;
        IF coalesce(jsonb_typeof(v_item -> 'audiences'), 'null') <> 'null' THEN
            IF jsonb_typeof(v_item -> 'audiences') <> 'array' THEN
                RAISE EXCEPTION 'Waypoint "%": audiences must be a JSON array of strings.',
                    v_item ->> 'name' USING ERRCODE = '22023';
            END IF;
            v_audiences := public.cms_normalise_tags(
                ARRAY(SELECT jsonb_array_elements_text(v_item -> 'audiences')),
                public.audience_tag_vocabulary(), 'audience');
        END IF;

        v_interests := NULL;
        IF coalesce(jsonb_typeof(v_item -> 'interests'), 'null') <> 'null' THEN
            IF jsonb_typeof(v_item -> 'interests') <> 'array' THEN
                RAISE EXCEPTION 'Waypoint "%": interests must be a JSON array of strings.',
                    v_item ->> 'name' USING ERRCODE = '22023';
            END IF;
            v_interests := public.cms_normalise_tags(
                ARRAY(SELECT jsonb_array_elements_text(v_item -> 'interests')),
                public.interest_tag_vocabulary(), 'interest');
        END IF;

        -- --- chapter (Epic 15): absent or null = unchanged --------------------
        v_chapter_id := NULL;
        IF coalesce(jsonb_typeof(v_item -> 'chapter_id'), 'null') <> 'null' THEN
            v_chapter_id := (v_item ->> 'chapter_id')::uuid;
            IF NOT EXISTS (SELECT 1 FROM public.tour_chapters c
                            WHERE c.id = v_chapter_id AND c.tour_id = p_tour_id) THEN
                RAISE EXCEPTION 'Waypoint "%": chapter % does not belong to tour %.',
                    v_item ->> 'name', v_chapter_id, p_tour_id
                    USING ERRCODE = '23503';
            END IF;
        END IF;

        -- --- planning (Epic 16): shape checks before any write -----------------
        IF coalesce(jsonb_typeof(v_item -> 'stop_role'), 'null') NOT IN ('null', 'string') THEN
            RAISE EXCEPTION 'Waypoint "%": stop_role must be "core" or "extension".',
                v_item ->> 'name' USING ERRCODE = '22023';
        END IF;
        IF coalesce(jsonb_typeof(v_item -> 'dwell_seconds'), 'null') NOT IN ('null', 'number') THEN
            RAISE EXCEPTION 'Waypoint "%": dwell_seconds must be a whole number of seconds or null.',
                v_item ->> 'name' USING ERRCODE = '22023';
        END IF;

        v_weights := NULL;
        IF v_item ? 'interest_weights' THEN
            v_weights := coalesce(nullif(v_item -> 'interest_weights', 'null'::jsonb), '{}'::jsonb);
            IF jsonb_typeof(v_weights) <> 'object' THEN
                RAISE EXCEPTION 'Waypoint "%": interest_weights must be an object like {"history": 3} or null.',
                    v_item ->> 'name' USING ERRCODE = '22023';
            END IF;
            SELECT string_agg(format('%s=%s', e.key, e.value), ', ')
              INTO v_bad
              FROM jsonb_each(v_weights) e
             WHERE e.value NOT IN ('1'::jsonb, '2'::jsonb, '3'::jsonb);
            IF v_bad IS NOT NULL THEN
                RAISE EXCEPTION 'Waypoint "%": interest weights must be 1, 2 or 3; got %.',
                    v_item ->> 'name', v_bad USING ERRCODE = '22023';
            END IF;
        END IF;

        v_waypoint_id := nullif(v_item ->> 'id', '')::uuid;

        IF v_waypoint_id IS NULL THEN
            -- chapter_id NULL here = the tour's only chapter (trigger).
            INSERT INTO public.waypoints
                (tour_id, name, poi_type, geom, sort_order, audiences, interests, chapter_id,
                 stop_role, dwell_seconds)
            VALUES (
                p_tour_id,
                v_item ->> 'name',
                v_item ->> 'poi_type',
                ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326),
                (v_item ->> 'sort_order')::int,
                coalesce(v_audiences, '{}'),
                coalesce(v_interests, '{}'),
                v_chapter_id,
                coalesce(v_item ->> 'stop_role', 'core'),
                (v_item ->> 'dwell_seconds')::int
            )
            RETURNING id INTO v_waypoint_id;
        ELSE
            -- tour_id in the WHERE clause: without it a payload could reassign
            -- another tour's waypoint by guessing its uuid.
            UPDATE public.waypoints w
               SET name       = v_item ->> 'name',
                   poi_type   = v_item ->> 'poi_type',
                   geom       = ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326),
                   sort_order = (v_item ->> 'sort_order')::int,
                   audiences  = coalesce(v_audiences, w.audiences),
                   interests  = coalesce(v_interests, w.interests),
                   chapter_id = coalesce(v_chapter_id, w.chapter_id),
                   -- NEW (Epic 16).
                   stop_role     = coalesce(v_item ->> 'stop_role', w.stop_role),
                   dwell_seconds = CASE WHEN v_item ? 'dwell_seconds'
                                        THEN (v_item ->> 'dwell_seconds')::int
                                        ELSE w.dwell_seconds END
             WHERE w.id = v_waypoint_id
               AND w.tour_id = p_tour_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Waypoint % does not belong to tour %.', v_waypoint_id, p_tour_id
                    USING ERRCODE = '23503';
            END IF;
        END IF;

        -- --- approach bearing (Epic 15): absent = unchanged, null = clear -----
        IF v_item ? 'approach' THEN
            v_approach := v_item -> 'approach';

            IF jsonb_typeof(v_approach) = 'null' THEN
                UPDATE public.waypoints w
                   SET approach_bearing_deg    = NULL,
                       approach_bearing_source = NULL,
                       bearing_tolerance_deg   = DEFAULT,
                       bearing_policy          = 'ignore'
                 WHERE w.id = v_waypoint_id;
            ELSIF jsonb_typeof(v_approach) = 'object' THEN
                IF v_approach ->> 'policy' IS NULL THEN
                    RAISE EXCEPTION 'Waypoint "%": approach.policy is required (required, preferred or ignore).',
                        v_item ->> 'name' USING ERRCODE = '22023';
                END IF;

                UPDATE public.waypoints w
                   SET approach_bearing_deg    = (v_approach ->> 'bearing_deg')::smallint,
                       approach_bearing_source = CASE
                                                     WHEN v_approach ->> 'bearing_deg' IS NULL THEN NULL
                                                     ELSE coalesce(v_approach ->> 'source', 'authored')
                                                 END,
                       bearing_tolerance_deg   = coalesce((v_approach ->> 'tolerance_deg')::smallint, 45),
                       bearing_policy          = v_approach ->> 'policy'
                 WHERE w.id = v_waypoint_id;
            ELSE
                RAISE EXCEPTION 'Waypoint "%": approach must be an object or null.',
                    v_item ->> 'name' USING ERRCODE = '22023';
            END IF;
        END IF;

        -- --- interest weights (Epic 16): after interests are written ----------
        IF v_weights IS NOT NULL THEN
            DELETE FROM public.waypoint_interest_weights x WHERE x.waypoint_id = v_waypoint_id;
            INSERT INTO public.waypoint_interest_weights (waypoint_id, interest, weight)
            SELECT v_waypoint_id, e.key, (e.value #>> '{}')::smallint
              FROM jsonb_each(v_weights) e;
        END IF;

        v_kept     := array_append(v_kept, v_waypoint_id);
        v_upserted := v_upserted + 1;

        v_geofence := v_item -> 'geofence';

        IF v_geofence IS NULL OR jsonb_typeof(v_geofence) = 'null' THEN
            DELETE FROM public.geofence_zones WHERE waypoint_id = v_waypoint_id;
        ELSE
            IF (v_geofence ->> 'type') = 'polygon' THEN
                -- ST_GeomFromGeoJSON yields SRID 0; stamp 4326 before it becomes
                -- a geometry(Polygon, 4326).
                v_ring := ST_SetSRID(
                    ST_GeomFromGeoJSON(jsonb_build_object(
                        'type', 'LineString',
                        'coordinates', v_geofence -> 'ring'
                    )::text), 4326);

                IF ST_NPoints(v_ring) < 3 THEN
                    RAISE EXCEPTION 'Waypoint "%": a polygon ring needs at least 3 points, got %.',
                        v_item ->> 'name', ST_NPoints(v_ring)
                        USING ERRCODE = '22023';
                END IF;

                IF NOT ST_IsClosed(v_ring) THEN
                    v_ring := ST_AddPoint(v_ring, ST_PointN(v_ring, 1));
                END IF;

                v_zone_geom := ST_MakePolygon(v_ring);
            ELSE
                -- Radius. The geography cast is what makes the radius metres.
                v_zone_geom := ST_Buffer(
                    ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326)::geography,
                    (v_geofence ->> 'radius_meters')::double precision
                )::geometry;
            END IF;

            -- One zone per waypoint; get_tour_bundle picks one.
            DELETE FROM public.geofence_zones WHERE waypoint_id = v_waypoint_id;

            INSERT INTO public.geofence_zones
                (waypoint_id, zone_type, trigger_radius_meters, geom)
            VALUES (
                v_waypoint_id,
                coalesce(v_geofence ->> 'type', 'radius'),
                (v_geofence ->> 'radius_meters')::int,
                v_zone_geom
            );
        END IF;
    END LOOP;

    -- Deleting omitted waypoints cascades to geofence_zones and audio_tracks,
    -- every kind. The storage OBJECTS survive - SQL cannot reach the Storage
    -- API - so they are reported: the audio of every kind, plus any transcript
    -- sidecar actually present. UNION also de-duplicates a shared recording.
    SELECT jsonb_agg(p.path ORDER BY p.path)
      INTO v_orphaned
      FROM (
          SELECT a.storage_path AS path
            FROM public.audio_tracks a
            JOIN public.waypoints w ON w.id = a.waypoint_id
           WHERE w.tour_id = p_tour_id
             AND NOT (w.id = ANY(coalesce(v_kept, ARRAY[]::uuid[])))
          UNION
          SELECT o.name
            FROM public.audio_tracks a
            JOIN public.waypoints w ON w.id = a.waypoint_id
            JOIN storage.objects o
              ON o.bucket_id = 'audio-tracks'
             AND o.name = public.transcript_path_for(a.storage_path)
           WHERE w.tour_id = p_tour_id
             AND NOT (w.id = ANY(coalesce(v_kept, ARRAY[]::uuid[])))
      ) p;

    DELETE FROM public.waypoints w
     WHERE w.tour_id = p_tour_id
       AND NOT (w.id = ANY(coalesce(v_kept, ARRAY[]::uuid[])));

    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN jsonb_build_object(
        'tour_id',          p_tour_id,
        'upserted',         v_upserted,
        'deleted',          v_deleted,
        'orphaned_objects', coalesce(v_orphaned, '[]'::jsonb)
    );
END;
$fn$;

COMMENT ON FUNCTION public.cms_replace_tour_waypoints(uuid, jsonb) IS
    'Replaces a tour''s entire waypoint list; anything absent from the payload is deleted. Optional per-item keys - audiences/interests, chapter_id, approach, and (Epic 16) stop_role, dwell_seconds, interest_weights - leave the stored value alone when absent. A new waypoint without chapter_id joins the tour''s only chapter (refused when it has several). Returns orphaned_objects - audio files and transcript sidecars of cascade-deleted tracks, which the caller must remove from the bucket because SQL cannot.';


-- -----------------------------------------------------------------------------
-- 4. cms_validate_tour  (+ Epic 16 checks 17-22)
--
-- Reproduced from 20261001120100; checks 0-16 unchanged. New (all Epic 16):
--
--   17 extension_in_anchored_driving_chapter   (error)   PM MVP rule, 2 Oct:
--        Google Maps follows the anchors, so it drives past a kept extension
--        (or the plan must regenerate anchors against the 9-anchor cap).
--   18 extension_in_anchored_chapter           (warning) the same mechanism
--        on a walking/biking chapter with a handoff. Warning, not error,
--        because the PM's rule names driving; see the handover.
--   19 extension_unreachable                   (error)   an extension in a
--        chapter that is not plannable: catalogue sessions play core only and
--        the planner never selects the chapter, so no one ever hears it.
--   20 plannable_chapter_without_core          (error)   no backbone - a plan
--        could hand someone a chapter that plays nothing.
--   21 extension_untagged                      (warning) no interest can ever
--        select it.
--   22 plannable_endpoint_far                  (warning) entry/exit far from
--        the first/last core stop (walking/biking), or exit far from the
--        chapter's own handoff destination - usually a swapped lon/lat or a
--        stale pre-fill.
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
    -- 0. A published tour with no city would be listed under every city by the
    --    app, which cannot know where it belongs. Set one with
    --    cms_set_tour_city() first.
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

    -- 5a. A stop the route does not reach. Tolerance by CHAPTER mode (Epic 15).
    SELECT 'error', 'route_far_from_waypoint', w.id,
           format('Waypoint %s is %s m from the tour route (limit %s m for %s). Following the route will not reach it: re-route, or check the polyline precision.',
                  w.name, round(ST_Distance(w.geom::geography, t.route::geography)),
                  public.route_tolerance_meters(c.transit_mode), c.transit_mode)
    FROM public.tours t
    JOIN public.waypoints w     ON w.tour_id = t.id
    JOIN public.tour_chapters c ON c.id = w.chapter_id
    WHERE t.id = p_tour_id
      AND t.route IS NOT NULL
      AND NOT ST_DWithin(w.geom::geography, t.route::geography,
                         public.route_tolerance_meters(c.transit_mode))

    UNION ALL

    -- 5b. Warning. Near the stop, but never inside its trigger zone.
    SELECT 'warning', 'route_misses_geofence', w.id,
           format('The route passes waypoint %s but never enters its geofence, so someone following the route may not trigger its narration.', w.name)
    FROM public.tours t
    JOIN public.waypoints w      ON w.tour_id = t.id
    JOIN public.tour_chapters c  ON c.id = w.chapter_id
    JOIN public.geofence_zones g ON g.waypoint_id = w.id
    WHERE t.id = p_tour_id
      AND t.route IS NOT NULL
      AND ST_DWithin(w.geom::geography, t.route::geography,
                     public.route_tolerance_meters(c.transit_mode))
      AND NOT ST_Intersects(t.route, g.geom)

    UNION ALL

    -- 5c. Warning. The route meets the stops out of sort_order.
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

    -- 5d. Warning. No route at all.
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
    HAVING coalesce(sum(a.duration_seconds), 0) < (t.duration_minutes * 60) * 0.1

    UNION ALL

    -- 10. NEW (Epic 15). Stops are visited in sort_order; chapters run in
    --     their own sort_order. A stop whose chapter comes BEFORE the previous
    --     stop's chapter means the two orders disagree.
    SELECT 'error', 'chapter_order_mismatch', o.id,
           format('Waypoint %s (sort_order %s) is in chapter %s, which comes before the chapter of the stop before it. Order the stops chapter by chapter.',
                  o.name, o.sort_order, o.chapter_order)
    FROM (
        SELECT w.id, w.name, w.sort_order, c.sort_order AS chapter_order,
               lag(c.sort_order) OVER (ORDER BY w.sort_order) AS prev_chapter_order
        FROM public.waypoints w
        JOIN public.tour_chapters c ON c.id = w.chapter_id
        WHERE w.tour_id = p_tour_id
    ) o
    WHERE o.prev_chapter_order IS NOT NULL
      AND o.chapter_order < o.prev_chapter_order

    UNION ALL

    -- 11. NEW. Headings, once there is more than one chapter to tell apart.
    SELECT 'error', 'chapter_untitled', NULL::uuid,
           format('Chapter %s has no title; a tour with %s chapters needs one on each.',
                  c.sort_order, (SELECT count(*) FROM public.tour_chapters x WHERE x.tour_id = p_tour_id))
    FROM public.tour_chapters c
    WHERE c.tour_id = p_tour_id
      AND c.title IS NULL
      AND (SELECT count(*) FROM public.tour_chapters x WHERE x.tour_id = p_tour_id) > 1

    UNION ALL

    -- 12. NEW. Nothing to hear and nowhere to go.
    SELECT 'error', 'chapter_empty', NULL::uuid,
           format('Chapter %s (%s) has no waypoints and no navigation destination, so it does nothing.',
                  c.sort_order, coalesce(c.title, 'untitled'))
    FROM public.tour_chapters c
    WHERE c.tour_id = p_tour_id
      AND c.destination IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.waypoints w WHERE w.chapter_id = c.id)

    UNION ALL

    -- 13. NEW. Anchors are via-points on the way to the destination.
    SELECT 'error', 'chapter_anchors_without_destination', NULL::uuid,
           format('Chapter %s (%s) has routing anchors but no destination; set the destination the navigation app should route to.',
                  c.sort_order, coalesce(c.title, 'untitled'))
    FROM public.tour_chapters c
    WHERE c.tour_id = p_tour_id
      AND c.destination IS NULL
      AND EXISTS (SELECT 1 FROM public.chapter_route_anchors a WHERE a.chapter_id = c.id)

    UNION ALL

    -- 14. NEW. The provider's hard cap.
    SELECT 'error', 'chapter_too_many_anchors', NULL::uuid,
           format('Chapter %s (%s) has %s routing anchors; Google Maps accepts at most %s.',
                  c.sort_order, coalesce(c.title, 'untitled'), x.n, public.max_route_anchors())
    FROM public.tour_chapters c
    CROSS JOIN LATERAL (
        SELECT count(*) AS n FROM public.chapter_route_anchors a WHERE a.chapter_id = c.id
    ) x
    WHERE c.tour_id = p_tour_id
      AND x.n > public.max_route_anchors()

    UNION ALL

    -- 15. NEW. Warning. The browser fallback's lower cap.
    SELECT 'warning', 'chapter_anchors_browser_limit', NULL::uuid,
           format('Chapter %s (%s) has %s routing anchors. Without the Google Maps app the link opens in a browser, which honours only 3.',
                  c.sort_order, coalesce(c.title, 'untitled'), x.n)
    FROM public.tour_chapters c
    CROSS JOIN LATERAL (
        SELECT count(*) AS n FROM public.chapter_route_anchors a WHERE a.chapter_id = c.id
    ) x
    WHERE c.tour_id = p_tour_id
      AND x.n > 3
      AND x.n <= public.max_route_anchors()

    UNION ALL

    -- 16. NEW. Warning. A direction check walking pace cannot satisfy.
    SELECT 'warning', 'bearing_required_at_walking_pace', w.id,
           format('Waypoint %s requires an approach bearing, but it is in a walking chapter: GPS course is unreliable at walking speed, so it will rarely fire. Use ''preferred'' or ''ignore''.',
                  w.name)
    FROM public.waypoints w
    JOIN public.tour_chapters c ON c.id = w.chapter_id
    WHERE w.tour_id = p_tour_id
      AND w.bearing_policy = 'required'
      AND c.transit_mode = 'walking'

    UNION ALL

    -- 17. NEW (Epic 16). PM MVP rule.
    SELECT 'error', 'extension_in_anchored_driving_chapter', w.id,
           format('Waypoint %s is an extension in driving chapter %s (%s), which has routing anchors. Google Maps follows the anchors and would drive past it. Make it core, or remove the anchors.',
                  w.name, c.sort_order, coalesce(c.title, 'untitled'))
    FROM public.waypoints w
    JOIN public.tour_chapters c ON c.id = w.chapter_id
    WHERE w.tour_id = p_tour_id
      AND w.stop_role = 'extension'
      AND c.transit_mode = 'driving'
      AND EXISTS (SELECT 1 FROM public.chapter_route_anchors a WHERE a.chapter_id = c.id)

    UNION ALL

    -- 18. NEW. Warning. Same mechanism, walking/biking handoff.
    SELECT 'warning', 'extension_in_anchored_chapter', w.id,
           format('Waypoint %s is an extension in %s chapter %s (%s), which has routing anchors. A navigation app following the anchors may not pass it.',
                  w.name, c.transit_mode, c.sort_order, coalesce(c.title, 'untitled'))
    FROM public.waypoints w
    JOIN public.tour_chapters c ON c.id = w.chapter_id
    WHERE w.tour_id = p_tour_id
      AND w.stop_role = 'extension'
      AND c.transit_mode <> 'driving'
      AND EXISTS (SELECT 1 FROM public.chapter_route_anchors a WHERE a.chapter_id = c.id)

    UNION ALL

    -- 19. NEW. Content no one can reach.
    SELECT 'error', 'extension_unreachable', w.id,
           format('Waypoint %s is an extension, but chapter %s (%s) is not plannable. Catalogue sessions play core stops only and the planner never selects this chapter, so no one would hear it. Make it core, or make the chapter plannable.',
                  w.name, c.sort_order, coalesce(c.title, 'untitled'))
    FROM public.waypoints w
    JOIN public.tour_chapters c ON c.id = w.chapter_id
    WHERE w.tour_id = p_tour_id
      AND w.stop_role = 'extension'
      AND NOT c.plannable

    UNION ALL

    -- 20. NEW. A plannable chapter needs a backbone.
    SELECT 'error', 'plannable_chapter_without_core', NULL::uuid,
           format('Chapter %s (%s) is plannable but has no core stop; a plan could include it and play nothing.',
                  c.sort_order, coalesce(c.title, 'untitled'))
    FROM public.tour_chapters c
    WHERE c.tour_id = p_tour_id
      AND c.plannable
      AND NOT EXISTS (SELECT 1 FROM public.waypoints w
                       WHERE w.chapter_id = c.id AND w.stop_role = 'core')

    UNION ALL

    -- 21. NEW. Warning. Extensions are selected by interest.
    SELECT 'warning', 'extension_untagged', w.id,
           format('Waypoint %s is an extension with no interest tags, so no visitor''s interests will select it.', w.name)
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
      AND w.stop_role = 'extension'
      AND cardinality(w.interests) = 0

    UNION ALL

    -- 22. NEW. Warning. Endpoints that do not fit the chapter.
    SELECT 'warning', 'plannable_endpoint_far', NULL::uuid,
           format('Chapter %s (%s): %s is %s m from %s. Check for swapped lon/lat or a stale pre-fill.',
                  e.sort_order, coalesce(e.title, 'untitled'), e.what, round(e.metres), e.other)
    FROM (
        SELECT c.sort_order, c.title, x.what, x.other, x.metres, x.limit_m
        FROM public.tour_chapters c
        CROSS JOIN LATERAL (
            SELECT 'entry_point' AS what, 'the first core stop' AS other,
                   ST_Distance(c.entry_point::geography, f.geom::geography) AS metres,
                   CASE WHEN c.transit_mode = 'driving' THEN NULL ELSE 2000 END AS limit_m
              FROM (SELECT w.geom FROM public.waypoints w
                     WHERE w.chapter_id = c.id AND w.stop_role = 'core'
                     ORDER BY w.sort_order LIMIT 1) f
            UNION ALL
            SELECT 'exit_point', 'the last core stop',
                   ST_Distance(c.exit_point::geography, l.geom::geography),
                   CASE WHEN c.transit_mode = 'driving' THEN NULL ELSE 2000 END
              FROM (SELECT w.geom FROM public.waypoints w
                     WHERE w.chapter_id = c.id AND w.stop_role = 'core'
                     ORDER BY w.sort_order DESC LIMIT 1) l
            UNION ALL
            SELECT 'exit_point', 'the chapter''s handoff destination',
                   ST_Distance(c.exit_point::geography, c.destination::geography),
                   500
             WHERE c.destination IS NOT NULL
        ) x
        WHERE c.tour_id = p_tour_id
          AND c.plannable
    ) e
    WHERE e.limit_m IS NOT NULL
      AND e.metres > e.limit_m;
$fn$;

COMMENT ON FUNCTION public.cms_validate_tour(uuid) IS
    'Pre-flight checks for publishing. One row per problem; errors block publication, warnings do not. Covers missing narration, missing storage objects, unreachable Deep Dives, route coverage and order, orphaned transcripts, untagged tours, tours with no city, and (Epic 15) chapter order, titles, handoff destinations, routing-anchor caps and walking-pace bearing checks, and (Epic 16) core/extension and planner-eligibility checks, including no extension in an anchored driving chapter.';

-- -----------------------------------------------------------------------------
-- 5. get_planner_candidates
--
-- The plan-tour Edge Function's ONE database read. It returns every chapter
-- that COULD appear in a feasible plan, with the ingredients the TypeScript
-- planner needs, and the cached costs between and inside those chapters.
--
-- WHO CALLS IT: service_role only. Not anon, not authenticated.
--   * It reads chapter_travel_matrix and chapter_leg_costs, which are
--     service-role-only (a cost cache is not public API).
--   * Executable by anon, it would be a compute endpoint reachable straight
--     through PostgREST, bypassing the Edge Function's consume_rate_limit.
-- Because service_role bypasses RLS, publication is enforced HERE, explicitly
-- (t.status = 'published'), not by policies. That is the public-content
-- pattern written as a predicate - the same rule the policies apply.
--
-- THE CONTRACT: PRUNE ONLY WHAT IS PROVABLY USELESS.
-- The RPC makes no judgement the planner should make. A chapter is dropped
-- for exactly one of these reasons, evaluated in this order, and each count is
-- returned in `pruned` so the Edge Function can tell no_candidates from
-- origin_out_of_range from plan_infeasible instead of guessing:
--
--   excluded        the caller asked (exclude_chapter_ids)
--   mode            its transit mode is not eligible for the visitor's mode:
--                     walking -> walking
--                     biking  -> walking, biking
--                     driving -> walking, driving
--   invalid         no core stop (cms_validate_tour blocks this at publish;
--                   counted rather than hidden if an edit after publish
--                   created it)
--   audience        the tour is restricted to audiences excluding group_type
--   interests       the chapter is tagged and shares no interest with the
--                   visitor. A chapter's interests = those of its core stops
--                   and audience-eligible extensions; if none are tagged, the
--                   tour's interests; if those are empty too, the chapter is
--                   unrestricted (the project-wide "empty = not restricted").
--   origin_too_far  ST_DWithin(entry, origin, budget * v_max(transfer mode))
--                   is false: even the transfer alone cannot fit
--   over_budget     lower_bound_s > budget
--
-- THE LOWER BOUND - why it is safe to prune on.
--
--   lower_bound_s = crow(origin, entry)              / v_max(transfer mode)
--                 + crow(entry -> cores... -> exit)  / v_max(chapter mode)
--                 + sum(core dwell)                    (+ core Deep Dives if
--                                                       p_include_deep_dives)
--
--   * crow (geodesic) distance <= any road distance, and every speed here is
--     an upper bound on what Valhalla models, so each travel term is <= the
--     real cost. The planner's pace factor (>= 1) only slows travel down.
--   * Valid for a chapter in ANY position, not just first: by the triangle
--     inequality, origin -> ... -> entry is at least crow(origin, entry), and
--     every eligible chapter mode is no faster than the transfer mode.
--   * Extensions and other chapters are left out, which only lowers it.
--   * dwell is not bounded but DEFINED here (stops[].dwell_s), and the
--     planner uses these exact values, so the term cannot disagree with it.
--   * floor(), not round(): real costs are stored as whole seconds.
--   So lower_bound_s > budget proves no plan containing the chapter fits.
--
-- v_max (m/s): walking 2.0 (7.2 km/h; Valhalla pedestrian default 5.1),
-- biking 9.0 (32 km/h; bicycle default ~20), driving 36.2 (130 km/h). If a
-- provider costing ever exceeds these, the bound stops being safe - test-cms
-- pins them.
--
-- DWELL - defined once, here:
--   driving chapter        dwell_s = dwell_seconds, else 0 (audio plays while
--                          moving); Deep Dives add nothing
--   walking/biking         dwell_s = dwell_seconds, else narration length;
--                          deep_dive_dwell_s = Deep Dive length
--
-- WHAT IS NOT CHECKED HERE: coords_key. Costs are returned with their keys and
-- the current coordinates; the Edge Function validates keys with the same
-- shared function that wrote them. Re-implementing the key format in SQL
-- would be a second formatter that can disagree with the first.
--
-- Output is deterministic (every array ordered, ties by id) - the planner's
-- determinism contract starts here. Shape:
--   { transfer_profile, budget_s, considered, pruned: {reason: n},
--     min_pruned_lower_bound_s, truncated,
--     candidates: [{ chapter_id, tour_id, tour_title, title, chapter_sort_order,
--                    transit_mode, profile, entry, exit, origin_crow_m,
--                    lower_bound_s, core_dwell_s, core_path_m,
--                    core_matched_weight,
--                    stops: [{ waypoint_id, sort_order, stop_role, poi_type,
--                              coordinates, eligible, dwell_s,
--                              deep_dive_dwell_s, narration_s,
--                              interest_weights, matched_weight }] }],
--     transfers: [{ from_chapter_id, to_chapter_id, duration_s, distance_m,
--                   coords_key }],             duration_s null = unroutable
--     legs:      [{ chapter_id, from_node, to_node, duration_s, distance_m,
--                   coords_key }] }
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_planner_candidates(
    p_city_id             uuid,
    p_origin_lon          double precision,
    p_origin_lat          double precision,
    p_transit_mode        text,
    p_group_type          text,
    p_interests           text[],
    p_budget_seconds      integer,
    p_include_deep_dives  boolean,
    p_exclude_chapter_ids uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    -- Survivors returned at most. A city holds ~30-50 plannable chapters (PM,
    -- 2 Oct), so this only guards a runaway catalogue; `truncated` says so.
    c_max_candidates CONSTANT int := 200;
    v_result jsonb;
BEGIN
    -- --- input: refused loudly, never defaulted ------------------------------
    IF p_city_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.cities c WHERE c.id = p_city_id) THEN
        RAISE EXCEPTION 'City % not found.', p_city_id USING ERRCODE = 'no_data_found';
    END IF;
    IF p_origin_lon IS NULL OR p_origin_lat IS NULL
       OR p_origin_lat < -90 OR p_origin_lat > 90 OR p_origin_lon < -180 OR p_origin_lon > 180 THEN
        RAISE EXCEPTION 'Origin needs lon and lat in range, got lon %, lat %.', p_origin_lon, p_origin_lat
            USING ERRCODE = '22023';
    END IF;
    IF p_transit_mode IS NULL OR p_transit_mode NOT IN ('walking', 'biking', 'driving') THEN
        RAISE EXCEPTION 'transit_mode must be walking, biking or driving, got %.', p_transit_mode
            USING ERRCODE = '22023';
    END IF;
    IF p_group_type IS NULL OR NOT (p_group_type = ANY (public.audience_tag_vocabulary())) THEN
        RAISE EXCEPTION 'group_type % is not in audience_tag_vocabulary().', p_group_type
            USING ERRCODE = '22023';
    END IF;
    IF p_interests IS NULL OR cardinality(p_interests) = 0
       OR array_position(p_interests, NULL) IS NOT NULL
       OR NOT (p_interests <@ public.interest_tag_vocabulary()) THEN
        RAISE EXCEPTION 'interests must be a non-empty subset of interest_tag_vocabulary(), got %.', p_interests
            USING ERRCODE = '22023';
    END IF;
    -- Same range as tour_plans_budget_check: a candidate set for a budget no
    -- plan could be stored with is wasted work.
    IF p_budget_seconds IS NULL OR p_budget_seconds NOT BETWEEN 900 AND 86400 THEN
        RAISE EXCEPTION 'budget_seconds must be 900..86400, got %.', p_budget_seconds
            USING ERRCODE = '22023';
    END IF;
    IF p_include_deep_dives IS NULL THEN
        RAISE EXCEPTION 'include_deep_dives is required.' USING ERRCODE = '22023';
    END IF;
    IF cardinality(coalesce(p_exclude_chapter_ids, '{}')) > 50 THEN
        RAISE EXCEPTION 'At most 50 exclude_chapter_ids, got %.', cardinality(p_exclude_chapter_ids)
            USING ERRCODE = '22023';
    END IF;

    WITH k AS (
        SELECT
            ST_SetSRID(ST_MakePoint(p_origin_lon, p_origin_lat), 4326)::geography AS origin,
            CASE p_transit_mode
                WHEN 'walking' THEN ARRAY['walking']
                WHEN 'biking'  THEN ARRAY['walking', 'biking']
                ELSE                ARRAY['walking', 'driving']
            END AS modes,
            CASE p_transit_mode
                WHEN 'walking' THEN 'pedestrian' WHEN 'biking' THEN 'bicycle' ELSE 'auto'
            END AS transfer_profile,
            CASE p_transit_mode
                WHEN 'walking' THEN 2.0 WHEN 'biking' THEN 9.0 ELSE 36.2
            END::double precision AS v_transfer
    ),
    -- Every plannable chapter of a PUBLISHED tour in the city. The status
    -- predicate is the authority (service_role bypasses RLS).
    chapters AS (
        SELECT
            c.id, c.tour_id, c.sort_order, c.title, c.transit_mode,
            c.entry_point, c.exit_point,
            t.title     AS tour_title,
            t.audiences AS tour_audiences,
            t.interests AS tour_interests,
            CASE c.transit_mode
                WHEN 'walking' THEN 'pedestrian' WHEN 'biking' THEN 'bicycle' ELSE 'auto'
            END AS profile,
            CASE c.transit_mode
                WHEN 'walking' THEN 2.0 WHEN 'biking' THEN 9.0 ELSE 36.2
            END::double precision AS v_chapter
        FROM public.tour_chapters c
        JOIN public.tours t ON t.id = c.tour_id
        WHERE t.city_id = p_city_id
          AND t.status  = 'published'
          AND c.plannable
    ),
    stops AS (
        SELECT
            w.chapter_id, w.id, w.sort_order, w.stop_role, w.poi_type, w.geom, w.interests,
            n.duration_seconds AS narration_s,
            CASE WHEN ch.transit_mode = 'driving' THEN coalesce(w.dwell_seconds, 0)
                 ELSE coalesce(w.dwell_seconds, n.duration_seconds, 0)
            END AS dwell_s,
            CASE WHEN ch.transit_mode = 'driving' THEN 0
                 ELSE coalesce(d.duration_seconds, 0)
            END AS deep_dive_dwell_s,
            -- Core stops are the backbone and always play; an extension
            -- restricted to other audiences can never be kept.
            (w.stop_role = 'core' OR cardinality(w.audiences) = 0 OR p_group_type = ANY (w.audiences))
                AS eligible,
            wt.weights,
            wt.matched_weight
        FROM chapters ch
        JOIN public.waypoints w ON w.chapter_id = ch.id
        LEFT JOIN LATERAL (
            SELECT a.duration_seconds FROM public.audio_tracks a
             WHERE a.waypoint_id = w.id AND a.track_kind = 'narration'
             ORDER BY a.id LIMIT 1
        ) n ON TRUE
        LEFT JOIN LATERAL (
            SELECT a.duration_seconds FROM public.audio_tracks a
             WHERE a.waypoint_id = w.id AND a.track_kind = 'deep_dive'
             ORDER BY a.id LIMIT 1
        ) d ON TRUE
        CROSS JOIN LATERAL (
            -- Weight of each listed interest (no row = 2), and the sum over
            -- the visitor's interests.
            SELECT coalesce(jsonb_object_agg(i.interest, coalesce(x.weight, 2)), '{}'::jsonb) AS weights,
                   coalesce(sum(coalesce(x.weight, 2)) FILTER (WHERE i.interest = ANY (p_interests)), 0)::int
                       AS matched_weight
              FROM unnest(w.interests) AS i(interest)
              LEFT JOIN public.waypoint_interest_weights x
                     ON x.waypoint_id = w.id AND x.interest = i.interest
        ) wt
    ),
    per_chapter AS (
        SELECT ch.*, agg.*
        FROM chapters ch
        CROSS JOIN LATERAL (
            SELECT
                count(DISTINCT s.id) FILTER (WHERE s.stop_role = 'core') AS core_count,
                coalesce(array_agg(DISTINCT i.interest) FILTER (WHERE i.interest IS NOT NULL), '{}')
                    AS stop_interests
            FROM stops s
            LEFT JOIN LATERAL unnest(s.interests) AS i(interest) ON TRUE
            WHERE s.chapter_id = ch.id
              AND s.eligible
        ) agg
    ),
    pathed AS (
        SELECT pc.*,
               cs.core_dwell_s,
               cs.core_matched_weight,
               -- entry -> core stops in sort_order -> exit, as straight lines.
               ST_Length(ST_MakeLine(
                   ARRAY[pc.entry_point::geometry]
                   || coalesce(cs.core_geoms, '{}'::geometry[])
                   || ARRAY[pc.exit_point::geometry]
               )::geography) AS core_path_m,
               CASE WHEN cardinality(pc.stop_interests) > 0 THEN pc.stop_interests
                    ELSE pc.tour_interests END AS chapter_interests
        FROM per_chapter pc
        CROSS JOIN LATERAL (
            SELECT array_agg(s.geom::geometry ORDER BY s.sort_order) AS core_geoms,
                   coalesce(sum(s.dwell_s + CASE WHEN p_include_deep_dives THEN s.deep_dive_dwell_s ELSE 0 END), 0)::int
                       AS core_dwell_s,
                   coalesce(sum(s.matched_weight), 0)::int AS core_matched_weight
              FROM stops s
             WHERE s.chapter_id = pc.id
               AND s.stop_role = 'core'
        ) cs
    ),
    evaluated AS (
        SELECT p.*,
               b.origin_crow_m,
               b.lower_bound_s,
               CASE
                   WHEN p.id = ANY (coalesce(p_exclude_chapter_ids, '{}'))           THEN 'excluded'
                   WHEN NOT (p.transit_mode = ANY (k.modes))                         THEN 'mode'
                   WHEN p.core_count = 0                                             THEN 'invalid'
                   WHEN NOT (cardinality(p.tour_audiences) = 0
                             OR p_group_type = ANY (p.tour_audiences))               THEN 'audience'
                   WHEN cardinality(p.chapter_interests) > 0
                        AND NOT (p.chapter_interests && p_interests)                 THEN 'interests'
                   WHEN NOT ST_DWithin(p.entry_point::geography, k.origin,
                                       p_budget_seconds * k.v_transfer)              THEN 'origin_too_far'
                   WHEN b.lower_bound_s > p_budget_seconds                           THEN 'over_budget'
               END AS prune_reason
        FROM pathed p
        CROSS JOIN k
        CROSS JOIN LATERAL (
            SELECT ST_Distance(p.entry_point::geography, k.origin) AS origin_crow_m,
                   floor(  ST_Distance(p.entry_point::geography, k.origin) / k.v_transfer
                         + p.core_path_m / p.v_chapter
                         + p.core_dwell_s)::int AS lower_bound_s
        ) b
    ),
    survivors AS (
        SELECT e.*
        FROM evaluated e
        WHERE e.prune_reason IS NULL
        ORDER BY e.lower_bound_s, e.id
        LIMIT c_max_candidates
    )
    SELECT jsonb_build_object(
        'transfer_profile', k.transfer_profile,
        'budget_s',         p_budget_seconds,
        'considered',       (SELECT count(*) FROM evaluated),
        'pruned',           coalesce((SELECT jsonb_object_agg(x.prune_reason, x.n)
                                        FROM (SELECT e.prune_reason, count(*) AS n
                                                FROM evaluated e
                                               WHERE e.prune_reason IS NOT NULL
                                               GROUP BY e.prune_reason) x), '{}'::jsonb),
        -- A lower bound on plan_infeasible's shortfall: cheapest pruned chapter.
        'min_pruned_lower_bound_s',
                            (SELECT min(e.lower_bound_s) FROM evaluated e
                              WHERE e.prune_reason IN ('origin_too_far', 'over_budget')),
        'truncated',        (SELECT count(*) FROM evaluated e WHERE e.prune_reason IS NULL) > c_max_candidates,
        'candidates', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'chapter_id',          s.id,
                'tour_id',             s.tour_id,
                'tour_title',          s.tour_title,
                'title',               s.title,
                'chapter_sort_order',  s.sort_order,
                'transit_mode',        s.transit_mode,
                'profile',             s.profile,
                'entry',               jsonb_build_array(ST_X(s.entry_point), ST_Y(s.entry_point)),
                'exit',                jsonb_build_array(ST_X(s.exit_point),  ST_Y(s.exit_point)),
                'origin_crow_m',       round(s.origin_crow_m)::int,
                'lower_bound_s',       s.lower_bound_s,
                'core_dwell_s',        s.core_dwell_s,
                'core_path_m',         round(s.core_path_m)::int,
                'core_matched_weight', s.core_matched_weight,
                'stops', (
                    SELECT jsonb_agg(jsonb_build_object(
                        'waypoint_id',       st.id,
                        'sort_order',        st.sort_order,
                        'stop_role',         st.stop_role,
                        'poi_type',          st.poi_type,
                        'coordinates',       jsonb_build_array(ST_X(st.geom), ST_Y(st.geom)),
                        'eligible',          st.eligible,
                        'dwell_s',           st.dwell_s,
                        'deep_dive_dwell_s', st.deep_dive_dwell_s,
                        'narration_s',       st.narration_s,
                        'interest_weights',  st.weights,
                        'matched_weight',    st.matched_weight
                    ) ORDER BY st.sort_order, st.id)
                    FROM stops st
                    WHERE st.chapter_id = s.id
                )
            ) ORDER BY s.lower_bound_s, s.id)
            FROM survivors s
        ), '[]'::jsonb),
        'transfers', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'from_chapter_id', m.from_chapter_id,
                'to_chapter_id',   m.to_chapter_id,
                'duration_s',      m.duration_seconds,
                'distance_m',      m.distance_meters,
                'coords_key',      m.coords_key
            ) ORDER BY m.from_chapter_id, m.to_chapter_id)
            FROM public.chapter_travel_matrix m
            WHERE m.profile = k.transfer_profile
              AND m.from_chapter_id IN (SELECT s.id FROM survivors s)
              AND m.to_chapter_id   IN (SELECT s.id FROM survivors s)
        ), '[]'::jsonb),
        'legs', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'chapter_id', l.chapter_id,
                'from_node',  l.from_node,
                'to_node',    l.to_node,
                'duration_s', l.duration_seconds,
                'distance_m', l.distance_meters,
                'coords_key', l.coords_key
            ) ORDER BY l.chapter_id, l.from_node, l.to_node)
            FROM public.chapter_leg_costs l
            JOIN survivors s ON s.id = l.chapter_id AND l.profile = s.profile
        ), '[]'::jsonb)
    )
    INTO v_result
    FROM k;

    RETURN v_result;
END;
$fn$;

COMMENT ON FUNCTION public.get_planner_candidates(uuid, double precision, double precision, text, text, text[], integer, boolean, uuid[]) IS
    'Epic 16: the plan-tour Edge Function''s single read. Plannable chapters of published tours in a city, pruned only by provable reasons (mode, audience, interests, and a lower bound on time vs budget), with per-stop dwell, interest weights, and the cached transfer/leg costs among the survivors. service_role only.';

REVOKE ALL ON FUNCTION public.get_planner_candidates(uuid, double precision, double precision, text, text, text[], integer, boolean, uuid[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_planner_candidates(uuid, double precision, double precision, text, text, text[], integer, boolean, uuid[])
    TO service_role;

-- Self-check, as in 20261002120000: fail the push rather than ship an
-- anon-reachable compute endpoint.
DO $check$
DECLARE
    v_sig text := 'public.get_planner_candidates(uuid, double precision, double precision, text, text, text[], integer, boolean, uuid[])';
BEGIN
    IF has_function_privilege('anon', v_sig, 'EXECUTE')
       OR has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'get_planner_candidates is executable by anon or authenticated; it must be service_role only.';
    END IF;
    IF NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
        RAISE EXCEPTION 'get_planner_candidates is not executable by service_role.';
    END IF;
END
$check$;
