import type { LatLng, TransitMode } from '../types/domain.ts';
import type { BearingPolicy } from './geo/bearing.ts';

/**
 * Epic 15 - the loose-sequence engine's contract.
 *
 * reduce(state, event) -> { state, effects } is pure and synchronous. The
 * shell (TourSessionController, slice 4) owns the clock, persistence and every
 * side effect; the engine owns every decision. Nothing here imports React
 * Native, so the Node simulator runs it exactly as the device will.
 */

// -----------------------------------------------------------------------------
// Input: one GPS fix as the OS reported it
// -----------------------------------------------------------------------------

/**
 * Raw OS fix. Each one carries ITS OWN timestamp - before Epic 15 the
 * background task stamped a whole batch with one Date.now(), which makes the
 * time between fixes zero and the swept test's speed guard meaningless.
 */
export interface GpsFix {
  coordinate: LatLng;
  /** Epoch ms, from the location provider. */
  timestamp: number;
  /** Horizontal 1-sigma error in metres; null when the OS gave none. */
  accuracyM: number | null;
  /** m/s; null or negative when invalid (iOS reports -1). */
  speedMps: number | null;
  /** Course over ground, degrees; null or negative when invalid. */
  headingDeg: number | null;
}

// -----------------------------------------------------------------------------
// The tour as the engine sees it (mapped from the bundle by the shell)
// -----------------------------------------------------------------------------

export type EngineZone =
  | { kind: 'radius'; center: LatLng; radiusM: number }
  | { kind: 'polygon'; ring: readonly LatLng[] };

export interface EngineApproach {
  bearingDeg: number;
  toleranceDeg: number;
  policy: Exclude<BearingPolicy, 'ignore'>;
}

export interface EngineStop {
  id: string;
  chapterId: string;
  /**
   * Position among the ACTIVE stops of its chapter, 0-based and contiguous.
   * The shell assigns it AFTER preference filtering (TASK-604), so the window
   * never counts a stop this visitor will not hear.
   */
  index: number;
  zone: EngineZone;
  approach: EngineApproach | null;
}

export type SequencePolicy = 'strict' | 'windowed';

export interface EngineChapter {
  id: string;
  sortOrder: number;
  transitMode: TransitMode;
  sequencePolicy: SequencePolicy;
  /** How many stops past the cursor may fire. strict behaves as 1. */
  lookaheadStops: number;
}

export interface EngineTour {
  chapters: readonly EngineChapter[];
  /** Only stops that CAN fire: a stop with no zone is the mapper's to drop. */
  stops: readonly EngineStop[];
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

/**
 * A stop that fired and is waiting for the narration slot.
 *
 * Times here and everywhere in the state are the SHELL's clock (Date.now()
 * at the event), never a fix's own timestamp: one clock for every timeout.
 * Fix timestamps are used only to order fixes and measure speed.
 */
export interface QueueItem {
  stopId: string;
  firedAt: number;
  /** Where it fired, for the distance expiry. */
  firedWhere: LatLng;
  /** firedAt + the mode's queue TTL. */
  expiresAt: number;
}

/**
 * The PERSISTED slice. The reducer returns the SAME object when nothing in it
 * changed, so the shell persists on `next.progress !== prev.progress` - one
 * reference comparison per dispatch, and no write per GPS fix.
 *
 * The cursor (furthest stop reached per chapter) is DERIVED from `fired`,
 * never stored, so the two cannot disagree after a partial write.
 */
export interface Progress {
  chapterId: string;
  /** Every stop that fired, ever: played, queued, expired or failed. stopId -> fix time. */
  fired: Readonly<Record<string, number>>;
  /** Stops whose narration actually STARTED. stopId -> time. Subset of fired. */
  played: Readonly<Record<string, number>>;
  /** Fired, waiting. Does NOT include the stop currently playing. */
  queue: readonly QueueItem[];
}

export type AudioState =
  | { kind: 'idle' }
  /** PLAY issued; waiting for AUDIO_STARTED. */
  | { kind: 'starting'; token: number; stopId: string; since: number }
  | { kind: 'playing'; token: number; stopId: string; since: number }
  /** Paused by the OS (an iOS doNotMix interruption) or by the user. */
  | {
      kind: 'interrupted';
      token: number;
      stopId: string;
      since: number;
      by: 'os' | 'user';
      /** The watchdog already asked the player to resume once. */
      resumeRequested: boolean;
    };

/** Evidence for jumping past the window (see reduce.ts, "Re-anchor"). */
export interface ReanchorEvidence {
  stopId: string;
  /** Consecutive accepted fixes that hit this stop since entering it. */
  hits: number;
}

export interface EngineState {
  tour: EngineTour;
  progress: Progress;
  audio: AudioState;
  /** Last ACCEPTED fix - the start of the next swept segment. Not persisted. */
  lastFix: GpsFix | null;
  reanchor: ReanchorEvidence | null;
  /** Stops whose bearing rejection was already reported (one telemetry event each). */
  bearingReported: ReadonlySet<string>;
  /** Monotonic; every PLAY gets a fresh one. Stale audio events carry an old one. */
  nextToken: number;
}

// -----------------------------------------------------------------------------
// Events (into the reducer)
// -----------------------------------------------------------------------------

export type EngineEvent =
  /** The session is (re)starting: replay a restored queue. `at` = Date.now(). */
  | { type: 'SESSION_STARTED'; at: number }
  /** One OS delivery, in any order; `receivedAt` = Date.now() at ingestion. */
  | { type: 'FIX_BATCH'; fixes: readonly GpsFix[]; receivedAt: number }
  | { type: 'AUDIO_STARTED'; token: number; at: number }
  | { type: 'AUDIO_ENDED'; token: number; at: number }
  | { type: 'AUDIO_FAILED'; token: number; at: number; message: string }
  | { type: 'AUDIO_INTERRUPTED'; token: number; at: number; by: 'os' | 'user' }
  | { type: 'AUDIO_RESUMED'; token: number; at: number }
  /**
   * Clock only: the shell's 1 Hz heartbeat (PM, Epic 15). Drives the PLAY
   * timeout, the interruption watchdog and queue expiry when no fix arrives.
   * FIX_BATCH runs the same clock checks at its receivedAt, because on
   * Android JS timers are paused in the background and the fix stream is the
   * only heartbeat there.
   */
  | { type: 'TICK'; at: number }
  /** Manual chapter advance (PM: manual only for MVP). */
  | { type: 'CHAPTER_SELECTED'; chapterId: string; at: number }
  /** "Play this stop now" - debug trigger and the future skip-to control. */
  | { type: 'MANUAL_TRIGGER'; stopId: string; at: number };

// -----------------------------------------------------------------------------
// Effects (out of the reducer, executed by the shell after persisting)
// -----------------------------------------------------------------------------

export type TelemetryKind =
  | 'trigger_fired'
  | 'trigger_reanchored'
  | 'trigger_rejected_bearing'
  | 'trigger_expired'
  | 'trigger_missed'
  | 'audio_watchdog';

export type Effect =
  | { type: 'PLAY'; token: number; stopId: string }
  /** Stop the narration `token` owns. fade: the walking zone-exit fade-out. */
  | { type: 'STOP'; token: number; fade: boolean }
  /** Ask the player to resume after an interruption that never ended. */
  | { type: 'RESUME'; token: number }
  /**
   * The chapter's mode changed: tracking must use its sampling (Android
   * restarts the task, so this only ever runs from an in-app tap) and the
   * audio session its interruption mode (driving: duckOthers on Android).
   */
  | { type: 'APPLY_TRANSIT_MODE'; transitMode: TransitMode }
  | { type: 'TELEMETRY'; kind: TelemetryKind; stopId: string | null; detail: Readonly<Record<string, string | number>> };

export interface ReduceResult {
  state: EngineState;
  effects: Effect[];
}
