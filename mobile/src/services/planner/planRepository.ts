import { parsePlanTourOk, type PlanTourOk, type PlanTourRequest } from '../../../../shared/src/contracts/planTour.ts';

/**
 * Saved plans and the PINS they hold on downloaded tours (Epic 16 final slice).
 *
 * A plan is built against exact bundle versions (`sources[].bundle_version_hash`).
 * Once SAVED - every pinned bundle verified on this device - it pins those
 * versions: replacing or removing one of those tours would break it.
 * TourBundleRepository asks this repository before any update or removal and
 * refuses (PinnedBundleError) unless the visitor has agreed to give the
 * blocking plans up (PM: strict invalidation - one copy of each tour on the
 * device, never several versions).
 *
 *   draft   just planned, being reviewed or downloaded. Pins NOTHING: a plan
 *           the visitor never kept must not freeze tours. At most one draft.
 *   saved   downloaded and verified. Pins its sources.
 *
 * downloadRequestedAt is a WRITE-AHEAD INTENT: set (and on disk) before the
 * first byte of a plan's download, so after a crash planReconciler can tell a
 * draft the visitor asked to keep - which it may promote to saved once every
 * pin is verified on disk - from one they only previewed, which it must not.
 *
 * SYNCHRONOUS by design, like TourProgressRepository: the guard runs inside a
 * download, and an async store that had not finished loading at cold start
 * would read "no plans" and let a pinned tour be overwritten. Pure: the file
 * I/O arrives through PlanStoreIO (planRepositoryFile.ts in the app, a Map in
 * the tests).
 */

export interface SavedPlan {
  plan: PlanTourOk;
  /** What was asked, so a stale plan can be re-planned once without the form. */
  request: PlanTourRequest;
  /** "Current location" or the Places label - shown in lists and dialogs. */
  originLabel: string;
  status: 'draft' | 'saved';
  savedAt: number;
  /** Epoch ms of "Download & save" (drafts only); null until then. */
  downloadRequestedAt: number | null;
}

export interface PinHolder {
  planId: string;
  /** For dialogs: "your plan from Dizengoff St 50 (Oct 4)". */
  label: string;
  hash: string;
}

export interface PlanStoreIO {
  read(): string | null;
  /** Must be atomic (write-then-rename): a torn file would lose every plan. */
  write(text: string): void;
}

const FILE_VERSION = 1;

export interface PlanRepository {
  list(): readonly SavedPlan[];
  get(planId: string): SavedPlan | null;
  /** Store a freshly planned plan as THE draft (any previous draft is dropped). */
  putDraft(entry: Omit<SavedPlan, 'status' | 'downloadRequestedAt'>): void;
  /** Record, durably, that the visitor asked to download and keep the draft. */
  requestDownload(planId: string, at: number): void;
  /** Draft -> saved, once every pin has been verified on the device. */
  markSaved(planId: string): void;
  remove(planIds: readonly string[]): void;
  /** Saved plans that would break if tour `tourId` became version `toHash` (null = removed). */
  blockingPlans(tourId: string, toHash: string | null): PinHolder[];
  subscribe(listener: () => void): () => void;
}

export function planLabel(p: SavedPlan): string {
  const d = new Date(p.savedAt);
  return `your plan from ${p.originLabel} (${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })})`;
}

export function createPlanRepository(io: PlanStoreIO, log: (msg: string) => void = (m) => console.warn(m)): PlanRepository {
  let plans: SavedPlan[] = load();
  const listeners = new Set<() => void>();

  function load(): SavedPlan[] {
    const text = io.read();
    if (text === null) return [];
    try {
      const parsed = JSON.parse(text) as { v?: unknown; plans?: unknown };
      if (parsed.v !== FILE_VERSION || !Array.isArray(parsed.plans)) throw new Error(`unknown plan file version ${String(parsed.v)}`);
      const out: SavedPlan[] = [];
      for (const raw of parsed.plans as Record<string, unknown>[]) {
        try {
          // Re-parsed on every load: a plan that no longer satisfies the
          // contract is dropped loudly, never run.
          const plan = parsePlanTourOk(raw.plan);
          if (raw.status !== 'draft' && raw.status !== 'saved') throw new Error('bad status');
          // Absent in files written before the intent existed: no intent was recorded.
          const intent = typeof raw.downloadRequestedAt === 'number' ? raw.downloadRequestedAt : null;
          out.push({ plan, request: raw.request as PlanTourRequest, originLabel: String(raw.originLabel), status: raw.status, savedAt: Number(raw.savedAt), downloadRequestedAt: intent });
        } catch (cause) {
          log(`[Plans] dropped an unreadable saved plan: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      return out;
    } catch (cause) {
      log(`[Plans] plan file unreadable, starting empty: ${cause instanceof Error ? cause.message : String(cause)}`);
      return [];
    }
  }

  function commit(next: SavedPlan[]): void {
    io.write(JSON.stringify({ v: FILE_VERSION, plans: next }));
    plans = next;
    for (const l of [...listeners]) l();
  }

  return {
    list: () => plans,
    get: (id) => plans.find((p) => p.plan.plan_id === id) ?? null,
    putDraft(entry) {
      commit([...plans.filter((p) => p.status !== 'draft' && p.plan.plan_id !== entry.plan.plan_id), { ...entry, status: 'draft', downloadRequestedAt: null }]);
    },
    requestDownload(id, at) {
      const p = plans.find((x) => x.plan.plan_id === id);
      if (!p) throw new RangeError(`no plan ${id}`);
      if (p.status !== 'draft') throw new RangeError(`plan ${id} is ${p.status}, not a draft`);
      if (p.downloadRequestedAt !== null) return;
      commit(plans.map((x) => (x === p ? { ...x, downloadRequestedAt: at } : x)));
    },
    markSaved(id) {
      const p = plans.find((x) => x.plan.plan_id === id);
      if (!p) throw new RangeError(`no plan ${id}`);
      if (p.status === 'saved') return;
      commit(plans.map((x) => (x === p ? { ...x, status: 'saved', downloadRequestedAt: null } : x)));
    },
    remove(ids) {
      const drop = new Set(ids);
      if (plans.some((p) => drop.has(p.plan.plan_id))) commit(plans.filter((p) => !drop.has(p.plan.plan_id)));
    },
    blockingPlans(tourId, toHash) {
      const out: PinHolder[] = [];
      for (const p of plans) {
        if (p.status !== 'saved') continue;
        const pin = p.plan.sources.find((s) => s.tour_id === tourId);
        if (pin && pin.bundle_version_hash !== toHash) out.push({ planId: p.plan.plan_id, label: planLabel(p), hash: pin.bundle_version_hash });
      }
      return out;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Raised by TourBundleRepository when an update or removal would break saved plans. */
export class PinnedBundleError extends Error {
  override readonly name = 'PinnedBundleError';
  readonly tourId: string;
  readonly blocking: readonly PinHolder[];
  readonly action: 'update' | 'remove';
  // No parameter properties: test:plan runs this file under Node's strip-only TypeScript.
  constructor(tourId: string, blocking: readonly PinHolder[], action: 'update' | 'remove') {
    super(`${action === 'update' ? 'Updating' : 'Removing'} tour ${tourId} would invalidate ${blocking.length} saved plan(s)`);
    this.tourId = tourId;
    this.blocking = blocking;
    this.action = action;
  }
}

/**
 * The PM's copy (strict invalidation), human-readable and explicit that the
 * old plan is overwritten. One function so every surface says the same thing.
 */
export function pinConflictCopy(blocking: readonly PinHolder[], action: 'update' | 'remove' | 'new_plan'): { title: string; message: string; confirm: string } {
  const which = blocking.length === 1 ? blocking[0]!.label : `${blocking.length} of your saved plans`;
  if (action === 'new_plan') {
    return {
      title: 'Overwrite an older plan?',
      message: `Planning this new route requires updating a tour used in ${which}. Updating it will delete that plan. Overwrite the old plan?`,
      confirm: 'Overwrite old plan',
    };
  }
  return action === 'update'
    ? { title: 'Update this tour?', message: `This tour is used by ${which}. Updating it will delete that plan - you can plan again afterwards.`, confirm: 'Update and delete plan' }
    : { title: 'Remove this tour?', message: `This tour is used by ${which}. Removing it will delete that plan.`, confirm: 'Remove and delete plan' };
}
