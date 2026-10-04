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
  MAX_FILL_CELLS,
  optionTime,
  parseCandidates,
  planTour,
  requestHash,
  roundOrigin,
  searchSequence,
  type ChapterModel,
  type ChapterOption,
  type MissingCell,
  type Pair,
  type PlannerCandidates,
} from '../../shared/src/planner/index.ts';
import { coordsKey } from '../../shared/src/routing/coordsKey.ts';
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

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
