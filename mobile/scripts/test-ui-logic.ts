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
import { sessionStops } from '../src/routing/stopSelection.ts';
import {
  adoptableStopOrder,
  deviceLocalTime,
  formatLocalTime,
  parseRouteOrder,
  predictStopOrder,
  routePreferencesOf,
  routeRequestBody,
} from '../src/routing/routeRequest.ts';
import { LocationService } from '../src/services/location/LocationService.ts';
import { parseLocalTime } from '../../shared/src/smartSorter.ts';
import { connectivityOf } from '../src/services/network/connectivity.ts';
import AsyncStorage, { __dump, __setFailReads } from './stubs/async-storage.ts';
import { players } from './stubs/expo-audio.ts';
import { __isAppForegrounded, __setAppForegrounded, calls as locationCalls, resetCalls as resetLocationCalls } from './stubs/expo-location.ts';
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

heading('TASK-1103: the wizard produces the route-stops contract');
{
  const contract = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../shared/src/contracts/route-stops.onboarding.json'), 'utf8'),
  ) as {
    wizard: { city_slug: string; group_type: 'family_kids'; interests_in_tap_order: Interest[]; time_budget: 'half_day' };
    stops: { waypoint_id: string; sort_order: number; poi_type: string; lon: number; lat: number; audiences: GroupType[]; interests: Interest[] }[];
    request: { tour_id: string; waypoint_ids: string[]; transit_mode: 'walking'; context: { local_time: string } };
    expected_order: string[];
    expected_order_without_preferences: string[];
  };

  // Drive the REAL store through the wizard, as the screens do.
  const store = usePreferences.getState();
  store.resetPreferences();
  store.setCity(TLV.id);
  store.setGroupType(contract.wizard.group_type);
  for (const interest of contract.wizard.interests_in_tap_order) usePreferences.getState().toggleInterest(interest);
  store.setTimeBudget(contract.wizard.time_budget);
  store.completeOnboarding();

  // The route-stops wire contract (TASK-1103). Since Epic 15 a session makes no
  // route-stops call, and since Epic 16 a catalogue session runs every core
  // stop - so the request names them all.
  const criteria = routeCriteria(usePreferences.getState());
  const preferences = routePreferencesOf(criteria);
  const stops: Waypoint[] = contract.stops.map((s) => ({
    id: s.waypoint_id,
    tourId: contract.request.tour_id,
    name: s.waypoint_id,
    poiType: s.poi_type as Waypoint['poiType'],
    coordinate: { latitude: s.lat, longitude: s.lon },
    sortOrder: s.sort_order,
    geofence: null,
    audio: null,
    audiences: s.audiences,
    interests: s.interests,
    stopRole: 'core',
  }));
  const body = routeRequestBody({
    tourId: contract.request.tour_id,
    waypointIds: sessionStops(stops, { kind: 'catalogue' }).active.map((w) => w.id),
    transitMode: 'walking',
    localTime: formatLocalTime(Date.parse(contract.request.context.local_time), 180),
    preferences,
  });

  eq('the body the wizard builds IS the contract request, key for key', body, contract.request);
  eq(
    'no time budget or city in the body: they chose the tour, not the route',
    Object.keys(body).sort(),
    ['context', 'preferences', 'tour_id', 'transit_mode', 'waypoint_ids'],
  );
  eq(
    'the device predicts the order the server must return (shared contract)',
    predictStopOrder(stops, preferences, contract.request.context.local_time),
    contract.expected_order,
  );
  const localTime = contract.request.context.local_time;
  eq(
    '...and only the FULL preferences produce it (none / group only / interests only / one interest)',
    [
      predictStopOrder(stops, null, localTime),
      predictStopOrder(stops, { groupType: 'family_kids', interests: [] }, localTime),
      predictStopOrder(stops, { groupType: '', interests: ['nature', 'culinary'] }, localTime),
      predictStopOrder(stops, { groupType: 'family_kids', interests: ['nature'] }, localTime),
    ],
    Array(4).fill(contract.expected_order_without_preferences),
  );

  const permutations = [['culinary', 'nature'], ['nature', 'culinary']] as const;
  eq(
    'interest TAP order never changes the route',
    permutations.map((interests) =>
      predictStopOrder(stops, { groupType: 'family_kids', interests }, contract.request.context.local_time),
    ),
    [contract.expected_order, contract.expected_order],
  );

  store.resetPreferences();
  const beforeOnboarding = routeRequestBody({
    tourId: contract.request.tour_id,
    waypointIds: contract.request.waypoint_ids,
    transitMode: 'walking',
    localTime: contract.request.context.local_time,
    preferences: routePreferencesOf(routeCriteria(usePreferences.getState())),
  });
  eq('before onboarding completes there is no preferences key at all', 'preferences' in beforeOnboarding, false);
}

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
assert('cache key depends on the visiting order (TASK-903)', routeCacheKey('t', 'h', ['b', 'a']) !== routeCacheKey('t', 'h', ['a', 'b']));
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

const MORNING_TIME = '2026-09-17T08:00:00+03:00';
const GOLDEN_TIME = '2026-09-17T17:40:00+03:00'; // sunset in Jerusalem that day is ~18:44

function routeHarness(opts: { online: boolean; cache?: Map<string, EncodedRoute>; localTime?: string }) {
  let online = opts.online;
  const localTime = opts.localTime ?? MORNING_TIME;
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
    localTime: () => localTime,
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
  preferences: null,
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
  eq('stamped with the clock at send time', h.calls[0]!.req.localTime, MORNING_TIME);
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

// 7-9. Every stop kept, no route at all, and a late answer after the tour ended.
{
  const h = routeHarness({ online: true });
  await h.manager.start(sessionFor({ stops: ALL_STOPS }));
  await flush();
  eq(
    'nothing filtered: the Smart Sorter is still asked, for every stop (TASK-903)',
    [h.source(), h.calls.map((c) => c.req.waypointIds.length)],
    ['static', [4]],
  );
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
  eq('and is cached under that order', [...h.cache.keys()], ['route:dynamic:v2:jlm:hash-1:wall,jaffa']);
  h.manager.stop();
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
  eq(
    'an order naming other stops: route neither drawn, cached nor sequenced (TASK-903)',
    [orders.length, h.source(), h.cache.size, h.pendingTimers().length],
    [0, 'static', 0, 0],
  );
  h.manager.stop();
}

// -----------------------------------------------------------------------------
// TASK-903: fetch policy, preferences, order-dependent cache
// -----------------------------------------------------------------------------

heading('TASK-903: preferences and the predicted order');

// Stops on a line running north from Jaffa Gate. Checked against the real
// sorter: the morning order is a-b-v-c, golden hour pulls the viewpoint to
// second (a-v-b-c), and a history lover goes a-c-b-v.
const northOfJaffa = (metres: number) => ({ latitude: 31.7766 + metres / 111_320, longitude: 35.2279 });
const sortStop = (
  id: string,
  sort: number,
  metres: number,
  poiType: Waypoint['poiType'],
  interests: NonNullable<Waypoint['interests']>,
): Waypoint => ({
  ...stopAt(id, sort, northOfJaffa(metres).latitude, northOfJaffa(metres).longitude, { interests }),
  poiType,
});
const SA = sortStop('a', 1, 0, 'anchor', ['history']);
const SB = sortStop('b', 2, 150, 'anchor', ['culinary']);
const SV = sortStop('v', 3, 300, 'viewpoint', []);
const SC = sortStop('c', 4, -150, 'anchor', ['history']);
const SORT_STOPS = [SA, SB, SV, SC];
const HISTORY_PREFS = { groupType: 'couple', interests: ['history'] };
// Through every stop. Validation checks reach, not order, so one line serves every order.
const THROUGH_ALL: EncodedRoute = {
  precision: 6,
  polyline: encodePolyline([SC, SA, SB, SV].map(asPoint), 6),
  lengthMeters: 450,
};

eq('morning order', predictStopOrder(SORT_STOPS, null, MORNING_TIME), ['a', 'b', 'v', 'c']);
eq('golden hour pulls the viewpoint forward', predictStopOrder(SORT_STOPS, null, GOLDEN_TIME), ['a', 'v', 'b', 'c']);
eq('preferences change the order', predictStopOrder(SORT_STOPS, HISTORY_PREFS, MORNING_TIME), ['a', 'c', 'b', 'v']);
eq(
  "predicted in the session's own ids, whatever their case",
  predictStopOrder([{ ...SA, id: 'A' }, SB], null, MORNING_TIME),
  ['A', 'b'],
);
eq('a clock the sorter refuses predicts nothing', predictStopOrder(SORT_STOPS, null, '2026-09-17T08:00:00'), null);

eq(
  'preferences are sent alongside context',
  routeRequestBody({ tourId: 't', waypointIds: ['a'], transitMode: 'walking', localTime: MORNING_TIME, preferences: HISTORY_PREFS }),
  {
    tour_id: 't',
    waypoint_ids: ['a'],
    transit_mode: 'walking',
    preferences: { group_type: 'couple', interests: ['history'] },
    context: { local_time: MORNING_TIME },
  },
);

heading('TASK-903: RouteManager with an order-dependent cache');

{
  const sortSession = (over: Partial<RouteSessionContext> = {}): RouteSessionContext =>
    sessionFor({ stops: SORT_STOPS, staticRoute: null, ...over });

  // Morning, online: the server answers with the morning order.
  const morning = routeHarness({ online: true, localTime: MORNING_TIME });
  await morning.manager.start(sortSession());
  await flush();
  eq('online with an empty cache: asks at once', morning.calls.length, 1);
  morning.calls[0]!.resolve(liveRoute(THROUGH_ALL, ['a', 'b', 'v', 'c']));
  await flush();
  morning.manager.stop();

  // Evening, same stops, online: a different order, a SECOND entry.
  const evening = routeHarness({ online: true, cache: morning.cache, localTime: GOLDEN_TIME });
  await evening.manager.start(sortSession());
  await flush();
  evening.calls[0]!.resolve(liveRoute(THROUGH_ALL, ['a', 'v', 'b', 'c']));
  await flush();
  eq(
    'the evening route does not overwrite the morning one',
    [...evening.cache.keys()].sort(),
    ['route:dynamic:v2:jlm:hash-1:a,b,v,c', 'route:dynamic:v2:jlm:hash-1:a,v,b,c'],
  );
  evening.manager.stop();

  // Offline: each time window reads back its own route, and narrates in its order.
  for (const [label, time, expected] of [
    ['golden hour', GOLDEN_TIME, ['a', 'v', 'b', 'c']],
    ['morning', MORNING_TIME, ['a', 'b', 'v', 'c']],
  ] as const) {
    const orders: string[][] = [];
    const offline = routeHarness({ online: false, cache: evening.cache, localTime: time });
    await offline.manager.start(sortSession({ onStopOrder: (ids) => orders.push(ids) }));
    await flush();
    eq(
      `offline in the ${label}: that window's cached route, and narration in its order`,
      [offline.source(), orders, offline.calls.length],
      ['dynamic', [expected], 0],
    );
    offline.manager.stop();
  }

  // Offline with preferences the cache has never seen: a miss, not a wrong route.
  const unseenOrders: string[][] = [];
  const unseen = routeHarness({ online: false, cache: evening.cache, localTime: MORNING_TIME });
  await unseen.manager.start(sortSession({ preferences: HISTORY_PREFS, onStopOrder: (ids) => unseenOrders.push(ids) }));
  await flush();
  eq(
    'offline, no route cached for this order: straight lines, authored order kept',
    [unseen.source(), unseenOrders.length],
    ['straight', 0],
  );
  unseen.manager.stop();

  // Online, preferences sent; the answer is cached under the preference order.
  const refresh = routeHarness({ online: true, cache: evening.cache, localTime: MORNING_TIME });
  await refresh.manager.start(sortSession({ preferences: HISTORY_PREFS }));
  await flush();
  eq('the session snapshot of preferences is sent', refresh.calls[0]?.req.preferences, HISTORY_PREFS);
  refresh.calls[0]!.resolve(liveRoute(THROUGH_ALL, ['a', 'c', 'b', 'v']));
  await flush();
  refresh.manager.stop();

  // Online with that route cached: drawn at once, and the server still asked.
  const hitOrders: string[][] = [];
  const hit = routeHarness({ online: true, cache: refresh.cache, localTime: MORNING_TIME });
  await hit.manager.start(sortSession({ preferences: HISTORY_PREFS, onStopOrder: (ids) => hitOrders.push(ids) }));
  await flush();
  eq(
    'online with a cached route: it is drawn AND the server is still asked',
    [hit.source(), hitOrders, hit.calls.length],
    ['dynamic', [['a', 'c', 'b', 'v']], 1],
  );
  const publishedBeforeLive = hit.published.length;
  // The server disagrees with the prediction (say, a newer sorter): it wins.
  hit.calls[0]!.resolve(liveRoute(THROUGH_ALL, ['a', 'b', 'c', 'v']));
  await flush();
  eq(
    'the live route replaces the cached one on screen and re-sequences narration',
    [hit.published.length - publishedBeforeLive, hit.source(), hitOrders.at(-1)],
    [1, 'dynamic', ['a', 'b', 'c', 'v']],
  );
  await hit.setOnline(false);
  await hit.setOnline(true);
  eq('one live route per session: no further requests', hit.calls.length, 1);
  hit.manager.stop();

  // A server from before Epic 8 sends no order: it routed the order it was given.
  const legacyOrders: string[][] = [];
  const legacy = routeHarness({ online: true, localTime: MORNING_TIME });
  await legacy.manager.start(sortSession({ onStopOrder: (ids) => legacyOrders.push(ids) }));
  await flush();
  legacy.calls[0]!.resolve(liveRoute(THROUGH_ALL, null));
  await flush();
  eq(
    'no waypoint_ids: the authored order it was sent, cached under that order',
    [legacyOrders, [...legacy.cache.keys()]],
    [[['a', 'b', 'v', 'c']], ['route:dynamic:v2:jlm:hash-1:a,b,v,c']],
  );
  legacy.manager.stop();

  const noHash = routeHarness({ online: true });
  await noHash.manager.start(sortSession({ bundleHash: null }));
  await flush();
  noHash.calls[0]!.resolve(liveRoute(THROUGH_ALL, ['a', 'b', 'v', 'c']));
  await flush();
  eq('no bundle hash: fetched and drawn, never cached', [noHash.source(), noHash.cache.size], ['dynamic', 0]);
  noHash.manager.stop();
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
  routeRequestBody({
    tourId: 't',
    waypointIds: ['a', 'b'],
    transitMode: 'walking',
    localTime: '2026-09-17T18:40:05+03:00',
    preferences: null,
  }),
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
// Epic 15: LocationService is GPS transport for the engine - no decisions
// -----------------------------------------------------------------------------

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
