/**
 * Epic 16 Part 4 - planned-session mode, `npm run test:plan` (plain Node, no stubs).
 *
 *   parsePlanTourOk         the contract parser both sides use
 *   sessionStops('plan')    exactly the plan's stops, in plan order
 *   engineTourFromPlan      synthetic transfer chapters + the strict gate
 *   planChapters            what the chapter panel shows
 *   createPlanClient        HTTP mapping against a fake fetch
 *   createPlanRepository    drafts vs saved plans, pins, the conflict copy
 *   downloadPlanBundles     conflict / stale / invalid / ready
 *   PlacesSession           session tokens, debounce, latest-wins, dispose
 *   planForm                the request, error copy, preview rows
 */

import { parsePlanTourOk, type PlanTourOk, type PlanTourRequest } from '../../shared/src/contracts/planTour.ts';
import { engineTourFromPlan, isTransferChapter, planChapters, planProblem } from '../src/engine/fromPlan.ts';
import { sessionStops } from '../src/routing/stopSelection.ts';
import { createPlanClient } from '../src/services/planner/PlanClient.ts';
import { downloadPlanBundles, type PlanDownloadDeps } from '../src/services/planner/planDownload.ts';
import { buildPlanRequest, estimateSummary, formatDistance, formatDuration, localIsoWithOffset, planErrorCopy, segmentRows, upsellCopy } from '../src/services/planner/planForm.ts';
import { createPlanRepository, PinnedBundleError, pinConflictCopy } from '../src/services/planner/planRepository.ts';
import { MAX_REQUESTS_PER_SESSION, MIN_QUERY, PlacesSession, SESSION_IDLE_MS, type PlacesCallResult, type PlacesClient } from '../src/services/planner/places.ts';
import { checkPlanRequest } from '../../shared/src/planner/request.ts';
import type { PlaceSuggestion } from '../../shared/src/contracts/places.ts';
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

// -----------------------------------------------------------------------------
// Final slice: plan repository (pins), plan downloads, Places session, plan form.

{
  heading('createPlanRepository - drafts pin nothing, saved plans pin their sources');
  const store = new Map<string, string>();
  const io = { read: () => store.get('f') ?? null, write: (t: string) => void store.set('f', t) };
  const logs: string[] = [];
  const repo = createPlanRepository(io, (m) => logs.push(m));
  const request = { contract_version: 1, city_id: uuid(900) } as unknown as PlanTourRequest;
  let notified = 0;
  repo.subscribe(() => notified++);

  repo.putDraft({ plan, request, originLabel: 'Dizengoff Center', savedAt: Date.UTC(2026, 9, 4) });
  eq('a draft blocks nothing', repo.blockingPlans(TA, 'hashA-new'), []);
  repo.markSaved(plan.plan_id);
  eq('saved: blocks another version of a pinned tour', repo.blockingPlans(TA, 'hashA-new').map((b) => b.planId), [plan.plan_id]);
  eq('saved: blocks removal (toHash null)', repo.blockingPlans(TB, null).map((b) => b.hash), ['hashB']);
  eq('saved: the SAME version is no conflict', repo.blockingPlans(TA, 'hashA'), []);
  eq('a tour the plan does not use is never blocked', repo.blockingPlans(uuid(3), null), []);
  assert('the label names the origin', /Dizengoff Center/.test(repo.blockingPlans(TA, null)[0]!.label));
  assert('subscribers hear every change', notified === 2, `got ${notified}`);

  const second = parsePlanTourOk({ ...rawPlan(), plan_id: uuid(501) });
  const third = parsePlanTourOk({ ...rawPlan(), plan_id: uuid(502) });
  repo.putDraft({ plan: second, request, originLabel: 'A', savedAt: 1 });
  repo.putDraft({ plan: third, request, originLabel: 'B', savedAt: 2 });
  eq('at most ONE draft; saved plans are kept', repo.list().map((p) => `${p.plan.plan_id.slice(-1)}:${p.status}`), ['4:saved', '6:draft']);
  throwsLike('markSaved of an unknown plan fails loudly', () => repo.markSaved(uuid(503)), /no plan/);

  const reloaded = createPlanRepository(io, (m) => logs.push(m));
  eq('persisted and re-parsed on load', reloaded.list().map((p) => p.status), ['saved', 'draft']);

  const file = JSON.parse(store.get('f')!);
  file.plans[1].plan.segments = [];
  store.set('f', JSON.stringify(file));
  const pruned = createPlanRepository(io, (m) => logs.push(m));
  assert('a plan that no longer parses is dropped, loudly', pruned.list().length === 1 && logs.some((l) => /dropped an unreadable/.test(l)));
  store.set('f', JSON.stringify({ v: 99, plans: [] }));
  assert('an unknown file version starts empty, loudly', createPlanRepository(io, (m) => logs.push(m)).list().length === 0 && logs.some((l) => /version 99/.test(l)));

  reloaded.remove([plan.plan_id]);
  eq('remove drops the plan and its pins', reloaded.blockingPlans(TA, null), []);

  heading("pinConflictCopy - the PM's strict-invalidation wording");
  const holder = { planId: uuid(1), label: 'your plan from Dizengoff Center (Oct 4)', hash: 'h' };
  const np = pinConflictCopy([holder], 'new_plan');
  assert('new_plan: "requires updating a tour used in" + names the plan', np.message.startsWith('Planning this new route requires updating a tour used in your plan from Dizengoff Center'));
  assert('new_plan: explicit that the old plan is overwritten', /Overwrite the old plan\?$/.test(np.message) && np.confirm === 'Overwrite old plan');
  assert('several plans are counted, not listed', /2 of your saved plans/.test(pinConflictCopy([holder, { ...holder, planId: uuid(2) }], 'update').message));
  assert('remove copy says the plan is deleted', /Removing it will delete that plan/.test(pinConflictCopy([holder], 'remove').message));
}

{
  heading('downloadPlanBundles - pins, conflicts, stale bundles');
  type Holder = { planId: string; label: string; hash: string };
  const holderX: Holder = { planId: uuid(700), label: 'your plan from X', hash: 'hashA-old' };
  const setup = (o: { local?: Record<string, string>; serve?: Record<string, string>; blocking?: Record<string, Holder[]>; fail?: Record<string, Error> } = {}) => {
    const local = new Map(Object.entries(o.local ?? {}));
    const calls: { tourId: string; invalidatePlans: readonly string[] }[] = [];
    const deps: PlanDownloadDeps = {
      localHash: (id) => local.get(id) ?? null,
      async download(id, opts) {
        calls.push({ tourId: id, invalidatePlans: opts.invalidatePlans ?? [] });
        const err = o.fail?.[id];
        if (err) throw err;
        opts.onProgress?.(0.5);
        const h = o.serve?.[id] ?? (id === TA ? 'hashA' : 'hashB');
        local.set(id, h);
        return { bundle_version_hash: h };
      },
      blockingPlans: (id) => o.blocking?.[id] ?? [],
      manifest: (id) => (local.get(id) === manifests.get(id)?.bundle_version_hash ? manifests.get(id)! : null),
    };
    return { deps, calls };
  };

  const done = setup({ local: { [TA]: 'hashA', [TB]: 'hashB' } });
  eq('everything already at its pin: ready, nothing fetched', [(await downloadPlanBundles(plan, done.deps)).kind, done.calls.length], ['ready', 0]);

  const fresh = setup();
  const progress: number[] = [];
  const r1 = await downloadPlanBundles(plan, fresh.deps, { onProgress: (f) => progress.push(f) });
  eq('fresh device: both tours fetched, ready', [r1.kind, fresh.calls.map((c) => c.tourId)], ['ready', [TA, TB]]);
  assert('progress climbs and ends at 1', progress.every((f, i) => i === 0 || f >= progress[i - 1]!) && progress.at(-1) === 1, JSON.stringify(progress));

  const pinned = setup({ local: { [TA]: 'hashA-old' }, blocking: { [TA]: [holderX] } });
  const c1 = await downloadPlanBundles(plan, pinned.deps);
  eq('a saved plan pins another version: conflict BEFORE any download', [c1.kind, c1.kind === 'conflict' ? c1.blocking.map((b) => b.planId) : null, pinned.calls.length], ['conflict', [uuid(700)], 0]);
  const c2 = await downloadPlanBundles(plan, pinned.deps, { invalidatePlans: [uuid(700)] });
  eq('agreed: downloads, passing the agreed plans to the guarded download', [c2.kind, pinned.calls[0]?.invalidatePlans], ['ready', [uuid(700)]]);

  const self = setup({ local: { [TA]: 'hashA-old' }, blocking: { [TA]: [{ ...holderX, planId: plan.plan_id }] } });
  eq('the plan being saved never blocks itself', (await downloadPlanBundles(plan, self.deps)).kind, 'ready');

  const moved = setup({ serve: { [TA]: 'hashA-newer' } });
  eq('the server bundle moved on since planning: stale', await downloadPlanBundles(plan, moved.deps), { kind: 'stale', tourId: TA });

  const raced = setup({ fail: { [TB]: new PinnedBundleError(TB, [holderX], 'update') } });
  const c3 = await downloadPlanBundles(plan, raced.deps);
  assert('a guard refusal mid-run is a conflict, not a failure', c3.kind === 'conflict' && c3.tourId === TB);

  const broken = setup({ fail: { [TA]: new Error('disk full') } });
  eq('any other error: failed, with its message', await downloadPlanBundles(plan, broken.deps), { kind: 'failed', tourId: TA, message: 'disk full' });

  const gone = setup();
  const r2 = await downloadPlanBundles(plan, gone.deps, { cancelled: () => true });
  assert('a screen that is gone stops before the next tour', r2.kind === 'failed' && r2.message === 'cancelled' && gone.calls.length === 0);

  const mismatched = setup({ local: { [TA]: 'hashA', [TB]: 'hashB' } });
  mismatched.deps.manifest = (id) => (id === TA ? ({ ...mA, waypoints: mA.waypoints.slice(0, 2) } as WireBundle) : mB);
  assert('pins match but the plan does not fit the bundle: invalid', (await downloadPlanBundles(plan, mismatched.deps)).kind === 'invalid');
}

{
  heading('PlacesSession - one token per search, debounce, latest wins, dispose');
  type Pending = { input: string; token: string; signal: AbortSignal; resolve: (r: PlacesCallResult<PlaceSuggestion[]>) => void };
  type PendingDetails = { placeId: string; token: string; signal: AbortSignal; resolve: (r: PlacesCallResult<{ lon: number; lat: number; label: string }>) => void };
  const make = () => {
    let clock = 0;
    let tokens = 0;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const auto: Pending[] = [];
    const details: PendingDetails[] = [];
    const picked: string[] = [];
    const client: PlacesClient = {
      autocomplete: (input, token, _city, signal) => new Promise((resolve) => auto.push({ input, token, signal, resolve })),
      details: (placeId, token, signal) => new Promise((resolve) => details.push({ placeId, token, signal, resolve })),
    };
    const session = new PlacesSession({
      client, cityId: uuid(900), uuid: () => `tok-${++tokens}`, now: () => clock,
      setTimeout: (fn) => { const id = nextTimer++; timers.set(id, fn); return id; },
      clearTimeout: (h) => void timers.delete(h as number),
      onSelected: (o) => picked.push(o.label),
    });
    const flush = () => { const fns = [...timers.values()]; timers.clear(); fns.forEach((fn) => fn()); };
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { session, auto, details, picked, flush, tick, timers, advance: (ms: number) => { clock += ms; } };
  };
  const sug = (id: string): PlaceSuggestion => ({ place_id: id, primary: id, secondary: null });

  const t = make();
  t.session.setQuery('Di');
  assert(`below ${MIN_QUERY} characters: no timer, no request`, t.timers.size === 0 && t.session.view.status === 'idle');
  t.session.setQuery('Diz'); t.session.setQuery('Dize'); t.session.setQuery('Dizen');
  assert('debounced: one timer pending', t.timers.size === 1 && t.session.view.status === 'searching');
  t.flush();
  eq('only the last keystroke is sent', t.auto.map((a) => a.input), ['Dizen']);
  t.session.setQuery('Dizengoff');
  t.flush();
  assert('a newer query aborts the older request', t.auto[0]!.signal.aborted);
  t.auto[1]!.resolve({ ok: true, value: [sug('new')] });
  await t.tick();
  t.auto[0]!.resolve({ ok: true, value: [sug('old')] });
  await t.tick();
  eq('latest wins: the late, older answer is dropped', t.session.view.suggestions.map((s) => s.place_id), ['new']);
  assert('every keystroke of one search shares ONE token', t.auto[0]!.token === t.auto[1]!.token && t.auto[0]!.token === 'tok-1');

  const sel = t.session.select(sug('new'));
  assert("details carries the search's token (ends the billing session)", t.details[0]!.token === 'tok-1' && t.session.view.status === 'resolving');
  t.details[0]!.resolve({ ok: true, value: { lon: 34.77, lat: 32.07, label: 'Dizengoff Center' } });
  await sel;
  eq('the pick resolves to the label and reaches the screen', [t.picked, t.session.view.query, t.session.view.status], [['Dizengoff Center'], 'Dizengoff Center', 'idle']);
  t.session.setQuery('Rothschild'); t.flush();
  assert('the next search gets a NEW token', t.auto.at(-1)!.token === 'tok-2');

  const f = make();
  f.session.setQuery('Jaffa'); f.flush();
  const failedSel = f.session.select(sug('x'));
  f.details[0]!.resolve({ ok: false, code: 'upstream', retryable: true });
  await failedSel;
  assert('a failed pick shows an error', f.session.view.status === 'error' && f.picked.length === 0);
  f.session.setQuery('Jaffa port'); f.flush();
  assert('a FAILED details call still rotates the token', f.auto.at(-1)!.token === 'tok-2');

  const idle = make();
  idle.session.setQuery('Habima'); idle.flush();
  idle.advance(SESSION_IDLE_MS + 1);
  idle.session.setQuery('Habima Sq'); idle.flush();
  assert('a token idle past SESSION_IDLE_MS is rotated', idle.auto[0]!.token !== idle.auto[1]!.token);

  const cap = make();
  for (let i = 0; i < MAX_REQUESTS_PER_SESSION; i++) { cap.session.setQuery(`query ${i}`); cap.flush(); }
  cap.session.setQuery('one too many');
  assert(`past ${MAX_REQUESTS_PER_SESSION} requests in a session: refine, no request`, cap.session.view.status === 'refine' && cap.auto.length === MAX_REQUESTS_PER_SESSION && cap.timers.size === 0);

  const d = make();
  let heard = 0;
  d.session.subscribe(() => heard++);
  d.session.setQuery('Carmel'); d.flush();
  const pending = d.session.select(sug('carmel'));
  d.session.dispose();
  assert('dispose aborts the details request in flight', d.details[0]!.signal.aborted);
  const before = heard;
  d.details[0]!.resolve({ ok: true, value: { lon: 1, lat: 1, label: 'late' } });
  await pending;
  d.session.setQuery('after dispose');
  assert('after dispose: no onSelected, no notifications, no timers', d.picked.length === 0 && heard === before && d.timers.size === 0);
}

{
  heading('planForm - request, copy, rows');
  const iso = localIsoWithOffset(new Date(2026, 9, 4, 9, 5, 7));
  assert('local time carries the wall clock and an offset', /^2026-10-04T09:05:07[+-]\d{2}:\d{2}$/.test(iso), iso);
  const req = buildPlanRequest({
    cityId: uuid(900), origin: { lon: 34.7749342, lat: 32.0751211, source: 'address', label: 'Dizengoff Center' },
    minutes: 240, transitMode: 'walking', groupType: 'couple', interests: ['history', 'culinary'], includeDeepDives: false,
  }, new Date());
  const checked = checkPlanRequest(req);
  assert("the built request passes the server's own validator", checked.ok, JSON.stringify(checked));
  assert('the origin label never leaves the phone', !JSON.stringify(req).includes('Dizengoff'));
  throwsLike('no interests is refused, not sent', () => buildPlanRequest({ cityId: uuid(900), origin: { lon: 0, lat: 0, source: 'gps', label: '' }, minutes: 60, transitMode: 'walking', groupType: 'solo', interests: [], includeDeepDives: false }, new Date()), /interest/);

  eq('durations read naturally', [formatDuration(30), formatDuration(45 * 60), formatDuration(3600), formatDuration(5400)], ['1 min', '45 min', '1 h', '1 h 30 min']);
  eq('distances', [formatDistance(437), formatDistance(5000)], ['440 m', '5.0 km']);

  const withDrops = (n: number) => parsePlanTourOk(mutate((p) => { p.quality.dropped_high_value_extensions = n; }));
  eq('upsell: none when nothing was dropped for time', upsellCopy(withDrops(0)), null);
  assert('upsell: singular and plural', /^1 more stop that/.test(upsellCopy(withDrops(1))!) && /^3 more stops that/.test(upsellCopy(withDrops(3))!));

  const rows = segmentRows(plan, { chapterTitle: (tid) => (tid === TA ? 'Old North' : null), tourTitle: (tid) => (tid === TB ? 'Coastal Drive' : null) });
  eq('rows alternate transfer, chapter', rows.map((r) => r.kind), ['transfer', 'chapter', 'transfer', 'chapter']);
  eq('titles: chapter, else tour', rows.flatMap((r) => (r.kind === 'chapter' ? [r.title] : [])), ['Old North', 'Coastal Drive']);
  assert("the first transfer is from the visitor's start", rows[0]!.kind === 'transfer' && rows[0]!.fromOrigin && rows[0]!.estimated);
  const untitled = segmentRows(plan, { chapterTitle: () => null, tourTitle: () => null });
  eq('no titles anywhere: numbered placeholders', untitled.flatMap((r) => (r.kind === 'chapter' ? [r.title] : [])), ['Stop group 1', 'Stop group 2']);

  const est = estimateSummary(plan);
  assert('estimated legs make the total "about"', est.approximate === (plan.quality.legs_estimated > 0));
  const infeasible = planErrorCopy({ kind: 'error', code: 'plan_infeasible', retryable: false, detail: '', shortfallS: 1800 });
  assert('infeasible copy names the shortfall and is not a blind retry', /30 min more/.test(infeasible.message) && !infeasible.retry);
  assert('network copy is a retry', planErrorCopy({ kind: 'error', code: 'network', retryable: true, detail: '' }).retry);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
