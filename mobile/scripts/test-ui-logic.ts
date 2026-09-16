/**
 * TASK-601/602 - logic behind the onboarding and player UI.
 *
 * Runs the REAL modules in Node, with AsyncStorage, react-native and expo-audio
 * redirected to the stubs in ./stubs. Components are not rendered here; what is
 * tested is every decision a component delegates: which transcript line is lit,
 * which direction it reads, what gets persisted, what survives a zone exit, and
 * whether a seek can trip the stall watchdog.
 *
 * Run:  npm run test:ui
 */

import { mock } from 'node:test';

import {
  parseGroupTypes,
  parseInterests,
  routeCriteria,
  tourFitsBudget,
} from '../src/personalization/options.ts';
import { planBundleFiles } from '../src/services/bundle/plan.ts';
import { tourFromManifest } from '../src/services/bundle/catalogue.ts';
import type { WireBundle } from '../src/services/bundle/types.ts';
import { transcriptPathFor } from '../src/transcript/sidecar.ts';
import { usePreferences, usePreferencesBoot } from '../src/personalization/preferencesStore.ts';
import { AudioService, type PlaybackError } from '../src/services/audio/AudioService.ts';
import { useTourSession } from '../src/session/tourSessionStore.ts';
import { cueIndexAt, isRtlText, parseVtt, VttParseError } from '../src/transcript/vtt.ts';
import type { AudioTrack, EncodedRoute, LatLng, Waypoint } from '../src/types/domain.ts';
import { encodePolyline } from '../../shared/src/polyline.ts';
import { RouteManager, type RouteSessionContext } from '../src/routing/RouteManager.ts';
import {
  isPermanentRouteStatus,
  routeCacheKey,
  type DynamicRouteRequest,
  type DynamicRouteResult,
  type RouteDisplay,
} from '../src/routing/routeDecision.ts';
import { decodeRoute, parseEncodedRoute } from '../src/routing/routeGeometry.ts';
import { selectStops } from '../src/routing/stopSelection.ts';
import {
  adoptableStopOrder,
  deviceLocalTime,
  formatLocalTime,
  parseRouteOrder,
  routeRequestBody,
} from '../src/routing/routeRequest.ts';
import { LocationService, type GeofenceEvent } from '../src/services/location/LocationService.ts';
import { StopSequence } from '../src/services/location/stopSequence.ts';
import { parseLocalTime } from '../../shared/src/smartSorter.ts';
import { connectivityOf } from '../src/services/network/connectivity.ts';
import AsyncStorage, { __dump, __setFailReads } from './stubs/async-storage.ts';
import { players } from './stubs/expo-audio.ts';

// -----------------------------------------------------------------------------
// Tiny test harness
// -----------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, a === e ? undefined : `got ${a}, expected ${e}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// -----------------------------------------------------------------------------
// WebVTT
// -----------------------------------------------------------------------------

heading('parseVtt');

const SAMPLE = [
  '﻿WEBVTT - Stop 1',
  '',
  'NOTE authored in the CMS',
  'and spanning two lines',
  '',
  'STYLE',
  '::cue { color: red }',
  '',
  '1',
  '00:00:00.000 --> 00:00:04.500 align:start position:10%',
  '<v Narrator>Welcome to <i>Tel Aviv</i>.</v>',
  '',
  // Out of order on purpose.
  '00:09.000 --> 00:12.250',
  'Fish &amp; chips',
  'on a second line',
  '',
  '00:04.500 --> 00:09.000',
  'Escaped &lt;b&gt; stays visible',
  '',
  'broken-timing',
  '00:10.000 --> 00:09.000',
  'Ends before it starts',
  '',
  '00:13.000 --> 00:14.000',
  '<c.yellow></c>',
  '',
].join('\r\n');

const parsed = parseVtt(SAMPLE);
eq('three usable cues', parsed.cues.length, 3);
eq('two unusable cue blocks counted, NOTE/STYLE not', parsed.skipped, 2);
eq('sorted by start time', parsed.cues.map((c) => c.start), [0, 4.5, 9]);
eq('voice and italic tags stripped', parsed.cues[0]?.text, 'Welcome to Tel Aviv.');
eq('escaped markup decoded, not stripped', parsed.cues[1]?.text, 'Escaped <b> stays visible');
eq('entities decoded, lines joined', parsed.cues[2]?.text, 'Fish & chips on a second line');
eq('hour-less timestamp end', parsed.cues[2]?.end, 12.25);
eq('hours parsed', parseVtt('WEBVTT\n\n01:02:03.004 --> 01:02:04.000\nx').cues[0]?.start, 3723.004);

for (const [label, source] of [
  ['no signature', '00:00.000 --> 00:01.000\nhello'],
  ['signature glued to text', 'WEBVTTX\n\n00:00.000 --> 00:01.000\nhello'],
  ['an HTML error page', '<!doctype html><title>404</title>'],
] as const) {
  let threw = false;
  try {
    parseVtt(source);
  } catch (err) {
    threw = err instanceof VttParseError;
  }
  assert(`rejects ${label}`, threw);
}

heading('cueIndexAt');

const cues = parsed.cues;
eq('before the first cue', cueIndexAt([{ start: 1, end: 2, text: 'a' }], 0.5), -1);
eq('exactly at a start', cueIndexAt(cues, 4.5), 1);
eq('just before the next start', cueIndexAt(cues, 4.499), 0);
eq('in a silence between cues, holds the previous line', cueIndexAt([{ start: 0, end: 2, text: 'a' }, { start: 5, end: 7, text: 'b' }], 3), 0);
eq('after the last cue ends, holds the last line', cueIndexAt(cues, 99), 2);
eq('no cues', cueIndexAt([], 3), -1);

heading('isRtlText');

assert('Hebrew narration from the Tel Aviv seed', isRtlText('ברוכים הבאים לסיור שלנו בתל אביב.'));
assert('Hebrew line that opens with a digit', isRtlText('8 דובנוב היא מסעדה'));
assert('English', !isRtlText('Welcome to Tel Aviv.'));
assert('Latin name first decides LTR', !isRtlText('Dubnov 8 ביסטרו'));
assert('no letters at all', !isRtlText('12:30 — !'));

// -----------------------------------------------------------------------------
// Personalisation
// -----------------------------------------------------------------------------

heading('routeCriteria / tourFitsBudget');

eq('incomplete preferences give no criteria', routeCriteria({ groupType: 'solo', interests: [], timeBudget: 'quick' }), null);
const quick = routeCriteria({ groupType: 'couple', interests: ['history'], timeBudget: 'quick' });
eq('complete preferences', quick, { groupType: 'couple', interests: ['history'], maxMinutes: 60 });
eq('a 45 min tour fits a quick walk', tourFitsBudget(45, quick), true);
eq('a 60 min tour fits exactly', tourFitsBudget(60, quick), true);
eq('a 90 min tour does not', tourFitsBudget(90, quick), false);
eq('no criteria means no opinion, not "no"', tourFitsBudget(90, null), null);

heading('preferences store');

await flush();
eq('boot gate opens after the first restore', usePreferencesBoot.getState(), { ready: true, restoreFailed: false });

const prefs = usePreferences.getState();
prefs.setGroupType('family_kids');
prefs.toggleInterest('history');
prefs.toggleInterest('culinary');
prefs.toggleInterest('history');
prefs.setTimeBudget('half_day');
prefs.completeOnboarding();
eq('toggle adds and removes', usePreferences.getState().interests, ['culinary']);

await flush();
const raw = __dump()['user-preferences'];
const saved = raw === undefined ? null : (JSON.parse(raw) as { version: number; state: Record<string, unknown> });
eq('persisted with a schema version', saved?.version, 1);
eq(
  'persists exactly the four preference fields - no actions',
  Object.keys(saved?.state ?? {}).sort(),
  ['groupType', 'interests', 'onboardingComplete', 'timeBudget'],
);

// Simulated relaunch. Clearing memory writes through persist, so put the saved
// payload back before reading it.
usePreferences.setState({ groupType: null, interests: [], timeBudget: null, onboardingComplete: false });
if (raw !== undefined) await AsyncStorage.setItem('user-preferences', raw);
await usePreferences.persist.rehydrate();
eq('relaunch restores preferences', usePreferences.getState().groupType, 'family_kids');
eq('relaunch skips onboarding', usePreferences.getState().onboardingComplete, true);

// The failure the boot store exists for.
usePreferencesBoot.setState({ ready: false, restoreFailed: false });
__setFailReads(true);
await usePreferences.persist.rehydrate();
__setFailReads(false);
assert(
  'zustand itself never reports hydrated after a failed read',
  !usePreferences.persist.hasHydrated(),
  'if this starts passing, zustand changed and the boot store could be simplified',
);
eq('boot gate still opens, flagged as failed', usePreferencesBoot.getState(), { ready: true, restoreFailed: true });

// -----------------------------------------------------------------------------
// Deep Dive session semantics
// -----------------------------------------------------------------------------

heading('Deep Dive vs geofence events');

function waypoint(id: string, sortOrder: number): Waypoint {
  return {
    id,
    tourId: 'tour',
    name: `Stop ${id}`,
    poiType: 'anchor',
    coordinate: { latitude: 32.08, longitude: 34.79 },
    sortOrder,
    geofence: null,
    audio: null,
  };
}

const session = useTourSession.getState();
session.sessionStarted({ waypoints: [waypoint('A', 1), waypoint('B', 2)], transitMode: 'walking', backgroundPermission: true });

session.markEntered('A');
session.startDeepDive('A');
session.markExited('A');
eq('exiting keeps the stop whose Deep Dive is playing', useTourSession.getState().activeWaypointId, 'A');

session.markEntered('A');
eq('re-entering the same stop keeps its Deep Dive', useTourSession.getState().deepDiveWaypointId, 'A');

session.markEntered('B');
eq('a different stop displaces the Deep Dive', useTourSession.getState().deepDiveWaypointId, null);
eq('and becomes active', useTourSession.getState().activeWaypointId, 'B');

session.markExited('B');
eq('without a Deep Dive, exit clears the stop as before', useTourSession.getState().activeWaypointId, null);

session.reset();
eq('reset clears the Deep Dive', useTourSession.getState().deepDiveWaypointId, null);

// -----------------------------------------------------------------------------
// Seek vs the stall watchdog
// -----------------------------------------------------------------------------

heading('AudioService.seekTo');

mock.timers.enable({ apis: ['setTimeout'] });

const track: AudioTrack = {
  id: 'A:audio',
  waypointId: 'A',
  storagePath: 'tours/tour/wp01_a.m4a',
  audioTrackId: null,
  durationSeconds: 120,
  format: 'AAC',
  sizeBytes: 960_000,
};

const audio = new AudioService();
let failure: PlaybackError | null = null;
audio.setOnError((e) => {
  failure = e;
});

await audio.play(track, 'file:///bundles/tour/media/tours/tour/wp01_a.m4a', waypoint('A', 1));
const player = players.at(-1);
assert('a player was created', player !== undefined);

if (player) {
  player.emitStatus({ currentTime: 30, duration: 120 });

  // Seek back while a status tick carrying the OLD position is in flight.
  const seeking = audio.seekTo(5);
  player.emitStatus({ currentTime: 30.4, duration: 120 });
  await seeking;
  eq('seek reached the player', player.seekedTo, 5);

  // Twelve seconds of healthy playback from the new position - longer than the
  // 8 s stall window, all of it below the pre-seek position.
  for (let t = 6; t <= 17; t++) {
    mock.timers.tick(1000);
    player.emitStatus({ currentTime: t, duration: 120 });
  }
  eq('no false "stalled" after a backward seek', (failure as PlaybackError | null)?.reason ?? null, null);

  mock.timers.tick(9000);
  eq('a genuine stall is still caught', (failure as PlaybackError | null)?.reason ?? null, 'stalled');
}

mock.timers.reset();

// -----------------------------------------------------------------------------
// TASK-603: what a bundle download fetches
// -----------------------------------------------------------------------------

heading('planBundleFiles');

const T = 'tours/t';
const media = (path: string, size: number, transcript?: { storage_path: string; size_bytes: number } | null) => ({
  storage_path: path,
  size_bytes: size,
  duration_seconds: 10,
  format: 'AAC',
  ...(transcript === undefined ? {} : { transcript }),
});
const wp = (id: string, sort: number, extra: Partial<WireBundle['waypoints'][number]>) => ({
  waypoint_id: id,
  name: `Stop ${id}`,
  poi_type: 'anchor',
  sort_order: sort,
  coordinates: [34.79, 32.08] as [number, number],
  geofence: null,
  media: null,
  ...extra,
});

const bundlePlan = planBundleFiles({
  bundle_version_hash: 'h',
  tour_metadata: { tour_id: 't', title: 'T', topology: 'in_city', transit_mode: 'walking', duration_minutes: 30 },
  waypoints: [
    wp('a', 1, {
      media: media(`${T}/wp01_a.m4a`, 100, { storage_path: `${T}/wp01_a.vtt`, size_bytes: 20 }),
      deep_dive: media(`${T}/wp01_a.deep_dive.m4a`, 900, { storage_path: `${T}/wp01_a.deep_dive.vtt`, size_bytes: 80 }),
    }),
    // Shares a's recording AND its transcript.
    wp('b', 2, { media: media(`${T}/wp01_a.m4a`, 100, { storage_path: `${T}/wp01_a.vtt`, size_bytes: 20 }) }),
    // A pre-TASK-603 manifest: no transcript, deep_dive or tag keys at all.
    wp('c', 3, { media: media(`${T}/wp03_c.m4a`, 50) }),
    // A transcript at the wrong name, and a deep dive transcript with no size.
    wp('d', 4, {
      media: media(`${T}/wp04_d.m4a`, 60, { storage_path: `${T}/elsewhere.vtt`, size_bytes: 10 }),
      deep_dive: media(`${T}/wp04_d.deep_dive.m4a`, 70, { storage_path: `${T}/wp04_d.deep_dive.vtt`, size_bytes: 0 }),
    }),
    wp('e', 5, { media: null, deep_dive: null }),
  ],
});

eq('narration, deep dives and valid transcripts, de-duplicated, in tour order', bundlePlan.files.map((f) => f.storagePath), [
  `${T}/wp01_a.m4a`,
  `${T}/wp01_a.vtt`,
  `${T}/wp01_a.deep_dive.m4a`,
  `${T}/wp01_a.deep_dive.vtt`,
  `${T}/wp03_c.m4a`,
  `${T}/wp04_d.m4a`,
  `${T}/wp04_d.deep_dive.m4a`,
]);
eq('kinds recorded', bundlePlan.files.map((f) => f.kind), [
  'narration', 'transcript', 'deep_dive', 'transcript', 'narration', 'narration', 'deep_dive',
]);
eq('transcript sizes carried for validation', bundlePlan.files.find((f) => f.kind === 'transcript')?.sizeBytes, 20);
eq('two bad transcript entries skipped with warnings, not failures', bundlePlan.warnings.length, 2);
assert(
  'the mis-named transcript names the path it expected',
  bundlePlan.warnings.some((w) => w.includes('expected tours/t/wp04_d.vtt')),
  JSON.stringify(bundlePlan.warnings),
);

heading('Bundle tags and sidecar paths');

eq('unknown and non-string interests dropped', parseInterests(['history', 'shopping', 3, null, 'nature']), ['history', 'nature']);
eq('absent tags parse as untagged', parseGroupTypes(undefined), []);
eq('audiences filtered to known ids', parseGroupTypes(['family_kids', 'couples']), ['family_kids']);
eq('m4a sidecar', transcriptPathFor('tours/t/wp01_a.m4a'), 'tours/t/wp01_a.vtt');
eq('deep dive sidecar', transcriptPathFor('tours/t/wp01_a.deep_dive.m4a'), 'tours/t/wp01_a.deep_dive.vtt');
eq('MP3 fallback, any case', transcriptPathFor('tours/t/B.MP3'), 'tours/t/B.vtt');
eq('no audio extension, no sidecar (never the file itself)', transcriptPathFor('tours/t/a.opus'), null);

// -----------------------------------------------------------------------------
// TASK-604: which stops run, which route is drawn, and what the network does
// -----------------------------------------------------------------------------

heading('selectStops');

const stopAt = (
  id: string,
  sort: number,
  lat: number,
  lng: number,
  tags: Partial<Pick<Waypoint, 'audiences' | 'interests'>> = {},
): Waypoint => ({
  id,
  tourId: 'jlm',
  name: `Stop ${id}`,
  poiType: 'anchor',
  coordinate: { latitude: lat, longitude: lng },
  sortOrder: sort,
  geofence: null,
  audio: null,
  ...tags,
});

// The Jerusalem seed's four stops.
const JAFFA = stopAt('jaffa', 1, 31.7766, 35.2279, { interests: ['history', 'architecture'] });
const DAVID = stopAt('david', 2, 31.7761, 35.2281, { interests: ['architecture'] });
const CARDO = stopAt('cardo', 3, 31.7757, 35.2312, { interests: ['culinary'] });
const WALL = stopAt('wall', 4, 31.7767, 35.2344); // untagged: never filtered out
const ALL_STOPS = [JAFFA, DAVID, CARDO, WALL];
const HISTORY_COUPLE = { groupType: 'couple' as const, interests: ['history' as const], maxMinutes: 60 };

const selection = selectStops(ALL_STOPS, HISTORY_COUPLE);
eq('keeps matching and untagged stops, in order', selection.active.map((s) => s.id), ['jaffa', 'wall']);
eq('reports the skipped stops', selection.skippedIds, ['david', 'cardo']);
eq('marks the session as filtered', selection.filtered, true);
eq('no preferences: nothing filtered', selectStops(ALL_STOPS, null).filtered, false);
eq(
  'every stop matches: not "filtered", so no live route is ever requested',
  selectStops(ALL_STOPS, { ...HISTORY_COUPLE, interests: ['history', 'architecture', 'culinary'] }).filtered,
  false,
);
const oneLeft = selectStops([JAFFA, DAVID, CARDO], { ...HISTORY_COUPLE, interests: ['culinary'] });
eq('fewer than 2 stops would remain: the whole tour runs instead', [oneLeft.active.length, oneLeft.filtered], [3, false]);
eq(
  'audience tags filter too',
  selectStops(
    [stopAt('bar', 1, 0, 0, { audiences: ['couple'] }), stopAt('park', 2, 0, 0), stopAt('zoo', 3, 0, 0, { audiences: ['family_kids'] })],
    { groupType: 'family_kids', interests: ['nature'], maxMinutes: 60 },
  ).skippedIds,
  ['bar'],
);

heading('connectivityOf');

eq('reachable', connectivityOf({ isConnected: true, isInternetReachable: true }), 'online');
eq('connected but no internet (captive portal, Android)', connectivityOf({ isConnected: true, isInternetReachable: false }), 'offline');
eq('connected, reachability unknown: worth trying', connectivityOf({ isConnected: true }), 'online');
eq('no connection', connectivityOf({ isConnected: false }), 'offline');
eq('nothing known yet', connectivityOf({}), 'unknown');

heading('parseEncodedRoute / decodeRoute');

const asPoint = (s: Waypoint) => ({ lat: s.coordinate.latitude, lng: s.coordinate.longitude });
const STATIC_ROUTE: EncodedRoute = { precision: 6, polyline: encodePolyline(ALL_STOPS.map(asPoint), 6), lengthMeters: 700 };
const DIRECT_ROUTE: EncodedRoute = { precision: 5, polyline: encodePolyline([JAFFA, WALL].map(asPoint), 5), lengthMeters: 620 };
const FAR = stopAt('far', 5, 31.78, 35.231); // ~380 m north of the Jaffa-Wall line

eq(
  'wire route parsed',
  parseEncodedRoute({ encoding: 'polyline', precision: 6, polyline: 'abc', length_meters: 12 }),
  { precision: 6, polyline: 'abc', lengthMeters: 12 },
);
eq('missing precision rejected, never defaulted to 5', parseEncodedRoute({ encoding: 'polyline', polyline: 'abc' }), null);
eq('unknown encoding rejected', parseEncodedRoute({ encoding: 'geojson', precision: 6, polyline: 'abc' }), null);
eq('bundles from before TASK-604 carry no route', parseEncodedRoute(undefined), null);
assert('the bundled route passes every stop', decodeRoute(STATIC_ROUTE, ALL_STOPS, 'walking').ok);
assert('a direct route validates for the two stops it joins', decodeRoute(DIRECT_ROUTE, [JAFFA, WALL], 'walking').ok);
const missesStop = decodeRoute(DIRECT_ROUTE, [JAFFA, FAR, WALL], 'walking');
assert(
  'a route is rejected for a stop it does not reach',
  !missesStop.ok && missesStop.reason.includes('Stop far'),
  JSON.stringify(missesStop),
);
const mislabelled = decodeRoute({ ...DIRECT_ROUTE, precision: 6 }, [JAFFA, WALL], 'walking');
assert('a precision-5 route labelled 6 is rejected', !mislabelled.ok, JSON.stringify(mislabelled));
eq('cache key ignores stop order', routeCacheKey('t', 'h', ['b', 'a']), routeCacheKey('t', 'h', ['a', 'b']));
assert('cache key changes with the bundle version', routeCacheKey('t', 'h1', ['a']) !== routeCacheKey('t', 'h2', ['a']));
eq('no bundle hash, no caching', routeCacheKey('t', null, ['a']), null);
eq(
  'route-stops statuses that stop retrying',
  [400, 401, 403, 404, 408, 422, 429, 500, 501, 502, 504].filter((s) => isPermanentRouteStatus(s)),
  [400, 403, 404, 422, 501],
);
eq('no status (network error) is retried', isPermanentRouteStatus(undefined), false);

heading('RouteManager: live, bundled and straight routes across connectivity changes');

type PendingRequest = {
  req: DynamicRouteRequest;
  signal: AbortSignal;
  resolve: (result: DynamicRouteResult) => void;
};

function routeHarness(opts: { online: boolean; cache?: Map<string, EncodedRoute> }) {
  let online = opts.online;
  const listeners = new Set<(online: boolean) => void>();
  const calls: PendingRequest[] = [];
  const published: RouteDisplay[] = [];
  const timers: { fn: () => void; delay: number; done: boolean }[] = [];
  const cache = opts.cache ?? new Map<string, EncodedRoute>();

  const manager = new RouteManager({
    network: {
      isOnline: () => online,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    // A request that never settles by itself, like a real one on a bad link.
    // Aborting resolves it the way supabase-js does: as a failure.
    fetchRoute: (req, signal) =>
      new Promise((resolve) => {
        calls.push({ req, signal, resolve });
        signal.addEventListener('abort', () => resolve({ kind: 'failed', reason: 'aborted' }));
      }),
    cache: {
      get: async (key) => cache.get(key) ?? null,
      set: async (key, route) => {
        cache.set(key, route);
      },
    },
    publish: (route) => published.push(route),
    schedule: (fn, delay) => {
      const timer = { fn, delay, done: false };
      timers.push(timer);
      return () => {
        timer.done = true;
      };
    },
  });

  return {
    manager,
    calls,
    published,
    cache,
    listeners,
    pendingTimers: () => timers.filter((t) => !t.done).map((t) => t.delay),
    source: () => published.at(-1)?.source,
    setOnline: async (next: boolean) => {
      online = next;
      for (const listener of [...listeners]) listener(next);
      await flush();
    },
    fireTimer: async () => {
      const timer = timers.filter((t) => !t.done).pop();
      if (timer) {
        timer.done = true;
        timer.fn();
      }
      await flush();
    },
  };
}

const staticPoints = (decodeRoute(STATIC_ROUTE, ALL_STOPS, 'walking') as { ok: true; points: LatLng[] }).points;
const sessionFor = (over: Partial<RouteSessionContext> = {}): RouteSessionContext => ({
  tourId: 'jlm',
  transitMode: 'walking',
  stops: [JAFFA, WALL],
  filtered: true,
  staticRoute: staticPoints,
  bundleHash: 'hash-1',
  ...over,
});
const liveRoute = (route: EncodedRoute = DIRECT_ROUTE, waypointIds: string[] | null = null): DynamicRouteResult => ({
  kind: 'ok',
  route,
  waypointIds,
});

// 1. Offline -> online -> offline, then a later session with no signal at all.
{
  const h = routeHarness({ online: false });
  await h.manager.start(sessionFor());
  await flush();
  eq('offline start: bundled route drawn at once', h.source(), 'static');
  eq('offline start: nothing requested', h.calls.length, 0);

  await h.setOnline(true);
  eq('back online: one request, for the selected stops only', h.calls.map((c) => c.req.waypointIds), [['jaffa', 'wall']]);
  eq('while it is in flight the bundled route stays up', h.source(), 'static');

  h.calls[0]!.resolve(liveRoute());
  await flush();
  eq('valid response: live route drawn', h.source(), 'dynamic');
  eq('and written to the disk cache', h.cache.size, 1);

  await h.setOnline(false);
  eq('offline again: the live route is kept, not downgraded', h.source(), 'dynamic');
  eq('and nothing more is requested', h.calls.length, 1);

  h.manager.stop();
  eq('stop() unsubscribes from the network', h.listeners.size, 0);

  const later = routeHarness({ online: false, cache: h.cache });
  await later.manager.start(sessionFor());
  await flush();
  eq('next session, same stops, no signal: cached live route and zero requests', [later.source(), later.calls.length], ['dynamic', 0]);
  later.manager.stop();
}

// 2. A failed request: backoff, a timer firing while offline, a reconnect.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor());
  await flush();
  eq('online start: requests straight away', h.calls.length, 1);

  h.calls[0]!.resolve({ kind: 'failed', reason: 'HTTP 502' });
  await flush();
  eq('failure: bundled route kept', h.source(), 'static');
  eq('a retry is scheduled in 5 s', h.pendingTimers(), [5000]);

  await h.setOnline(false);
  await h.fireTimer();
  eq('the retry timer firing while offline sends nothing', h.calls.length, 1);

  await h.setOnline(true);
  eq('the reconnect retries at once', h.calls.length, 2);
  h.calls[1]!.resolve(liveRoute());
  await flush();
  eq('second attempt succeeds: live route', h.source(), 'dynamic');
  h.manager.stop();
}

// 3. Connections dropping mid-request do not use up the attempts.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor());
  await flush();
  for (let i = 0; i < 4; i++) {
    await h.setOnline(false);
    await h.setOnline(true);
  }
  eq('four drops mid-request, more than the 3-attempt limit: a fifth request still goes out', h.calls.length, 5);
  eq('each dropped request was actually aborted', h.calls.slice(0, 4).every((c) => c.signal.aborted), true);
  h.calls[4]!.resolve(liveRoute());
  await flush();
  eq('and it delivers the live route', h.source(), 'dynamic');
  h.manager.stop();
}

// 4. Endpoint not deployed - today's reality.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor());
  await flush();
  h.calls[0]!.resolve({ kind: 'unavailable', reason: 'route-stops answered HTTP 404' });
  await flush();
  await h.setOnline(false);
  await h.setOnline(true);
  eq(
    'endpoint missing (404): bundled route, no retries, no timers',
    [h.source(), h.calls.length, h.pendingTimers().length],
    ['static', 1, 0],
  );
  h.manager.stop();
}

// 5. The server answers with a route that does not fit the stops.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor());
  await flush();
  h.calls[0]!.resolve(liveRoute({ ...DIRECT_ROUTE, precision: 6 }));
  await flush();
  await h.setOnline(false);
  await h.setOnline(true);
  eq(
    'a bad route is never drawn, cached, or asked for again',
    [h.source(), h.cache.size, h.calls.length],
    ['static', 0, 1],
  );
  h.manager.stop();
}

// 6. Three genuine failures exhaust the session.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor());
  await flush();
  for (let i = 0; i < 3; i++) {
    h.calls[i]!.resolve({ kind: 'failed', reason: 'timeout' });
    await flush();
    await h.fireTimer();
  }
  await h.setOnline(false);
  await h.setOnline(true);
  eq('after 3 real failures it stops asking; bundled route stays', [h.calls.length, h.source()], [3, 'static']);
  h.manager.stop();
}

// 7-9. No filtering, no route at all, and a late answer after the tour ended.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor({ filtered: false, stops: ALL_STOPS }));
  await flush();
  eq('nothing filtered: the bundled route is already right, no request even online', [h.source(), h.calls.length], ['static', 0]);
  h.manager.stop();
}
{
  const h = routeHarness({ online: false });
  await h.manager.start(sessionFor({ staticRoute: null }));
  await flush();
  eq('no bundled route and no signal: straight (dashed) lines', h.source(), 'straight');
  h.manager.stop();
}
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor());
  await flush();
  const publishedBefore = h.published.length;
  h.manager.stop();
  h.calls[0]!.resolve(liveRoute());
  await flush();
  eq(
    'an answer arriving after the tour ended is aborted and ignored',
    [h.published.length, h.cache.size, h.calls[0]!.signal.aborted],
    [publishedBefore, 0, true],
  );
}

// 10-12. TASK-902: the visiting order travels with the route that validated.
{
  const orders: string[][] = [];
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor({ onStopOrder: (ids) => orders.push(ids) }));
  await flush();
  h.calls[0]!.resolve(liveRoute(DIRECT_ROUTE, ['WALL', 'jaffa']));
  await flush();
  eq("a live route hands its order to the session, in the session's own ids", orders, [['wall', 'jaffa']]);
  h.manager.stop();

  const later = routeHarness({ online: false, cache: h.cache });
  const cachedOrders: string[][] = [];
  await later.manager.start(sessionFor({ onStopOrder: (ids) => cachedOrders.push(ids) }));
  await flush();
  eq('a cached route carries no order: authored order stays (TASK-903)', [later.source(), cachedOrders.length], ['dynamic', 0]);
  later.manager.stop();
}
{
  const orders: string[][] = [];
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor({ onStopOrder: (ids) => orders.push(ids) }));
  await flush();
  h.calls[0]!.resolve(liveRoute({ ...DIRECT_ROUTE, precision: 6 }, ['wall', 'jaffa']));
  await flush();
  eq('a route that fails validation never sequences the geofences', orders.length, 0);
  h.manager.stop();
}
{
  const orders: string[][] = [];
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor({ onStopOrder: (ids) => orders.push(ids) }));
  await flush();
  h.calls[0]!.resolve(liveRoute(DIRECT_ROUTE, ['wall', 'david']));
  await flush();
  eq('an order naming other stops is dropped, the route is still drawn', [orders.length, h.source()], [0, 'dynamic']);
  h.manager.stop();
}

// -----------------------------------------------------------------------------
// TASK-901: context.local_time
// -----------------------------------------------------------------------------

heading('TASK-901: local time with its UTC offset');

const INSTANT = Date.UTC(2026, 8, 17, 15, 40, 5, 250); // 2026-09-17 15:40:05.250Z
eq('Tel Aviv summer time', formatLocalTime(INSTANT, 180), '2026-09-17T18:40:05+03:00');
eq('New York, negative offset', formatLocalTime(INSTANT, -240), '2026-09-17T11:40:05-04:00');
eq('Kathmandu, 45-minute offset', formatLocalTime(INSTANT, 345), '2026-09-17T21:25:05+05:45');
eq('Marquesas, negative half hour', formatLocalTime(INSTANT, -570), '2026-09-17T06:10:05-09:30');
eq('UTC is written +00:00', formatLocalTime(INSTANT, 0), '2026-09-17T15:40:05+00:00');
eq('the local date rolls over with the offset', formatLocalTime(Date.UTC(2026, 11, 31, 22, 30), 180), '2027-01-01T01:30:00+03:00');
eq('and back', formatLocalTime(Date.UTC(2026, 0, 1, 2, 0), -300), '2025-12-31T21:00:00-05:00');

for (const offset of [180, -240, 345, -570, 0, 840, -720]) {
  const parsedTime = parseLocalTime(formatLocalTime(INSTANT, offset));
  eq(
    `the server's parser reads the same instant and offset back (${offset} min)`,
    [parsedTime?.instantMs, parsedTime?.offsetMinutes],
    [INSTANT - 250, offset],
  );
}

const deviceNow = new Date();
const device = deviceLocalTime(deviceNow);
const deviceParsed = parseLocalTime(device);
assert('the device clock produces a string the server accepts', deviceParsed !== null, device);
eq(
  "with this machine's own offset and instant",
  [deviceParsed?.offsetMinutes, deviceParsed?.instantMs],
  [-deviceNow.getTimezoneOffset(), Math.floor(deviceNow.getTime() / 1000) * 1000],
);

eq(
  'the request body carries context.local_time',
  routeRequestBody({ tourId: 't', waypointIds: ['a', 'b'], transitMode: 'walking' }, '2026-09-17T18:40:05+03:00'),
  { tour_id: 't', waypoint_ids: ['a', 'b'], transit_mode: 'walking', context: { local_time: '2026-09-17T18:40:05+03:00' } },
);

heading('TASK-902: reading the routed order');

eq('waypoint_ids read from the response', parseRouteOrder({ polyline: 'x', waypoint_ids: ['b', 'a'] }), ['b', 'a']);
eq('a pre-Epic-8 response has none', parseRouteOrder({ polyline: 'x' }), null);
eq('a malformed one is ignored', parseRouteOrder({ waypoint_ids: ['a', 7] }), null);
eq('a reordering is adopted', adoptableStopOrder(['wall', 'jaffa'], [JAFFA, WALL]), ['wall', 'jaffa']);
eq('uuid case differences are tolerated', adoptableStopOrder(['WALL', 'Jaffa'], [JAFFA, WALL]), ['wall', 'jaffa']);
eq('a missing stop is refused', adoptableStopOrder(['wall'], [JAFFA, WALL]), null);
eq('a duplicate is refused', adoptableStopOrder(['wall', 'wall'], [JAFFA, WALL]), null);
eq('a stranger is refused', adoptableStopOrder(['wall', 'david'], [JAFFA, WALL]), null);

// -----------------------------------------------------------------------------
// TASK-902: sequenced geofences
// -----------------------------------------------------------------------------

heading('StopSequence');

{
  const seq = new StopSequence(['a', 'b', 'c', 'd']);
  eq('arms the first stop', seq.next(), 'a');
  seq.reach('a');
  eq('reaching it arms the next', seq.next(), 'b');
  eq(
    'a reorder must hold exactly the same stops',
    [seq.reorder(['a', 'b', 'c']), seq.reorder(['a', 'b', 'c', 'x']), seq.reorder(['a', 'a', 'c', 'd'])],
    [false, false, false],
  );
  assert('a valid reorder is accepted', seq.reorder(['a', 'd', 'c', 'b']));
  eq('progress survives it: the first unpassed stop of the new order is armed', seq.next(), 'd');
  seq.reach('c');
  eq('reaching a later stop skips the ones before it', [seq.isPassed('d'), seq.next()], [true, 'b']);
  seq.reach('a');
  eq('reaching a passed stop changes nothing', seq.next(), 'b');
  seq.reach('b');
  eq('done: nothing armed', seq.next(), null);
}

heading('LocationService: only the next routed stop narrates');

// Stops on a line running north, 200 m apart, 20 m zones: clear of each other
// even with walking's x1.6 exit hysteresis.
const SEQ_ORIGIN = { latitude: 32.08, longitude: 34.78 };
const northOf = (metres: number): LatLng => ({
  latitude: SEQ_ORIGIN.latitude + metres / 111_320,
  longitude: SEQ_ORIGIN.longitude,
});
const zonedStop = (id: string, sortOrder: number, metres: number, zoned = true): Waypoint => ({
  ...waypoint(id, sortOrder),
  coordinate: northOf(metres),
  geofence: zoned
    ? { id: `${id}:zone`, waypointId: id, zoneType: 'radius', center: northOf(metres), radiusMeters: 20 }
    : null,
});

function engine(stops: Waypoint[]) {
  const service = new LocationService('walking');
  service.loadTour(stops, 'walking');
  const events: string[] = [];
  service.setCallbacks({ onGeofence: (e: GeofenceEvent) => events.push(`${e.type}:${e.waypoint.id}`) });
  let clock = 1_000_000_000;
  // A minute per fix: every Adaptive GPS change commits at once, leaving no timer.
  const at = (metres: number): string[] => {
    const before = events.length;
    clock += 60_000;
    service.onFix(northOf(metres), 5, clock);
    return events.slice(before);
  };
  return { service, at };
}

{
  const { service, at } = engine([zonedStop('A', 1, 0), zonedStop('B', 2, 200), zonedStop('C', 3, 400), zonedStop('D', 4, 600)]);
  eq('before any route arrives, authored order: A is armed', service.nextWaypointId(), 'A');
  eq('the routed order puts C second', service.setStopOrder(['A', 'C', 'B', 'D']), true);
  eq('enter A', at(0), ['enter:A']);
  eq('walking through B, scheduled for later, is silent', at(200), ['exit:A']);
  eq('and leaves no state: B is not "inside"', service.isInside('B'), false);
  eq('C, the next routed stop, narrates', at(400), ['enter:C']);
  eq('walking back to B: exit C, then B narrates, in that order', at(200), ['exit:C', 'enter:B']);
  eq('D narrates last', at(600), ['exit:B', 'enter:D']);
  eq('returning to a narrated stop does not replay it', [...at(400), ...at(0)], ['exit:D']);
  eq('the tour is done', service.nextWaypointId(), null);
  eq('with nothing armed, no zone holds the GPS on fine sampling', service.distanceToNearestZone(northOf(0)), null);
  await service.stop();
}

{
  const { service, at } = engine([zonedStop('A', 1, 0), zonedStop('B', 2, 200), zonedStop('C', 3, 400)]);
  service.setStopOrder(['A', 'C', 'B']);
  at(0);
  eq('standing in B early is ignored', at(200), ['exit:A']);
  eq('a mid-walk reorder arms B while the user already stands in it', service.setStopOrder(['A', 'B', 'C']), true);
  eq('B narrates on the next fix, without walking out and back in', at(200), ['enter:B']);
  eq(
    'Adaptive GPS measures to the armed stop (C), not the nearer unarmed one',
    Math.round(service.distanceToNearestZone(northOf(300)) ?? -1),
    80,
  );
  eq(
    'a reorder naming other stops is refused and changes nothing',
    [service.setStopOrder(['A', 'B', 'X']), service.nextWaypointId()],
    [false, 'C'],
  );
  await service.stop();
}

{
  const stops = [zonedStop('A', 1, 0), zonedStop('B', 2, 200), zonedStop('C', 3, 400)];
  const { service, at } = engine(stops);
  at(0);
  eq("B's zone is missed entirely: C is not armed", at(400), ['exit:A']);
  service.markReached('B');
  eq('reaching B by hand arms C', service.nextWaypointId(), 'C');
  eq('and C narrates on the next fix', at(400), ['enter:C']);
  await service.stop();

  const skip = engine(stops);
  skip.at(0);
  skip.service.markReached('C');
  eq('reaching a later stop by hand skips the one in between', [skip.service.nextWaypointId(), skip.at(200)], [null, ['exit:A']]);
  await skip.service.stop();
}

{
  const { service, at } = engine([zonedStop('A', 1, 0), zonedStop('X', 2, 100, false), zonedStop('B', 3, 200)]);
  at(0);
  eq('a stop with no geofence cannot block the stops after it', at(200), ['exit:A', 'enter:B']);
  await service.stop();
}

heading('Session store follows the routed order');

{
  useTourSession.getState().sessionStarted({
    waypoints: [waypoint('A', 1), waypoint('B', 2), waypoint('C', 3)],
    transitMode: 'walking',
    backgroundPermission: true,
  });
  useTourSession.getState().setStopOrder(['C', 'A', 'B']);
  eq('stops are listed in narration order', useTourSession.getState().waypoints.map((w) => w.id), ['C', 'A', 'B']);
  useTourSession.getState().setStopOrder(['C', 'A']);
  useTourSession.getState().setStopOrder(['C', 'C', 'A']);
  eq('an order that is not the same stops is ignored', useTourSession.getState().waypoints.map((w) => w.id), ['C', 'A', 'B']);
  useTourSession.getState().reset();
}

// -----------------------------------------------------------------------------
// TASK-605: offline catalogue
// -----------------------------------------------------------------------------

heading('tourFromManifest (offline Discovery)');

eq(
  'a downloaded manifest becomes a catalogue entry',
  tourFromManifest({
    bundle_version_hash: 'h',
    tour_metadata: { tour_id: 't1', title: 'Jerusalem', topology: 'in_city', transit_mode: 'walking', duration_minutes: 90 },
    waypoints: [],
  }),
  { id: 't1', title: 'Jerusalem', topology: 'in_city', transitMode: 'walking', durationMinutes: 90 },
);
eq(
  'an empty title still gets a readable label',
  tourFromManifest({
    bundle_version_hash: 'h',
    tour_metadata: { tour_id: 't2', title: '', topology: 'in_city', transit_mode: 'walking', duration_minutes: 15 },
    waypoints: [],
  }).title,
  'Untitled tour',
);

// -----------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
