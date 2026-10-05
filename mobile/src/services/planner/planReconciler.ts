import type { PlanTourOk } from '../../../../shared/src/contracts/planTour.ts';
import { planProblem } from '../../engine/fromPlan.ts';
import type { WireBundle } from '../bundle/types.ts';
import type { PlanRepository, SavedPlan } from './planRepository.ts';

/**
 * Plan reconciliation (Epic 16, PM 5 Oct 2026): compare what the plan store
 * SAYS with what the bundle directory HOLDS, and correct the store.
 *
 * Two stores, no transaction between them: saved-plans.json (planRepository)
 * and the bundle directories (TourBundleRepository). Each is atomic on its
 * own; a crash or a kill between two of their writes leaves a pair that the
 * sequential code never produces. This is the one place that repairs it.
 *
 *   saved plan, every pin on disk and the plan fits the bundles  -> correct
 *   saved plan, a pin missing or another version on disk          -> REMOVE
 *       It cannot run, and nothing can bring that version back (the server
 *       serves only the current bundle). TourBundleRepository deletes plans
 *       BEFORE the bundle they pin, so this is never the normal path - it is
 *       external damage or a bug, and it is logged as such.
 *   saved plan, pins match but the plan no longer fits the bundle -> REMOVE
 *   draft WITH a download intent, every pin verified              -> MARK SAVED
 *       The download finished; the save after it was lost (a kill between
 *       the last bundle's rename and markSaved).
 *   draft with an intent, download incomplete                     -> nothing
 *       PlanPreview offers to resume; staged bytes are kept.
 *   draft WITHOUT an intent                                       -> nothing,
 *       even when its tours happen to be on disk: a plan the visitor only
 *       previewed must never start pinning tours on its own.
 *
 * Pure: the store and the disk arrive as arguments. Idempotent: a second run
 * over its own output finds nothing to do.
 */

export interface DiskView {
  /** The bundle on disk for this tour, or null (absent or unreadable). */
  manifest(tourId: string): WireBundle | null;
}

export type PlanDiskState =
  | { kind: 'complete' }
  | { kind: 'missing'; tourIds: string[] }
  | { kind: 'changed'; tourIds: string[] }
  | { kind: 'invalid'; problem: string };

export type ReconcileAction =
  | { kind: 'mark_saved'; planId: string }
  | { kind: 'remove'; planId: string; reason: 'bundle_missing' | 'bundle_changed' | 'plan_invalid'; detail: string };

/** Where one plan stands against the disk. Missing outranks changed outranks invalid. */
function planDiskState(plan: PlanTourOk, manifest: (tourId: string) => WireBundle | null): PlanDiskState {
  const missing: string[] = [];
  const changed: string[] = [];
  const manifests = new Map<string, WireBundle>();
  for (const s of plan.sources) {
    const m = manifest(s.tour_id);
    if (m === null) missing.push(s.tour_id);
    else if (m.bundle_version_hash !== s.bundle_version_hash) changed.push(s.tour_id);
    else manifests.set(s.tour_id, m);
  }
  if (missing.length > 0) return { kind: 'missing', tourIds: missing };
  if (changed.length > 0) return { kind: 'changed', tourIds: changed };
  const problem = planProblem(plan, manifests);
  return problem === null ? { kind: 'complete' } : { kind: 'invalid', problem };
}

export function reconcileActions(plans: readonly SavedPlan[], disk: DiskView): ReconcileAction[] {
  // One parse per tour per run, however many plans share it.
  const cache = new Map<string, WireBundle | null>();
  const manifest = (tourId: string) => {
    if (!cache.has(tourId)) cache.set(tourId, disk.manifest(tourId));
    return cache.get(tourId)!;
  };

  const actions: ReconcileAction[] = [];
  for (const p of plans) {
    const planId = p.plan.plan_id;
    if (p.status === 'draft' && p.downloadRequestedAt === null) continue;
    const state = planDiskState(p.plan, manifest);
    if (p.status === 'draft') {
      if (state.kind === 'complete') actions.push({ kind: 'mark_saved', planId });
      continue;
    }
    switch (state.kind) {
      case 'complete':
        break;
      case 'missing':
        actions.push({ kind: 'remove', planId, reason: 'bundle_missing', detail: `no bundle on disk for ${state.tourIds.join(', ')}` });
        break;
      case 'changed':
        actions.push({ kind: 'remove', planId, reason: 'bundle_changed', detail: `another version on disk for ${state.tourIds.join(', ')}` });
        break;
      case 'invalid':
        actions.push({ kind: 'remove', planId, reason: 'plan_invalid', detail: state.problem });
        break;
    }
  }
  // Removals first: a promotion must never be judged against a plan about to go.
  return [...actions.filter((a) => a.kind === 'remove'), ...actions.filter((a) => a.kind === 'mark_saved')];
}

export interface ReconcileReport {
  actions: ReconcileAction[];
}

/** Compute and apply. Every correction is logged: each one means two stores disagreed. */
export function reconcilePlans(repo: Pick<PlanRepository, 'list' | 'remove' | 'markSaved'>, disk: DiskView, log: (msg: string) => void): ReconcileReport {
  const actions = reconcileActions(repo.list(), disk);
  const removals = actions.filter((a): a is Extract<ReconcileAction, { kind: 'remove' }> => a.kind === 'remove');
  for (const r of removals) log(`[PlanReconciler] removing saved plan ${r.planId}: ${r.reason} (${r.detail})`);
  if (removals.length > 0) repo.remove(removals.map((r) => r.planId));
  for (const a of actions) {
    if (a.kind !== 'mark_saved') continue;
    log(`[PlanReconciler] plan ${a.planId}: download had completed, marking saved`);
    repo.markSaved(a.planId);
  }
  return { actions };
}
