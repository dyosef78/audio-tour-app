/**
 * Epic 16 Part 4 - Edge Function `warm-costs`: the planner cost RECONCILER.
 * index.ts wires the database and Valhalla; tests inject fakes.
 *
 *   POST /functions/v1/warm-costs   { city, dry_run?, max_requests? }
 *
 * CMS ADMINS ONLY (is_cms_admin(), checked with the caller's own token): it
 * spends the shared Valhalla budget.
 *
 * One call = one bounded batch, never a sweep:
 *   1. get_warm_state(city): every plannable chapter + every cached row
 *   2. reconcile: needed cells minus present ones (coords_key checked)
 *   3. up to max_requests (default 10, max 20) fills, each ONE Valhalla
 *      request of at most 5 chained cells through the shared fill code and
 *      the shared budget (warm sub-bucket + valhalla:global, fail-closed)
 *   4. answer { remaining, stopped } - the CLI calls again until done
 * Idempotent and resumable: a call that dies half-way leaves only correct
 * rows, and the next call recomputes what is still missing.
 *
 *   200 ok   401 unauthenticated   403 not a CMS admin   400 bad body / city
 *   405      503 fill not configured (a non-dry run without Valhalla)   500
 */

import { chooseFillChain, missingCellKey, parseWarmState, reconcile, type MissingCell } from '@shared/planner/index.ts';
import { fillMissingCosts, type FillDeps } from '../_shared/costFill.ts';

export interface WarmDeps {
  requestId(): string;
  /** The caller, judged by is_cms_admin() under their own token. */
  callerRole(request: Request): Promise<'admin' | 'not_admin' | 'anonymous'>;
  /** A city id from an id or a slug; null when unknown. */
  resolveCity(city: string): Promise<string | null>;
  warmState(cityId: string): Promise<unknown>;
  fill: FillDeps | null;
  log(event: Record<string, unknown>): void;
}

export const DEFAULT_MAX_REQUESTS = 10;
export const MAX_REQUESTS_CAP = 20;
/** Consecutive failed fills before a call gives up (the provider is unwell). */
const MAX_ROUTING_ERRORS = 3;

export type WarmStop = 'done' | 'dry_run' | 'budget' | 'max_requests' | 'routing_errors';

export interface WarmResult {
  status: 'ok';
  city_id: string;
  dry_run: boolean;
  needed: { legs: number; transfers: number };
  missing_before: number;
  requests: number;
  filled_cells: number;
  remaining: number;
  stopped: WarmStop;
  /** Set when stopped on budget: a reasonable wait before calling again. */
  retry_after_s?: number;
  request_id: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
const err = (status: number, code: string, detail: string, requestId: string) => json(status, { status: 'error', code, detail, request_id: requestId });

export async function handleWarmCosts(request: Request, deps: WarmDeps): Promise<Response> {
  const requestId = deps.requestId();
  try {
    if (request.method !== 'POST') return err(405, 'invalid_request', 'POST { city, dry_run?, max_requests? }', requestId);

    const role = await deps.callerRole(request);
    if (role === 'anonymous') return err(401, 'unauthenticated', 'Sign in as a CMS administrator.', requestId);
    if (role !== 'admin') return err(403, 'forbidden', 'CMS administrators only: this spends the shared routing budget.', requestId);

    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await request.text());
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return err(400, 'invalid_request', 'Body must be a JSON object.', requestId);
    }
    if (typeof body.city !== 'string' || body.city.trim() === '') return err(400, 'invalid_request', 'city (slug or id) is required.', requestId);
    const dryRun = body.dry_run === true;
    const maxRequests = body.max_requests ?? DEFAULT_MAX_REQUESTS;
    if (typeof maxRequests !== 'number' || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > MAX_REQUESTS_CAP) {
      return err(400, 'invalid_request', `max_requests must be a whole number 1..${MAX_REQUESTS_CAP}.`, requestId);
    }
    if (!dryRun && !deps.fill) return err(503, 'fill_not_configured', 'Valhalla is not configured for this function.', requestId);

    const cityId = await deps.resolveCity(body.city.trim());
    if (!cityId) return err(400, 'invalid_request', `Unknown city ${JSON.stringify(body.city)}.`, requestId);

    const { needed, missing } = reconcile(parseWarmState(await deps.warmState(cityId)));
    const base = { status: 'ok' as const, city_id: cityId, dry_run: dryRun, needed, missing_before: missing.length, request_id: requestId };
    if (dryRun) {
      return json(200, { ...base, requests: 0, filled_cells: 0, remaining: missing.length, stopped: 'dry_run' } satisfies WarmResult);
    }

    let queue: MissingCell[] = missing;
    let requests = 0;
    let filled = 0;
    let errors = 0;
    let stopped: WarmStop = 'done';
    while (queue.length > 0) {
      if (requests >= maxRequests) {
        stopped = 'max_requests';
        break;
      }
      const chain = chooseFillChain([], queue);
      const outcome = await fillMissingCosts(chain, deps.fill!, deps.log);
      if (outcome === 'no_token') {
        stopped = 'budget';
        break;
      }
      requests++;
      // Done or failed, a chain leaves THIS call's queue: a failure is retried
      // by the next call, never in a loop here.
      const taken = new Set(chain.map(missingCellKey));
      queue = queue.filter((c) => !taken.has(missingCellKey(c)));
      if (outcome === 'filled') {
        filled += chain.length;
        errors = 0;
      } else if (++errors >= MAX_ROUTING_ERRORS) {
        stopped = 'routing_errors';
        break;
      }
    }

    const result: WarmResult = {
      ...base,
      requests,
      filled_cells: filled,
      remaining: missing.length - filled,
      stopped,
      ...(stopped === 'budget' ? { retry_after_s: 30 } : {}),
    };
    deps.log({ event: 'warm_costs_batch', city_id: cityId, requests, filled_cells: filled, remaining: result.remaining, stopped, request_id: requestId });
    return json(200, result);
  } catch (cause) {
    deps.log({ event: 'warm_costs_internal_error', request_id: requestId, message: cause instanceof Error ? cause.message : String(cause) });
    return err(500, 'internal', 'Warming failed; see the server log for this request_id.', requestId);
  }
}
