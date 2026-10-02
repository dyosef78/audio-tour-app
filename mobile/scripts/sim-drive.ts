/**
 * sim:drive - Epic 15 end to end, on a simulated day out (replaces sim:walk).
 *
 * The REAL engine path, with only the outside world simulated:
 *
 *   chaptered manifest -> engineTourFromManifest -> EngineRunner (reduce,
 *   persist into a real TourProgressRepository, publish) -> AudioActor ->
 *   a simulated player that "plays" each narration for its duration
 *
 * on a simulated clock with a 1 Hz heartbeat and a 1 Hz GPS trace:
 *
 *   Chapter 1 - DRIVE at 100 km/h
 *     h1  passed eastbound, approach east        -> fires
 *     h2  approach WEST, passed eastbound         -> rejected (bearing)
 *     h3, h4  500 m apart                         -> h4 waits behind h3, expires
 *     h5  inside a 2 km tunnel (no fixes)         -> not fired from the chord
 *     detour 3 km north past h6..h8               -> re-anchor to h9
 *     h10 back on plan                            -> fires
 *     park; the listener starts chapter 2 by hand -> APPLY_TRANSIT_MODE walking
 *   Chapter 2 - WALK
 *     w1, w2, w3                                  -> each narrates
 *     sit 16 minutes                              -> idle timeout, tracking off
 *     tap Resume                                  -> tracking on
 *
 * Deterministic, no network, no stubs: CI runs it (npm run sim:drive).
 */

import { engineTourFromManifest } from '../src/engine/fromManifest.ts';
import { createEngineState, freshProgress, missedStops } from '../src/engine/reduce.ts';
import { EARTH_RADIUS_M } from '../src/engine/geo/sweep.ts';
import type { Effect, GpsFix } from '../src/engine/types.ts';
import { AudioActor, type NarrationPlayer } from '../src/services/audio/AudioActor.ts';
import type { PlaybackError, PlaybackSnapshot } from '../src/services/audio/AudioService.ts';
import type { WireBundle, WireWaypoint } from '../src/services/bundle/types.ts';
import { EngineRunner } from '../src/session/EngineRunner.ts';
import { createProgressRepository } from '../src/session/progressRepository.ts';
import type { CheckpointIO } from '../src/session/sessionCheckpoint.ts';
import type { AudioTrack, LatLng, Waypoint } from '../src/types/domain.ts';

// -----------------------------------------------------------------------------
// The world
// -----------------------------------------------------------------------------

const ORIGIN: LatLng = { latitude: 31.3, longitude: 35.0 };
const K = (Math.PI / 180) * EARTH_RADIUS_M;
const at = (east: number, north: number): LatLng => ({
  latitude: ORIGIN.latitude + north / K,
  longitude: ORIGIN.longitude + east / (K * Math.cos((ORIGIN.latitude * Math.PI) / 180)),
});
const lonLat = (east: number, north: number): [number, number] => {
  const p = at(east, north);
  return [p.longitude, p.latitude];
};

const TOUR = 'tttttttt-0000-4000-8000-000000000001';
const T0 = 1_800_000_000_000;

function stop(
  id: string,
  sort: number,
  chapter: string,
  east: number,
  north: number,
  radius: number,
  seconds: number,
  approach: WireWaypoint['approach'] = null,
): WireWaypoint {
  return {
    waypoint_id: id,
    name: id,
    poi_type: 'anchor',
    sort_order: sort,
    coordinates: lonLat(east, north),
    geofence: { type: 'radius', radius_meters: radius, center: lonLat(east, north) },
    media: { storage_path: `sim/${id}.m4a`, duration_seconds: seconds, size_bytes: 1, format: 'm4a' },
    chapter_id: chapter,
    approach,
  };
}

const manifest: WireBundle = {
  bundle_version_hash: 'sim',
  tour_metadata: { tour_id: TOUR, title: 'Masada day', topology: 'point_to_point', transit_mode: 'driving', duration_minutes: 240 },
  chapters: [
    {
      chapter_id: 'drive', sort_order: 0, title: 'Drive to Masada', transit_mode: 'driving',
      sequence_policy: 'windowed', lookahead_stops: 3,
      handoff: { destination: lonLat(22_000, 0), destination_label: 'East parking', anchors: [lonLat(8_000, 0)], providers: ['google_maps'] },
    },
    { chapter_id: 'walk', sort_order: 1, title: 'Walk the fortress', transit_mode: 'walking', sequence_policy: 'windowed', lookahead_stops: 3, handoff: null },
  ],
  waypoints: [
    stop('h1', 1, 'drive', 3_000, 100, 200, 90, { bearing_deg: 90, tolerance_deg: 45, policy: 'required' }),
    stop('h2', 2, 'drive', 5_000, 100, 200, 60, { bearing_deg: 270, tolerance_deg: 45, policy: 'required' }),
    stop('h3', 3, 'drive', 6_000, 100, 200, 90),
    stop('h4', 4, 'drive', 6_500, 100, 200, 60),
    stop('h5', 5, 'drive', 10_000, 0, 150, 60),
    stop('h6', 6, 'drive', 14_000, 0, 150, 60),
    stop('h7', 7, 'drive', 15_000, 0, 150, 60),
    stop('h8', 8, 'drive', 16_000, 0, 150, 60),
    stop('h9', 9, 'drive', 19_500, 0, 150, 60),
    stop('h10', 10, 'drive', 21_000, 0, 150, 45),
    stop('w1', 11, 'walk', 22_000, 120, 25, 40),
    stop('w2', 12, 'walk', 22_000, 320, 25, 40),
    stop('w3', 13, 'walk', 22_250, 320, 25, 40),
  ],
};

/**
 * The day, as legs. Each leg moves to a point at a speed, or holds still.
 * `noFixes` models the tunnel; `then` is what the listener does on arrival.
 */
type Leg =
  | { to: [number, number]; speed: number; noFixes?: boolean }
  | { hold: number; jitter?: number }
  | { action: 'chapter'; chapterId: string }
  | { action: 'resume' };
const DRIVE = 27.8;
const WALK = 1.3;
const legs: Leg[] = [
  { to: [9_000, 0], speed: DRIVE },
  { to: [11_000, 0], speed: DRIVE, noFixes: true }, // the tunnel
  { to: [13_000, 0], speed: DRIVE },
  { to: [13_000, 3_000], speed: DRIVE }, // detour north...
  { to: [18_000, 3_000], speed: DRIVE }, // ...past h6, h7, h8...
  { to: [18_000, 0], speed: DRIVE }, // ...and back to the road
  { to: [22_000, 0], speed: DRIVE }, // h9, h10, the parking
  { hold: 120 },
  { action: 'chapter', chapterId: 'walk' },
  { to: [22_000, 320], speed: WALK },
  { to: [22_250, 320], speed: WALK },
  { hold: 16 * 60, jitter: 6 }, // a long coffee
  { hold: 120 },
  { action: 'resume' },
  { hold: 30 },
];

// -----------------------------------------------------------------------------
// The simulated outside world: clock, player, storage
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

const durationOf = new Map(manifest.waypoints.map((w) => [w.waypoint_id, (w.media?.duration_seconds ?? 30) * 1000]));
let maxConcurrent = 0;
const onAirIds = new Set<string>();

class SimPlayer implements NarrationPlayer {
  private status: ((s: PlaybackSnapshot) => void) | null = null;
  private generation = 0;
  private playing: string | null = null;
  async play(track: AudioTrack): Promise<void> {
    await this.stop(null);
    const gen = ++this.generation;
    this.playing = track.waypointId;
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

// -----------------------------------------------------------------------------
// Wiring - as TourSessionController does it
// -----------------------------------------------------------------------------

const allIds = manifest.waypoints.map((w) => w.waypoint_id);
const tour = engineTourFromManifest(manifest, allIds);
const domain = new Map<string, Waypoint>(
  manifest.waypoints.map((w) => [
    w.waypoint_id,
    {
      id: w.waypoint_id, tourId: TOUR, name: w.name, poiType: 'anchor', sortOrder: w.sort_order,
      coordinate: { latitude: w.coordinates[1], longitude: w.coordinates[0] }, geofence: null,
      audio: { id: `${w.waypoint_id}:audio`, waypointId: w.waypoint_id, storagePath: `sim/${w.waypoint_id}.m4a`, audioTrackId: null, durationSeconds: w.media?.duration_seconds ?? null, format: 'm4a', sizeBytes: 1 },
    },
  ]),
);

let writes = 0;
let trackingOn = true;
const telemetry: Extract<Effect, { type: 'TELEMETRY' }>[] = [];
const transitModes: string[] = [];
/** CHAPTER_ARRIVED effects, and whether the listener had switched chapter yet. */
const arrivals: { chapterId: string; nextChapterId: string | null; beforeSwitch: boolean }[] = [];
let chapterSwitched = false;
let heartbeat: (() => void) | null = null;
let actorRef: AudioActor | null = null;

const runner = new EngineRunner(createEngineState(tour, freshProgress(tour, 'drive')), {
  persist: (progress) => {
    writes++;
    repo.save({
      v: 2, tourId: TOUR, tourTitle: 'Masada day', activeIds: allIds, skippedIds: [],
      backgroundPermission: true, notificationPermission: true, startedAt: T0, savedAt: now, progress,
    });
  },
  audio: (fx) => {
    if (fx.type === 'PLAY') log(`PLAY  ${fx.stopId}`);
    if (fx.type === 'STOP') log(`STOP  token ${fx.token} (${fx.reason})`);
    actorRef?.execute(fx);
  },
  applyTransitMode: (mode) => {
    transitModes.push(mode);
    log(`transit mode -> ${mode}`);
  },
  tracking: (fx) => {
    trackingOn = fx.type === 'RESUME_TRACKING';
    log(fx.type === 'SUSPEND_TRACKING' ? 'TRACKING OFF (idle timeout) + notification' : 'TRACKING ON (resumed)');
  },
  chapterArrived: (fx) => {
    arrivals.push({ chapterId: fx.chapterId, nextChapterId: fx.nextChapterId, beforeSwitch: !chapterSwitched });
    log(`ARRIVED at the end of "${fx.chapterId}" + notification (next: ${fx.nextChapterId ?? 'none'})`);
  },
  telemetry: (fx) => {
    telemetry.push(fx);
    if (fx.kind !== 'trigger_fired') log(`${fx.kind} ${fx.stopId ?? ''} ${JSON.stringify(fx.detail)}`);
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
actorRef = new AudioActor({
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

// -----------------------------------------------------------------------------
// Run the day, one simulated second at a time
// -----------------------------------------------------------------------------

const drain = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await actorRef?.settled();
    await Promise.resolve();
  }
};

runner.start();
let pos: [number, number] = [0, 0];
let headingDeg = 90;

for (const leg of legs) {
  if ('action' in leg) {
    if (leg.action === 'chapter') {
      log(`listener starts "${leg.chapterId}"`);
      chapterSwitched = true;
      runner.dispatch({ type: 'CHAPTER_SELECTED', chapterId: leg.chapterId, at: now });
    } else {
      log('listener taps Resume');
      runner.dispatch({ type: 'RESUME_REQUESTED', at: now });
    }
    await drain();
    continue;
  }
  const steps = 'hold' in leg ? leg.hold : Math.ceil(Math.hypot(leg.to[0] - pos[0], leg.to[1] - pos[1]) / leg.speed);
  const from: [number, number] = [...pos];
  if (!('hold' in leg)) headingDeg = ((Math.atan2(leg.to[0] - from[0], leg.to[1] - from[1]) * 180) / Math.PI + 360) % 360;
  for (let i = 1; i <= steps; i++) {
    now += 1000;
    if ('hold' in leg) {
      const j = leg.jitter ?? 0;
      pos = [from[0] + ((i * 7) % 5) * j * 0.2, from[1] + ((i * 3) % 5) * j * 0.2];
    } else {
      const f = i / steps;
      pos = [from[0] + (leg.to[0] - from[0]) * f, from[1] + (leg.to[1] - from[1]) * f];
    }
    for (const t of timers.filter((x) => x.at <= now)) {
      timers.splice(timers.indexOf(t), 1);
      t.fn();
    }
    const moving = !('hold' in leg);
    const noFixes = 'noFixes' in leg && leg.noFixes === true;
    if (trackingOn && !noFixes) {
      const fix: GpsFix = {
        coordinate: at(pos[0], pos[1]),
        timestamp: now - 100,
        accuracyM: moving ? 6 : 12,
        speedMps: moving ? ('speed' in leg ? leg.speed : 0) : 0,
        headingDeg: moving ? headingDeg : -1,
      };
      runner.fixes([fix]);
    }
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
const kinds = (k: string) => telemetry.filter((t) => t.kind === k);

console.log('\nChecks\n------');
assert('h1: passed in its direction -> heard', played.includes('h1'));
assert('h2: passed against its approach bearing -> never fired, reported once', !fired.includes('h2') && kinds('trigger_rejected_bearing').filter((t) => t.stopId === 'h2').length === 1);
assert('h3 heard; h4 (500 m later) waited, then expired by distance', played.includes('h3') && !played.includes('h4') && kinds('trigger_expired').some((t) => t.stopId === 'h4'));
assert('h5: inside the tunnel -> not fired from the 2 km chord', !fired.includes('h5'));
assert('detour past h6..h8 -> re-anchored to h9', kinds('trigger_reanchored').some((t) => t.stopId === 'h9') && played.includes('h9'));
assert('...h5..h8 reported as skipped', ['h5', 'h6', 'h7', 'h8'].every((id) => kinds('trigger_missed').some((t) => t.stopId === id)));
assert('h10: back on plan -> heard', played.includes('h10'));
assert(
  'parked at the chapter destination -> arrival announced once, before the manual switch',
  arrivals.length === 1 && arrivals[0].chapterId === 'drive' && arrivals[0].nextChapterId === 'walk' && arrivals[0].beforeSwitch && kinds('chapter_arrived').length === 1,
  JSON.stringify(arrivals),
);
assert('chapter 2 by hand -> transit mode switched to walking', transitModes.join() === 'walking');
assert('w1, w2, w3 heard on foot', ['w1', 'w2', 'w3'].every((id) => played.includes(id)));
assert('16 min sitting -> suspended once, resumed on tap', kinds('tour_suspended').length === 1 && kinds('tour_resumed').length === 1);
assert('never two narrations at once', maxConcurrent === 1, `max ${maxConcurrent}`);
assert('drive recap lists the stops not heard', missedStops(state, 'drive').map((s) => s.id).join() === 'h2,h4,h5,h6,h7,h8');
assert(`progress written only on change: ${writes} writes over ~${Math.round((now - T0) / 1000)} fixes/ticks`, writes > 0 && writes < 60);
const saved = repo.load();
assert('the last checkpoint round-trips and matches the engine', saved.kind === 'found' && JSON.stringify(saved.snapshot.progress) === JSON.stringify(state.progress));

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
