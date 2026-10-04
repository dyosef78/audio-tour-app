import { assert, assertEquals } from 'jsr:@std/assert@1';

import { isRoutingError, type ValhallaRoute } from '@shared/routing/index.ts';
import { budgetedRouter, takeValhallaToken, valhallaGlobalBucket } from './valhallaBudget.ts';
import type { BucketRequest } from './rateLimit.ts';

const ok = { allowed: true, retryAfterSeconds: 0, remaining: 5, exhausted: [] };
const no = { allowed: false, retryAfterSeconds: 2.4, remaining: 0, exhausted: ['valhalla:global'] };
const route = { legs: [] } as unknown as ValhallaRoute;

Deno.test('the global bucket: one key for every function, env-overridable', () => {
  assertEquals(valhallaGlobalBucket({}), { key: 'valhalla:global', capacity: 120, refillPerSecond: 2 });
  assertEquals(valhallaGlobalBucket({ VALHALLA_BUDGET_BURST: '30', VALHALLA_BUDGET_PER_MINUTE: '60' }), { key: 'valhalla:global', capacity: 30, refillPerSecond: 1 });
  assertEquals(valhallaGlobalBucket({ VALHALLA_BUDGET_BURST: 'lots' }).capacity, 120, 'garbage falls back, never NaN');
});

Deno.test('caller and global buckets are taken in ONE call', async () => {
  const calls: BucketRequest[][] = [];
  const sub = { key: 'plan-tour:valhalla-fill', capacity: 5, refillPerSecond: 1 };
  await takeValhallaToken((b) => { calls.push(b); return Promise.resolve(ok); }, [sub, valhallaGlobalBucket()], 'fail-closed', () => {});
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.map((b) => b.key), ['plan-tour:valhalla-fill', 'valhalla:global']);
});

Deno.test('exhausted -> refused with a whole-second retry', async () => {
  const d = await takeValhallaToken(() => Promise.resolve(no), [valhallaGlobalBucket()], 'fail-open', () => {});
  assertEquals(d, { ok: false, retryAfterSeconds: 3, reason: 'budget' });
});

Deno.test('store down: route-stops fails OPEN, enrichment fails CLOSED', async () => {
  const down = () => Promise.reject(new Error('db down'));
  assertEquals(await takeValhallaToken(down, [valhallaGlobalBucket()], 'fail-open', () => {}), { ok: true });
  const closed = await takeValhallaToken(down, [valhallaGlobalBucket()], 'fail-closed', () => {});
  assert(!closed.ok && closed.reason === 'store_unavailable');
});

Deno.test('budgetedRouter: no token -> rate_limited (route-stops answers 429 + Retry-After), and no request', async () => {
  let requests = 0;
  const inner = { route: () => { requests++; return Promise.resolve(route); } };
  const denied = budgetedRouter(inner, () => Promise.resolve({ ok: false, retryAfterSeconds: 7, reason: 'budget' }));
  let caught: unknown;
  try { await denied.route([[0, 0], [1, 1]], 'pedestrian'); } catch (e) { caught = e; }
  assert(isRoutingError(caught) && caught.code === 'rate_limited' && caught.retryAfterMs === 7000);
  assertEquals(requests, 0);
  const allowed = budgetedRouter(inner, () => Promise.resolve({ ok: true }));
  await allowed.route([[0, 0], [1, 1]], 'pedestrian');
  assertEquals(requests, 1);
});
