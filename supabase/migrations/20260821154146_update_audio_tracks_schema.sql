-- =============================================================================
-- TASK-305 : audio_tracks refinements
--
-- 1. file_url -> storage_path. The column now holds a path RELATIVE to the
--    `audio-tracks` bucket, not an absolute URL, so rows stop being pinned to
--    one project ref. Clients resolve it at read time via
--    storage.from('audio-tracks').getPublicUrl(storage_path).
--
-- 2. + duration_seconds. Needed for the offline bundle time estimate on PRD
--    Screen 4, and to size the deep-dive vs. transition cue split from PRD
--    Section 3. Until now duration was only inferable from size_bytes and an
--    assumed bitrate.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rename
--
-- RENAME COLUMN preserves data, indexes and constraints - no rebuild, and no
-- window where the column is missing.
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    RENAME COLUMN file_url TO storage_path;

-- Backfill: any environment that already received the old seed holds absolute
-- URLs in this column, which no longer match its meaning. Strip the public
-- prefix down to the bucket-relative path.
--
-- This matters for the remote project specifically - see the handover report.
-- Idempotent: the WHERE clause skips rows that are already relative paths.
UPDATE public.audio_tracks
   SET storage_path = regexp_replace(
           storage_path,
           '^https?://[^/]+/storage/v1/object/public/audio-tracks/',
           ''
       )
 WHERE storage_path ~ '^https?://';

COMMENT ON COLUMN public.audio_tracks.storage_path IS
    'Path relative to the audio-tracks Storage bucket, e.g. tours/<tour_id>/wp01_name.opus. Never an absolute URL - resolve with getPublicUrl().';

-- -----------------------------------------------------------------------------
-- 2. Duration
--
-- Nullable on purpose: rows may be inserted by the CMS before the encoder has
-- reported a duration. See the handover note on tightening this to NOT NULL
-- once the pipeline guarantees it.
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    ADD COLUMN duration_seconds INT;

COMMENT ON COLUMN public.audio_tracks.duration_seconds IS
    'Playback length in whole seconds. Feeds the PRD Screen 4 bundle estimate. Walking anchors run 90-150s; transition cues are much shorter.';
