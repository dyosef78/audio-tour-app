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
 */

import type { Pair } from './candidates.ts';
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

export function searchSequence(input: SearchInput): SearchResult {
  const maxNodes = input.maxNodes ?? MAX_SEARCH_NODES;
  const models = [...input.models].sort((a, b) => (a.candidate.chapterId < b.candidate.chapterId ? -1 : 1));
  const minTime = new Map(models.map((m) => [m.candidate.chapterId, optionTime(m.options[0]!)]));
  const maxValue = new Map(models.map((m) => [m.candidate.chapterId, m.options[m.options.length - 1]!.value]));
  const ratio = (m: ChapterModel): number =>
    (m.baseValue + maxValue.get(m.candidate.chapterId)!) / Math.max(1, minTime.get(m.candidate.chapterId)!);

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
      if (transferS + hop.seconds + fastestCombo + minTime.get(id)! > input.capacityS) continue;
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
      const nextBase = baseValue + child.model.baseValue;
      const nextTable = fold(seq.length === 0 ? [{ value: 0, timeS: 0, estimatedLegs: 0, picks: [] }] : table, child.model.options, input.capacityS - nextTransferS);
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
        [...seq, { model: child.model, hop: child.hop, option: child.model.options[0]! }],
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
