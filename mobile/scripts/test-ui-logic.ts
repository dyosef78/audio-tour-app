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
import type { WireBundle } from '../src/services/bundle/types.ts';
import { transcriptPathFor } from '../src/transcript/sidecar.ts';
import { usePreferences, usePreferencesBoot } from '../src/personalization/preferencesStore.ts';
import { AudioService, type PlaybackError } from '../src/services/audio/AudioService.ts';
import { useTourSession } from '../src/session/tourSessionStore.ts';
import { cueIndexAt, isRtlText, parseVtt, VttParseError } from '../src/transcript/vtt.ts';
import type { AudioTrack, Waypoint } from '../src/types/domain.ts';
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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
