-- =============================================================================
-- TASK-603 (1 of 2) : track_kind, preference tags, transcript sidecars
--
-- STATUS: APPROVED 15 Sep 2026 (PM, TASK-603). NOT YET APPLIED to the linked
-- project. `supabase db push` only after db-verify.yml is green on this branch,
-- and ahead of any mobile build that reads the new columns.
-- Push together with 20260915120100, which rewrites the functions that read
-- these columns. Neither is useful alone, and this one must land first.
--
-- PM decisions (15 Sep 2026) this implements:
--   * audio_tracks.track_kind separates narration from Deep Dives.
--   * Tours and waypoints carry tags matching the onboarding preferences.
--   * Transcripts are WebVTT files stored NEXT TO their audio (same path,
--     .vtt extension) - a convention, not a table.
--
-- WHAT THIS MIGRATION DOES TO EXISTING ROWS
--
--   audio_tracks   Every row becomes track_kind = 'narration' via the column
--                  default. That is true of all of them: no Deep Dive has ever
--                  been ingested, and the unique index being replaced has
--                  guaranteed one track per waypoint since TASK-402.
--   tours,         Gain audiences/interests as empty arrays. A constant
--   waypoints      default is metadata-only since Postgres 11 - no rewrite.
--   storage        text/vtt is APPENDED to the audio-tracks allowlist. Nothing
--                  already allowed is removed.
--   KPI views      Now count narration only. Today that changes no number,
--                  because every event so far is for a narration track.
--
-- No bundle_version_hash moves and no device re-downloads anything; the
-- function that computes the hash is in the next migration, which explains
-- how it stays byte-identical for existing tours.
--
-- NOT IN HERE: 'ambient' as a track_kind. The brief listed it as an example,
-- but nothing on the device plays one, so a row of that kind would be accepted
-- by the CMS and silently never heard. Widening the CHECK below is a one-line
-- migration on the day ambient playback exists.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. Tag vocabulary
--
-- One function per axis, used by the CHECK constraints, by the CMS functions'
-- error messages, and read by `npm run test:cms` to prove it still matches the
-- ids in mobile/src/personalization/options.ts. Those ids are persisted on
-- devices, so the three must never drift apart.
--
-- CHECK rather than a lookup table, for the reason TASK-301 gave for enums:
-- the mobile app hardcodes a label per id, so a value an admin could insert
-- without a release would be a tag no device can display.
--
-- CAVEAT: Postgres does not re-validate existing rows when a function used by
-- a CHECK is replaced. WIDENING the list is safe. NARROWING it needs a data
-- migration plus an explicit re-check, or old rows keep a value the
-- constraint no longer describes.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audience_tag_vocabulary()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
    SELECT ARRAY['solo', 'couple', 'friends', 'family_kids']::text[];
$fn$;

CREATE OR REPLACE FUNCTION public.interest_tag_vocabulary()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
    SELECT ARRAY['history', 'culinary', 'nature', 'architecture', 'art_culture']::text[];
$fn$;

COMMENT ON FUNCTION public.audience_tag_vocabulary() IS
    'Allowed audience tags. Must equal GROUP_TYPES ids in mobile/src/personalization/options.ts; npm run test:cms checks.';
COMMENT ON FUNCTION public.interest_tag_vocabulary() IS
    'Allowed interest tags. Must equal INTERESTS ids in mobile/src/personalization/options.ts; npm run test:cms checks.';

-- Left executable by PUBLIC on purpose. A CHECK calls its functions as the
-- user performing the write, and these disclose nothing but two literals.

-- -----------------------------------------------------------------------------
-- 2. Tags on tours and waypoints
--
-- EMPTY MEANS UNRESTRICTED. A tour with no interests is not "for nobody", it
-- is "not narrowed to anyone". That makes untagged content show up for every
-- preference instead of vanishing from every filtered list the day this ships,
-- and cms_validate_tour warns about it so the gap is visible.
--
-- Waypoints carry both axes as well: a stop can suit a group or an interest
-- that the tour as a whole does not (a wine bar on a family walk).
-- -----------------------------------------------------------------------------
ALTER TABLE public.tours
    ADD COLUMN IF NOT EXISTS audiences text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.waypoints
    ADD COLUMN IF NOT EXISTS audiences text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS interests text[] NOT NULL DEFAULT '{}';

-- array_position(..., NULL) finds NULL elements (it compares with IS NOT
-- DISTINCT FROM), which `<@` alone would not reliably reject.
ALTER TABLE public.tours
    ADD CONSTRAINT tours_audiences_vocabulary_check
        CHECK (audiences <@ public.audience_tag_vocabulary()
               AND array_position(audiences, NULL) IS NULL),
    ADD CONSTRAINT tours_interests_vocabulary_check
        CHECK (interests <@ public.interest_tag_vocabulary()
               AND array_position(interests, NULL) IS NULL);

ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_audiences_vocabulary_check
        CHECK (audiences <@ public.audience_tag_vocabulary()
               AND array_position(audiences, NULL) IS NULL),
    ADD CONSTRAINT waypoints_interests_vocabulary_check
        CHECK (interests <@ public.interest_tag_vocabulary()
               AND array_position(interests, NULL) IS NULL);

COMMENT ON COLUMN public.tours.audiences IS
    'Onboarding group types this tour suits (audience_tag_vocabulary). Empty = not restricted.';
COMMENT ON COLUMN public.tours.interests IS
    'Onboarding interests this tour serves (interest_tag_vocabulary). Empty = not restricted.';
COMMENT ON COLUMN public.waypoints.audiences IS
    'Group types this stop suits, for route filtering. Empty = not restricted.';
COMMENT ON COLUMN public.waypoints.interests IS
    'Interests this stop serves, for route filtering. Empty = not restricted.';

-- The catalogue filter is `interests && $1` / `audiences && $1`, which GIN
-- serves. Waypoints are filtered on the device from the bundle, so they get none.
CREATE INDEX IF NOT EXISTS idx_tours_audiences ON public.tours USING GIN (audiences);
CREATE INDEX IF NOT EXISTS idx_tours_interests ON public.tours USING GIN (interests);

-- RLS: nothing to add. These are columns on rows already governed by the
-- public-content pattern (visible iff the tour is published), and tags are
-- public content by definition.

-- -----------------------------------------------------------------------------
-- 3. audio_tracks.track_kind
-- -----------------------------------------------------------------------------
ALTER TABLE public.audio_tracks
    ADD COLUMN IF NOT EXISTS track_kind text NOT NULL DEFAULT 'narration';

ALTER TABLE public.audio_tracks
    ADD CONSTRAINT audio_tracks_track_kind_check
        CHECK (track_kind IN ('narration', 'deep_dive'));

COMMENT ON COLUMN public.audio_tracks.track_kind IS
    'narration: plays on geofence entry, one per waypoint, required to publish. deep_dive: optional extended track the listener chooses; never on a transition stop.';

-- One track PER KIND per waypoint.
--
-- The index this replaces allowed exactly one row per waypoint, which is what
-- made the old get_tour_bundle() ORDER BY id LIMIT 1 safe. A Deep Dive needs a
-- second row, and without a kind in both the key AND the bundle query, which
-- row a device received would be decided by uuid ordering. Created before the
-- old one is dropped, so uniqueness is never absent inside the transaction.
CREATE UNIQUE INDEX IF NOT EXISTS audio_tracks_one_per_waypoint_kind
    ON public.audio_tracks (waypoint_id, track_kind);

COMMENT ON INDEX public.audio_tracks_one_per_waypoint_kind IS
    'One track of each kind per waypoint. Conflict target for cms_register_audio_track(); leading waypoint_id also serves FK lookups and cascades.';

DROP INDEX IF EXISTS public.audio_tracks_one_per_waypoint;

-- -----------------------------------------------------------------------------
-- 4. Transcript sidecars
--
-- The ONE definition of "where a track's transcript lives". Mirrored exactly by
-- mobile/src/transcript/sidecar.ts, which both the device and backend/cms
-- import. test:cms pins the two together.
--
-- NULL for a path with no recognised audio extension. The CASE is load-bearing:
-- regexp_replace returns its input unchanged when nothing matches, which would
-- name the AUDIO file as its own transcript.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transcript_path_for(p_storage_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = ''
AS $fn$
    SELECT CASE
        WHEN p_storage_path ~* '[.](m4a|mp3)$'
        THEN regexp_replace(p_storage_path, '[.](m4a|mp3)$', '.vtt', 'i')
    END;
$fn$;

COMMENT ON FUNCTION public.transcript_path_for(text) IS
    'Bucket path of the WebVTT transcript for an audio storage_path: same path, .vtt extension. NULL when the path has no .m4a/.mp3 extension.';

-- -----------------------------------------------------------------------------
-- 5. Storage access for sidecars
--
-- WITHOUT THIS, NO TRANSCRIPT COULD EVER REACH A DEVICE. The published-read
-- policy on storage.objects calls audio_object_is_published(name), which only
-- matched names equal to a registered storage_path. A .vtt is never one, so
-- createSignedUrls() would refuse every transcript regardless of the MIME
-- allowlist - and it refuses per-path inside a 200, which looks like "no
-- transcript" rather than an error.
--
-- A sidecar is now published exactly when its audio is. Same flag, same place,
-- so unpublishing still retracts both.
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
        WHERE t.status = 'published'
          AND (
                a.storage_path = p_object_name
             OR (p_object_name ~* '[.]vtt$'
                 AND public.transcript_path_for(a.storage_path) = p_object_name)
          )
    );
$fn$;

COMMENT ON FUNCTION public.audio_object_is_published(text) IS
    'True when an audio-tracks object - an audio file or its .vtt transcript sidecar - belongs to a published tour. Gates signed-URL issuance and direct download, so unpublishing makes both genuinely unreachable.';

-- -----------------------------------------------------------------------------
-- 6. Bucket MIME allowlist - APPEND text/vtt
--
-- Every earlier migration touching this column REPLACED the array, and the
-- TASK-301 review caught that replacing drops anything added by hand. So this
-- appends, and is guarded twice:
--   * NOT ... = ANY  - re-running does not add a duplicate
--   * IS NOT NULL    - NULL means "allow everything"; array_append(NULL, x)
--                      is {x}, which would lock the bucket to transcripts only
--                      and break every audio upload.
--
-- Uploads must send Content-Type exactly `text/vtt`; backend/cms does.
-- -----------------------------------------------------------------------------
UPDATE storage.buckets
   SET allowed_mime_types = array_append(allowed_mime_types, 'text/vtt')
 WHERE id = 'audio-tracks'
   AND allowed_mime_types IS NOT NULL
   AND NOT ('text/vtt' = ANY (allowed_mime_types));

-- -----------------------------------------------------------------------------
-- 7. KPI views: narration only
--
-- A Deep Dive is optional and minutes long; most listeners will not finish
-- one. Left in, every Deep Dive start would join the denominator of the Audio
-- Completion Rate and drag the headline KPI down for content working exactly
-- as intended.
--
-- Classified by joining the event's audio_track_id. An event with NO track id
-- counts as narration, which is correct for every bundle downloaded before
-- TASK-507 (they predate Deep Dives) and wrong only for a Deep Dive whose row
-- was since deleted (ON DELETE SET NULL). That residue is small and one-way.
--
-- Column lists are unchanged, which is what lets CREATE OR REPLACE VIEW apply.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_kpi_audio_completion
WITH (security_invoker = true) AS
SELECT
    e.tour_id,
    t.title AS tour_title,
    e.waypoint_id,
    w.name  AS waypoint_name,
    w.sort_order,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started')   AS devices_started,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_completed') AS devices_completed,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_skipped')   AS devices_skipped,
    round(
        count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_completed')::numeric
        / nullif(count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started'), 0)
    , 4) AS completion_rate,
    round(
        count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_skipped')::numeric
        / nullif(count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started'), 0)
    , 4) AS skip_rate
FROM public.telemetry_events e
LEFT JOIN public.tours t        ON t.id = e.tour_id
LEFT JOIN public.waypoints w    ON w.id = e.waypoint_id
LEFT JOIN public.audio_tracks a ON a.id = e.audio_track_id
WHERE e.event_type IN ('audio_started', 'audio_completed', 'audio_skipped')
  AND coalesce(a.track_kind, 'narration') = 'narration'
GROUP BY e.tour_id, t.title, e.waypoint_id, w.name, w.sort_order;

COMMENT ON VIEW public.v_kpi_audio_completion IS
    'Audio Completion Rate and Skip Rate per waypoint, NARRATION ONLY (Deep Dives are in v_kpi_deep_dive_completion). Counts distinct devices, not events. security_invoker = true, so admin-only like the underlying table.';

CREATE OR REPLACE VIEW public.v_kpi_audio_dropoff
WITH (security_invoker = true) AS
SELECT
    e.tour_id,
    t.title AS tour_title,
    e.waypoint_id,
    w.name  AS waypoint_name,
    count(*)                                       AS stop_events,
    round(avg(e.position_seconds / e.track_seconds), 4) AS avg_progress_at_stop,
    round(percentile_cont(0.5) WITHIN GROUP (
              ORDER BY e.position_seconds / e.track_seconds)::numeric, 4) AS median_progress_at_stop,
    count(*) FILTER (WHERE e.position_seconds / e.track_seconds < 0.1) AS abandoned_early
FROM public.telemetry_events e
LEFT JOIN public.tours t        ON t.id = e.tour_id
LEFT JOIN public.waypoints w    ON w.id = e.waypoint_id
LEFT JOIN public.audio_tracks a ON a.id = e.audio_track_id
WHERE e.event_type IN ('audio_stopped', 'audio_skipped')
  AND e.position_seconds IS NOT NULL
  AND e.track_seconds IS NOT NULL
  AND e.track_seconds > 0
  AND coalesce(a.track_kind, 'narration') = 'narration'
GROUP BY e.tour_id, t.title, e.waypoint_id, w.name;

COMMENT ON VIEW public.v_kpi_audio_dropoff IS
    'Where NARRATION playback stops, as a fraction of track length. abandoned_early (under 10%) usually means the wrong track fired rather than genuine drop-off.';

-- Deep Dives get their own funnel. Inner join: an event must name a track that
-- is still a deep_dive to count, so nothing here is guessed.
CREATE OR REPLACE VIEW public.v_kpi_deep_dive_completion
WITH (security_invoker = true) AS
SELECT
    e.tour_id,
    t.title AS tour_title,
    e.waypoint_id,
    w.name  AS waypoint_name,
    w.sort_order,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started')   AS devices_started,
    count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_completed') AS devices_completed,
    round(
        count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_completed')::numeric
        / nullif(count(DISTINCT e.device_id) FILTER (WHERE e.event_type = 'audio_started'), 0)
    , 4) AS completion_rate,
    round(avg(e.position_seconds / nullif(e.track_seconds, 0))
          FILTER (WHERE e.event_type IN ('audio_stopped', 'audio_skipped')), 4) AS avg_progress_at_stop
FROM public.telemetry_events e
JOIN public.audio_tracks a   ON a.id = e.audio_track_id AND a.track_kind = 'deep_dive'
LEFT JOIN public.tours t     ON t.id = e.tour_id
LEFT JOIN public.waypoints w ON w.id = e.waypoint_id
WHERE e.event_type IN ('audio_started', 'audio_completed', 'audio_skipped', 'audio_stopped')
GROUP BY e.tour_id, t.title, e.waypoint_id, w.name, w.sort_order;

COMMENT ON VIEW public.v_kpi_deep_dive_completion IS
    'Deep Dive completion and how far listeners get before stopping, per waypoint. Kept apart from v_kpi_audio_completion so optional long-form content cannot distort the headline narration KPI.';

GRANT SELECT ON public.v_kpi_deep_dive_completion TO authenticated;
