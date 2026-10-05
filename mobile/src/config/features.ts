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
