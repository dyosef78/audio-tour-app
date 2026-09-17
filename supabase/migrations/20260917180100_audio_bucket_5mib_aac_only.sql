-- =============================================================================
-- TASK-1002 - Storage limits: 5 MiB per file, AAC-only MIME allowlist
--
-- STATUS: DRAFT - awaiting PM approval. Do not push.
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
-- the task. Removed:
--   audio/mpeg  the MP3 emergency fallback allowed in TASK-301. AAC-LC is now
--               the sole standard (PM, 17 Sep 2026). audio_tracks.format still
--               accepts 'MP3'; see the Handover Report.
-- Kept:
--   audio/mp4, audio/m4a, audio/x-m4a   .m4a as the pipeline uploads it (audio/mp4)
--                                       and as other tools label it
--   audio/aac                           raw ADTS .aac, named in the brief
--   text/vtt                            transcript sidecars (TASK-603); dropping
--                                       it would break every transcript upload
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
           'audio/aac',
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
