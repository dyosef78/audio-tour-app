import type { PlanTourOk } from '../../../../shared/src/contracts/planTour.ts';
import type { PlanDownloadOutcome } from './planDownload.ts';
import type { PlanRepository } from './planRepository.ts';

/**
 * Plan downloads as JOBS owned by the app, not by a screen (Epic 16, PM 5 Oct
 * 2026: no correctness may depend on a component staying mounted).
 *
 * Before: PlanPreviewScreen ran the download and marked the plan saved when
 * it finished. Leaving the screen stopped the sequence between tours; coming
 * back offered a second "Download & save" that could run the same tour's
 * download twice into one staging directory.
 *
 * Now, per plan id, at most ONE job:
 *   start()   records the intent durably (requestDownload - write-ahead, so a
 *             crash is recoverable by planReconciler), then runs the download
 *             to its outcome whatever the UI does. A second start() while it
 *             runs returns the SAME promise.
 *   ready     -> markSaved here, mounted screen or not. Unless the draft was
 *             replaced meanwhile (Back, then a new plan): logged, not saved.
 *   others    -> kept as the job's outcome until a screen take()s it, so a
 *             conflict or a stale plan that lands while nobody is looking is
 *             shown on the next visit instead of being lost.
 *
 * What it does NOT survive: the process. A kill mid-job leaves the intent and
 * the staged bytes; planReconciler promotes a draft whose bundles all landed,
 * and the next start() resumes the rest.
 */

export type JobRunner = (plan: PlanTourOk, agreed: readonly string[], onProgress: (fraction: number) => void) => Promise<PlanDownloadOutcome>;

export interface PlanJobView {
  running: boolean;
  /** 0..1 while running. */
  fraction: number;
  /** The last finished run's outcome, until take()n. `ready` is never kept: the plan's status says it. */
  outcome: Exclude<PlanDownloadOutcome, { kind: 'ready' }> | null;
}

export interface PlanDownloadJobs {
  start(planId: string, agreed?: readonly string[]): Promise<PlanDownloadOutcome>;
  view(planId: string): PlanJobView;
  /** Hand the pending outcome to the caller and forget it. */
  take(planId: string): PlanJobView['outcome'];
  subscribe(listener: () => void): () => void;
}

const IDLE: PlanJobView = { running: false, fraction: 0, outcome: null };

export function createPlanDownloadJobs(deps: {
  repo: Pick<PlanRepository, 'get' | 'markSaved' | 'requestDownload'>;
  run: JobRunner;
  now(): number;
  log(msg: string): void;
}): PlanDownloadJobs {
  const running = new Map<string, Promise<PlanDownloadOutcome>>();
  const views = new Map<string, PlanJobView>();
  const listeners = new Set<() => void>();

  // A new object per change: useSyncExternalStore compares snapshots by identity.
  const set = (planId: string, patch: Partial<PlanJobView>) => {
    views.set(planId, { ...(views.get(planId) ?? IDLE), ...patch });
    for (const l of [...listeners]) l();
  };

  function finish(planId: string, outcome: PlanDownloadOutcome): PlanDownloadOutcome {
    if (outcome.kind === 'ready') {
      const entry = deps.repo.get(planId);
      if (entry === null) deps.log(`[PlanDownloads] plan ${planId} was replaced while downloading; not saving it`);
      else deps.repo.markSaved(planId);
      set(planId, { running: false, fraction: 1, outcome: null });
    } else {
      set(planId, { running: false, outcome });
    }
    return outcome;
  }

  return {
    start(planId, agreed = []) {
      const existing = running.get(planId);
      if (existing) return existing;
      const entry = deps.repo.get(planId);
      if (entry === null) throw new RangeError(`no plan ${planId}`);
      if (entry.status === 'saved') return Promise.resolve({ kind: 'ready' });

      // Durable BEFORE the first byte: the reconciler's evidence that this
      // draft was meant to be kept.
      deps.repo.requestDownload(planId, deps.now());
      set(planId, { running: true, fraction: 0, outcome: null });

      const job = deps
        .run(entry.plan, agreed, (fraction) => set(planId, { fraction }))
        // The runner reports expected failures as outcomes; a throw here is a
        // bug in it. Surfaced as a failed outcome AND logged - never a hung job.
        .catch((err: unknown): PlanDownloadOutcome => {
          const message = err instanceof Error ? err.message : String(err);
          deps.log(`[PlanDownloads] plan ${planId}: the download runner threw: ${message}`);
          return { kind: 'failed', tourId: '', message };
        })
        .then((outcome) => {
          // Forgotten BEFORE anyone hears the outcome: a listener that starts
          // again (Overwrite, Try again) must get a new job, not this one.
          running.delete(planId);
          return finish(planId, outcome);
        });
      running.set(planId, job);
      return job;
    },
    view: (planId) => views.get(planId) ?? IDLE,
    take(planId) {
      const v = views.get(planId);
      if (!v?.outcome) return null;
      set(planId, { outcome: null });
      return v.outcome;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
