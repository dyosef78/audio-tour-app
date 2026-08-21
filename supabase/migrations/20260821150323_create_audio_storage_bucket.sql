-- =============================================================================
-- TASK-304 : Storage bucket for the audio pipeline
--
-- Creates the `audio-tracks` bucket that backs the audio_tracks table, and
-- publishes it for unauthenticated CDN reads so the offline bundle download
-- (PRD Screen 4) can fetch tracks without an auth round-trip per file.
--
-- Write access stays with service_role (the CMS API). Same posture as the
-- enable_rls_policies migration: grant reads explicitly, define no write
-- policies, and let the RLS bypass on service_role cover the content pipeline.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Bucket
--
-- public = true means objects are served from
--   /storage/v1/object/public/audio-tracks/<path>
-- with no Authorization header and no RLS evaluation. Anyone with the URL can
-- fetch the file. That is the intent here - see the handover note on why the
-- SELECT policy below is still worth having.
--
-- ON CONFLICT DO UPDATE so the migration converges even if the bucket was
-- created by hand in the dashboard first.
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'audio-tracks',
    'audio-tracks',
    true,
    52428800,  -- 50 MB ceiling; real tracks run ~0.2-1 MB (Opus mono, 48 kbps).
    -- Opus in Ogg, raw Opus, and AAC-LC in an MP4/M4A container, per the
    -- offline bundle format in PRD Step 5.
    ARRAY[
        'audio/ogg',
        'audio/opus',
        'audio/aac',
        'audio/mp4'
    ]
)
ON CONFLICT (id) DO UPDATE
SET public             = EXCLUDED.public,
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Policies on storage.objects
--
-- Note: RLS is already enabled on storage.objects by Supabase, and the table is
-- owned by supabase_storage_admin - migrations run as `postgres` and cannot
-- ALTER it. So there is deliberately no ENABLE ROW LEVEL SECURITY line here;
-- adding one would fail with "must be owner of table objects".
--
-- Every policy is scoped by bucket_id so it cannot leak into other buckets
-- added later.
-- -----------------------------------------------------------------------------

-- Read: needed for the authenticated Storage API path - list(), download(),
-- and getPublicUrl() when called with a user session. The anonymous CDN path
-- does not consult this policy at all (see handover).
CREATE POLICY "Public read access to audio-tracks objects"
    ON storage.objects FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'audio-tracks');

-- No INSERT / UPDATE / DELETE policies are defined. RLS denies by default, so
-- uploads, overwrites and deletes are impossible for anon and authenticated
-- while remaining unrestricted for service_role, which bypasses RLS.
