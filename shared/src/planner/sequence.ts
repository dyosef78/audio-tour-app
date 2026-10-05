/**
 * Which chapters, in which order (Epic 16): orienteering over at most ~50
 * candidates, by depth-first branch-and-bound from the origin. One-way: no
 * return leg.
 *
 * A NODE is a sequence of chapters. Its time has two parts:
 *   transfers   origin -> c1 -> c2 ...  (exit to entry, transfer profile)
 *   chapters    one option per chapter from its choice curve
 * The chapter part is a multiple-choice knapsack, solved EXACTLY and
 * incrementally: each DFS step folds the new chapter's curve into the
 * parent's table (value -> best combination), so a node costs one fold, not
 * a fresh solve.
 *
 * PRUNING. A child is skipped when even its fastest option cannot fit. A
 * subtree is cut when an optimistic bound - the node's best possible value
 * plus (best value per second of any unused chapter) x (time left) - is
 * strictly below the best plan found. Strict, so an equal-value plan with a
 * better tie-break is still reached.
 *
 * BOUNDED AND DETERMINISTIC. Children are visited in a fixed order (value per
 * second, then chapter id), and the search stops after MAX_SEARCH_NODES
 * nodes, returning the best plan so far with `truncated`. Same input, same
 * nodes, same cut-off, same plan.
 *
 * PLAN ORDER (best first): more value; less total time; fewer estimated
 * legs; then chapter ids, lexicographically.
 *
 * SPATIAL DEDUP (v3, PM 6 Oct 2026), when `dedup` is given. Two tours may visit
 * the same plaza; the visitor must not hear it twice. An EXTENSION of a
 * chapter in the sequence is unavailable when it lies within dedup.radiusM of
 *   - a CORE stop of any other chapter in the sequence (cores always play), or
 *   - an extension of an EARLIER chapter (the first visit keeps the place).
 * Exact, not a post-pass: each chapter's curve is recomputed for the sequence
 * it is in (memoised; most pairs of chapters are far apart and change nothing),
 * and when a new chapter takes extensions away from earlier ones the node's
 * table is folded again from scratch. Value only falls, so every bound stays
 * optimistic. Core stops are never removed (core means core).
 *
 * SILENT CORES (v4, Option E). A CORE stop within dedup.radiusM of a core of
 * an EARLIER chapter stays in the plan (its zone still fires) but is silenced
 * (silent_stop_ids), so its interest weight is not counted a second time:
 * the node's base value drops by it - and its DWELL is zero (the
 * visitor walks through without stopping to listen; the legs through it are
 * unchanged). Silence depends only on earlier chapters, so appending a chapter
 * never changes an earlier one's. No later core can sit on an earlier KEPT
 * extension - that extension was excluded.
 *
 * Because silence makes a chapter SHORTER, the two time bounds account for
 * it: a child's fit is judged on its curve with its actual silence, and the
 * value-per-second rate behind the pruning bound uses each chapter's fastest
 * possible time (every core that could ever be silenced, silenced) - so the
 * bound stays optimistic.
 */

import { distanceMeters } from '../distance.ts';
import type { CandidateStop, Pair } from './candidates.ts';
import { compareOrders, compareSameValue, optionTime, paretoByValue, type ChapterModel, type ChapterOption } from './chapterOptions.ts';
import { UNROUTABLE, type Cost, type CostBook } from './costBook.ts';
import { MAX_PLAN_CHAPTERS, MAX_SEARCH_NODES } from './constants.ts';

export interface SearchInput {
  models: ChapterModel[];
  book: CostBook;
  origin: Pair;
  /** Already reduced by PLANNING_MARGIN. */
  capacityS: number;
  /** Applied to transfers when the transfer mode is walking. */
  transferPace: number;
  transferIsWalking: boolean;
  maxNodes?: number;
  /** Spatial dedup of extensions. Absent: off (the brute-force oracle tests without it). */
  dedup?: DedupInput;
}

export interface DedupInput {
  radiusM: number;
  /** The chapter's curve with these extensions unavailable and these cores silenced: chapterOptions(..., excluded, silenced). */
  curveFor(model: ChapterModel, excluded: ReadonlySet<string>, silenced: ReadonlySet<string>): ChapterOption[];
}

export interface Hop {
  cost: Cost;
  /** cost.durationS with the walking pace applied. */
  seconds: number;
}

export interface PlannedChapter {
  model: ChapterModel;
  /** The transfer INTO this chapter (from the origin for the first). */
  hop: Hop;
  option: ChapterOption;
  /** The curve this chapter was planned with: model.options minus deduplicated extensions. */
  options: ChapterOption[];
  /** v4: core stops silenced because an earlier chapter's core is the same place. */
  silentIds: string[];
}

export interface SearchResult {
  chapters: PlannedChapter[];
  value: number;
  totalS: number;
  truncated: boolean;
  nodes: number;
}

/** Combined chapter choices: value -> best, folded chapter by chapter. */
interface Combo {
  value: number;
  timeS: number;
  estimatedLegs: number;
  /** One option per chapter, in sequence order. */
  picks: ChapterOption[];
}

function better(a: Combo, b: Combo): boolean {
  if (a.timeS !== b.timeS) return a.timeS < b.timeS;
  if (a.estimatedLegs !== b.estimatedLegs) return a.estimatedLegs < b.estimatedLegs;
  for (let i = 0; i < Math.min(a.picks.length, b.picks.length); i++) {
    const c = compareOrders(a.picks[i]!.keptOrders, b.picks[i]!.keptOrders);
    if (c !== 0) return c < 0;
  }
  return false;
}

function fold(table: Combo[], options: ChapterOption[], capacity: number): Combo[] {
  const byValue = new Map<number, Combo>();
  for (const t of table) {
    for (const o of options) {
      const next: Combo = {
        value: t.value + o.value,
        timeS: t.timeS + optionTime(o),
        estimatedLegs: t.estimatedLegs + o.estimatedLegs,
        picks: [...t.picks, o],
      };
      if (next.timeS > capacity) continue;
      const held = byValue.get(next.value);
      if (!held || better(next, held)) byValue.set(next.value, next);
    }
  }
  // Pareto: a lower value survives only if strictly faster.
  const sorted = [...byValue.values()].sort((a, b) => b.value - a.value);
  const kept: Combo[] = [];
  let bestTime = Number.POSITIVE_INFINITY;
  for (const c of sorted) {
    if (c.timeS < bestTime) {
      kept.push(c);
      bestTime = c.timeS;
    }
  }
  return kept;
}

interface Best {
  value: number;
  totalS: number;
  estimatedLegs: number;
  ids: string[];
  chapters: PlannedChapter[];
}

function improves(c: Best, best: Best | null): boolean {
  if (!best) return true;
  if (c.value !== best.value) return c.value > best.value;
  if (c.totalS !== best.totalS) return c.totalS < best.totalS;
  if (c.estimatedLegs !== best.estimatedLegs) return c.estimatedLegs < best.estimatedLegs;
  for (let i = 0; i < Math.min(c.ids.length, best.ids.length); i++) {
    if (c.ids[i] !== best.ids[i]) return (c.ids[i] as string) < (best.ids[i] as string);
  }
  return c.ids.length < best.ids.length;
}

/** Extensions offered by a chapter (the only stops dedup can take away). */
const offeredExtensions = (m: ChapterModel): CandidateStop[] =>
  m.candidate.stops.filter((s) => s.stopRole === 'extension' && s.eligible && s.matchedWeight > 0);

const toPoint = (s: CandidateStop) => ({ lng: s.coordinates[0], lat: s.coordinates[1] });

/**
 * For every ordered pair of chapters (x, y): x's offered extensions within
 * radius of y's CORE stops, and of y's offered extensions. Empty pairs are
 * not stored; a bounding-box test skips chapters that cannot be that close.
 */
function proximity(models: readonly ChapterModel[], radiusM: number) {
  const nearCore = new Map<string, Map<string, string[]>>();
  const nearExt = new Map<string, Map<string, string[]>>();
  /** x's CORE stops within radius of y's core stops - silenced when y comes first. */
  const coreOnCore = new Map<string, Map<string, CandidateStop[]>>();
  const box = new Map<string, [number, number, number, number]>();
  for (const m of models) {
    const pts = m.candidate.stops.map((s) => s.coordinates);
    const lats = pts.map((p) => p[1]);
    const lons = pts.map((p) => p[0]);
    const padLat = radiusM / 111_320;
    const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const padLon = radiusM / (111_320 * Math.max(0.01, Math.cos((midLat * Math.PI) / 180)));
    box.set(m.candidate.chapterId, [Math.min(...lons) - padLon, Math.min(...lats) - padLat, Math.max(...lons) + padLon, Math.max(...lats) + padLat]);
  }
  const overlap = (a: [number, number, number, number], b: [number, number, number, number]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const within = (s: CandidateStop, others: readonly CandidateStop[]) => others.some((o) => distanceMeters(toPoint(s), toPoint(o)) <= radiusM);
  for (const x of models) {
    const xs = offeredExtensions(x);
    const xCores = x.candidate.stops.filter((s) => s.stopRole === 'core');
    for (const y of models) {
      if (x === y || !overlap(box.get(x.candidate.chapterId)!, box.get(y.candidate.chapterId)!)) continue;
      const cores = y.candidate.stops.filter((s) => s.stopRole === 'core');
      const silenced = xCores.filter((s) => within(s, cores));
      if (silenced.length > 0) (coreOnCore.get(x.candidate.chapterId) ?? coreOnCore.set(x.candidate.chapterId, new Map()).get(x.candidate.chapterId)!).set(y.candidate.chapterId, silenced);
      if (xs.length === 0) continue;
      const exts = offeredExtensions(y);
      const c = xs.filter((s) => within(s, cores)).map((s) => s.waypointId);
      const e = xs.filter((s) => within(s, exts)).map((s) => s.waypointId);
      if (c.length > 0) (nearCore.get(x.candidate.chapterId) ?? nearCore.set(x.candidate.chapterId, new Map()).get(x.candidate.chapterId)!).set(y.candidate.chapterId, c);
      if (e.length > 0) (nearExt.get(x.candidate.chapterId) ?? nearExt.set(x.candidate.chapterId, new Map()).get(x.candidate.chapterId)!).set(y.candidate.chapterId, e);
    }
  }
  return { nearCore, nearExt, coreOnCore };
}

export function searchSequence(input: SearchInput): SearchResult {
  const maxNodes = input.maxNodes ?? MAX_SEARCH_NODES;
  const models = [...input.models].sort((a, b) => (a.candidate.chapterId < b.candidate.chapterId ? -1 : 1));

  // Dedup: which extensions each chapter loses, given the sequence it is in.
  const dedup = input.dedup;
  const near = dedup ? proximity(models, dedup.radiusM) : null;
  const excludedAt = (ids: readonly string[], i: number): Set<string> => {
    const out = new Set<string>();
    const x = ids[i]!;
    ids.forEach((y, j) => {
      if (j === i) return;
      for (const id of near!.nearCore.get(x)?.get(y) ?? []) out.add(id);
      if (j < i) for (const id of near!.nearExt.get(x)?.get(y) ?? []) out.add(id);
    });
    return out;
  };
  /** The cores of chapter `ids[i]` that an earlier chapter's core already narrates. */
  const silentAt = (ids: readonly string[], i: number): CandidateStop[] => {
    const out = new Map<string, CandidateStop>();
    for (let j = 0; j < i; j++) for (const s of near!.coreOnCore.get(ids[i]!)?.get(ids[j]!) ?? []) out.set(s.waypointId, s);
    return [...out.values()].sort((a, b) => a.sortOrder - b.sortOrder);
  };
  const curves = new Map<string, ChapterOption[]>();
  const NO_IDS: ReadonlySet<string> = new Set();
  const curveOf = (m: ChapterModel, excluded: ReadonlySet<string>, silenced: ReadonlySet<string> = NO_IDS): ChapterOption[] => {
    if (excluded.size === 0 && silenced.size === 0) return m.options;
    const key = `${m.candidate.chapterId}|${[...excluded].sort().join(',')}|${[...silenced].sort().join(',')}`;
    let c = curves.get(key);
    if (!c) {
      c = dedup!.curveFor(m, excluded, silenced);
      curves.set(key, c);
    }
    return c;
  };
  // Fastest a chapter can ever be: core only, with every core that some
  // other chapter could silence silenced. For the optimistic bound only.
  const fastestEver = new Map(
    models.map((m) => {
      const id = m.candidate.chapterId;
      const silenceable = new Set([...(near?.coreOnCore.get(id)?.values() ?? [])].flat().map((s) => s.waypointId));
      return [id, silenceable.size === 0 ? optionTime(m.options[0]!) : optionTime(curveOf(m, NO_IDS, silenceable)[0]!)];
    }),
  );
  /** The child's core-only time with the silence it would actually get after `seq`. */
  const minTimeAfter = (seqIds: readonly string[], m: ChapterModel): number => {
    if (!near) return optionTime(m.options[0]!);
    const silent = silentAt([...seqIds, m.candidate.chapterId], seqIds.length);
    return optionTime(curveOf(m, NO_IDS, new Set(silent.map((s) => s.waypointId)))[0]!);
  };
  const minTime = new Map(models.map((m) => [m.candidate.chapterId, optionTime(m.options[0]!)]));
  const maxValue = new Map(models.map((m) => [m.candidate.chapterId, m.options[m.options.length - 1]!.value]));
  const ratio = (m: ChapterModel): number =>
    (m.baseValue + maxValue.get(m.candidate.chapterId)!) / Math.max(1, fastestEver.get(m.candidate.chapterId)!);

  const hopTo = (fromId: string | null, toId: string): Hop | null => {
    const cost = fromId === null ? input.book.fromOrigin(input.origin, toId) : input.book.transfer(fromId, toId);
    if (cost === UNROUTABLE) return null;
    const seconds = input.transferIsWalking ? Math.ceil(cost.durationS * input.transferPace) : cost.durationS;
    return { cost, seconds };
  };

  let nodes = 0;
  let truncated = false;
  let best: Best | null = null;

  const visit = (seq: PlannedChapter[], used: Set<string>, transferS: number, baseValue: number, table: Combo[], hopEstimated: number): void => {
    if (seq.length > 0) {
      // Best combination that fits beside the transfers: the table holds only
      // combinations within capacity - transfers of the PARENT path, so check again.
      const room = input.capacityS - transferS;
      const fit = table.find((c) => c.timeS <= room);
      if (fit) {
        const candidate: Best = {
          value: baseValue + fit.value,
          totalS: transferS + fit.timeS,
          estimatedLegs: hopEstimated + fit.estimatedLegs,
          ids: seq.map((p) => p.model.candidate.chapterId),
          chapters: seq.map((p, i) => ({ ...p, option: fit.picks[i]! })),
        };
        if (improves(candidate, best)) best = candidate;
      }
    }
    if (seq.length >= MAX_PLAN_CHAPTERS) return;

    const lastId = seq.length > 0 ? seq[seq.length - 1]!.model.candidate.chapterId : null;
    const children: { model: ChapterModel; hop: Hop; score: number }[] = [];
    for (const m of models) {
      const id = m.candidate.chapterId;
      if (used.has(id)) continue;
      const hop = hopTo(lastId, id);
      if (!hop) continue;
      const fastestCombo = table.length > 0 ? table[table.length - 1]!.timeS : 0;
      const seqIds = seq.map((p) => p.model.candidate.chapterId);
      if (transferS + hop.seconds + fastestCombo + minTimeAfter(seqIds, m) > input.capacityS) continue;
      children.push({ model: m, hop, score: (m.baseValue + maxValue.get(id)!) / Math.max(1, hop.seconds + minTime.get(id)!) });
    }
    children.sort((a, b) => b.score - a.score || (a.model.candidate.chapterId < b.model.candidate.chapterId ? -1 : 1));

    for (const child of children) {
      if (nodes >= maxNodes) {
        truncated = true;
        return;
      }
      const id = child.model.candidate.chapterId;
      const nextTransferS = transferS + child.hop.seconds;
      const ids = [...seq.map((p) => p.model.candidate.chapterId), id];
      const silent = near ? silentAt(ids, seq.length) : [];
      // A silenced core's weight was already earned where the place first played.
      const nextBase = baseValue + child.model.baseValue - silent.reduce((a, s) => a + s.matchedWeight, 0);
      const capacity = input.capacityS - nextTransferS;
      const seed: Combo[] = [{ value: 0, timeS: 0, estimatedLegs: 0, picks: [] }];

      // The child's curve, and - when it takes a place an earlier chapter's
      // extension relied on - the earlier chapters' too (then fold again).
      let nextSeq: PlannedChapter[];
      let nextTable: Combo[];
      if (near) {
        let refold = false;
        const prior = seq.map((p, i) => {
          if ((near.nearCore.get(p.model.candidate.chapterId)?.get(id)?.length ?? 0) === 0) return p;
          refold = true;
          return { ...p, options: curveOf(p.model, excludedAt(ids, i), new Set(p.silentIds)) };
        });
        const own = curveOf(child.model, excludedAt(ids, seq.length), new Set(silent.map((s) => s.waypointId)));
        nextSeq = [...prior, { model: child.model, hop: child.hop, option: own[0]!, options: own, silentIds: silent.map((s) => s.waypointId) }];
        nextTable = refold
          ? nextSeq.reduce((t, p) => fold(t, p.options, capacity), seed)
          : fold(seq.length === 0 ? seed : table, own, capacity);
      } else {
        nextSeq = [...seq, { model: child.model, hop: child.hop, option: child.model.options[0]!, options: child.model.options, silentIds: [] }];
        nextTable = fold(seq.length === 0 ? seed : table, child.model.options, capacity);
      }
      if (nextTable.length === 0) continue;

      // Bound: this node's best value, plus what the time left could buy at
      // the best rate of any unused chapter.
      const room = input.capacityS - nextTransferS - nextTable[nextTable.length - 1]!.timeS;
      let bestRate = 0;
      for (const m of models) {
        const mid = m.candidate.chapterId;
        if (mid !== id && !used.has(mid)) bestRate = Math.max(bestRate, ratio(m));
      }
      const bound = nextBase + nextTable[0]!.value + bestRate * Math.max(0, room);
      if (best !== null && bound < (best as Best).value) continue;

      nodes++;
      used.add(id);
      visit(
        nextSeq,
        used,
        nextTransferS,
        nextBase,
        nextTable,
        hopEstimated + (child.hop.cost.source === 'estimated' ? 1 : 0),
      );
      used.delete(id);
      if (truncated) return;
    }
  };

  visit([], new Set(), 0, 0, [], 0);
  const found = best as Best | null;
  return found
    ? { chapters: found.chapters, value: found.value, totalS: found.totalS, truncated, nodes }
    : { chapters: [], value: 0, totalS: 0, truncated, nodes };
}

// Re-exported for tests that compare against brute force.
export { compareSameValue, paretoByValue };
