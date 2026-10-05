/**
 * Compile-time feature flags. A flag that is false removes the feature's ENTRY
 * POINTS and its routes from the build, so merged-but-unfinished work ships
 * dark: the code is integrated and type-checked on main, and no visitor can
 * reach it.
 */

/**
 * Epic 16 planner (Plan my day, saved plans). OFF until the session
 * controller can run a plan (PM, 5 Oct 2026): a visitor must never save a plan
 * they cannot start. Gates the Discovery entry, the "Your plans" list and the
 * Plan / PlanPreview routes.
 */
export const IS_PLANNING_ENABLED = false;

/**
 * Migration 20261009120000 (telemetry_events.plan_id + 'handoff_tracking_late')
 * is applied to production. Until it was, TelemetryService sent neither: one
 * row the server refuses fails its whole batch (all-or-nothing PostgREST
 * insert). LIVE since 6 Oct 2026 - the migration is in production (supabase
 * migration list) and its generated types match the production schema.
 */
export const TELEMETRY_PLAN_FIELDS_LIVE = true;

/**
 * Migration 20261010120100 ('navigation_handoff') is applied to production.
 * Until then TelemetryService refuses the event before queueing it (a type
 * the server's CHECK lacks fails its whole batch). Flip only AFTER the push.
 */
export const TELEMETRY_HANDOFF_EVENT_LIVE = false;
