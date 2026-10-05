/**
 * The planner, end to end, as one pure synchronous function (Epic 16 Part 3):
 *
 *   candidates (get_planner_candidates) + request
 *     -> CostBook               every cost: cached, unroutable or estimated
 *     -> chapterOptions         per chapter, the exact extension choice curve
 *     -> searchSequence         which chapters, in which order
 *     -> PlanDraft              contract segments, estimate, quality
 *
 * No clock, no network, no randomness: same input, same plan, byte for byte.
 * Hashing, bundle hashes, plan_id and expiry are the Edge Function's (they
 * need the database or Web Crypto).
 */

import type { ChapterSegment, PlanEstimate, PlanSegment, PlanTourRequest, TransferSegment } from '../contracts/planTour.ts';
import type { Candidate, Pair, PlannerCandidates } from './candidates.ts';
import { chapterOptions, coreIds, extensionIds, type ChapterModel } from './chapterOptions.ts';
import { CostBook, missingCellKey, type MissingCell } from './costBook.ts';
import { BASE_CHAPTER_VALUE, DEDUP_RADIUS_M, HIGH_VALUE_WEIGHT, MAX_FILL_CELLS, PLANNING_MARGIN, WALKING_PACE } from './constants.ts';
import { searchSequence, type PlannedChapter } from './sequence.ts';

export interface PlanDraft {
  segments: PlanSegment[];
  estimate: PlanEstimate;
  legsTotal: number;
  legsEstimated: number;
  searchTruncated: boolean;
  /** See PlanQuality.dropped_high_value_extensions. */
  droppedHighValueExtensions: number;
  /** Chosen chapters, for content_hash and the stale check. */
  chapters: { chapterId: string; tourId: string; waypointIds: string[]; silentStopIds: string[]; entry: Pair; exit: Pair }[];
}

export type PlanOutcome =
  | { ok: true; draft: PlanDraft; missing: MissingCell[]; planCells: MissingCell[] }
  | { ok: false; reason: 'infeasible'; shortfallS: number; missing: MissingCell[] };

export function planTour(request: PlanTourRequest, answer: PlannerCandidates, origin: Pair): PlanOutcome {
  const budgetS = request.available_minutes * 60;
  const capacityS = Math.floor(budgetS * (1 - PLANNING_MARGIN));
  const pace = WALKING_PACE[request.group_type];
  const book = new CostBook(answer, request.transit_mode);

  const models: ChapterModel[] = [];
  for (const c of answer.candidates) {
    const options = chapterOptions(c, book, { includeDeepDives: request.include_deep_dives, walkingPace: pace });
    if (options) models.push({ candidate: c, baseValue: BASE_CHAPTER_VALUE + c.coreMatchedWeight, options });
  }

  const params = { includeDeepDives: request.include_deep_dives, walkingPace: pace };
  const result = searchSequence({
    models,
    book,
    origin,
    capacityS,
    transferPace: pace,
    transferIsWalking: request.transit_mode === 'walking',
    dedup: {
      radiusM: DEDUP_RADIUS_M,
      curveFor: (m, excluded, silenced) => {
        // Excluding extensions or silencing cores never touches the core path,
        // so a chapter that had a curve still has one; null is a planner bug.
        const curve = chapterOptions(m.candidate, book, params, excluded, silenced);
        if (curve === null) throw new Error(`dedup: chapter ${m.candidate.chapterId} lost its core path`);
        return curve;
      },
    },
  });

  if (result.chapters.length === 0) {
    // Smallest time any single chapter needs from here, against the margin-reduced budget.
    let cheapest = Number.POSITIVE_INFINITY;
    for (const m of models) {
      const hop = book.fromOrigin(origin, m.candidate.chapterId);
      const hopS = request.transit_mode === 'walking' ? Math.ceil(hop.durationS * pace) : hop.durationS;
      const o = m.options[0]!;
      cheapest = Math.min(cheapest, hopS + o.travelS + o.dwellS);
    }
    const fromSql = answer.minPrunedLowerBoundS ?? Number.POSITIVE_INFINITY;
    const need = Math.min(cheapest, fromSql);
    return {
      ok: false,
      reason: 'infeasible',
      shortfallS: Number.isFinite(need) ? Math.max(1, need - capacityS) : 1,
      missing: book.missingCells(),
    };
  }

  const segments: PlanSegment[] = [];
  let transferS = 0;
  let chapterTravelS = 0;
  let dwellS = 0;
  let deepDiveExtraS = 0;
  let legsTotal = 0;
  let legsEstimated = 0;
  let droppedHighValue = 0;
  let previous: Candidate | null = null;
  const chapters: PlanDraft['chapters'] = [];
  const planCells: MissingCell[] = [];

  result.chapters.forEach((p: PlannedChapter) => {
    const c = p.model.candidate;
    const transfer: TransferSegment = {
      kind: 'transfer',
      // The origin is never written into a plan: tour_plans.plan is stored.
      from: previous === null
        ? { kind: 'origin' }
        : { kind: 'chapter_exit', chapter_id: previous.chapterId, point: { lon: previous.exit[0], lat: previous.exit[1] } },
      to_chapter_id: c.chapterId,
      to: { lon: c.entry[0], lat: c.entry[1] },
      mode: request.transit_mode,
      duration_s: p.hop.seconds,
      distance_m: p.hop.cost.distanceM,
      cost_source: p.hop.cost.source,
      // Decided here, like get_tour_bundle's providers: a transfer has no
      // anchors, so Waze is offered only for driving.
      providers: request.transit_mode === 'driving' ? ['google_maps', 'waze'] : ['google_maps'],
    };
    segments.push(transfer);
    if (previous !== null && p.hop.cost.source === 'estimated') {
      planCells.push(...book.missingCells().filter((m) => m.kind === 'transfer' && m.fromChapterId === previous!.chapterId && m.toChapterId === c.chapterId));
    }

    const kept = new Set(p.option.keptIds);
    // With unlimited time the chapter takes its highest-value option; what that
    // keeps and this plan does not was dropped strictly for lack of time. The
    // DEDUPLICATED curve: an extension another chapter already covers was not
    // dropped for time, so it must not drive the "add more time" upsell.
    const unlimited = p.options[p.options.length - 1]!;
    const weightOf = new Map(c.stops.map((s) => [s.waypointId, s.matchedWeight]));
    droppedHighValue += unlimited.keptIds.filter((id) => !kept.has(id) && (weightOf.get(id) ?? 0) >= HIGH_VALUE_WEIGHT).length;
    const waypointIds = c.stops.filter((s) => s.stopRole === 'core' || kept.has(s.waypointId)).map((s) => s.waypointId);
    const chapter: ChapterSegment = {
      kind: 'chapter',
      tour_id: c.tourId,
      chapter_id: c.chapterId,
      transit_mode: c.transitMode,
      // Contract: always every core stop, plus the kept extensions, authored order.
      waypoint_ids: waypointIds,
      kept_extension_ids: [...p.option.keptIds],
      dropped_extension_ids: extensionIds(c).filter((id) => !kept.has(id)),
      // v4: duplicate places an earlier chapter already narrates. Still planned
      // (walked through), with ZERO dwell: dwell_s below already excludes them.
      silent_stop_ids: [...p.silentIds],
      travel_s: p.option.travelS,
      dwell_s: p.option.dwellS,
      cost_source: p.option.estimatedLegs > 0 ? 'estimated' : 'valhalla',
    };
    segments.push(chapter);

    // Legs of this chapter's chosen path that were estimated: first in line for enrichment.
    const path = ['entry', ...waypointIds, 'exit'];
    for (let i = 0; i + 1 < path.length; i++) {
      const key = `leg|${c.chapterId}|${path[i]}|${path[i + 1]}|${c.profile}`;
      const cell = book.missingCells().find((m) => missingCellKey(m) === key);
      if (cell) planCells.push(cell);
    }

    if (coreIds(c).some((id) => !waypointIds.includes(id))) {
      throw new Error(`planner invariant broken: chapter ${c.chapterId} dropped a core stop`);
    }

    transferS += p.hop.seconds;
    chapterTravelS += p.option.travelS;
    dwellS += p.option.dwellS;
    deepDiveExtraS += p.option.deepDiveExtraS;
    legsTotal += 1 + p.option.legs;
    legsEstimated += (p.hop.cost.source === 'estimated' ? 1 : 0) + p.option.estimatedLegs;
    chapters.push({ chapterId: c.chapterId, tourId: c.tourId, waypointIds, silentStopIds: [...p.silentIds], entry: c.entry, exit: c.exit });
    previous = c;
  });

  const totalS = transferS + chapterTravelS + dwellS;
  if (totalS !== result.totalS || totalS > capacityS) {
    throw new Error(`planner invariant broken: total ${totalS} vs search ${result.totalS}, capacity ${capacityS}`);
  }

  return {
    ok: true,
    draft: {
      segments,
      estimate: {
        budget_s: budgetS,
        total_s: totalS,
        transfer_s: transferS,
        chapter_travel_s: chapterTravelS,
        dwell_s: dwellS,
        deep_dive_extra_s: deepDiveExtraS,
        slack_s: budgetS - totalS,
        pace_factor: pace,
      },
      legsTotal,
      legsEstimated,
      searchTruncated: result.truncated,
      droppedHighValueExtensions: droppedHighValue,
      chapters,
    },
    missing: book.missingCells(),
    planCells,
  };
}

/**
 * The cells ONE background execution may fill (PM: at most MAX_FILL_CELLS).
 *
 * Valhalla is asked ONCE, with a route through up to MAX_FILL_CELLS + 1
 * points: its legs ARE the cells. So the chosen cells form a chain in one
 * chapter and profile - a -> b, b -> c, ... - or are a single transfer.
 * Priority: the cells the returned plan relied on, then every other missing
 * cell in key order. Gradual: the next request enriches the next chain.
 */
export function chooseFillChain(planCells: readonly MissingCell[], missing: readonly MissingCell[]): MissingCell[] {
  const seen = new Set<string>();
  const queue: MissingCell[] = [];
  for (const c of [...planCells, ...missing]) {
    const k = missingCellKey(c);
    if (!seen.has(k)) {
      seen.add(k);
      queue.push(c);
    }
  }
  const seed = queue[0];
  if (!seed) return [];
  if (seed.kind === 'transfer') return [seed];

  const chain: MissingCell[] = [seed];
  let tail = seed;
  while (chain.length < MAX_FILL_CELLS) {
    const next = queue.find(
      (c): c is Extract<MissingCell, { kind: 'leg' }> =>
        c.kind === 'leg' && c.chapterId === tail.chapterId && c.profile === tail.profile && c.fromNode === tail.toNode
        && !chain.some((x) => missingCellKey(x) === missingCellKey(c)),
    );
    if (!next) break;
    chain.push(next);
    tail = next;
  }
  return chain;
}
