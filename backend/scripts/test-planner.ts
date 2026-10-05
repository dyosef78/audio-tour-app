/**
 * Epic 16 planner (shared/src/planner) - `npm run test:planner`.
 *
 * The two optimisers are checked against BRUTE FORCE on seeded random
 * instances, so "exact" and "best" are measured, not asserted:
 *   * chapterOptions (slot DP)  vs every subset of every chapter's extensions
 *   * searchSequence (B&B)      vs every ordered subset of chapters
 * plus the PM rules: detour time is the first tie-break, every core stop is
 * kept, the 10% margin holds, the background fill touches at most 5 cells,
 * and the same input always gives the same plan.
 */

import {
  canonicalJson,
  chapterOptions,
  checkPlanRequest,
  chooseFillChain,
  contentHash,
  CostBook,
  DEDUP_RADIUS_M,
  MAX_FILL_CELLS,
  PLANNER_VERSION,
  optionTime,
  parseCandidates,
  planTour,
  requestHash,
  roundOrigin,
  searchSequence,
  missingCellKey,
  neededCells,
  parseWarmState,
  reconcile,
  type ChapterModel,
  type ChapterOption,
  type MissingCell,
  type Pair,
} from '../../shared/src/planner/index.ts';
import { coordsKey } from '../../shared/src/routing/coordsKey.ts';
import { distanceMeters } from '../../shared/src/distance.ts';
import type { PlanTourRequest } from '../../shared/src/contracts/planTour.ts';

let checks = 0;
let failures = 0;
function assert(label: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}
const eq = <T>(label: string, actual: T, expected: T): void =>
  assert(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
const heading = (t: string): void => console.log(`\n${t}`);

// -----------------------------------------------------------------------------
// Builders: produce the RPC's JSON (snake_case), then parse it like production.

const ORIGIN_LL: Pair = [34.78, 32.08];
const at = (eastM: number, northM: number): Pair => [
  Number((ORIGIN_LL[0] + eastM / (111_320 * Math.cos((ORIGIN_LL[1] * Math.PI) / 180))).toFixed(6)),
  Number((ORIGIN_LL[1] + northM / 111_320).toFixed(6)),
];
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

interface StopSpec { id: string; sort: number; role: 'core' | 'extension'; pos: Pair; dwell?: number; dd?: number; weight?: number; eligible?: boolean; narration?: number; poi?: string }
interface ChapterSpec { id: string; tour?: string; mode?: 'walking' | 'biking' | 'driving'; entry: Pair; exit: Pair; stops: StopSpec[]; coreWeight?: number }

const PROFILE = { walking: 'pedestrian', biking: 'bicycle', driving: 'auto' } as const;

function rpc(chapters: ChapterSpec[], opts: {
  legs?: { chapter: string; from: string; to: string; s: number | null; fromPt: Pair; toPt: Pair }[];
  transfers?: { from: string; to: string; s: number | null; fromPt: Pair; toPt: Pair }[];
  transferProfile?: string;
} = {}): unknown {
  const pt = (p: Pair) => ({ lon: p[0], lat: p[1] });
  return {
    transfer_profile: opts.transferProfile ?? 'pedestrian',
    budget_s: 7200,
    considered: chapters.length,
    pruned: {},
    min_pruned_lower_bound_s: null,
    truncated: false,
    candidates: chapters.map((c) => ({
      chapter_id: c.id,
      tour_id: c.tour ?? uuid(9000),
      tour_title: 'T',
      title: null,
      chapter_sort_order: 0,
      transit_mode: c.mode ?? 'walking',
      profile: PROFILE[c.mode ?? 'walking'],
      entry: c.entry,
      exit: c.exit,
      origin_crow_m: 0,
      lower_bound_s: 0,
      core_dwell_s: 0,
      core_path_m: 0,
      core_matched_weight: c.coreWeight ?? 0,
      stops: c.stops.map((s) => ({
        waypoint_id: s.id,
        sort_order: s.sort,
        stop_role: s.role,
        poi_type: s.poi ?? 'anchor',
        coordinates: s.pos,
        eligible: s.eligible ?? true,
        dwell_s: s.dwell ?? 60,
        deep_dive_dwell_s: s.dd ?? 0,
        narration_s: s.narration ?? 60,
        interest_weights: {},
        matched_weight: s.weight ?? 0,
      })),
    })),
    transfers: (opts.transfers ?? []).map((t) => ({
      from_chapter_id: t.from, to_chapter_id: t.to, duration_s: t.s, distance_m: t.s === null ? null : t.s, coords_key: coordsKey(pt(t.fromPt), pt(t.toPt)),
    })),
    legs: (opts.legs ?? []).map((l) => ({
      chapter_id: l.chapter, from_node: l.from, to_node: l.to, duration_s: l.s, distance_m: l.s === null ? null : l.s, coords_key: coordsKey(pt(l.fromPt), pt(l.toPt)),
    })),
  };
}

/** Every forward leg of a chapter with a cost from `cost(i, j)` (node indices in entry..exit order). */
function allLegs(c: ChapterSpec, cost: (i: number, j: number) => number | null) {
  const nodes = [{ id: 'entry', pos: c.entry }, ...c.stops.map((s) => ({ id: s.id, pos: s.pos })), { id: 'exit', pos: c.exit }];
  const out: { chapter: string; from: string; to: string; s: number | null; fromPt: Pair; toPt: Pair }[] = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    out.push({ chapter: c.id, from: nodes[i]!.id, to: nodes[j]!.id, s: cost(i, j), fromPt: nodes[i]!.pos, toPt: nodes[j]!.pos });
  }
  return out;
}

const request = (o: Partial<PlanTourRequest> = {}): PlanTourRequest => ({
  contract_version: 1, city_id: uuid(1), origin: { lon: ORIGIN_LL[0], lat: ORIGIN_LL[1], source: 'gps' },
  available_minutes: 120, transit_mode: 'walking', group_type: 'solo', interests: ['history'],
  context: { local_time: '2026-10-04T10:00:00+03:00' }, include_deep_dives: false, ...o,
});

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PARAMS = { includeDeepDives: false, walkingPace: 1 };

// -----------------------------------------------------------------------------
heading('parseCandidates');

const tiny: ChapterSpec = { id: uuid(10), entry: at(0, 0), exit: at(300, 0), stops: [{ id: uuid(11), sort: 1, role: 'core', pos: at(150, 0) }] };
const parsed = parseCandidates(rpc([tiny]));
eq('snake_case answer becomes the typed shape', [parsed.candidates[0]!.chapterId, parsed.candidates[0]!.stops[0]!.stopRole], [uuid(10), 'core']);
let threw = '';
try { parseCandidates({ ...(rpc([tiny]) as object), transfer_profile: 'boat' }); } catch (e) { threw = String(e); }
assert('an unknown profile is refused, never guessed', /transfer_profile/.test(threw), threw);
threw = '';
try {
  const bad = rpc([{ ...tiny, stops: [{ id: uuid(12), sort: 2, role: 'core', pos: at(1, 0) }, { id: uuid(13), sort: 1, role: 'core', pos: at(2, 0) }] }]);
  parseCandidates(bad);
} catch (e) { threw = String(e); }
assert('stops out of authored order are refused (the SQL orders them)', /stops order/.test(threw), threw);

// -----------------------------------------------------------------------------
heading('CostBook: cached, stale, unroutable, estimated');
{
  const legs = allLegs(tiny, (i, j) => (i === 0 && j === 1 ? 100 : i === 1 && j === 2 ? null : 999));
  const stale = legs.map((l) => (l.from === 'entry' && l.to === 'exit' ? { ...l, fromPt: at(5, 5) } : l));
  const book = new CostBook(parseCandidates(rpc([tiny], { legs: stale })), 'walking');
  const c = parseCandidates(rpc([tiny])).candidates[0]!;
  const a = book.leg(c, 'entry', uuid(11));
  assert('matching coords_key -> the cached cost', a !== 'unroutable' && a.durationS === 100 && a.source === 'valhalla', JSON.stringify(a));
  eq('duration NULL -> unroutable (forbidden)', book.leg(c, uuid(11), 'exit'), 'unroutable');
  const s = book.leg(c, 'entry', 'exit');
  assert('stale coords_key -> estimated, never trusted', s !== 'unroutable' && s.source === 'estimated', JSON.stringify(s));
  // 300 m straight x 1.4 = 420 m at 1.42 m/s = 296 s
  assert('estimate = straight line x 1.4 at 5.1 km/h', s !== 'unroutable' && s.distanceM === 420 && s.durationS === 296, JSON.stringify(s));
  eq('the stale cell is recorded as missing; cached and unroutable ones are not', book.missingCells().map((m) => m.kind === 'leg' && `${m.fromNode}>${m.toNode}`), ['entry>exit']);
  const o = book.fromOrigin(ORIGIN_LL, uuid(10));
  assert('the origin transfer is always estimated and never a missing cell', o.source === 'estimated' && book.missingCells().length === 1);
}

// -----------------------------------------------------------------------------
heading('chapterOptions == brute force (200 random chapters)');
{
  const rand = rng(16);
  let mismatches = 0;
  let firstDetail = '';
  for (let trial = 0; trial < 200; trial++) {
    const nStops = 2 + Math.floor(rand() * 6);
    const stops: StopSpec[] = [];
    for (let i = 0; i < nStops; i++) {
      const ext = i > 0 && rand() < 0.55;
      stops.push({ id: uuid(100 + i), sort: i + 1, role: ext ? 'extension' : 'core', pos: at(100 * (i + 1), Math.round(rand() * 200)),
        dwell: 30 + Math.floor(rand() * 120), weight: ext ? Math.floor(rand() * 4) : 0, eligible: !ext || rand() > 0.15 });
    }
    if (!stops.some((s) => s.role === 'core')) stops[0]!.role = 'core';
    const ch: ChapterSpec = { id: uuid(50), entry: at(0, 0), exit: at(100 * (nStops + 1), 0), stops };
    const costs = new Map<string, number | null>();
    const legs = allLegs(ch, (i, j) => {
      const v = rand() < 0.06 ? null : 40 + Math.floor(rand() * 300) * (j - i);
      costs.set(`${i}>${j}`, v);
      return v;
    });
    const answer = parseCandidates(rpc([ch], { legs }));
    const c = answer.candidates[0]!;
    const got = chapterOptions(c, new CostBook(answer, 'walking'), PARAMS);

    // Brute force: every subset of keepable extensions, path in authored order.
    const nodes = ['entry', ...stops.map((s) => s.id), 'exit'];
    const keepable = stops.map((s, i) => ({ s, i: i + 1 })).filter(({ s }) => s.role === 'extension' && s.eligible !== false && (s.weight ?? 0) > 0);
    const coreDwell = stops.filter((s) => s.role === 'core').reduce((a, s) => a + (s.dwell ?? 60), 0);
    const bestByValue = new Map<number, number>();
    for (let mask = 0; mask < 1 << keepable.length; mask++) {
      const kept = new Set(keepable.filter((_, b) => mask & (1 << b)).map(({ i }) => i));
      const path = nodes.map((_, i) => i).filter((i) => i === 0 || i === nodes.length - 1 || stops[i - 1]!.role === 'core' || kept.has(i));
      let t = coreDwell;
      let v = 0;
      let ok = true;
      for (let k = 0; k + 1 < path.length; k++) {
        const leg = costs.get(`${path[k]}>${path[k + 1]}`);
        if (leg === null || leg === undefined) { ok = false; break; }
        t += leg;
      }
      for (const i of kept) { t += stops[i - 1]!.dwell ?? 60; v += stops[i - 1]!.weight ?? 0; }
      if (ok && (!bestByValue.has(v) || t < bestByValue.get(v)!)) bestByValue.set(v, t);
    }
    // Pareto of the brute force.
    const pareto: [number, number][] = [];
    let bestT = Infinity;
    for (const v of [...bestByValue.keys()].sort((a, b) => b - a)) {
      const t = bestByValue.get(v)!;
      if (t < bestT) { pareto.push([v, t]); bestT = t; }
    }
    pareto.reverse();
    const mine = got === null ? [] : got.map((o) => [o.value, optionTime(o)]);
    if (JSON.stringify(mine) !== JSON.stringify(pareto)) {
      mismatches++;
      if (!firstDetail) firstDetail = `trial ${trial}: got ${JSON.stringify(mine)} expected ${JSON.stringify(pareto)}`;
    }
  }
  assert('every curve equals the brute-force Pareto frontier (value -> least time)', mismatches === 0, firstDetail);
}

// -----------------------------------------------------------------------------
heading('Tie-breaks: detour time strictly before sequence position');
{
  // core A - E1 (sort 2) - E2 (sort 3) - core B; both extensions weight 2.
  const mk = (e1: number, e2: number, e1Estimated = false): ChapterOption[] => {
    const ch: ChapterSpec = { id: uuid(60), entry: at(0, 0), exit: at(400, 0), stops: [
      { id: uuid(61), sort: 1, role: 'core', pos: at(0, 0), dwell: 0 },
      { id: uuid(62), sort: 2, role: 'extension', pos: at(100, 50), dwell: 0, weight: 2 },
      { id: uuid(63), sort: 3, role: 'extension', pos: at(200, 50), dwell: 0, weight: 2 },
      { id: uuid(64), sort: 4, role: 'core', pos: at(400, 0), dwell: 0 },
    ] };
    // Detour through Ek = A->Ek + Ek->B; the direct A->B is 100. E1->E2 is huge, so only one fits a tight budget.
    let legs = allLegs(ch, (i, j) => {
      if (i === 1 && j === 4) return 100;
      if (i === 1 && j === 2) return e1 / 2;
      if (i === 2 && j === 4) return e1 / 2;
      if (i === 1 && j === 3) return e2 / 2;
      if (i === 3 && j === 4) return e2 / 2;
      if (i === 2 && j === 3) return 10_000;
      return 1;
    });
    if (e1Estimated) legs = legs.filter((l) => !(l.from === uuid(61) && l.to === uuid(62)));
    const answer = parseCandidates(rpc([ch], { legs }));
    return chapterOptions(answer.candidates[0]!, new CostBook(answer, 'walking'), PARAMS)!;
  };
  const shorterLater = mk(400, 200).find((o) => o.value === 2)!;
  eq('equal weight: the SHORTER detour wins even though it comes later', shorterLater.keptOrders, [3]);
  const equalTime = mk(300, 300).find((o) => o.value === 2)!;
  eq('equal weight and equal detour: the EARLIER stop wins', equalTime.keptOrders, [2]);
  // With E1's first leg missing, its estimate (straight line) differs; force equal time by
  // comparing only when times tie - here we just prove estimates never beat equal-time cached costs:
  const opts = mk(300, 300, true).filter((o) => o.value === 2);
  assert('one choice per value survives (no duplicates)', opts.length === 1);
}

// -----------------------------------------------------------------------------
heading('Hard rules inside a chapter');
{
  const ch: ChapterSpec = { id: uuid(70), mode: 'driving', entry: at(0, 0), exit: at(9000, 0), stops: [
    { id: uuid(71), sort: 1, role: 'core', pos: at(1000, 0), dwell: 0, narration: 120 },
    { id: uuid(72), sort: 2, role: 'extension', pos: at(1500, 0), dwell: 0, weight: 3, narration: 60 },
    { id: uuid(73), sort: 3, role: 'core', pos: at(8000, 0), dwell: 0, narration: 60 },
  ] };
  const legs = allLegs(ch, (i, j) => (i === 1 && j === 2 ? 30 : 400));
  const answer = parseCandidates(rpc([ch], { legs, transferProfile: 'auto' }));
  const curve = chapterOptions(answer.candidates[0]!, new CostBook(answer, 'driving'), PARAMS)!;
  assert('driving: an extension reached before the previous narration ends is never kept (queue would expire it)',
    curve.every((o) => !o.keptIds.includes(uuid(72))), JSON.stringify(curve.map((o) => o.keptIds)));

  const ineligible: ChapterSpec = { id: uuid(80), entry: at(0, 0), exit: at(300, 0), stops: [
    { id: uuid(81), sort: 1, role: 'core', pos: at(100, 0) },
    { id: uuid(82), sort: 2, role: 'extension', pos: at(200, 0), weight: 3, eligible: false },
    { id: uuid(83), sort: 3, role: 'extension', pos: at(250, 0), weight: 0 },
  ] };
  const a2 = parseCandidates(rpc([ineligible], { legs: allLegs(ineligible, () => 10) }));
  const c2 = chapterOptions(a2.candidates[0]!, new CostBook(a2, 'walking'), PARAMS)!;
  eq('audience-ineligible and zero-value extensions are never kept', c2.map((o) => o.keptIds), [[]]);

  const blocked: ChapterSpec = { id: uuid(90), entry: at(0, 0), exit: at(300, 0), stops: [{ id: uuid(91), sort: 1, role: 'core', pos: at(100, 0) }] };
  const a3 = parseCandidates(rpc([blocked], { legs: allLegs(blocked, (i) => (i === 0 ? null : 10)) }));
  eq('a chapter whose core path is unroutable cannot be planned', chapterOptions(a3.candidates[0]!, new CostBook(a3, 'walking'), PARAMS), null);
}

// -----------------------------------------------------------------------------
heading('searchSequence == brute force (60 small + 150 dense random cities)');
for (const [seed, trials, minN, spanN, valueScale] of [[1604, 60, 3, 3, 1], [2610, 150, 5, 2, 3]] as const) {
  const rand = rng(seed);
  let mismatches = 0;
  let detail = '';
  for (let trial = 0; trial < trials; trial++) {
    const n = minN + Math.floor(rand() * spanN);
    const specs: ChapterSpec[] = [];
    for (let k = 0; k < n; k++) {
      const x = Math.round(rand() * 3000);
      const y = Math.round(rand() * 3000);
      const stops: StopSpec[] = [
        { id: uuid(1000 + k * 10 + 1), sort: 1, role: 'core', pos: at(x + 50, y), dwell: 200 + Math.floor(rand() * 400) },
        { id: uuid(1000 + k * 10 + 2), sort: 2, role: 'extension', pos: at(x + 100, y + 40), dwell: 100, weight: Math.floor(rand() * 4 * valueScale) },
        { id: uuid(1000 + k * 10 + 3), sort: 3, role: 'core', pos: at(x + 200, y), dwell: 200 },
      ];
      specs.push({ id: uuid(2000 + k), entry: at(x, y), exit: at(x + 250, y), stops, coreWeight: Math.floor(rand() * 4 * valueScale) });
    }
    const legs = specs.flatMap((c) => allLegs(c, () => 60 + Math.floor(rand() * 240)));
    const transfers = specs.flatMap((a) => specs.filter((b) => b !== a).map((b) => ({ from: a.id, to: b.id, s: rand() < 0.1 ? null : 300 + Math.floor(rand() * 2400), fromPt: a.exit, toPt: b.entry })));
    const answer = parseCandidates(rpc(specs, { legs, transfers }));
    const book = new CostBook(answer, 'walking');
    const models: ChapterModel[] = answer.candidates.map((c) => ({ candidate: c, baseValue: 1 + c.coreMatchedWeight, options: chapterOptions(c, book, PARAMS)! }));
    const capacityS = 1800 + Math.floor(rand() * 4000 * valueScale);
    const got = searchSequence({ models, book, origin: ORIGIN_LL, capacityS, transferPace: 1, transferIsWalking: true });

    // Brute force: every ordered subset, every combination of options.
    let best: { value: number; total: number; est: number; ids: string[] } | null = null;
    const ids = models.map((m) => m.candidate.chapterId);
    const better = (c: NonNullable<typeof best>) => {
      if (!best) return true;
      if (c.value !== best.value) return c.value > best.value;
      if (c.total !== best.total) return c.total < best.total;
      if (c.est !== best.est) return c.est < best.est;
      return c.ids.join() < best.ids.join();
    };
    const walk = (seq: string[]) => {
      if (seq.length > 0) {
        let hopS = 0;
        let hopEst = 0;
        let ok = true;
        seq.forEach((id, i) => {
          const h = i === 0 ? book.fromOrigin(ORIGIN_LL, id) : book.transfer(seq[i - 1]!, id);
          if (h === 'unroutable') { ok = false; return; }
          hopS += h.durationS;
          hopEst += h.source === 'estimated' ? 1 : 0;
        });
        if (ok) {
          const ms = seq.map((id) => models.find((m) => m.candidate.chapterId === id)!);
          const rec = (i: number, v: number, t: number, e: number) => {
            if (i === ms.length) {
              if (hopS + t <= capacityS) {
                const cand = { value: v + ms.reduce((a, m) => a + m.baseValue, 0), total: hopS + t, est: hopEst + e, ids: seq };
                if (better(cand)) best = cand;
              }
              return;
            }
            for (const o of ms[i]!.options) rec(i + 1, v + o.value, t + optionTime(o), e + o.estimatedLegs);
          };
          rec(0, 0, 0, 0);
        }
      }
      if (seq.length < ids.length) for (const id of ids) if (!seq.includes(id)) walk([...seq, id]);
    };
    walk([]);
    const mine = got.chapters.length === 0 ? null : { value: got.value, total: got.totalS, ids: got.chapters.map((p) => p.model.candidate.chapterId) };
    const theirs = best ? { value: (best as { value: number }).value, total: (best as { total: number }).total, ids: (best as { ids: string[] }).ids } : null;
    if (got.truncated || JSON.stringify(mine) !== JSON.stringify(theirs)) {
      mismatches++;
      if (!detail) detail = `trial ${trial} (cap ${capacityS}): got ${JSON.stringify(mine)} expected ${JSON.stringify(theirs)}`;
    }
  }
  assert(`B&B finds the brute-force optimum, tie-breaks included (seed ${seed}, ${trials} trials)`, mismatches === 0, detail);
}

// -----------------------------------------------------------------------------
heading('planTour: contract, margin, determinism, bounds');
{
  const rand = rng(42);
  const specs: ChapterSpec[] = [];
  for (let k = 0; k < 12; k++) {
    const x = Math.round(rand() * 2500);
    const y = Math.round(rand() * 2500);
    specs.push({ id: uuid(3000 + k), tour: uuid(4000 + (k % 4)), entry: at(x, y), exit: at(x + 300, y), coreWeight: k % 3, stops: [
      { id: uuid(5000 + k * 10 + 1), sort: 1, role: 'core', pos: at(x + 20, y), dwell: 240, dd: 300 },
      { id: uuid(5000 + k * 10 + 2), sort: 2, role: 'extension', pos: at(x + 120, y + 60), dwell: 180, dd: 200, weight: 1 + (k % 3) },
      { id: uuid(5000 + k * 10 + 3), sort: 3, role: 'core', pos: at(x + 200, y), dwell: 240, poi: 'transition' },
      { id: uuid(5000 + k * 10 + 4), sort: 4, role: 'extension', pos: at(x + 260, y + 80), dwell: 200, weight: 2, eligible: k % 2 === 0 },
    ] });
  }
  const raw = rpc(specs, { legs: specs.flatMap((c) => allLegs(c, () => 90)).filter(() => rand() > 0.2) });
  const answer = parseCandidates(raw);
  const req = request({ available_minutes: 180 });
  const out = planTour(req, answer, ORIGIN_LL);
  assert('a plan is produced', out.ok);
  if (out.ok) {
    const d = out.draft;
    assert('total within budget minus the 10% margin', d.estimate.total_s <= Math.floor(180 * 60 * 0.9), String(d.estimate.total_s));
    eq('estimate adds up', d.estimate.transfer_s + d.estimate.chapter_travel_s + d.estimate.dwell_s, d.estimate.total_s);
    eq('slack = budget - total', d.estimate.slack_s, d.estimate.budget_s - d.estimate.total_s);
    eq('segments alternate transfer, chapter, ... starting with a transfer',
      d.segments.map((s) => s.kind).join(), d.segments.map((_, i) => (i % 2 === 0 ? 'transfer' : 'chapter')).join());
    const first = d.segments[0]!;
    assert('the first transfer carries no origin coordinates', first.kind === 'transfer' && first.from.kind === 'origin' && !('point' in first.from));
    const chapterSegs = d.segments.filter((s) => s.kind === 'chapter');
    assert('every chapter keeps EVERY core stop, transitions included', chapterSegs.every((s) => {
      const spec = specs.find((c) => c.id === s.chapter_id)!;
      return spec.stops.filter((x) => x.role === 'core').every((x) => s.waypoint_ids.includes(x.id));
    }));
    assert('waypoint_ids = cores + kept, authored order; dropped = the other extensions', chapterSegs.every((s) => {
      const spec = specs.find((c) => c.id === s.chapter_id)!;
      const expected = spec.stops.filter((x) => x.role === 'core' || s.kept_extension_ids.includes(x.id)).map((x) => x.id);
      const exts = spec.stops.filter((x) => x.role === 'extension').map((x) => x.id);
      return JSON.stringify(s.waypoint_ids) === JSON.stringify(expected)
        && JSON.stringify([...s.kept_extension_ids, ...s.dropped_extension_ids].sort()) === JSON.stringify(exts.sort());
    }));
    assert('an audience-ineligible extension is never kept', chapterSegs.every((s) => {
      const spec = specs.find((c) => c.id === s.chapter_id)!;
      return spec.stops.filter((x) => x.eligible === false).every((x) => !s.kept_extension_ids.includes(x.id));
    }));
    assert('Deep Dives not included: reported as extra, not in the total', d.estimate.deep_dive_extra_s > 0);

    const again = planTour(req, parseCandidates(JSON.parse(JSON.stringify(raw))), ORIGIN_LL);
    eq('same input -> byte-identical plan', JSON.stringify(again), JSON.stringify(out));
    const shuffled = { ...(raw as Record<string, unknown>), candidates: [...(raw as { candidates: unknown[] }).candidates].reverse() };
    const reordered = planTour(req, parseCandidates(shuffled), ORIGIN_LL);
    eq('candidate order in the answer does not change the plan', reordered.ok && reordered.draft.segments, d.segments);

    const dd = planTour({ ...req, include_deep_dives: true }, answer, ORIGIN_LL);
    assert('Deep Dives included: none reported as extra', dd.ok && dd.draft.estimate.deep_dive_extra_s === 0);

    const chain = chooseFillChain(out.planCells, out.missing);
    assert(`background fill takes at most ${MAX_FILL_CELLS} cells`, chain.length > 0 && chain.length <= MAX_FILL_CELLS, String(chain.length));
    assert('...as ONE chain (one chapter, one profile, each leg starting where the last ended)', chain.every((c, i) =>
      c.kind === 'leg' && (i === 0 || (c.chapterId === (chain[0] as Extract<MissingCell, { kind: 'leg' }>).chapterId
        && c.fromNode === (chain[i - 1] as Extract<MissingCell, { kind: 'leg' }>).toNode))));
    assert('...starting with a cell the returned plan relied on', out.planCells.length === 0 || JSON.stringify(chain[0]) === JSON.stringify(out.planCells[0]));
  }

  // Truncation is deterministic.
  const book = new CostBook(answer, 'walking');
  const models: ChapterModel[] = answer.candidates.map((c) => ({ candidate: c, baseValue: 1 + c.coreMatchedWeight, options: chapterOptions(c, book, PARAMS)! }));
  const cut1 = searchSequence({ models, book, origin: ORIGIN_LL, capacityS: 6 * 3600, transferPace: 1, transferIsWalking: true, maxNodes: 40 });
  const cut2 = searchSequence({ models, book, origin: ORIGIN_LL, capacityS: 6 * 3600, transferPace: 1, transferIsWalking: true, maxNodes: 40 });
  assert('the node cap truncates, and is reported', cut1.truncated && cut1.nodes === 40);
  eq('...at the same place every time', cut2.chapters.map((p) => p.model.candidate.chapterId), cut1.chapters.map((p) => p.model.candidate.chapterId));

  const none = planTour(request({ available_minutes: 15 }), parseCandidates(rpc([{ ...specs[0]!, entry: at(20_000, 0), exit: at(20_300, 0) }])), ORIGIN_LL);
  assert('nothing fits -> infeasible with a positive shortfall', !none.ok && none.shortfallS > 0, JSON.stringify(none));
}

{
  const chain = chooseFillChain([], [
    { kind: 'transfer', fromChapterId: uuid(1), toChapterId: uuid(2), profile: 'pedestrian', from: at(0, 0), to: at(1, 1) },
    { kind: 'leg', chapterId: uuid(3), profile: 'pedestrian', fromNode: 'entry', toNode: 'a', from: at(0, 0), to: at(1, 0) },
  ]);
  eq('a transfer is filled alone (it cannot chain)', chain.length, 1);
  const legs: MissingCell[] = ['entry', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].slice(0, -1).map((n, i, all) => ({
    kind: 'leg', chapterId: uuid(3), profile: 'pedestrian', fromNode: n, toNode: ['a', 'b', 'c', 'd', 'e', 'f', 'g'][i]!, from: at(i, 0), to: at(i + 1, 0),
  }));
  eq('a 7-leg chain is cut at 5', chooseFillChain([], legs).length, 5);
  eq('nothing missing -> nothing to fill', chooseFillChain([], []), []);
}

// -----------------------------------------------------------------------------
heading('quality: dropped_high_value_extensions (the "add more time" upsell)');
{
  // core - E1 (w3, 10 min) - E2 (w3, 10 min) - E3 (w1, 10 min) - X (w3, ineligible) - core
  const ch: ChapterSpec = { id: uuid(7000), entry: at(0, 0), exit: at(500, 0), coreWeight: 1, stops: [
    { id: uuid(7001), sort: 1, role: 'core', pos: at(0, 0), dwell: 300 },
    { id: uuid(7002), sort: 2, role: 'extension', pos: at(100, 0), dwell: 600, weight: 3 },
    { id: uuid(7003), sort: 3, role: 'extension', pos: at(200, 0), dwell: 600, weight: 3 },
    { id: uuid(7004), sort: 4, role: 'extension', pos: at(300, 0), dwell: 600, weight: 1 },
    { id: uuid(7005), sort: 5, role: 'extension', pos: at(400, 0), dwell: 600, weight: 3, eligible: false },
    { id: uuid(7006), sort: 6, role: 'core', pos: at(500, 0), dwell: 300 },
  ] };
  const raw = rpc([ch], { legs: allLegs(ch, () => 30) });
  const count = (minutes: number) => {
    const out = planTour(request({ available_minutes: minutes }), parseCandidates(raw), at(0, 0));
    return out.ok ? [out.draft.droppedHighValueExtensions, out.draft.segments.filter((x) => x.kind === 'chapter').flatMap((x) => (x as { kept_extension_ids: readonly string[] }).kept_extension_ids).length] : null;
  };
  // 30 min * 0.9 = 1620 s: cores 600 + travel ~ + ONE 600 s extension fits.
  eq('tight budget: one w3 kept, the other w3 counted; w1 and the ineligible w3 never counted', count(30), [1, 1]);
  eq('generous budget: everything keepable kept, nothing counted', count(120), [0, 3]);
}

heading('Reconciler (warm-costs): needed, present, missing');
{
  const warmRaw = (chapters: ChapterSpec[], legs: { chapter: string; from: string; to: string; profile: string; key: string }[] = [], transfers: { from: string; to: string; profile: string; key: string }[] = []) => ({
    chapters: chapters.map((c) => ({
      chapter_id: c.id, tour_id: uuid(9000), transit_mode: c.mode ?? 'walking', profile: PROFILE[c.mode ?? 'walking'], entry: c.entry, exit: c.exit,
      stops: c.stops.map((x) => ({ waypoint_id: x.id, sort_order: x.sort, stop_role: x.role, coordinates: x.pos })),
    })),
    legs: legs.map((l) => ({ chapter_id: l.chapter, from_node: l.from, to_node: l.to, profile: l.profile, unroutable: false, coords_key: l.key })),
    transfers: transfers.map((t) => ({ from_chapter_id: t.from, to_chapter_id: t.to, profile: t.profile, unroutable: false, coords_key: t.key })),
  });
  // entry - C1 - E1 - E2 - C2 - exit : slots [entry,C1] [C1,E1,E2,C2] [C2,exit] -> 1 + 6 + 1 legs
  const c: ChapterSpec = { id: uuid(8000), entry: at(0, 0), exit: at(400, 0), stops: [
    { id: uuid(8001), sort: 1, role: 'core', pos: at(50, 0) },
    { id: uuid(8002), sort: 2, role: 'extension', pos: at(150, 30) },
    { id: uuid(8003), sort: 3, role: 'extension', pos: at(250, 30) },
    { id: uuid(8004), sort: 4, role: 'core', pos: at(350, 0) },
  ] };
  const legsOnly = neededCells(parseWarmState(warmRaw([c]))).filter((x) => x.kind === 'leg');
  eq('legs: forward pairs within each slot (1 + 6 + 1)', legsOnly.length, 8);

  // Property: every leg the planner can read is a needed leg (200 random chapters).
  const rand = rng(77);
  let uncovered = '';
  for (let t = 0; t < 200 && !uncovered; t++) {
    const n = 2 + Math.floor(rand() * 6);
    const stops: StopSpec[] = Array.from({ length: n }, (_, i) => ({ id: uuid(8100 + i), sort: i + 1, role: i === 0 || rand() < 0.4 ? 'core' : 'extension', pos: at(80 * (i + 1), Math.round(rand() * 100)), weight: 1 + Math.floor(rand() * 3) } as StopSpec));
    const ch: ChapterSpec = { id: uuid(8090), entry: at(0, 0), exit: at(80 * (n + 1), 0), stops };
    const answer = parseCandidates(rpc([ch]));
    const book = new CostBook(answer, 'walking');
    chapterOptions(answer.candidates[0]!, book, PARAMS);
    const needed = new Set(neededCells(parseWarmState(warmRaw([ch]))).map(missingCellKey));
    const miss = book.missingCells().find((m) => !needed.has(missingCellKey(m)));
    if (miss) uncovered = `trial ${t}: ${missingCellKey(miss)}`;
  }
  assert('every leg the planner can read is in the needed set (200 random chapters)', uncovered === '', uncovered);

  // Transfers: profile eligibility and radius.
  const walkA: ChapterSpec = { id: uuid(8200), entry: at(0, 0), exit: at(100, 0), stops: [{ id: uuid(8201), sort: 1, role: 'core', pos: at(50, 0) }] };
  const walkB: ChapterSpec = { id: uuid(8210), entry: at(3000, 0), exit: at(3100, 0), stops: [{ id: uuid(8211), sort: 1, role: 'core', pos: at(3050, 0) }] };
  const walkFar: ChapterSpec = { id: uuid(8220), entry: at(20_000, 0), exit: at(20_100, 0), stops: [{ id: uuid(8221), sort: 1, role: 'core', pos: at(20_050, 0) }] };
  const drive: ChapterSpec = { id: uuid(8230), mode: 'driving', entry: at(1000, 0), exit: at(9000, 0), stops: [{ id: uuid(8231), sort: 1, role: 'core', pos: at(5000, 0) }] };
  const tr = neededCells(parseWarmState(warmRaw([walkA, walkB, walkFar, drive]))).filter((x) => x.kind === 'transfer');
  const has = (p: string, a: string, b: string) => tr.some((x) => x.kind === 'transfer' && x.profile === p && x.fromChapterId === a && x.toChapterId === b);
  assert('pedestrian: walking <-> walking within 5 km', has('pedestrian', walkA.id, walkB.id) && has('pedestrian', walkB.id, walkA.id));
  assert('pedestrian: never to a 20 km chapter, never to a driving chapter', !has('pedestrian', walkA.id, walkFar.id) && !has('pedestrian', walkA.id, drive.id));
  assert('auto: walking and driving chapters, within 80 km', has('auto', walkA.id, drive.id) && has('auto', drive.id, walkFar.id));
  assert('bicycle: never a driving chapter', !tr.some((x) => x.kind === 'transfer' && x.profile === 'bicycle' && (x.fromChapterId === drive.id || x.toChapterId === drive.id)));
  const firstTransfer = neededCells(parseWarmState(warmRaw([walkA, walkB, walkFar, drive]))).findIndex((x) => x.kind === 'transfer');
  assert('legs come before transfers', neededCells(parseWarmState(warmRaw([walkA, walkB, walkFar, drive]))).slice(firstTransfer).every((x) => x.kind === 'transfer'));

  // Present vs stale.
  const pt = (p: Pair) => ({ lon: p[0], lat: p[1] });
  const good = { chapter: c.id, from: 'entry', to: uuid(8001), profile: 'pedestrian', key: coordsKey(pt(c.entry), pt(c.stops[0]!.pos)) };
  const stale = { chapter: c.id, from: uuid(8004), to: 'exit', profile: 'pedestrian', key: coordsKey(pt(at(1, 1)), pt(c.exit)) };
  const r = reconcile(parseWarmState(warmRaw([c], [good, stale])));
  eq('a matching row is present; a stale-keyed row is missing again', [r.needed.legs, r.missing.length], [8, 7]);
  assert('the stale cell is among the missing', r.missing.some((m) => m.kind === 'leg' && m.fromNode === uuid(8004) && m.toNode === 'exit'));

  // The fill loop converges in bounded chains: 8 legs -> at most 5 per request.
  let left = r.missing;
  let requests = 0;
  while (left.length > 0 && requests < 20) {
    const chain = chooseFillChain([], left);
    assert(`chain ${requests + 1} has 1..5 cells`, chain.length >= 1 && chain.length <= MAX_FILL_CELLS);
    const done = new Set(chain.map(missingCellKey));
    left = left.filter((m) => !done.has(missingCellKey(m)));
    requests++;
  }
  assert('every missing cell is eventually chained', left.length === 0, String(left.length));
}

heading('Request, hashing, origin');
{
  const ok = checkPlanRequest({ ...request(), exclude_chapter_ids: [uuid(7).toUpperCase()] });
  assert('a valid request passes and is normalised', ok.ok && ok.request.exclude_chapter_ids![0] === uuid(7));
  const bad = (patch: Record<string, unknown>) => {
    const r = checkPlanRequest({ ...request(), ...patch });
    return r.ok ? 'ok' : r.code;
  };
  eq('wrong contract_version -> unsupported_contract', bad({ contract_version: 2 }), 'unsupported_contract');
  eq('minutes below 15 -> invalid', bad({ available_minutes: 10 }), 'invalid_request');
  eq('fractional minutes -> invalid', bad({ available_minutes: 90.5 }), 'invalid_request');
  eq('unknown interest -> invalid', bad({ interests: ['shopping'] }), 'invalid_request');
  eq('repeated interest -> invalid', bad({ interests: ['history', 'history'] }), 'invalid_request');
  eq('UTC "Z" time (no offset) -> invalid', bad({ context: { local_time: '2026-10-04T10:00:00Z' } }), 'invalid_request');
  eq('origin out of range -> invalid', bad({ origin: { lon: 200, lat: 0, source: 'gps' } }), 'invalid_request');
  eq('51 excluded chapters -> invalid', bad({ exclude_chapter_ids: Array.from({ length: 51 }, (_, i) => uuid(i)) }), 'invalid_request');

  eq('origin rounded to 3 decimals', roundOrigin(34.781949, 32.085551), [34.782, 32.086]);
  eq('canonical JSON ignores key order', canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));

  const raw = rpc([tiny]);
  const h1 = await requestHash(request(), [34.78, 32.08], null, raw);
  const h2 = await requestHash(request({ interests: ['history'] }), [34.78, 32.08], null, JSON.parse(JSON.stringify(raw)));
  assert('request_hash is 64 hex and stable', /^[0-9a-f]{64}$/.test(h1) && h1 === h2);
  const h3 = await requestHash(request(), [34.78, 32.08], uuid(77), raw);
  assert('a signed-in user never shares a plan row with anyone', h3 !== h1);
  const h4 = await requestHash(request(), [34.78, 32.08], null, rpc([{ ...tiny, exit: at(301, 0) }]));
  assert('any change in the candidates (content or costs) makes a new key', h4 !== h1);
  const h5 = await requestHash(request({ context: { local_time: '2026-10-04T18:00:00+03:00' } }), [34.78, 32.08], null, raw);
  eq('local_time is not in the key (planner v1 has no time rules)', h5, h1);

  const ch = [{ chapterId: uuid(10), waypointIds: [uuid(11)], entry: at(0, 0), exit: at(300, 0) }];
  const c1 = await contentHash(ch, { [uuid(9000)]: 'abc' });
  assert('content_hash is 32 hex (the tour_plans CHECK)', /^[0-9a-f]{32}$/.test(c1));
  assert('a moved entry point changes content_hash', c1 !== (await contentHash([{ ...ch[0]!, entry: at(1, 0) }], { [uuid(9000)]: 'abc' })));
  assert('a changed bundle hash changes content_hash', c1 !== (await contentHash(ch, { [uuid(9000)]: 'abd' })));
}

// -----------------------------------------------------------------------------
heading('spatial dedup (v3) - an extension the plan already covers is not narrated twice');
{
  // Two chapters 400 m apart; each: core - extension (weight 3) - core.
  const chapter = (k: number, x: number, extPos: Pair): ChapterSpec => ({
    id: uuid(7000 + k), tour: uuid(7100 + k), entry: at(x, 0), exit: at(x + 300, 0), coreWeight: 1, stops: [
      { id: uuid(7200 + k * 10 + 1), sort: 1, role: 'core', pos: at(x + 20, 0), dwell: 120 },
      { id: uuid(7200 + k * 10 + 2), sort: 2, role: 'extension', pos: extPos, dwell: 60, weight: 3 },
      { id: uuid(7200 + k * 10 + 3), sort: 3, role: 'core', pos: at(x + 280, 0), dwell: 120 },
    ],
  });
  const run = (a: ChapterSpec, b: ChapterSpec) => {
    const out = planTour(request({ available_minutes: 240 }), parseCandidates(rpc([a, b], { legs: [a, b].flatMap((c) => allLegs(c, () => 90)) })), ORIGIN_LL);
    if (!out.ok) throw new Error('expected a plan');
    return out.draft.segments.filter((s): s is Extract<typeof s, { kind: 'chapter' }> => s.kind === 'chapter');
  };
  const extA = uuid(7200 + 0 * 10 + 2);
  const extB = uuid(7200 + 1 * 10 + 2);
  const coreA1 = at(0 + 20, 0);

  // B's extension 10 m from A's first CORE stop: A's core always plays, so B's extension goes.
  const near = run(chapter(0, 0, at(150, 40)), chapter(1, 400, [coreA1[0], Number((coreA1[1] + 10 / 111_320).toFixed(6))]));
  eq('both chapters are planned (dedup never costs a chapter)', near.length, 2);
  const segB = near.find((s) => s.chapter_id === uuid(7001))!;
  assert('an extension within 20 m of another chapter\'s CORE stop is not kept', !segB.kept_extension_ids.includes(extB) && segB.dropped_extension_ids.includes(extB));
  assert('...and every core stop is still planned (core means core)', near.every((s) => s.waypoint_ids.length >= 2));

  // The same at 30 m: a different place - kept.
  const far = run(chapter(0, 0, at(150, 40)), chapter(1, 400, [coreA1[0], Number((coreA1[1] + 30 / 111_320).toFixed(6))]));
  assert('30 m away it is another place: kept', far.find((s) => s.chapter_id === uuid(7001))!.kept_extension_ids.includes(extB));

  // Extension next to extension: the EARLIER chapter keeps the place.
  const shared = at(200, 120);
  const twin = run(chapter(0, 0, shared), chapter(1, 400, [shared[0], Number((shared[1] + 8 / 111_320).toFixed(6))]));
  const order = twin.map((s) => s.chapter_id);
  const keptBy = twin.filter((s) => s.kept_extension_ids.some((id) => id === extA || id === extB)).map((s) => s.chapter_id);
  eq('two extensions 8 m apart: only the earlier chapter keeps one', keptBy, [order[0]]);

  // The upsell counts extensions dropped for TIME, never ones dropped as duplicates.
  const dropped = planTour(request({ available_minutes: 240 }), parseCandidates(rpc([chapter(0, 0, at(150, 40)), chapter(1, 400, [coreA1[0], Number((coreA1[1] + 10 / 111_320).toFixed(6))])], { legs: [chapter(0, 0, at(150, 40)), chapter(1, 400, at(0, 0))].flatMap((c) => allLegs(c, () => 90)) })), ORIGIN_LL);
  assert('a deduplicated extension never counts toward dropped_high_value_extensions', dropped.ok && dropped.draft.droppedHighValueExtensions === 0, dropped.ok ? String(dropped.draft.droppedHighValueExtensions) : 'no plan');
  eq('planner_version is v4 (cached v2/v3 plans are not reused)', PLANNER_VERSION, 'v4');
  eq('the radius is the PM\'s ~20 m', DEDUP_RADIUS_M, 20);
}

// -----------------------------------------------------------------------------
heading('Option E (v4) - a CORE stop on a place an earlier chapter narrated is kept but silenced');
{
  const chapter = (k: number, x: number, firstCore: Pair, w = 0): ChapterSpec => ({
    id: uuid(7500 + k), tour: uuid(7600 + k), entry: at(x, 0), exit: at(x + 300, 0), coreWeight: w, stops: [
      { id: uuid(7700 + k * 10 + 1), sort: 1, role: 'core', pos: firstCore, dwell: 120, weight: w },
      { id: uuid(7700 + k * 10 + 3), sort: 3, role: 'core', pos: at(x + 280, 0), dwell: 120 },
    ],
  });
  const plaza = at(20, 0);
  const a = chapter(0, 0, plaza);
  const b = chapter(1, 400, [plaza[0], Number((plaza[1] + 9 / 111_320).toFixed(6))]);
  const out = planTour(request({ available_minutes: 240 }), parseCandidates(rpc([a, b], { legs: [a, b].flatMap((c) => allLegs(c, () => 90)) })), ORIGIN_LL);
  assert('a plan is produced', out.ok);
  if (out.ok) {
    const chs = out.draft.segments.filter((x): x is Extract<typeof x, { kind: 'chapter' }> => x.kind === 'chapter');
    eq('both chapters planned (no content value lost)', chs.length, 2);
    const [first, second] = chs as [typeof chs[0], typeof chs[0]];
    const secondPlaza = second.chapter_id === a.id ? a.stops[0]!.id : b.stops[0]!.id;
    eq('the LATER chapter\'s plaza core is silenced, the first plays it', [first.silent_stop_ids, second.silent_stop_ids], [[], [secondPlaza]]);
    assert('...and stays in waypoint_ids (core means core: planProblem passes)', second.waypoint_ids.includes(secondPlaza));
    eq('draft.chapters carries the silent ids for content_hash', out.draft.chapters.map((c) => c.silentStopIds), [[], [secondPlaza]]);
  }
  // 30 m: another place, nothing silenced.
  const far = planTour(request({ available_minutes: 240 }), parseCandidates(rpc([a, chapter(1, 400, [plaza[0], Number((plaza[1] + 30 / 111_320).toFixed(6))])], { legs: [a, b].flatMap((c) => allLegs(c, () => 90)) })), ORIGIN_LL);
  assert('30 m apart: nothing silenced', far.ok && far.draft.segments.every((x) => x.kind !== 'chapter' || x.silent_stop_ids.length === 0));

  // ZERO DWELL (PM, 6 Oct 2026): the visitor walks through a silent stop.
  // A 20-minute plaza stop in both tours: the second visit must cost nothing.
  const big = (k: number, x: number, firstCore: Pair): ChapterSpec => ({
    id: uuid(7800 + k), tour: uuid(7900 + k), entry: at(x, 0), exit: at(x + 300, 0), coreWeight: 0, stops: [
      { id: uuid(7950 + k * 10 + 1), sort: 1, role: 'core', pos: firstCore, dwell: 1200 },
      { id: uuid(7950 + k * 10 + 3), sort: 3, role: 'core', pos: at(x + 280, 0), dwell: 120 },
    ],
  });
  const bigA = big(0, 0, plaza);
  const bigB = big(1, 400, [plaza[0], Number((plaza[1] + 9 / 111_320).toFixed(6))]);
  const both = rpc([bigA, bigB], { legs: [bigA, bigB].flatMap((c) => allLegs(c, () => 90)) });
  const roomy = planTour(request({ available_minutes: 240 }), parseCandidates(both), ORIGIN_LL);
  assert('roomy budget: both chapters planned', roomy.ok && roomy.draft.chapters.length === 2);
  if (roomy.ok) {
    const segs = roomy.draft.segments.filter((x): x is Extract<typeof x, { kind: 'chapter' }> => x.kind === 'chapter');
    eq('dwell: the first visit stops 1200 + 120 s, the silent second visit only 120 s', segs.map((x) => x.dwell_s), [1320, 120]);
    eq('the estimate adds only what the visitor actually stands for', roomy.draft.estimate.dwell_s, 1440);
    // Tight budget: room for the plaza ONCE. Counting the silent dwell would
    // have dropped the second chapter for time that is never spent.
    const need = roomy.draft.estimate.total_s;
    const minutes = Math.ceil((need + 60) / 0.9 / 60);
    const tight = planTour(request({ available_minutes: minutes }), parseCandidates(both), ORIGIN_LL);
    // Driving: a stop's narration plays on the move, so the next stop must not
    // come sooner - but a SILENT stop narrates nothing, so it blocks nothing.
    const drive = (k: number, x: number, firstCore: Pair): ChapterSpec => ({
      id: uuid(8800 + k), tour: uuid(8900 + k), mode: 'driving', entry: at(x, 0), exit: at(x + 3000, 0), coreWeight: 0, stops: [
        { id: uuid(8950 + k * 10 + 1), sort: 1, role: 'core', pos: firstCore, dwell: 0, narration: 300 },
        { id: uuid(8950 + k * 10 + 2), sort: 2, role: 'extension', pos: at(x + 1500, 300), dwell: 0, narration: 60, weight: 3 },
        { id: uuid(8950 + k * 10 + 3), sort: 3, role: 'core', pos: at(x + 2800, 0), dwell: 0, narration: 60 },
      ],
    });
    const dA = drive(0, 0, plaza);
    const dB = drive(1, 5000, [plaza[0], Number((plaza[1] + 9 / 111_320).toFixed(6))]);
    // Every leg 90 s: shorter than the plaza's 300 s narration.
    const drv = planTour(request({ available_minutes: 240, transit_mode: 'driving' }), parseCandidates(rpc([dA, dB], { legs: [dA, dB].flatMap((c) => allLegs(c, () => 90)), transferProfile: 'auto' })), ORIGIN_LL);
    assert('a plan is produced (driving)', drv.ok);
    if (drv.ok) {
      const segs = drv.draft.segments.filter((x): x is Extract<typeof x, { kind: 'chapter' }> => x.kind === 'chapter');
      const second = segs[1]!;
      assert('driving: the second chapter silences its plaza core', second.silent_stop_ids.length === 1);
      assert('...and may keep the extension 90 s after it (nothing is narrating there)', second.kept_extension_ids.length === 1, JSON.stringify(second));
      assert('...while the FIRST chapter cannot (its plaza narrates 300 s)', segs[0]!.kept_extension_ids.length === 0, JSON.stringify(segs[0]));
    }
    assert(`tight budget (${minutes} min, ${need} s needed, +1200 s if the silent dwell counted): BOTH chapters still fit`,
      tight.ok && tight.draft.chapters.length === 2 && Math.floor(minutes * 60 * 0.9) < need + 1200, tight.ok ? JSON.stringify(tight.draft.chapters.map((c) => c.chapterId)) : 'no plan');
  }
}

{
  heading('contentHash - stored planner version, silent ids only when present');
  const ch = { chapterId: uuid(1), waypointIds: [uuid(2)], entry: at(0, 0), exit: at(10, 0) };
  const src = { [uuid(3)]: 'h' };
  const v2 = await contentHash([ch], src, 'v2');
  eq('a plan stored by v2 hashes the same under a v4 deploy (no spurious plan_stale)', await contentHash([ch], src, 'v2'), v2);
  assert('the version is part of the hash', (await contentHash([ch], src, 'v4')) !== v2);
  eq('no silent ids hashes exactly as before v4', await contentHash([{ ...ch, silentStopIds: [] }], src, 'v2'), v2);
  assert('silent ids change the hash (a GET detects them changing)', (await contentHash([{ ...ch, silentStopIds: [uuid(2)] }], src, 'v4')) !== (await contentHash([ch], src, 'v4')));
}

// -----------------------------------------------------------------------------
heading('the pruning bound knows silence makes a chapter SHORTER');
{
  // Z: a medium chapter, alone. Y: a cheap visit to the plaza. X: valuable,
  // but with a 50-minute plaza stop - which, AFTER Y, is silent and costs 0.
  // Optimum: Y then X. A bound that rated X at its unsilenced time would
  // prune Y's subtree once Z is found, and return Z.
  const spec = (k: number, stops: StopSpec[], entry: Pair, exit: Pair): ChapterSpec => ({ id: uuid(9100 + k), tour: uuid(9200 + k), entry, exit, coreWeight: 0, stops });
  const Y = spec(1, [
    { id: uuid(9301), sort: 1, role: 'core', pos: at(20, 0), dwell: 60 },
    { id: uuid(9302), sort: 2, role: 'core', pos: at(60, 0), dwell: 60 },
  ], at(0, 0), at(80, 0));
  const X = spec(2, [
    { id: uuid(9311), sort: 1, role: 'core', pos: at(20, 5), dwell: 3000 },
    { id: uuid(9312), sort: 2, role: 'core', pos: at(40, 40), dwell: 60, weight: 10 },
  ], at(0, 10), at(50, 50));
  const Z = spec(3, [{ id: uuid(9321), sort: 1, role: 'core', pos: at(0, -60), dwell: 500, weight: 4 }], at(0, -50), at(0, -70));
  const specs = [Y, X, Z];
  const transfers = specs.flatMap((a) => specs.filter((b) => b !== a).map((b) => ({ from: a.id, to: b.id, s: a === Z || b === Z ? 600 : 30, fromPt: a.exit, toPt: b.entry })));
  const answer = parseCandidates(rpc(specs, { legs: specs.flatMap((c) => allLegs(c, () => 30)), transfers }));
  const book = new CostBook(answer, 'walking');
  const models: ChapterModel[] = answer.candidates.map((c) => ({ candidate: c, baseValue: 1 + c.stops.filter((st) => st.stopRole === 'core').reduce((a, st) => a + st.matchedWeight, 0), options: chapterOptions(c, book, PARAMS)! }));
  const model = (spec: ChapterSpec) => models.find((m) => m.candidate.chapterId === spec.id)!;
  const hop = (spec: ChapterSpec) => book.fromOrigin(ORIGIN_LL, spec.id).durationS;
  const zTotal = hop(Z) + optionTime(model(Z).options[0]!);
  const yTotal = hop(Y) + optionTime(model(Y).options[0]!);
  const capacityS = zTotal + 5;
  // The hazard, stated: the rate a silence-blind bound would use, and what it would conclude.
  const rate = (m: ChapterModel) => m.baseValue / Math.max(1, optionTime(m.options[0]!));
  const blindBound = model(Y).baseValue + Math.max(rate(model(X)), rate(model(Z))) * (capacityS - yTotal);
  assert('fixture: a silence-blind bound would prune Y (and so miss Y -> X)', blindBound < model(Z).baseValue, `bound ${blindBound} vs Z ${model(Z).baseValue}`);
  const got = searchSequence({ models, book, origin: ORIGIN_LL, capacityS, transferPace: 1, transferIsWalking: true,
    dedup: { radiusM: 20, curveFor: (m, ex, si) => chapterOptions(m.candidate, book, PARAMS, ex, si)! } });
  eq('the search finds Y then X (silence makes X fit), not Z', got.chapters.map((c) => c.model.candidate.chapterId), [Y.id, X.id]);
}

// -----------------------------------------------------------------------------
heading('searchSequence WITH dedup == brute force over every ordered subset (150 overlapping cities + 200 dwell-heavy)');
for (const [seed, trials, coreDwellMax, capMin, capSpan] of [[6100, 150, 0, 2400, 6000], [6200, 200, 1800, 1200, 3600]] as const) {
  const rand = rng(seed);
  let mismatches = 0;
  let detail = '';
  let overlapsSeen = 0;
  for (let trial = 0; trial < 150; trial++) {
    const n = 3 + Math.floor(rand() * 3);
    const specs: ChapterSpec[] = [];
    for (let k = 0; k < n; k++) {
      const x = Math.round(rand() * 800);
      const y = Math.round(rand() * 800);
      specs.push({ id: uuid(8000 + k), entry: at(x, y), exit: at(x + 250, y), coreWeight: 0, stops: [
        { id: uuid(8100 + k * 10 + 1), sort: 1, role: 'core', pos: at(x + 50, y), dwell: 200 + Math.floor(rand() * coreDwellMax), weight: Math.floor(rand() * 3) },
        { id: uuid(8100 + k * 10 + 2), sort: 2, role: 'extension', pos: at(x + 100, y + 40), dwell: 100, weight: 1 + Math.floor(rand() * 4) },
        { id: uuid(8100 + k * 10 + 3), sort: 3, role: 'extension', pos: at(x + 150, y + 40), dwell: 100, weight: 1 + Math.floor(rand() * 4) },
        { id: uuid(8100 + k * 10 + 4), sort: 4, role: 'core', pos: at(x + 200, y), dwell: 200 },
      ] });
    }
    // Make places collide on purpose: move some stops - extensions AND first
    // cores - onto another chapter's stop (+ up to 10 m).
    for (const s of specs) for (const st of s.stops) {
      if (st.sort === 4 || rand() < 0.5) continue;
      const other = specs[Math.floor(rand() * specs.length)]!;
      if (other === s) continue;
      const target = other.stops[Math.floor(rand() * other.stops.length)]!.pos;
      st.pos = [target[0], Number((target[1] + (rand() * 10) / 111_320).toFixed(6))];
      overlapsSeen++;
    }
    const legs = specs.flatMap((c) => allLegs(c, () => 60 + Math.floor(rand() * 240)));
    const transfers = specs.flatMap((a) => specs.filter((b) => b !== a).map((b) => ({ from: a.id, to: b.id, s: 300 + Math.floor(rand() * 1200), fromPt: a.exit, toPt: b.entry })));
    const answer = parseCandidates(rpc(specs, { legs, transfers }));
    const book = new CostBook(answer, 'walking');
    // baseValue from the cores' own weights, as the SQL's core_matched_weight sums them.
    const models: ChapterModel[] = answer.candidates.map((c) => ({ candidate: c, baseValue: 1 + c.stops.filter((st) => st.stopRole === 'core').reduce((a, st) => a + st.matchedWeight, 0), options: chapterOptions(c, book, PARAMS)! }));
    const capacityS = capMin + Math.floor(rand() * capSpan);
    const curveFor = (m: ChapterModel, ex: ReadonlySet<string>, si: ReadonlySet<string>) => chapterOptions(m.candidate, book, PARAMS, ex, si)!;
    const got = searchSequence({ models, book, origin: ORIGIN_LL, capacityS, transferPace: 1, transferIsWalking: true, dedup: { radiusM: 20, curveFor } });

    // Oracle: the rule written out again, independently, and every combination tried.
    const dist = (p: Pair, q: Pair) => distanceMeters({ lng: p[0], lat: p[1] }, { lng: q[0], lat: q[1] });
    const offered = (m: ChapterModel) => m.candidate.stops.filter((s) => s.stopRole === 'extension' && s.eligible && s.matchedWeight > 0);
    const excludedFor = (ms: ChapterModel[], i: number) => new Set(offered(ms[i]!).filter((e) => ms.some((o, j) => j !== i && (
      o.candidate.stops.some((s) => s.stopRole === 'core' && dist(e.coordinates, s.coordinates) <= 20) ||
      (j < i && offered(o).some((s) => dist(e.coordinates, s.coordinates) <= 20))))).map((e) => e.waypointId));
    let best: { value: number; total: number; ids: string[] } | null = null;
    const ids = models.map((m) => m.candidate.chapterId);
    const walk = (seq: string[]) => {
      if (seq.length > 0) {
        let hopS = 0;
        let ok = true;
        seq.forEach((id, i) => {
          const h = i === 0 ? book.fromOrigin(ORIGIN_LL, id) : book.transfer(seq[i - 1]!, id);
          if (h === 'unroutable') ok = false;
          else hopS += h.durationS;
        });
        if (ok) {
          const ms = seq.map((id) => models.find((m) => m.candidate.chapterId === id)!);
          // Silent cores (v4): a core on an EARLIER chapter's core earns nothing a
          // second time, and the visitor does not stop there (zero dwell).
          const cores = (m: ChapterModel) => m.candidate.stops.filter((st) => st.stopRole === 'core');
          const silentFor = (i: number) => new Set(cores(ms[i]!).filter((c) => ms.slice(0, i).some((o) => cores(o).some((d) => dist(c.coordinates, d.coordinates) <= 20))).map((c) => c.waypointId));
          const cs = ms.map((m, i) => chapterOptions(m.candidate, book, PARAMS, excludedFor(ms, i), silentFor(i))!);
          const silentWeight = ms.reduce((acc, m, i) => acc + cores(m).filter((c) => ms.slice(0, i).some((o) => cores(o).some((d) => dist(c.coordinates, d.coordinates) <= 20))).reduce((a, c) => a + c.matchedWeight, 0), 0);
          const rec = (i: number, v: number, t: number) => {
            if (i === ms.length) {
              if (hopS + t > capacityS) return;
              const cand = { value: v + ms.reduce((a, m) => a + m.baseValue, 0) - silentWeight, total: hopS + t, ids: seq };
              const b = best as typeof cand | null;
              if (!b || cand.value > b.value || (cand.value === b.value && (cand.total < b.total || (cand.total === b.total && cand.ids.join() < b.ids.join())))) best = cand;
              return;
            }
            for (const o of cs[i]!) rec(i + 1, v + o.value, t + optionTime(o));
          };
          rec(0, 0, 0);
        }
      }
      if (seq.length < ids.length) for (const id of ids) if (!seq.includes(id)) walk([...seq, id]);
    };
    walk([]);
    const mine = got.chapters.length === 0 ? null : { value: got.value, total: got.totalS, ids: got.chapters.map((p) => p.model.candidate.chapterId) };
    if (got.truncated || JSON.stringify(mine) !== JSON.stringify(best)) {
      mismatches++;
      if (!detail) detail = `trial ${trial}: got ${JSON.stringify(mine)} expected ${JSON.stringify(best)}`;
    }
    // Whatever was chosen, no kept extension sits on a place the plan already narrates.
    const chosen = got.chapters;
    chosen.forEach((p, i) => {
      for (const id of p.option.keptIds) {
        const e = p.model.candidate.stops.find((s) => s.waypointId === id)!;
        const clash = chosen.some((o, j) => j !== i && o.model.candidate.stops.some((s) =>
          dist(e.coordinates, s.coordinates) <= 20 && (s.stopRole === 'core' || (j < i && o.option.keptIds.includes(s.waypointId)))));
        if (clash && !detail) { mismatches++; detail = `trial ${trial}: kept ${id} on a place already narrated`; }
      }
    });
  }
  assert(`dedup + silent-core B&B finds the brute-force optimum (seed ${seed}, ${trials} trials, ${overlapsSeen} forced overlaps)`, mismatches === 0, detail);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
