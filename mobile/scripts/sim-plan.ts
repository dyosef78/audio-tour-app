/**
 * sim:plan - Epic 16 end to end: a PLANNED day across two tours.
 *
 * The REAL plan path, with only the outside world simulated:
 *
 *   plan JSON -> parsePlanTourOk -> planProblem/engineTourFromPlan (two
 *   manifests) -> EngineRunner (reduce, persist a v3 checkpoint into a real
 *   TourProgressRepository) -> AudioActor -> a simulated player
 *
 * on a simulated clock with a 1 Hz heartbeat and a 1 Hz GPS trace:
 *
 *   transfer 1  DRIVE from the origin to Old Town      -> arrival, start it by hand
 *   Old Town    a1 THE PLAZA (core)                    -> narrates
 *     (tour A)  a2 kept extension                      -> narrates
 *               a3 DROPPED extension, on the path      -> never armed, never fires
 *               a4 transition, a5 core                 -> narrate
 *               b1's zone (tour B, same plaza)         -> not armed: another chapter
 *   transfer 2  DRIVE to the Market chapter            -> the app is KILLED halfway:
 *                                                         resumed from the v3
 *                                                         checkpoint, arrival, start
 *   Market      b0 (core, 120 s narration)             -> narrates...
 *     (tour B)  b1 THE PLAZA again, 8 m from a1        -> SILENT (silent_stop_ids):
 *                                                         fires, counts as heard,
 *                                                         no PLAY, b0 keeps playing
 *               b2, b3                                 -> narrate
 *
 * Deterministic, no network. The Expo stubs are loaded only for
 * expo-location's Accuracy enum (transitProfiles.ts). CI runs it (npm run sim:plan).
 */

import { parsePlanTourOk } from '../../shared/src/contracts/planTour.ts';
import { finestMode } from '../src/config/transitProfiles.ts';
import { engineTourFromPlan, planProblem, TRANSFER_CHAPTER_PREFIX } from '../src/engine/fromPlan.ts';
import { createEngineState, freshProgress, progressProblem } from '../src/engine/reduce.ts';
import { EARTH_RADIUS_M } from '../src/engine/geo/sweep.ts';
import type { Effect, EngineState, GpsFix, Progress } from '../src/engine/types.ts';
import { AudioActor, type NarrationPlayer } from '../src/services/audio/AudioActor.ts';
import type { PlaybackError, PlaybackSnapshot } from '../src/services/audio/AudioService.ts';
import type { WireBundle, WireWaypoint } from '../src/services/bundle/types.ts';
import { EngineRunner } from '../src/session/EngineRunner.ts';
import { createProgressRepository, type TourProgressSnapshot } from '../src/session/progressRepository.ts';
import type { CheckpointIO } from '../src/session/sessionCheckpoint.ts';
import { planSessionKey } from '../src/session/sessionKey.ts';
import { engineEventTourId } from '../src/session/telemetryAttribution.ts';
import type { AudioTrack, LatLng, Waypoint } from '../src/types/domain.ts';

// -----------------------------------------------------------------------------
// The world: two tours that share a plaza
// -----------------------------------------------------------------------------

const ORIGIN: LatLng = { latitude: 32.06, longitude: 34.77 };
const K = (Math.PI / 180) * EARTH_RADIUS_M;
const at = (east: number, north: number): LatLng => ({
  latitude: ORIGIN.latitude + north / K,
  longitude: ORIGIN.longitude + east / (K * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
});
const lonLat = (east: number, north: number): [number, number] => {
  const p = at(east, north);
  return [p.longitude, p.latitude];
};
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const TOUR_A = uuid(0xa), TOUR_B = uuid(0xb);
const CH_A = uuid(0xa0), CH_B = uuid(0xb0);
const PLAN_ID = uuid(0x500);
const T0 = 1_800_000_000_000;

const ids = {
  a1: uuid(0xa1), a2: uuid(0xa2), a3: uuid(0xa3), a4: uuid(0xa4), a5: uuid(0xa5),
  b0: uuid(0xb10), b1: uuid(0xb11), b2: uuid(0xb12), b3: uuid(0xb13),
};
const nameOf = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
const n = (id: string | null | undefined): string => (id ? nameOf.get(id) ?? id : '-');

function stop(id: string, sort: number, chapter: string, east: number, north: number, radius: number, seconds: number, role: 'core' | 'extension' = 'core', poi = 'anchor'): WireWaypoint {
  return {
    waypoint_id: id, name: n(id), poi_type: poi, stop_role: role, sort_order: sort,
    coordinates: lonLat(east, north),
    geofence: { type: 'radius', radius_meters: radius, center: lonLat(east, north) },
    media: { storage_path: `sim/${n(id)}.m4a`, duration_seconds: seconds, size_bytes: 1, format: 'm4a' },
    chapter_id: chapter, approach: null,
  };
}

const manifestA: WireBundle = {
  bundle_version_hash: 'hashA',
  tour_metadata: { tour_id: TOUR_A, title: 'Old Town', topology: 'loop', transit_mode: 'walking', duration_minutes: 60 },
  chapters: [{ chapter_id: CH_A, sort_order: 0, title: 'Old Town', transit_mode: 'walking', sequence_policy: 'windowed', lookahead_stops: 3, handoff: null }],
  waypoints: [
    stop(ids.a1, 1, CH_A, 0, 0, 25, 40), // THE PLAZA
    stop(ids.a2, 2, CH_A, 0, 150, 25, 40, 'extension'), // kept
    stop(ids.a3, 3, CH_A, 0, 250, 25, 40, 'extension'), // dropped - and on the path
    stop(ids.a4, 4, CH_A, 100, 300, 20, 15, 'core', 'transition'),
    stop(ids.a5, 5, CH_A, 200, 300, 25, 40),
  ],
};
const manifestB: WireBundle = {
  bundle_version_hash: 'hashB',
  tour_metadata: { tour_id: TOUR_B, title: 'Market', topology: 'loop', transit_mode: 'walking', duration_minutes: 60 },
  chapters: [{ chapter_id: CH_B, sort_order: 0, title: 'Market', transit_mode: 'walking', sequence_policy: 'windowed', lookahead_stops: 3, handoff: null }],
  waypoints: [
    stop(ids.b0, 1, CH_B, 0, -45, 40, 120), // long narration, zone overlapping the plaza's
    stop(ids.b1, 2, CH_B, 0, 8, 25, 40), // THE PLAZA again, 8 m from a1 -> silent
    stop(ids.b2, 3, CH_B, 0, 200, 25, 30),
    stop(ids.b3, 4, CH_B, 150, 200, 25, 30),
  ],
};
const manifests = new Map([[TOUR_A, manifestA], [TOUR_B, manifestB]]);

const ENTRY_A: [number, number] = [-50, 0];
const EXIT_A: [number, number] = [250, 300];
const ENTRY_B: [number, number] = [0, -150];
const EXIT_B: [number, number] = [200, 200];
const pt = ([e, nn]: [number, number]) => {
  const p = at(e, nn);
  return { lon: p.longitude, lat: p.latitude };
};

// The plan, as plan-tour v4 would send it - parsed by the app's own parser.
const plan = parsePlanTourOk({
  status: 'ok', contract_version: 1, plan_id: PLAN_ID, planner_version: 'v4', content_hash: 'c'.repeat(32), expires_at: '2026-11-05T00:00:00Z',
  sources: [{ tour_id: TOUR_A, bundle_version_hash: 'hashA' }, { tour_id: TOUR_B, bundle_version_hash: 'hashB' }],
  segments: [
    { kind: 'transfer', from: { kind: 'origin' }, to_chapter_id: CH_A, to: pt(ENTRY_A), mode: 'driving', duration_s: 120, distance_m: 2950, cost_source: 'valhalla', providers: ['google_maps', 'waze'] },
    { kind: 'chapter', tour_id: TOUR_A, chapter_id: CH_A, transit_mode: 'walking', waypoint_ids: [ids.a1, ids.a2, ids.a4, ids.a5], kept_extension_ids: [ids.a2], dropped_extension_ids: [ids.a3], silent_stop_ids: [], travel_s: 600, dwell_s: 180, cost_source: 'valhalla' },
    { kind: 'transfer', from: { kind: 'chapter_exit', chapter_id: CH_A, point: pt(EXIT_A) }, to_chapter_id: CH_B, to: pt(ENTRY_B), mode: 'driving', duration_s: 60, distance_m: 700, cost_source: 'valhalla', providers: ['google_maps', 'waze'] },
    { kind: 'chapter', tour_id: TOUR_B, chapter_id: CH_B, transit_mode: 'walking', waypoint_ids: [ids.b0, ids.b1, ids.b2, ids.b3], kept_extension_ids: [], dropped_extension_ids: [], silent_stop_ids: [ids.b1], travel_s: 500, dwell_s: 220, cost_source: 'valhalla' },
  ],
  estimate: { budget_s: 14400, total_s: 2000, transfer_s: 180, chapter_travel_s: 1100, dwell_s: 400, deep_dive_extra_s: 0, slack_s: 12400, pace_factor: 1 },
  quality: { candidates_considered: 2, legs_total: 12, legs_estimated: 0, search_truncated: false, dropped_high_value_extensions: 0 },
});
const TRANSFER_A = `${TRANSFER_CHAPTER_PREFIX}${CH_A}`;
const TRANSFER_B = `${TRANSFER_CHAPTER_PREFIX}${CH_B}`;

const problem = planProblem(plan, manifests);
const tour = engineTourFromPlan(plan, manifests);
const activeIds = plan.segments.flatMap((s) => (s.kind === 'chapter' ? [...s.waypoint_ids] : []));
const tourOfStop = new Map(plan.segments.flatMap((s) => (s.kind === 'chapter' ? s.waypoint_ids.map((id) => [id, s.tour_id] as const) : [])));
const SESSION_KEY = planSessionKey(PLAN_ID);
const SOURCE = { kind: 'plan' as const, planId: PLAN_ID, contentHash: plan.content_hash };

// -----------------------------------------------------------------------------
// The day
// -----------------------------------------------------------------------------

type Leg =
  | { to: [number, number]; speed: number }
  | { hold: number }
  | { action: 'chapter'; chapterId: string }
  | { action: 'kill-and-resume' };
const DRIVE = 13.9;
const WALK = 1.3;
const legs: Leg[] = [
  { to: [-3_000, 0], speed: DRIVE }, // already there: the plan starts at the origin
  { to: ENTRY_A, speed: DRIVE },
  { hold: 30 }, // parked
  { action: 'chapter', chapterId: CH_A },
  { to: [0, 0], speed: WALK }, // a1, the plaza (b1's zone too - not armed now)
  { hold: 45 },
  { to: [0, 150], speed: WALK }, // a2
  { hold: 45 },
  { to: [0, 300], speed: WALK }, // ...through a3, dropped
  { to: [100, 300], speed: WALK }, // a4
  { hold: 20 },
  { to: EXIT_A, speed: WALK }, // a5
  { hold: 45 },
  { action: 'chapter', chapterId: TRANSFER_B },
  { to: [250, -60], speed: DRIVE },
  { action: 'kill-and-resume' }, // halfway down the road
  { to: [250, -150], speed: DRIVE },
  { to: ENTRY_B, speed: DRIVE },
  { hold: 30 },
  { action: 'chapter', chapterId: CH_B },
  { to: [0, -10], speed: WALK }, // b0 fires on the way; stop inside BOTH zones: b0 and the plaza b1
  { hold: 100 }, // b0 is still narrating when b1 fires
  { to: [0, 200], speed: WALK }, // b2
  { hold: 40 },
  { to: EXIT_B, speed: WALK }, // b3
  { hold: 40 },
];

// -----------------------------------------------------------------------------
// The simulated outside world
// -----------------------------------------------------------------------------

let now = T0;
const timers: { at: number; fn: () => void }[] = [];
const schedule = (delayMs: number, fn: () => void): void => {
  timers.push({ at: now + delayMs, fn });
};
const timeline: string[] = [];
const clock = (): string => {
  const s = Math.round((now - T0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const log = (line: string): void => {
  timeline.push(`${clock()}  ${line}`);
};

const durationOf = new Map([...manifestA.waypoints, ...manifestB.waypoints].map((w) => [w.waypoint_id, (w.media?.duration_seconds ?? 30) * 1000]));
const playsStarted: string[] = [];
const onAirIds = new Set<string>();
let maxConcurrent = 0;

class SimPlayer implements NarrationPlayer {
  private status: ((s: PlaybackSnapshot) => void) | null = null;
  private generation = 0;
  private playing: string | null = null;
  async play(track: AudioTrack): Promise<void> {
    await this.stop(null);
    const gen = ++this.generation;
    this.playing = track.waypointId;
    playsStarted.push(track.waypointId);
    onAirIds.add(track.waypointId);
    maxConcurrent = Math.max(maxConcurrent, onAirIds.size);
    const length = durationOf.get(track.waypointId) ?? 30_000;
    schedule(300, () => gen === this.generation && this.status?.({ isPlaying: true, positionSeconds: 0.3, durationSeconds: length / 1000, didJustFinish: false }));
    schedule(length, () => {
      if (gen !== this.generation) return;
      onAirIds.delete(track.waypointId);
      this.playing = null;
      this.status?.({ isPlaying: false, positionSeconds: length / 1000, durationSeconds: length / 1000, didJustFinish: true });
    });
  }
  async stop(_reason: unknown): Promise<void> {
    this.generation++;
    if (this.playing) onAirIds.delete(this.playing);
    this.playing = null;
  }
  async fadeOutAndStop(): Promise<void> {
    await this.stop(null);
  }
  pause(): void {}
  resume(): void {}
  setOnStatus(l: ((s: PlaybackSnapshot) => void) | null): void {
    this.status = l;
  }
  setOnError(_l: ((e: PlaybackError) => void) | null): void {}
}

const files: { main: string | null; temp: string | null } = { main: null, temp: null };
const io: CheckpointIO = {
  readMain: () => files.main,
  readTemp: () => files.temp,
  writeTemp: (t) => void (files.temp = t),
  commitTemp: () => {
    files.main = files.temp;
    files.temp = null;
  },
  clear: () => {
    files.main = null;
    files.temp = null;
  },
};
const repo = createProgressRepository(io);

const domain = new Map<string, Waypoint>(
  [...manifestA.waypoints.map((w) => [w, TOUR_A] as const), ...manifestB.waypoints.map((w) => [w, TOUR_B] as const)].map(([w, tourId]) => [
    w.waypoint_id,
    {
      id: w.waypoint_id, tourId, name: w.name, poiType: w.poi_type as Waypoint['poiType'], sortOrder: w.sort_order,
      coordinate: { latitude: w.coordinates[1], longitude: w.coordinates[0] }, geofence: null,
      audio: { id: `${w.waypoint_id}:audio`, waypointId: w.waypoint_id, storagePath: `sim/${w.name}.m4a`, audioTrackId: null, durationSeconds: w.media?.duration_seconds ?? null, format: 'm4a', sizeBytes: 1 },
      stopRole: w.stop_role === 'extension' ? 'extension' : 'core',
    },
  ]),
);

// -----------------------------------------------------------------------------
// Wiring - as TourSessionController does it for a planned session
// -----------------------------------------------------------------------------

const audioEffects: Extract<Effect, { type: 'PLAY' | 'STOP' | 'RESUME' }>[] = [];
const telemetry: { kind: string; stopId: string | null; tourId: string | undefined; detail: Record<string, string | number> }[] = [];
const transitModes: string[] = [];
const arrivals: string[] = [];
let writes = 0;
let heartbeat: (() => void) | null = null;
let actor: AudioActor | null = null;

function open(initial: EngineState): EngineRunner {
  const runner = new EngineRunner(initial, {
    persist: (progress: Progress) => {
      writes++;
      const snap: TourProgressSnapshot = {
        v: 3, tourId: SESSION_KEY, source: SOURCE, tourTitle: 'Your plan', activeIds,
        backgroundPermission: true, notificationPermission: true, startedAt: T0, savedAt: now, progress,
      };
      repo.save(snap);
    },
    audio: (fx) => {
      audioEffects.push(fx);
      if (fx.type === 'PLAY') log(`PLAY  ${n(fx.stopId)}`);
      if (fx.type === 'STOP') log(`STOP  (${fx.reason})`);
      actor?.execute(fx);
    },
    applyTransitMode: (mode) => {
      transitModes.push(mode);
      log(`transit mode -> ${mode}`);
    },
    tracking: () => {
      throw new Error('no idle pause expected in this day');
    },
    chapterArrived: (fx) => {
      arrivals.push(fx.chapterId);
      log(`ARRIVED: ${fx.chapterId === TRANSFER_A ? 'Old Town' : fx.chapterId === TRANSFER_B ? 'Market' : fx.chapterId}`);
    },
    telemetry: (fx) => {
      // The controller's own attribution rule (telemetryAttribution.ts).
      const tourId = engineEventTourId(SOURCE, SESSION_KEY, fx.stopId ? tourOfStop.get(fx.stopId) : undefined);
      telemetry.push({ kind: fx.kind, stopId: fx.stopId, tourId, detail: fx.detail });
      if (fx.kind === 'trigger_fired') log(`fired ${n(fx.stopId)}${fx.detail.silent ? '  (SILENT - an earlier chapter narrated this place)' : ''}`);
    },
    publish: () => {},
    now: () => now,
    setInterval: (fn) => {
      heartbeat = fn;
      return 'hb';
    },
    clearInterval: () => {
      heartbeat = null;
    },
    reportError: (ctx, err, detail) => {
      throw new Error(`engine ${ctx} error (${detail}): ${String(err)}`);
    },
  });
  actor = new AudioActor({
    player: new SimPlayer(),
    source: {
      resolve: async (stopId) => {
        const w = domain.get(stopId);
        return w?.audio ? { track: w.audio, uri: `sim://${stopId}`, waypoint: w } : null;
      },
    },
    sink: (e) => runner.dispatch(e),
    now: () => now,
    reportError: (err, detail) => {
      throw new Error(`audio actor ${detail}: ${String(err)}`);
    },
  });
  return runner;
}

const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await actor?.settled();
    await Promise.resolve();
  }
};

let runner = open(createEngineState(tour, freshProgress(tour, tour.chapters[0]!.id)));
runner.start();
let resumed: { ok: boolean; detail: string } | null = null;
let marketStartedAt: number | null = null;
let pos: [number, number] = [-3_000, 0];
let headingDeg = 90;

for (const leg of legs) {
  if ('action' in leg) {
    if (leg.action === 'chapter') {
      log(`listener starts ${leg.chapterId === CH_A ? 'Old Town' : leg.chapterId === CH_B ? 'Market' : 'the drive to Market'}`);
      if (leg.chapterId === CH_B) marketStartedAt = now;
      runner.dispatch({ type: 'CHAPTER_SELECTED', chapterId: leg.chapterId, at: now });
    } else {
      // The OS kills the app mid-drive; the restarted process rebuilds the
      // session from the checkpoint and the SAVED plan - as rebuildPlan does.
      log('*** process killed - resuming from the checkpoint ***');
      runner.stop();
      await actor?.dispose();
      const loaded = repo.load();
      if (loaded.kind !== 'found') throw new Error('no checkpoint to resume');
      const snap = loaded.snapshot;
      const ok = snap.v === 3 && snap.source.kind === 'plan' && snap.source.planId === PLAN_ID && snap.source.contentHash === plan.content_hash
        && snap.tourId === SESSION_KEY && JSON.stringify(snap.activeIds) === JSON.stringify(activeIds);
      const rebuilt = engineTourFromPlan(plan, manifests);
      const fit = progressProblem(rebuilt, snap.progress);
      resumed = { ok: ok && fit === null && snap.progress.chapterId === TRANSFER_B, detail: `${JSON.stringify(snap.source)} chapter ${snap.progress.chapterId} fit ${fit}` };
      runner = open(createEngineState(rebuilt, snap.progress));
      runner.start();
    }
    await drain();
    continue;
  }
  const steps = 'hold' in leg ? leg.hold : Math.max(1, Math.ceil(Math.hypot(leg.to[0] - pos[0], leg.to[1] - pos[1]) / leg.speed));
  const from: [number, number] = [...pos];
  if (!('hold' in leg)) headingDeg = ((Math.atan2(leg.to[0] - from[0], leg.to[1] - from[1]) * 180) / Math.PI + 360) % 360;
  for (let i = 1; i <= steps; i++) {
    now += 1000;
    if (!('hold' in leg)) {
      const f = i / steps;
      pos = [from[0] + (leg.to[0] - from[0]) * f, from[1] + (leg.to[1] - from[1]) * f];
    }
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    const moving = !('hold' in leg);
    const fix: GpsFix = {
      coordinate: at(pos[0], pos[1]),
      timestamp: now - 100,
      accuracyM: moving ? 6 : 10,
      speedMps: moving ? ('speed' in leg ? leg.speed : 0) : 0,
      headingDeg: moving ? headingDeg : -1,
    };
    runner.fixes([fix]);
    heartbeat?.();
    await drain();
  }
}
runner.stop();

// -----------------------------------------------------------------------------
// Report
// -----------------------------------------------------------------------------

console.log('\nTimeline\n--------');
for (const line of timeline) console.log(`  ${line}`);

let checks = 0;
let failures = 0;
const assert = (label: string, ok: boolean, detail = ''): void => {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
};
const state = runner.state;
const played = Object.keys(state.progress.played);
const fired = Object.keys(state.progress.fired);
const firedEvents = telemetry.filter((t) => t.kind === 'trigger_fired');

console.log('\nChecks\n------');
assert('the plan passes planProblem against both bundles (silent b1 is a core stop)', problem === null, String(problem));
assert('the engine marks b1, and only b1, silent', tour.stops.filter((s) => s.silent).map((s) => s.id).join() === ids.b1);
assert('transfer 1: arrival at Old Town announced, then started by hand', arrivals[0] === TRANSFER_A);
assert('a1 (the plaza, first visit) narrates', playsStarted.includes(ids.a1) && played.includes(ids.a1));
assert('a2 (kept extension) narrates', playsStarted.includes(ids.a2));
assert('a3 (dropped extension on the path) never armed, never fires', !tour.stops.some((s) => s.id === ids.a3) && !fired.includes(ids.a3));
assert('a4 (transition) and a5 narrate', [ids.a4, ids.a5].every((id) => playsStarted.includes(id)));
assert('while Old Town runs, the Market plaza zone (b1) is not armed - it fires once, after the Market starts', firedEvents.filter((t) => t.stopId === ids.b1).length === 1 && marketStartedAt !== null && state.progress.fired[ids.b1]! > marketStartedAt);
assert('killed mid-transfer: resumed from a v3 checkpoint naming the plan (id + content hash, never the plan body)', resumed?.ok === true, resumed?.detail ?? 'never resumed');
assert('transfer 2: arrival at the Market after the resume', arrivals.includes(TRANSFER_B));
assert('b0 narrates', playsStarted.includes(ids.b0));

// --- The duplicate core stop (Option E) ---
const b1Fired = firedEvents.find((t) => t.stopId === ids.b1);
assert('b1 (the plaza again): its zone FIRES - the window and cursor move as for any stop', fired.includes(ids.b1) && b1Fired !== undefined);
assert('...reported as silent', b1Fired?.detail.silent === 1, JSON.stringify(b1Fired?.detail));
assert('...counts as heard (no "missed" recap, no completion gap)', played.includes(ids.b1));
assert('...and NOTHING plays for it: no PLAY effect, no player call, no audio telemetry possible', !audioEffects.some((fx) => fx.type === 'PLAY' && fx.stopId === ids.b1) && !playsStarted.includes(ids.b1));
assert('...b0, on air when b1 fired, was NOT preempted and played to its end', !audioEffects.some((fx) => fx.type === 'STOP' && fx.reason === 'preempted') && played.includes(ids.b0));
assert('b2 and b3 narrate after the silent stop (sequencing intact)', [ids.b2, ids.b3].every((id) => played.includes(id)));

// --- Session-wide ---
assert('every planned stop is settled; the plan ran to its end', activeIds.every((id) => played.includes(id)), JSON.stringify(activeIds.filter((id) => !played.includes(id)).map(n)));
assert('never two narrations at once', maxConcurrent === 1, `max ${maxConcurrent}`);
assert('telemetry: every stop event names the tour that OWNS the stop', firedEvents.every((t) => t.tourId === tourOfStop.get(t.stopId!)));
assert('telemetry: arrivals in a transfer name no tour - never the plan:<id> key', telemetry.filter((t) => t.kind === 'chapter_arrived').every((t) => t.tourId === undefined) && !telemetry.some((t) => t.tourId === SESSION_KEY));
assert('GPS: the plan pins tracking at its finest mode (driving) - no restart at these mode changes', finestMode(tour.chapters.map((c) => c.transitMode)) === 'driving' && transitModes.length >= 3, transitModes.join());
const saved = repo.load();
assert(`the last v3 checkpoint matches the engine (${writes} writes)`, saved.kind === 'found' && saved.snapshot.source.kind === 'plan' && JSON.stringify(saved.snapshot.progress) === JSON.stringify(state.progress));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
