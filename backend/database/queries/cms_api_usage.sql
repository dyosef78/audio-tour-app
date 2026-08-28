-- =============================================================================
-- TASK-303 : CMS API - worked example and acceptance checks
--
-- Run as an ADMIN session, not as `postgres`. Running as postgres bypasses RLS
-- and proves nothing about whether the API works for the people who will use
-- it - which is the only thing worth verifying here.
--
-- In the SQL editor, impersonate an admin like this:
--     SET LOCAL ROLE authenticated;
--     SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
-- inside a transaction. <ADMIN-UUID> must exist in public.app_admins.
-- =============================================================================


-- =============================================================================
-- PART 1 - THE HAPPY PATH, END TO END
-- =============================================================================

-- --- 1. Create the tour ------------------------------------------------------
-- p_tour_id NULL means insert. Status is 'draft' and is not settable here.
SELECT * FROM public.cms_upsert_tour(
    NULL,
    'Jerusalem Old City - Evening Ramparts',
    'in_city',
    'walking',
    75
);

-- --- 2. Lay out the waypoints ------------------------------------------------
-- The whole list in one call. Anything omitted from this payload is deleted, so
-- send the complete set every time - this is the editor's Save, not a patch.
--
-- Note "lon" before "lat" in the payload but the geofence radius in METRES: the
-- server does the geography cast, so the CMS never has to know that buffering a
-- 4326 geometry would work in degrees.
SELECT public.cms_replace_tour_waypoints(
    '<TOUR-UUID>',
    '[
      {
        "id": null,
        "name": "Jaffa Gate",
        "poi_type": "anchor",
        "lon": 35.2279,
        "lat": 31.7766,
        "sort_order": 1,
        "geofence": { "type": "radius", "radius_meters": 25 }
      },
      {
        "id": null,
        "name": "Tower of David",
        "poi_type": "anchor",
        "lon": 35.2281,
        "lat": 31.7761,
        "sort_order": 2,
        "geofence": { "type": "radius", "radius_meters": 20 }
      },
      {
        "id": null,
        "name": "Ramparts Overlook",
        "poi_type": "viewpoint",
        "lon": 35.2290,
        "lat": 31.7770,
        "sort_order": 3,
        "geofence": {
          "type": "polygon",
          "ring": [[35.2288,31.7768],[35.2293,31.7768],[35.2293,31.7772],[35.2288,31.7772]]
        }
      }
    ]'::jsonb
);
-- Returns { upserted, deleted, orphaned_objects }.
-- ALWAYS READ orphaned_objects. It lists storage files whose rows were just
-- cascade-deleted. Nothing in SQL can delete the objects themselves, so if the
-- caller ignores this array those files stay in the bucket forever.

-- --- 3. Audio ----------------------------------------------------------------
-- Upload to the DRAFT bucket from the CMS, then record the row. There is no RPC
-- for this because the upload is a Storage API call the CMS makes directly; the
-- row is a plain insert under the admin RLS policy.
--
--   supabase.storage.from('audio-tracks-draft')
--           .upload(`tours/${tourId}/wp01_jaffa_gate.m4a`, file,
--                   { contentType: 'audio/mp4' });
--
INSERT INTO public.audio_tracks
    (waypoint_id, storage_path, storage_bucket, format, size_bytes, duration_seconds)
VALUES
    ('<WAYPOINT-UUID>',
     'tours/<TOUR-UUID>/wp01_jaffa_gate.m4a',
     'audio-tracks-draft',
     'AAC', 1160000, 145);

-- --- 4. Pre-flight -----------------------------------------------------------
-- Call this from the CMS to render a checklist next to the Publish button.
-- Errors block publication; warnings do not.
SELECT * FROM public.cms_validate_tour('<TOUR-UUID>');

-- --- 5. Publish --------------------------------------------------------------
-- In production the CMS calls the Edge Function, which drives all three phases:
--
--   POST /functions/v1/publish-tour   { "tour_id": "<TOUR-UUID>" }
--   Authorization: Bearer <admin access token>
--
-- The phases are separately callable for debugging:

--   Phase 1 - validate, lock, and return the copy manifest.
SELECT public.cms_request_publish('<TOUR-UUID>');

--   Phase 2 - the copies. NOT POSSIBLE IN SQL. This is the whole reason the
--   Edge Function exists: PostgreSQL cannot reach the Storage API, and
--   UPDATE storage.objects SET bucket_id = ... moves metadata while leaving the
--   bytes where they were, producing a row that points at nothing.

--   Phase 3 - verify the objects landed, then promote.
SELECT public.cms_confirm_publish('<TOUR-UUID>');

--   If the worker died mid-copy the tour sits in 'publishing', invisible.
--   Retry the Edge Function, or give up:
-- SELECT public.cms_abandon_publish('<TOUR-UUID>');

-- --- 6. Confirm the mobile client can see it ---------------------------------
SELECT public.get_tour_bundle('<TOUR-UUID>');
-- media now carries "bucket". Published tracks always read 'audio-tracks'.

-- --- 7. Unpublish ------------------------------------------------------------
SELECT * FROM public.cms_set_tour_status('<TOUR-UUID>', 'archived');

-- This hides the row. It does NOT retract the audio - the public bucket is
-- public, so the objects stay fetchable to anyone holding the path. Run this
-- and delete what it lists, or the "unpublished" tour is still downloadable:
SELECT public.cms_retraction_manifest('<TOUR-UUID>');


-- =============================================================================
-- PART 2 - ACCEPTANCE CHECKS
--
-- Each asserts something the API must refuse. A pass is an ERROR.
-- =============================================================================

-- --- A. A non-admin cannot use the CMS API -----------------------------------
-- Anyone can obtain the `authenticated` role, so this is the check that matters.
-- EXPECT: 'Not authorised: CMS administrator required.' (SQLSTATE 42501)
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims =
      '{"sub":"11111111-2222-4000-8000-000000000000","role":"authenticated"}';
  SELECT public.cms_upsert_tour(NULL, 'nope', 'in_city', 'walking', 10);
ROLLBACK;

-- --- B. status cannot be set to published directly ----------------------------
-- The gate is the point: this path skips validation AND leaves the audio in the
-- draft bucket, so the tour would go live pointing at objects the public bucket
-- does not contain.
-- EXPECT: an error naming cms_request_publish().
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
  SELECT public.cms_set_tour_status('<TOUR-UUID>', 'published');
ROLLBACK;

-- --- C. Publishing a tour with a missing audio object is refused --------------
-- The check the architecture doc asked for. Point a row at a file that was never
-- uploaded and confirm publication is blocked rather than shipping silence.
-- EXPECT: 'failed validation' mentioning audio_object_missing.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
  UPDATE public.audio_tracks SET storage_path = 'tours/does/not/exist.m4a'
   WHERE waypoint_id = '<WAYPOINT-UUID>';
  SELECT public.cms_request_publish('<TOUR-UUID>');
ROLLBACK;

-- --- D. A reorder does not trip the unique constraint -------------------------
-- Swapping two positions passes through a state where both rows share a
-- sort_order. cms_replace_tour_waypoints() defers the constraint for exactly
-- this. EXPECT: success.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
  SELECT public.cms_replace_tour_waypoints('<TOUR-UUID>', '[
     {"id":"<WP-A>","name":"Jaffa Gate","poi_type":"anchor",
      "lon":35.2279,"lat":31.7766,"sort_order":2,
      "geofence":{"type":"radius","radius_meters":25}},
     {"id":"<WP-B>","name":"Tower of David","poi_type":"anchor",
      "lon":35.2281,"lat":31.7761,"sort_order":1,
      "geofence":{"type":"radius","radius_meters":20}}
  ]'::jsonb);
ROLLBACK;

-- --- E. A waypoint cannot be stolen from another tour -------------------------
-- An admin may edit every tour, so RLS alone would permit this. The tour_id in
-- the UPDATE's WHERE clause is what refuses it.
-- EXPECT: 'does not belong to tour'.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
  SELECT public.cms_replace_tour_waypoints('<TOUR-UUID>', '[
     {"id":"<WAYPOINT-BELONGING-TO-ANOTHER-TOUR>","name":"stolen",
      "poi_type":"anchor","lon":35.2,"lat":31.7,"sort_order":1,
      "geofence":{"type":"radius","radius_meters":25}}
  ]'::jsonb);
ROLLBACK;

-- --- F. The radius buffer is in METRES, not degrees ---------------------------
-- The single highest-value assertion in this file. A degrees buffer would be
-- roughly 2,750 km across and would still look like a valid polygon.
-- EXPECT: ~25 (a few cm of tolerance from the buffer's segmentation).
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
  SELECT z.trigger_radius_meters AS declared,
         round(ST_Distance(ST_Centroid(z.geom)::geography,
                           ST_ClosestPoint(ST_Boundary(z.geom),
                                           ST_Centroid(z.geom))::geography)::numeric, 1)
             AS actual_meters
  FROM public.geofence_zones z
  JOIN public.waypoints w ON w.id = z.waypoint_id
  WHERE w.tour_id = '<TOUR-UUID>' AND z.zone_type = 'radius';
ROLLBACK;

-- --- G. A tour mid-publish cannot be edited -----------------------------------
-- Editing during a copy would let the manifest the worker holds drift out of
-- date, and phase 3 would then verify the wrong set of objects.
-- EXPECT: 'is mid-publish' (SQLSTATE 55006).
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<ADMIN-UUID>","role":"authenticated"}';
  UPDATE public.tours SET status = 'publishing' WHERE id = '<TOUR-UUID>';
  SELECT public.cms_replace_tour_waypoints('<TOUR-UUID>', '[]'::jsonb);
ROLLBACK;


-- =============================================================================
-- PART 3 - STORAGE RECONCILIATION
--
-- Nothing keeps the database and the bucket in step automatically. Rows are
-- deleted by cascade and objects are not; objects are uploaded and their rows
-- may never be written. Both directions drift silently, so run these on a
-- schedule until something automates them.
-- =============================================================================

-- Rows pointing at objects that do not exist. These are tracks that will 404 on
-- a device. Publication is blocked on them, so in practice these are drafts.
SELECT a.id, a.storage_bucket, a.storage_path, w.name AS waypoint, t.title AS tour, t.status
FROM public.audio_tracks a
JOIN public.waypoints w ON w.id = a.waypoint_id
JOIN public.tours t     ON t.id = w.tour_id
WHERE NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = a.storage_bucket AND o.name = a.storage_path
)
ORDER BY t.title, w.sort_order;

-- Objects nothing references, in either bucket. Every one is wasted storage,
-- and every one in the PUBLIC bucket is also still downloadable by path.
SELECT o.bucket_id, o.name, o.created_at,
       pg_size_pretty(coalesce((o.metadata ->> 'size')::bigint, 0)) AS size
FROM storage.objects o
WHERE o.bucket_id IN ('audio-tracks', 'audio-tracks-draft')
  AND NOT EXISTS (
      SELECT 1 FROM public.audio_tracks a
      WHERE a.storage_path = o.name AND a.storage_bucket = o.bucket_id
  )
ORDER BY o.bucket_id, o.created_at;

-- Objects in the PUBLIC bucket belonging to tours that are not published.
-- These are the actual leak: the row is hidden, the file is not.
SELECT o.name, t.title, t.status
FROM storage.objects o
JOIN public.audio_tracks a ON a.storage_path = o.name
JOIN public.waypoints w    ON w.id = a.waypoint_id
JOIN public.tours t        ON t.id = w.tour_id
WHERE o.bucket_id = 'audio-tracks'
  AND t.status <> 'published'
ORDER BY t.title;

-- Tours stuck mid-publish. Should always be empty; anything here means a worker
-- died and a tour is invisible with nobody being told.
SELECT id, title, updated_at
FROM public.tours
WHERE status = 'publishing'
ORDER BY updated_at;
