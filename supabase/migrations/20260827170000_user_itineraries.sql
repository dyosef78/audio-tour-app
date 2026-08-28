-- =============================================================================
-- TASK-304 (1 of 2) : User itineraries - local-first cloud sync
--
-- STATUS: DRAFT - awaiting approval. Do not push.
--
-- A tourist plans a trip on the web at home and finds it on their phone in the
-- Old City. That is the whole feature, and it is a SYNC problem rather than a
-- storage problem - which is what most of the design below is about.
--
-- !! THIS TABLE CHANGES WHO `authenticated` IS !!
--
-- Until now this project had no end-user accounts. TASK-302 turned signup OFF
-- precisely because an open `authenticated` role, combined with an anon key
-- that ships in the app, meant the role was worth nothing.
--
-- Tourist SSO reverses that: anyone with a Google or Apple account will hold an
-- `authenticated` JWT. The role is public again, by design this time.
--
-- The TASK-302 posture survives that unchanged, and deliberately so - admin
-- authority comes from app_admins membership, never from the role. Every policy
-- written since is scoped either to is_cms_admin() or to auth.uid(). Nothing in
-- this migration relaxes that, and nothing should.
--
-- See the handover report: enabling SSO requires turning enable_signup back on,
-- which is a real config change with a real blast radius.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1. user_itineraries
--
-- SOFT DELETE IS NOT OPTIONAL HERE.
--
-- The client is offline-first, so deletions happen on a device with no
-- connection and sync later. With hard deletes there is no way to tell "the
-- server has never seen this row" from "the user deleted this row" - so a naive
-- sync resurrects everything the user removed while they were offline. A
-- deleted_at timestamp is the smallest thing that makes deletion a fact the
-- server can hold and replicate.
--
-- The cost is that rows accumulate. A purge of rows soft-deleted more than ~90
-- days ago is safe once every client has certainly seen the tombstone; that is
-- a scheduled job, not schema, and it is flagged rather than built.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_itineraries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    tour_id     uuid NOT NULL REFERENCES public.tours(id) ON DELETE CASCADE,

    -- The user's own label. Optional: most people save a tour without renaming
    -- it, and forcing a title would make the common case worse.
    title       text,
    planned_for date,
    notes       text,

    -- Sync bookkeeping.
    deleted_at  timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT user_itineraries_title_len CHECK (title IS NULL OR length(title) <= 200),
    CONSTRAINT user_itineraries_notes_len CHECK (notes IS NULL OR length(notes) <= 4000)
);

COMMENT ON TABLE public.user_itineraries IS
    'A user''s saved plan for a tour. Owner-only under RLS. Soft-deleted rather than deleted, because an offline-first client cannot otherwise distinguish "never synced" from "deleted while offline".';

COMMENT ON COLUMN public.user_itineraries.deleted_at IS
    'Tombstone. Non-null means the user deleted this; the row is retained so the deletion can propagate to their other devices. Clients must filter on deleted_at IS NULL.';

COMMENT ON COLUMN public.user_itineraries.updated_at IS
    'Server-side change marker, maintained by trigger. This is the column a client passes as its "changed since" cursor when pulling; see the handover report on why the client''s own clock must not be trusted for this.';

-- One live itinerary per user per tour. PARTIAL on deleted_at IS NULL so that a
-- user who removes a tour can add it back - a plain UNIQUE would make the
-- tombstone permanently block re-saving.
CREATE UNIQUE INDEX IF NOT EXISTS user_itineraries_user_tour_live_key
    ON public.user_itineraries (user_id, tour_id)
    WHERE deleted_at IS NULL;

-- The pull query: "everything of mine that changed since X".
CREATE INDEX IF NOT EXISTS idx_user_itineraries_sync
    ON public.user_itineraries (user_id, updated_at);

CREATE TRIGGER trg_user_itineraries_updated_at
    BEFORE UPDATE ON public.user_itineraries
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. user_itinerary_waypoints
--
-- Per-waypoint choices within a plan: skip the museum, reorder two stops. Kept
-- as a child table rather than a jsonb blob on the itinerary so that a waypoint
-- deleted by the CMS cascades out of everyone's plans instead of leaving a
-- dangling id inside a document nothing validates.
--
-- sort_order is nullable and means "the tour's own order". Only rows the user
-- actually moved need a value, so an untouched plan stores nothing.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_itinerary_waypoints (
    itinerary_id uuid NOT NULL REFERENCES public.user_itineraries(id) ON DELETE CASCADE,
    waypoint_id  uuid NOT NULL REFERENCES public.waypoints(id) ON DELETE CASCADE,
    included     boolean NOT NULL DEFAULT true,
    sort_order   int,
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (itinerary_id, waypoint_id)
);

COMMENT ON TABLE public.user_itinerary_waypoints IS
    'Per-waypoint overrides within an itinerary. Rows exist only for waypoints the user changed; absence means "as the tour defines it".';

CREATE TRIGGER trg_user_itinerary_waypoints_updated_at
    BEFORE UPDATE ON public.user_itinerary_waypoints
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. RLS
--
-- Owner-only, both directions. Two details do the work:
--
--   USING       controls which rows are visible and updatable.
--   WITH CHECK  controls what a row may become.
--
-- Without WITH CHECK on user_id, a user could UPDATE their own row and set
-- user_id to someone else's - handing over a row they no longer own, or
-- planting content in another account. USING alone does not prevent that,
-- because the row is theirs at the moment the update is evaluated.
--
-- auth.uid() is wrapped in a scalar subquery so the planner hoists it into an
-- InitPlan rather than calling it per row - the same fix as TASK-302.
-- -----------------------------------------------------------------------------
ALTER TABLE public.user_itineraries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_itinerary_waypoints  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_itineraries_owner_select"
    ON public.user_itineraries FOR SELECT
    TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- INSERT is gated on publication as well as ownership: a user should not be
-- able to save a draft tour, even holding a uuid from somewhere. Existing rows
-- are NOT re-checked if a tour is later unpublished - the plan stays in their
-- account and the tour simply stops resolving, which is the kinder behaviour.
CREATE POLICY "user_itineraries_owner_insert"
    ON public.user_itineraries FOR INSERT
    TO authenticated
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND public.tour_is_published(tour_id)
    );

CREATE POLICY "user_itineraries_owner_update"
    ON public.user_itineraries FOR UPDATE
    TO authenticated
    USING      (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

-- No DELETE policy, deliberately. Deletion goes through deleted_at so the
-- tombstone can sync; a hard DELETE would be invisible to the user's other
-- devices. RLS denying by default is what enforces that.

CREATE POLICY "user_itinerary_waypoints_owner_all"
    ON public.user_itinerary_waypoints FOR ALL
    TO authenticated
    USING (
        EXISTS (SELECT 1 FROM public.user_itineraries i
                 WHERE i.id = itinerary_id AND i.user_id = (SELECT auth.uid()))
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.user_itineraries i
                 WHERE i.id = itinerary_id AND i.user_id = (SELECT auth.uid()))
    );

-- -----------------------------------------------------------------------------
-- 4. Sync helper
--
-- The pull half of sync: everything of mine that changed since a cursor,
-- tombstones included. Tombstones are the point - a client that filters them
-- out server-side can never learn about a deletion.
--
-- The cursor is server updated_at, never a client timestamp. Device clocks are
-- wrong, sometimes by years, and a client-supplied cursor that runs ahead of
-- the server silently skips rows forever.
--
-- Callers should re-request with the returned server_time as the next cursor.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_pull_itineraries(p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions
AS $fn$
    SELECT jsonb_build_object(
        -- The next cursor. Taken from the server so the client never has to
        -- guess, and so a wrong device clock cannot advance it.
        'server_time', now(),
        'itineraries', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'id',          i.id,
                       'tour_id',     i.tour_id,
                       'title',       i.title,
                       'planned_for', i.planned_for,
                       'notes',       i.notes,
                       'deleted_at',  i.deleted_at,
                       'updated_at',  i.updated_at,
                       'waypoints', coalesce((
                           SELECT jsonb_agg(jsonb_build_object(
                                      'waypoint_id', iw.waypoint_id,
                                      'included',    iw.included,
                                      'sort_order',  iw.sort_order))
                           FROM public.user_itinerary_waypoints iw
                           WHERE iw.itinerary_id = i.id
                       ), '[]'::jsonb)))
            FROM public.user_itineraries i
            WHERE i.user_id = (SELECT auth.uid())
              AND (p_since IS NULL OR i.updated_at > p_since)
        ), '[]'::jsonb)
    );
$fn$;

COMMENT ON FUNCTION public.sync_pull_itineraries(timestamptz) IS
    'Pull half of itinerary sync: rows changed since a cursor, tombstones included, plus a server_time to use as the next cursor. Runs as the caller, so RLS scopes it to their own rows.';

REVOKE ALL ON FUNCTION public.sync_pull_itineraries(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_pull_itineraries(timestamptz) TO authenticated;
