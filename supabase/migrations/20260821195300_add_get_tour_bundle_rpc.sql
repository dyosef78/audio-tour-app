-- =============================================================================
-- TASK-201 : get_tour_bundle() - one-shot offline bundle payload
--
-- Returns the complete offline bundle for a tour as a single jsonb document,
-- shaped to the manifest spec in docs/architecture_schema.md v2.0.0.
--
-- !! CORRECTION TO THE TASK-201 PROPOSAL !!
-- The proposal warned that PostgREST might serialise geometry as WKB hex. It
-- does not - this project already returns GeoJSON
-- ({"type":"Point","coordinates":[lon,lat]}), verified against the live API.
-- So this function is NOT needed to decode coordinates. It is still worth
-- having for three other reasons:
--
--   1. One round trip instead of four nested selects, over a connection the
--      user may be about to lose. Bundle assembly should not be chatty.
--   2. It computes bundle_version_hash server-side. The manifest spec requires
--      that field and nothing in the schema produces it (no column exists), so
--      it is derived here from the content itself.
--   3. It pins the wire contract. Client parsing no longer depends on how
--      PostGIS/PostgREST happen to serialise geometry today.
--
-- SECURITY INVOKER (the default) is deliberate: the function runs as the
-- caller, so the public-read RLS policies still apply. It grants no access the
-- caller did not already have.
-- =============================================================================

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
      ST_X(w.geom) AS lon,
      ST_Y(w.geom) AS lat,
      z.zone_type,
      z.trigger_radius_meters,
      z.geom AS zone_geom,
      t.storage_path,
      t.duration_seconds,
      t.size_bytes,
      t.format
    FROM public.waypoints w
    -- LATERAL + LIMIT 1: the schema allows many zones/tracks per waypoint, and
    -- a plain LEFT JOIN would multiply rows. Ordering by id keeps the choice
    -- deterministic, which matters because it feeds the version hash.
    LEFT JOIN LATERAL (
      SELECT g.zone_type, g.trigger_radius_meters, g.geom
      FROM public.geofence_zones g
      WHERE g.waypoint_id = w.id
      ORDER BY g.id
      LIMIT 1
    ) z ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.storage_path, a.duration_seconds, a.size_bytes, a.format
      FROM public.audio_tracks a
      WHERE a.waypoint_id = w.id
      ORDER BY a.id
      LIMIT 1
    ) t ON TRUE
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
                  -- waypoint's own point is the exact centre by construction -
                  -- better than taking a centroid of the buffer.
                  'center', jsonb_build_array(r.lon, r.lat)
                )
            END,
          'media',
            CASE
              WHEN r.storage_path IS NULL THEN NULL
              ELSE jsonb_build_object(
                'storage_path',     r.storage_path,
                'duration_seconds', r.duration_seconds,
                'size_bytes',       r.size_bytes,
                'format',           r.format
              )
            END
        )
        ORDER BY r.sort_order
      ) AS waypoints,
      -- Canonical signature string. Deterministic ordering matters: the hash is
      -- the client's only signal that a cached bundle is stale.
      string_agg(
        concat_ws(':',
          r.id::text, r.sort_order::text, r.lon::text, r.lat::text,
          coalesce(r.storage_path, ''), coalesce(r.size_bytes::text, ''),
          coalesce(r.duration_seconds::text, ''), coalesce(r.zone_type, ''),
          coalesce(r.trigger_radius_meters::text, '')
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
      'duration_minutes', tr.duration_minutes
    ),
    'waypoints', coalesce(a.waypoints, '[]'::jsonb)
  )
  FROM public.tours tr
  CROSS JOIN agg a
  WHERE tr.id = p_tour_id;
$$;

COMMENT ON FUNCTION public.get_tour_bundle(uuid) IS
  'Offline bundle payload for a tour: decoded coordinates, geofences and media, plus a content-derived bundle_version_hash. Runs as the caller, so RLS still applies.';

-- Default EXECUTE is granted to PUBLIC; naming the roles makes the intent
-- explicit and survives a future REVOKE ... FROM PUBLIC hardening pass.
GRANT EXECUTE ON FUNCTION public.get_tour_bundle(uuid) TO anon, authenticated;
