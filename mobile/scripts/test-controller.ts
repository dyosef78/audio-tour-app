/**
 * TourSessionController, end to end in Node (Epic 17, TASK-1702).
 *
 * The REAL controller, engine, store, LocationService, AudioService, bundle
 * repository, checkpoint file and plan store - over the expo stubs in
 * ./stubs, with an in-memory file system and a fake clock. Before this, the
 * controller had no test at all: the sims re-implement its wiring, which is
 * how the paused re-entry wipe (engine audit, 11 Oct 2026) went unnoticed.
 *
 * A "process" is a fresh import of the controller module (a query string makes
 * Node evaluate it again); its children - store, repositories - are shared, as
 * the disk is. kill() is process death: every live timer and listener gone,
 * the store emptied, nothing torn down cleanly.
 *
 * Run: npm run test:controller
 */

import * as audio from './stubs/expo-audio.ts';
import * as fs from './stubs/expo-file-system.ts';
import * as location from './stubs/expo-location.ts';
import * as notifications from './stubs/expo-notifications.ts';
import * as rn from './stubs/react-native.ts';
import type { WireBundle, WireWaypoint } from '../src/services/bundle/types.ts';
import { tourProgress } from '../src/session/sessionCheckpointFile.ts';
import { useTourSession } from '../src/session/tourSessionStore.ts';
import { savedPlans } from '../src/services/planner/planRepositoryFile.ts';
import { parsePlanTourOk } from '../../shared/src/contracts/planTour.ts';
import { planSessionKey } from '../src/session/sessionKey.ts';
import type { GpsFix } from '../src/engine/types.ts';
import type { TourProgressSnapshot } from '../src/session/progressRepository.ts';
import { HEARTBEAT_MS } from '../src/session/EngineRunner.ts';

// --- reporting -----------------------------------------------------------------
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

// --- the clock -----------------------------------------------------------------
const T0 = 1_800_000_000_000;
let now = T0;
Date.now = () => now;
const advance = (ms: number): void => {
  now += ms;
};

// --- live engine heartbeats, so a leaked one is visible and a kill can end them --
// Only HEARTBEAT_MS intervals: the shared Supabase client runs its own 30 s
// auth refresh, which is not the controller's and survives "processes" here.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const liveIntervals = new Set<ReturnType<typeof setInterval>>();
globalThis.setInterval = ((fn: () => void, ms?: number) => {
  const h = realSetInterval(fn, ms);
  if (ms === HEARTBEAT_MS) liveIntervals.add(h);
  return h;
}) as typeof setInterval;
globalThis.clearInterval = ((h: ReturnType<typeof setInterval> | undefined) => {
  if (h !== undefined) liveIntervals.delete(h);
  realClearInterval(h);
}) as typeof clearInterval;

/** Let queued transitions, tracking ops and drains run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
}

/** Watchers started and not removed, plus the background task if running. */
async function liveTrackers(): Promise<number> {
  const watches = location.calls.filter((c) => c.kind === 'watch').length - location.calls.filter((c) => c.kind === 'watch-remove').length;
  return watches + ((await location.hasStartedLocationUpdatesAsync()) ? 1 : 0);
}

// --- processes -------------------------------------------------------------------
type Controller = (typeof import('../src/session/TourSessionController.ts'))['tourSession'];
const CONTROLLER_URL = new URL('../src/session/TourSessionController.ts', import.meta.url).href;
let processCount = 0;
async function newProcess(): Promise<Controller> {
  processCount++;
  const mod = (await import(`${CONTROLLER_URL}?process=${processCount}`)) as typeof import('../src/session/TourSessionController.ts');
  return mod.tourSession;
}
/** Process death: nothing ends cleanly; only the disk survives. */
function kill(): void {
  for (const h of [...liveIntervals]) globalThis.clearInterval(h);
  rn.__resetAppState();
  useTourSession.getState().reset();
  location.resetCalls();
}
function freshWorld(): void {
  kill();
  fs.__resetFs();
  notifications.__resetNotifications();
  now = T0;
}

function checkpoint(): TourProgressSnapshot | null {
  const loaded = tourProgress.load();
  return loaded.kind === 'found' ? loaded.snapshot : null;
}

// --- the world: a drive, then a walk (the Chapter 1 -> Chapter 2 handoff) -------
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOUR = uuid(0x1);
const OTHER_TOUR = uuid(0x2);
const DRIVE = uuid(0x10);
const WALK = uuid(0x20);

const wp = (id: string, sort: number, chapter: string, lon: number, lat: number): WireWaypoint => ({
  waypoint_id: id,
  name: id,
  poi_type: 'anchor',
  stop_role: 'core',
  sort_order: sort,
  coordinates: [lon, lat],
  geofence: { type: 'radius', radius_meters: 25, center: [lon, lat] },
  media: null,
  chapter_id: chapter,
  approach: null,
});
const bundle = (tourId: string, hash: string): WireBundle => ({
  bundle_version_hash: hash,
  tour_metadata: { tour_id: tourId, title: `Tour ${tourId.slice(-1)}`, topology: 'in_city', transit_mode: 'driving', duration_minutes: 90 },
  chapters: [
    { chapter_id: tourId === TOUR ? DRIVE : uuid(0x30), sort_order: 0, title: 'Drive', transit_mode: 'driving', sequence_policy: 'windowed', lookahead_stops: 2,
      handoff: { destination: [34.8, 32.1], destination_label: 'Car park', anchors: [], providers: ['google_maps', 'waze'] } },
    { chapter_id: tourId === TOUR ? WALK : uuid(0x40), sort_order: 1, title: 'Walk', transit_mode: 'walking', sequence_policy: 'windowed', lookahead_stops: 3, handoff: null },
  ],
  waypoints: [
    wp(uuid(tourId === TOUR ? 0x101 : 0x201), 1, tourId === TOUR ? DRIVE : uuid(0x30), 34.75, 32.05),
    wp(uuid(tourId === TOUR ? 0x102 : 0x202), 2, tourId === TOUR ? WALK : uuid(0x40), 34.81, 32.11),
  ],
});
function seedBundle(b: WireBundle): void {
  fs.__writeFile(`/document/bundles/${b.tour_metadata.tour_id}/manifest.json`, JSON.stringify(b));
}

/** Far from every stop, so nothing fires: the tests are about lifecycle. */
const PARKED = { latitude: 32.0, longitude: 34.7 };
function fix(at = PARKED, accuracyM = 10): GpsFix {
  return { coordinate: at, timestamp: now, accuracyM, speedMps: null, headingDeg: null };
}

/** Run a tour into Chapter 2, then park for 16 minutes: the idle pause. */
async function driveThenPark(tour: Controller): Promise<void> {
  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  tour.startNextChapter();
  await settle();
  tour.onBackgroundFixes([fix()]);
  await settle();
  advance(16 * 60_000);
  tour.onBackgroundFixes([fix()]);
  await settle();
}

// =============================================================================
heading('Baseline: start, chapter 2, idle pause');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const tour = await newProcess();
  await driveThenPark(tour);
  const s = useTourSession.getState();
  const cp = checkpoint();
  assert('the tour is paused for inactivity', s.status === 'paused', s.status);
  assert('the checkpoint is in chapter 2 and suspended', cp?.progress.chapterId === WALK && cp.progress.suspendedAt !== undefined, JSON.stringify(cp?.progress));
  assert('tracking is off while paused', (await liveTrackers()) === 0, String(await liveTrackers()));
  assert('the visitor was told (tour_suspended notification)', notifications.scheduled.some((n) => n.content.data?.kind === 'tour_suspended'));
  assert('exactly one heartbeat runs', liveIntervals.size === 1, String(liveIntervals.size));
}

// =============================================================================
heading('P1: re-entry into a PAUSED tour (notification tap, TourDetail Start)');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const tour = await newProcess();
  await driveThenPark(tour);
  const watchesBefore = location.restartCount();

  // What a tap does: App.tsx openActiveTour -> ActiveTourScreen's mount effect.
  await tour.startSession(TOUR, 'Tour 1');
  await settle();

  const s = useTourSession.getState();
  const cp = checkpoint();
  assert('still paused - the Resume banner is the only way back (PM: no auto-resume)', s.status === 'paused', s.status);
  assert('progress kept: the checkpoint is still in chapter 2', cp?.progress.chapterId === WALK, cp?.progress.chapterId);
  assert('progress kept: still suspended', cp?.progress.suspendedAt !== undefined);
  assert('the store still shows chapter 2', s.activeChapterId === WALK, String(s.activeChapterId));
  assert('no tracker started by the tap', location.restartCount() === watchesBefore && (await liveTrackers()) === 0, `${location.restartCount() - watchesBefore} starts, ${await liveTrackers()} live`);
  assert('no second heartbeat (the old runner did not leak)', liveIntervals.size === 1, String(liveIntervals.size));

  // Then the explicit Resume: tracking back, chapter 2 intact.
  tour.resumeTour();
  await settle();
  assert('Resume restarts tracking', useTourSession.getState().status === 'active' && (await liveTrackers()) === 1, `${useTourSession.getState().status}, ${await liveTrackers()} live`);
  assert('...in chapter 2', checkpoint()?.progress.chapterId === WALK);
}

// =============================================================================
heading('P1: killed while paused (iOS OOM under Maps), then the notification tap');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const first = await newProcess();
  await driveThenPark(first);
  kill();
  advance(10 * 60_000);

  const tour = await newProcess();
  await tour.reconcileOnColdStart();
  await settle();
  assert('cold start resumes it paused', useTourSession.getState().status === 'paused', useTourSession.getState().status);
  assert('...in chapter 2', checkpoint()?.progress.chapterId === WALK);

  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  assert('the tap after the kill keeps chapter 2', checkpoint()?.progress.chapterId === WALK, checkpoint()?.progress.chapterId);
  assert('...and stays paused, tracking off', useTourSession.getState().status === 'paused' && (await liveTrackers()) === 0);
  assert('one heartbeat', liveIntervals.size === 1, String(liveIntervals.size));
}

// =============================================================================
heading('Checkpoint-aware start: Start reached before the cold-start reconcile');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const first = await newProcess();
  await first.startSession(TOUR, 'Tour 1');
  await settle();
  first.startNextChapter();
  await settle();
  kill();

  // A screen effect (child) can run before App's reconcile effect (parent).
  const tour = await newProcess();
  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  assert('Start resumes the saved walk instead of starting over', checkpoint()?.progress.chapterId === WALK, checkpoint()?.progress.chapterId);
  assert('...and it runs', useTourSession.getState().status === 'active' && (await liveTrackers()) === 1, `${useTourSession.getState().status}, ${await liveTrackers()}`);
  await tour.reconcileOnColdStart();
  await settle();
  assert('the late reconcile changes nothing', checkpoint()?.progress.chapterId === WALK && liveIntervals.size === 1, `${checkpoint()?.progress.chapterId}, ${liveIntervals.size}`);
}

// =============================================================================
heading('Checkpoint-aware start: a hardware failure keeps the walk and fails loud');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const first = await newProcess();
  await first.startSession(TOUR, 'Tour 1');
  await settle();
  first.startNextChapter();
  await settle();
  kill();

  const tour = await newProcess();
  audio.__failNextAudioMode();
  let threw: unknown = null;
  try {
    await tour.startSession(TOUR, 'Tour 1');
  } catch (err) {
    threw = err;
  }
  await settle();
  assert('Start rejects with SessionStartError(audio)', threw instanceof Error && threw.name === 'SessionStartError' && (threw as Error & { stage?: string }).stage === 'audio', String(threw));
  assert('the store shows the error, nothing is held', useTourSession.getState().status === 'error' && (await liveTrackers()) === 0 && liveIntervals.size === 0);
  assert('the checkpoint survives, still in chapter 2', checkpoint()?.progress.chapterId === WALK, checkpoint()?.progress.chapterId);

  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  assert('the retry resumes chapter 2', useTourSession.getState().status === 'active' && checkpoint()?.progress.chapterId === WALK, `${useTourSession.getState().status} ${checkpoint()?.progress.chapterId}`);
}

// =============================================================================
heading('Switching tours while paused ends the old one');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  seedBundle(bundle(OTHER_TOUR, 'h2'));
  const tour = await newProcess();
  await driveThenPark(tour);
  await tour.startSession(OTHER_TOUR, 'Tour 2');
  await settle();
  const cp = checkpoint();
  assert('the other tour runs, from its start', useTourSession.getState().tourId === OTHER_TOUR && useTourSession.getState().status === 'active' && cp?.tourId === OTHER_TOUR && cp.progress.chapterId === uuid(0x30), `${useTourSession.getState().tourId} ${cp?.tourId} ${cp?.progress.chapterId}`);
  assert('one tracker, one heartbeat', (await liveTrackers()) === 1 && liveIntervals.size === 1, `${await liveTrackers()}, ${liveIntervals.size}`);
}

// =============================================================================
heading('Re-entry into an ACTIVE tour is a no-op (StrictMode remount)');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const tour = await newProcess();
  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  tour.startNextChapter();
  await settle();
  const starts = location.restartCount();
  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  assert('chapter 2 kept, nothing restarted', checkpoint()?.progress.chapterId === WALK && location.restartCount() === starts && liveIntervals.size === 1);
}

// =============================================================================
heading('Fail loud: launch() over a live session throws');
// =============================================================================
{
  freshWorld();
  seedBundle(bundle(TOUR, 'h1'));
  const tour = await newProcess();
  await tour.startSession(TOUR, 'Tour 1');
  await settle();
  let threw: unknown = null;
  try {
    // Unreachable through the public API after the fix; the invariant itself is pinned.
    await (tour as unknown as { launch: (spec: unknown) => Promise<void> }).launch({});
  } catch (err) {
    threw = err;
  }
  assert('launch() refuses to run over a live session', threw instanceof Error && /live session/.test(threw.message), String(threw));
  assert('...and the running session is untouched', useTourSession.getState().status === 'active' && liveIntervals.size === 1);
}

// =============================================================================
heading('Planned session: re-entry while paused keeps the plan position');
// =============================================================================
{
  freshWorld();
  const b = bundle(TOUR, 'h1');
  seedBundle(b);
  const PLAN_ID = uuid(0x500);
  const plan = parsePlanTourOk({
    status: 'ok', contract_version: 1, plan_id: PLAN_ID, planner_version: 'v4', content_hash: 'c'.repeat(32), expires_at: '2026-11-05T00:00:00Z',
    sources: [{ tour_id: TOUR, bundle_version_hash: 'h1' }],
    segments: [
      { kind: 'transfer', from: { kind: 'origin' }, to_chapter_id: WALK, to: { lon: 34.81, lat: 32.11 }, mode: 'driving', duration_s: 600, distance_m: 9000, cost_source: 'valhalla', providers: ['google_maps', 'waze'] },
      { kind: 'chapter', tour_id: TOUR, chapter_id: WALK, transit_mode: 'walking', waypoint_ids: [uuid(0x102)], kept_extension_ids: [], dropped_extension_ids: [], silent_stop_ids: [], travel_s: 60, dwell_s: 60, cost_source: 'valhalla' },
    ],
    estimate: { budget_s: 3600, total_s: 720, transfer_s: 600, chapter_travel_s: 60, dwell_s: 60, deep_dive_extra_s: 0, slack_s: 2880, pace_factor: 1 },
    quality: { candidates_considered: 1, legs_total: 2, legs_estimated: 0, search_truncated: false, dropped_high_value_extensions: 0 },
  });
  savedPlans.putDraft({
    plan,
    request: { contract_version: 1, city_id: uuid(0x900), origin: { lon: 34.7, lat: 32.0, source: 'gps' }, available_minutes: 60, transit_mode: 'driving', group_type: 'solo', interests: ['history'], context: { local_time: '2026-10-11T10:00:00+03:00' }, include_deep_dives: false },
    originLabel: 'Here', status: 'draft', savedAt: now, downloadRequestedAt: null,
  } as Parameters<typeof savedPlans.putDraft>[0]);
  savedPlans.markSaved(PLAN_ID);

  const key = planSessionKey(PLAN_ID);
  const tour = await newProcess();
  await tour.startPlannedSession(PLAN_ID, 'My plan');
  await settle();
  assert('the plan runs', useTourSession.getState().status === 'active' && useTourSession.getState().tourId === key, `${useTourSession.getState().status} ${useTourSession.getState().error}`);
  tour.startNextChapter(); // transfer -> the walk
  await settle();
  tour.onBackgroundFixes([fix()]);
  await settle();
  advance(16 * 60_000);
  tour.onBackgroundFixes([fix()]);
  await settle();
  assert('paused in the walk', useTourSession.getState().status === 'paused' && checkpoint()?.progress.chapterId === WALK, `${useTourSession.getState().status} ${checkpoint()?.progress.chapterId}`);

  await tour.startPlannedSession(PLAN_ID, 'My plan');
  await settle();
  assert('re-entry keeps the walk and the pause', checkpoint()?.progress.chapterId === WALK && useTourSession.getState().status === 'paused', `${checkpoint()?.progress.chapterId} ${useTourSession.getState().status}`);
  assert('no tracker, one heartbeat', (await liveTrackers()) === 0 && liveIntervals.size === 1, `${await liveTrackers()}, ${liveIntervals.size}`);
}

// --- summary --------------------------------------------------------------------
kill();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
