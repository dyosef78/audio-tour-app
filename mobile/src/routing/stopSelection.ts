import type { Waypoint } from '../types/domain';

/**
 * Which stops a session runs (Epic 16). Replaces TASK-604's selectStops.
 *
 * Pure. A CATALOGUE session - a tour started from Discovery - runs every core
 * stop, transitions included, in authored sort_order, and nothing else
 * (PM, 2 + 4 Oct 2026):
 *
 *   * Extensions never run here. They exist for planner bundles, and the
 *     narrative is authored so that core stands alone without them
 *     (cms_validate_tour: a transition connects core to core).
 *   * Onboarding preferences no longer remove stops. TASK-604 filtered by tag,
 *     which could drop a core stop while keeping the transition that walks you
 *     to it. Core means core; personalisation is the planner's job.
 *
 * A planned session will add a `{ kind: 'plan' }` mode here, so the engine
 * keeps one entry point for "which stops run".
 */

export type SessionMode = { kind: 'catalogue' };

export interface SessionStops {
  /** The stops this session runs, in authored sort_order. */
  active: Waypoint[];
  /** Extensions present in the bundle that this session never arms. Not "skipped": never part of it. */
  excludedIds: string[];
}

/**
 * @throws RangeError on a bundle that breaks a server invariant - a
 *   transition marked as an extension (waypoints_transition_is_core_check), or
 *   no core stop at all. The caller refuses to start; running a tour that is
 *   not the authored one is worse than not running it.
 */
export function sessionStops(waypoints: readonly Waypoint[], mode: SessionMode): SessionStops {
  const sorted = [...waypoints].sort((a, b) => a.sortOrder - b.sortOrder);

  const optionalTransition = sorted.find((w) => w.poiType === 'transition' && w.stopRole === 'extension');
  if (optionalTransition) {
    throw new RangeError(`transition ${optionalTransition.id} is marked as an extension; transitions are always core`);
  }

  switch (mode.kind) {
    case 'catalogue': {
      const active = sorted.filter((w) => w.stopRole === 'core');
      if (active.length === 0) throw new RangeError('the tour has no core stops');
      return { active, excludedIds: sorted.filter((w) => w.stopRole !== 'core').map((w) => w.id) };
    }
  }
}
