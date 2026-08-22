-- =============================================================================
-- Epic 1/2 wrap-up : AAC-LC (.m4a) as the sole client audio format
--
-- Opus is abandoned for client delivery. iOS has no Ogg demuxer and no Opus
-- decoder in AVFoundation, and it fails SILENTLY - the player reports as
-- playing while the position never leaves 0:00. Android decodes Opus-in-Ogg
-- fine, so this is an iOS constraint rather than a universal one; we standardise
-- on AAC-LC because it is the one codec that works natively on both.
--
-- Full rationale: docs/architecture_schema.md section 2.
--
-- NOTE ON THE BUCKET UPDATE BELOW
-- The MIME allowlist was already widened by hand in the Supabase dashboard
-- during testing. Repeating it here is deliberate: an environment rebuilt from
-- migrations alone would otherwise lose the change, and dashboard edits that
-- never reach migration history have already caused drift twice in this project.
-- The statement is idempotent, so re-applying what is already live is a no-op.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Column default
-- Existing rows are left alone: content already published as Opus should be
-- re-encoded and updated deliberately, not silently relabelled by a migration.
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    ALTER COLUMN format SET DEFAULT 'AAC';

COMMENT ON COLUMN public.audio_tracks.format IS
    'Audio codec. AAC-LC only for client delivery - iOS cannot decode Opus and fails silently.';

COMMENT ON COLUMN public.audio_tracks.storage_path IS
    'Path relative to the audio-tracks Storage bucket, e.g. tours/<tour_id>/wp01_name.m4a. Must end .m4a - AVFoundation infers format from the extension, so AAC bytes named .opus still fail. Never an absolute URL; resolve with getPublicUrl().';

-- -----------------------------------------------------------------------------
-- 2. Bucket MIME allowlist
-- Different tools label .m4a differently, so all three spellings are accepted.
-- A wrong MIME type is rejected at UPLOAD, which surfaces in the CMS rather
-- than as a silent playback failure on a device - the better failure mode.
-- -----------------------------------------------------------------------------
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
         'audio/mp4',
         'audio/m4a',
         'audio/x-m4a',
         'audio/aac'
       ]
 WHERE id = 'audio-tracks';
