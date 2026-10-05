import type { Progress, QueueItem } from '../engine/types.ts';
import { MAX_RESUME_AGE_MS, type CheckpointIO } from './sessionCheckpoint.ts';
import { planSessionKey } from './sessionKey.ts';

/**
 * TourProgressRepository (Epic 15) - the running tour, persisted so a killed
 * process can resume it. Version 2 of the Epic 13 checkpoint: the engine's
 * Progress replaces StopSequence's order/passed, and "visited" is derived
 * from progress.played instead of stored beside it.
 *
 * SYNCHRONOUS BY CONTRACT (PM, Epic 15). save() returns only once the bytes
 * are durable; the engine runner calls it BEFORE any audio effect runs, so a
 * kill can never leave a narration playing that the checkpoint does not know
 * fired. The storage behind it is the CheckpointIO port - today expo-file-system's
 * synchronous File API (sessionCheckpointFile.ts). If Android QA shows those
 * writes stall the UI thread, the replacement is react-native-mmkv behind the
 * same port, never an async queue (PM decision).
 *
 * Pure: the I/O is injected, so `npm run test:engine` covers every branch.
 *
 * VERSION 3 (Epic 16) adds `source`: a catalogue tour, or a saved PLAN named by
 * id and content_hash - never embedded. The plan already lives in
 * saved-plans.json; copying it into a file rewritten synchronously at every
 * progress change would put 20-50 KB of JSON on the JS thread mid-narration.
 * A v2 file still LOADS (as a catalogue tour) so a walk in progress survives
 * the app update; every write is v3.
 */

export const SNAPSHOT_VERSION = 3;

/** What the session runs. A plan is re-read from the plan store at resume and must still match. */
export type SessionSource = { kind: 'tour' } | { kind: 'plan'; planId: string; contentHash: string };

export interface TourProgressSnapshot {
  v: typeof SNAPSHOT_VERSION;
  /** The session key (sessionKey.ts): the tour id, or plan:<planId>. */
  tourId: string;
  source: SessionSource;
  tourTitle: string;
  /** The stops this session runs (every core stop, Epic 16). Never re-derived. */
  activeIds: string[];
  /**
   * TASK-604's preference skips. Retired in Epic 16: written as [] and never
   * read, kept so v2 checkpoints keep one shape - bumping the version would
   * discard every walk in progress when the app updates.
   */
  skippedIds: string[];
  backgroundPermission: boolean;
  notificationPermission: boolean;
  /** Epoch ms the tour was first started; kept across resumes. */
  startedAt: number;
  /** Epoch ms of this write. */
  savedAt: number;
  progress: Progress;
}

export type SnapshotLoad =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'found'; snapshot: TourProgressSnapshot };

export type SnapshotDecision =
  | { kind: 'nothing' }
  | { kind: 'discard'; reason: string }
  | { kind: 'resume'; snapshot: TourProgressSnapshot };

export interface TourProgressRepository {
  /** A read that throws is reported as invalid, never as "none". */
  load(): SnapshotLoad;
  /** Synchronous and atomic. Throws if the disk refuses; the caller reports it. */
  save(snapshot: TourProgressSnapshot): void;
  clear(): void;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isTimeRecord = (v: unknown): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((t) => typeof t === 'number' && Number.isFinite(t));

function isQueueItem(v: unknown): v is QueueItem {
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Record<string, unknown>;
  const where = q.firedWhere as Record<string, unknown> | null | undefined;
  return (
    typeof q.stopId === 'string' &&
    typeof q.firedAt === 'number' &&
    typeof q.expiresAt === 'number' &&
    typeof where === 'object' &&
    where !== null &&
    typeof where.latitude === 'number' &&
    typeof where.longitude === 'number'
  );
}

/**
 * Why a parsed value is not a usable snapshot, or null. Structure only:
 * whether its stops and chapters fit the downloaded tour is the engine's
 * question (progressProblem), asked at resume against the bundle.
 */
export function snapshotProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'not an object';
  const c = value as Record<string, unknown>;
  if (c.v !== SNAPSHOT_VERSION) return `unknown version ${String(c.v)}`;
  if (typeof c.tourId !== 'string' || c.tourId === '') return 'no tourId';
  const source = c.source as Record<string, unknown> | null | undefined;
  if (typeof source !== 'object' || source === null) return 'no source';
  if (source.kind === 'plan') {
    if (typeof source.planId !== 'string' || source.planId === '') return 'plan source has no planId';
    if (typeof source.contentHash !== 'string' || source.contentHash === '') return 'plan source has no contentHash';
    // One identity, stated twice: they must agree, or resume would key the wrong session.
    if (c.tourId !== planSessionKey(source.planId)) return `a plan session is keyed ${String(c.tourId)}, not ${planSessionKey(source.planId)}`;
  } else if (source.kind !== 'tour') {
    return `unknown source ${String(source.kind)}`;
  }
  if (typeof c.tourTitle !== 'string') return 'no tourTitle';
  if (!isStringArray(c.activeIds) || c.activeIds.length === 0) return 'activeIds is not a non-empty list of ids';
  if (!isStringArray(c.skippedIds)) return 'skippedIds is not a list of ids';
  for (const key of ['backgroundPermission', 'notificationPermission'] as const) {
    if (typeof c[key] !== 'boolean') return `${key} is not a boolean`;
  }
  for (const key of ['startedAt', 'savedAt'] as const) {
    if (typeof c[key] !== 'number' || !Number.isFinite(c[key])) return `${key} is not a timestamp`;
  }
  const p = c.progress as Record<string, unknown> | null | undefined;
  if (typeof p !== 'object' || p === null) return 'no progress';
  if (typeof p.chapterId !== 'string') return 'progress has no chapterId';
  if (!isTimeRecord(p.fired)) return 'progress.fired is not a map of times';
  if (!isTimeRecord(p.played)) return 'progress.played is not a map of times';
  if (!Array.isArray(p.queue) || !p.queue.every(isQueueItem)) return 'progress.queue is malformed';
  if (p.suspendedAt !== undefined && (typeof p.suspendedAt !== 'number' || !Number.isFinite(p.suspendedAt))) {
    return 'progress.suspendedAt is not a timestamp';
  }
  if (p.arrivedChapterIds !== undefined && !isStringArray(p.arrivedChapterIds)) {
    return 'progress.arrivedChapterIds is not a list of chapter ids';
  }
  const active = new Set(c.activeIds);
  for (const id of [...Object.keys(p.fired as object), ...(p.queue as QueueItem[]).map((q) => q.stopId)]) {
    if (!active.has(id)) return `progress names ${id}, which is not an active stop`;
  }
  return null;
}

export function createProgressRepository(io: CheckpointIO): TourProgressRepository {
  const parse = (text: string): SnapshotLoad => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { kind: 'invalid', reason: 'not JSON' };
    }
    // A v2 checkpoint is a catalogue tour by definition (plans did not exist).
    if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).v === 2) {
      value = { ...(value as Record<string, unknown>), v: SNAPSHOT_VERSION, source: { kind: 'tour' } };
    }
    const problem = snapshotProblem(value);
    return problem === null ? { kind: 'found', snapshot: value as TourProgressSnapshot } : { kind: 'invalid', reason: problem };
  };

  return {
    load(): SnapshotLoad {
      let main: string | null;
      let temp: string | null;
      try {
        main = io.readMain();
        // A kill between commitTemp's delete and its rename leaves only the temp.
        temp = main === null ? io.readTemp() : null;
      } catch (err) {
        return { kind: 'invalid', reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (main !== null) return parse(main);
      if (temp !== null) return parse(temp);
      return { kind: 'none' };
    },

    save(snapshot: TourProgressSnapshot): void {
      const problem = snapshotProblem(snapshot);
      // A snapshot that would be refused on load is a bug here, not later.
      if (problem !== null) throw new Error(`refusing to save an invalid progress snapshot: ${problem}`);
      io.writeTemp(JSON.stringify(snapshot));
      io.commitTemp();
    },

    clear(): void {
      io.clear();
    },
  };
}

/** Resume, discard (with the reason, for the log), or nothing to do. Same age limit as Epic 13. */
export function decideSnapshotResume(loaded: SnapshotLoad, now: number): SnapshotDecision {
  if (loaded.kind === 'none') return { kind: 'nothing' };
  if (loaded.kind === 'invalid') return { kind: 'discard', reason: `unusable checkpoint (${loaded.reason})` };
  const age = now - loaded.snapshot.savedAt;
  if (age > MAX_RESUME_AGE_MS) return { kind: 'discard', reason: `checkpoint is ${Math.round(age / 60_000)} min old` };
  return { kind: 'resume', snapshot: loaded.snapshot };
}
