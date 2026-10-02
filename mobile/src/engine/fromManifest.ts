import type { WireBundle, WireChapter, WireWaypoint } from '../services/bundle/types.ts';
import type { LatLng, TransitMode } from '../types/domain.ts';
import type { EngineApproach, EngineChapter, EngineStop, EngineTour, EngineZone, SequencePolicy } from './types.ts';

/**
 * Downloaded manifest -> the tour as the engine sees it (Epic 15).
 *
 * Pure. Fails loudly (RangeError) on anything it cannot represent faithfully -
 * an unknown transit mode or policy from a newer server, a stop the session
 * names that the manifest lacks, a radius zone with no radius. The caller
 * refuses to start (or resume) rather than run a tour that is not the one
 * authored.
 */

/**
 * What a manifest saved before 20261001120100 means: ONE chapter whose id is
 * the tour id, in the tour's transit mode, with these settings. They are also
 * the database column defaults and the values get_tour_bundle treats as
 * "plain" when hashing - test-cms pins all three together.
 */
export const PLAIN_CHAPTER_DEFAULTS = { sequencePolicy: 'windowed', lookaheadStops: 3 } as const;

const TRANSIT_MODES: readonly TransitMode[] = ['walking', 'biking', 'driving'];
const SEQUENCE_POLICIES: readonly SequencePolicy[] = ['strict', 'windowed'];

/**
 * @param activeIds the stops THIS session runs (preference selection,
 *   TASK-604), in any order. Their index within each chapter follows the
 *   authored sort_order, renumbered 0..n-1 so the window never counts a stop
 *   this visitor will not hear.
 */
export function engineTourFromManifest(manifest: WireBundle, activeIds: readonly string[]): EngineTour {
  const tourId = manifest.tour_metadata.tour_id;
  const wireChapters: readonly WireChapter[] = manifest.chapters ?? [plainChapter(manifest)];
  const chapters = [...wireChapters].sort((a, b) => a.sort_order - b.sort_order).map(toChapter);

  const byId = new Map(manifest.waypoints.map((w) => [w.waypoint_id, w]));
  const missing = activeIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new RangeError(`manifest has no stop ${missing.join(', ')}`);

  const active = new Set(activeIds);
  const stops: EngineStop[] = [];
  for (const chapter of chapters) {
    const inChapter = manifest.waypoints
      .filter((w) => active.has(w.waypoint_id) && (w.chapter_id ?? tourId) === chapter.id)
      // A stop with no zone can never fire, and leaving it in would hold the
      // window on it forever. cms_validate_tour refuses to publish one.
      .filter((w) => w.geofence !== null)
      .sort((a, b) => a.sort_order - b.sort_order);
    inChapter.forEach((w, index) => {
      stops.push({ id: w.waypoint_id, chapterId: chapter.id, index, zone: toZone(w), approach: toApproach(w) });
    });
  }
  return { chapters, stops };
}

/** Chapters as the UI lists them (titles, handoff) - sorted, unknown providers dropped. */
export function chaptersOf(manifest: WireBundle): WireChapter[] {
  return [...(manifest.chapters ?? [plainChapter(manifest)])]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((c) =>
      c.handoff === null
        ? c
        : { ...c, handoff: { ...c.handoff, providers: c.handoff.providers.filter((p) => p === 'google_maps' || p === 'waze') } },
    );
}

function plainChapter(manifest: WireBundle): WireChapter {
  return {
    chapter_id: manifest.tour_metadata.tour_id,
    sort_order: 0,
    title: null,
    transit_mode: manifest.tour_metadata.transit_mode,
    sequence_policy: PLAIN_CHAPTER_DEFAULTS.sequencePolicy,
    lookahead_stops: PLAIN_CHAPTER_DEFAULTS.lookaheadStops,
    handoff: null,
  };
}

function toChapter(c: WireChapter): EngineChapter {
  if (!TRANSIT_MODES.includes(c.transit_mode as TransitMode)) {
    throw new RangeError(`chapter ${c.chapter_id}: unknown transit mode '${c.transit_mode}'`);
  }
  if (!SEQUENCE_POLICIES.includes(c.sequence_policy as SequencePolicy)) {
    throw new RangeError(`chapter ${c.chapter_id}: unknown sequence policy '${c.sequence_policy}'`);
  }
  if (!Number.isInteger(c.lookahead_stops) || c.lookahead_stops < 1) {
    throw new RangeError(`chapter ${c.chapter_id}: lookahead_stops must be a positive integer, got ${c.lookahead_stops}`);
  }
  return {
    id: c.chapter_id,
    sortOrder: c.sort_order,
    transitMode: c.transit_mode as TransitMode,
    sequencePolicy: c.sequence_policy as SequencePolicy,
    lookaheadStops: c.lookahead_stops,
    destination: c.handoff === null ? null : lonLat(c.handoff.destination),
  };
}

const lonLat = (p: readonly [number, number] | readonly number[]): LatLng => {
  const [longitude, latitude] = p;
  if (longitude === undefined || latitude === undefined) throw new RangeError('coordinate pair is incomplete');
  return { latitude, longitude };
};

function toZone(w: WireWaypoint): EngineZone {
  const g = w.geofence;
  if (g === null) throw new RangeError(`stop ${w.waypoint_id}: no geofence`);
  if (g.type === 'radius') {
    if (g.radius_meters === null || !(g.radius_meters > 0)) {
      throw new RangeError(`stop ${w.waypoint_id}: radius zone without a radius`);
    }
    return { kind: 'radius', center: lonLat(g.center), radiusM: g.radius_meters };
  }
  return { kind: 'polygon', ring: g.ring.map(lonLat) };
}

function toApproach(w: WireWaypoint): EngineApproach | null {
  const a = w.approach;
  if (a === undefined || a === null) return null;
  if (a.policy !== 'required' && a.policy !== 'preferred') {
    throw new RangeError(`stop ${w.waypoint_id}: unknown approach policy '${a.policy}'`);
  }
  return { bearingDeg: a.bearing_deg, toleranceDeg: a.tolerance_deg, policy: a.policy };
}
