/**
 * Epic 15 - the loose-sequence reducer, driven by synthetic GPS traces.
 *
 * Pure: no app modules beyond the engine, no stubs. Scenarios are named for
 * the failure they pin - the window skip / re-anchor recovery, the loop-tour
 * trap, the opposite carriageway, the tunnel gap, stale audio events, the
 * interruption watchdog, and persistence identity.
 *
 * Run:  npm run test:engine
 */

import { MODE_CONFIG } from '../src/engine/config.ts';
import { EARTH_RADIUS_M } from '../src/engine/geo/sweep.ts';
import {
  createEngineState,
  cursorOf,
  freshProgress,
  ingest,
  missedStops,
  progressProblem,
  reduce,
} from '../src/engine/reduce.ts';
import type {
  Effect,
  EngineApproach,
  EngineChapter,
  EngineEvent,
  EngineState,
  EngineStop,
  EngineTour,
  GpsFix,
} from '../src/engine/types.ts';
import type { LatLng, TransitMode } from '../src/types/domain.ts';

let checks = 0;
let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}
function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}
function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    assert(label, false, 'did not throw');
  } catch (e) {
    assert(label, e instanceof RangeError, String(e));
  }
}

// --- geometry helpers ---------------------------------------------------------
const ORIGIN: LatLng = { latitude: 31.5, longitude: 35.0 };
const K = (Math.PI / 180) * EARTH_RADIUS_M;
/** A point `east`/`north` metres from ORIGIN. */
const at = (east: number, north: number): LatLng => ({
  latitude: ORIGIN.latitude + north / K,
  longitude: ORIGIN.longitude + east / (K * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
});

const T0 = 1_800_000_000_000;

function fix(east: number, north: number, t: number, opts: Partial<GpsFix> = {}): GpsFix {
  return { coordinate: at(east, north), timestamp: t, accuracyM: 8, speedMps: null, headingDeg: null, ...opts };
}

/** Drive along y = north from x0 to x1 at `speed` m/s, one fix per second, heading east or west. */
function drive(x0: number, x1: number, north: number, tStart: number, speed: number): GpsFix[] {
  const dir = x1 >= x0 ? 1 : -1;
  const out: GpsFix[] = [];
  const n = Math.floor(Math.abs(x1 - x0) / speed);
  for (let i = 0; i <= n; i++) {
    out.push(fix(x0 + dir * i * speed, north, tStart + i * 1000, { speedMps: speed, headingDeg: dir > 0 ? 90 : 270 }));
  }
  return out;
}

function chapter(id: string, mode: TransitMode, over: Partial<EngineChapter> = {}): EngineChapter {
  return { id, sortOrder: 0, transitMode: mode, sequencePolicy: 'windowed', lookaheadStops: 3, ...over };
}
function stop(id: string, chapterId: string, index: number, east: number, north: number, radiusM: number, approach: EngineApproach | null = null): EngineStop {
  return { id, chapterId, index, zone: { kind: 'radius', center: at(east, north), radiusM }, approach };
}

// --- dispatch harness (what the shell will do, minus I/O) --------------------
interface Run {
  state: EngineState;
  effects: Effect[];
  persists: number;
  /** A well-behaved player: every PLAY is confirmed by AUDIO_STARTED at once. */
  autoAudio: boolean;
}
function start(tour: EngineTour, chapterId: string, autoAudio = true): Run {
  return { state: createEngineState(tour, freshProgress(tour, chapterId)), effects: [], persists: 0, autoAudio };
}
function restore(tour: EngineTour, progress: Parameters<typeof createEngineState>[1], autoAudio = true): Run {
  return { state: createEngineState(tour, progress), effects: [], persists: 0, autoAudio };
}
function send(run: Run, event: EngineEvent): Run {
  const r = reduce(run.state, event);
  let next: Run = {
    ...run,
    state: r.state,
    effects: [...run.effects, ...r.effects],
    persists: run.persists + (r.state.progress !== run.state.progress ? 1 : 0),
  };
  if (run.autoAudio) {
    const now = event.type === 'FIX_BATCH' ? event.receivedAt : event.at;
    for (const e of r.effects) if (e.type === 'PLAY') next = send(next, { type: 'AUDIO_STARTED', token: e.token, at: now });
  }
  return next;
}
const batch = (fixes: GpsFix[], receivedAt?: number): EngineEvent => ({
  type: 'FIX_BATCH',
  fixes,
  receivedAt: receivedAt ?? (fixes[fixes.length - 1]?.timestamp ?? T0) + 200,
});
/** Feed fixes one OS delivery at a time, as the 1 Hz task does. */
function feed(run: Run, fixes: GpsFix[]): Run {
  for (const f of fixes) run = send(run, batch([f]));
  return run;
}
const plays = (r: Run) => r.effects.filter((e): e is Extract<Effect, { type: 'PLAY' }> => e.type === 'PLAY');
const tel = (r: Run, kind: string) => r.effects.filter((e) => e.type === 'TELEMETRY' && e.kind === kind);
const fired = (r: Run) => Object.keys(r.state.progress.fired).sort();

// -----------------------------------------------------------------------------
heading('Window: stops fire in sequence; busy narration queues (driving)');
// -----------------------------------------------------------------------------
{
  // Stops every 1 km, 150 m zones centred 100 m off the road.
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1, 2].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 100, 150)),
  };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 1200, 0, T0, 27.8));
  assert('s0 fired and was put on air', fired(r).join() === 's0' && plays(r).length === 1 && plays(r)[0]?.stopId === 's0');
  const t0 = plays(r)[0]?.token ?? -1;
  assert('AUDIO_STARTED records s0 as played', 's0' in r.state.progress.played && r.state.audio.kind === 'playing');
  r = feed(r, drive(1200, 2200, 0, T0 + 44_000, 27.8));
  assert('s1 fired while s0 plays: QUEUED, not played over it', fired(r).join() === 's0,s1' && r.state.progress.queue.length === 1 && plays(r).length === 1);
  r = send(r, { type: 'AUDIO_ENDED', token: t0, at: T0 + 80_000 });
  assert('s0 ends: s1 goes on air with a NEW token', plays(r).length === 2 && plays(r)[1]?.stopId === 's1' && plays(r)[1]?.token !== t0);
  // ~80 fixes, 5 writes: fire s0, start s0, fire s1, dequeue s1, start s1.
  assert('progress written only when it changes - 5 writes over ~80 fixes', r.persists === 5, `${r.persists} writes`);
}

// -----------------------------------------------------------------------------
heading('Queue expiry: a waiting stop is dropped once it is stale');
// -----------------------------------------------------------------------------
{
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 100, 150)),
  };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 2100, 0, T0, 27.8));
  r = send(r, { type: 'AUDIO_STARTED', token: plays(r)[0]?.token ?? -1, at: T0 + 37_000 });
  assert('s1 waiting behind a long s0', r.state.progress.queue.length === 1);
  // Keep driving 2 km more: s1 fired at ~x=1900, now 1.5 km+ away.
  r = feed(r, drive(2100, 3500, 0, T0 + 76_000, 27.8));
  assert('s1 expired by distance (1.5 km driving)', r.state.progress.queue.length === 0 && tel(r, 'trigger_expired').length === 1);
  r = send(r, { type: 'AUDIO_ENDED', token: plays(r)[0]?.token ?? -1, at: T0 + 130_000 });
  assert('s0 ends: nothing stale is played', plays(r).length === 1 && r.state.audio.kind === 'idle');
  assert('recap lists s1 as missed', missedStops(r.state, 'drive').map((s) => s.id).join() === 's1');
}

// -----------------------------------------------------------------------------
heading('Swept test in the reducer: the 1 Hz blind spot fires');
// -----------------------------------------------------------------------------
{
  // Tangential pass: road 215 m from the centre of a 220 m zone; fixes 100 m apart.
  const tour: EngineTour = { chapters: [chapter('drive', 'driving')], stops: [stop('s0', 'drive', 0, 0, 215, 220)] };
  let r = start(tour, 'drive');
  r = feed(r, [fix(-50, 0, T0, { speedMps: 27.8, headingDeg: 90 }), fix(50, 0, T0 + 3600, { speedMps: 27.8, headingDeg: 90 })]);
  assert('neither fix inside, the segment crosses: s0 fires', fired(r).join() === 's0');
}

// -----------------------------------------------------------------------------
heading('Bearing: the opposite carriageway does not fire; the 360/0 seam does');
// -----------------------------------------------------------------------------
{
  const east: EngineApproach = { bearingDeg: 90, toleranceDeg: 45, policy: 'required' };
  const tour: EngineTour = { chapters: [chapter('drive', 'driving')], stops: [stop('s0', 'drive', 0, 1000, 0, 150, east)] };
  let r = start(tour, 'drive');
  r = feed(r, drive(2000, 0, 0, T0, 27.8)); // westbound
  assert('westbound through an eastbound stop: not fired', fired(r).length === 0);
  assert('rejection reported ONCE, not per fix inside the zone', tel(r, 'trigger_rejected_bearing').length === 1);
  let e = start(tour, 'drive');
  e = feed(e, drive(0, 1200, 0, T0, 27.8));
  assert('eastbound: fired', fired(e).join() === 's0');

  const seam: EngineApproach = { bearingDeg: 355, toleranceDeg: 20, policy: 'required' };
  const north: EngineTour = { chapters: [chapter('drive', 'driving')], stops: [stop('n0', 'drive', 0, 0, 1000, 150, seam)] };
  let n = start(north, 'drive');
  n = feed(n, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40].map((i) =>
    fix(i * 2.4, i * 27.7, T0 + i * 1000, { speedMps: 27.8, headingDeg: 5 })));
  assert('approach 355 +-20, travelling 005: fires across the seam', fired(n).join() === 'n0');
}

// -----------------------------------------------------------------------------
heading('Re-anchor: the visitor skips the whole window');
// -----------------------------------------------------------------------------
{
  // 7 stops 1 km apart on y=0; window K=3 covers s0..s2. The car detours
  // 3 km north past s0..s4 and rejoins the road at x = 5500, heading east
  // through s5 (x=6000).
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1, 2, 3, 4, 5, 6].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 0, 150)),
  };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 5500, 3000, T0, 27.8));
  assert('on the detour: nothing fired, cursor still -1', fired(r).length === 0 && cursorOf(r.state, 'drive') === -1);
  // Rejoin (a curve back down to the road, then east).
  const rejoin = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => fix(5500, 3000 - i * 275, T0 + 200_000 + i * 10_000, { speedMps: 27.5, headingDeg: 180 }));
  r = feed(r, rejoin);
  r = feed(r, drive(5500, 6400, 0, T0 + 320_000, 27.8));
  assert('s5 fired by re-anchor', 's5' in r.state.progress.fired && tel(r, 'trigger_reanchored').length === 1);
  assert('cursor jumped to 5; window is now s6 only', cursorOf(r.state, 'drive') === 5);
  assert('s0..s4 reported missed (one event each)', tel(r, 'trigger_missed').length === 5);
  assert('recap lists s0..s4', missedStops(r.state, 'drive').map((s) => s.id).join() === 's0,s1,s2,s3,s4');
  // Doubling back past s2 must not replay it.
  r = send(r, { type: 'AUDIO_STARTED', token: plays(r)[0]?.token ?? -1, at: T0 + 340_000 });
  r = feed(r, drive(6400, 2500, 0, T0 + 400_000, 27.8));
  assert('doubling back past s2: behind the cursor, never fires', !('s2' in r.state.progress.fired));
}
{
  // Re-anchor needs DWELL: one fix inside a beyond stop is not a detour.
  const tour: EngineTour = {
    chapters: [chapter('walk', 'walking')],
    stops: [0, 1, 2, 3, 4].map((i) => stop(`w${i}`, 'walk', i, 300 * (i + 1), 0, 20)),
  };
  let r = start(tour, 'walk');
  r = feed(r, [fix(1500, -60, T0, { accuracyM: 5 }), fix(1500, -5, T0 + 15_000, { accuracyM: 5 }), fix(1500, -60, T0 + 30_000, { accuracyM: 5 })]);
  assert('walking: in and out of beyond stop w4 within 2 fixes - no jump (needs 3)', fired(r).length === 0 && r.state.reanchor === null);
  r = feed(r, [fix(1500, -5, T0 + 45_000, { accuracyM: 5 }), fix(1500, 0, T0 + 50_000, { accuracyM: 5 }), fix(1500, 5, T0 + 55_000, { accuracyM: 5 })]);
  assert('walking: entered and stayed 3 fixes - jump to w4', 'w4' in r.state.progress.fired);
}
{
  // The loop-tour trap: the LAST stop sits beside the start.
  const tour: EngineTour = {
    chapters: [chapter('walk', 'walking')],
    stops: [
      stop('start', 'walk', 0, 60, 0, 20),
      stop('mid1', 'walk', 1, 400, 0, 20),
      stop('mid2', 'walk', 2, 400, 400, 20),
      stop('mid3', 'walk', 3, 0, 400, 20),
      stop('end', 'walk', 4, 0, 0, 25),
    ],
  };
  let r = start(tour, 'walk');
  // Standing inside `end` at the start, several fixes.
  r = feed(r, [0, 1, 2, 3, 4].map((i) => fix(0, 1 + i * 0.5, T0 + i * 5000, { accuracyM: 5 })));
  assert('standing in the final stop at the start: no jump (no entry from outside)', fired(r).length === 0);
  // Same trap with the first stop 300 m away - beyond the off-plan
  // suppression radius, so the ENTRY rule alone must hold.
  const far: EngineTour = {
    chapters: [chapter('walk', 'walking')],
    stops: [
      stop('first', 'walk', 0, 300, 0, 20),
      stop('m1', 'walk', 1, 300, 300, 20),
      stop('m2', 'walk', 2, 0, 300, 20),
      stop('m3', 'walk', 3, -300, 300, 20),
      stop('last', 'walk', 4, 0, 0, 25),
    ],
  };
  let f = start(far, 'walk');
  f = feed(f, [0, 1, 2, 3, 4].map((i) => fix(0, 1 + i * 0.5, T0 + i * 5000, { accuracyM: 5 })));
  assert('first stop 300 m away, standing in the last: still no jump (entry rule alone)', fired(f).length === 0);
  // Walk out of `end`, around, and back through it on the way to `start`.
  let q = start(tour, 'walk');
  q = feed(q, [fix(-60, 0, T0, { accuracyM: 5 }), ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => fix(-40 + i * 6, 0, T0 + (i + 1) * 5000, { accuracyM: 5 }))]);
  assert('walking through `end` towards `start`: suppressed (start is 60 m away) - no jump', !('end' in q.state.progress.fired));
  q = feed(q, [0, 1, 2, 3, 4, 5].map((i) => fix(36 + i * 4, 0, T0 + 70_000 + i * 5000, { accuracyM: 5 })));
  assert('...and `start` fires normally', fired(q).join() === 'start');
}
{
  // strict = window of one.
  const tour: EngineTour = {
    chapters: [chapter('walk', 'walking', { sequencePolicy: 'strict', lookaheadStops: 3 })],
    stops: [stop('a', 'walk', 0, 500, 0, 20), stop('b', 'walk', 1, 100, 0, 20)],
  };
  // Walk through b (x 80..120) - 400 m from a, so not "on plan".
  let r = start(tour, 'walk');
  r = feed(r, [0, 1].map((i) => fix(i * 5 + 70, 0, T0 + i * 4000, { accuracyM: 5 })));
  assert('strict: one fix into the 2nd stop fires nothing (window = next stop only)', fired(r).length === 0);
  r = feed(r, [2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => fix(i * 5 + 70, 0, T0 + i * 4000, { accuracyM: 5 })));
  const firedB = tel(r, 'trigger_fired')[0];
  assert(
    'strict: dwelling in it re-anchors - b fires as a JUMP, not a window hit',
    fired(r).join() === 'b' && firedB?.type === 'TELEMETRY' && firedB.detail.reason === 'reanchor',
  );
  assert('strict: a, skipped, is missed', missedStops(r.state, 'walk').map((s) => s.id).join() === 'a');
}

// -----------------------------------------------------------------------------
heading('Fix hygiene: ingest, tunnel gap, accuracy ceiling');
// -----------------------------------------------------------------------------
{
  const f = (t: number) => fix(0, 0, t);
  const got = ingest([f(T0 + 3000), f(T0 + 1000), f(T0 + 2000), f(T0 + 2000)], T0 + 3500, null).map((x) => x.timestamp - T0);
  assert('batch sorted by fix time, duplicates dropped', got.join() === '1000,2000,3000', got.join());
  assert('older than the last accepted fix: dropped', ingest([f(T0 + 500)], T0 + 600, f(T0 + 1000)).length === 0);
  assert('stamped 10 s in the future: dropped', ingest([f(T0 + 10_000)], T0, null).length === 0);
  assert('11 minutes old: dropped', ingest([f(T0)], T0 + 11 * 60_000, null).length === 0);
  assert('NaN coordinate: dropped', ingest([{ ...f(T0), coordinate: { latitude: Number.NaN, longitude: 0 } }], T0 + 1, null).length === 0);
}
{
  // Tunnel: 2 km without a fix. The straight chord passes a stop the road
  // does not - it must not fire from the chord.
  const tour: EngineTour = { chapters: [chapter('drive', 'driving')], stops: [stop('s0', 'drive', 0, 1000, 0, 150)] };
  let r = start(tour, 'drive');
  r = feed(r, [fix(0, 0, T0, { speedMps: 27.8, headingDeg: 90 }), fix(2000, 0, T0 + 72_000, { speedMps: 27.8, headingDeg: 90 })]);
  assert('2 km gap: not swept, the stop on the chord does not fire', fired(r).length === 0);
  let a = start(tour, 'drive');
  a = feed(a, [fix(0, 0, T0), fix(990, 0, T0 + 1000, { accuracyM: 200 }), fix(1010, 0, T0 + 2000, { accuracyM: 200 })]);
  assert('fixes worse than the ceiling are ignored, even inside the zone', fired(a).length === 0 && a.state.lastFix?.timestamp === T0);
}

// -----------------------------------------------------------------------------
heading('Audio: tokens, preemption, walking exits');
// -----------------------------------------------------------------------------
{
  const tour: EngineTour = {
    chapters: [chapter('walk', 'walking')],
    stops: [stop('a', 'walk', 0, 50, 0, 20), stop('b', 'walk', 1, 120, 0, 20)],
  };
  let r = start(tour, 'walk');
  r = feed(r, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].map((i) => fix(i * 5, 0, T0 + i * 4000, { accuracyM: 5 })));
  const [pa, pb] = plays(r);
  assert('walking: a then b both put on air (b preempts)', pa?.stopId === 'a' && pb?.stopId === 'b');
  const stopA = r.effects.find((e) => e.type === 'STOP' && e.token === pa?.token);
  assert('a was stopped (zone exit fade or preemption) before b played', stopA !== undefined);
  const before = r.state;
  r = send(r, { type: 'AUDIO_ENDED', token: pa?.token ?? -1, at: T0 + 200_000 });
  assert('stale AUDIO_ENDED for a: ignored - the reducer returns the very same state', r.state === before);
  r = send(r, { type: 'AUDIO_STARTED', token: pb?.token ?? -1, at: T0 + 120_000 });
  r = feed(r, [fix(120 + 40, 0, T0 + 140_000, { accuracyM: 5 })]);
  const fadeB = r.effects.find((e) => e.type === 'STOP' && e.token === pb?.token);
  assert('walking: leaving b beyond 1.6 x radius fades it out', fadeB !== undefined && fadeB.type === 'STOP' && fadeB.fade);
}
{
  // Driving: leaving the zone never stops the narration.
  const tour: EngineTour = { chapters: [chapter('drive', 'driving')], stops: [stop('s0', 'drive', 0, 1000, 0, 150)] };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 1100, 0, T0, 27.8));
  r = send(r, { type: 'AUDIO_STARTED', token: plays(r)[0]?.token ?? -1, at: T0 + 40_000 });
  r = feed(r, drive(1100, 2500, 0, T0 + 41_000, 27.8));
  assert('driving: 1.4 km past the stop, still playing', r.state.audio.kind === 'playing' && !r.effects.some((e) => e.type === 'STOP'));
}

// -----------------------------------------------------------------------------
heading('Interruptions (iOS doNotMix) and the watchdog');
// -----------------------------------------------------------------------------
{
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 0, 150)),
  };
  const timeout = MODE_CONFIG.driving.interruptionTimeoutMs;
  let r = start(tour, 'drive', false);
  // Stop feeding as s0 fires, so the prompt lands inside the 5 s PLAY window.
  r = feed(r, drive(0, 880, 0, T0, 27.8));
  const tok = plays(r)[0]?.token ?? -1;
  r = send(r, { type: 'AUDIO_INTERRUPTED', token: tok, at: T0 + 32_500, by: 'os' });
  assert('Google Maps prompt while the player loads: interrupted', r.state.audio.kind === 'interrupted');
  r = send(r, { type: 'AUDIO_STARTED', token: tok, at: T0 + 33_000 });
  assert('STARTED after the interruption still records played, stays interrupted', 's0' in r.state.progress.played && r.state.audio.kind === 'interrupted');
  r = send(r, { type: 'AUDIO_RESUMED', token: tok, at: T0 + 36_000 });
  assert('prompt over: playing again (same narration, same token)', r.state.audio.kind === 'playing' && r.state.audio.token === tok);

  r = send(r, { type: 'AUDIO_INTERRUPTED', token: tok, at: T0 + 50_000, by: 'os' });
  r = feed(r, drive(900, 2050, 0, T0 + 51_000, 27.8));
  assert('s1 fires during the interruption: queued, not played over the paused s0', r.state.progress.queue.length === 1 && plays(r).length === 1);
  r = send(r, { type: 'TICK', at: T0 + 50_000 + timeout });
  assert('watchdog at the timeout: ONE resume request', r.effects.filter((e) => e.type === 'RESUME').length === 1);
  r = send(r, { type: 'TICK', at: T0 + 50_000 + timeout + 5_000 });
  assert('...not repeated on the next tick', r.effects.filter((e) => e.type === 'RESUME').length === 1);
  r = send(r, { type: 'TICK', at: T0 + 50_000 + 2 * timeout });
  assert('watchdog at twice the timeout: s0 given up, slot freed', r.state.audio.kind !== 'interrupted' && r.effects.some((e) => e.type === 'STOP' && e.token === tok));

  let u = start(tour, 'drive');
  u = feed(u, drive(0, 1100, 0, T0, 27.8));
  u = send(u, { type: 'AUDIO_INTERRUPTED', token: plays(u)[0]?.token ?? -1, at: T0 + 39_000, by: 'user' });
  u = send(u, { type: 'TICK', at: T0 + 39_000 + 10 * timeout });
  assert('a USER pause is never auto-resumed or given up', u.state.audio.kind === 'interrupted' && !u.effects.some((e) => e.type === 'RESUME' || e.type === 'STOP'));
}

// -----------------------------------------------------------------------------
heading('Persistence identity, restore, chapters, manual trigger');
// -----------------------------------------------------------------------------
{
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving'), chapter('walk', 'walking', { sortOrder: 1 })],
    stops: [stop('d0', 'drive', 0, 1000, 0, 150), stop('d1', 'drive', 1, 2000, 0, 150), stop('w0', 'walk', 0, 5000, 0, 20)],
  };
  let r = start(tour, 'drive');
  const p0 = r.state.progress;
  r = feed(r, drive(0, 500, 0, T0, 27.8));
  assert('18 fixes that change nothing: SAME progress object (no write)', r.state.progress === p0 && r.persists === 0);

  r = feed(r, drive(500, 2100, 0, T0 + 20_000, 27.8));
  assert('d0 on air, d1 queued', r.state.audio.kind === 'playing' && r.state.progress.queue.length === 1);
  r = send(r, { type: 'CHAPTER_SELECTED', chapterId: 'walk', at: T0 + 80_000 });
  assert('chapter switch: waiting d1 expires, transit mode applied (walking)', r.state.progress.queue.length === 0 && r.effects.some((e) => e.type === 'APPLY_TRANSIT_MODE' && e.transitMode === 'walking'));
  assert('...and the narration on air is NOT cut', r.state.audio.kind === 'playing' && !r.effects.some((e) => e.type === 'STOP'));
  throws('unknown chapter throws', () => reduce(r.state, { type: 'CHAPTER_SELECTED', chapterId: 'nope', at: T0 }));
  throws('manual trigger of another chapter\'s stop throws', () => reduce(r.state, { type: 'MANUAL_TRIGGER', stopId: 'd1', at: T0 }));

  // Restore: a checkpoint with d1 still waiting, written 30 s ago.
  const saved = { chapterId: 'drive', fired: { d0: T0, d1: T0 + 30_000 }, played: { d0: T0 + 1000 }, queue: [{ stopId: 'd1', firedAt: T0 + 30_000, firedWhere: at(2000, 0), expiresAt: T0 + 90_000 }] };
  let back = restore(tour, saved);
  back = send(back, { type: 'SESSION_STARTED', at: T0 + 60_000 });
  assert('resume within the TTL: the waiting stop plays', plays(back).some((p) => p.stopId === 'd1'));
  let late = restore(tour, saved);
  late = send(late, { type: 'SESSION_STARTED', at: T0 + 120_000 });
  assert('resume after the TTL: expired, not played', plays(late).length === 0 && tel(late, 'trigger_expired').length === 1);
  assert('progressProblem: queued-but-played is refused', progressProblem(tour, { ...saved, played: { d0: 1, d1: 2 } }) !== null);
  assert('progressProblem: unknown stop is refused', progressProblem(tour, { ...saved, fired: { ...saved.fired, ghost: 1 } }) !== null);
  throws('createEngineState refuses a progress that does not fit the tour', () => createEngineState(tour, { ...saved, chapterId: 'gone' }));

  // Manual trigger of a stop already waiting: plays now, never again later.
  let m = restore(tour, saved);
  m = send(m, { type: 'MANUAL_TRIGGER', stopId: 'd1', at: T0 + 40_000 });
  assert('manual trigger of a queued stop: on air, and removed from the queue', plays(m).at(-1)?.stopId === 'd1' && m.state.progress.queue.length === 0);
}

// -----------------------------------------------------------------------------
heading('Heartbeat: the PLAY timeout backstop and clock-only expiry');
// -----------------------------------------------------------------------------
{
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 0, 150)),
  };
  // s0 fires; keep driving into s1 so it queues behind a PLAY that never answers.
  let r = start(tour, 'drive', false);
  r = feed(r, [fix(800, 0, T0, { speedMps: 27.8, headingDeg: 90 }), fix(850, 0, T0 + 1000, { speedMps: 27.8, headingDeg: 90 })]);
  r = feed(r, [fix(870, 0, T0 + 1700, { speedMps: 27.8, headingDeg: 90 }), fix(1860, 0, T0 + 1900, { speedMps: 27.8, headingDeg: 90 })]);
  r = feed(r, [fix(1880, 0, T0 + 2600, { speedMps: 27.8, headingDeg: 90 })]);
  const t0 = plays(r)[0]?.token ?? -1;
  // When the PLAY was issued, read from the state rather than assumed.
  const issued = r.state.audio.kind === 'starting' ? r.state.audio.since : Number.NaN;
  assert('s0 PLAY issued, s1 waiting', r.state.audio.kind === 'starting' && r.state.progress.queue.length === 1, `${r.state.audio.kind} q=${r.state.progress.queue.length}`);
  r = send(r, { type: 'TICK', at: issued + 4_999 });
  assert('4.999 s: still waiting for the player', r.state.audio.kind === 'starting' && !r.effects.some((e) => e.type === 'STOP'));
  r = send(r, { type: 'TICK', at: issued + 5_000 });
  const stopped = r.effects.find((e) => e.type === 'STOP' && e.token === t0);
  assert('5 s: s0 abandoned - STOP for its token, so a late player is torn down', stopped !== undefined);
  assert('...the slot is freed and s1 goes on air', plays(r).at(-1)?.stopId === 's1' && r.state.audio.kind === 'starting');
  assert('...reported as play_timeout', tel(r, 'audio_watchdog').some((e) => e.type === 'TELEMETRY' && e.detail.action === 'play_timeout'));
  const afterTimeout = r.state;
  r = send(r, { type: 'AUDIO_STARTED', token: t0, at: issued + 6_000 });
  assert('a LATE AUDIO_STARTED for s0 is ignored (dead token)', r.state === afterTimeout && !('s0' in r.state.progress.played));
  assert('recap lists s0 (fired, never heard)', missedStops(r.state, 'drive').map((s) => s.id).join() === 's0');
}
{
  // Parked: no fixes at all. Only the heartbeat expires the waiting stop.
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 0, 150)),
  };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 2050, 0, T0, 27.8));
  assert('s0 playing, s1 waiting', r.state.audio.kind === 'playing' && r.state.progress.queue.length === 1);
  const expiresAt = r.state.progress.queue[0]?.expiresAt ?? 0;
  r = send(r, { type: 'TICK', at: expiresAt - 1 });
  assert('parked, 1 ms before the TTL: s1 still waiting', r.state.progress.queue.length === 1);
  r = send(r, { type: 'TICK', at: expiresAt });
  assert('parked, at the TTL: s1 expired by the heartbeat alone', r.state.progress.queue.length === 0 && tel(r, 'trigger_expired').length === 1);
  const quiet = r.state.progress;
  r = send(r, { type: 'TICK', at: expiresAt + 1000 });
  assert('a TICK that changes nothing writes nothing (same progress)', r.state.progress === quiet);
}
{
  // FIX_BATCH is a heartbeat too: the play timeout fires on a fix, no TICK needed.
  const tour: EngineTour = { chapters: [chapter('drive', 'driving')], stops: [stop('s0', 'drive', 0, 1000, 0, 150)] };
  let r = start(tour, 'drive', false);
  r = feed(r, drive(0, 900, 0, T0, 27.8));
  const t0 = plays(r)[0]?.token ?? -1;
  r = feed(r, drive(900, 1200, 0, T0 + 33_000, 27.8));
  assert('Android background (no TICKs): the fix stream alone times out the PLAY', r.effects.some((e) => e.type === 'STOP' && e.token === t0));
}

// -----------------------------------------------------------------------------
heading('Deep Dive and user skip');
// -----------------------------------------------------------------------------
{
  const tour: EngineTour = {
    chapters: [chapter('walk', 'walking')],
    stops: [stop('a', 'walk', 0, 50, 0, 20), stop('b', 'walk', 1, 300, 0, 20)],
  };
  let r = start(tour, 'walk');
  r = feed(r, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => fix(i * 5, 0, T0 + i * 4000, { accuracyM: 5 })));
  const narration = plays(r)[0];
  assert('a narrates', narration?.stopId === 'a' && narration.track === 'narration');
  r = send(r, { type: 'DEEP_DIVE_REQUESTED', stopId: 'a', at: T0 + 45_000 });
  const dd = plays(r).at(-1);
  assert('Deep Dive displaces the narration (STOP preempted) and goes on air', dd?.track === 'deep_dive' && r.effects.some((e) => e.type === 'STOP' && e.token === narration?.token && e.reason === 'preempted'));
  assert('a Deep Dive marks nothing new as played', Object.keys(r.state.progress.played).join() === 'a');
  r = feed(r, [fix(120, 0, T0 + 60_000, { accuracyM: 5 }), fix(150, 0, T0 + 70_000, { accuracyM: 5 })]);
  assert('walking away from a: the Deep Dive is NOT faded (it survives the zone exit)', !r.effects.some((e) => e.type === 'STOP' && e.token === dd?.token));
  r = feed(r, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30].map((i) => fix(160 + i * 5, 0, T0 + 80_000 + i * 4000, { accuracyM: 5 })));
  assert('...but reaching a DIFFERENT stop displaces it (walking preempts)', r.effects.some((e) => e.type === 'STOP' && e.token === dd?.token && e.reason === 'preempted') && plays(r).at(-1)?.stopId === 'b');
  throws('a Deep Dive for a stop outside the active chapter throws', () => reduce(r.state, { type: 'DEEP_DIVE_REQUESTED', stopId: 'nope', at: T0 }));
}
{
  // Driving: the listener skips; the waiting stop follows.
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 0, 150)),
  };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 2050, 0, T0, 27.8));
  const first = plays(r)[0];
  r = send(r, { type: 'USER_SKIP', at: T0 + 76_000 });
  assert('user skip: STOP reason user_skip, and the waiting s1 goes on air', r.effects.some((e) => e.type === 'STOP' && e.token === first?.token && e.reason === 'user_skip') && plays(r).at(-1)?.stopId === 's1');
  const idle = start(tour, 'drive');
  assert('user skip with nothing on air: nothing happens', reduce(idle.state, { type: 'USER_SKIP', at: T0 }).effects.length === 0);
}

// -----------------------------------------------------------------------------
heading('Idle timeout: 15 minutes still suspends the tour (battery)');
// -----------------------------------------------------------------------------
{
  const MIN = 60_000;
  const tour: EngineTour = {
    chapters: [chapter('walk', 'walking')],
    stops: [stop('a', 'walk', 0, 500, 0, 20), stop('b', 'walk', 1, 1000, 0, 20)],
  };
  /** Sitting at a cafe: a fix every 30 s, wandering inside 25 m, accuracy 15 m. */
  const sit = (run: Run, fromMin: number, toMin: number, east = 0): Run => {
    for (let t = fromMin * MIN; t <= toMin * MIN; t += 30_000) {
      run = feed(run, [fix(east + ((t / 30_000) % 5) * 5, ((t / 30_000) % 3) * 5, T0 + t, { accuracyM: 15 })]);
    }
    return run;
  };
  const suspends = (r: Run) => r.effects.filter((e) => e.type === 'SUSPEND_TRACKING').length;

  let r = start(tour, 'walk');
  r = sit(r, 0, 14.5);
  assert('14.5 min still: still tracking', suspends(r) === 0 && r.state.progress.suspendedAt === undefined);
  r = sit(r, 15, 15.5);
  assert('15 min still: SUSPEND_TRACKING, once', suspends(r) === 1, `${suspends(r)}`);
  assert('...suspendedAt persisted, reported as tour_suspended', r.state.progress.suspendedAt !== undefined && tel(r, 'tour_suspended').length === 1);
  r = sit(r, 16, 20);
  assert('...and not again while suspended', suspends(r) === 1);
  r = feed(r, [fix(500, 0, T0 + 21 * MIN, { accuracyM: 5 }), fix(502, 0, T0 + 21 * MIN + 2000, { accuracyM: 5 })]);
  assert('a late fix inside a zone while suspended fires nothing', Object.keys(r.state.progress.fired).length === 0);

  r = send(r, { type: 'RESUME_REQUESTED', at: T0 + 22 * MIN });
  assert('resume: RESUME_TRACKING, suspension cleared, tour_resumed', r.effects.some((e) => e.type === 'RESUME_TRACKING') && r.state.progress.suspendedAt === undefined && tel(r, 'tour_resumed').length === 1);
  assert('...the next fix is a fresh start, not a sweep from before', r.state.lastFix === null);
  r = feed(r, [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => fix(470 + i * 5, 0, T0 + 23 * MIN + i * 4000, { accuracyM: 5 })));
  assert('...and stops fire again', 'a' in r.state.progress.fired);
}
{
  const MIN = 60_000;
  const tour: EngineTour = { chapters: [chapter('walk', 'walking')], stops: [stop('a', 'walk', 0, 5000, 0, 20)] };
  let r = start(tour, 'walk');
  for (let m = 0; m <= 10; m++) r = feed(r, [fix(0, 0, T0 + m * MIN, { accuracyM: 10 })]);
  r = feed(r, [fix(100, 0, T0 + 10.5 * MIN, { accuracyM: 10 })]);
  for (let m = 11; m <= 24; m++) r = feed(r, [fix(100, 0, T0 + m * MIN, { accuracyM: 10 })]);
  assert('moving 100 m at minute 10 restarts the clock: no suspension at 15 or 24', !r.effects.some((e) => e.type === 'SUSPEND_TRACKING'));
  // The move was RECEIVED 200 ms after its fix time; the clock is the shell's.
  r = send(r, { type: 'TICK', at: T0 + 25.5 * MIN + 200 });
  assert('...15 min after the move, a bare TICK suspends (no fix needed)', r.effects.some((e) => e.type === 'SUSPEND_TRACKING'));
}
{
  // A narration actually playing is never cut for inactivity.
  const MIN = 60_000;
  const tour: EngineTour = { chapters: [chapter('walk', 'walking')], stops: [stop('a', 'walk', 0, 0, 0, 30)] };
  let r = start(tour, 'walk');
  r = feed(r, [fix(0, 0, T0, { accuracyM: 5 })]);
  const tok = plays(r)[0]?.token ?? -1;
  assert('standing in a stop: its narration plays', r.state.audio.kind === 'playing');
  for (let m = 1; m <= 16; m++) r = send(r, { type: 'TICK', at: T0 + m * MIN });
  assert('16 min still, narration (a long Deep Dive) still playing: NOT suspended', !r.effects.some((e) => e.type === 'SUSPEND_TRACKING'));
  r = send(r, { type: 'AUDIO_ENDED', token: tok, at: T0 + 17 * MIN });
  r = send(r, { type: 'TICK', at: T0 + 17 * MIN + 1000 });
  assert('...it ends: suspended on the next tick', r.effects.some((e) => e.type === 'SUSPEND_TRACKING'));

  let p = start(tour, 'walk');
  p = feed(p, [fix(0, 0, T0, { accuracyM: 5 })]);
  const ptok = plays(p)[0]?.token ?? -1;
  p = send(p, { type: 'AUDIO_INTERRUPTED', token: ptok, at: T0 + 1000, by: 'user' });
  p = send(p, { type: 'TICK', at: T0 + 15 * MIN + 1000 });
  assert('paused by the listener and left: STOP idle_timeout, then suspended', p.effects.some((e) => e.type === 'STOP' && e.token === ptok && e.reason === 'idle_timeout') && p.effects.some((e) => e.type === 'SUSPEND_TRACKING'));
  p = send(p, { type: 'MANUAL_TRIGGER', stopId: 'a', at: T0 + 20 * MIN });
  assert('a tap on a stop while suspended resumes tracking AND plays it', p.effects.some((e) => e.type === 'RESUME_TRACKING') && plays(p).at(-1)?.stopId === 'a');
}
{
  // Driving: stuck behind an accident with a stop waiting - it expires on suspension.
  const MIN = 60_000;
  const tour: EngineTour = {
    chapters: [chapter('drive', 'driving')],
    stops: [0, 1].map((i) => stop(`s${i}`, 'drive', i, 1000 * (i + 1), 0, 150)),
  };
  let r = start(tour, 'drive');
  r = feed(r, drive(0, 2000, 0, T0, 27.8));
  const tok = plays(r)[0]?.token ?? -1;
  r = send(r, { type: 'AUDIO_INTERRUPTED', token: tok, at: T0 + 73_000, by: 'user' });
  assert('setup: s1 waiting behind a paused s0', r.state.progress.queue.length === 1);
  for (let m = 2; m <= 18; m++) r = feed(r, [fix(2000, 0, T0 + m * MIN, { speedMps: 0, headingDeg: -1, accuracyM: 10 })]);
  // Queue TTLs (<= 2 min) always beat the 15 min idle timeout: the waiting stop
  // expired on its own long before, so suspension has nothing left to expire.
  assert('the waiting stop expired on its TTL minutes before the suspension', r.effects.some((e) => e.type === 'TELEMETRY' && e.kind === 'trigger_expired' && e.detail.reason === 'ttl'));
  assert('...and the paused narration is stopped as the tour suspends', r.state.progress.suspendedAt !== undefined && r.effects.some((e) => e.type === 'STOP' && e.token === tok && e.reason === 'idle_timeout'));
}
{
  // Restored suspended: the checkpoint brings the suspension back.
  const tour: EngineTour = { chapters: [chapter('walk', 'walking')], stops: [stop('a', 'walk', 0, 0, 0, 30)] };
  let r = restore(tour, { chapterId: 'walk', fired: {}, played: {}, queue: [], suspendedAt: T0 });
  r = feed(r, [fix(0, 0, T0 + 60_000, { accuracyM: 5 })]);
  assert('restored while suspended: a fix inside a stop fires nothing', Object.keys(r.state.progress.fired).length === 0 && plays(r).length === 0);
  r = send(r, { type: 'RESUME_REQUESTED', at: T0 + 120_000 });
  r = feed(r, [fix(0, 0, T0 + 121_000, { accuracyM: 5 })]);
  assert('...resumed: it fires', 'a' in r.state.progress.fired);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
