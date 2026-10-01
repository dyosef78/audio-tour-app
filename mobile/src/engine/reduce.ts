import type { LatLng } from '../types/domain.ts';
import { estimateCourse, evaluateApproach, type Course, type CourseFix } from './geo/bearing.ts';
import { planarDistanceMeters } from './geo/sweep.ts';
import { MAX_FIX_AGE_MS, MAX_FUTURE_SKEW_MS, MODE_CONFIG, PLAY_TIMEOUT_MS, type ModeConfig } from './config.ts';
import type {
  AudioState,
  Effect,
  EngineChapter,
  EngineEvent,
  EngineState,
  EngineStop,
  EngineTour,
  GpsFix,
  Progress,
  QueueItem,
  ReduceResult,
} from './types.ts';
import { distanceToZoneM, insideZone, sweepZone } from './zone.ts';

/**
 * The loose-sequence engine (Epic 15): one pure, synchronous function from
 * (state, event) to (state, effects). See types.ts for the contract.
 *
 * WHICH STOPS MAY FIRE
 *
 * Per chapter, the CURSOR is the highest index among fired stops (-1 before
 * the first). Every stop above the cursor is unfired, by definition.
 *
 *   window    cursor+1 .. cursor+K   (K = lookaheadStops; strict means K = 1)
 *             fires on the first fix whose swept segment touches it and whose
 *             course passes its approach check. Lowest index wins.
 *   beyond    cursor+K+1 ..          may fire only by RE-ANCHOR (below)
 *   behind    index < cursor, unfired: MISSED. Never fires by itself - the
 *             visitor has moved on; doubling back must not replay the tour.
 *
 * RE-ANCHOR - recovering when the visitor skipped the whole window
 *
 * A detour can take a visitor past every window stop; without this the tour
 * would wait for stops they will never reach (the pre-Epic-15 deadlock). A
 * beyond stop fires, and the cursor jumps to it, when ALL of these hold:
 *
 *   1. ENTRY  the evidence starts with a swept segment that began OUTSIDE the
 *             zone (t > 0) and a fix INSIDE it. Standing in the last stop of
 *             a loop tour at the start, or resuming inside a zone, is never a
 *             jump - and nor is a fast pass that never puts a fix inside.
 *   2. DWELL  mode.reanchorFixes consecutive accepted fixes INSIDE the same
 *             stop (counting the entry fix). One jittering fix is not a
 *             detour; a fix outside resets the count.
 *   3. COURSE every one of those fixes passes the stop's approach check.
 *   4. OFF PLAN no window stop is within mode.reanchorSuppressM. A visitor
 *             near the next expected stop is on plan, whatever zone they
 *             happen to cross - this is what protects a loop tour whose final
 *             stop sits beside its first.
 *
 * Window stops always win over re-anchor on the same fix. Re-anchor never
 * crosses a chapter (chapter advance is manual - PM, Epic 15).
 *
 * TIME: ONE clock for every timeout - the shell's Date.now() carried by each
 * event (TICK.at, FIX_BATCH.receivedAt, AUDIO_*.at). A fix's own timestamp
 * orders fixes and measures speed, nothing else. advanceClock() runs the
 * PLAY timeout, the interruption watchdog and queue expiry, on every TICK
 * (the 1 Hz heartbeat) AND every FIX_BATCH (the only heartbeat on Android in
 * the background, where JS timers are paused).
 */

// -----------------------------------------------------------------------------
// Construction and restore
// -----------------------------------------------------------------------------

export function freshProgress(tour: EngineTour, chapterId: string): Progress {
  chapterOrThrow(tour, chapterId);
  return { chapterId, fired: {}, played: {}, queue: [] };
}

/** Why `progress` cannot run on `tour`, or null. The shell discards (loudly) on non-null. */
export function progressProblem(tour: EngineTour, progress: Progress): string | null {
  if (!tour.chapters.some((c) => c.id === progress.chapterId)) return `unknown chapter ${progress.chapterId}`;
  const stops = new Map(tour.stops.map((s) => [s.id, s]));
  for (const id of Object.keys(progress.fired)) if (!stops.has(id)) return `fired names unknown stop ${id}`;
  for (const id of Object.keys(progress.played)) {
    if (!(id in progress.fired)) return `played stop ${id} never fired`;
  }
  for (const q of progress.queue) {
    if (!(q.stopId in progress.fired)) return `queued stop ${q.stopId} never fired`;
    if (q.stopId in progress.played) return `queued stop ${q.stopId} already played`;
    if (stops.get(q.stopId)?.chapterId !== progress.chapterId) return `queued stop ${q.stopId} is not in the active chapter`;
  }
  return null;
}

export function createEngineState(tour: EngineTour, progress: Progress): EngineState {
  validateTour(tour);
  const problem = progressProblem(tour, progress);
  if (problem !== null) throw new RangeError(`createEngineState: ${problem}`);
  return {
    tour,
    progress,
    audio: { kind: 'idle' },
    lastFix: null,
    reanchor: null,
    bearingReported: new Set(),
    nextToken: 1,
  };
}

/** Indices must be 0..n-1 per chapter: the window arithmetic depends on it. */
function validateTour(tour: EngineTour): void {
  for (const chapter of tour.chapters) {
    const idx = tour.stops.filter((s) => s.chapterId === chapter.id).map((s) => s.index).sort((a, b) => a - b);
    idx.forEach((v, i) => {
      if (v !== i) throw new RangeError(`chapter ${chapter.id}: stop indices must be 0..${idx.length - 1}, got ${idx.join(',')}`);
    });
    if (chapter.lookaheadStops < 1) throw new RangeError(`chapter ${chapter.id}: lookaheadStops must be >= 1`);
  }
  for (const s of tour.stops) {
    if (!tour.chapters.some((c) => c.id === s.chapterId)) throw new RangeError(`stop ${s.id}: unknown chapter ${s.chapterId}`);
  }
}

// -----------------------------------------------------------------------------
// reduce
// -----------------------------------------------------------------------------

export function reduce(state: EngineState, event: EngineEvent): ReduceResult {
  const effects: Effect[] = [];
  let s = state;
  switch (event.type) {
    case 'SESSION_STARTED':
      s = startNextIfIdle(s, event.at, effects);
      break;
    case 'FIX_BATCH':
      s = advanceClock(s, event.receivedAt, effects);
      for (const fix of ingest(event.fixes, event.receivedAt, s.lastFix)) s = stepFix(s, fix, event.receivedAt, effects);
      break;
    case 'AUDIO_STARTED':
      // Also when an interruption arrived while the player was still loading:
      // the narration did start, so it is played, and it stays interrupted.
      if (s.audio.kind !== 'idle' && s.audio.token === event.token) {
        const { stopId } = s.audio;
        const played = stopId in s.progress.played ? s.progress.played : { ...s.progress.played, [stopId]: event.at };
        s = {
          ...s,
          audio: s.audio.kind === 'starting' ? { kind: 'playing', token: event.token, stopId, since: event.at } : s.audio,
          progress: played === s.progress.played ? s.progress : { ...s.progress, played },
        };
      }
      break;
    case 'AUDIO_ENDED':
    case 'AUDIO_FAILED':
      if (s.audio.kind !== 'idle' && s.audio.token === event.token) {
        if (event.type === 'AUDIO_FAILED') {
          effects.push(telemetry('trigger_missed', s.audio.stopId, { reason: 'audio_failed', message: event.message }));
        }
        s = startNextIfIdle({ ...s, audio: { kind: 'idle' } }, event.at, effects);
      }
      break;
    case 'AUDIO_INTERRUPTED':
      if ((s.audio.kind === 'playing' || s.audio.kind === 'starting') && s.audio.token === event.token) {
        s = {
          ...s,
          audio: {
            kind: 'interrupted',
            token: event.token,
            stopId: s.audio.stopId,
            since: event.at,
            by: event.by,
            resumeRequested: false,
          },
        };
      }
      break;
    case 'AUDIO_RESUMED':
      if (s.audio.kind === 'interrupted' && s.audio.token === event.token) {
        s = { ...s, audio: { kind: 'playing', token: event.token, stopId: s.audio.stopId, since: event.at } };
      }
      break;
    case 'TICK':
      s = advanceClock(s, event.at, effects);
      break;
    case 'CHAPTER_SELECTED':
      s = selectChapter(s, event.chapterId, effects);
      break;
    case 'MANUAL_TRIGGER':
      s = manualTrigger(s, event.stopId, event.at, effects);
      break;
  }
  return { state: s, effects };
}

// -----------------------------------------------------------------------------
// Fixes
// -----------------------------------------------------------------------------

/**
 * Order and filter one OS delivery. Sorted by the fix's own time; refused when
 * non-finite, stamped in the future (clock skew), older than MAX_FIX_AGE_MS,
 * or not strictly after the last accepted fix - a duplicate delivered by both
 * the foreground watcher and the background task during the iOS hand-over, or
 * a batch Android redelivers after a restart, would otherwise sweep backwards.
 */
export function ingest(fixes: readonly GpsFix[], receivedAt: number, lastFix: GpsFix | null): GpsFix[] {
  const out: GpsFix[] = [];
  let lastT = lastFix?.timestamp ?? -Infinity;
  const sorted = fixes
    .filter(
      (f) =>
        Number.isFinite(f.timestamp) &&
        Number.isFinite(f.coordinate.latitude) &&
        Number.isFinite(f.coordinate.longitude) &&
        Math.abs(f.coordinate.latitude) <= 90 &&
        f.timestamp <= receivedAt + MAX_FUTURE_SKEW_MS &&
        receivedAt - f.timestamp <= MAX_FIX_AGE_MS,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  for (const f of sorted) {
    if (f.timestamp <= lastT) continue;
    out.push(f);
    lastT = f.timestamp;
  }
  return out;
}

function stepFix(state: EngineState, fix: GpsFix, now: number, effects: Effect[]): EngineState {
  const chapter = activeChapter(state);
  const mode = MODE_CONFIG[chapter.transitMode];

  // A fix that cannot resolve a zone is not used at all - not even as the
  // start of the next segment, which then sweeps from the last good fix.
  if (fix.accuracyM !== null && fix.accuracyM > mode.accuracyCeilingM) return state;

  const prev = state.lastFix;
  const sweepable = prev !== null && isSweepable(prev, fix, mode);
  const from = sweepable && prev ? prev.coordinate : fix.coordinate;
  const course = estimateCourse(sweepable && prev ? courseFix(prev) : null, courseFix(fix));

  let s: EngineState = state;
  s = walkingExit(s, prev, fix, now, mode, effects);
  s = { ...s, progress: pruneQueue(s, now, fix, effects) };

  const cursor = cursorOf(s, chapter.id);
  const k = chapter.sequencePolicy === 'strict' ? 1 : chapter.lookaheadStops;
  const stops = s.tour.stops.filter((st) => st.chapterId === chapter.id && st.index > cursor);
  const windowStops = stops.filter((st) => st.index <= cursor + k);
  const beyondStops = stops.filter((st) => st.index > cursor + k);

  // --- window: first hit by sequence order --------------------------------
  let reported = s.bearingReported;
  let windowHit: EngineStop | null = null;
  for (const stop of [...windowStops].sort((a, b) => a.index - b.index)) {
    const hit = sweepZone(from, fix.coordinate, stop.zone);
    if (!hit.hit) continue;
    const verdict = approachVerdict(stop, course);
    if (!verdict.fire) {
      reported = reportBearing(reported, stop, verdict.reason, course, effects);
      continue;
    }
    windowHit = stop;
    break;
  }
  if (reported !== s.bearingReported) s = { ...s, bearingReported: reported };

  if (windowHit !== null) {
    s = { ...s, reanchor: null, lastFix: fix };
    return fire(s, windowHit, fix, now, 'window', mode, effects);
  }

  // --- beyond: re-anchor evidence -----------------------------------------
  const onPlan = windowStops.some((st) => distanceToZoneM(fix.coordinate, st.zone) <= mode.reanchorSuppressM);
  let evidence = null as EngineState['reanchor'];
  if (!onPlan) {
    for (const stop of [...beyondStops].sort((a, b) => a.index - b.index)) {
      const hit = sweepZone(from, fix.coordinate, stop.zone);
      if (!hit.hit) continue;
      // Dwell counts FIXES INSIDE, not segments touching: a segment that
      // starts inside and leaves "hits" too, and would count an exit as
      // evidence of staying.
      if (!insideZone(fix.coordinate, stop.zone)) continue;
      const verdict = approachVerdict(stop, course);
      if (!verdict.fire) {
        reported = reportBearing(reported, stop, verdict.reason, course, effects);
        continue;
      }
      if (s.reanchor?.stopId === stop.id) {
        evidence = { stopId: stop.id, hits: s.reanchor.hits + 1 };
      } else if (sweepable && hit.t > 0) {
        // Entry from outside starts the evidence; being inside already does not.
        evidence = { stopId: stop.id, hits: 1 };
      }
      if (evidence !== null) break;
    }
  }
  if (reported !== s.bearingReported) s = { ...s, bearingReported: reported };
  s = { ...s, reanchor: evidence, lastFix: fix };

  if (evidence !== null && evidence.hits >= mode.reanchorFixes) {
    const target = s.tour.stops.find((st) => st.id === evidence.stopId) as EngineStop;
    const skipped = s.tour.stops.filter((st) => st.chapterId === chapter.id && st.index > cursor && st.index < target.index);
    for (const st of skipped) effects.push(telemetry('trigger_missed', st.id, { reason: 'reanchor_skipped', to: target.index }));
    effects.push(telemetry('trigger_reanchored', target.id, { from: cursor, to: target.index, skipped: skipped.length }));
    s = { ...s, reanchor: null };
    return fire(s, target, fix, now, 'reanchor', mode, effects);
  }
  return s;
}

/**
 * The swept segment is the road only when it is short and plausible. Beyond
 * either bound (a tunnel exit, a teleporting cell fix), the new fix is
 * point-tested alone - and cannot start re-anchor evidence.
 */
function isSweepable(prev: GpsFix, fix: GpsFix, mode: ModeConfig): boolean {
  const d = planarDistanceMeters(prev.coordinate, fix.coordinate);
  const dtS = (fix.timestamp - prev.timestamp) / 1000;
  return d <= mode.maxSweepM && dtS > 0 && d / dtS <= mode.maxPlausibleSpeedMps;
}

function courseFix(f: GpsFix): CourseFix {
  return { coordinate: f.coordinate, headingDeg: f.headingDeg, speedMps: f.speedMps, accuracyM: f.accuracyM };
}

function approachVerdict(stop: EngineStop, course: Course) {
  return stop.approach === null
    ? evaluateApproach('ignore', null, 0, course)
    : evaluateApproach(stop.approach.policy, stop.approach.bearingDeg, stop.approach.toleranceDeg, course);
}

/** One trigger_rejected_bearing per stop per chapter - not one per fix spent inside its zone. */
function reportBearing(
  reported: ReadonlySet<string>,
  stop: EngineStop,
  reason: string,
  course: Course,
  effects: Effect[],
): ReadonlySet<string> {
  if (reported.has(stop.id)) return reported;
  effects.push(
    telemetry('trigger_rejected_bearing', stop.id, {
      reason,
      course: course === null ? 'unknown' : Math.round(course.deg),
      approach: stop.approach?.bearingDeg ?? -1,
    }),
  );
  return new Set(reported).add(stop.id);
}

/**
 * Walking only: leaving the playing stop's zone (grown by the hysteresis
 * factor) fades its narration. A TRANSITION - previous fix inside, this one
 * outside - so a stop fired by a swept segment that ended beyond the zone is
 * not cut the instant it starts.
 */
function walkingExit(s: EngineState, prev: GpsFix | null, fix: GpsFix, now: number, mode: ModeConfig, effects: Effect[]): EngineState {
  if (!mode.exitStopsNarration || s.audio.kind === 'idle' || prev === null) return s;
  const stop = s.tour.stops.find((st) => st.id === audioStopId(s.audio));
  if (!stop) return s;
  const wasInside = insideZone(prev.coordinate, stop.zone, mode.exitHysteresisFactor);
  if (!wasInside || insideZone(fix.coordinate, stop.zone, mode.exitHysteresisFactor)) return s;
  effects.push({ type: 'STOP', token: audioToken(s.audio), fade: true });
  return startNextIfIdle({ ...s, audio: { kind: 'idle' } }, now, effects);
}

// -----------------------------------------------------------------------------
// Firing and the narration queue
// -----------------------------------------------------------------------------

function fire(
  s: EngineState,
  stop: EngineStop,
  fix: GpsFix,
  now: number,
  reason: 'window' | 'reanchor',
  mode: ModeConfig,
  effects: Effect[],
): EngineState {
  effects.push(telemetry('trigger_fired', stop.id, { index: stop.index, reason }));
  const item: QueueItem = {
    stopId: stop.id,
    firedAt: now,
    firedWhere: fix.coordinate,
    expiresAt: now + mode.queueTtlMs,
  };
  const progress: Progress = { ...s.progress, fired: { ...s.progress.fired, [stop.id]: now } };
  return enqueue({ ...s, progress }, item, mode.whileBusy, mode.maxQueue, now, effects);
}

/** Put a fired stop in line, or straight on air. */
function enqueue(
  s: EngineState,
  item: QueueItem,
  whileBusy: 'preempt' | 'queue',
  maxQueue: number,
  now: number,
  effects: Effect[],
): EngineState {
  if (s.audio.kind === 'idle') return play(s, item.stopId, now, effects);

  if (whileBusy === 'preempt') {
    // Walking: you are standing at the new stop. Older waiting stops are stale.
    for (const q of s.progress.queue) effects.push(telemetry('trigger_expired', q.stopId, { reason: 'preempted' }));
    effects.push({ type: 'STOP', token: audioToken(s.audio), fade: false });
    const cleared: EngineState = { ...s, audio: { kind: 'idle' }, progress: { ...s.progress, queue: [] } };
    return play(cleared, item.stopId, now, effects);
  }

  let queue = [...s.progress.queue, item];
  while (queue.length > maxQueue) {
    const [dropped, ...rest] = queue;
    if (dropped) effects.push(telemetry('trigger_expired', dropped.stopId, { reason: 'queue_full' }));
    queue = rest;
  }
  return { ...s, progress: { ...s.progress, queue } };
}

function play(s: EngineState, stopId: string, now: number, effects: Effect[]): EngineState {
  const token = s.nextToken;
  effects.push({ type: 'PLAY', token, stopId });
  return { ...s, nextToken: token + 1, audio: { kind: 'starting', token, stopId, since: now } };
}

/** When the slot is free, drop what expired and put the next waiting stop on air. */
function startNextIfIdle(s: EngineState, now: number, effects: Effect[]): EngineState {
  if (s.audio.kind !== 'idle') return s;
  const pruned: EngineState = { ...s, progress: pruneQueue(s, now, s.lastFix, effects) };
  const [next, ...rest] = pruned.progress.queue;
  if (!next) return pruned;
  return play({ ...pruned, progress: { ...pruned.progress, queue: rest } }, next.stopId, now, effects);
}

/**
 * Expire waiting stops by time, and by distance when a position is known.
 * Returns the SAME progress object when nothing expired - the persistence
 * check depends on it.
 */
function pruneQueue(s: EngineState, now: number, at: GpsFix | null, effects: Effect[]): Progress {
  const chapter = activeChapter(s);
  const mode = MODE_CONFIG[chapter.transitMode];
  const keep: QueueItem[] = [];
  for (const q of s.progress.queue) {
    const tooOld = now >= q.expiresAt;
    const tooFar = at !== null && planarDistanceMeters(at.coordinate, q.firedWhere) > mode.queueExpireBeyondM;
    if (tooOld || tooFar) {
      effects.push(telemetry('trigger_expired', q.stopId, { reason: tooOld ? 'ttl' : 'distance' }));
    } else {
      keep.push(q);
    }
  }
  return keep.length === s.progress.queue.length ? s.progress : { ...s.progress, queue: keep };
}

/**
 * Everything that depends only on the clock, in a fixed order: a stuck PLAY
 * first (it holds the slot), then a stuck interruption, then queue expiry.
 */
function advanceClock(s: EngineState, now: number, effects: Effect[]): EngineState {
  let next = playTimeout(s, now, effects);
  next = watchdog(next, now, effects);
  const progress = pruneQueue(next, now, next.lastFix, effects);
  return progress === next.progress ? next : { ...next, progress };
}

/**
 * The reducer-side backstop (PM, Epic 15): a PLAY with no AUDIO_STARTED or
 * AUDIO_FAILED after PLAY_TIMEOUT_MS is treated as failed. The STOP for its
 * token is what makes this safe: if the player does start late, the audio
 * shell tears it down instead of letting it talk over the next narration -
 * and its late AUDIO_STARTED carries a dead token, so the reducer ignores it.
 */
function playTimeout(s: EngineState, now: number, effects: Effect[]): EngineState {
  const a = s.audio;
  if (a.kind !== 'starting' || now - a.since < PLAY_TIMEOUT_MS) return s;
  effects.push({ type: 'STOP', token: a.token, fade: false });
  effects.push(telemetry('audio_watchdog', a.stopId, { action: 'play_timeout', heldMs: now - a.since }));
  return startNextIfIdle({ ...s, audio: { kind: 'idle' } }, now, effects);
}

/**
 * An OS interruption that never ends would hold the narration slot forever:
 * the queue behind it would expire stop by stop. After the timeout, ask the
 * player to resume once; after twice the timeout, give the narration up and
 * move on. A USER pause is the user's to end - no watchdog.
 */
function watchdog(s: EngineState, now: number, effects: Effect[]): EngineState {
  const a = s.audio;
  if (a.kind !== 'interrupted' || a.by !== 'os') return s;
  const timeout = MODE_CONFIG[activeChapter(s).transitMode].interruptionTimeoutMs;
  const held = now - a.since;
  if (held >= 2 * timeout) {
    effects.push({ type: 'STOP', token: a.token, fade: false });
    effects.push(telemetry('audio_watchdog', a.stopId, { action: 'gave_up', heldMs: held }));
    return startNextIfIdle({ ...s, audio: { kind: 'idle' } }, now, effects);
  }
  if (held >= timeout && !a.resumeRequested) {
    effects.push({ type: 'RESUME', token: a.token });
    effects.push(telemetry('audio_watchdog', a.stopId, { action: 'resume_requested', heldMs: held }));
    return { ...s, audio: { ...a, resumeRequested: true } };
  }
  return s;
}

// -----------------------------------------------------------------------------
// Chapter and manual control
// -----------------------------------------------------------------------------

/**
 * Manual advance. The narration on air finishes (cutting it would be
 * jarring); stops still WAITING belong to the chapter being left and expire.
 */
function selectChapter(s: EngineState, chapterId: string, effects: Effect[]): EngineState {
  const chapter = chapterOrThrow(s.tour, chapterId);
  if (chapterId === s.progress.chapterId) return s;
  for (const q of s.progress.queue) effects.push(telemetry('trigger_expired', q.stopId, { reason: 'chapter_left' }));
  effects.push({ type: 'APPLY_TRANSIT_MODE', transitMode: chapter.transitMode });
  // lastFix is kept: the next segment is judged against the NEW mode's sweep
  // bounds, so a walking-to-driving switch cannot bridge an implausible gap.
  return {
    ...s,
    progress: { ...s.progress, chapterId, queue: [] },
    reanchor: null,
    bearingReported: new Set(),
  };
}

/**
 * "Play this stop now" (debug trigger, future skip-to). Must be a stop of the
 * ACTIVE chapter - anything else is a caller bug. Takes over whatever plays,
 * in every mode: the user asked. Firing it moves the cursor, so stops before
 * it count as missed, exactly as before Epic 15 (StopSequence.reach).
 */
function manualTrigger(s: EngineState, stopId: string, at: number, effects: Effect[]): EngineState {
  const stop = s.tour.stops.find((st) => st.id === stopId);
  if (!stop) throw new RangeError(`MANUAL_TRIGGER: unknown stop ${stopId}`);
  if (stop.chapterId !== s.progress.chapterId) {
    throw new RangeError(`MANUAL_TRIGGER: stop ${stopId} is not in the active chapter ${s.progress.chapterId}`);
  }
  effects.push(telemetry('trigger_fired', stop.id, { index: stop.index, reason: 'manual' }));
  const fired = stopId in s.progress.fired ? s.progress.fired : { ...s.progress.fired, [stopId]: at };
  // Already waiting in the queue: it plays now, so it must not play again later.
  const queue = s.progress.queue.filter((q) => q.stopId !== stopId);
  const base: EngineState = { ...s, progress: { ...s.progress, fired, queue }, reanchor: null };
  const mode = MODE_CONFIG[activeChapter(s).transitMode];
  return enqueue(
    base,
    { stopId, firedAt: at, firedWhere: s.lastFix?.coordinate ?? zoneAnchor(stop), expiresAt: at + mode.queueTtlMs },
    'preempt',
    mode.maxQueue,
    at,
    effects,
  );
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

export function activeChapter(s: EngineState): EngineChapter {
  return chapterOrThrow(s.tour, s.progress.chapterId);
}

function chapterOrThrow(tour: EngineTour, chapterId: string): EngineChapter {
  const c = tour.chapters.find((ch) => ch.id === chapterId);
  if (!c) throw new RangeError(`unknown chapter ${chapterId}`);
  return c;
}

/** Highest fired index in the chapter, -1 before the first. */
export function cursorOf(s: EngineState, chapterId: string): number {
  let cursor = -1;
  for (const st of s.tour.stops) {
    if (st.chapterId === chapterId && st.id in s.progress.fired && st.index > cursor) cursor = st.index;
  }
  return cursor;
}

/**
 * The chapter's stops the visitor will not hear unless they ask - the
 * post-chapter recap list. At or behind the cursor, never started, and not
 * still waiting or on air: skipped by a re-anchor, or fired and then expired
 * or failed.
 */
export function missedStops(s: EngineState, chapterId: string): EngineStop[] {
  const cursor = cursorOf(s, chapterId);
  const pending = new Set(s.progress.queue.map((q) => q.stopId));
  const onAir = audioStopId(s.audio);
  return s.tour.stops
    .filter(
      (st) =>
        st.chapterId === chapterId &&
        st.index <= cursor &&
        !(st.id in s.progress.played) &&
        !pending.has(st.id) &&
        st.id !== onAir,
    )
    .sort((a, b) => a.index - b.index);
}

function audioStopId(a: AudioState): string | null {
  return a.kind === 'idle' ? null : a.stopId;
}

function audioToken(a: AudioState): number {
  if (a.kind === 'idle') throw new Error('audioToken: no narration on air');
  return a.token;
}

function zoneAnchor(stop: EngineStop): LatLng {
  if (stop.zone.kind === 'radius') return stop.zone.center;
  const first = stop.zone.ring[0];
  if (!first) throw new RangeError(`stop ${stop.id}: empty polygon ring`);
  return first;
}

function telemetry(
  kind: Extract<Effect, { type: 'TELEMETRY' }>['kind'],
  stopId: string | null,
  detail: Record<string, string | number>,
): Effect {
  return { type: 'TELEMETRY', kind, stopId, detail };
}
