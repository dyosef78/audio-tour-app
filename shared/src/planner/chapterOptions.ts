/**
 * Which extensions a chapter keeps, as a curve of choices: for each achievable
 * extension VALUE, the cheapest way to get it (Epic 16, PM-approved design).
 *
 * THE CHAPTER, AS SLOTS. Authored order is  entry, s1 .. sn, exit.  Entry,
 * every core stop and exit are MANDATORY; the extensions between two
 * consecutive mandatory nodes L and R form a SLOT. Core stops are fixed, so
 * slots are independent: a slot's cost depends only on which of its own
 * extensions are kept.
 *
 * ONE SLOT, EXACTLY. Kept extensions are visited in authored order, so a
 * choice is a path L -> e_i -> ... -> e_j -> R that only moves forward. A DP
 * over (last node kept, value so far) -> cheapest time reads ONLY legs from a
 * node to a later node of the same slot, up to and including R - exactly the
 * rows chapter_leg_costs holds. It never needs another leg and never calls
 * Valhalla. Values are small integers (interest weights 1-3), so indexing by
 * value is exact: no time buckets, no rounding.
 *
 * TIES (PM: detour time strictly first). Two choices with equal value:
 *   1. less added TIME (detour + dwell)  - the budget is the hard constraint,
 *                                          and slack absorbs pace error
 *   2. fewer ESTIMATED legs              - prefer costs Valhalla measured
 *   3. EARLIER in authored order         - compared stop by stop
 * Sort orders are unique within a tour, so (3) is a total order.
 *
 * Never kept: an extension not eligible for the visitor's audience, or one
 * matching none of their interests (value 0 buys nothing).
 */

import type { TransitMode } from '../contracts/planTour.ts';
import type { Candidate, CandidateStop } from './candidates.ts';
import { UNROUTABLE, type CostBook } from './costBook.ts';

export interface ChapterParams {
  includeDeepDives: boolean;
  /** Multiplies walking travel only. */
  walkingPace: number;
}

/** One way to run a chapter. Times in whole seconds. */
export interface ChapterOption {
  /** Sum of kept extensions' matched weights. */
  value: number;
  travelS: number;
  /** Time at stops, Deep Dives included when the request asked. */
  dwellS: number;
  /** Deep Dive time of the kept stops NOT in dwellS (0 when included). */
  deepDiveExtraS: number;
  estimatedLegs: number;
  legs: number;
  /** Kept extensions, authored order. */
  keptIds: string[];
  keptOrders: number[];
}

export interface ChapterModel {
  candidate: Candidate;
  /** BASE_CHAPTER_VALUE + core matched weight - set by the caller. */
  baseValue: number;
  /** Pareto curve: value strictly increasing, time strictly increasing. Never empty. */
  options: ChapterOption[];
}

export const optionTime = (o: ChapterOption): number => o.travelS + o.dwellS;

const NONE: ReadonlySet<string> = new Set();

/** -1 when a is better, 1 when b is better. Never 0 for distinct choices. */
export function compareSameValue(a: ChapterOption, b: ChapterOption): number {
  const ta = optionTime(a);
  const tb = optionTime(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.estimatedLegs !== b.estimatedLegs) return a.estimatedLegs < b.estimatedLegs ? -1 : 1;
  return compareOrders(a.keptOrders, b.keptOrders);
}

export function compareOrders(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (a[i] as number) < (b[i] as number) ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const EMPTY: ChapterOption = {
  value: 0, travelS: 0, dwellS: 0, deepDiveExtraS: 0, estimatedLegs: 0, legs: 0, keptIds: [], keptOrders: [],
};

function combine(a: ChapterOption, b: ChapterOption): ChapterOption {
  return {
    value: a.value + b.value,
    travelS: a.travelS + b.travelS,
    dwellS: a.dwellS + b.dwellS,
    deepDiveExtraS: a.deepDiveExtraS + b.deepDiveExtraS,
    estimatedLegs: a.estimatedLegs + b.estimatedLegs,
    legs: a.legs + b.legs,
    keptIds: [...a.keptIds, ...b.keptIds],
    keptOrders: [...a.keptOrders, ...b.keptOrders],
  };
}

/** Keep the better option per value, then drop dominated ones. */
export function paretoByValue(options: Iterable<ChapterOption>): ChapterOption[] {
  const byValue = new Map<number, ChapterOption>();
  for (const o of options) {
    const held = byValue.get(o.value);
    if (!held || compareSameValue(o, held) < 0) byValue.set(o.value, o);
  }
  const sorted = [...byValue.values()].sort((a, b) => b.value - a.value);
  const kept: ChapterOption[] = [];
  let bestTime = Number.POSITIVE_INFINITY;
  for (const o of sorted) {
    // A lower value is worth keeping only if it is strictly faster.
    if (optionTime(o) < bestTime) {
      kept.push(o);
      bestTime = optionTime(o);
    }
  }
  return kept.reverse();
}

interface SlotNode {
  id: string; // 'entry' | 'exit' | waypoint id
  stop: CandidateStop | null;
}

function travel(seconds: number, mode: TransitMode, pace: number): number {
  return mode === 'walking' ? Math.ceil(seconds * pace) : seconds;
}

/**
 * Every way to cross one slot L -> [extensions] -> R. Empty when no path
 * exists (every route through it is unroutable).
 */
function slotOptions(chapter: Candidate, book: CostBook, params: ChapterParams, L: SlotNode, exts: CandidateStop[], R: SlotNode, silenced: ReadonlySet<string>): ChapterOption[] {
  const nodes: SlotNode[] = [L, ...exts.map((s) => ({ id: s.waypointId, stop: s })), R];
  const last = nodes.length - 1;
  // best[j]: value -> best option for paths L .. ending at node j
  const best: Map<number, ChapterOption>[] = nodes.map(() => new Map());
  best[0]!.set(0, EMPTY);

  for (let j = 1; j <= last; j++) {
    const to = nodes[j]!;
    const isExtension = j < last;
    for (let i = 0; i < j; i++) {
      const from = nodes[i]!;
      if (best[i]!.size === 0) continue;
      const cost = book.leg(chapter, from.id, to.id);
      if (cost === UNROUTABLE) continue;
      const t = travel(cost.durationS, chapter.transitMode, params.walkingPace);

      // Driving: a stop's narration plays while moving; the next stop must
      // not arrive before it ends, or the engine's queue expires that stop.
      // Applied only to hops an EXTENSION choice creates - core-to-core hops
      // are authored, and the planner cannot drop a core.
      const touchesExtension = i > 0 || isExtension;
      // A silenced core narrates nothing, so there is nothing to outrun.
      const narrationS = from.stop && !silenced.has(from.stop.waypointId) ? (from.stop.narrationS ?? 0) : 0;
      if (chapter.transitMode === 'driving' && touchesExtension && from.stop && t < narrationS) continue;

      const step: ChapterOption = isExtension
        ? {
            value: to.stop!.matchedWeight,
            travelS: t,
            dwellS: to.stop!.dwellS + (params.includeDeepDives ? to.stop!.deepDiveDwellS : 0),
            deepDiveExtraS: params.includeDeepDives ? 0 : to.stop!.deepDiveDwellS,
            estimatedLegs: cost.source === 'estimated' ? 1 : 0,
            legs: 1,
            keptIds: [to.id],
            keptOrders: [to.stop!.sortOrder],
          }
        : { ...EMPTY, travelS: t, estimatedLegs: cost.source === 'estimated' ? 1 : 0, legs: 1 };

      for (const prev of best[i]!.values()) {
        const next = combine(prev, step);
        const held = best[j]!.get(next.value);
        if (!held || compareSameValue(next, held) < 0) best[j]!.set(next.value, next);
      }
    }
  }
  return paretoByValue(best[last]!.values());
}

/**
 * The chapter's choice curve, or null when no path crosses it at all - a
 * chapter whose core route is unroutable cannot be planned.
 */
/**
 * `excluded`: extensions the plan already covers elsewhere (dedup, sequence.ts).
 * `silenced`: CORE stops an earlier chapter already narrated (v4, Option E).
 * The visitor walks through them - their legs stay, so travel is unchanged -
 * but does not stop to listen: no dwell, no Deep Dive, nothing to outrun.
 */
export function chapterOptions(
  chapter: Candidate,
  book: CostBook,
  params: ChapterParams,
  excluded: ReadonlySet<string> = NONE,
  silenced: ReadonlySet<string> = NONE,
): ChapterOption[] | null {
  const mandatory: SlotNode[] = [{ id: 'entry', stop: null }];
  const slots: CandidateStop[][] = [[]];
  let coreDwell = 0;
  let coreDeepDiveExtra = 0;

  for (const s of chapter.stops) {
    if (s.stopRole === 'core') {
      mandatory.push({ id: s.waypointId, stop: s });
      slots.push([]);
      if (!silenced.has(s.waypointId)) {
        coreDwell += s.dwellS + (params.includeDeepDives ? s.deepDiveDwellS : 0);
        coreDeepDiveExtra += params.includeDeepDives ? 0 : s.deepDiveDwellS;
      }
    } else if (s.eligible && s.matchedWeight > 0 && !excluded.has(s.waypointId)) {
      // `excluded`: extensions the plan already covers elsewhere (dedup, sequence.ts).
      slots[slots.length - 1]!.push(s);
    }
  }
  mandatory.push({ id: 'exit', stop: null });

  let curve: ChapterOption[] = [{ ...EMPTY, dwellS: coreDwell, deepDiveExtraS: coreDeepDiveExtra }];
  for (let k = 0; k < mandatory.length - 1; k++) {
    const options = slotOptions(chapter, book, params, mandatory[k]!, slots[k]!, mandatory[k + 1]!, silenced);
    if (options.length === 0) return null;
    const merged: ChapterOption[] = [];
    for (const a of curve) for (const b of options) merged.push(combine(a, b));
    curve = paretoByValue(merged);
  }
  return curve;
}

/** Every extension in the chapter (kept or not), authored order - for dropped_extension_ids. */
export function extensionIds(chapter: Candidate): string[] {
  return chapter.stops.filter((s) => s.stopRole === 'extension').map((s) => s.waypointId);
}

export function coreIds(chapter: Candidate): string[] {
  return chapter.stops.filter((s) => s.stopRole === 'core').map((s) => s.waypointId);
}
