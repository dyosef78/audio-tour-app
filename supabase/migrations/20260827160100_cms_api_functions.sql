-- =============================================================================
-- TASK-303 (revised) : CMS API
--
-- STATUS: DRAFT - awaiting approval. Do not push.
--
-- Rewritten for the single private bucket. The three-phase publish is gone:
-- with no files to move, publishing is validation plus a status flag, in one
-- transaction, with no worker and no intermediate state to get stuck in.
--
-- Removed relative to the withdrawn two-bucket draft:
--   cms_request_publish() / cms_confirm_publish() / cms_abandon_publish()
--       - replaced by cms_publish_tour(), which is atomic.
--   cms_retraction_manifest()
--       - obsolete. Unpublishing now retracts by itself, because storage
--         access is gated on the same status the rows are.
--   the 'publishing' status and audio_tracks.storage_bucket
--       - neither was ever pushed, so neither needs unwinding.
--
-- SECURITY POSTURE - unchanged and worth restating
--
-- All SECURITY INVOKER. These run as the calling admin, so the TASK-302
-- policies remain the enforcement layer and none of them can reach a row the
-- caller could not already reach. SECURITY DEFINER would make RLS irrelevant
-- and quietly undo the PM's decision that the CMS authorises through
-- app_admins rather than bypassing RLS.
--
-- Each still calls assert_cms_admin() first, because RLS filtering turns an
-- unauthorised UPDATE into zero affected rows - which surfaces as "not found",
-- indistinguishable from a bad id and impossible to debug.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Guard
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_cms_admin()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
BEGIN
    IF NOT public.is_cms_admin() THEN
        -- 42501 = insufficient_privilege. PostgREST maps it to HTTP 403, so the
        -- CMS gets a status it can branch on rather than a generic 400.
        RAISE EXCEPTION 'Not authorised: CMS administrator required.'
            USING ERRCODE = '42501';
    END IF;
END;
$fn$;

-- -----------------------------------------------------------------------------
-- 2. Validation - the publish gate
--
-- Returns problems rather than raising, so the CMS can render a live checklist
-- beside the Publish button. cms_publish_tour() calls the same function and
-- refuses if it returns any error.
--
-- Check 3 is the one architecture_schema.md section 2 asked for and nothing has
-- implemented until now: "a row whose storage_path does not resolve to an
-- object in the bucket". It is possible in pure SQL only because
-- storage.objects is an ordinary table. It catches an upload that failed while
-- the CMS reported success - otherwise discovered by a user standing in front
-- of the Western Wall hearing nothing.
--
-- SECURITY INVOKER means the storage.objects lookup runs under the admin read
-- policy from 20260827160000. That is deliberate: only admins call this, and it
-- keeps the storage read honest rather than laundering it through a definer.
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

    -- 2. A waypoint with no audio is a silent stop: the geofence fires and
    --    nothing plays, which reads as a broken app rather than missing content.
    SELECT 'error', 'waypoint_without_audio', w.id,
           format('Waypoint %s (sort_order %s) has no audio track.', w.name, w.sort_order)
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
      AND NOT EXISTS (SELECT 1 FROM public.audio_tracks a WHERE a.waypoint_id = w.id)

    UNION ALL

    -- 3. THE MISSING-OBJECT CHECK. A row in audio_tracks is a CLAIM that a file
    --    exists; nothing had ever verified it. storage.objects.name is the path
    --    within the bucket, so this join is the verification.
    SELECT 'error', 'audio_object_missing', a.waypoint_id,
           format('audio_tracks %s claims %s, which does not exist in storage.',
                  a.id, a.storage_path)
    FROM public.audio_tracks a
    JOIN public.waypoints w ON w.id = a.waypoint_id
    WHERE w.tour_id = p_tour_id
      AND NOT EXISTS (
            SELECT 1 FROM storage.objects o
            WHERE o.bucket_id = 'audio-tracks'
              AND o.name      = a.storage_path
      )

    UNION ALL

    -- 4. A waypoint with no geofence never triggers. Its audio is unreachable
    --    even though every row looks complete.
    SELECT 'error', 'waypoint_without_geofence', w.id,
           format('Waypoint %s has no geofence zone; its audio can never trigger.', w.name)
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
      AND NOT EXISTS (SELECT 1 FROM public.geofence_zones g WHERE g.waypoint_id = w.id)

    UNION ALL

    -- 5. Warning. Gaps in sort_order are legal and harmless to playback, but
    --    they usually mean a waypoint was deleted and nobody noticed.
    SELECT 'warning', 'sort_order_gap', NULL::uuid,
           format('sort_order is not contiguous: %s waypoints spanning %s..%s.',
                  count(*), min(w.sort_order), max(w.sort_order))
    FROM public.waypoints w
    WHERE w.tour_id = p_tour_id
    HAVING count(*) > 0
       AND (max(w.sort_order) - min(w.sort_order) + 1) <> count(*)

    UNION ALL

    -- 6. Warning. A tour claiming 90 minutes with 4 minutes of audio is an
    --    unfinished draft rather than a design choice.
    SELECT 'warning', 'duration_implausible', NULL::uuid,
           format('Tour claims %s min but holds only %s s of audio.',
                  t.duration_minutes, coalesce(sum(a.duration_seconds), 0))
    FROM public.tours t
    JOIN public.waypoints w         ON w.tour_id = t.id
    LEFT JOIN public.audio_tracks a ON a.waypoint_id = w.id
    WHERE t.id = p_tour_id
    GROUP BY t.id, t.duration_minutes
    HAVING coalesce(sum(a.duration_seconds), 0) < (t.duration_minutes * 60) * 0.1;
$fn$;

COMMENT ON FUNCTION public.cms_validate_tour(uuid) IS
    'Pre-flight checks for publishing. One row per problem; errors block publication, warnings do not. Includes the storage-object existence check from architecture_schema.md section 2, which nothing else performs.';

-- -----------------------------------------------------------------------------
-- 3. Tour CRUD
--
-- One upsert rather than separate create and update: the editor screen has one
-- Save button and does not care which it is.
--
-- status is not settable here. Publication has a validation gate, and letting a
-- general-purpose upsert write status = 'published' would route straight around
-- it.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_upsert_tour(
    p_tour_id          uuid,
    p_title            text,
    p_topology         text,
    p_transit_mode     text,
    p_duration_minutes int
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

    IF p_tour_id IS NULL THEN
        INSERT INTO public.tours (title, topology, transit_mode, duration_minutes)
        VALUES (p_title, p_topology, p_transit_mode, p_duration_minutes)
        RETURNING * INTO v_row;
    ELSE
        UPDATE public.tours t
           SET title            = p_title,
               topology         = p_topology,
               transit_mode     = p_transit_mode,
               duration_minutes = p_duration_minutes
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

-- -----------------------------------------------------------------------------
-- 4. Publish / unpublish
--
-- Atomic, because there is nothing to move. This is the entire benefit of the
-- single-bucket pivot expressed as code: one transaction, no worker, no
-- intermediate state, nothing to get stuck in, nothing to reconcile.
--
-- Publishing also makes the audio reachable, because storage.objects SELECT is
-- gated on the same tour status - see audio_object_is_published(). One flag
-- controls both the metadata and the media, so they cannot disagree.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_publish_tour(p_tour_id uuid)
RETURNS public.tours
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_errors jsonb;
    v_row    public.tours;
BEGIN
    PERFORM public.assert_cms_admin();

    IF NOT EXISTS (SELECT 1 FROM public.tours WHERE id = p_tour_id) THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
               'code', v.code, 'waypoint_id', v.waypoint_id, 'detail', v.detail))
      INTO v_errors
      FROM public.cms_validate_tour(p_tour_id) v
     WHERE v.severity = 'error';

    IF v_errors IS NOT NULL THEN
        RAISE EXCEPTION 'Tour % failed validation: %', p_tour_id, v_errors::text
            USING ERRCODE = '23514';  -- check_violation
    END IF;

    UPDATE public.tours SET status = 'published' WHERE id = p_tour_id
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$fn$;

COMMENT ON FUNCTION public.cms_publish_tour(uuid) IS
    'Validates and publishes in one transaction. Publishing also unlocks the tour''s audio objects, because storage access is gated on the same status.';

CREATE OR REPLACE FUNCTION public.cms_set_tour_status(
    p_tour_id uuid,
    p_status  text
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

    IF p_status = 'published' THEN
        RAISE EXCEPTION 'Use cms_publish_tour(), which validates first.'
            USING ERRCODE = '42501';
    END IF;

    IF p_status NOT IN ('draft', 'archived') THEN
        RAISE EXCEPTION 'Unknown target status: %', p_status USING ERRCODE = '22023';
    END IF;

    -- Unpublishing genuinely retracts now. The rows go invisible AND the
    -- storage policy stops issuing signed URLs for the objects.
    --
    -- Two things it cannot retract, both inherent rather than design faults:
    --   * a signed URL already issued stays valid until it expires, which is
    --     the argument for a short expiry;
    --   * a bundle already downloaded is on someone's phone for good.
    UPDATE public.tours SET status = p_status WHERE id = p_tour_id
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_row;
END;
$fn$;

-- -----------------------------------------------------------------------------
-- 5. Bulk waypoint / geofence upsert
--
-- Payload shape (geofence nested per waypoint):
--
--   [{ "id": "uuid-or-null",
--      "name": "Jaffa Gate",
--      "poi_type": "anchor",
--      "lon": 35.2279,
--      "lat": 31.7766,
--      "sort_order": 1,
--      "geofence": { "type": "radius",  "radius_meters": 25 }
--                | { "type": "polygon", "ring": [[lon,lat], ...] }
--   }, ...]
--
-- REPLACE SEMANTICS. The payload is the complete list; anything absent is
-- deleted. That is what an editor's Save means, and merge semantics would make
-- deletion impossible to express. It also means a truncated payload destroys
-- content - which is why the return value reports what was deleted.
--
-- WHY THE SERVER BUILDS THE BUFFER
--
--     ST_Buffer(geom, 25)              -- 25 DEGREES. ~2,750 km.
--     ST_Buffer(geom::geography, 25)   -- 25 metres.
--
-- Letting the CMS compute the polygon would put that trap in JavaScript, in a
-- codebase with no PostGIS to get it right, and the failure is silent: a
-- geofence spanning a continent is still a valid polygon. Centralised here, the
-- mistake can only be made in one place, where it is already made correctly.
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
BEGIN
    PERFORM public.assert_cms_admin();

    SELECT status INTO v_status FROM public.tours WHERE id = p_tour_id;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Tour % not found.', p_tour_id USING ERRCODE = 'no_data_found';
    END IF;

    IF jsonb_typeof(p_waypoints) <> 'array' THEN
        RAISE EXCEPTION 'p_waypoints must be a JSON array.' USING ERRCODE = '22023';
    END IF;

    -- THE DEFERRED CONSTRAINT.
    -- waypoints_tour_sort_order_key was created DEFERRABLE in TASK-301 for
    -- exactly this: a reorder passes through states where two rows legitimately
    -- share a sort_order. Without this, any payload that swaps two positions
    -- fails on the first UPDATE.
    SET CONSTRAINTS public.waypoints_tour_sort_order_key DEFERRED;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_waypoints)
    LOOP
        v_lon := (v_item ->> 'lon')::double precision;
        v_lat := (v_item ->> 'lat')::double precision;

        IF v_lon IS NULL OR v_lat IS NULL THEN
            RAISE EXCEPTION 'Waypoint "%" is missing lon or lat.', v_item ->> 'name'
                USING ERRCODE = '22023';
        END IF;

        -- Range check only. It catches a null-island fix or a value in the wrong
        -- unit. It does NOT catch a swapped lon/lat pair when both are in range
        -- - (31.77, 35.22) is a perfectly valid point in Iraq. Only the CMS map
        -- preview catches that one.
        IF v_lat < -90 OR v_lat > 90 OR v_lon < -180 OR v_lon > 180 THEN
            RAISE EXCEPTION 'Waypoint "%" has out-of-range coordinates (lon %, lat %).',
                v_item ->> 'name', v_lon, v_lat
                USING ERRCODE = '22023';
        END IF;

        v_waypoint_id := nullif(v_item ->> 'id', '')::uuid;

        IF v_waypoint_id IS NULL THEN
            INSERT INTO public.waypoints (tour_id, name, poi_type, geom, sort_order)
            VALUES (
                p_tour_id,
                v_item ->> 'name',
                v_item ->> 'poi_type',
                ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326),
                (v_item ->> 'sort_order')::int
            )
            RETURNING id INTO v_waypoint_id;
        ELSE
            -- tour_id is in the WHERE clause, not just id: without it a payload
            -- could reassign another tour's waypoint by guessing its uuid. RLS
            -- would permit that, because an admin may edit every tour.
            UPDATE public.waypoints w
               SET name       = v_item ->> 'name',
                   poi_type   = v_item ->> 'poi_type',
                   geom       = ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326),
                   sort_order = (v_item ->> 'sort_order')::int
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
                -- ST_GeomFromGeoJSON yields SRID 0, so the ring is built in an
                -- untyped variable and stamped 4326 before it becomes a polygon
                -- - assigning an SRID-0 geometry to geometry(Polygon,4326)
                -- would be rejected outright.
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

                -- Close the ring only if the client left it open. ST_MakePolygon
                -- rejects an unclosed ring, and "repeat the first point at the
                -- end" is what a drawing UI most often forgets - but appending
                -- unconditionally would leave a duplicate vertex on rings that
                -- were already correct.
                IF NOT ST_IsClosed(v_ring) THEN
                    v_ring := ST_AddPoint(v_ring, ST_PointN(v_ring, 1));
                END IF;

                v_zone_geom := ST_MakePolygon(v_ring);
            ELSE
                -- Radius. The geography cast is the point - see the header.
                v_zone_geom := ST_Buffer(
                    ST_SetSRID(ST_MakePoint(v_lon, v_lat), 4326)::geography,
                    (v_geofence ->> 'radius_meters')::double precision
                )::geometry;
            END IF;

            -- One zone per waypoint. The schema allows many and get_tour_bundle
            -- picks one arbitrarily, so writing a second here would make the
            -- bundle non-deterministic. Replace rather than accumulate.
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

    -- Deleting omitted waypoints cascades to geofence_zones and audio_tracks.
    -- The rows go; the storage OBJECTS do not, because nothing here can reach
    -- the Storage API. This is the one drift risk the single-bucket pivot does
    -- NOT remove, so the orphans are reported rather than left to be noticed.
    SELECT jsonb_agg(a.storage_path)
      INTO v_orphaned
      FROM public.audio_tracks a
      JOIN public.waypoints w ON w.id = a.waypoint_id
     WHERE w.tour_id = p_tour_id
       AND NOT (w.id = ANY(coalesce(v_kept, ARRAY[]::uuid[])));

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
    'Replaces a tour''s entire waypoint list; anything absent from the payload is deleted. Returns orphaned_objects - storage files whose rows were cascade-deleted, which the caller must remove from the bucket because SQL cannot.';

-- -----------------------------------------------------------------------------
-- 6. Grants
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.assert_cms_admin()                            FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cms_validate_tour(uuid)                       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, int)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cms_publish_tour(uuid)                        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cms_set_tour_status(uuid, text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cms_replace_tour_waypoints(uuid, jsonb)       FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.assert_cms_admin()                           TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_validate_tour(uuid)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_upsert_tour(uuid, text, text, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_publish_tour(uuid)                       TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_set_tour_status(uuid, text)              TO authenticated;
GRANT EXECUTE ON FUNCTION public.cms_replace_tour_waypoints(uuid, jsonb)      TO authenticated;
