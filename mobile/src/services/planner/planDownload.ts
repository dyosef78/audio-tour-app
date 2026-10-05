import type { PlanTourOk } from '../../../../shared/src/contracts/planTour.ts';
import { planProblem } from '../../engine/fromPlan.ts';
import type { WireBundle } from '../bundle/types.ts';
import { PinnedBundleError, type PinHolder } from './planRepository.ts';

/**
 * Bring every bundle a plan pins onto the device at EXACTLY the pinned version
 * (Epic 16 final slice). Pure orchestration; the real download and the pin
 * index arrive through PlanDownloadDeps.
 *
 * Per source tour, in plan order:
 *   already at the pinned version  -> nothing to do
 *   another saved plan pins another version -> `conflict`, BEFORE downloading:
 *     the caller asks the visitor (pinConflictCopy 'new_plan') and calls again
 *     with those plan ids in invalidatePlans
 *   otherwise download the CURRENT published bundle; if that is not the pinned
 *     version, the tour changed since planning -> `stale`: the caller re-plans
 *     ONCE (a busy CMS must not trap the visitor in a loop)
 * Then planProblem() checks the whole plan against the bundles on disk; only
 * `ready` lets the caller mark the plan saved (which is what makes it pin).
 */

export interface PlanDownloadDeps {
  /** bundle_version_hash of the tour on the device, or null when absent. */
  localHash(tourId: string): string | null;
  download(tourId: string, options: { invalidatePlans?: readonly string[]; onProgress?: (fraction: number) => void }): Promise<{ bundle_version_hash: string }>;
  blockingPlans(tourId: string, toHash: string | null): PinHolder[];
  manifest(tourId: string): WireBundle | null;
}

export type PlanDownloadOutcome =
  | { kind: 'ready' }
  | { kind: 'conflict'; tourId: string; blocking: PinHolder[] }
  | { kind: 'stale'; tourId: string }
  | { kind: 'invalid'; problem: string }
  | { kind: 'failed'; tourId: string; message: string };

export interface PlanDownloadOptions {
  /** Plans (excluding this one) the visitor agreed to overwrite. */
  invalidatePlans?: readonly string[];
  /** Overall progress 0..1 across every tour still to fetch. */
  onProgress?: (fraction: number, tourId: string) => void;
}

export async function downloadPlanBundles(plan: PlanTourOk, deps: PlanDownloadDeps, options: PlanDownloadOptions = {}): Promise<PlanDownloadOutcome> {
  const agreed = new Set(options.invalidatePlans ?? []);
  const todo = plan.sources.filter((s) => deps.localHash(s.tour_id) !== s.bundle_version_hash);

  for (const [i, source] of todo.entries()) {
    // This plan itself is still a draft and pins nothing, so it never blocks itself.
    const blocking = deps.blockingPlans(source.tour_id, source.bundle_version_hash).filter((b) => b.planId !== plan.plan_id);
    const unagreed = blocking.filter((b) => !agreed.has(b.planId));
    if (unagreed.length > 0) return { kind: 'conflict', tourId: source.tour_id, blocking: unagreed };

    let got: { bundle_version_hash: string };
    try {
      got = await deps.download(source.tour_id, {
        invalidatePlans: [...agreed],
        onProgress: (f) => options.onProgress?.((i + f) / todo.length, source.tour_id),
      });
    } catch (cause) {
      // The server bundle moved on AND another plan pins the old one: still a conflict to ask about.
      if (cause instanceof PinnedBundleError) return { kind: 'conflict', tourId: source.tour_id, blocking: [...cause.blocking] };
      return { kind: 'failed', tourId: source.tour_id, message: cause instanceof Error ? cause.message : String(cause) };
    }
    if (got.bundle_version_hash !== source.bundle_version_hash) return { kind: 'stale', tourId: source.tour_id };
  }

  const manifests = new Map<string, WireBundle>();
  for (const s of plan.sources) {
    const m = deps.manifest(s.tour_id);
    if (m) manifests.set(s.tour_id, m);
  }
  const problem = planProblem(plan, manifests);
  if (problem !== null) return { kind: 'invalid', problem };
  options.onProgress?.(1, plan.sources[plan.sources.length - 1]!.tour_id);
  return { kind: 'ready' };
}
