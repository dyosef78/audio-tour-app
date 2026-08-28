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
--
-- Different tools label .m4a differently, so all three spellings are accepted.
-- A wrong MIME type is rejected at UPLOAD, which surfaces in the CMS rather
-- than as a silent playback failure on a device - the better failure mode.
--
-- This statement REPLACES the array rather than appending to it, so the list
-- below must be the complete intended allowlist, not a delta. Anything live but
-- absent here is dropped.
--
-- audio/mpeg was added on PM instruction (TASK-301 review, 27 Aug 2026). It
-- unblocks the MP3 fallback that architecture_schema.md section 2 sanctions for
-- sources that cannot be re-encoded - that section explicitly notes MP3 needs
-- audio/mpeg on the allowlist first, and until now it was missing, so the
-- fallback was documented but not actually usable.
--
-- MP3 remains a fallback, not a second standard: it has no gapless playback,
-- which matters for the transition cues in PRD section 3. AAC-LC stays the
-- default and the column default below still says so.
-- -----------------------------------------------------------------------------
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY[
         'audio/mp4',
         'audio/m4a',
         'audio/x-m4a',
         'audio/mpeg',
         'audio/aac'
       ]
 WHERE id = 'audio-tracks';
