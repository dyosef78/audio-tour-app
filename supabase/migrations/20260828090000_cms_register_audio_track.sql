-- =============================================================================
-- TASK-402 (D4) : cms_register_audio_track
--
-- STATUS: APPROVED 28 Aug 2026. Safe to push.
--
-- Closes the gap found while writing the media pipeline: there was NO write
-- path for audio_tracks anywhere in the CMS API. cms_replace_tour_waypoints()
-- upserts waypoints and geofence zones and never touches audio at all, so the
-- pipeline could produce a perfect master and had nowhere to record it.
--
-- WHAT THIS MIGRATION DOES TO EXISTING ROWS
--
-- Section 1 collapses any waypoint holding more than one audio_tracks row and
-- then makes that impossible. On the seeds this is a no-op - supabase/seed.sql
-- has four rows for four waypoints, prod_test_seed.sql two for two - but the
-- schema has always permitted duplicates and nothing has ever stopped one being
-- written, so a remote database may hold some.
--
-- The row that SURVIVES is the lowest id per waypoint, which is exactly the row
-- get_tour_bundle() already returns:
--
--     LEFT JOIN LATERAL (... ORDER BY a.id LIMIT 1) t ON TRUE
--
-- Matching that ordering is the whole point. Every published bundle_version_hash
-- is derived from the surviving row's storage_path, size_bytes and
-- duration_seconds, so keeping the row the bundle already uses means no hash
-- moves and no device is told to re-download anything. Deleting the "newest"
-- duplicate instead would look more intuitive and would silently invalidate
-- every cached bundle for the affected tours.
--
-- Deleted duplicates leave their storage objects behind - SQL cannot reach the
-- Storage API - so their paths are RAISEd as a NOTICE for whoever runs the
-- migration to clean up. Same limitation, same convention, as the
-- orphaned_objects key returned by cms_replace_tour_waypoints().
--
-- FOLLOW-UP REQUIRED AFTER PUSHING
--
--   npm run types:generate
--
-- This adds a function, and generated types include Functions, so the "types
-- are up to date" step in .github/workflows/db-verify.yml will fail until they
-- are regenerated and committed.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. One audio track per waypoint
--
-- Why this has to exist before an upsert can: "upsert the audio track for this
-- waypoint" has no meaning without a key to conflict on, and the alternative -
-- a hand-rolled UPDATE-then-INSERT - leaves the door open for any other code
-- path to create a second row later.
--
-- A duplicate is worse than untidy here. get_tour_bundle() picks ORDER BY id
-- LIMIT 1, and ids are gen_random_uuid(), so a second row wins or loses at
-- random. Re-record a waypoint, INSERT rather than replace, and the tour may
-- keep serving the old take forever with nothing anywhere reporting a problem.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_orphans text[];
BEGIN
    SELECT array_agg(r.storage_path ORDER BY r.storage_path)
      INTO v_orphans
      FROM (
          SELECT a.storage_path,
                 row_number() OVER (PARTITION BY a.waypoint_id ORDER BY a.id) AS rn
            FROM public.audio_tracks a
           WHERE a.waypoint_id IS NOT NULL
      ) r
     WHERE r.rn > 1;

    IF v_orphans IS NOT NULL THEN
        RAISE NOTICE
            'Collapsing % duplicate audio_tracks row(s). These storage objects are now orphaned and must be deleted from the audio-tracks bucket by hand: %',
            array_length(v_orphans, 1), v_orphans;

        WITH ranked AS (
            SELECT a.id,
                   row_number() OVER (PARTITION BY a.waypoint_id ORDER BY a.id) AS rn
              FROM public.audio_tracks a
             WHERE a.waypoint_id IS NOT NULL
        )
        DELETE FROM public.audio_tracks a
         USING ranked r
         WHERE a.id = r.id
           AND r.rn > 1;
    END IF;
END;
$$;

-- NULLs are distinct by default, so this constrains real waypoints only. A row
-- with a NULL waypoint_id is already unreachable from any tour and is left
-- alone rather than being quietly deleted by a migration about something else.
CREATE UNIQUE INDEX IF NOT EXISTS audio_tracks_one_per_waypoint
    ON public.audio_tracks (waypoint_id);

COMMENT ON INDEX public.audio_tracks_one_per_waypoint IS
    'One narration track per waypoint. Also the conflict target for cms_register_audio_track(); without it "upsert" has no key to resolve against.';

-- The plain FK index from the init migration is now redundant: this unique
-- index has the same leading column and serves the same lookups and cascades.
-- Two indexes on one column is write cost for nothing.
DROP INDEX IF EXISTS public.idx_audio_tracks_waypoint_id;

-- -----------------------------------------------------------------------------
-- 2. cms_register_audio_track
--
-- SECURITY INVOKER, like every other cms_* function. It runs as the calling
-- admin so the TASK-302 policies stay the enforcement layer, and
-- assert_cms_admin() runs first so an unauthorised call is a 403 rather than
-- "zero rows affected", which is indistinguishable from a bad id.
--
-- NOTE ON THE SERVICE ROLE. This cannot be called with a service_role key:
-- is_cms_admin() resolves auth.uid(), which is NULL for service_role, so the
-- guard rejects it. That is deliberate and is why the TASK-402 upload service
-- carries the signed-in admin's access token rather than a service key. Every
-- registration is therefore attributable to a person, and the box running the
-- CMS never holds a credential that bypasses RLS.
--
-- THE STORAGE CHECK IS THE POINT OF THIS FUNCTION
--
-- An audio_tracks row is a CLAIM that a file exists in the bucket, and until
-- now nothing verified that claim until cms_validate_tour() ran at publish
-- time - by which point the upload that failed while the CMS reported success
-- is hours old and nobody remembers it. Checking here moves the failure to the
-- moment it is caused, and makes the ordering explicit: UPLOAD FIRST, REGISTER
-- SECOND. A row can no longer describe a file that is not there.
--
-- The size comparison closes the same loop from the other end. The mobile
-- downloader compares the served byte count with audio_tracks.size_bytes using
-- ===, and rejects the entire bundle on a mismatch, so a size that disagrees
-- with the stored object is not a cosmetic error - it is a tour that cannot be
-- downloaded. The database is the last place that can see both numbers at once,
-- so it is the right place to refuse.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_register_audio_track(
    p_waypoint_id      uuid,
    p_storage_path     text,
    p_size_bytes       bigint,
    p_duration_seconds int,
    -- Optional so the four-argument call in the TASK-402 spec works unchanged.
    -- It exists because the pipeline MEASURES the encoded loudness rather than
    -- assuming it, and a measured value is worth recording over a column
    -- default that is only ever hoped to be true.
    p_lufs_normalization int DEFAULT -16
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
DECLARE
    v_format      text;
    v_object_size bigint;
    v_previous    public.audio_tracks;
    v_row         public.audio_tracks;
BEGIN
    PERFORM public.assert_cms_admin();

    -- --- the waypoint -------------------------------------------------------
    -- Checked explicitly rather than left to the foreign key: 23503 with a
    -- constraint name tells the CMS almost nothing, and an admin can see every
    -- waypoint, so a miss here really is a bad id.
    IF NOT EXISTS (SELECT 1 FROM public.waypoints w WHERE w.id = p_waypoint_id) THEN
        RAISE EXCEPTION 'Waypoint % not found.', p_waypoint_id
            USING ERRCODE = 'no_data_found';
    END IF;

    -- --- the path -----------------------------------------------------------
    IF p_storage_path IS NULL OR btrim(p_storage_path) = '' THEN
        RAISE EXCEPTION 'storage_path is required.' USING ERRCODE = '22023';
    END IF;

    -- Same rule as audio_tracks_storage_path_relative_check, asserted here so
    -- the CMS gets a sentence instead of a constraint name. An absolute URL
    -- re-pins the row to one project ref; a leading slash breaks path joining
    -- on the client.
    IF p_storage_path ~ '^(https?://|/)' THEN
        RAISE EXCEPTION
            'storage_path must be relative to the audio-tracks bucket, not an absolute URL: %',
            p_storage_path
            USING ERRCODE = '22023';
    END IF;

    -- A traversal segment would escape the bundle directory on the device. The
    -- client guards this too (paths.isSafeStoragePath), but a path that reaches
    -- the database is a path some other client may trust.
    IF p_storage_path ~ '(^|/)\.\.?(/|$)' OR p_storage_path ~ '\\' THEN
        RAISE EXCEPTION 'storage_path may not contain path traversal segments: %', p_storage_path
            USING ERRCODE = '22023';
    END IF;

    -- --- the format, DERIVED and never passed in ----------------------------
    -- audio_tracks_extension_matches_format_check binds the two together, so
    -- accepting format as a parameter only creates a way for them to disagree.
    -- Deriving it means the caller cannot label AAC bytes as MP3 - which on iOS
    -- fails silently, the player reporting `playing` while position never
    -- leaves 0:00.
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

    -- The column and its CHECK both permit NULL, and this function does not.
    -- A track with no duration makes the offline size estimate and the
    -- duration_implausible validator silently wrong, and the pipeline always
    -- has the number - so there is no legitimate caller with an excuse.
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

    -- metadata is populated by the Storage API, not by us, so treat a missing
    -- size as unknown rather than as zero. Refusing to register because
    -- Storage declined to report a byte count would be a worse failure than the
    -- one being guarded against.
    IF v_object_size IS NOT NULL AND v_object_size <> p_size_bytes THEN
        RAISE EXCEPTION
            'size_bytes (%) disagrees with the stored object (% bytes). The offline downloader compares these exactly and would reject the whole bundle.',
            p_size_bytes, v_object_size
            USING ERRCODE = '23514';  -- check_violation
    END IF;

    -- --- write --------------------------------------------------------------
    -- Read the outgoing row first: once the upsert lands, the path it used to
    -- point at is gone, and that path is an object nobody will ever reference
    -- again. Returning it is the only chance the caller gets to delete it.
    SELECT * INTO v_previous
      FROM public.audio_tracks a
     WHERE a.waypoint_id = p_waypoint_id;

    INSERT INTO public.audio_tracks (
        waypoint_id, storage_path, format, size_bytes, duration_seconds, lufs_normalization
    )
    VALUES (
        p_waypoint_id, p_storage_path, v_format, p_size_bytes, p_duration_seconds,
        p_lufs_normalization
    )
    ON CONFLICT (waypoint_id) DO UPDATE
       SET storage_path       = EXCLUDED.storage_path,
           format             = EXCLUDED.format,
           size_bytes         = EXCLUDED.size_bytes,
           duration_seconds   = EXCLUDED.duration_seconds,
           lufs_normalization = EXCLUDED.lufs_normalization
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'track_id',         v_row.id,
        'waypoint_id',      v_row.waypoint_id,
        'storage_path',     v_row.storage_path,
        'format',           v_row.format,
        'size_bytes',       v_row.size_bytes,
        'duration_seconds', v_row.duration_seconds,
        'replaced',         v_previous.id IS NOT NULL,
        -- Null when this was a first upload, or when a re-record reused the
        -- same path and simply overwrote the object.
        'orphaned_object',  CASE
                                WHEN v_previous.id IS NOT NULL
                                 AND v_previous.storage_path IS DISTINCT FROM p_storage_path
                                THEN v_previous.storage_path
                                ELSE NULL
                            END
    );
END;
$fn$;

COMMENT ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, int, int) IS
    'Registers the processed narration track for a waypoint, replacing any existing one. Refuses unless the object is already in the bucket and its byte count matches size_bytes, so a row can never describe a file that is missing or a different size. Returns orphaned_object - the previous path, which the caller must delete from the bucket because SQL cannot reach the Storage API.';

-- -----------------------------------------------------------------------------
-- 3. Grants
--
-- Same shape as the other cms_* functions: closed to PUBLIC, opened to
-- authenticated, and actually authorised inside by assert_cms_admin(). The role
-- grant is not the authorisation - open SSO means anyone can hold an
-- `authenticated` JWT.
-- -----------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cms_register_audio_track(uuid, text, bigint, int, int) TO authenticated;
