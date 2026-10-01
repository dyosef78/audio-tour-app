-- =============================================================================
-- Epic 15 (Part 1 of 2): Chapters, routing anchors, approach bearings - SCHEMA
--
-- STATUS: DRAFT - awaiting approval. NOT APPLIED to the linked project.
--
-- A tour becomes a sequence of CHAPTERS ("Drive to the site", "Walk the site"),
-- each with its own transit mode. Navigation is handed off to Google Maps or
-- Waze per chapter, so the data separates:
--
--   ROUTING ANCHORS  chapter_route_anchors - points sent to the navigation app
--                    to force the scenic route. Never trigger audio.
--   AUDIO TRIGGERS   the existing waypoints + geofence_zones + audio_tracks.
--                    Not renamed: get_tour_bundle, the CMS RPCs, telemetry FKs
--                    and every shipped app address them by these names.
--
--   1. tour_chapters            NEW table, owns transit_mode from now on
--   2. chapter_route_anchors    NEW table, <= max_route_anchors() per chapter
--   3. waypoints                + chapter_id, + approach bearing (3 columns)
--   4. backfill                 one chapter per existing tour
--   5. invariants (triggers)    default chapter, tours.transit_mode mirror
--   6. RLS                      public-content pattern on both tables
--
-- WHAT THIS MIGRATION DOES TO EXISTING ROWS
--
--   * tours: nothing written. tours.transit_mode stays, as a value DERIVED
--     from the chapters (section 5) - shipped apps (TestFlight build 10, the
--     deployed route-stops function) read it and must keep working.
--   * tour_chapters: one row per tour, whose id IS the tour's id (section 4).
--   * waypoints: every row gets chapter_id = its tour_id, so every row's
--     updated_at moves to the migration time (trg_waypoints_updated_at). The
--     bearing columns are added with constant defaults: metadata-only, no
--     table rewrite.
--   * bundle_version_hash: UNCHANGED for every tour, including the published
--     Tel Aviv QA tour. See 20261001120100 section 1.
--
-- DEPLOY ORDER: push this and 20261001120100 TOGETHER (one `db push`). This
-- file makes waypoints.chapter_id NOT NULL; the old cms_replace_tour_waypoints
-- still works against it only because of the default-chapter trigger here.
--
-- FOLLOW-UP AFTER PUSHING: backend/types/supabase.ts by hand (see the
-- seeding-workstation note: never run types:generate blind on this machine).
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 0. The Google Maps waypoint cap, defined once
--
-- Google Maps URLs accept up to 9 waypoints when the link opens the app, and
-- only 3 in a mobile browser (Google's Maps URLs documentation). Used by the
-- anchor cap trigger below, cms_replace_tour_chapters and cms_validate_tour.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.max_route_anchors()
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $fn$
    SELECT 9;
$fn$;

COMMENT ON FUNCTION public.max_route_anchors() IS
    'Most routing anchors one chapter may hold: Google Maps URLs accept at most 9 waypoints. Waze accepts none, so a chapter with any anchor is Google-Maps-only.';

-- -----------------------------------------------------------------------------
-- 1. tour_chapters
--
-- sort_order is unique per tour and DEFERRABLE, for the same reason as
-- waypoints_tour_sort_order_key: a drag-and-drop reorder passes through
-- duplicates inside one transaction.
--
-- (id, tour_id) is UNIQUE only so waypoints can reference the PAIR (section 3):
-- that composite FK is what makes "a waypoint's chapter belongs to the
-- waypoint's own tour" a constraint instead of a hope.
--
-- title NULL = no chapter heading. Only legal while the tour has one chapter
-- (cms_validate_tour: chapter_untitled).
--
-- destination NULL = no navigation handoff for this chapter (a walk on site
-- uses the in-app map). Anchors without a destination are meaningless and are
-- refused at publish (chapter_anchors_without_destination).
--
-- sequence_policy / lookahead_stops drive the device's loose-sequence engine:
--   windowed  any unplayed stop among the next `lookahead_stops` may fire
--   strict    only the next unplayed stop may fire (the Epic 9 behaviour)
-- The defaults ('windowed', 3) are ALSO the values a device assumes for a
-- manifest saved before this migration, and the values get_tour_bundle treats
-- as "plain" when hashing. Change one, change all three.
-- -----------------------------------------------------------------------------
CREATE TABLE public.tour_chapters (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tour_id           uuid NOT NULL REFERENCES public.tours (id) ON DELETE CASCADE,
    sort_order        int  NOT NULL
                      CONSTRAINT tour_chapters_sort_order_check CHECK (sort_order >= 0),
    title             text
                      CONSTRAINT tour_chapters_title_check
                          CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 120),
    transit_mode      text NOT NULL
                      CONSTRAINT tour_chapters_transit_mode_check
                          CHECK (transit_mode IN ('walking', 'biking', 'driving')),
    sequence_policy   text NOT NULL DEFAULT 'windowed'
                      CONSTRAINT tour_chapters_sequence_policy_check
                          CHECK (sequence_policy IN ('strict', 'windowed')),
    lookahead_stops   smallint NOT NULL DEFAULT 3
                      CONSTRAINT tour_chapters_lookahead_stops_check
                          CHECK (lookahead_stops BETWEEN 1 AND 20),
    destination       geometry(Point, 4326),
    destination_label text
                      CONSTRAINT tour_chapters_destination_label_check
                          CHECK (destination_label IS NULL OR char_length(btrim(destination_label)) BETWEEN 1 AND 120),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tour_chapters_label_needs_destination_check
        CHECK (destination_label IS NULL OR destination IS NOT NULL),
    CONSTRAINT tour_chapters_tour_sort_order_key
        UNIQUE (tour_id, sort_order) DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT tour_chapters_id_tour_key
        UNIQUE (id, tour_id)
);

COMMENT ON TABLE public.tour_chapters IS
    'Epic 15: a tour is an ordered list of chapters, each with its own transit mode and optional navigation handoff. Audio triggers (waypoints) belong to exactly one chapter of their own tour.';
COMMENT ON COLUMN public.tour_chapters.id IS
    'For the chapter a tour is born with (and every chapter backfilled by 20261001120000) this equals tours.id. get_tour_bundle relies on that to recognise a plain single-chapter tour.';
COMMENT ON COLUMN public.tour_chapters.transit_mode IS
    'The authoritative transit mode. tours.transit_mode is derived from these (tour_transit_mode_from_chapters).';
COMMENT ON COLUMN public.tour_chapters.destination IS
    'Where the navigation handoff routes to. NULL = no handoff; the chapter uses the in-app map.';

-- -----------------------------------------------------------------------------
-- 2. chapter_route_anchors
--
-- Ordered via-points for the handoff deep link. They never trigger audio and
-- the device never geofences them. ON DELETE CASCADE: an anchor has no meaning
-- without its chapter and owns no storage object, so nothing is orphaned.
-- -----------------------------------------------------------------------------
CREATE TABLE public.chapter_route_anchors (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id  uuid NOT NULL REFERENCES public.tour_chapters (id) ON DELETE CASCADE,
    sort_order  int  NOT NULL
                CONSTRAINT chapter_route_anchors_sort_order_check CHECK (sort_order >= 0),
    geom        geometry(Point, 4326) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chapter_route_anchors_chapter_sort_order_key
        UNIQUE (chapter_id, sort_order) DEFERRABLE INITIALLY IMMEDIATE
);

COMMENT ON TABLE public.chapter_route_anchors IS
    'Epic 15: ordered waypoints passed to Google Maps to force a chapter''s scenic route. Routing only - never an audio trigger. At most max_route_anchors() per chapter.';

-- The cap, enforced for every write path, not only the RPC. DEFERRED so a
-- replace-all inside one transaction (delete 9, insert 9) is judged on the
-- end state. Two concurrent transactions could each stay under the cap and
-- together exceed it; cms_validate_tour re-checks at publish
-- (chapter_too_many_anchors), which is enough for a single-editor CMS.
CREATE OR REPLACE FUNCTION public.assert_chapter_anchor_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
DECLARE
    v_count int;
BEGIN
    SELECT count(*) INTO v_count
      FROM public.chapter_route_anchors a
     WHERE a.chapter_id = NEW.chapter_id;

    IF v_count > public.max_route_anchors() THEN
        RAISE EXCEPTION 'Chapter % has % routing anchors; Google Maps accepts at most %.',
            NEW.chapter_id, v_count, public.max_route_anchors()
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$fn$;

CREATE CONSTRAINT TRIGGER trg_chapter_route_anchors_cap
    AFTER INSERT OR UPDATE OF chapter_id ON public.chapter_route_anchors
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.assert_chapter_anchor_cap();

-- -----------------------------------------------------------------------------
-- 3. waypoints: chapter + approach bearing
--
-- The bearing qualifies the trigger ("fire only while travelling roughly this
-- way"), so it lives with the waypoint that owns the trigger, not on
-- geofence_zones: cms_replace_tour_waypoints deletes and re-inserts the zone on
-- every Save, and would drop it.
--
--   approach_bearing_deg     0..359, degrees clockwise from true north: the
--                            direction of TRAVEL that should fire the stop.
--   bearing_tolerance_deg    half-width of the accepted cone. 10..90: below
--                            10 GPS course noise alone rejects real passes;
--                            above 90 the cone admits the opposite carriageway.
--   bearing_policy           required   no usable course -> do not fire
--                            preferred  no usable course -> fire; a course
--                                       that contradicts -> do not fire
--                            ignore     no direction check (the default)
--   approach_bearing_source  authored | derived. CMS-time Valhalla derivation
--                            (Epic 15 decision 5) may overwrite 'derived' rows
--                            and must never overwrite 'authored' ones.
-- -----------------------------------------------------------------------------
ALTER TABLE public.waypoints
    ADD COLUMN IF NOT EXISTS chapter_id uuid,
    ADD COLUMN IF NOT EXISTS approach_bearing_deg smallint
        CONSTRAINT waypoints_approach_bearing_range_check
            CHECK (approach_bearing_deg IS NULL OR approach_bearing_deg BETWEEN 0 AND 359),
    ADD COLUMN IF NOT EXISTS bearing_tolerance_deg smallint NOT NULL DEFAULT 45
        CONSTRAINT waypoints_bearing_tolerance_range_check
            CHECK (bearing_tolerance_deg BETWEEN 10 AND 90),
    ADD COLUMN IF NOT EXISTS bearing_policy text NOT NULL DEFAULT 'ignore'
        CONSTRAINT waypoints_bearing_policy_check
            CHECK (bearing_policy IN ('required', 'preferred', 'ignore')),
    ADD COLUMN IF NOT EXISTS approach_bearing_source text
        CONSTRAINT waypoints_approach_bearing_source_check
            CHECK (approach_bearing_source IN ('authored', 'derived'));

ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_bearing_policy_needs_bearing_check
        CHECK (bearing_policy = 'ignore' OR approach_bearing_deg IS NOT NULL),
    ADD CONSTRAINT waypoints_bearing_source_pairing_check
        CHECK ((approach_bearing_deg IS NULL) = (approach_bearing_source IS NULL));

COMMENT ON COLUMN public.waypoints.chapter_id IS
    'The chapter this audio trigger belongs to; always a chapter of the same tour (waypoints_chapter_same_tour_fkey). On INSERT, NULL means "the tour''s only chapter" (waypoints_default_chapter).';
COMMENT ON COLUMN public.waypoints.approach_bearing_deg IS
    'Direction of travel, degrees clockwise from true north, that should fire this stop. Used only when bearing_policy <> ''ignore''.';

-- -----------------------------------------------------------------------------
-- 4. Backfill: one chapter per tour
--
-- The chapter's id is the tour's id. Deliberate: a device holding a manifest
-- saved before this migration has no chapter list and synthesises one, and it
-- can only name it after something it has - the tour id. With the server using
-- the same id, that synthesised chapter IS the server's chapter, so a resumed
-- session checkpoint and telemetry agree on it whichever manifest is loaded.
--
-- title NULL, defaults for policy/lookahead, no destination: exactly the
-- "plain" chapter that leaves bundle_version_hash unchanged.
-- -----------------------------------------------------------------------------
INSERT INTO public.tour_chapters (id, tour_id, sort_order, title, transit_mode)
SELECT t.id, t.id, 0, NULL, t.transit_mode
  FROM public.tours t
 WHERE NOT EXISTS (SELECT 1 FROM public.tour_chapters c WHERE c.tour_id = t.id);

UPDATE public.waypoints w
   SET chapter_id = w.tour_id
 WHERE w.chapter_id IS NULL;

-- Fails loudly if any waypoint was missed (tour_id is NOT NULL since TASK-301,
-- so none can be).
ALTER TABLE public.waypoints ALTER COLUMN chapter_id SET NOT NULL;

-- NO ACTION, not RESTRICT and not CASCADE:
--   * not CASCADE - deleting a chapter must never silently delete its stops'
--     audio rows (the storage objects would be orphaned with no report);
--     cms_replace_tour_chapters refuses with a readable message instead.
--   * not RESTRICT - deleting a TOUR cascades to both waypoints and chapters
--     in one statement. NO ACTION checks at the end of that statement, after
--     both cascades; RESTRICT checks immediately and could fire mid-cascade.
ALTER TABLE public.waypoints
    ADD CONSTRAINT waypoints_chapter_same_tour_fkey
        FOREIGN KEY (chapter_id, tour_id)
        REFERENCES public.tour_chapters (id, tour_id);

CREATE INDEX IF NOT EXISTS idx_waypoints_chapter_id ON public.waypoints (chapter_id);

-- -----------------------------------------------------------------------------
-- 5. Invariants
--
-- 5a. Every tour is born with one chapter.
--     Keeps every existing write path working unchanged: cms_upsert_tour, the
--     two seed files, backend/scripts/seed-tel-aviv-qa.ts and verify-bundle's
--     probes all INSERT a tour and then its waypoints.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tours_create_default_chapter()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
BEGIN
    INSERT INTO public.tour_chapters (id, tour_id, sort_order, title, transit_mode)
    VALUES (NEW.id, NEW.id, 0, NULL, NEW.transit_mode);
    RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.tours_create_default_chapter() IS
    'Epic 15: a new tour gets one plain chapter whose id is the tour id, so pre-chapter write paths (seeds, CMS) keep working.';

CREATE TRIGGER trg_tours_create_default_chapter
    AFTER INSERT ON public.tours
    FOR EACH ROW EXECUTE FUNCTION public.tours_create_default_chapter();

-- -----------------------------------------------------------------------------
-- 5b. A waypoint inserted without a chapter joins the tour's ONLY chapter.
--     With two or more chapters the caller must choose - refused, not guessed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.waypoints_default_chapter()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
DECLARE
    v_count int;
    v_only  uuid;
BEGIN
    SELECT count(*), min(c.id::text)::uuid
      INTO v_count, v_only
      FROM public.tour_chapters c
     WHERE c.tour_id = NEW.tour_id;

    IF v_count <> 1 THEN
        RAISE EXCEPTION 'Waypoint "%" names no chapter, and tour % has % chapters; set chapter_id.',
            NEW.name, NEW.tour_id, v_count
            USING ERRCODE = '23502';
    END IF;

    NEW.chapter_id := v_only;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_waypoints_default_chapter
    BEFORE INSERT ON public.waypoints
    FOR EACH ROW
    WHEN (NEW.chapter_id IS NULL)
    EXECUTE FUNCTION public.waypoints_default_chapter();

-- -----------------------------------------------------------------------------
-- 5c. tours.transit_mode is DERIVED: the most demanding chapter mode.
--
-- Kept, not dropped, because TestFlight build 10 selects it for Discovery and
-- runs a whole tour on it, and route-stops validates against it. Dropping it is
-- a later contract migration, once no build older than Epic 15 is in use.
--
-- "Most demanding" (driving > biking > walking) rather than "first chapter":
-- the Discovery badge answers "what do I need to bring" - a Drive -> Walk ->
-- Drive tour needs a car. An old build running such a tour is wrong either
-- way; do not publish a multi-chapter tour while build 10 is in testers' hands.
--
-- A plain single-chapter tour's mode is its chapter's mode, which is what
-- keeps tr.transit_mode in bundle_version_hash byte-identical.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tour_transit_mode_from_chapters(p_tour_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions
AS $fn$
    SELECT CASE
             WHEN bool_or(c.transit_mode = 'driving') THEN 'driving'
             WHEN bool_or(c.transit_mode = 'biking')  THEN 'biking'
             WHEN count(*) > 0                         THEN 'walking'
           END
      FROM public.tour_chapters c
     WHERE c.tour_id = p_tour_id;
$fn$;

COMMENT ON FUNCTION public.tour_transit_mode_from_chapters(uuid) IS
    'The value tours.transit_mode must hold: the most demanding mode among the tour''s chapters (driving > biking > walking), or NULL when it has none.';

-- Mirror: chapters -> tours. Skips when the tour has no chapters left, which is
-- the state during a tour DELETE's cascade - updating the tour row the same
-- statement is deleting would raise instead.
CREATE OR REPLACE FUNCTION public.sync_tour_transit_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
DECLARE
    v_tour    uuid;
    v_derived text;
BEGIN
    FOREACH v_tour IN ARRAY ARRAY[
        CASE WHEN TG_OP <> 'INSERT' THEN OLD.tour_id END,
        CASE WHEN TG_OP <> 'DELETE' THEN NEW.tour_id END
    ]
    LOOP
        CONTINUE WHEN v_tour IS NULL;
        v_derived := public.tour_transit_mode_from_chapters(v_tour);
        CONTINUE WHEN v_derived IS NULL;
        UPDATE public.tours t
           SET transit_mode = v_derived
         WHERE t.id = v_tour
           AND t.transit_mode IS DISTINCT FROM v_derived;
    END LOOP;
    RETURN NULL;
END;
$fn$;

CREATE TRIGGER trg_tour_chapters_sync_tour_transit_mode
    AFTER INSERT OR DELETE OR UPDATE OF transit_mode, tour_id ON public.tour_chapters
    FOR EACH ROW EXECUTE FUNCTION public.sync_tour_transit_mode();

-- Guard: tours -> refuse. A direct write (Studio, a script, an old CMS build on
-- a multi-chapter tour) that disagrees with the chapters fails loudly instead
-- of leaving a badge that contradicts the content. The mirror's own UPDATE
-- always writes the derived value, so it passes.
CREATE OR REPLACE FUNCTION public.guard_tour_transit_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $fn$
DECLARE
    v_derived text;
BEGIN
    v_derived := public.tour_transit_mode_from_chapters(NEW.id);
    IF v_derived IS NOT NULL AND NEW.transit_mode IS DISTINCT FROM v_derived THEN
        RAISE EXCEPTION 'tours.transit_mode is derived from the tour''s chapters (%); set tour_chapters.transit_mode instead of writing %.',
            v_derived, NEW.transit_mode
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$fn$;

CREATE TRIGGER trg_tours_guard_transit_mode
    BEFORE UPDATE OF transit_mode ON public.tours
    FOR EACH ROW
    WHEN (OLD.transit_mode IS DISTINCT FROM NEW.transit_mode)
    EXECUTE FUNCTION public.guard_tour_transit_mode();

COMMENT ON COLUMN public.tours.transit_mode IS
    'DERIVED since Epic 15: the most demanding of the tour''s chapter modes, kept for pre-Epic-15 apps. Write tour_chapters.transit_mode; a disagreeing write here is refused (trg_tours_guard_transit_mode).';

-- -----------------------------------------------------------------------------
-- 5d. updated_at, as on every other content table.
-- -----------------------------------------------------------------------------
CREATE TRIGGER trg_tour_chapters_updated_at
    BEFORE UPDATE ON public.tour_chapters
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_chapter_route_anchors_updated_at
    BEFORE UPDATE ON public.chapter_route_anchors
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 6. RLS - public-content pattern (visibility follows tours.status) plus the
--    admin pattern. No identity-based read. See 20260827140000.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chapter_is_published(p_chapter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
    SELECT EXISTS (
        SELECT 1
          FROM public.tour_chapters c
          JOIN public.tours t ON t.id = c.tour_id
         WHERE c.id = p_chapter_id
           AND t.status = 'published'
    );
$fn$;

REVOKE ALL ON FUNCTION public.chapter_is_published(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chapter_is_published(uuid) TO anon, authenticated;

ALTER TABLE public.tour_chapters         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_route_anchors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tour_chapters_read_published"
    ON public.tour_chapters FOR SELECT
    TO anon, authenticated
    USING (public.tour_is_published(tour_id));

CREATE POLICY "tour_chapters_admin_write"
    ON public.tour_chapters FOR ALL
    TO authenticated
    USING      ((SELECT public.is_cms_admin()))
    WITH CHECK ((SELECT public.is_cms_admin()));

CREATE POLICY "chapter_route_anchors_read_published"
    ON public.chapter_route_anchors FOR SELECT
    TO anon, authenticated
    USING (public.chapter_is_published(chapter_id));

CREATE POLICY "chapter_route_anchors_admin_write"
    ON public.chapter_route_anchors FOR ALL
    TO authenticated
    USING      ((SELECT public.is_cms_admin()))
    WITH CHECK ((SELECT public.is_cms_admin()));
