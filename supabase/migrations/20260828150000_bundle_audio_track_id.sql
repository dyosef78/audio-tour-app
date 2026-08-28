-- =============================================================================
-- TASK-507 (2 of 2) : expose audio_tracks.id in the bundle payload
--
-- PM decision. telemetry_events.audio_track_id has been NULL from every mobile
-- event since the table shipped, because get_tour_bundle() returned media as
-- {storage_path, duration_seconds, size_bytes, format} - no id. The device
-- genuinely did not know which audio_tracks row it was playing, so the FK could
-- not be populated from the client at all.
--
-- The only change is one extra key in the `media` object. Everything else here
-- is the function as it stood in 20260821195300, reproduced because Postgres has
-- no way to patch a function body.
-- =============================================================================

SET search_path = public, extensions;

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
      t.audio_track_id,
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
      SELECT a.id AS audio_track_id, a.storage_path, a.duration_seconds,
             a.size_bytes, a.format
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
                -- NEW (TASK-507). The FK telemetry needs; see the note below.
                'audio_track_id',   r.audio_track_id,
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
      --
      -- !! audio_track_id IS DELIBERATELY ABSENT FROM THIS SIGNATURE !!
      --
      -- Adding it would change bundle_version_hash for every tour in the
      -- catalogue, and TourBundleRepository.download() treats a changed hash as
      -- "re-download everything". Every user on the network would re-fetch every
      -- byte of audio they already hold, to acquire an id that affects analytics
      -- and nothing a listener can hear.
      --
      -- The trade is that bundles downloaded before this migration keep a
      -- manifest with no audio_track_id, and their telemetry keeps reporting
      -- null until the tour's content genuinely changes. The client treats the
      -- field as optional for exactly this reason. That is the right way round:
      -- analytics coverage improves as bundles naturally refresh, and nobody
      -- pays for a forced re-download.
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
  'Offline bundle payload for a tour: decoded coordinates, geofences and media (including audio_track_id for telemetry), plus a content-derived bundle_version_hash. Runs as the caller, so RLS still applies. audio_track_id is excluded from the hash on purpose - see the migration.';

GRANT EXECUTE ON FUNCTION public.get_tour_bundle(uuid) TO anon, authenticated;
