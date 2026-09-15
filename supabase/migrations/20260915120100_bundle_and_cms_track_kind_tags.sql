-- =============================================================================
-- TASK-603 (2 of 2) : bundle payload and CMS API for track_kind, tags, transcripts
--
-- STATUS: APPROVED 15 Sep 2026 (PM, TASK-603). NOT YET APPLIED to the linked
-- project. Requires 20260915120000. Rewrites functions only; touches no rows.
--
--   get_tour_bundle            narration-only media, deep_dive, transcripts, tags
--   cms_upsert_tour            + p_audiences, p_interests      (DROP + CREATE)
--   cms_register_audio_track   + p_track_kind                  (DROP + CREATE)
--   cms_replace_tour_waypoints + per-waypoint audiences/interests; sidecar orphans
--   cms_validate_tour          + Deep Dive, transcript and tag checks
--
-- WHY TWO FUNCTIONS ARE DROPPED RATHER THAN REPLACED
--
-- CREATE OR REPLACE with a different parameter list does not replace anything:
-- it creates an OVERLOAD beside the original. With the new parameters
-- defaulted, a call naming only the old parameters matches both, and PostgREST
-- answers PGRST203 "Could not choose the best candidate function" - so every
-- existing caller, including seed-tel-aviv-qa.ts, would break at once. Dropping
-- the old signature is what keeps those callers working unchanged.
--
-- FOLLOW-UP REQUIRED AFTER PUSHING
--
--   npm run types:generate      (functions and table columns changed)
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. get_tour_bundle
--
-- THE HASH DOES NOT MOVE FOR ANY EXISTING TOUR.
--
-- The signature below reproduces the original nine fields exactly, and appends
-- the new ones as expressions that are NULL when absent. concat_ws() skips NULL
-- arguments entirely - no value AND no separator - so a waypoint with no
-- transcript and no Deep Dive produces the byte-identical string it produced
-- before. Only content that actually gains a transcript or a Deep Dive gets a
-- new hash, and that is a re-download the device genuinely needs.
--
-- Transcripts ARE in the hash, by object eTag: a corrected transcript must
-- reach devices, and its byte count alone would miss a same-length fix.
--
-- Tags are NOT in the hash, on the TASK-507 precedent for audio_track_id.
-- Retagging changes no file, and a new hash makes the device re-download every
-- byte of audio (the downloader stages into a fresh directory). The cost is
-- that an offline bundle keeps the tags it was downloaded with.
--
-- NARRATION ONLY in `media`. The old lateral took ORDER BY id LIMIT 1 over all
-- of a waypoint's tracks; with a second kind allowed, that would have handed
-- devices a Deep Dive as the geofence narration whenever its uuid sorted first.
--
-- TRANSCRIPTS are discovered, not registered. The sidecar path is derived by
-- transcript_path_for() and looked up in storage.objects through the caller's
-- own RLS, which since 20260915120000 exposes a sidecar exactly when its
-- audio is published. An object whose Storage metadata reports no size is left
-- out: the downloader validates every file by byte count, and a transcript it
-- cannot validate would fail the whole bundle.
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
    -- LATERAL + LIMIT 1: the schema allows many zones per waypoint, and a plain
    -- LEFT JOIN would multiply rows. Ordering by id keeps the choice
    -- deterministic, which matters because it feeds the version hash.
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
      -- Unique per (waypoint_id, track_kind) now, so LIMIT 1 is belt and braces.
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
          -- [longitude, latitude], matching the manifest example.
          'coordinates', jsonb_build_array(r.lon, r.lat),
          'geofence',
            CASE
              WHEN r.zone_type IS NULL THEN NULL
              WHEN r.zone_type = 'polygon' THEN
                jsonb_build_object(
                  'type', 'polygon',
                  -- coordinates[0] is the exterior ring; holes are not modelled.
                  'ring', ST_AsGeoJSON(r.zone_geom)::jsonb -> 'coordinates' -> 0
                )
              ELSE
                jsonb_build_object(
                  'type', 'radius',
                  'radius_meters', r.trigger_radius_meters,
                  -- The stored polygon is a buffer of the waypoint, so the
                  -- waypoint's own point is the exact centre by construction.
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
      -- Canonical signature string. The first nine fields are EXACTLY the
      -- pre-TASK-603 signature; see the header before changing any of them.
      string_agg(
        concat_ws(':',
          r.id::text, r.sort_order::text, r.lon::text, r.lat::text,
          coalesce(r.storage_path, ''), coalesce(r.size_bytes::text, ''),
          coalesce(r.duration_seconds::text, ''), coalesce(r.zone_type, ''),
          coalesce(r.trigger_radius_meters::text, ''),
          -- NEW. Deliberately NOT coalesced: NULL is skipped by concat_ws.
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
                tr.duration_minutes::text, coalesce(a.signature, ''))
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
    'waypoints', coalesce(a.waypoints, '[]'::jsonb)
  )
  FROM public.tours tr
  CROSS JOIN agg a
  WHERE tr.id = p_tour_id;
$$;

COMMENT ON FUNCTION public.get_tour_bundle(uuid) IS
  'Offline bundle payload: decoded coordinates, geofences, narration media, optional deep_dive media, WebVTT transcript sidecars found in storage, and preference tags, plus a content-derived bundle_version_hash. Runs as the caller, so RLS applies. Tags and audio_track_id are excluded from the hash on purpose - see migration 20260915120100.';

GRANT EXECUTE ON FUNCTION public.get_tour_bundle(uuid) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Tag normalisation for the CMS functions
--
-- Validates against the vocabulary with a sentence rather than a constraint
-- name, and returns the array de-duplicated and sorted so that equal tag sets
-- are equal arrays. NULL in, NULL out: the callers use NULL to mean "leave the
-- stored tags alone", which is different from '{}', "clear them".
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_normalise_tags(
    p_tags       text[],
    p_vocabulary text[],
    p_label      text
)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_unknown text[];
BEGIN
    IF p_tags IS NULL THEN
        RETURN NULL;
    END IF;

    IF array_position(p_tags, NULL) IS NOT NULL THEN
        RAISE EXCEPTION '% tags may not contain null.', p_label USING ERRCODE = '22023';
    END IF;

    SELECT array_agg(DISTINCT t ORDER BY t)
      INTO v_unknown
      FROM unnest(p_tags) AS t
     WHERE NOT (t = ANY (p_vocabulary));

    IF v_unknown IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown % tag(s): %. Allowed: %.',
            p_label, array_to_string(v_unknown, ', '), array_to_string(p_vocabulary, ', ')
            USING ERRCODE = '22023';
    END IF;

    RETURN coalesce(
        (SELECT array_agg(DISTINCT t ORDER BY t) FROM unnest(p_tags) AS t),
        '{}'::text[]
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.cms_normalise_tags(text[], text[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_normalise_tags(text[], text[], text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. cms_upsert_tour  (+ p_audiences, p_interests)
--
-- Both default NULL = unchanged, so the existing five-argument call keeps
-- working and cannot wipe tags an editor set elsewhere. Pass '{}' to clear.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cms_upsert_tour(uuid, text, text, text, int);

CREATE FUNCTION public.cms_upsert_tour(
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
    'Create (p_tour_id NULL) or update a tour. p_audiences / p_interests: NULL leaves stored tags unchanged, ''{}'' clears them. status is not settable here - use cms_publish_tour().';

REVOKE ALL ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, int, text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, int, text[], text[]) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. cms_register_audio_track  (+ p_track_kind)
--
-- Everything from 20260828090000 stands - upload first, object must exist,
-- byte count must match, format derived from the extension. Additions:
--
--   * the conflict key is (waypoint_id, track_kind), so registering a Deep
--     Dive can never replace the narration;
--   * a Deep Dive on a transition stop is refused, because the app never
--     offers one there - it would be content nobody can reach;
--   * one waypoint's narration and Deep Dive may not share a path, or they
--     would share one file and one transcript;
--   * the return value reports what happened to transcripts, which SQL can
--     see but cannot delete:
--       orphaned_transcript      the old path's sidecar, when a replacement
--                                changed the path - the caller must delete it
--       transcript_needs_review  a replacement kept the path, so the existing
--                                transcript now sits beside NEW audio and its
--                                timings are almost certainly wrong
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.cms_register_audio_track(uuid, text, bigint, int, int);

CREATE FUNCTION public.cms_register_audio_track(
    p_waypoint_id        uuid,
    p_storage_path       text,
    p_size_bytes         bigint,
    p_duration_seconds   int,
    p_lufs_normalization int  DEFAULT -16,
    p_track_kind         text DEFAULT 'narration'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_format      text;
    v_poi_type    text;
    v_object_size bigint;
    v_previous    public.audio_tracks;
    v_row         public.audio_tracks;
    v_old_sidecar text;
    v_sidecar_existed boolean;
BEGIN
    PERFORM public.assert_cms_admin();

    -- --- the kind -----------------------------------------------------------
    IF p_track_kind IS NULL OR p_track_kind NOT IN ('narration', 'deep_dive') THEN
        RAISE EXCEPTION 'track_kind must be narration or deep_dive, got %.', p_track_kind
            USING ERRCODE = '22023';
    END IF;

    -- --- the waypoint -------------------------------------------------------
    SELECT w.poi_type INTO v_poi_type FROM public.waypoints w WHERE w.id = p_waypoint_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Waypoint % not found.', p_waypoint_id
            USING ERRCODE = 'no_data_found';
    END IF;

    IF p_track_kind = 'deep_dive' AND v_poi_type = 'transition' THEN
        RAISE EXCEPTION
            'Waypoint % is a transition stop. The app never offers a Deep Dive there, so this track could not be played.',
            p_waypoint_id
            USING ERRCODE = '23514';
    END IF;

    -- --- the path -----------------------------------------------------------
    IF p_storage_path IS NULL OR btrim(p_storage_path) = '' THEN
        RAISE EXCEPTION 'storage_path is required.' USING ERRCODE = '22023';
    END IF;

    IF p_storage_path ~ '^(https?://|/)' THEN
        RAISE EXCEPTION
            'storage_path must be relative to the audio-tracks bucket, not an absolute URL: %',
            p_storage_path
            USING ERRCODE = '22023';
    END IF;

    IF p_storage_path ~ '(^|/)\.\.?(/|$)' OR p_storage_path ~ '\\' THEN
        RAISE EXCEPTION 'storage_path may not contain path traversal segments: %', p_storage_path
            USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.audio_tracks a
         WHERE a.waypoint_id = p_waypoint_id
           AND a.track_kind <> p_track_kind
           AND a.storage_path = p_storage_path
    ) THEN
        RAISE EXCEPTION
            'storage_path % is already this waypoint''s other track. Narration and Deep Dive need separate files.',
            p_storage_path
            USING ERRCODE = '23505';
    END IF;

    -- --- the format, DERIVED and never passed in ----------------------------
    v_format := CASE
        WHEN p_storage_path ~* '[.]m4a$' THEN 'AAC'
        WHEN p_storage_path ~* '[.]mp3$' THEN 'MP3'
        ELSE NULL
    END;

    IF v_format IS NULL THEN
        RAISE EXCEPTION
            'storage_path must end .m4a (AAC) or .mp3 (MP3 fallback), got %', p_storage_path
            USING ERRCODE = '22023';
    END IF;

    -- --- the numbers --------------------------------------------------------
    IF p_size_bytes IS NULL OR p_size_bytes <= 0 THEN
        RAISE EXCEPTION 'size_bytes must be a positive byte count, got %.', p_size_bytes
            USING ERRCODE = '22023';
    END IF;

    IF p_duration_seconds IS NULL OR p_duration_seconds <= 0 THEN
        RAISE EXCEPTION 'duration_seconds must be a positive whole number of seconds, got %.',
            p_duration_seconds
            USING ERRCODE = '22023';
    END IF;

    -- --- the object must already be in the bucket ---------------------------
    SELECT coalesce(
               (o.metadata ->> 'size')::bigint,
               (o.metadata ->> 'contentLength')::bigint
           )
      INTO v_object_size
      FROM storage.objects o
     WHERE o.bucket_id = 'audio-tracks'
       AND o.name      = p_storage_path;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'No object at % in the audio-tracks bucket. Upload the file BEFORE registering the row.',
            p_storage_path
            USING ERRCODE = 'no_data_found';
    END IF;

    IF v_object_size IS NOT NULL AND v_object_size <> p_size_bytes THEN
        RAISE EXCEPTION
            'size_bytes (%) disagrees with the stored object (% bytes). The offline downloader compares these exactly and would reject the whole bundle.',
            p_size_bytes, v_object_size
            USING ERRCODE = '23514';
    END IF;

    -- --- write --------------------------------------------------------------
    SELECT * INTO v_previous
      FROM public.audio_tracks a
     WHERE a.waypoint_id = p_waypoint_id
       AND a.track_kind  = p_track_kind;

    -- NULL when there was no previous row (STRICT), which makes EXISTS false.
    v_old_sidecar := public.transcript_path_for(v_previous.storage_path);
    v_sidecar_existed := EXISTS (
        SELECT 1 FROM storage.objects o
         WHERE o.bucket_id = 'audio-tracks' AND o.name = v_old_sidecar
    );

    INSERT INTO public.audio_tracks (
        waypoint_id, track_kind, storage_path, format, size_bytes, duration_seconds,
        lufs_normalization
    )
    VALUES (
        p_waypoint_id, p_track_kind, p_storage_path, v_format, p_size_bytes,
        p_duration_seconds, p_lufs_normalization
    )
    ON CONFLICT (waypoint_id, track_kind) DO UPDATE
       SET storage_path       = EXCLUDED.storage_path,
           format             = EXCLUDED.format,
           size_bytes         = EXCLUDED.size_bytes,
           duration_seconds   = EXCLUDED.duration_seconds,
           lufs_normalization = EXCLUDED.lufs_normalization
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'track_id',         v_row.id,
        'waypoint_id',      v_row.waypoint_id,
        'track_kind',       v_row.track_kind,
        'storage_path',     v_row.storage_path,
        'format',           v_row.format,
        'size_bytes',       v_row.size_bytes,
        'duration_seconds', v_row.duration_seconds,
        'replaced',         v_previous.id IS NOT NULL,
        'orphaned_object',  CASE
                                WHEN v_previous.id IS NOT NULL
                                 AND v_previous.storage_path IS DISTINCT FROM p_storage_path
                                THEN v_previous.storage_path
                            END,
        'orphaned_transcript', CASE
                                WHEN v_sidecar_existed
                                 AND v_previous.storage_path IS DISTINCT FROM p_storage_path
                                THEN v_old_sidecar
                            END,
        'transcript_needs_review', v_sidecar_existed
                                   AND v_previous.storage_path = p_storage_path
    );
END;
$fn$;

COMMENT ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, int, int, text) IS
    'Registers a processed track of one kind (narration | deep_dive) for a waypoint, replacing any existing track of that kind. Refuses unless the object is in the bucket with a matching byte count. Returns orphaned_object and orphaned_transcript for the caller to delete, and transcript_needs_review when a transcript now sits beside replaced audio.';

REVOKE ALL ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, int, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, int, int, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. cms_replace_tour_waypoints  (+ per-waypoint tags; sidecar orphans)
--
-- Same signature, so a plain replace. Payload items gain two optional keys:
--
--   "audiences": ["family_kids"], "interests": ["history", "culinary"]
--
-- ABSENT (or JSON null) LEAVES AN EXISTING WAYPOINT'S TAGS ALONE. The rest of
-- the item has replace semantics, but tags are new: a CMS build that predates
-- them would otherwise wipe every tag on every Save. [] clears.
--
-- orphaned_objects now also lists transcript sidecars of deleted tracks.
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

        v_waypoint_id := nullif(v_item ->> 'id', '')::uuid;

        IF v_waypoint_id IS NULL THEN
            INSERT INTO public.waypoints
                (tour_id, name, poi_type, geom, sort_order, audiences, interests)
            VALUES (
                p_tour_id,
                v_item ->> 'name',
                v_item ->> 'poi_type',
                ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326),
                (v_item ->> 'sort_order')::int,
                coalesce(v_audiences, '{}'),
                coalesce(v_interests, '{}')
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
                   interests  = coalesce(v_interests, w.interests)
             WHERE w.id = v_waypoint_id
               AND w.tour_id = p_tour_id;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Waypoint % does not belong to tour %.', v_waypoint_id, p_tour_id
                    USING ERRCODE = '23503';
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
    'Replaces a tour''s entire waypoint list; anything absent from the payload is deleted. Per-waypoint audiences/interests are optional: absent or null leaves stored tags unchanged. Returns orphaned_objects - audio files and transcript sidecars of cascade-deleted tracks, which the caller must remove from the bucket because SQL cannot.';

-- -----------------------------------------------------------------------------
-- 6. cms_validate_tour
--
-- Changed relative to 20260827160100:
--   waypoint_without_audio  now means "no NARRATION" - a waypoint holding only
--                           a Deep Dive plays nothing when its geofence fires
--   duration_implausible    sums narration only; Deep Dives are optional
-- New:
--   deep_dive_on_transition (error)   unreachable content - the app never
--                                     offers a Deep Dive on a transition stop
--   transcript_orphaned     (warning) a .vtt in this tour's folder that no
--                                     registered track points at; no device
--                                     will ever download it
--   tour_untagged           (warning) no audiences or no interests, so the
--                                     tour matches every preference instead
--                                     of being matched to any
--
-- Not checkable here: whether a transcript PARSES. SQL cannot read object
-- contents; backend/cms validates with the device's own parser before upload.
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

    -- 5. NEW. A Deep Dive the app will never offer.
    SELECT 'error', 'deep_dive_on_transition', w.id,
           format('Waypoint %s is a transition stop but has a Deep Dive; the app only offers Deep Dives on anchor stops.', w.name)
    FROM public.waypoints w
    JOIN public.audio_tracks a ON a.waypoint_id = w.id AND a.track_kind = 'deep_dive'
    WHERE w.tour_id = p_tour_id
      AND w.poi_type = 'transition'

    UNION ALL

    -- 6. NEW. Warning. A transcript with no audio beside it.
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

    -- 7. NEW. Warning. Untagged content cannot be personalised.
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
    'Pre-flight checks for publishing. One row per problem; errors block publication, warnings do not. Covers missing narration, missing storage objects, unreachable Deep Dives, orphaned transcripts and untagged tours.';
