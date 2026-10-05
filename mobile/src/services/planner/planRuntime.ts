import { useLayoutEffect, useState, useSyncExternalStore } from 'react';

import { TourBundleRepository } from '../bundle/TourBundleRepository';
import { downloadPlanBundles, type PlanDownloadDeps } from './planDownload';
import { createPlanDownloadJobs, type PlanJobView } from './planDownloadJobs';
import { reconcilePlans, type DiskView, type ReconcileReport } from './planReconciler';
import { savedPlans } from './planRepositoryFile';

/**
 * The planner's app-wide runtime (Epic 16): the one download-job registry and
 * the reconciler, wired to the real bundle directory and plan file.
 */

const downloadDeps: PlanDownloadDeps = {
  localHash: (tourId) => TourBundleRepository.readManifest(tourId)?.bundle_version_hash ?? null,
  download: (tourId, o) =>
    TourBundleRepository.download(tourId, {
      invalidatePlans: o.invalidatePlans,
      onProgress: (p) => o.onProgress?.(p.fraction),
    }),
  blockingPlans: (tourId, toHash) => savedPlans.blockingPlans(tourId, toHash),
  manifest: (tourId) => TourBundleRepository.readManifest(tourId),
};

export const planDownloads = createPlanDownloadJobs({
  repo: savedPlans,
  run: (plan, agreed, onProgress) => downloadPlanBundles(plan, downloadDeps, { invalidatePlans: agreed, onProgress }),
  now: Date.now,
  log: (m) => console.warn(m),
});

/** A plan's download job, live. */
export function usePlanDownload(planId: string): PlanJobView {
  return useSyncExternalStore(planDownloads.subscribe, () => planDownloads.view(planId));
}

const disk: DiskView = { manifest: (tourId) => TourBundleRepository.readManifest(tourId) };

/**
 * Reconcile the plan store with the bundles on disk, once, as the screen
 * mounts. A layout effect: it lands before the first paint, so a plan the
 * reconciler removes or promotes is never drawn in its stale state - and it
 * is not render-phase, where updating the store would update other mounted
 * screens mid-render. Synchronous (manifest reads are sync file reads, one
 * parse per tour).
 */
export function usePlanReconciler(): ReconcileReport | null {
  const [report, setReport] = useState<ReconcileReport | null>(null);
  useLayoutEffect(() => {
    setReport(reconcilePlans(savedPlans, disk, (m) => console.warn(m)));
  }, []);
  return report;
}
