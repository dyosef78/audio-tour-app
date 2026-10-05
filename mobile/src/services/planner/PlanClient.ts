import {
  parsePlanError,
  parsePlanTourOk,
  PlanContractError,
  type PlanTourOk,
  type PlanTourRequest,
} from '../../../../shared/src/contracts/planTour.ts';
import { checkPlanRequest } from '../../../../shared/src/planner/request.ts';

/**
 * The plan-tour client (Epic 16 Part 4). Pure: no Expo, no Supabase SDK -
 * everything it needs arrives in PlanClientDeps, so `npm run test:plan` drives
 * it with a fake fetch. services/planner/index.ts wires the real one.
 *
 *   plan(request)     POST - validated locally first (the shared checker the
 *                     server uses), so a malformed request never leaves the phone
 *
 * No GET client: the device never re-fetches a plan (it runs the saved plan
 * against its pinned bundles). The server's GET stays for other callers;
 * a cross-device resume would be built natively, not revived from here (PM,
 * 6 Oct 2026: YAGNI).
 *
 * fetch with an explicit timeout, never supabase.functions.invoke (a
 * UI-blocking flow - Epic 11 rule). Every response is PARSED, never trusted:
 * a 200 that is not a valid plan is `bad_response`, not a plan.
 *
 * Auth: the signed-in user's token when there is one (their plan is then
 * theirs alone), else the anon key - anonymous planning is allowed (PM).
 */

export interface PlanClientDeps {
  baseUrl: string;
  anonKey: string;
  /** The user's access token, or null when signed out. Must not hang. */
  accessToken(): Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type PlanErrorCode =
  | 'invalid_request'
  | 'unsupported_contract'
  | 'no_candidates'
  | 'origin_out_of_range'
  | 'plan_infeasible'
  | 'rate_limited'
  | 'internal'
  | 'network'
  | 'timeout'
  | 'bad_response';

export type PlanResult =
  | { kind: 'plan'; plan: PlanTourOk }
  | { kind: 'error'; code: PlanErrorCode; retryable: boolean; detail: string; shortfallS?: number; retryAfterS?: number; requestId?: string };

export const DEFAULT_PLAN_TIMEOUT_MS = 20_000;
const SERVER_CODES: ReadonlySet<string> = new Set(['invalid_request', 'unsupported_contract', 'no_candidates', 'origin_out_of_range', 'plan_infeasible', 'rate_limited', 'internal']);
const RETRYABLE: ReadonlySet<PlanErrorCode> = new Set(['rate_limited', 'internal', 'network', 'timeout']);

type Raw = { status: number; body: unknown } | { failure: 'network' | 'timeout'; detail: string };

export interface PlanClient {
  plan(request: PlanTourRequest, signal?: AbortSignal): Promise<PlanResult>;
}

export function createPlanClient(deps: PlanClientDeps): PlanClient {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const endpoint = `${deps.baseUrl}/functions/v1/plan-tour`;

  async function send(init: { method: 'GET' | 'POST'; query?: string; body?: unknown }, outer?: AbortSignal): Promise<Raw> {
    // Not AbortSignal.timeout(): Hermes lacks it, and a manual timer can be cleared.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deps.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS);
    const onOuterAbort = () => controller.abort();
    outer?.addEventListener('abort', onOuterAbort);
    try {
      const token = await deps.accessToken();
      const response = await doFetch(`${endpoint}${init.query ?? ''}`, {
        method: init.method,
        headers: {
          apikey: deps.anonKey,
          Authorization: `Bearer ${token ?? deps.anonKey}`,
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: controller.signal,
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // A gateway error page is not JSON; the status still says what happened.
      }
      return { status: response.status, body };
    } catch (cause) {
      return { failure: timedOut ? 'timeout' : 'network', detail: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }

  const parsedPlan = (body: unknown): { ok: true; plan: PlanTourOk } | { ok: false; detail: string } => {
    try {
      return { ok: true, plan: parsePlanTourOk(body) };
    } catch (cause) {
      if (cause instanceof PlanContractError) return { ok: false, detail: cause.message };
      throw cause;
    }
  };

  return {
    async plan(request, signal) {
      const local = checkPlanRequest(request);
      if (!local.ok) return { kind: 'error', code: local.code, retryable: false, detail: local.detail };

      const raw = await send({ method: 'POST', body: local.request }, signal);
      if ('failure' in raw) return { kind: 'error', code: raw.failure, retryable: true, detail: raw.detail };
      if (raw.status === 200) {
        const p = parsedPlan(raw.body);
        return p.ok ? { kind: 'plan', plan: p.plan } : { kind: 'error', code: 'bad_response', retryable: false, detail: p.detail };
      }
      const e = parsePlanError(raw.body);
      if (!e || !SERVER_CODES.has(e.code)) {
        return { kind: 'error', code: raw.status >= 500 ? 'internal' : 'bad_response', retryable: raw.status >= 500, detail: `HTTP ${raw.status}` };
      }
      const code = e.code as PlanErrorCode;
      return {
        kind: 'error', code, retryable: RETRYABLE.has(code), detail: e.detail,
        ...(e.shortfallS !== undefined ? { shortfallS: e.shortfallS } : {}),
        ...(e.retryAfterS !== undefined ? { retryAfterS: e.retryAfterS } : {}),
        ...(e.requestId !== undefined ? { requestId: e.requestId } : {}),
      };
    },

  };
}
