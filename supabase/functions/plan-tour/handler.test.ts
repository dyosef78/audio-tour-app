/**
 * plan-tour handler - Deno tests with injected fakes (no network, no DB).
 * The planner's maths is covered in backend/scripts/test-planner.ts; this is
 * the HTTP contract, idempotency, revalidation and the fill bound.
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';

import { coordsKey } from '@shared/routing/coordsKey.ts';
import { RoutingError, type LonLat, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';
import type { PlanFetchError, PlanTourError, PlanTourOk } from '@shared/contracts/planTour.ts';
import type { MissingCell } from '@shared/planner/index.ts';
import {
  fillMissingCosts,
  handlePlanTour,
  RpcError,
  type ChapterState,
  type FillDeps,
  type LegCostWrite,
  type NewPlanRow,
  type PlanTourDeps,
  type StoredPlan,
  type TransferCostWrite,
} from './handler.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CITY = uuid(1);
const TOUR = uuid(2);
const CH_A = uuid(10);
const CH_B = uuid(20);
const NOW = Date.parse('2026-10-04T08:00:00Z');

const p = (lon: number, lat: number): [number, number] => [lon, lat];
const A = { entry: p(34.77, 32.08), exit: p(34.773, 32.08), core1: p(34.771, 32.08), ext: p(34.772, 32.081), core2: p(34.7725, 32.08) };
const B = { entry: p(34.776, 32.08), exit: p(34.779, 32.08), core1: p(34.777, 32.08) };
const key = (a: [number, number], b: [number, number]) => coordsKey({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });

function answer(over: Record<string, unknown> = {}): Record<string, unknown> {
  const stop = (id: string, sort: number, role: string, pos: [number, number], weight = 0) => ({
    waypoint_id: id, sort_order: sort, stop_role: role, poi_type: 'anchor', coordinates: pos, eligible: true,
    dwell_s: 120, deep_dive_dwell_s: 0, narration_s: 60, interest_weights: {}, matched_weight: weight,
  });
  const chapter = (id: string, e: [number, number], x: [number, number], stops: unknown[]) => ({
    chapter_id: id, tour_id: TOUR, tour_title: 'Old Jaffa', title: null, chapter_sort_order: 0, transit_mode: 'walking',
    profile: 'pedestrian', entry: e, exit: x, origin_crow_m: 0, lower_bound_s: 0, core_dwell_s: 0, core_path_m: 0,
    core_matched_weight: 2, stops,
  });
  return {
    transfer_profile: 'pedestrian', budget_s: 7200, considered: 2, pruned: {}, min_pruned_lower_bound_s: null, truncated: false,
    candidates: [
      chapter(CH_A, A.entry, A.exit, [stop(uuid(11), 1, 'core', A.core1), stop(uuid(12), 2, 'extension', A.ext, 3), stop(uuid(13), 3, 'core', A.core2)]),
      chapter(CH_B, B.entry, B.exit, [stop(uuid(21), 4, 'core', B.core1)]),
    ],
    // One cached leg; everything else is missing -> estimated.
    transfers: [],
    legs: [{ chapter_id: CH_A, from_node: 'entry', to_node: uuid(11), duration_s: 70, distance_m: 95, coords_key: key(A.entry, A.core1) }],
    ...over,
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  contract_version: 1, city_id: CITY, origin: { lon: 34.769912, lat: 32.080044, source: 'gps' }, available_minutes: 120,
  transit_mode: 'walking', group_type: 'solo', interests: ['history'], context: { local_time: '2026-10-04T11:00:00+03:00' },
  include_deep_dives: false, ...over,
});
const post = (b: unknown, auth?: string) => new Request('https://x/functions/v1/plan-tour', {
  method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b), headers: auth ? { Authorization: `Bearer ${auth}` } : {},
});
const getReq = (id: string, auth?: string) => new Request(`https://x/functions/v1/plan-tour?plan_id=${id}`, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });

interface Harness {
  deps: PlanTourDeps;
  saved: NewPlanRow[];
  rows: Map<string, StoredPlan & { requestHash: string }>;
  deferred: Promise<unknown>[];
  routes: { locations: LonLat[]; profile: ValhallaProfile }[];
  legWrites: LegCostWrite[];
  transferWrites: TransferCostWrite[];
  logs: Record<string, unknown>[];
  bundleCalls: number;
  hashes: Record<string, string | null>;
  state: Record<string, ChapterState>;
}

function harness(opts: { candidates?: () => Promise<unknown>; token?: boolean; route?: (l: LonLat[]) => Promise<ValhallaRoute>; users?: Record<string, string> } = {}): Harness {
  const h: Harness = {
    saved: [], rows: new Map(), deferred: [], routes: [], legWrites: [], transferWrites: [], logs: [], bundleCalls: 0,
    hashes: { [TOUR]: 'bundlehash1' },
    state: {
      [CH_A]: { tourId: TOUR, tourPublished: true, plannable: true, entry: A.entry, exit: A.exit },
      [CH_B]: { tourId: TOUR, tourPublished: true, plannable: true, entry: B.entry, exit: B.exit },
    },
    deps: undefined as unknown as PlanTourDeps,
  };
  let n = 100;
  const fill: FillDeps = {
    takeToken: () => Promise.resolve(opts.token ?? true),
    route: (locations, profile) => {
      h.routes.push({ locations, profile });
      return opts.route ? opts.route(locations) : Promise.resolve({
        profile, encoding: 'polyline', precision: 6, polyline: '', distanceMeters: 0, durationSeconds: 0, locationOffsetsMeters: [],
        legs: locations.slice(1).map((_, i) => ({ polyline: '', distanceMeters: 100 + i, durationSeconds: 80 + i })),
      });
    },
    saveLegs: (rows) => { h.legWrites.push(...rows); return Promise.resolve(); },
    saveTransfers: (rows) => { h.transferWrites.push(...rows); return Promise.resolve(); },
  };
  h.deps = {
    now: () => NOW,
    requestId: () => 'req-1',
    rateLimit: null,
    userIdFor: (r) => Promise.resolve(opts.users?.[r.headers.get('Authorization')?.replace('Bearer ', '') ?? ''] ?? null),
    candidates: opts.candidates ?? (() => Promise.resolve(answer())),
    bundleHashes: (ids) => { h.bundleCalls++; return Promise.resolve(Object.fromEntries(ids.map((id) => [id, h.hashes[id] ?? null]))); },
    chapterState: (ids) => Promise.resolve(Object.fromEntries(ids.filter((id) => h.state[id]).map((id) => [id, h.state[id]!]))),
    findPlanByHash: (hash) => Promise.resolve([...h.rows.values()].find((r) => r.requestHash === hash) ?? null),
    loadPlan: (id) => Promise.resolve(h.rows.get(id) ?? null),
    savePlan: (row) => {
      h.saved.push(row);
      const existing = [...h.rows.values()].find((r) => r.requestHash === row.requestHash);
      const id = existing?.id ?? uuid(n++);
      const stored = { id, userId: row.userId, expiresAt: row.expiresAt, contentHash: row.contentHash, sourceTourHashes: row.sourceTourHashes, plan: row.plan, requestHash: row.requestHash };
      h.rows.set(id, stored);
      return Promise.resolve(stored);
    },
    fill,
    defer: (work) => { h.deferred.push(work); },
    log: (e) => { h.logs.push(e); },
  };
  return h;
}

Deno.test('POST: a plan in the contract shape, saved once, origin never stored', async () => {
  const h = harness();
  const res = await handlePlanTour(post(body()), h.deps);
  assertEquals(res.status, 200);
  const plan = await res.json() as PlanTourOk;
  assertEquals(plan.status, 'ok');
  assertEquals(plan.planner_version, 'v4');
  assertEquals(typeof plan.quality.dropped_high_value_extensions, 'number');
  assert(/^[0-9a-f]{32}$/.test(plan.content_hash));
  assertEquals(plan.sources, [{ tour_id: TOUR, bundle_version_hash: 'bundlehash1' }]);
  const first = plan.segments[0]!;
  assert(first.kind === 'transfer' && first.from.kind === 'origin' && !('point' in first.from));
  assertEquals(plan.quality.search_truncated, false);
  assert(plan.estimate.total_s <= Math.floor(7200 * 0.9));

  assertEquals(h.saved.length, 1);
  const row = h.saved[0]!;
  assert(/^[0-9a-f]{64}$/.test(row.requestHash));
  assertEquals(row.originApprox, [34.77, 32.08]);
  assert(!('origin' in row.request), 'request must not carry the origin');
  assertEquals(row.request.origin_source, 'gps');
  assert(!JSON.stringify(row.plan).includes('34.769912'), 'the exact origin must not reach the stored plan');
  assertEquals(Date.parse(row.expiresAt) - NOW, 30 * 86_400_000);
});

Deno.test('POST: identical requests are idempotent - same plan_id, no second write or bundle read', async () => {
  const h = harness();
  const a = await (await handlePlanTour(post(body()), h.deps)).json() as PlanTourOk;
  const bundleCallsAfterFirst = h.bundleCalls;
  const b = await (await handlePlanTour(post(body({ origin: { lon: 34.77002, lat: 32.07996, source: 'gps' } })), h.deps)).json() as PlanTourOk;
  assertEquals(b.plan_id, a.plan_id, 'origins within the same ~110 m cell share the plan');
  assertEquals(h.saved.length, 1);
  assertEquals(h.bundleCalls, bundleCallsAfterFirst);
  const c = await (await handlePlanTour(post(body(), 'user-token'), { ...h.deps, userIdFor: () => Promise.resolve(uuid(99)) })).json() as PlanTourOk;
  assert(c.plan_id !== a.plan_id, 'a signed-in user gets their own row');
});

Deno.test('POST: request errors are 400 with a code, never a guess', async () => {
  const h = harness();
  assertEquals((await handlePlanTour(post('{not json'), h.deps)).status, 400);
  const v2 = await (await handlePlanTour(post(body({ contract_version: 2 })), h.deps)).json() as PlanTourError;
  assertEquals(v2.code, 'unsupported_contract');
  const bad = await (await handlePlanTour(post(body({ interests: [] })), h.deps)).json() as PlanTourError;
  assertEquals([bad.code, bad.retryable], ['invalid_request', false]);
  const city = harness({ candidates: () => Promise.reject(new RpcError('City not found.', 'P0002')) });
  assertEquals((await handlePlanTour(post(body()), city.deps)).status, 400);
  const boom = harness({ candidates: () => Promise.reject(new RpcError('connection reset', '08006')) });
  const r = await handlePlanTour(post(body()), boom.deps);
  const e = await r.json() as PlanTourError;
  assertEquals([r.status, e.code, e.retryable, e.request_id], [500, 'internal', true, 'req-1']);
  assertEquals((await handlePlanTour(new Request('https://x/', { method: 'PUT' }), h.deps)).status, 405);
});

Deno.test('POST: no survivors maps to the right 422 code', async () => {
  const empty = (pruned: Record<string, number>, min: number | null = null) =>
    harness({ candidates: () => Promise.resolve(answer({ candidates: [], legs: [], pruned, min_pruned_lower_bound_s: min })) });
  const over = await (await handlePlanTour(post(body()), empty({ over_budget: 2, mode: 1 }, 7000).deps)).json() as PlanTourError;
  assertEquals([over.code, over.shortfall_s], ['plan_infeasible', 7000 - Math.floor(7200 * 0.9)]);
  assertEquals((await (await handlePlanTour(post(body()), empty({ origin_too_far: 3 }).deps)).json() as PlanTourError).code, 'origin_out_of_range');
  assertEquals((await (await handlePlanTour(post(body()), empty({ interests: 4 }).deps)).json() as PlanTourError).code, 'no_candidates');
});

Deno.test('POST: rate limited -> 429 with Retry-After', async () => {
  const h = harness();
  const res = await handlePlanTour(post(body()), { ...h.deps, rateLimit: () => Promise.resolve({ allowed: false, retryAfterSeconds: 7, scope: 'client' }) });
  assertEquals([res.status, res.headers.get('Retry-After')], [429, '7']);
  assertEquals(((await res.json()) as PlanTourError).retry_after_s, 7);
});

Deno.test('fill: one Valhalla request, at most 5 cells, written with coords_key', async () => {
  const h = harness();
  await handlePlanTour(post(body()), h.deps);
  await Promise.all(h.deferred);
  assertEquals(h.routes.length, 1, 'exactly one routing request per execution');
  const cells = h.routes[0]!.locations.length - 1;
  assert(cells >= 1 && cells <= 5, `${cells} cells`);
  assertEquals(h.legWrites.length + h.transferWrites.length, cells);
  for (const w of [...h.legWrites, ...h.transferWrites]) assert(/^-?\d+\.\d{6},-?\d+\.\d{6};-?\d+\.\d{6},-?\d+\.\d{6}$/.test(w.coordsKey));
});

Deno.test('fill: bounded, refused politely, never guessed', async () => {
  const leg = (from: string, to: string, i: number): MissingCell => ({
    kind: 'leg', chapterId: CH_A, profile: 'pedestrian', fromNode: from, toNode: to, from: p(34.77 + i * 0.001, 32.08), to: p(34.771 + i * 0.001, 32.08),
  });
  const chain6 = ['entry', 'a', 'b', 'c', 'd', 'e', 'f'].slice(0, 6).map((n, i, all) => leg(n, ['a', 'b', 'c', 'd', 'e', 'f'][i]!, i));
  const h = harness();
  let threw = '';
  try { await fillMissingCosts(chain6, h.deps.fill!, h.deps.log); } catch (e) { threw = String(e); }
  assert(/exceeds 5/.test(threw), 'a 6-cell chain is refused outright');
  assertEquals(h.routes.length, 0);

  const noToken = harness({ token: false });
  await fillMissingCosts(chain6.slice(0, 3), noToken.deps.fill!, noToken.deps.log);
  assertEquals(noToken.routes.length, 0, 'no token, no request');

  const unroutable = harness({ route: () => Promise.reject(new RoutingError('unroutable', 'no route')) });
  await fillMissingCosts(chain6.slice(0, 1), unroutable.deps.fill!, unroutable.deps.log);
  assertEquals(unroutable.legWrites.map((w) => w.durationS), [null], 'a single-cell "no route" is stored as unroutable');
  const unroutable3 = harness({ route: () => Promise.reject(new RoutingError('unroutable', 'no route')) });
  await fillMissingCosts(chain6.slice(0, 3), unroutable3.deps.fill!, unroutable3.deps.log);
  assertEquals(unroutable3.legWrites.length, 0, 'which hop failed is unknown: nothing written');

  const limited = harness({ route: () => Promise.reject(new RoutingError('rate_limited', '429')) });
  await fillMissingCosts(chain6.slice(0, 2), limited.deps.fill!, limited.deps.log);
  assertEquals([limited.routes.length, limited.legWrites.length], [1, 0], 'a 429 is not retried');

  let broken = '';
  try { await fillMissingCosts([chain6[0]!, chain6[2]!], h.deps.fill!, h.deps.log); } catch (e) { broken = String(e); }
  assert(/contiguous/.test(broken), 'a non-contiguous chain is refused');
});

Deno.test('GET: not found, other user, expired, stale, fresh', async () => {
  const h = harness({ users: { alice: uuid(500) } });
  const anon = await (await handlePlanTour(post(body()), h.deps)).json() as PlanTourOk;

  assertEquals((await handlePlanTour(getReq('nope'), h.deps)).status, 404);
  assertEquals((await handlePlanTour(getReq(uuid(4242)), h.deps)).status, 404);

  const fresh = await handlePlanTour(getReq(anon.plan_id), h.deps);
  assertEquals(fresh.status, 200);
  assertEquals(((await fresh.json()) as PlanTourOk).plan_id, anon.plan_id);

  const mine = await (await handlePlanTour(post(body(), 'alice'), h.deps)).json() as PlanTourOk;
  assertEquals((await handlePlanTour(getReq(mine.plan_id), h.deps)).status, 404, 'anon cannot read a signed-in user\'s plan');
  assertEquals((await handlePlanTour(getReq(mine.plan_id, 'alice'), h.deps)).status, 200);

  h.state[CH_A] = { ...h.state[CH_A]!, entry: p(34.7701, 32.08) };
  const moved = await handlePlanTour(getReq(anon.plan_id), h.deps);
  const m = await moved.json() as PlanFetchError;
  assertEquals([moved.status, m.code, m.stale_tour_ids], [409, 'plan_stale', [TOUR]], 'a moved entry point is stale');

  h.state[CH_A] = { ...h.state[CH_A]!, entry: A.entry };
  h.hashes[TOUR] = 'bundlehash2';
  assertEquals((await handlePlanTour(getReq(anon.plan_id), h.deps)).status, 409, 'a changed bundle is stale');

  h.hashes[TOUR] = 'bundlehash1';
  h.state[CH_A] = { ...h.state[CH_A]!, tourPublished: false };
  assertEquals((await handlePlanTour(getReq(anon.plan_id), h.deps)).status, 409, 'an unpublished tour is stale');

  h.state[CH_A] = { ...h.state[CH_A]!, tourPublished: true };
  const later = { ...h.deps, now: () => NOW + 31 * 86_400_000 };
  const expired = await handlePlanTour(getReq(anon.plan_id), later);
  assertEquals([expired.status, ((await expired.json()) as PlanFetchError).code], [410, 'plan_expired']);
});

Deno.test('GET: a plan stored by an EARLIER planner version is not stale after a deploy (v4 fix)', async () => {
  const { contentHash } = await import('@shared/planner/index.ts');
  const h = harness();
  const made = await (await handlePlanTour(post(body()), h.deps)).json() as PlanTourOk;
  const row = h.rows.get(made.plan_id)!;
  // As planner v2 stored it: its own version, no silent_stop_ids on the wire, hashed accordingly.
  const segments = row.plan.segments.map((s) => {
    if (s.kind !== 'chapter') return s;
    const { silent_stop_ids: _drop, ...rest } = s;
    return rest as typeof s;
  });
  const chapters = segments.filter((s) => s.kind === 'chapter').map((s) => ({ chapterId: s.chapter_id, waypointIds: s.waypoint_ids, entry: h.state[s.chapter_id]!.entry!, exit: h.state[s.chapter_id]!.exit! }));
  h.rows.set(made.plan_id, { ...row, plan: { ...row.plan, planner_version: 'v2', segments }, contentHash: await contentHash(chapters, row.sourceTourHashes, 'v2') });
  const res = await handlePlanTour(getReq(made.plan_id), h.deps);
  assertEquals(res.status, 200, 'hashed with the stored version, an unchanged v2 plan is still fresh');
});
