/**
 * warm-costs - Deno tests with injected fakes: admin-only, dry run, the
 * per-call cap, budget stops, error stops, and that no single Valhalla
 * request ever carries more than 5 cells.
 */

import { assert, assertEquals } from 'jsr:@std/assert@1';

import { RoutingError, type LonLat, type ValhallaProfile, type ValhallaRoute } from '@shared/routing/index.ts';
import type { FillDeps, LegCostWrite, TransferCostWrite } from '../_shared/costFill.ts';
import { handleWarmCosts, type WarmDeps, type WarmResult } from './handler.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CITY = uuid(1);

/** n walking chapters 1 km apart, each entry - core - extension - core - exit. */
function state(n: number): unknown {
  const chapters = Array.from({ length: n }, (_, k) => {
    const x = 34.77 + k * 0.01;
    return {
      chapter_id: uuid(100 + k), tour_id: uuid(2), transit_mode: 'walking', profile: 'pedestrian',
      entry: [x, 32.08], exit: [x + 0.003, 32.08],
      stops: [
        { waypoint_id: uuid(1000 + k * 10 + 1), sort_order: 1, stop_role: 'core', coordinates: [x + 0.0005, 32.08] },
        { waypoint_id: uuid(1000 + k * 10 + 2), sort_order: 2, stop_role: 'extension', coordinates: [x + 0.0015, 32.081] },
        { waypoint_id: uuid(1000 + k * 10 + 3), sort_order: 3, stop_role: 'core', coordinates: [x + 0.0025, 32.08] },
      ],
    };
  });
  return { chapters, legs: [], transfers: [] };
}

interface H {
  deps: WarmDeps;
  routes: { locations: LonLat[]; profile: ValhallaProfile }[];
  legs: LegCostWrite[];
  transfers: TransferCostWrite[];
  tokens: number;
}

function harness(o: { role?: 'admin' | 'not_admin' | 'anonymous'; chapters?: number; tokens?: number; route?: () => Promise<ValhallaRoute> | null; fill?: boolean } = {}): H {
  const h: H = { deps: undefined as unknown as WarmDeps, routes: [], legs: [], transfers: [], tokens: o.tokens ?? 1_000 };
  const fill: FillDeps = {
    takeToken: () => Promise.resolve(h.tokens-- > 0),
    route: (locations, profile) => {
      h.routes.push({ locations, profile });
      const custom = o.route?.();
      return custom ?? Promise.resolve({
        profile, encoding: 'polyline', precision: 6, polyline: '', distanceMeters: 0, durationSeconds: 0, locationOffsetsMeters: [],
        legs: locations.slice(1).map(() => ({ polyline: '', distanceMeters: 100, durationSeconds: 70 })),
      } as ValhallaRoute);
    },
    saveLegs: (rows) => { h.legs.push(...rows); return Promise.resolve(); },
    saveTransfers: (rows) => { h.transfers.push(...rows); return Promise.resolve(); },
  };
  h.deps = {
    requestId: () => 'req-w',
    callerRole: () => Promise.resolve(o.role ?? 'admin'),
    resolveCity: (c) => Promise.resolve(c === 'tel-aviv' || c === CITY ? CITY : null),
    warmState: () => Promise.resolve(state(o.chapters ?? 3)),
    fill: o.fill === false ? null : fill,
    log: () => {},
  };
  return h;
}

const call = async (h: H, body: Record<string, unknown>) => {
  const res = await handleWarmCosts(new Request('https://x/functions/v1/warm-costs', { method: 'POST', body: JSON.stringify(body) }), h.deps);
  return { status: res.status, body: await res.json() as WarmResult & { code?: string } };
};

Deno.test('admin only: anonymous 401, signed-in non-admin 403', async () => {
  assertEquals((await call(harness({ role: 'anonymous' }), { city: 'tel-aviv' })).status, 401);
  assertEquals((await call(harness({ role: 'not_admin' }), { city: 'tel-aviv' })).status, 403);
  const h = harness({ role: 'not_admin' });
  await call(h, { city: 'tel-aviv' });
  assertEquals(h.routes.length, 0, 'a refused caller never reaches Valhalla');
});

Deno.test('dry run: counts, no Valhalla, no writes', async () => {
  const h = harness();
  const { status, body } = await call(h, { city: 'tel-aviv', dry_run: true });
  assertEquals(status, 200);
  // 3 chapters x (entry->C1, C1->E, C1->C2, E->C2, C2->exit) = 15 legs. Transfers: 3x2 ordered
  // pairs x 3 profiles - a walking chapter is eligible for walking, cycling AND driving visitors.
  assertEquals(body.needed, { legs: 15, transfers: 18 });
  assertEquals([body.missing_before, body.remaining, body.stopped, h.routes.length], [33, 33, 'dry_run', 0]);
});

Deno.test('a full run converges: every request <= 5 cells, remaining reaches 0', async () => {
  const h = harness({ chapters: 1 });
  const { body } = await call(h, { city: 'tel-aviv' });
  // entry->C1->E->C2->exit chains into ONE request (4 cells); the skip leg C1->C2 is a second.
  assertEquals([body.stopped, body.remaining, body.requests], ['done', 0, 2]);
  assertEquals(h.routes.map((r) => r.locations.length), [5, 2]);
  assertEquals(h.legs.length, 5);
});

Deno.test('a bigger city: every request carries 1..5 cells, transfers one each', async () => {
  const h = harness();
  const { body } = await call(h, { city: 'tel-aviv', max_requests: 20 });
  assertEquals([body.stopped, body.requests], ['max_requests', 20]);
  assert(h.routes.every((r) => r.locations.length >= 2 && r.locations.length <= 6), 'one request never carries more than 5 cells');
  assertEquals(body.filled_cells, h.legs.length + h.transfers.length);
  assertEquals(body.remaining, 33 - body.filled_cells);
});

Deno.test('the per-call cap stops the batch; a second call resumes', async () => {
  const h = harness();
  const first = (await call(h, { city: 'tel-aviv', max_requests: 2 })).body;
  assertEquals([first.stopped, first.requests], ['max_requests', 2]);
  assert(first.remaining > 0 && first.remaining === first.missing_before - first.filled_cells);
  const bad = await call(h, { city: 'tel-aviv', max_requests: 21 });
  assertEquals(bad.status, 400, 'the cap itself is capped at 20');
});

Deno.test('budget exhausted: stop at once, no request without a token', async () => {
  const h = harness({ tokens: 1 });
  const { body } = await call(h, { city: 'tel-aviv' });
  assertEquals([body.stopped, body.requests, h.routes.length, body.retry_after_s], ['budget', 1, 1, 30]);
});

Deno.test('provider failures: three in a row end the call, nothing written', async () => {
  const h = harness({ route: () => Promise.reject(new RoutingError('upstream_error', '502')) });
  const { body } = await call(h, { city: 'tel-aviv' });
  assertEquals([body.stopped, body.requests, h.legs.length, body.remaining], ['routing_errors', 3, 0, body.missing_before]);
});

Deno.test('bad input', async () => {
  assertEquals((await call(harness(), {})).status, 400);
  assertEquals((await call(harness(), { city: 'atlantis' })).status, 400);
  assertEquals((await call(harness({ fill: false }), { city: 'tel-aviv' })).status, 503, 'no Valhalla: only dry runs');
  assertEquals((await call(harness({ fill: false }), { city: 'tel-aviv', dry_run: true })).status, 200);
});
