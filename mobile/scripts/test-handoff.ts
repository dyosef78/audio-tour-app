/**
 * Epic 15 Slice 5 - navigation handoff links. Pure.
 *
 * Run:  npm run test:engine
 */

import {
  GOOGLE_MAPS_STORE_URL,
  googleMapsUrl,
  planHandoff,
  wazeUrl,
  type HandoffSpec,
} from '../src/handoff/handoffLinks.ts';

let checks = 0;
let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}
function throws(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    assert(label, false, 'did not throw');
  } catch (e) {
    assert(label, match.test(String(e)), String(e));
  }
}
console.log('\nHandoff links\n-------------');

const P = (latitude: number, longitude: number) => ({ latitude, longitude });
const masada: HandoffSpec = {
  destination: P(31.315678912, 35.353912345),
  destinationLabel: 'East parking',
  anchors: [P(31.5, 35.1), P(31.4, 35.2)],
  providers: ['google_maps'],
};

const url = googleMapsUrl(masada, 'driving');
const q = new URL(url).searchParams;
assert('Google Maps: the documented dir endpoint, api=1', url.startsWith('https://www.google.com/maps/dir/?api=1&'), url);
assert('destination at 6 decimals', q.get('destination') === '31.315679,35.353912', String(q.get('destination')));
assert('anchors in order, |-separated (encoded as %7C)', url.includes('waypoints=31.500000%2C35.100000%7C31.400000%2C35.200000') && q.get('waypoints') === '31.500000,35.100000|31.400000,35.200000', url);
assert('turn-by-turn starts at once (dir_action=navigate), no origin (= current location)', q.get('dir_action') === 'navigate' && !q.has('origin'));
assert('travel modes: driving / walking / bicycling', q.get('travelmode') === 'driving' && new URL(googleMapsUrl(masada, 'walking')).searchParams.get('travelmode') === 'walking' && new URL(googleMapsUrl(masada, 'biking')).searchParams.get('travelmode') === 'bicycling');
assert('without the scenic route: no waypoints at all', !new URL(googleMapsUrl(masada, 'driving', { includeAnchors: false })).searchParams.has('waypoints'));
const nine = { ...masada, anchors: Array.from({ length: 9 }, (_, i) => P(31 + i / 100, 35)) };
assert('9 anchors: accepted', new URL(googleMapsUrl(nine, 'driving')).searchParams.get('waypoints')?.split('|').length === 9);
throws('10 anchors: refused (the server caps at 9)', () => googleMapsUrl({ ...nine, anchors: [...nine.anchors, P(32, 35)] }, 'driving'), /at most 9/);
throws('a NaN coordinate is refused, never sent', () => googleMapsUrl({ ...masada, destination: P(Number.NaN, 35) }, 'driving'), /not a valid coordinate/);

const direct: HandoffSpec = { destination: P(32.08, 34.78), destinationLabel: null, anchors: [], providers: ['google_maps', 'waze'] };
assert('Waze: ll + navigate=yes', wazeUrl(direct) === 'https://waze.com/ul?ll=32.080000%2C34.780000&navigate=yes', wazeUrl(direct));
throws('Waze with anchors: refused (Waze takes no waypoints)', () => wazeUrl(masada), /no waypoints/);

console.log('\nplanHandoff\n-----------');
assert('app installed: open with every anchor', (() => {
  const p = planHandoff('google_maps', masada, 'driving', { googleMaps: true }, 'ios');
  return p.kind === 'open' && p.url === url;
})());
assert('no app, 2 anchors (a browser honours 3): open anyway', planHandoff('google_maps', masada, 'driving', { googleMaps: false }, 'ios').kind === 'open');
const five = { ...masada, anchors: Array.from({ length: 5 }, (_, i) => P(31 + i / 100, 35)) };
const ask = planHandoff('google_maps', five, 'driving', { googleMaps: false }, 'android');
assert(
  'no app, 5 anchors: ASK - never silently drop the scenic route',
  ask.kind === 'needs_app' && ask.anchorCount === 5 && ask.installUrl === GOOGLE_MAPS_STORE_URL.android && !new URL(ask.withoutScenicUrl).searchParams.has('waypoints'),
  JSON.stringify(ask),
);
assert('Waze offered: open', planHandoff('waze', direct, 'driving', { googleMaps: false }, 'ios').kind === 'open');
throws('Waze NOT offered for this chapter: refused', () => planHandoff('waze', masada, 'driving', { googleMaps: true }, 'ios'), /not offered/);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
