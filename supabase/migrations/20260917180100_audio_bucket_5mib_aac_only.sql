-- =============================================================================
-- TASK-1002 - Storage limits: 5 MiB per file, AAC-LC (.m4a) as the only format
--
-- STATUS: APPROVED 17 Sep 2026 (PM, Epic 10 handover review). Safe to push.
--
-- PM DECISION (Epic 10 kickoff, 17 Sep 2026): hard limit 5 MB per file,
-- specified as 5,242,880 bytes (5 MiB). This replaces the 3 MB decision of 17
-- Sep. AAC-LC at 64-96 kbps: about 10 minutes at 64 kbps, 6.8 at 96.
--
-- WHERE EACH RULE IS ENFORCED, AND WHY THERE
--
--   1. storage.buckets.file_size_limit  Storage refuses the upload itself, for
--      every client: the CMS, the dashboard, resumable uploads. This is the only
--      layer that sees the real byte count. A storage.objects RLS policy
--      cannot do this job, because object metadata (size, mimetype) is not
--      reliably set when the INSERT policy is evaluated.
--   2. storage.buckets.allowed_mime_types  Storage refuses any declared
--      Content-Type off the list. It is a guard against mistakes, not a
--      security boundary: the uploader declares the type and nothing sniffs
--      the bytes. Uploads are admin-only anyway (audio_tracks_admin_insert).
--   3. audio_tracks.size_bytes CHECK  A registered row can never promise a
--      download larger than the limit, whatever reached Storage earlier. The
--      app sizes its progress bar and verifies every file against this column.
--   4. backend/media (not SQL)  picks 96 or 64 kbps before encoding and refuses
--      a track that fits neither, so an admin gets a clear message instead of a
--      413 after a full encode.
--
-- WHAT THIS DOES TO EXISTING DATA
--
--   * Objects already in the bucket are NOT touched. Bucket limits apply to
--     new uploads only.
--   * The CHECK validates every existing audio_tracks row and FAILS THE
--     MIGRATION if any row is over 5 MiB. That is deliberate: a loud failure
--     beats a published tour carrying a file the pipeline would now refuse.
--     Checked 17 Sep 2026: the 8 published Tel Aviv tracks are 107-147 KB, and
--     the largest seed row is 2,880,000 bytes. Draft rows are not visible to
--     anon; run the pre-push query in the Handover Report as an admin first.
--   * Bundle hash: unchanged. Nothing get_tour_bundle reads is modified.
--
-- MIME ALLOWLIST - REPLACED, NOT APPENDED
--
-- 20260915120000 appended text/vtt so it would not drop entries added by hand.
-- This migration replaces the whole list on purpose, because narrowing it is
-- the task. Removed (PM, 17 Sep 2026):
--   audio/mpeg  the MP3 emergency fallback allowed in TASK-301. AAC-LC in .m4a
--               is the sole standard; Opus was dropped earlier (iOS).
--   audio/aac   raw ADTS .aac. It could never be registered: the format
--               constraint binds AAC to a .m4a path, so an upload would only
--               ever produce an orphaned object.
-- Kept:
--   audio/mp4, audio/m4a, audio/x-m4a   .m4a as the pipeline uploads it (audio/mp4)
--                                       and as other tools label it
--   text/vtt                            transcript sidecars (TASK-603); dropping
--                                       it would break every transcript upload
--
-- FORMAT COLUMN - MP3 REMOVED (section 3)
--
-- audio_tracks_format_check and audio_tracks_extension_matches_format_check
-- were added NOT VALID in 20260827120000 and never validated. They are
-- replaced here by VALIDATED AAC-only versions, so an existing MP3 row, or an
-- AAC row with a non-.m4a path, FAILS THE MIGRATION. Run the pre-push query
-- first. cms_register_audio_track is redefined with the same signature (its
-- grants carry over) so an .mp3 path gets a clear message rather than a
-- constraint violation.
--
-- NOT changed: transcript_path_for() still maps .mp3 to .vtt, and so does its
-- TypeScript twin in mobile/src/transcript/sidecar.ts. With no MP3 row
-- possible that branch can never run, and editing it means changing a function
-- that get_tour_bundle and the storage read policy depend on, for no effect.
--
-- The NULL guard matches 20260915120000: NULL means "allow everything", and a
-- bucket that does not exist yet (a fresh local stack before 20260821150323)
-- is simply not updated.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Bucket
-- -----------------------------------------------------------------------------
UPDATE storage.buckets
   SET file_size_limit    = 5242880,
       allowed_mime_types = ARRAY[
           'audio/mp4',
           'audio/m4a',
           'audio/x-m4a',
           'text/vtt'
       ]
 WHERE id = 'audio-tracks';

-- -----------------------------------------------------------------------------
-- 2. audio_tracks.size_bytes
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_size_max_5mib_check
        CHECK (size_bytes <= 5242880);

COMMENT ON CONSTRAINT audio_tracks_size_max_5mib_check ON public.audio_tracks IS
    'TASK-1002: 5 MiB per audio file, matching storage.buckets.file_size_limit for audio-tracks and NARRATION_PRESET.maxOutputBytes.';

-- -----------------------------------------------------------------------------
-- 3. audio_tracks.format: AAC only
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    DROP CONSTRAINT IF EXISTS audio_tracks_format_check,
    DROP CONSTRAINT IF EXISTS audio_tracks_extension_matches_format_check;

ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_format_check
        CHECK (format = 'AAC'),
    -- AVFoundation infers the container from the extension, so AAC bytes under
    -- any other name fail silently on iOS.
    ADD CONSTRAINT audio_tracks_extension_matches_format_check
        CHECK (format = 'AAC' AND storage_path ~* '[.]m4a$');

COMMENT ON COLUMN public.audio_tracks.format IS
    'Always AAC: AAC-LC in an .m4a container is the only accepted format (TASK-1002). MP3 and Opus are not supported.';

-- -----------------------------------------------------------------------------
-- 4. cms_register_audio_track: .m4a only
--
-- Verbatim from 20260915120100 apart from the format derivation and its
-- message. Same signature, so CREATE OR REPLACE keeps existing callers and
-- grants (restated below all the same).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cms_register_audio_track(
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
    -- AAC-LC in .m4a is the only format (TASK-1002). MP3 is no longer accepted.
    v_format := CASE
        WHEN p_storage_path ~* '[.]m4a$' THEN 'AAC'
        ELSE NULL
    END;

    IF v_format IS NULL THEN
        RAISE EXCEPTION
            'storage_path must end .m4a: AAC-LC is the only accepted format, got %', p_storage_path
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
