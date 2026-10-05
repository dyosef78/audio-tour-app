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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';

import {
  INTERESTS,
  parseGroupTypes,
  parseInterests,
  routeCriteria,
  TIME_BUDGETS,
  tourFitsBudget,
  type GroupType,
  type Interest,
} from '../src/personalization/options.ts';
import { refreshCities, refreshCitiesWithin, useCityCatalogue } from '../src/personalization/cityCatalogue.ts';
import {
  catalogueCityId,
  cityCatalogueFilter,
  onboardingSteps,
  parseCities,
  resolveCity,
  stepPosition,
  type CitySummary,
} from '../src/personalization/onboardingFlow.ts';
import { contrastRatio, INTEREST_TINTS } from '../src/ui/interestTints.ts';
import { colors } from '../src/ui/theme.ts';
import { planBundleFiles } from '../src/services/bundle/plan.ts';
import { tourFromManifest } from '../src/services/bundle/catalogue.ts';
import { isWireBundle, type WireBundle } from '../src/services/bundle/types.ts';
import { transcriptPathFor } from '../src/transcript/sidecar.ts';
import { migratePreferences, usePreferences, usePreferencesBoot } from '../src/personalization/preferencesStore.ts';
import { AudioService, type PlaybackError } from '../src/services/audio/AudioService.ts';
import { useTourSession } from '../src/session/tourSessionStore.ts';
import { cueIndexAt, isRtlText, parseVtt, VttParseError } from '../src/transcript/vtt.ts';
import { MAX_REMOTE_TRANSCRIPT_BYTES, RemoteTranscriptStore } from '../src/transcript/remoteTranscripts.ts';
import type { AudioTrack, EncodedRoute, Waypoint } from '../src/types/domain.ts';
import { encodePolyline } from '../../shared/src/polyline.ts';
import { decodeRoute, parseEncodedRoute } from '../src/routing/routeGeometry.ts';
import { sessionStops } from '../src/routing/stopSelection.ts';
import { LocationService, TrackingLostError } from '../src/services/location/LocationService.ts';
import { connectivityOf } from '../src/services/network/connectivity.ts';
import AsyncStorage, { __dump, __setFailReads } from './stubs/async-storage.ts';
import { players } from './stubs/expo-audio.ts';
import { __afterNextBackgroundStop, __isAppForegrounded, __setAppForegrounded, calls as locationCalls, resetCalls as resetLocationCalls } from './stubs/expo-location.ts';
import { samplingFor } from '../src/config/transitProfiles.ts';

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
eq('complete preferences', quick, { groupType: 'couple', interests: ['history'], maxMinutes: 120 });
eq('a 90 min tour fits 2 hours', tourFitsBudget(90, quick), true);
eq('a 120 min tour fits exactly', tourFitsBudget(120, quick), true);
eq('a 150 min tour does not', tourFitsBudget(150, quick), false);
// TASK-1101: PM-confirmed budgets. The ids are a storage contract and must not move.
eq(
  'time budgets are 120 / 240 / 480 under unchanged ids',
  TIME_BUDGETS.map((b) => [b.id, b.maxMinutes]),
  [['quick', 120], ['half_day', 240], ['full_day', 480]],
);
eq(
  'interests stay the five database tags - culinary is ONE id',
  INTERESTS.map((i) => i.id).sort(),
  ['architecture', 'art_culture', 'culinary', 'history', 'nature'],
);
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
eq('persisted with a schema version', saved?.version, 2);
eq(
  'persists exactly the six preference fields - no actions',
  Object.keys(saved?.state ?? {}).sort(),
  ['cityId', 'groupType', 'interests', 'onboardingComplete', 'timeBudget', 'welcomeSeen'],
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

// TASK-1102: v1 -> v2. A literal v1 blob, as a device updated from the store holds it.
eq(
  'v1 migration: an onboarded user is treated as having chosen guest',
  migratePreferences({ groupType: 'couple', interests: ['history'], timeBudget: 'quick', onboardingComplete: true }, 1),
  { groupType: 'couple', interests: ['history'], timeBudget: 'quick', onboardingComplete: true, welcomeSeen: true, cityId: null },
);
eq(
  'v1 migration: a user mid-onboarding still sees Welcome',
  migratePreferences({ groupType: 'solo', interests: [], timeBudget: null, onboardingComplete: false }, 1).welcomeSeen,
  false,
);
eq('migration survives a non-object blob', migratePreferences(null, 1).onboardingComplete, false);

usePreferencesBoot.setState({ ready: false, restoreFailed: false });
await AsyncStorage.setItem(
  'user-preferences',
  JSON.stringify({ version: 1, state: { groupType: 'friends', interests: ['nature'], timeBudget: 'full_day', onboardingComplete: true } }),
);
await usePreferences.persist.rehydrate();
eq('a stored v1 blob rehydrates through the migration', usePreferences.getState().welcomeSeen, true);
eq('...keeping its choices', usePreferences.getState().groupType, 'friends');
eq('...and the boot gate opens cleanly', usePreferencesBoot.getState(), { ready: true, restoreFailed: false });

// -----------------------------------------------------------------------------
// TASK-1101: onboarding flow, cities, interest colours
// -----------------------------------------------------------------------------

heading('Onboarding flow and city resolution');

const TLV: CitySummary = { id: '11111111-0000-4000-8000-000000000001', slug: 'tel-aviv', name: 'Tel Aviv' };
const JLM: CitySummary = { id: '11111111-0000-4000-8000-000000000002', slug: 'jerusalem', name: 'Jerusalem' };

eq('one city, nothing saved -> selected silently', resolveCity([TLV], null), { kind: 'auto', cityId: TLV.id });
eq('one city, already saved -> kept', resolveCity([TLV], TLV.id), { kind: 'keep' });
eq('one city, a stale saved id -> replaced silently', resolveCity([TLV], JLM.id), { kind: 'auto', cityId: TLV.id });
eq('two cities, nothing saved -> the visitor chooses', resolveCity([TLV, JLM], null), { kind: 'choose' });
eq('two cities, a valid saved one -> kept', resolveCity([TLV, JLM], JLM.id), { kind: 'keep' });
eq('never fetched (offline first run) -> unknown', resolveCity(null, null), { kind: 'unknown' });
eq('an empty list is not a reason to ask', resolveCity([], TLV.id), { kind: 'unknown' });

eq('catalogue: keep filters by the saved city', catalogueCityId({ kind: 'keep' }, JLM.id), JLM.id);
eq('catalogue: auto filters by the chosen city', catalogueCityId({ kind: 'auto', cityId: TLV.id }, null), TLV.id);
eq('catalogue: choose lists every city until answered', catalogueCityId({ kind: 'choose' }, JLM.id), null);
eq('catalogue: unknown keeps the saved city (offline)', catalogueCityId({ kind: 'unknown' }, TLV.id), TLV.id);

eq('one city: three numbered steps, no City', onboardingSteps(false), ['OnboardingGroup', 'OnboardingInterests', 'OnboardingTime']);
eq('several cities: City leads', onboardingSteps(true)[0], 'OnboardingCity');
eq('Group is step 1 of 3 without City', stepPosition('OnboardingGroup', false), { step: 1, total: 3 });
eq('Group is step 2 of 4 with City', stepPosition('OnboardingGroup', true), { step: 2, total: 4 });
eq('Time is always last', stepPosition('OnboardingTime', true), { step: 4, total: 4 });

eq(
  'city rows: malformed ones are dropped',
  parseCities([TLV, { id: 'not-a-uuid', slug: 'x', name: 'X' }, { id: JLM.id, slug: 'jerusalem', name: '  ' }, null, 'x']),
  [TLV],
);
eq('city rows: a non-array is no cities', parseCities({ error: true }), []);

eq('catalogue filter includes city-less tours', cityCatalogueFilter(TLV.id), `city_id.eq.${TLV.id},city_id.is.null`);
eq('no city -> no filter', cityCatalogueFilter(null), null);
eq(
  'a non-uuid from storage is refused, never interpolated into the filter',
  cityCatalogueFilter('x,status.eq.draft'),
  null,
);

heading('City catalogue refresh');
{
  const warnCities = mock.method(console, 'warn', () => {});
  useCityCatalogue.setState({ cities: null });
  let calls = 0;
  const slow = () =>
    new Promise<CitySummary[]>((resolve) => {
      calls++;
      setTimeout(() => resolve([TLV]), 30);
    });
  const [a, b] = await Promise.all([refreshCities(slow), refreshCities(slow)]);
  eq('two screens asking at once cause ONE fetch', calls, 1);
  eq('...and both hear it succeeded', [a, b], [true, true]);
  eq('...and the list is stored', useCityCatalogue.getState().cities, [TLV]);

  eq('a failed refresh reports false', await refreshCities(async () => Promise.reject(new Error('offline'))), false);
  eq('...and keeps the last good list', useCityCatalogue.getState().cities, [TLV]);

  const hanging = () => new Promise<CitySummary[]>(() => {});
  const started = Date.now();
  eq('a hung network gives up at the deadline', await refreshCitiesWithin(40, hanging), false);
  assert('...promptly', Date.now() - started < 1000);
  warnCities.mock.restore();
}

heading('Interest bubble colours (WCAG AA)');
for (const [id, tint] of Object.entries(INTEREST_TINTS)) {
  const onSoft = contrastRatio(tint.strong, tint.soft);
  const onWhite = contrastRatio(tint.strong, colors.canvas);
  const secondaryOnSoft = contrastRatio(colors.inkSecondary, tint.soft);
  assert(`${id}: strong on soft >= 4.5`, onSoft >= 4.5, onSoft.toFixed(2));
  assert(`${id}: strong on white, and white tick on strong >= 4.5`, onWhite >= 4.5, onWhite.toFixed(2));
  assert(`${id}: description on the selected fill >= 4.5`, secondaryOnSoft >= 4.5, secondaryOnSoft.toFixed(2));
}
{
  const r = contrastRatio(colors.inkSecondary, colors.accentSoft);
  assert('ChoiceCard: description on its selected fill >= 4.5', r >= 4.5, r.toFixed(2));
  const muted = contrastRatio(colors.inkMuted, colors.accentSoft);
  assert('...which inkMuted did not (why inkSecondary exists)', muted < 4.5, muted.toFixed(2));
}
{
  // TASK-1104: "Delete account" is text on white rows that press to `surface`,
  // and the delete button is white text on it.
  for (const [label, bg] of [['white', colors.canvas], ['pressed row', colors.surface]] as const) {
    const r = contrastRatio(colors.dangerInk, bg);
    assert(`dangerInk on ${label} >= 4.5`, r >= 4.5, r.toFixed(2));
  }
}
eq('contrast sanity: black on white is 21', Math.round(contrastRatio('#000000', '#FFFFFF')), 21);

// -----------------------------------------------------------------------------
// Deep Dive session semantics
// -----------------------------------------------------------------------------

heading('Session store: the engine projection (Epic 15)');

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
    stopRole: 'core',
  };
}

{
  const session = useTourSession.getState();
  session.sessionStarted({ waypoints: [waypoint('A', 1), waypoint('B', 2)], transitMode: 'walking', backgroundPermission: true });

  session.setOnAir('A', false);
  eq('a narration on air: its card is shown', [useTourSession.getState().activeWaypointId, useTourSession.getState().deepDiveWaypointId], ['A', null]);
  useTourSession.getState().setPlaybackError('boom');
  session.setOnAir('A', true);
  eq('its Deep Dive on air: same card, Deep Dive marked', [useTourSession.getState().activeWaypointId, useTourSession.getState().deepDiveWaypointId], ['A', 'A']);
  eq('...the same stop keeps its error', useTourSession.getState().playbackError, 'boom');
  session.setOnAir('B', false);
  eq('a different stop displaces the Deep Dive and clears the old error', [useTourSession.getState().activeWaypointId, useTourSession.getState().deepDiveWaypointId, useTourSession.getState().playbackError], ['B', null, null]);
  useTourSession.getState().setPlayback({ isPlaying: true, positionSeconds: 12, durationSeconds: 60 });
  session.setOnAir(null, false);
  eq('taken off air: no card, transport reset', [useTourSession.getState().activeWaypointId, useTourSession.getState().isPlaying, useTourSession.getState().positionSeconds], [null, false, 0]);

  session.applyEngineView({ visitedWaypointIds: ['A'] });
  const visited = useTourSession.getState().visitedWaypointIds;
  session.applyEngineView({ visitedWaypointIds: ['A'] });
  assert('an unchanged visit list keeps its array (no map re-render per heartbeat)', useTourSession.getState().visitedWaypointIds === visited);
  session.applyEngineView({ visitedWaypointIds: ['A', 'B'] });
  eq('a new visit is published', useTourSession.getState().visitedWaypointIds, ['A', 'B']);

  session.promptCompletion();
  eq('the completion prompt is raised', useTourSession.getState().completionPrompted, true);
  session.dismissCompletionPrompt();
  eq('...and can be dismissed', useTourSession.getState().completionPrompted, false);

  session.reset();
  eq('reset clears the card', useTourSession.getState().activeWaypointId, null);
}

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

heading('sessionStops (Epic 16: catalogue = every core stop)');

const stopAt = (
  id: string,
  sort: number,
  lat: number,
  lng: number,
  tags: Partial<Pick<Waypoint, 'audiences' | 'interests' | 'stopRole' | 'poiType'>> = {},
): Waypoint => ({
  id,
  tourId: 'jlm',
  name: `Stop ${id}`,
  poiType: 'anchor',
  coordinate: { latitude: lat, longitude: lng },
  sortOrder: sort,
  geofence: null,
  audio: null,
  stopRole: 'core',
  ...tags,
});

// The Jerusalem seed's four stops.
const JAFFA = stopAt('jaffa', 1, 31.7766, 35.2279, { interests: ['history', 'architecture'] });
const DAVID = stopAt('david', 2, 31.7761, 35.2281, { interests: ['architecture'] });
const CARDO = stopAt('cardo', 3, 31.7757, 35.2312, { interests: ['culinary'] });
const WALL = stopAt('wall', 4, 31.7767, 35.2344); // untagged: never filtered out
const ALL_STOPS = [JAFFA, DAVID, CARDO, WALL];
const HISTORY_COUPLE = { groupType: 'couple' as const, interests: ['history' as const], maxMinutes: 60 };

const catalogue = { kind: 'catalogue' } as const;
const ext = (s: Waypoint): Waypoint => ({ ...s, stopRole: 'extension' });
const T_A = stopAt('a', 1, 0, 0, { interests: ['history'] });
const T_T = stopAt('t', 2, 0, 0, { poiType: 'transition' });
const T_B = stopAt('b', 3, 0, 0, { interests: ['culinary'] });
const T_E = ext(stopAt('e', 4, 0, 0, { interests: ['nature'] }));
const T_C = stopAt('c', 5, 0, 0);

const cat = sessionStops([T_C, T_E, T_B, T_T, T_A], catalogue);
eq('every core stop, transitions included, in authored order (input order ignored)', cat.active.map((s) => s.id), ['a', 't', 'b', 'c']);
eq('the extension is excluded, and reported as excluded', cat.excludedIds, ['e']);
eq('an all-core tour runs whole', sessionStops(ALL_STOPS, catalogue).active.map((s) => s.id), ['jaffa', 'david', 'cardo', 'wall']);
eq(
  'preferences no longer remove stops: tags are ignored by the session (TASK-604 retired)',
  sessionStops([stopAt('bar', 1, 0, 0, { audiences: ['couple'] }), stopAt('zoo', 2, 0, 0, { audiences: ['family_kids'], interests: ['nature'] })], catalogue).active.length,
  2,
);
let threw = '';
try { sessionStops([T_A, ext(T_T), T_B], catalogue); } catch (e) { threw = e instanceof RangeError ? e.message : `not a RangeError: ${String(e)}`; }
assert('a transition marked as an extension is refused (server invariant broken)', /transition t is marked as an extension/.test(threw), threw);
threw = '';
try { sessionStops([ext(T_A), ext(T_B)], catalogue); } catch (e) { threw = e instanceof RangeError ? e.message : String(e); }
assert('a tour with no core stop is refused, never run empty', /no core stops/.test(threw), threw);

heading('isWireBundle: stop_role (Epic 16)');

const wireWith = (role: unknown): unknown => ({
  bundle_version_hash: 'h',
  tour_metadata: { tour_id: 't' },
  waypoints: [{ waypoint_id: 'w', coordinates: [34.78, 32.08], ...(role === undefined ? {} : { stop_role: role }) }],
});
assert('no stop_role (a pre-Epic-16 manifest) is accepted', isWireBundle(wireWith(undefined)));
assert("'core' and 'extension' are accepted", isWireBundle(wireWith('core')) && isWireBundle(wireWith('extension')));
assert("an unknown role (a newer server's) is refused, never read as core", !isWireBundle(wireWith('bonus')) && !isWireBundle(wireWith(1)));

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

heading('LocationService: transport for the engine (Epic 13 rules kept)');

{
  const ORIGIN_15 = { latitude: 32.08, longitude: 34.78 };
  const fixAt = (metres: number, t: number) => ({
    coordinate: { latitude: ORIGIN_15.latitude + metres / 111_320, longitude: ORIGIN_15.longitude },
    timestamp: t,
    accuracyM: 5,
    speedMps: 1.2,
    headingDeg: 0,
  });
  const walking = samplingFor('walking');
  const driving = samplingFor('driving');
  resetLocationCalls();

  const ios = new LocationService('walking', 'ios');
  eq('iOS: no persistent task', ios.persistentTask, false);
  await ios.start();
  const watch = locationCalls.find((c) => c.kind === 'watch');
  assert(
    'iOS start(): a foreground watcher, pinned sampling, distanceInterval 0 (the background clock)',
    watch?.options?.distanceInterval === 0 && watch.options.accuracy === walking.accuracy && watch.options.timeInterval === walking.timeInterval,
    JSON.stringify(locationCalls),
  );
  resetLocationCalls();
  await ios.retune('driving');
  const rewatch = locationCalls.find((c) => c.kind === 'watch');
  assert('iOS retune(): the watcher reopened with the new mode', rewatch?.options?.accuracy === driving.accuracy, JSON.stringify(locationCalls));
  await ios.stop();
  resetLocationCalls();

  const droid = new LocationService('walking', 'android', { isForeground: __isAppForegrounded });
  const tiers: string[] = [];
  const got: number[] = [];
  droid.setCallbacks({ onSamplingChange: (tier) => tiers.push(tier), onGpsFix: (f) => got.push(f.timestamp) });
  await droid.start();
  const starts = locationCalls.filter((c) => c.kind === 'background-start');
  assert(
    'Android start(): the background task, never a watcher, distanceInterval 0',
    starts.length === 1 &&
      !locationCalls.some((c) => c.kind === 'watch') &&
      starts[0]?.options?.distanceInterval === 0 &&
      starts[0]?.options?.accuracy === walking.accuracy,
    JSON.stringify(locationCalls),
  );
  eq('the pinned tier is reported once, for the debug overlay', tiers, ['fine']);

  // Pocketed: from here any start with a foreground service throws, as on a device.
  __setAppForegrounded(false);
  const before = locationCalls.length;
  for (const [i, metres] of [-3_000, 0, 300, -3_000, 580, 600].entries()) {
    droid.onGpsFix(fixAt(metres, 2_000_000_000 + i * 60_000));
  }
  eq('pocketed: fixes far and near touch the task zero times', locationCalls.slice(before), []);
  eq('...and every fix reaches the engine with its own timestamp', got, [0, 1, 2, 3, 4, 5].map((i) => 2_000_000_000 + i * 60_000));

  let refused = false;
  try {
    await droid.startBackground();
  } catch {
    refused = true;
  }
  assert('startBackground() on Android is a loud contract violation', refused);

  let retuneRefused = false;
  const beforeRetune = locationCalls.length;
  try {
    await droid.retune('driving');
  } catch {
    retuneRefused = true;
  }
  assert('retune() while pocketed throws - a chapter change must come from an in-app tap', retuneRefused);
  eq('...and leaves the running task UNTOUCHED (stopping it first would leave no tracking at all)', locationCalls.slice(beforeRetune), []);

  // Not resetLocationCalls(): the stub's reset also forgets the running task.
  __setAppForegrounded(true);
  const markRetune = locationCalls.length;
  await droid.retune('driving');
  const retuneCalls = locationCalls.slice(markRetune);
  const retuned = retuneCalls.filter((c) => c.kind === 'background-start').at(-1);
  assert(
    'retune() in the foreground: stop, then start with the new mode (the failed retune did not wedge the chain)',
    retuneCalls.map((c) => c.kind).join() === 'background-stop,background-start' && retuned?.options?.timeInterval === driving.timeInterval && retuned.options.accuracy === driving.accuracy,
    JSON.stringify(retuneCalls),
  );
  await droid.stop();
  await droid.stopBackground();
  eq('ending the session stops the task', locationCalls.at(-1)?.kind, 'background-stop');

  // Not vacuous: with the guard bypassed, the STUB itself refuses a start
  // from the background - so the guard tests above test something real.
  let stubRefuses = false;
  __setAppForegrounded(false);
  try {
    await new LocationService('walking', 'android', { isForeground: () => true }).start();
  } catch {
    stubRefuses = true;
  }
  __setAppForegrounded(true);
  assert('a start while pocketed throws (the Android rule is enforced by the stub)', stubRefuses);

  // Epic 16 - the optimistic handoff can open Maps while a retune is still
  // queued or half-done. Two windows, two outcomes.
  {
    resetLocationCalls();
    const q = new LocationService('walking', 'android', { isForeground: __isAppForegrounded });
    await q.start();
    // (a) Pocketed AFTER the call but BEFORE the queued work ran: refused at
    //     the stop, task untouched - the old sampling keeps tracking.
    const mark = locationCalls.length;
    const pending = q.retune('driving');
    __setAppForegrounded(false);
    let queuedRefused = false;
    try {
      await pending;
    } catch (e) {
      queuedRefused = !(e instanceof TrackingLostError);
    }
    assert('retune queued, then pocketed: refused before the stop (not "lost")', queuedRefused && !q.trackingLost);
    eq('...and the running task was never touched', locationCalls.slice(mark), []);
    __setAppForegrounded(true);

    // (b) Pocketed BETWEEN the stop and the start: tracking is OFF - said
    //     precisely (TrackingLostError), remembered, and recoverable.
    const markLost = locationCalls.length;
    __afterNextBackgroundStop(() => __setAppForegrounded(false));
    let lostErr: unknown = null;
    try {
      await q.retune('driving');
    } catch (e) {
      lostErr = e;
    }
    assert('pocketed between stop and start: TrackingLostError, trackingLost = true', lostErr instanceof TrackingLostError && q.trackingLost, String(lostErr));
    eq('...the stop happened, the start was refused', locationCalls.slice(markLost).map((c) => c.kind), ['background-stop']);

    let stillRefused = false;
    try {
      await q.recover();
    } catch {
      stillRefused = true;
    }
    assert('recover() while still pocketed throws and stays lost (retried on the next return)', stillRefused && q.trackingLost);

    __setAppForegrounded(true);
    const markRecover = locationCalls.length;
    await q.recover();
    const restarted = locationCalls.slice(markRecover).filter((c) => c.kind === 'background-start');
    assert('back in the foreground: recover() restarts with the sampling the failed retune asked for', !q.trackingLost && restarted.length === 1 && restarted[0]?.options?.timeInterval === samplingFor('driving').timeInterval, JSON.stringify(locationCalls.slice(markRecover)));
    const markNoop = locationCalls.length;
    await q.recover();
    eq('recover() with nothing lost is a no-op', locationCalls.slice(markNoop), []);

    // A deliberate stop (idle pause, session end) clears "lost": nothing to recover.
    __afterNextBackgroundStop(() => __setAppForegrounded(false));
    await q.retune('walking').catch(() => undefined);
    __setAppForegrounded(true);
    await q.stopBackground();
    assert('stopBackground() clears lost - the pause turned tracking off on purpose', !q.trackingLost);
  }

  // A task left by a previous process keeps ITS options; start() must replace it.
  resetLocationCalls();
  await new LocationService('walking', 'ios').startBackground(); // stands in for a killed process's task
  const again = new LocationService('walking', 'android', { isForeground: __isAppForegrounded });
  await again.start();
  eq('a task already running is replaced, not adopted', locationCalls.map((c) => c.kind), ['background-start', 'background-stop', 'background-start']);

  // Resume (Epic 13): the OS restarted the task after a kill - ADOPT it.
  __setAppForegrounded(false); // the restarted process is headless: no UI
  const beforeAdopt = locationCalls.length;
  const adopted: string[] = [];
  const after = new LocationService('walking', 'android', { isForeground: __isAppForegrounded });
  after.setCallbacks({ onSamplingChange: (t) => adopted.push(t) });
  await after.resumeTracking();
  eq('Android resume with the task running: adopted - no stop, no start', locationCalls.slice(beforeAdopt), []);
  eq('...and the pinned tier is reported', adopted, ['fine']);
  __setAppForegrounded(true);
  await again.stopBackground();

  // Android, no task: a normal start, which only works in the foreground.
  resetLocationCalls();
  const cold = new LocationService('walking', 'android', { isForeground: __isAppForegrounded });
  let threw = false;
  __setAppForegrounded(false);
  try {
    await cold.resumeTracking();
  } catch {
    threw = true;
  }
  assert('Android resume with no task, in the background: throws (the caller tears down)', threw);
  __setAppForegrounded(true);
  await cold.resumeTracking();
  eq('...in the foreground: starts the task', locationCalls.map((c) => c.kind), ['background-start']);
  await cold.stopBackground();

  resetLocationCalls();
  const iosResume = new LocationService('walking', 'ios');
  await iosResume.resumeTracking();
  eq('iOS resume: the foreground watcher, as start() opens it', locationCalls.map((c) => c.kind), ['watch']);
  await iosResume.stop();
  resetLocationCalls();
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

// -----------------------------------------------------------------------------
// Streamed transcripts (TASK-1003)
// -----------------------------------------------------------------------------

heading('Transcript beside a streamed track');

{
  const AUDIO = 'tours/t1/wp01_start.m4a';
  const VTT = 'WEBVTT\n\n00:00.000 --> 00:02.000\nShalom\n\n00:02.000 --> 00:04.000\nTel Aviv';
  const signed: string[][] = [];
  const fetched: string[] = [];
  let body: string | (() => Promise<Response>) = VTT;

  const store = new RemoteTranscriptStore({
    sign: async (paths) => {
      signed.push([...paths]);
      return new Map(paths.filter((p) => !p.includes('no_transcript')).map((p) => [p, `https://signed/${p}`]));
    },
    fetch: async (url) => {
      fetched.push(url);
      return typeof body === 'string' ? new Response(body, { status: 200 }) : body();
    },
  });

  let notified = 0;
  const unsubscribe = store.subscribe(() => notified++);
  const before = store.getRevision();

  const pending = store.prefetch(AUDIO);
  eq('loading while the fetch is in flight', store.get(AUDIO), { status: 'loading' });
  const ready = await pending;
  eq('signs the sidecar path, not the audio', signed[0], ['tours/t1/wp01_start.vtt']);
  eq('parsed with the bundle parser', ready.status === 'ready' ? ready.cues.map((c) => c.text) : ready.status, ['Shalom', 'Tel Aviv']);
  assert('subscribers told on loading and on ready', notified === 2 && store.getRevision() === before + 2, `${notified}`);

  await store.prefetch(AUDIO);
  eq('a loaded transcript is not fetched again', fetched.length, 1);

  eq(
    'no transcript published -> unavailable, no download attempted',
    await store.prefetch('tours/t1/wp02_no_transcript.m4a'),
    { status: 'unavailable' },
  );
  eq('...and nothing fetched', fetched.length, 1);

  const signedBefore = signed.length;
  eq('a path with no audio extension -> unavailable', await store.prefetch('tours/t1/x.opus'), { status: 'unavailable' });
  eq('...and nothing signed', signed.length, signedBefore);

  const warn = mock.method(console, 'warn', () => {});
  body = async () => new Response('gone', { status: 403 });
  eq('an expired or refused URL -> unavailable, never a throw', await store.prefetch('tours/t1/wp03.m4a'), { status: 'unavailable' });

  body = '<html>error page</html>';
  eq('an HTML page is not rendered as a transcript', await store.prefetch('tours/t1/wp04.m4a'), { status: 'unavailable' });

  body = async () => new Response('WEBVTT', { status: 200, headers: { 'content-length': String(MAX_REMOTE_TRANSCRIPT_BYTES + 1) } });
  eq('an oversized object is not read', await store.prefetch('tours/t1/wp05.m4a'), { status: 'unavailable' });

  body = async () => Promise.reject(new TypeError('Network request failed'));
  eq('a dropped connection -> unavailable', await store.prefetch('tours/t1/wp06.m4a'), { status: 'unavailable' });
  body = VTT;
  eq('...and an unavailable one is retried once the stream recovers', (await store.prefetch('tours/t1/wp06.m4a')).status, 'ready');
  warn.mock.restore();
  unsubscribe();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
