-- =============================================================================
-- TASK-303 (revised) : Flip the audio bucket private
--
-- STATUS: DRAFT - awaiting approval, AND NOT SAFE TO PUSH YET.
--
-- !! DO NOT PUSH THIS UNTIL A MOBILE CLIENT USING createSignedUrls() HAS
-- !! SHIPPED AND OLD VERSIONS ARE DRAINED.
--
-- This is deliberately a separate migration from the policy groundwork in
-- 20260827160000, so that the two halves can be pushed weeks apart:
--
--   1. 20260827160000 - signed URLs start working, bucket still public.
--                       Nothing breaks; both URL styles are valid.
--   2. mobile release  - client switches to createSignedUrls().
--   3. THIS FILE       - getPublicUrl() stops working, and the CDN path that
--                        bypasses RLS is closed for good.
--
-- Pushing this early does not corrupt anything, but it breaks audio playback
-- for every installed copy of the app at once: getPublicUrl() builds a URL
-- string client-side without contacting anything, so the failure surfaces as a
-- 400 at download time rather than as an error the client can anticipate.
--
-- Once applied:
--   * every read is evaluated against the storage.objects policies
--   * unpublishing a tour genuinely retracts its audio, because
--     audio_object_is_published() gates signed-URL issuance on tour status
--   * the TASK-302 residual risk - "an object whose path is known stays
--     fetchable forever" - is closed rather than merely documented
--
-- Reversible. `UPDATE storage.buckets SET public = true WHERE id =
-- 'audio-tracks';` puts it back, and no data moves in either direction - which
-- makes this the cheapest possible rollback if a client version turns out to
-- still be in the wild.
-- =============================================================================

UPDATE storage.buckets
   SET public = false
 WHERE id = 'audio-tracks';
