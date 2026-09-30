import type { TransitMode } from '../types/domain';

/**
 * Epic 13 (P0, PM directive) - the running tour, persisted so a process Android
 * killed mid-walk can pick it up again.
 *
 * WHY: expo-location's tracking service returns START_REDELIVER_INTENT, so
 * Android restarts it after killing the process - into a fresh JS context
 * with no tour in memory. Before this, its fixes were dropped while the
 * notification kept promising narration (the "zombie"). TourSessionController
 * now rebuilds the session from this checkpoint instead.
 *
 * WHAT: everything a resume needs that is NOT in the downloaded bundle.
 * "Tour id + stop index" is not enough:
 *   - `activeIds`  the stops this session runs. Chosen from preferences at start
 *                  (TASK-604) and never re-derived: preferences may have changed.
 *   - `order`      the visiting order, which the live route may have changed.
 *   - `passed`     the stops already passed. After a reorder these need not be a
 *                  prefix of `order`, so an index cannot express them.
 *   - `visited`    what the player shows as "N of M stops".
 *
 * WHEN: written synchronously at every progress change (start, order adopted,
 * stop reached) and deleted as the FIRST step of ending a tour, so a crash
 * during teardown cannot bring a finished tour back.
 *
 * SYNCHRONOUS, AND WHY NOT ASYNCSTORAGE: every AsyncStorage call is async, so a
 * kill between "stop reached" and the write landing loses the progress - it
 * cannot be the synchronous write the directive requires. It is also one
 * SQLite database capped at 6 MB on Android, shared with the auth session.
 * expo-file-system's File.write() and rename() are synchronous native calls:
 * when save() returns, the bytes are on disk.
 *
 * ATOMIC: save() writes a temp file, deletes the checkpoint, and renames the
 * temp into place. A kill at any point leaves one complete copy - the old
 * checkpoint, or the temp - and load() falls back to the temp.
 *
 * Pure: the file I/O is injected (sessionCheckpointFile.ts is the real one), so
 * `npm run test:ui` covers every branch without a device.
 */

export const CHECKPOINT_VERSION = 1;

/**
 * A checkpoint older than this is discarded, not resumed. Measured from the
 * LAST progress change, so a long lunch on a full-day tour (480 min budget)
 * still resumes, while yesterday's abandoned tour does not come back.
 * PM-tunable.
 */
export const MAX_RESUME_AGE_MS = 12 * 60 * 60_000;

export interface SessionCheckpoint {
  v: typeof CHECKPOINT_VERSION;
  tourId: string;
  tourTitle: string;
  transitMode: TransitMode;
  activeIds: string[];
  skippedIds: string[];
  order: string[];
  passed: string[];
  visited: string[];
  backgroundPermission: boolean;
  notificationPermission: boolean;
  /** Epoch ms the tour was first started; kept across resumes. */
  startedAt: number;
  /** Epoch ms of this write. */
  savedAt: number;
}

/** Synchronous file operations. Every method may throw; callers decide. */
export interface CheckpointIO {
  readMain(): string | null;
  readTemp(): string | null;
  writeTemp(text: string): void;
  /** Replace the checkpoint with the temp file (delete, then rename). */
  commitTemp(): void;
  /** Delete both files. */
  clear(): void;
}

export type LoadResult =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'found'; checkpoint: SessionCheckpoint };

export type ResumeDecision =
  | { kind: 'nothing' }
  | { kind: 'discard'; reason: string }
  | { kind: 'resume'; checkpoint: SessionCheckpoint };

const TRANSIT_MODES: readonly TransitMode[] = ['walking', 'biking', 'driving'];

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** The reason a parsed value is not a usable checkpoint, or null if it is. */
export function checkpointProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object';
  const c = value as Record<string, unknown>;
  if (c.v !== CHECKPOINT_VERSION) return `unknown version ${String(c.v)}`;
  if (typeof c.tourId !== 'string' || c.tourId === '') return 'no tourId';
  if (typeof c.tourTitle !== 'string') return 'no tourTitle';
  if (!TRANSIT_MODES.includes(c.transitMode as TransitMode)) return `unknown transitMode ${String(c.transitMode)}`;
  for (const key of ['activeIds', 'skippedIds', 'order', 'passed', 'visited'] as const) {
    if (!isStringArray(c[key])) return `${key} is not a list of ids`;
  }
  const active = c.activeIds as string[];
  const order = c.order as string[];
  if (active.length === 0) return 'no active stops';
  const activeSet = new Set(active);
  if (activeSet.size !== active.length) return 'duplicate active stops';
  if (order.length !== active.length || new Set(order).size !== order.length || !order.every((id) => activeSet.has(id))) {
    return 'order is not the active stops';
  }
  if (!(c.passed as string[]).every((id) => activeSet.has(id))) return 'passed names a stop that is not active';
  if (!(c.visited as string[]).every((id) => activeSet.has(id))) return 'visited names a stop that is not active';
  for (const key of ['backgroundPermission', 'notificationPermission'] as const) {
    if (typeof c[key] !== 'boolean') return `${key} is not a boolean`;
  }
  for (const key of ['startedAt', 'savedAt'] as const) {
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key])) return `${key} is not a timestamp`;
  }
  return null;
}

export function createCheckpointStore(io: CheckpointIO) {
  const parse = (text: string): LoadResult => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: 'invalid', reason: 'not JSON' };
    }
    const problem = checkpointProblem(value);
    return problem === null ? { kind: 'found', checkpoint: value as SessionCheckpoint } : { kind: 'invalid', reason: problem };
  };

  return {
    /** Synchronous and atomic. Throws if the disk refuses; the caller reports it. */
    save(checkpoint: SessionCheckpoint): void {
      const problem = checkpointProblem(checkpoint);
      // A checkpoint that would be refused on load is a bug here, not later.
      if (problem !== null) throw new Error(`refusing to save an invalid checkpoint: ${problem}`);
      io.writeTemp(JSON.stringify(checkpoint));
      io.commitTemp();
    },

    /**
     * The checkpoint, falling back to the temp copy: a kill between commitTemp's
     * delete and its rename leaves only the temp. A read that throws is
     * reported as invalid rather than as "none", so it is never mistaken for
     * a tour that ended cleanly.
     */
    load(): LoadResult {
      let main: string | null;
      let temp: string | null;
      try {
        main = io.readMain();
        temp = main === null ? io.readTemp() : null;
      } catch (err) {
        return { kind: 'invalid', reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (main !== null) return parse(main);
      if (temp !== null) return parse(temp);
      return { kind: 'none' };
    },

    clear(): void {
      io.clear();
    },
  };
}

export type CheckpointStore = ReturnType<typeof createCheckpointStore>;

/** Resume, discard (with the reason, for the log), or nothing to do. */
export function decideResume(loaded: LoadResult, now: number): ResumeDecision {
  if (loaded.kind === 'none') return { kind: 'nothing' };
  if (loaded.kind === 'invalid') return { kind: 'discard', reason: `unusable checkpoint (${loaded.reason})` };
  const age = now - loaded.checkpoint.savedAt;
  if (age > MAX_RESUME_AGE_MS) return { kind: 'discard', reason: `checkpoint is ${Math.round(age / 60_000)} min old` };
  return { kind: 'resume', checkpoint: loaded.checkpoint };
}
