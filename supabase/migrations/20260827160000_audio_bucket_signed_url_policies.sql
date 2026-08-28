-- =============================================================================
-- TASK-303 (revised) : Single private audio bucket
--
-- STATUS: DRAFT - awaiting approval. Do not push.
--
-- SUPERSEDES the two-bucket draft/public design, which was written and then
-- withdrawn before it was ever pushed. Nothing here reverses applied history;
-- the earlier files were deleted rather than undone, so the migration log has
-- no record of a design that never ran. That is the one benefit of catching an
-- architecture problem while the SQL is still on disk.
--
-- THE PIVOT
--
-- Previously: audio-tracks (public) + audio-tracks-draft (private), with a copy
-- at publish time performed by an Edge Function, because PostgreSQL cannot
-- reach the Storage API.
--
-- Now: ONE private bucket. Publishing is a status flag and nothing else. The
-- client asks for a signed URL when it downloads a bundle, which works because
-- this app is offline-first - the URL is needed once, at download time, and
-- never again. Playback is from local disk.
--
-- What that deletes: the second bucket, the copy step, the Edge Function, the
-- 'publishing' status, audio_tracks.storage_bucket, and every storage/database
-- drift risk in the TASK-303 register.
--
-- What it buys beyond simplicity: unpublishing now ACTUALLY retracts content.
-- Under the public bucket, hiding a row left the object fetchable forever to
-- anyone holding the path. Here, storage access is gated on the same
-- publication state as the rows, in the same place.
--
-- THIS MIGRATION DOES NOT FLIP THE BUCKET.
--
-- Making the bucket private is a breaking change for the shipped mobile client,
-- which resolves audio through getPublicUrl(). Doing both in one migration
-- would mean the app is broken for however long it takes a client release to
-- reach devices.
--
-- So the flip lives in 20260827180000_flip_audio_bucket_private.sql, and the
-- policy groundwork lands here first. That splits the change into a safe order:
--
--   1. push THIS - signed URLs start working while the bucket is still public,
--      so nothing breaks and both URL styles are valid
--   2. ship the mobile client that uses createSignedUrls()
--   3. push the flip - getPublicUrl() dies, but nothing is using it any more
--
-- Between steps 1 and 3 the old public CDN path still bypasses RLS, so the
-- TASK-302 residual risk stays open for exactly that window. It is the price of
-- not breaking the app, and the window is closed by pushing step 3.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 2. Publication-gated storage access
--
-- A helper rather than an inline EXISTS, for the same reason as the TASK-302
-- publication helpers: it keeps the tours policy from being evaluated inside
-- the storage policy, which is legal but hard to reason about and one refactor
-- away from recursion.
--
-- SECURITY DEFINER with a pinned search_path. It answers only "is this object
-- path part of a published tour", takes a path the caller already holds, and
-- returns a boolean - so it discloses nothing beyond publication state.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audio_object_is_published(p_object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
    SELECT EXISTS (
        SELECT 1
        FROM public.audio_tracks a
        JOIN public.waypoints w ON w.id = a.waypoint_id
        JOIN public.tours t     ON t.id = w.tour_id
        WHERE a.storage_path = p_object_name
          AND t.status = 'published'
    );
$fn$;

COMMENT ON FUNCTION public.audio_object_is_published(text) IS
    'True when an audio-tracks object belongs to a published tour. Gates both signed-URL issuance and direct download, so unpublishing a tour makes its audio genuinely unreachable rather than merely unlisted.';

REVOKE ALL ON FUNCTION public.audio_object_is_published(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.audio_object_is_published(text) TO anon, authenticated;

-- The TASK-302 admin-only read policy is replaced: with a private bucket, the
-- mobile client needs SELECT in order to have a signed URL issued to it.
DROP POLICY IF EXISTS "audio_tracks_admin_read" ON storage.objects;

-- Public read, but only for published content.
--
-- SELECT on storage.objects is what createSignedUrl() checks, so this policy is
-- what decides whether a URL can be minted at all. It also permits list(),
-- which now enumerates published objects only - those are public content by
-- definition, so the enumeration that mattered in TASK-302 (draft paths, tour
-- ids, waypoint names) stays closed.
CREATE POLICY "audio_tracks_read_published"
    ON storage.objects FOR SELECT
    TO anon, authenticated
    USING (
        bucket_id = 'audio-tracks'
        AND public.audio_object_is_published(name)
    );

-- Admins keep full read regardless of publication state, or they could not
-- manage draft audio at all.
CREATE POLICY "audio_tracks_admin_read_all"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (bucket_id = 'audio-tracks' AND (SELECT public.is_cms_admin()));

-- Write policies from TASK-302 are unchanged and still admin-only. They are
-- listed here only so the full picture lives in one place:
--   audio_tracks_admin_insert / _update / _delete.

-- -----------------------------------------------------------------------------
-- 3. Bucket settings
--
-- Re-asserted so an environment rebuilt from migrations alone converges, and so
-- the allowlist is not silently inherited from whatever the dashboard holds.
-- Matches the TASK-301 allowlist including audio/mpeg for the MP3 fallback.
-- -----------------------------------------------------------------------------
UPDATE storage.buckets
   SET file_size_limit    = 52428800,
       allowed_mime_types = ARRAY[
           'audio/mp4',
           'audio/m4a',
           'audio/x-m4a',
           'audio/mpeg',
           'audio/aac'
       ]
 WHERE id = 'audio-tracks';
