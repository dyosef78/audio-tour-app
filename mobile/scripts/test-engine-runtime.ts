/**
 * Epic 15 slices 3-4 - the engine's runtime: manifest mapping, the progress
 * repository, the event loop (EngineRunner) and the audio shell (AudioActor).
 *
 * Pure: every collaborator is a recording fake, so ORDER is observable - the
 * PM's "persist strictly before any audio effect" is asserted, not assumed.
 *
 * Run:  npm run test:engine
 */

import { engineTourFromManifest, chaptersOf, PLAIN_CHAPTER_DEFAULTS } from '../src/engine/fromManifest.ts';
import { createEngineState, freshProgress } from '../src/engine/reduce.ts';
import type { EngineEvent, EngineTour, GpsFix, Progress } from '../src/engine/types.ts';
import { AudioActor, type AudioEngineEvent, type NarrationPlayer } from '../src/services/audio/AudioActor.ts';
import type { PlaybackError, PlaybackSnapshot } from '../src/services/audio/AudioService.ts';
import { interruptionModeFor } from '../src/services/audio/sessionMode.ts';
import { isWireBundle, type WireBundle, type WireWaypoint } from '../src/services/bundle/types.ts';
import { EngineRunner, HEARTBEAT_MS, type EngineRunnerPorts } from '../src/session/EngineRunner.ts';
import {
  createProgressRepository,
  decideSnapshotResume,
  type TourProgressSnapshot,
} from '../src/session/progressRepository.ts';
import type { CheckpointIO } from '../src/session/sessionCheckpoint.ts';
import type { AudioTrack, Waypoint } from '../src/types/domain.ts';

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
function throws(label: string, fn: () => unknown, match?: RegExp): void {
  try {
    fn();
    assert(label, false, 'did not throw');
  } catch (e) {
    assert(label, match ? match.test(String(e)) : true, String(e));
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// --- a small manifest ----------------------------------------------------------
const TOUR = 'aaaaaaaa-0000-4000-8000-000000000001';
const wp = (id: string, sort: number, lon: number, lat: number, extra: Partial<WireWaypoint> = {}): WireWaypoint => ({
  waypoint_id: id,
  name: id,
  poi_type: 'anchor',
  sort_order: sort,
  coordinates: [lon, lat],
  geofence: { type: 'radius', radius_meters: 25, center: [lon, lat] },
  media: null,
  ...extra,
});
const legacy: WireBundle = {
  bundle_version_hash: 'h',
  tour_metadata: { tour_id: TOUR, title: 'T', topology: 'in_city', transit_mode: 'walking', duration_minutes: 30 },
  waypoints: [wp('w2', 2, 34.79, 32.09), wp('w1', 1, 34.78, 32.08), wp('w3', 3, 34.8, 32.1, { geofence: null }), wp('w4', 4, 34.81, 32.11)],
};

// -----------------------------------------------------------------------------
heading('Manifest -> EngineTour');
// -----------------------------------------------------------------------------
{
  const t = engineTourFromManifest(legacy, ['w1', 'w2', 'w3', 'w4']);
  const ch = t.chapters[0];
  assert('legacy manifest: ONE chapter, id = tour id, mode from the tour', t.chapters.length === 1 && ch?.id === TOUR && ch.transitMode === 'walking');
  assert('legacy manifest: the plain defaults', ch?.sequencePolicy === PLAIN_CHAPTER_DEFAULTS.sequencePolicy && ch.lookaheadStops === PLAIN_CHAPTER_DEFAULTS.lookaheadStops);
  assert('stops indexed by sort_order, a zoneless stop dropped', t.stops.map((s) => `${s.id}:${s.index}`).join() === 'w1:0,w2:1,w4:2');
  const z = t.stops[0]?.zone;
  assert('[lon, lat] read as longitude, latitude', z?.kind === 'radius' && z.center.longitude === 34.78 && z.center.latitude === 32.08 && z.radiusM === 25);
  const sel = engineTourFromManifest(legacy, ['w4', 'w2']);
  assert('preference selection: indices renumbered over ACTIVE stops only', sel.stops.map((s) => `${s.id}:${s.index}`).join() === 'w2:0,w4:1');
  throws('an active stop the manifest lacks throws', () => engineTourFromManifest(legacy, ['w1', 'ghost']), /ghost/);
  throws('a radius zone with no radius throws', () =>
    engineTourFromManifest({ ...legacy, waypoints: [wp('w1', 1, 1, 1, { geofence: { type: 'radius', radius_meters: null, center: [1, 1] } })] }, ['w1']), /radius/);
}
const chaptered: WireBundle = {
  ...legacy,
  tour_metadata: { ...legacy.tour_metadata, transit_mode: 'driving' },
  chapters: [
    { chapter_id: 'walk', sort_order: 1, title: 'Walk', transit_mode: 'walking', sequence_policy: 'strict', lookahead_stops: 3, handoff: null },
    {
      chapter_id: 'drive',
      sort_order: 0,
      title: 'Drive',
      transit_mode: 'driving',
      sequence_policy: 'windowed',
      lookahead_stops: 2,
      handoff: { destination: [35, 31], destination_label: null, anchors: [], providers: ['google_maps', 'waze', 'teleport'] },
    },
  ],
  waypoints: [
    wp('d1', 1, 35.0, 31.0, { chapter_id: 'drive', approach: { bearing_deg: 90, tolerance_deg: 45, policy: 'required' } }),
    wp('d2', 2, 35.1, 31.0, { chapter_id: 'drive' }),
    wp('k1', 3, 35.2, 31.0, { chapter_id: 'walk' }),
  ],
};
{
  const t = engineTourFromManifest(chaptered, ['d1', 'd2', 'k1']);
  assert('chapters sorted by sort_order', t.chapters.map((c) => c.id).join() === 'drive,walk');
  assert('indices restart per chapter', t.stops.map((s) => `${s.chapterId}/${s.id}:${s.index}`).join() === 'drive/d1:0,drive/d2:1,walk/k1:0');
  assert('approach mapped', JSON.stringify(t.stops[0]?.approach) === '{"bearingDeg":90,"toleranceDeg":45,"policy":"required"}');
  assert('chaptersOf drops a provider this build does not know', JSON.stringify(chaptersOf(chaptered)[0]?.handoff?.providers) === '["google_maps","waze"]');
  throws('an unknown transit mode throws (a newer server)', () =>
    engineTourFromManifest({ ...chaptered, chapters: [{ ...(chaptered.chapters?.[0] as NonNullable<WireBundle['chapters']>[number]), transit_mode: 'hovercraft' }] }, []), /hovercraft/);
  throws('an unknown approach policy throws', () =>
    engineTourFromManifest({ ...chaptered, waypoints: [wp('d1', 1, 35, 31, { chapter_id: 'drive', approach: { bearing_deg: 1, tolerance_deg: 2, policy: 'maybe' } })] }, ['d1']), /maybe/);
}
{
  assert('isWireBundle: legacy manifest accepted', isWireBundle(legacy));
  assert('isWireBundle: chaptered manifest accepted', isWireBundle(chaptered));
  assert('isWireBundle: chapter_id without chapters refused', !isWireBundle({ ...legacy, waypoints: [wp('w1', 1, 1, 1, { chapter_id: 'x' })] }));
  assert('isWireBundle: a waypoint naming an unlisted chapter refused', !isWireBundle({ ...chaptered, waypoints: [wp('d1', 1, 1, 1, { chapter_id: 'nowhere' })] }));
  const dup = chaptered.chapters?.[0];
  assert('isWireBundle: duplicate chapter ids refused', dup !== undefined && !isWireBundle({ ...chaptered, chapters: [dup, dup] }));
  assert('isWireBundle: an empty chapter list refused', !isWireBundle({ ...chaptered, chapters: [] }));
}

// -----------------------------------------------------------------------------
heading('TourProgressRepository (v2)');
// -----------------------------------------------------------------------------
function memoryIO(opts: { failCommitAfterDelete?: boolean; failRead?: boolean } = {}) {
  const files: { main: string | null; temp: string | null } = { main: null, temp: null };
  const io: CheckpointIO = {
    readMain: () => {
      if (opts.failRead) throw new Error('EIO');
      return files.main;
    },
    readTemp: () => files.temp,
    writeTemp: (text) => {
      files.temp = text;
    },
    commitTemp: () => {
      files.main = null;
      if (opts.failCommitAfterDelete) throw new Error('killed between delete and rename');
      files.main = files.temp;
      files.temp = null;
    },
    clear: () => {
      files.main = null;
      files.temp = null;
    },
  };
  return { io, files };
}
const progress: Progress = {
  chapterId: TOUR,
  fired: { w1: 1000 },
  played: { w1: 1500 },
  queue: [{ stopId: 'w2', firedAt: 2000, firedWhere: { latitude: 32, longitude: 34 }, expiresAt: 62_000 }],
};
const snapshot: TourProgressSnapshot = {
  v: 2,
  tourId: TOUR,
  tourTitle: 'T',
  activeIds: ['w1', 'w2'],
  skippedIds: [],
  backgroundPermission: true,
  notificationPermission: true,
  startedAt: 1000,
  savedAt: 3000,
  progress,
};
{
  const { io } = memoryIO();
  const repo = createProgressRepository(io);
  assert('empty: none', repo.load().kind === 'none');
  repo.save(snapshot);
  const back = repo.load();
  assert('save -> load round-trips exactly', back.kind === 'found' && JSON.stringify(back.snapshot) === JSON.stringify(snapshot));
  repo.clear();
  assert('clear -> none', repo.load().kind === 'none');

  const crash = memoryIO({ failCommitAfterDelete: true });
  const crashRepo = createProgressRepository(crash.io);
  try {
    crashRepo.save(snapshot);
  } catch {
    /* the simulated kill */
  }
  const afterKill = crashRepo.load();
  assert('killed between delete and rename: the temp copy is found', afterKill.kind === 'found' && afterKill.snapshot.savedAt === 3000);

  const v1 = memoryIO();
  v1.files.main = JSON.stringify({ v: 1, tourId: TOUR });
  const v1Load = createProgressRepository(v1.io).load();
  assert('an Epic 13 (v1) checkpoint is invalid, not misread', v1Load.kind === 'invalid' && /version 1/.test(v1Load.reason));

  throws('saving progress about an inactive stop throws (bug here, not at resume)', () =>
    repo.save({ ...snapshot, progress: { ...progress, fired: { ghost: 1 } } }), /ghost/);
  const broken = createProgressRepository(memoryIO({ failRead: true }).io).load();
  assert('an unreadable file is invalid, never "none"', broken.kind === 'invalid' && /EIO/.test(broken.reason));
  assert('12 h + 1 min old: discarded', decideSnapshotResume({ kind: 'found', snapshot }, 3000 + 12 * 3_600_000 + 60_000).kind === 'discard');
  assert('fresh: resumed', decideSnapshotResume({ kind: 'found', snapshot }, 4000).kind === 'resume');
}

// -----------------------------------------------------------------------------
heading('EngineRunner - the event loop');
// -----------------------------------------------------------------------------
const runnerTour: EngineTour = engineTourFromManifest(legacy, ['w1', 'w2', 'w4']);
const at = (lon: number, lat: number, t: number): GpsFix => ({ coordinate: { latitude: lat, longitude: lon }, timestamp: t, accuracyM: 5, speedMps: null, headingDeg: null });

function harness(over: Partial<EngineRunnerPorts> = {}) {
  const log: string[] = [];
  let now = 1_800_000_000_000;
  let heartbeat: (() => void) | null = null;
  const ports: EngineRunnerPorts = {
    persist: (p) => log.push(`persist fired=${Object.keys(p.fired).join('+')}`),
    audio: (fx) => log.push(`audio ${fx.type} ${fx.token}`),
    applyTransitMode: (m) => log.push(`mode ${m}`),
    telemetry: (fx) => log.push(`tel ${fx.kind}`),
    publish: () => log.push('publish'),
    now: () => now,
    setInterval: (fn, ms) => {
      heartbeat = fn;
      log.push(`setInterval ${ms}`);
      return 'hb';
    },
    clearInterval: (h) => log.push(`clearInterval ${String(h)}`),
    reportError: (ctx, err, detail) => log.push(`error ${ctx} ${detail} ${err instanceof Error ? err.message : String(err)}`),
    ...over,
  };
  const runner = new EngineRunner(createEngineState(runnerTour, freshProgress(runnerTour, TOUR)), ports);
  return {
    runner,
    log,
    advance: (ms: number) => {
      now += ms;
    },
    beat: () => heartbeat?.(),
    now: () => now,
  };
}
{
  const h = harness();
  h.runner.start();
  assert('start(): a 1 Hz heartbeat', h.log[0] === `setInterval ${HEARTBEAT_MS}` && HEARTBEAT_MS === 1000);
  h.log.length = 0;
  h.runner.fixes([at(34.78, 32.08, h.now() - 100)]);
  const persistAt = h.log.findIndex((l) => l.startsWith('persist'));
  const playAt = h.log.findIndex((l) => l.startsWith('audio PLAY'));
  assert('a fix inside w1: persisted, then PLAY', persistAt >= 0 && playAt >= 0, h.log.join(' | '));
  assert('ORDER: persist strictly BEFORE the audio effect', persistAt < playAt, h.log.join(' | '));
  h.log.length = 0;
  h.beat();
  assert('an idle heartbeat writes nothing', !h.log.some((l) => l.startsWith('persist')), h.log.join(' | '));
  h.advance(5_000);
  h.beat();
  assert('heartbeat 5 s after an unanswered PLAY: the engine STOPs it', h.log.some((l) => l.startsWith('audio STOP')), h.log.join(' | '));
  h.runner.stop();
  assert('stop(): heartbeat cleared', h.log.includes('clearInterval hb'));
  const before = h.log.length;
  h.runner.dispatch({ type: 'TICK', at: h.now() });
  h.runner.fixes([at(34.79, 32.09, h.now())]);
  assert('after stop(): late events are ignored - no port is called', h.log.length === before);
}
{
  // Re-entrancy: the audio port fails SYNCHRONOUSLY inside PLAY.
  let runnerRef: EngineRunner | null = null;
  let depth = 0;
  let maxDepth = 0;
  let publishedInsideAudio = 0;
  const h = harness({
    audio: (fx) => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      h.log.push(`audio ${fx.type} ${fx.token}`);
      if (fx.type === 'PLAY') runnerRef?.dispatch({ type: 'AUDIO_FAILED', token: fx.token, at: h.now(), message: 'sync' });
      depth--;
    },
    publish: () => {
      if (depth > 0) publishedInsideAudio++;
    },
  });
  runnerRef = h.runner;
  h.runner.start();
  h.runner.fixes([at(34.78, 32.08, h.now() - 100)]);
  assert('a synchronous AUDIO_FAILED from inside PLAY is drained after, not inside', h.runner.state.audio.kind === 'idle' && maxDepth === 1);
  assert('...no drain ever runs nested inside an effect (nothing published from within the audio port)', publishedInsideAudio === 0);
  assert('...and the stop still counts as fired', 'w1' in h.runner.state.progress.fired);
}
{
  const h = harness({
    persist: () => {
      throw new Error('disk full');
    },
  });
  h.runner.start();
  h.runner.fixes([at(34.78, 32.08, h.now() - 100)]);
  assert('persist throws: reported...', h.log.some((l) => l.startsWith('error persist') && l.includes('disk full')));
  assert('...and narration still starts (PM policy)', h.log.some((l) => l.startsWith('audio PLAY')));
}
{
  const h = harness();
  h.runner.start();
  h.runner.dispatch({ type: 'MANUAL_TRIGGER', stopId: 'nope', at: h.now() } as EngineEvent);
  assert('a reducer throw is reported with the event type', h.log.some((l) => l.startsWith('error reduce MANUAL_TRIGGER')));
  h.runner.fixes([at(34.78, 32.08, h.now() - 100)]);
  assert('...and the loop keeps working afterwards', 'w1' in h.runner.state.progress.fired);
}

// -----------------------------------------------------------------------------
heading('AudioActor - the audio shell');
// -----------------------------------------------------------------------------
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function fakePlayer() {
  const calls: string[] = [];
  let status: ((s: PlaybackSnapshot) => void) | null = null;
  let error: ((e: PlaybackError) => void) | null = null;
  let playGate: Deferred<void> | null = null;
  const player: NarrationPlayer & { gate(): Deferred<void> } = {
    play: async (track) => {
      calls.push(`play ${track.id}`);
      if (playGate) await playGate.promise;
    },
    stop: async (reason) => {
      calls.push(`stop ${reason}`);
    },
    fadeOutAndStop: async () => {
      calls.push('fade');
    },
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
    setOnStatus: (l) => {
      status = l;
    },
    setOnError: (l) => {
      error = l;
    },
    gate: () => {
      playGate = deferred<void>();
      return playGate;
    },
  };
  return {
    player,
    calls,
    emit: (s: Partial<PlaybackSnapshot>) => status?.({ isPlaying: false, positionSeconds: 0, durationSeconds: 60, didJustFinish: false, ...s }),
    fail: (message: string) => error?.({ reason: 'load-timeout', message }),
  };
}
const track = (id: string): AudioTrack => ({ id, waypointId: id, storagePath: `p/${id}.m4a`, audioTrackId: null, durationSeconds: 60, format: 'm4a', sizeBytes: 1 });
const waypointOf = (id: string): Waypoint => ({ id, tourId: TOUR, name: id, poiType: 'anchor', coordinate: { latitude: 0, longitude: 0 }, sortOrder: 0, geofence: null, audio: null });
function actorHarness(source?: (stopId: string) => Promise<{ track: AudioTrack; uri: string; waypoint: Waypoint } | null>) {
  const p = fakePlayer();
  const events: AudioEngineEvent[] = [];
  const errors: string[] = [];
  const actor = new AudioActor({
    player: p.player,
    source: { resolve: source ?? (async (id) => ({ track: track(id), uri: `file:///${id}.m4a`, waypoint: waypointOf(id) })) },
    sink: (e) => events.push(e),
    now: () => 42,
    reportError: (err, detail) => errors.push(`${detail}: ${String(err)}`),
  });
  const kinds = () => events.map((e) => `${e.type}:${e.token}${e.type === 'AUDIO_INTERRUPTED' ? `:${e.by}` : ''}`).join(' ');
  return { actor, p, events, errors, kinds };
}
await (async () => {
  const a = actorHarness();
  a.actor.execute({ type: 'PLAY', token: 1, stopId: 's1', track: 'narration' });
  await a.actor.settled();
  assert('PLAY resolves the source and plays it', a.p.calls.join() === 'play s1');
  a.p.emit({ isPlaying: true, positionSeconds: 0 });
  assert('"playing" at 0:00 is NOT started (the undecodable-file trap)', a.events.length === 0);
  a.p.emit({ isPlaying: true, positionSeconds: 0.4 });
  assert('playhead past zero: AUDIO_STARTED with its token', a.kinds() === 'AUDIO_STARTED:1');
  a.p.emit({ isPlaying: false, positionSeconds: 3 });
  a.p.emit({ isPlaying: false, positionSeconds: 3 });
  assert('stops playing on its own: ONE os interruption', a.kinds() === 'AUDIO_STARTED:1 AUDIO_INTERRUPTED:1:os');
  a.p.emit({ isPlaying: true, positionSeconds: 3.2 });
  assert('plays again: resumed', a.kinds().endsWith('AUDIO_RESUMED:1'));
  a.actor.pauseByUser();
  a.p.emit({ isPlaying: false, positionSeconds: 4 });
  assert('a user pause is reported as by:user, and its silence is not an os interruption', a.kinds().endsWith('AUDIO_INTERRUPTED:1:user') && a.p.calls.includes('pause'));
  a.actor.resumeByUser();
  assert('user resume: resumed', a.kinds().endsWith('AUDIO_RESUMED:1') && a.p.calls.includes('resume'));
  a.p.emit({ isPlaying: false, positionSeconds: 60, didJustFinish: true });
  assert('track finishes: AUDIO_ENDED with its token', a.kinds().endsWith('AUDIO_ENDED:1'));
  const n = a.events.length;
  a.p.emit({ isPlaying: false, positionSeconds: 0 });
  assert('statuses after the end are not attributed to anything', a.events.length === n);
})();
await (async () => {
  // The engine's PLAY timeout: STOP arrives while the source is still resolving.
  const gate = deferred<{ track: AudioTrack; uri: string; waypoint: Waypoint } | null>();
  const a = actorHarness(() => gate.promise);
  a.actor.execute({ type: 'PLAY', token: 1, stopId: 's1', track: 'narration' });
  a.actor.execute({ type: 'STOP', token: 1, fade: false, reason: 'play_timeout' });
  gate.resolve({ track: track('s1'), uri: 'file:///s1.m4a', waypoint: waypointOf('s1') });
  await a.actor.settled();
  assert('stopped while resolving: the player is never created', !a.p.calls.some((c) => c.startsWith('play')));
  assert('...the STOP for a timeout records a drop-off, not a skip', a.p.calls.includes('stop audio_stopped'));
  assert('...and nothing is reported back for the dead token', a.events.length === 0);
})();
await (async () => {
  // STOP arrives while the player is LOADING: the late player is torn down.
  const a = actorHarness();
  const g = a.p.player.gate();
  a.actor.execute({ type: 'PLAY', token: 1, stopId: 's1', track: 'narration' });
  await tick();
  a.actor.execute({ type: 'STOP', token: 1, fade: false, reason: 'play_timeout' });
  g.resolve();
  await a.actor.settled();
  assert('stopped while loading: the late player is stopped right after it arrives (the STOP job is next in the lane)', a.p.calls.join() === 'play s1,stop audio_stopped');
  a.p.emit({ isPlaying: true, positionSeconds: 1 });
  assert('...and its status is never reported as STARTED', a.events.length === 0);
})();
await (async () => {
  const a = actorHarness();
  a.actor.execute({ type: 'PLAY', token: 1, stopId: 's1', track: 'narration' });
  a.actor.execute({ type: 'PLAY', token: 2, stopId: 's2', track: 'narration' });
  a.actor.execute({ type: 'STOP', token: 1, fade: false, reason: 'preempted' });
  await a.actor.settled();
  assert('a STOP for a superseded token never silences its successor', !a.p.calls.some((c) => c.startsWith('stop')) && a.p.calls.join() === 'play s2');
  a.actor.execute({ type: 'STOP', token: 2, fade: true, reason: 'zone_exit' });
  await a.actor.settled();
  assert('zone exit: the fade-out', a.p.calls.at(-1) === 'fade');
  a.actor.execute({ type: 'PLAY', token: 3, stopId: 's3', track: 'narration' });
  a.actor.execute({ type: 'STOP', token: 3, fade: false, reason: 'user_skip' });
  await a.actor.settled();
  assert('user skip: recorded as a skip', a.p.calls.at(-1) === 'stop audio_skipped');
})();
await (async () => {
  const a = actorHarness(async () => null);
  a.actor.execute({ type: 'PLAY', token: 7, stopId: 's1', track: 'deep_dive' });
  await a.actor.settled();
  assert('nothing playable: AUDIO_FAILED for that token', a.kinds() === 'AUDIO_FAILED:7');
  const b = actorHarness(async () => {
    throw new Error('offline');
  });
  b.actor.execute({ type: 'PLAY', token: 8, stopId: 's1', track: 'narration' });
  await b.actor.settled();
  assert('a source that throws: AUDIO_FAILED, the lane survives', b.kinds() === 'AUDIO_FAILED:8' && b.errors.length === 0);
  const c = actorHarness();
  c.actor.execute({ type: 'PLAY', token: 9, stopId: 's1', track: 'narration' });
  await c.actor.settled();
  c.p.fail('Audio did not load within 5s.');
  assert('AudioService onError: AUDIO_FAILED for the token on air', c.kinds() === 'AUDIO_FAILED:9');
  const d = actorHarness();
  d.p.player.stop = async () => {
    throw new Error('native crash');
  };
  d.actor.execute({ type: 'PLAY', token: 1, stopId: 's1', track: 'narration' });
  d.actor.execute({ type: 'STOP', token: 1, fade: false, reason: 'preempted' });
  d.actor.execute({ type: 'PLAY', token: 2, stopId: 's2', track: 'narration' });
  await d.actor.settled();
  assert('a command that throws is REPORTED and the next one still runs', d.errors.some((e) => e.includes('STOP 1') && e.includes('native crash')) && d.p.calls.includes('play s2'));
})();

// -----------------------------------------------------------------------------
heading('Audio session mode per platform and chapter');
// -----------------------------------------------------------------------------
assert('iOS driving: doNotMix (lock-screen controls)', interruptionModeFor('ios', 'driving') === 'doNotMix');
assert('iOS walking: doNotMix', interruptionModeFor('ios', 'walking') === 'doNotMix');
assert('Android driving: duckOthers', interruptionModeFor('android', 'driving') === 'duckOthers');
assert('Android walking / biking: doNotMix', interruptionModeFor('android', 'walking') === 'doNotMix' && interruptionModeFor('android', 'biking') === 'doNotMix');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
