/**
 * The cost reconciler's arithmetic (Epic 16 Part 4): which cells a city NEEDS,
 * and which of those the cache lacks. Pure; warm-costs does the I/O.
 *
 * NEEDED, derived from current state only:
 *   legs       per plannable chapter, in its own profile. The chapter splits
 *              into slots at its mandatory nodes (entry, core stops, exit);
 *              within a slot [L, e1..ek, R] every forward pair - exactly the
 *              legs chapterOptions may read. A slot without extensions needs
 *              only L -> R.
 *   transfers  exit(A) -> entry(B) for ordered pairs of plannable chapters, in
 *              each transfer profile whose visitors could take BOTH chapters
 *              (pedestrian: walking chapters; bicycle: walking + biking;
 *              auto: walking + driving), within TRANSFER_RADIUS_M.
 *
 * PRESENT: a row whose coords_key matches (shared formatter). A row with a
 * stale key is MISSING. An unroutable row is present: never asked again.
 *
 * ORDER (deterministic): legs first - every plan uses them - by chapter, in
 * authored order, so consecutive legs chain into one Valhalla request; then
 * transfers, nearest pairs first (the likeliest to be planned).
 */

import { distanceMeters } from '../distance.ts';
import { coordsKey } from '../routing/coordsKey.ts';
import type { ValhallaProfile } from '../routing/valhalla.ts';
import type { TransitMode } from '../contracts/planTour.ts';
import type { Pair } from './candidates.ts';
import { missingCellKey, type MissingCell } from './costBook.ts';

/** Straight-line reach of a transfer worth caching. Beyond it the estimate serves. */
export const TRANSFER_RADIUS_M: Readonly<Record<ValhallaProfile, number>> = {
  pedestrian: 5_000,
  bicycle: 15_000,
  auto: 80_000,
};

const CHAPTER_MODES_FOR: Readonly<Record<ValhallaProfile, readonly TransitMode[]>> = {
  pedestrian: ['walking'],
  bicycle: ['walking', 'biking'],
  auto: ['walking', 'driving'],
};

export interface WarmChapter {
  chapterId: string;
  transitMode: TransitMode;
  profile: ValhallaProfile;
  entry: Pair;
  exit: Pair;
  stops: { waypointId: string; sortOrder: number; stopRole: 'core' | 'extension'; coordinates: Pair }[];
}

interface CachedRow {
  key: string;
  coordsKey: string;
}

export interface WarmState {
  chapters: WarmChapter[];
  legs: CachedRow[];
  transfers: CachedRow[];
}

export class WarmStateShapeError extends Error {
  override readonly name = 'WarmStateShapeError';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
function fail(w: string): never {
  throw new WarmStateShapeError(`get_warm_state: unexpected ${w}`);
}
const pair = (v: unknown, w: string): Pair =>
  Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0] as number, v[1] as number] : fail(w);
const str = (o: Obj, k: string, w: string): string => (typeof o[k] === 'string' ? (o[k] as string) : fail(`${w}.${k}`));
const PROFILES: ReadonlySet<string> = new Set(['pedestrian', 'bicycle', 'auto']);
const MODES: ReadonlySet<string> = new Set(['walking', 'biking', 'driving']);

export function parseWarmState(raw: unknown): WarmState {
  if (!isObj(raw)) fail('answer');
  const arr = (k: string): unknown[] => (Array.isArray((raw as Obj)[k]) ? ((raw as Obj)[k] as unknown[]) : fail(k));
  const chapters = arr('chapters').map((c, i): WarmChapter => {
    const w = `chapters[${i}]`;
    if (!isObj(c)) fail(w);
    const mode = str(c, 'transit_mode', w);
    const profile = str(c, 'profile', w);
    if (!MODES.has(mode) || !PROFILES.has(profile)) fail(`${w}.mode/profile`);
    const stops = (Array.isArray(c.stops) ? c.stops : fail(`${w}.stops`)).map((s, j) => {
      const ws = `${w}.stops[${j}]`;
      if (!isObj(s)) fail(ws);
      const role = str(s, 'stop_role', ws);
      if (role !== 'core' && role !== 'extension') fail(`${ws}.stop_role`);
      if (typeof s.sort_order !== 'number') fail(`${ws}.sort_order`);
      return { waypointId: str(s, 'waypoint_id', ws), sortOrder: s.sort_order as number, stopRole: role as 'core' | 'extension', coordinates: pair(s.coordinates, `${ws}.coordinates`) };
    });
    return { chapterId: str(c, 'chapter_id', w), transitMode: mode as TransitMode, profile: profile as ValhallaProfile, entry: pair(c.entry, `${w}.entry`), exit: pair(c.exit, `${w}.exit`), stops };
  });
  const legs = arr('legs').map((l, i): CachedRow => {
    if (!isObj(l)) fail(`legs[${i}]`);
    const w = `legs[${i}]`;
    return { key: `leg|${str(l as Obj, 'chapter_id', w)}|${str(l as Obj, 'from_node', w)}|${str(l as Obj, 'to_node', w)}|${str(l as Obj, 'profile', w)}`, coordsKey: str(l as Obj, 'coords_key', w) };
  });
  const transfers = arr('transfers').map((t, i): CachedRow => {
    if (!isObj(t)) fail(`transfers[${i}]`);
    const w = `transfers[${i}]`;
    return { key: `transfer|${str(t as Obj, 'from_chapter_id', w)}|${str(t as Obj, 'to_chapter_id', w)}|${str(t as Obj, 'profile', w)}`, coordsKey: str(t as Obj, 'coords_key', w) };
  });
  return { chapters, legs, transfers };
}

const pt = ([lon, lat]: Pair) => ({ lon, lat });

/** Every cell the city needs, in fill order. */
export function neededCells(state: WarmState): MissingCell[] {
  const legs: MissingCell[] = [];
  for (const c of [...state.chapters].sort((a, b) => (a.chapterId < b.chapterId ? -1 : 1))) {
    const stops = [...c.stops].sort((a, b) => a.sortOrder - b.sortOrder);
    const node = (id: string, at: Pair) => ({ id, at });
    const slots: { id: string; at: Pair }[][] = [[node('entry', c.entry)]];
    for (const s of stops) {
      slots[slots.length - 1]!.push(node(s.waypointId, s.coordinates));
      if (s.stopRole === 'core') slots.push([node(s.waypointId, s.coordinates)]);
    }
    slots[slots.length - 1]!.push(node('exit', c.exit));
    for (const slot of slots) {
      // slot = [L, e1..ek, R]; every forward pair. With k = 0 that is just L -> R.
      for (let i = 0; i < slot.length; i++) {
        for (let j = i + 1; j < slot.length; j++) {
          legs.push({ kind: 'leg', chapterId: c.chapterId, profile: c.profile, fromNode: slot[i]!.id, toNode: slot[j]!.id, from: slot[i]!.at, to: slot[j]!.at });
        }
      }
    }
  }

  const transfers: { cell: MissingCell; metres: number }[] = [];
  for (const profile of ['pedestrian', 'bicycle', 'auto'] as const) {
    const eligible = state.chapters.filter((c) => CHAPTER_MODES_FOR[profile].includes(c.transitMode));
    for (const a of eligible) {
      for (const b of eligible) {
        if (a.chapterId === b.chapterId) continue;
        const metres = distanceMeters({ lng: a.exit[0], lat: a.exit[1] }, { lng: b.entry[0], lat: b.entry[1] });
        if (metres > TRANSFER_RADIUS_M[profile]) continue;
        transfers.push({ cell: { kind: 'transfer', fromChapterId: a.chapterId, toChapterId: b.chapterId, profile, from: a.exit, to: b.entry }, metres });
      }
    }
  }
  transfers.sort((x, y) => x.metres - y.metres || (missingCellKey(x.cell) < missingCellKey(y.cell) ? -1 : 1));
  return [...legs, ...transfers.map((t) => t.cell)];
}

export interface Reconciliation {
  needed: { legs: number; transfers: number };
  missing: MissingCell[];
}

/** Needed minus present (a present row's coords_key must match today's points). */
export function reconcile(state: WarmState): Reconciliation {
  const present = new Map<string, string>();
  for (const r of [...state.legs, ...state.transfers]) present.set(r.key, r.coordsKey);
  const needed = neededCells(state);
  const missing = needed.filter((c) => present.get(missingCellKey(c)) !== coordsKey(pt(c.from), pt(c.to)));
  return {
    needed: { legs: needed.filter((c) => c.kind === 'leg').length, transfers: needed.filter((c) => c.kind === 'transfer').length },
    missing,
  };
}
