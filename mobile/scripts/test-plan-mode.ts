/**
 * Epic 16 Part 4 - planned-session mode, `npm run test:plan` (plain Node, no stubs).
 *
 *   parsePlanTourOk         the contract parser both sides use
 *   sessionStops('plan')    exactly the plan's stops, in plan order
 *   engineTourFromPlan      synthetic transfer chapters + the strict gate
 *   planChapters            what the chapter panel shows
 *   createPlanClient        HTTP mapping against a fake fetch
 */

import { parsePlanTourOk, type PlanTourOk } from '../../shared/src/contracts/planTour.ts';
import { engineTourFromPlan, isTransferChapter, planChapters, planProblem } from '../src/engine/fromPlan.ts';
import { sessionStops } from '../src/routing/stopSelection.ts';
import { createPlanClient } from '../src/services/planner/PlanClient.ts';
import type { WireBundle, WireWaypoint } from '../src/services/bundle/types.ts';
import type { Waypoint } from '../src/types/domain.ts';

let checks = 0;
let failures = 0;
function assert(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}
const eq = <T>(label: string, a: T, b: T) => assert(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
const throwsLike = (label: string, fn: () => unknown, re: RegExp) => {
  try { fn(); assert(label, false, 'did not throw'); } catch (e) { assert(label, re.test(String(e)), String(e)); }
};
const heading = (t: string) => console.log(`\n${t}`);
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// -----------------------------------------------------------------------------
// Fixtures: two downloaded tours, one chapter each.
//   Tour A (walk): core a1 - extension a2 - core a3 (transition) - extension a4
//   Tour B (drive, its own handoff): core b1 - core b2

const TA = uuid(1), TB = uuid(2), CA = uuid(10), CB = uuid(20);
const wp = (id: string, sort: number, chapter: string, role: 'core' | 'extension', poi = 'anchor'): WireWaypoint => ({
  waypoint_id: id, name: id, poi_type: poi, sort_order: sort, coordinates: [34.78 + sort * 0.001, 32.08], chapter_id: chapter, stop_role: role,
  geofence: { type: 'radius', radius_meters: 30, center: [34.78 + sort * 0.001, 32.08] }, media: null, approach: null,
});
const manifest = (tour: string, hash: string, chapter: string, mode: string, waypoints: WireWaypoint[], handoff: WireBundle['chapters'] extends (infer C)[] | undefined ? C extends { handoff: infer H } ? H : never : never = null) => ({
  bundle_version_hash: hash,
  tour_metadata: { tour_id: tour, title: `Tour ${tour.slice(-1)}`, topology: 'in_city', transit_mode: mode, duration_minutes: 60, audiences: [], interests: [] },
  waypoints,
  route: null,
  chapters: [{ chapter_id: chapter, sort_order: 0, title: null, transit_mode: mode, sequence_policy: 'windowed', lookahead_stops: 3, handoff }],
}) as unknown as WireBundle;

const A1 = uuid(11), A2 = uuid(12), A3 = uuid(13), A4 = uuid(14), B1 = uuid(21), B2 = uuid(22);
const mA = manifest(TA, 'hashA', CA, 'walking', [wp(A1, 1, CA, 'core'), wp(A2, 2, CA, 'extension'), wp(A3, 3, CA, 'core', 'transition'), wp(A4, 4, CA, 'extension')]);
const mB = manifest(TB, 'hashB', CB, 'driving', [wp(B1, 1, CB, 'core'), wp(B2, 2, CB, 'core')],
  { destination: [34.9, 32.2], destination_label: 'Lookout', anchors: [], providers: ['google_maps', 'waze'] });
const manifests = new Map([[TA, mA], [TB, mB]]);

const rawPlan = (): Record<string, unknown> => ({
  status: 'ok', contract_version: 1, plan_id: uuid(500), planner_version: 'v2', content_hash: 'a'.repeat(32), expires_at: '2026-11-03T08:00:00.000Z',
  sources: [{ tour_id: TA, bundle_version_hash: 'hashA' }, { tour_id: TB, bundle_version_hash: 'hashB' }],
  segments: [
    { kind: 'transfer', from: { kind: 'origin' }, to_chapter_id: CA, to: { lon: 34.78, lat: 32.08 }, mode: 'driving', duration_s: 600, distance_m: 5000, cost_source: 'estimated', providers: ['google_maps', 'waze'] },
    { kind: 'chapter', tour_id: TA, chapter_id: CA, transit_mode: 'walking', waypoint_ids: [A1, A2, A3], kept_extension_ids: [A2], dropped_extension_ids: [A4], travel_s: 300, dwell_s: 400, cost_source: 'valhalla' },
    { kind: 'transfer', from: { kind: 'chapter_exit', chapter_id: CA, point: { lon: 34.784, lat: 32.08 } }, to_chapter_id: CB, to: { lon: 34.85, lat: 32.1 }, mode: 'driving', duration_s: 900, distance_m: 9000, cost_source: 'valhalla', providers: ['google_maps', 'waze'] },
    { kind: 'chapter', tour_id: TB, chapter_id: CB, transit_mode: 'driving', waypoint_ids: [B1, B2], kept_extension_ids: [], dropped_extension_ids: [], travel_s: 1200, dwell_s: 0, cost_source: 'valhalla' },
  ],
  estimate: { budget_s: 7200, total_s: 3400, transfer_s: 1500, chapter_travel_s: 1500, dwell_s: 400, deep_dive_extra_s: 0, slack_s: 3800, pace_factor: 1 },
  quality: { candidates_considered: 2, legs_total: 9, legs_estimated: 1, search_truncated: false, dropped_high_value_extensions: 1 },
});
const plan: PlanTourOk = parsePlanTourOk(rawPlan());
const mutate = (fn: (p: Record<string, any>) => void) => { const p = JSON.parse(JSON.stringify(rawPlan())); fn(p); return p; };

// -----------------------------------------------------------------------------
heading('parsePlanTourOk');
eq('a valid plan parses', [plan.segments.length, plan.quality.dropped_high_value_extensions], [4, 1]);
throwsLike('a non-hex content_hash is refused', () => parsePlanTourOk(mutate((p) => { p.content_hash = 'nope'; })), /content_hash/);
throwsLike('segments that do not alternate are refused', () => parsePlanTourOk(mutate((p) => { p.segments = [p.segments[1], p.segments[0]]; })), /expected transfer/);
throwsLike('a transfer pointing elsewhere is refused', () => parsePlanTourOk(mutate((p) => { p.segments[2].to_chapter_id = uuid(99); })), /goes elsewhere/);
throwsLike('the first transfer may not carry the origin', () => parsePlanTourOk(mutate((p) => { p.segments[0].from = { kind: 'origin', point: { lon: 1, lat: 1 } }; })), /origin/);
throwsLike('a chapter outside the pinned sources is refused', () => parsePlanTourOk(mutate((p) => { p.segments[3].tour_id = uuid(77); })), /pinned sources/);
throwsLike('a pinned source no chapter uses is refused', () => parsePlanTourOk(mutate((p) => { p.sources.push({ tour_id: uuid(78), bundle_version_hash: 'x' }); })), /no chapter uses/);
throwsLike('a v1 body without the upsell count is refused', () => parsePlanTourOk(mutate((p) => { delete p.quality.dropped_high_value_extensions; })), /dropped_high_value/);
throwsLike('an estimate over budget is refused', () => parsePlanTourOk(mutate((p) => { p.estimate.total_s = 9000; })), /over budget/);

// -----------------------------------------------------------------------------
heading("sessionStops({ kind: 'plan' })");
const domain = (m: WireBundle): Waypoint[] => m.waypoints.map((w) => ({
  id: w.waypoint_id, tourId: m.tour_metadata.tour_id, name: w.name, poiType: w.poi_type as Waypoint['poiType'],
  coordinate: { latitude: w.coordinates[1], longitude: w.coordinates[0] }, sortOrder: w.sort_order, geofence: null, audio: null,
  stopRole: w.stop_role === 'extension' ? 'extension' : 'core',
}));
const all = [...domain(mA), ...domain(mB)];
const planIds = plan.segments.flatMap((s) => (s.kind === 'chapter' ? [...s.waypoint_ids] : []));
const sel = sessionStops(all, { kind: 'plan', waypointIds: planIds });
eq('exactly the planned stops, in PLAN order, across tours', sel.active.map((w) => w.id), [A1, A2, A3, B1, B2]);
eq('a kept extension plays; the dropped one is excluded', sel.excludedIds, [A4]);
throwsLike('a stop no bundle holds is refused', () => sessionStops(all, { kind: 'plan', waypointIds: [A1, uuid(404)] }), /no downloaded bundle/);
throwsLike('a stop named twice is refused', () => sessionStops(all, { kind: 'plan', waypointIds: [A1, A1] }), /twice/);
eq('catalogue mode is untouched: core only', sessionStops(domain(mA), { kind: 'catalogue' }).active.map((w) => w.id), [A1, A3]);

// -----------------------------------------------------------------------------
heading('engineTourFromPlan');
const tour = engineTourFromPlan(plan, manifests);
eq('chapters: transfer, A, transfer, B - in plan order', tour.chapters.map((c) => `${isTransferChapter(c.id) ? 'T' : 'C'}${c.sortOrder}`), ['T0', 'C1', 'T2', 'C3']);
const t0 = tour.chapters[0]!;
eq('a transfer chapter: no stops, destination = the next entry, transfer mode', [t0.id, t0.destination, t0.transitMode, tour.stops.filter((s) => s.chapterId === t0.id).length],
  [`transfer:${CA}`, { latitude: 32.08, longitude: 34.78 }, 'driving', 0]);
eq('an authored chapter keeps its own handoff destination', tour.chapters[3]!.destination, { latitude: 32.2, longitude: 34.9 });
eq('stops renumbered per chapter (the window never counts a dropped stop)', tour.stops.map((s) => [s.id, s.index]), [[A1, 0], [A2, 1], [A3, 2], [B1, 0], [B2, 1]]);

const stale = new Map([[TA, { ...mA, bundle_version_hash: 'hashA2' } as WireBundle], [TB, mB]]);
throwsLike('a source at another version is refused (pins)', () => engineTourFromPlan(plan, stale), /different version/);
throwsLike('a missing source is refused', () => engineTourFromPlan(plan, new Map([[TA, mA]])), /not downloaded/);
const p2 = parsePlanTourOk(mutate((p) => { p.segments[1].waypoint_ids = [A2, A3]; p.segments[1].kept_extension_ids = [A2]; }));
eq('a plan leaving out a CORE stop is refused (core means core)', planProblem(p2, manifests), `chapter ${CA} leaves out core stop ${A1}`);
const p3 = parsePlanTourOk(mutate((p) => { p.segments[1].waypoint_ids = [A2, A1, A3]; }));
eq('stops out of authored order are refused', planProblem(p3, manifests), `chapter ${CA}: stops are not in authored order`);
const p4 = parsePlanTourOk(mutate((p) => { p.segments[1].dropped_extension_ids = []; }));
eq('kept + dropped must be exactly the extensions', planProblem(p4, manifests), `chapter ${CA}: kept + dropped is not the chapter's extensions`);
const p5 = parsePlanTourOk(mutate((p) => { p.segments[1].waypoint_ids = [A1, A3]; }));
eq('a kept extension that is not planned is refused', planProblem(p5, manifests), `chapter ${CA}: the planned extensions are not the kept ones`);
const p6 = parsePlanTourOk(mutate((p) => { p.segments[3].waypoint_ids = [B1, B2, A1]; }));
eq('a stop from another chapter is refused', planProblem(p6, manifests), `stop ${A1} is not in chapter ${CB}`);

const panel = planChapters(plan, manifests);
eq('panel: "Travel to ..." with the plan providers, then the authored chapter', panel.map((c) => [c.title, c.handoff?.providers ?? null]),
  [['Travel to Tour 1', ['google_maps', 'waze']], ['Tour 1', null], ['Travel to Tour 2', ['google_maps', 'waze']], ['Tour 2', ['google_maps', 'waze']]]);

// -----------------------------------------------------------------------------
heading('createPlanClient');
{
  const calls: { url: string; init: RequestInit }[] = [];
  const reply = (status: number, body: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  };
  const client = (f: typeof fetch, token: string | null = null, timeoutMs?: number) =>
    createPlanClient({ baseUrl: 'https://x.supabase.co', anonKey: 'ANON', accessToken: async () => token, fetch: f, ...(timeoutMs ? { timeoutMs } : {}) });
  const request = {
    contract_version: 1 as const, city_id: uuid(3), origin: { lon: 34.78, lat: 32.08, source: 'address' as const }, available_minutes: 120,
    transit_mode: 'walking' as const, group_type: 'solo' as const, interests: ['history' as const], context: { local_time: '2026-10-04T10:00:00+03:00' }, include_deep_dives: false,
  };

  const ok = await client(reply(200, rawPlan()) as typeof fetch).plan(request);
  assert('200 -> a parsed plan', ok.kind === 'plan' && ok.plan.plan_id === uuid(500));
  const hdr = calls[0]!.init.headers as Record<string, string>;
  eq('anonymous: Authorization carries the anon key', [calls[0]!.url, hdr.Authorization, hdr.apikey], ['https://x.supabase.co/functions/v1/plan-tour', 'Bearer ANON', 'ANON']);
  await client(reply(200, rawPlan()) as typeof fetch, 'USER').plan(request);
  eq('signed in: the user token', (calls[1]!.init.headers as Record<string, string>).Authorization, 'Bearer USER');

  const local = await client(reply(200, rawPlan()) as typeof fetch).plan({ ...request, interests: [] });
  assert('an invalid request never leaves the phone', local.kind === 'error' && local.code === 'invalid_request' && calls.length === 2);
  const infeasible = await client(reply(422, { status: 'error', code: 'plan_infeasible', detail: 'x', retryable: false, shortfall_s: 600, request_id: 'r' }) as typeof fetch).plan(request);
  assert('422 plan_infeasible keeps its shortfall', infeasible.kind === 'error' && infeasible.code === 'plan_infeasible' && infeasible.shortfallS === 600 && !infeasible.retryable);
  const limited = await client(reply(429, { status: 'error', code: 'rate_limited', detail: 'x', retryable: true, retry_after_s: 7, request_id: 'r' }) as typeof fetch).plan(request);
  assert('429 is retryable with its wait', limited.kind === 'error' && limited.retryable && limited.retryAfterS === 7);
  const garbage = await client(reply(200, { status: 'ok' }) as typeof fetch).plan(request);
  assert('a 200 that is not a plan is bad_response, never a plan', garbage.kind === 'error' && garbage.code === 'bad_response');
  const gateway = await client(reply(502, '<html>') as typeof fetch).plan(request);
  assert('a non-contract 5xx is internal and retryable', gateway.kind === 'error' && gateway.code === 'internal' && gateway.retryable);
  const offline = await client((async () => { throw new TypeError('Network request failed'); }) as typeof fetch).plan(request);
  assert('no network -> network, retryable', offline.kind === 'error' && offline.code === 'network' && offline.retryable);
  const hang = await client(((_u: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch, null, 50).plan(request);
  assert('a hung request times out', hang.kind === 'error' && hang.code === 'timeout');

  const get = (status: number, body: unknown) => client(reply(status, body) as typeof fetch).fetchPlan(uuid(500));
  assert('GET 200 -> the plan', (await get(200, rawPlan())).kind === 'plan');
  eq('GET 409 -> stale, with the tours', await get(409, { status: 'error', code: 'plan_stale', detail: '', retryable: false, stale_tour_ids: [TA], request_id: 'r' }), { kind: 'stale', staleTourIds: [TA] });
  eq('GET 410 -> expired (runnable offline if pins match)', await get(410, { status: 'error', code: 'plan_expired', detail: '', retryable: false, request_id: 'r' }), { kind: 'expired' });
  eq('GET 404 -> not_found', await get(404, { status: 'error', code: 'plan_not_found', detail: '', retryable: false, request_id: 'r' }), { kind: 'not_found' });
  const other = await client(reply(200, { ...rawPlan(), plan_id: uuid(501) }) as typeof fetch).fetchPlan(uuid(500));
  assert('a 200 for ANOTHER plan_id is refused', other.kind === 'error' && other.code === 'bad_response');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
