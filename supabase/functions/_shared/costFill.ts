/**
 * The ONE way any function writes planner costs from Valhalla (Epic 16):
 * plan-tour's background fill and warm-costs both go through here.
 *
 * Strict bounds (PM, 4 Oct 2026), checked here rather than trusted:
 *   * at most MAX_FILL_CELLS cells per call
 *   * exactly ONE Valhalla /route request, through the chain's points - its
 *     legs ARE the cells, so the chain must be one contiguous path
 *   * a budget token first (takeToken: the caller's sub-bucket AND the shared
 *     valhalla:global bucket); no token, no request
 *   * no retry, ever: a failure is reported and the next caller tries again
 *
 * Writes carry coords_key from the shared formatter, so a row written for a
 * point the CMS has since moved is simply ignored by every reader.
 */

import { MAX_FILL_CELLS, type MissingCell } from '@shared/planner/index.ts';
import { coordsKey } from '@shared/routing/coordsKey.ts';
import { isRoutingError, type LonLat, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';

export interface LegCostWrite {
  chapterId: string;
  fromNode: string;
  toNode: string;
  profile: ValhallaProfile;
  durationS: number | null;
  distanceM: number | null;
  coordsKey: string;
}

export interface TransferCostWrite {
  fromChapterId: string;
  toChapterId: string;
  profile: ValhallaProfile;
  durationS: number | null;
  distanceM: number | null;
  coordsKey: string;
}

export interface FillDeps {
  /** A budget token (caller's sub-bucket + valhalla:global). false = do not call Valhalla. */
  takeToken(): Promise<boolean>;
  route(locations: LonLat[], profile: ValhallaProfile): Promise<ValhallaRoute>;
  saveLegs(rows: LegCostWrite[]): Promise<void>;
  saveTransfers(rows: TransferCostWrite[]): Promise<void>;
}

/**
 *   filled         cells written (some may be stored as unroutable)
 *   no_token       the budget said no; nothing was requested
 *   routing_error  Valhalla failed or was rate limited; nothing written
 *   mismatch       Valhalla answered with the wrong number of legs; nothing written
 *   empty          nothing to do
 */
export type FillOutcome = 'filled' | 'no_token' | 'routing_error' | 'mismatch' | 'empty';

export async function fillMissingCosts(
  chain: readonly MissingCell[],
  fill: FillDeps,
  log: (event: Record<string, unknown>) => void,
): Promise<FillOutcome> {
  if (chain.length === 0) return 'empty';
  if (chain.length > MAX_FILL_CELLS) throw new Error(`fill chain of ${chain.length} cells exceeds ${MAX_FILL_CELLS}`);
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!;
    const b = chain[i]!;
    if (a.kind !== 'leg' || b.kind !== 'leg' || a.chapterId !== b.chapterId || a.toNode !== b.fromNode || a.profile !== b.profile) {
      throw new Error('fill chain is not one contiguous path');
    }
  }
  if (!(await fill.takeToken())) {
    log({ event: 'cost_fill_skipped', reason: 'no_budget_token', cells: chain.length });
    return 'no_token';
  }

  const first = chain[0]!;
  const locations: LonLat[] = [first.from, ...chain.map((c) => c.to)].map(([lon, lat]) => [lon, lat] as LonLat);
  let durations: (number | null)[];
  let distances: (number | null)[];
  try {
    const route = await fill.route(locations, first.profile);
    if (route.legs.length !== chain.length) {
      log({ event: 'cost_fill_mismatch', legs: route.legs.length, cells: chain.length });
      return 'mismatch';
    }
    durations = route.legs.map((l) => l.durationSeconds);
    distances = route.legs.map((l) => l.distanceMeters);
  } catch (cause) {
    // Only a SINGLE-cell "no route" is attributable to one pair: store it as
    // unroutable so it is never asked again (until a point moves). For a
    // longer chain we cannot tell which hop failed, so nothing is written.
    if (isRoutingError(cause) && cause.code === 'unroutable' && chain.length === 1) {
      durations = [null];
      distances = [null];
    } else {
      log({ event: 'cost_fill_routing_error', code: isRoutingError(cause) ? cause.code : 'unknown', cells: chain.length });
      return 'routing_error';
    }
  }

  const key = (c: MissingCell) => coordsKey({ lon: c.from[0], lat: c.from[1] }, { lon: c.to[0], lat: c.to[1] });
  if (first.kind === 'transfer') {
    await fill.saveTransfers([{
      fromChapterId: first.fromChapterId, toChapterId: first.toChapterId, profile: first.profile,
      durationS: durations[0] ?? null, distanceM: distances[0] ?? null, coordsKey: key(first),
    }]);
  } else {
    await fill.saveLegs(chain.map((c, i) => {
      const leg = c as Extract<MissingCell, { kind: 'leg' }>;
      return {
        chapterId: leg.chapterId, fromNode: leg.fromNode, toNode: leg.toNode, profile: leg.profile,
        durationS: durations[i] ?? null, distanceM: distances[i] ?? null, coordsKey: key(c),
      };
    }));
  }
  log({ event: 'cost_fill_done', cells: chain.length, kind: first.kind, unroutable: durations[0] === null });
  return 'filled';
}
