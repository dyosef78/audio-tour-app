/**
 * Every travel cost the planner uses, from ONE place. Three outcomes per cell:
 *
 *   valhalla    a cached row whose coords_key matches the points just loaded
 *   unroutable  a cached row with duration NULL: Valhalla found no route,
 *               so that hop is forbidden (until a point moves)
 *   estimated   no row, or a stale one: straight line x DETOUR_FACTOR at a
 *               realistic speed. Flagged, never stored, and recorded as
 *               MISSING so the background fill can enrich it later
 *
 * The request path never calls Valhalla. The origin transfer is always
 * estimated: an arbitrary GPS fix has no cache key.
 */

import { distanceMeters } from '../distance.ts';
import { coordsKey } from '../routing/coordsKey.ts';
import type { ValhallaProfile } from '../routing/valhalla.ts';
import type { TransitMode } from '../contracts/planTour.ts';
import type { Candidate, LegRow, Pair, PlannerCandidates, TransferRow } from './candidates.ts';
import { DETOUR_FACTOR, ESTIMATE_SPEED_MPS } from './constants.ts';

export type CostSource = 'valhalla' | 'estimated';

export interface Cost {
  /** Whole seconds at the profile's modelled speed - no pace factor applied. */
  durationS: number;
  distanceM: number;
  source: CostSource;
}

/** A cell the cache lacks, as the background fill needs it. */
export type MissingCell =
  | { kind: 'leg'; chapterId: string; profile: ValhallaProfile; fromNode: string; toNode: string; from: Pair; to: Pair }
  | { kind: 'transfer'; fromChapterId: string; toChapterId: string; profile: ValhallaProfile; from: Pair; to: Pair };

export const UNROUTABLE = 'unroutable' as const;

const point = ([lon, lat]: Pair) => ({ lon, lat });

export function estimateCost(from: Pair, to: Pair, mode: TransitMode): Cost {
  const crow = distanceMeters({ lng: from[0], lat: from[1] }, { lng: to[0], lat: to[1] });
  const distanceM = Math.round(crow * DETOUR_FACTOR);
  return { durationS: Math.ceil(distanceM / ESTIMATE_SPEED_MPS[mode]), distanceM, source: 'estimated' };
}

export function missingCellKey(c: MissingCell): string {
  return c.kind === 'leg'
    ? `leg|${c.chapterId}|${c.fromNode}|${c.toNode}|${c.profile}`
    : `transfer|${c.fromChapterId}|${c.toChapterId}|${c.profile}`;
}

export class CostBook {
  readonly #legs = new Map<string, LegRow>();
  readonly #transfers = new Map<string, TransferRow>();
  readonly #chapters = new Map<string, Candidate>();
  readonly #missing = new Map<string, MissingCell>();
  readonly #transferProfile: ValhallaProfile;
  readonly #transferMode: TransitMode;

  constructor(answer: PlannerCandidates, transferMode: TransitMode) {
    this.#transferProfile = answer.transferProfile;
    this.#transferMode = transferMode;
    for (const c of answer.candidates) this.#chapters.set(c.chapterId, c);
    for (const l of answer.legs) this.#legs.set(`${l.chapterId}|${l.fromNode}|${l.toNode}`, l);
    for (const t of answer.transfers) this.#transfers.set(`${t.fromChapterId}|${t.toChapterId}`, t);
  }

  /** Coordinates of 'entry' | 'exit' | a waypoint id within a chapter. */
  nodePoint(chapter: Candidate, node: string): Pair {
    if (node === 'entry') return chapter.entry;
    if (node === 'exit') return chapter.exit;
    const stop = chapter.stops.find((s) => s.waypointId === node);
    if (!stop) throw new RangeError(`chapter ${chapter.chapterId} has no node ${node}`);
    return stop.coordinates;
  }

  /** Travel inside a chapter, in the chapter's own profile. */
  leg(chapter: Candidate, fromNode: string, toNode: string): Cost | typeof UNROUTABLE {
    const from = this.nodePoint(chapter, fromNode);
    const to = this.nodePoint(chapter, toNode);
    const row = this.#legs.get(`${chapter.chapterId}|${fromNode}|${toNode}`);
    // Rows come filtered to the chapter's profile by the SQL.
    const resolved = this.#resolve(row, from, to);
    if (resolved !== null) return resolved;
    const cell: MissingCell = { kind: 'leg', chapterId: chapter.chapterId, profile: chapter.profile, fromNode, toNode, from, to };
    this.#missing.set(missingCellKey(cell), cell);
    return estimateCost(from, to, chapter.transitMode);
  }

  /** exit(from) -> entry(to) in the TRANSFER profile. */
  transfer(fromChapterId: string, toChapterId: string): Cost | typeof UNROUTABLE {
    const a = this.#chapter(fromChapterId);
    const b = this.#chapter(toChapterId);
    const row = this.#transfers.get(`${fromChapterId}|${toChapterId}`);
    const resolved = this.#resolve(row, a.exit, b.entry);
    if (resolved !== null) return resolved;
    const cell: MissingCell = { kind: 'transfer', fromChapterId, toChapterId, profile: this.#transferProfile, from: a.exit, to: b.entry };
    this.#missing.set(missingCellKey(cell), cell);
    return estimateCost(a.exit, b.entry, this.#transferMode);
  }

  /** origin -> entry(to): never cached. */
  fromOrigin(origin: Pair, toChapterId: string): Cost {
    return estimateCost(origin, this.#chapter(toChapterId).entry, this.#transferMode);
  }

  /** Every cell looked up and not found, in deterministic key order. */
  missingCells(): MissingCell[] {
    return [...this.#missing.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, c]) => c);
  }

  #chapter(id: string): Candidate {
    const c = this.#chapters.get(id);
    if (!c) throw new RangeError(`unknown chapter ${id}`);
    return c;
  }

  /** null = treat as missing (absent, or stale coords_key). */
  #resolve(row: LegRow | TransferRow | undefined, from: Pair, to: Pair): Cost | typeof UNROUTABLE | null {
    if (!row || row.coordsKey !== coordsKey(point(from), point(to))) return null;
    if (row.durationS === null || row.distanceM === null) return UNROUTABLE;
    return { durationS: row.durationS, distanceM: row.distanceM, source: 'valhalla' };
  }
}
