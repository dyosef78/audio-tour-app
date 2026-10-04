import type { ChapterSegment, PlanTourOk, TransferSegment } from '../../../shared/src/contracts/planTour.ts';
import type { WireBundle, WireChapter, WireWaypoint } from '../services/bundle/types.ts';
import { plainChapter, toApproach, toChapter, toZone } from './fromManifest.ts';
import type { EngineChapter, EngineStop, EngineTour } from './types.ts';

/**
 * A server plan -> the tour as the engine sees it (Epic 16 Part 4).
 *
 * Pure. The plan's segments alternate transfer, chapter, transfer, chapter.
 *
 *   transfer  becomes a SYNTHETIC chapter: id `transfer:<to_chapter_id>`, no
 *             stops, its destination the next chapter's entry point. The Epic
 *             15 machinery does the rest unchanged - the panel offers the
 *             navigation handoff, arrival detection raises CHAPTER_ARRIVED
 *             near the entry, and the visitor starts the next chapter by hand.
 *   chapter   is the authored chapter from its own tour's manifest (mode,
 *             sequencing, its own handoff), running exactly the plan's
 *             waypoint_ids, renumbered 0..n-1 so the window counts only stops
 *             this visitor will hear.
 *
 * NOTHING IS GUESSED. planProblem() checks the plan against the downloaded
 * bundles before anything runs, and engineTourFromPlan refuses (RangeError)
 * whatever it reports. A plan that disagrees with the device's bundles is
 * stale; it is never repaired, filtered or silently replaced by a catalogue
 * session.
 */

export const TRANSFER_CHAPTER_PREFIX = 'transfer:';

export const isTransferChapter = (chapterId: string): boolean => chapterId.startsWith(TRANSFER_CHAPTER_PREFIX);

const chapters = (plan: PlanTourOk) => plan.segments.filter((s): s is ChapterSegment => s.kind === 'chapter');

function wireChapterOf(manifest: WireBundle, chapterId: string): WireChapter | undefined {
  return (manifest.chapters ?? [plainChapter(manifest)]).find((c) => c.chapter_id === chapterId);
}

const chapterOfStop = (manifest: WireBundle, w: WireWaypoint): string => w.chapter_id ?? manifest.tour_metadata.tour_id;

/**
 * Why this plan cannot run on these bundles, or null when it can. Checks,
 * in order:
 *   * every pinned source is downloaded at EXACTLY the pinned bundle hash
 *   * every chapter exists in its tour's manifest
 *   * every planned stop exists, belongs to that chapter, and has a zone
 *   * the planned stops are in authored order
 *   * EVERY core stop of the chapter is planned (core means core)
 *   * kept + dropped are exactly the chapter's extensions, and the planned
 *     extensions are exactly the kept ones
 */
export function planProblem(plan: PlanTourOk, manifests: ReadonlyMap<string, WireBundle>): string | null {
  for (const s of plan.sources) {
    const m = manifests.get(s.tour_id);
    if (!m) return `tour ${s.tour_id} is not downloaded`;
    if (m.bundle_version_hash !== s.bundle_version_hash) return `tour ${s.tour_id} is downloaded at a different version than the plan was made for`;
  }
  for (const c of chapters(plan)) {
    const m = manifests.get(c.tour_id)!;
    if (!wireChapterOf(m, c.chapter_id)) return `chapter ${c.chapter_id} is not in tour ${c.tour_id}`;
    const inChapter = m.waypoints.filter((w) => chapterOfStop(m, w) === c.chapter_id);
    const byId = new Map(inChapter.map((w) => [w.waypoint_id, w]));

    let lastOrder = Number.NEGATIVE_INFINITY;
    for (const id of c.waypoint_ids) {
      const w = byId.get(id);
      if (!w) return `stop ${id} is not in chapter ${c.chapter_id}`;
      if (w.geofence === null) return `stop ${id} has no geofence`;
      if (w.sort_order <= lastOrder) return `chapter ${c.chapter_id}: stops are not in authored order`;
      lastOrder = w.sort_order;
    }
    const planned = new Set(c.waypoint_ids);
    const role = (w: WireWaypoint) => w.stop_role ?? 'core';
    const missingCore = inChapter.find((w) => role(w) === 'core' && !planned.has(w.waypoint_id));
    if (missingCore) return `chapter ${c.chapter_id} leaves out core stop ${missingCore.waypoint_id}`;

    const extensions = inChapter.filter((w) => role(w) === 'extension').map((w) => w.waypoint_id).sort();
    const partition = [...c.kept_extension_ids, ...c.dropped_extension_ids].sort();
    if (JSON.stringify(partition) !== JSON.stringify(extensions)) return `chapter ${c.chapter_id}: kept + dropped is not the chapter's extensions`;
    const plannedExtensions = c.waypoint_ids.filter((id) => role(byId.get(id)!) === 'extension').sort();
    if (JSON.stringify(plannedExtensions) !== JSON.stringify([...c.kept_extension_ids].sort())) {
      return `chapter ${c.chapter_id}: the planned extensions are not the kept ones`;
    }
  }
  return null;
}

export function engineTourFromPlan(plan: PlanTourOk, manifests: ReadonlyMap<string, WireBundle>): EngineTour {
  const problem = planProblem(plan, manifests);
  if (problem !== null) throw new RangeError(`plan ${plan.plan_id} cannot run: ${problem}`);

  const engineChapters: EngineChapter[] = [];
  const stops: EngineStop[] = [];
  plan.segments.forEach((segment, sortOrder) => {
    if (segment.kind === 'transfer') {
      engineChapters.push(transferChapter(segment, sortOrder));
      return;
    }
    const m = manifests.get(segment.tour_id)!;
    // The authored chapter, in PLAN order.
    engineChapters.push({ ...toChapter(wireChapterOf(m, segment.chapter_id)!), sortOrder });
    const byId = new Map(m.waypoints.map((w) => [w.waypoint_id, w]));
    segment.waypoint_ids.forEach((id, index) => {
      const w = byId.get(id)!;
      stops.push({ id, chapterId: segment.chapter_id, index, zone: toZone(w), approach: toApproach(w) });
    });
  });
  return { chapters: engineChapters, stops };
}

function transferChapter(t: TransferSegment, sortOrder: number): EngineChapter {
  return {
    id: `${TRANSFER_CHAPTER_PREFIX}${t.to_chapter_id}`,
    sortOrder,
    transitMode: t.mode,
    // No stops: the policy is moot, but strict/1 is the plainest truthful value.
    sequencePolicy: 'strict',
    lookaheadStops: 1,
    destination: { latitude: t.to.lat, longitude: t.to.lon },
  };
}

/**
 * The chapter list the panel shows (titles, navigation handoff), in plan
 * order: a "Travel to ..." chapter for each transfer - handed off with the
 * plan's providers and no anchors - then the authored chapter.
 */
export function planChapters(plan: PlanTourOk, manifests: ReadonlyMap<string, WireBundle>): WireChapter[] {
  const out: WireChapter[] = [];
  plan.segments.forEach((segment, i) => {
    if (segment.kind === 'transfer') {
      const next = plan.segments[i + 1] as ChapterSegment;
      const m = manifests.get(next.tour_id)!;
      const target = wireChapterOf(m, next.chapter_id)!;
      const name = target.title ?? m.tour_metadata.title;
      out.push({
        chapter_id: `${TRANSFER_CHAPTER_PREFIX}${segment.to_chapter_id}`,
        sort_order: i,
        title: `Travel to ${name}`,
        transit_mode: segment.mode,
        sequence_policy: 'strict',
        lookahead_stops: 1,
        handoff: { destination: [segment.to.lon, segment.to.lat], destination_label: name, anchors: [], providers: [...segment.providers] },
      });
      return;
    }
    const m = manifests.get(segment.tour_id)!;
    const c = wireChapterOf(m, segment.chapter_id)!;
    out.push({ ...c, sort_order: i, title: c.title ?? m.tour_metadata.title });
  });
  return out;
}
