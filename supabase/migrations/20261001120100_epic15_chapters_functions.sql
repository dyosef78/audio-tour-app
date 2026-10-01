-- =============================================================================
-- Epic 15 (Part 2 of 2): Chapters, routing anchors, approach bearings - FUNCTIONS
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
-- Requires 20261001120000 (same push).
--
--   1. get_tour_bundle             + top-level `chapters`, + per-waypoint
--                                    `chapter_id` and `approach`
--   2. cms_upsert_tour             same signature; p_transit_mode now writes the
--                                    chapter of a single-chapter tour
--   3. cms_replace_tour_chapters   NEW: chapters, destinations, anchors
--   4. cms_replace_tour_waypoints  same signature; items gain optional
--                                    `chapter_id` and `approach`
--   5. cms_validate_tour           route tolerance per CHAPTER mode, + 7 checks
--
-- No signature changes to existing functions: CREATE OR REPLACE keeps their
-- grants and adds no overload (PGRST203 - see 20260915120100).
--
-- Not here (next migration, after the Valhalla CMS work - Epic 15 decision 5):
-- per-chapter reference route, CMS-time bearing derivation, and the
-- gap_along_route >= duration * speed check. Those need a chapter route to
-- measure along, and its shape is that task's decision.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. get_tour_bundle  (+ chapters, + chapter_id/approach per waypoint)
--
-- Reproduced from 20260916090000 (what production runs). The waypoint rows CTE
-- gains five columns, the payload gains three keys, and the hash gains three
-- terms. Nothing existing is edited - `npm run test:cms` checks both hash
-- expressions are the production ones with terms APPENDED.
--
-- Wire additions:
--
--   "chapters": [{
--     "chapter_id", "sort_order", "title" (null for a single plain chapter),
--     "transit_mode", "sequence_policy", "lookahead_stops",
--     "handoff": null | {
--       "destination": [lon, lat], "destination_label": string | null,
--       "anchors": [[lon, lat], ...],         in order, <= 9
--       "providers": ["google_maps"] | ["google_maps", "waze"]
--     }
--   }]
--   waypoints[i].chapter_id   uuid
--   waypoints[i].approach     null | { "bearing_deg", "tolerance_deg", "policy" }
--                             null exactly when bearing_policy = 'ignore'
--
-- `providers` is decided HERE so the rule lives in one place (PM, Epic 15
-- decision 2): Waze takes a single destination and no waypoints, and only
-- drives - so Waze only for a DRIVING chapter with ZERO anchors. An app reads
-- the list; it does not re-derive it. The list is not hashed separately: it is
-- a function of transit_mode and the anchors, which are.
--
-- THE HASH. Same rule as TASK-603/604: a new term is NULL whenever its content
-- is absent, so concat_ws skips it and every existing hash stays byte-identical.
--
--   per waypoint  'ch=<chapter_id>'   NULL while the waypoint is in the chapter
--                                     whose id is the tour id
--                 'b=<policy>/<deg>/<tol>'   NULL while bearing_policy = 'ignore'
--   per tour      'chapters=<md5>'    NULL while the tour is PLAIN: exactly one
--                                     chapter, id = tour id, no title, no
--                                     destination, no anchors, and the default
--                                     sequence_policy/lookahead_stops
--
-- Every tour today is plain (20261001120000 section 4), so no device
-- re-downloads anything. What a plain tour's manifest omits is exactly what a
-- device synthesises for a manifest without `chapters` - the defaults ARE the
-- contract, and test-cms pins them against the app's constants.
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
      w.bearing_policy
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
            END
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
                    || '/' || r.bearing_tolerance_deg::text END
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
  'Offline bundle payload: decoded coordinates, geofences, narration and deep_dive media, WebVTT transcript sidecars, preference tags, the tour route, and (Epic 15) chapters with navigation handoff plus per-waypoint chapter and approach bearing, with a content-derived bundle_version_hash. Runs as the caller, so RLS applies. A plain single-chapter tour hashes exactly as before Epic 15.';

GRANT EXECUTE ON FUNCTION public.get_tour_bundle(uuid) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. cms_upsert_tour - same signature, new meaning for p_transit_mode
--
-- Creating a tour is unchanged: trg_tours_create_default_chapter gives it one
-- chapter in p_transit_mode.
--
-- Updating: tours.transit_mode is derived now, so the mode is written where it
-- lives. A single-chapter tour (every tour today) has its chapter set to
-- p_transit_mode, and the mirror carries it to tours - the pre-Epic-15 CMS
-- keeps working. A multi-chapter tour accepts only its current derived value;
-- anything else is refused by trg_tours_guard_transit_mode with a message
-- naming tour_chapters. Never silently ignored.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_upsert_tour(
    p_tour_id          uuid,
    p_title            text,
    p_topology         text,
    p_transit_mode     text,
    p_duration_minutes int,
    p_audiences        text[] DEFAULT NULL,
    p_interests        text[] DEFAULT NULL
)
RETURNS public.tours
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_row       public.tours;
    v_audiences text[];
    v_interests text[];
BEGIN
    PERFORM public.assert_cms_admin();

    v_audiences := public.cms_normalise_tags(p_audiences, public.audience_tag_vocabulary(), 'audience');
    v_interests := public.cms_normalise_tags(p_interests, public.interest_tag_vocabulary(), 'interest');

    IF p_tour_id IS NULL THEN
        INSERT INTO public.tours (title, topology, transit_mode, duration_minutes, audiences, interests)
        VALUES (p_title, p_topology, p_transit_mode, p_duration_minutes,
                coalesce(v_audiences, '{}'), coalesce(v_interests, '{}'))
        RETURNING * INTO v_row;
    ELSE
        -- NEW (Epic 15). Only a tour with exactly one chapter.
        UPDATE public.tour_chapters c
           SET transit_mode = p_transit_mode
         WHERE c.tour_id = p_tour_id
           AND c.transit_mode IS DISTINCT FROM p_transit_mode
           AND (SELECT count(*) FROM public.tour_chapters x WHERE x.tour_id = p_tour_id) = 1;

        UPDATE public.tours t
           SET title            = p_title,
               topology         = p_topology,
               transit_mode     = p_transit_mode,
               duration_minutes = p_duration_minutes,
               audiences        = coalesce(v_audiences, t.audiences),
               interests        = coalesce(v_interests, t.interests)
         WHERE t.id = p_tour_id
        RETURNING * INTO v_row;

        -- Zero rows is either a bad id or an RLS denial, and the caller cannot
        -- tell those apart. assert_cms_admin() has ruled out the denial.
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Tour % not found.', p_tour_id
                USING ERRCODE = 'no_data_found';
        END IF;
    END IF;

    RETURN v_row;
END;
$fn$;

COMMENT ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, int, text[], text[]) IS
    'Create (p_tour_id NULL) or update a tour. p_transit_mode: a new tour''s first chapter mode; on update it sets the mode of a single-chapter tour, and must equal the derived mode of a multi-chapter one (use cms_replace_tour_chapters). p_audiences / p_interests: NULL leaves stored tags unchanged, ''{}'' clears them. status is not settable here - use cms_publish_tour().';

-- -----------------------------------------------------------------------------
-- 3. cms_replace_tour_chapters  (NEW)
--
-- Replace-all, like cms_replace_tour_waypoints: a chapter absent from the
-- payload is deleted. Item:
--
--   {
--     "id":              uuid | null      null/absent = create
--     "sort_order":      int              required
--     "transit_mode":    text             required to create; absent = unchanged
--     "title":           text | null      absent = unchanged, null = clear
--     "sequence_policy": text             absent = unchanged (default on create)
--     "lookahead_stops": int              absent = unchanged (default on create)
--     "destination":     {"lon","lat","label"?} | null
--                                         absent = unchanged, null = no handoff
--     "anchors":         [{"lon","lat"}, ...]
--                                         absent = unchanged, [] = none;
--                                         replaces the list, in array order
--   }
--
-- "Absent = unchanged" matches the tags rule in cms_replace_tour_waypoints, so
-- a CMS build that does not yet know a key can never wipe it.
--
-- A chapter that still owns waypoints is NOT deleted: the call is refused,
-- naming the chapters. Move or delete their waypoints first with
-- cms_replace_tour_waypoints - deleting audio is that RPC's job, because it
-- reports the orphaned storage objects.
--
-- Returns { tour_id, upserted, deleted, chapter_ids } with chapter_ids in
-- PAYLOAD order, so the CMS can address newly created chapters in its next
-- cms_replace_tour_waypoints call.
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
               destination_label = CASE WHEN v_item ? 'destination' THEN v_label ELSE c.destination_label END
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
    'Epic 15: replaces a tour''s chapter list (transit mode, sequencing, navigation destination and routing anchors); chapters absent from the payload are deleted, unless they still hold waypoints, which is refused. Optional keys: absent leaves the stored value. Returns chapter_ids in payload order.';

-- FROM anon explicitly: Supabase's default privileges GRANT EXECUTE on every
-- new public function to anon by name, which REVOKE ... FROM PUBLIC does not
-- touch. assert_cms_admin() is still the authority; this just stops anon
-- reaching it. (Every older cms_* RPC is anon-executable for the same reason.)
REVOKE ALL ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cms_replace_tour_chapters(uuid, jsonb) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. cms_replace_tour_waypoints  (+ chapter_id, + approach per item)
--
-- Same signature, so a plain replace. Reproduced from 20260915120100. Items
-- gain two optional keys, both "absent = unchanged" like the tags:
--
--   "chapter_id": uuid
--       absent on a NEW waypoint: the tour's only chapter
--       (trg_waypoints_default_chapter), refused when it has several.
--       Must be a chapter of THIS tour.
--
--   "approach": { "bearing_deg": 0..359, "tolerance_deg"?: 10..90 (45),
--                 "policy": "required" | "preferred" | "ignore",
--                 "source"?: "authored" | "derived" ("authored") } | null
--       null clears it (policy 'ignore', no bearing).
--
-- Range and pairing errors come from the table's CHECK constraints, which name
-- the rule that was broken.
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

        v_waypoint_id := nullif(v_item ->> 'id', '')::uuid;

        IF v_waypoint_id IS NULL THEN
            -- chapter_id NULL here = the tour's only chapter (trigger).
            INSERT INTO public.waypoints
                (tour_id, name, poi_type, geom, sort_order, audiences, interests, chapter_id)
            VALUES (
                p_tour_id,
                v_item ->> 'name',
                v_item ->> 'poi_type',
                ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326),
                (v_item ->> 'sort_order')::int,
                coalesce(v_audiences, '{}'),
                coalesce(v_interests, '{}'),
                v_chapter_id
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
                   chapter_id = coalesce(v_chapter_id, w.chapter_id)
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
    'Replaces a tour''s entire waypoint list; anything absent from the payload is deleted. Optional per-item keys - audiences/interests, chapter_id, approach - leave the stored value alone when absent. A new waypoint without chapter_id joins the tour''s only chapter (refused when it has several). Returns orphaned_objects - audio files and transcript sidecars of cascade-deleted tracks, which the caller must remove from the bucket because SQL cannot.';

-- -----------------------------------------------------------------------------
-- 5. cms_validate_tour
--
-- The body from 20260918090000 (production), with:
--   5a, 5b      route tolerance now uses the waypoint's CHAPTER mode - a
--               walking stop in a Drive -> Walk tour keeps its 150 m limit.
-- New (all Epic 15):
--   10 chapter_order_mismatch     (error)   waypoint sort_order interleaves
--                                           chapters; the visiting order and
--                                           the chapter order disagree
--   11 chapter_untitled           (error)   a tour with 2+ chapters needs a
--                                           heading on each
--   12 chapter_empty              (error)   no waypoints and no handoff: a
--                                           chapter that does nothing
--   13 chapter_anchors_without_destination (error) anchors route nowhere
--   14 chapter_too_many_anchors   (error)   > max_route_anchors(); the cap
--                                           trigger can be raced (see 20261001120000)
--   15 chapter_anchors_browser_limit (warning) > 3 anchors: a phone without the
--                                           Google Maps app opens the link in a
--                                           browser, which honours only 3
--   16 bearing_required_at_walking_pace (warning) a 'required' bearing on a
--                                           walking chapter: GPS course is
--                                           unusable at walking speed, so the
--                                           stop will rarely fire
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
      AND c.transit_mode = 'walking';
$fn$;

COMMENT ON FUNCTION public.cms_validate_tour(uuid) IS
    'Pre-flight checks for publishing. One row per problem; errors block publication, warnings do not. Covers missing narration, missing storage objects, unreachable Deep Dives, route coverage and order, orphaned transcripts, untagged tours, tours with no city, and (Epic 15) chapter order, titles, handoff destinations, routing-anchor caps and walking-pace bearing checks.';
