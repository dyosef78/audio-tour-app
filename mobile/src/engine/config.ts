import type { TransitMode } from '../types/domain.ts';

/**
 * Per-mode tuning for the loose-sequence engine (Epic 15).
 *
 * INITIAL VALUES, to be tuned from the trigger_* telemetry the reducer emits.
 * Each number states the failure it guards against, so a change can be judged
 * against it rather than against a feeling.
 */
export interface ModeConfig {
  /** Exit boundary = zone x this (hysteresis). Walking only uses exits. */
  exitHysteresisFactor: number;
  /**
   * Walking: leaving a stop's zone fades its narration (the pre-Epic-15
   * behaviour). Driving/biking: never - at 100 km/h the exit comes ~20 s
   * after the entry and would cut every narration short (PM, Epic 15).
   */
  exitStopsNarration: boolean;
  /**
   * A stop fires while another narration plays:
   *   preempt  the new stop takes over (walking: you are standing at it)
   *   queue    it waits its turn (driving: cognitive overload otherwise)
   */
  whileBusy: 'preempt' | 'queue';
  /** A queued stop expires this long after firing... */
  queueTtlMs: number;
  /** ...or once we are this far from where it fired: "on your left" is wrong 2 km later. */
  queueExpireBeyondM: number;
  /** Waiting stops beyond this drop the OLDEST (the most likely to be stale). */
  maxQueue: number;
  /**
   * Longest gap the swept test bridges. Beyond it the straight line between
   * two fixes is not the road (a tunnel, a GPS outage): only the new fix is
   * point-tested. Bounded by the chord's sagitta on a curved road - a 500 m
   * chord of a 1 km-radius bend strays 32 m from the road.
   */
  maxSweepM: number;
  /** A segment implying more than this is a position jump, not travel: point test only. */
  maxPlausibleSpeedMps: number;
  /** Fixes worse than this are ignored entirely (they cannot resolve a zone). */
  accuracyCeilingM: number;
  /** Consecutive in-zone fixes, after ENTERING from outside, to jump past the window. */
  reanchorFixes: number;
  /** No re-anchor while any window stop is closer than this - the visitor is still on plan. */
  reanchorSuppressM: number;
  /** An OS interruption longer than this triggers one RESUME, twice this gives up on the narration. */
  interruptionTimeoutMs: number;
}

export const MODE_CONFIG: Readonly<Record<TransitMode, ModeConfig>> = {
  walking: {
    exitHysteresisFactor: 1.6,
    exitStopsNarration: true,
    whileBusy: 'preempt',
    queueTtlMs: 120_000,
    queueExpireBeyondM: 150,
    maxQueue: 1,
    maxSweepM: 100,
    maxPlausibleSpeedMps: 4,
    accuracyCeilingM: 35,
    reanchorFixes: 3,
    reanchorSuppressM: 120,
    interruptionTimeoutMs: 60_000,
  },
  biking: {
    exitHysteresisFactor: 1.5,
    exitStopsNarration: false,
    whileBusy: 'queue',
    queueTtlMs: 90_000,
    queueExpireBeyondM: 600,
    maxQueue: 2,
    maxSweepM: 200,
    maxPlausibleSpeedMps: 15,
    accuracyCeilingM: 40,
    reanchorFixes: 2,
    reanchorSuppressM: 300,
    interruptionTimeoutMs: 60_000,
  },
  driving: {
    exitHysteresisFactor: 1.4,
    exitStopsNarration: false,
    whileBusy: 'queue',
    queueTtlMs: 60_000,
    queueExpireBeyondM: 1_500,
    maxQueue: 2,
    maxSweepM: 500,
    maxPlausibleSpeedMps: 60,
    accuracyCeilingM: 50,
    reanchorFixes: 2,
    reanchorSuppressM: 1_000,
    interruptionTimeoutMs: 60_000,
  },
};

/**
 * A PLAY that has not produced AUDIO_STARTED (or AUDIO_FAILED) within this
 * long is abandoned by the reducer itself (PM, Epic 15): the narration slot
 * must never depend on a native callback arriving. Covers resolving a local
 * file or signing a stream and loading it. Tunable - a slow network's signed
 * stream is the case that would trip it first.
 */
export const PLAY_TIMEOUT_MS = 5_000;

/** A fix stamped more than this in the future (a skewed device clock) is refused. */
export const MAX_FUTURE_SKEW_MS = 5_000;

/** A fix older than this at ingestion is refused (a cached first fix, a stale replay). */
export const MAX_FIX_AGE_MS = 10 * 60_000;
