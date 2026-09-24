/**
 * Epic 13 - structured logging for every Edge Function: the console, plus a
 * direct copy to Axiom's ingest API.
 *
 * Why in code: Supabase's native log drain is a paid add-on (PM, 24 Sep), so the
 * functions ship their own lines. What that cannot see - an isolate killed by
 * the platform, a boot crash, a CPU limit - only the Supabase dashboard's
 * short-lived logs record. Every line is still written to the console for that
 * reason.
 *
 * THE PII RULE. `user_id` is the one identity key a caller may log. It never
 * leaves this module: every event is sanitised first, `user_id` replaced by
 * `user_ref` (userRef.ts), and only the sanitised event reaches the console or
 * Axiom. Without a key the ref reads "unconfigured"; if hashing fails it reads
 * "hash_failed". Never the raw id.
 *
 * OFF THE RESPONSE PATH. log() is synchronous and does no I/O. Events logged in
 * the same tick are batched into one ingest request, which runs under
 * EdgeRuntime.waitUntil (runInBackground), so the response never waits for
 * Axiom - including lines logged after the response, by background revocations.
 *
 * FAILURE IS REPORTED, NEVER THROWN. A failed or timed-out ingest writes an
 * `axiom_ingest_failed` line to the console with the number of events dropped;
 * a logging outage must never fail a request. No retries: a batch is a handful
 * of lines, and a retry would hold the isolate open for a service already down.
 */

import { type UserRefFn, userRefFromEnv } from './userRef.ts';

export type LogEvent = Record<string, unknown>;

export interface Logger {
  /** Record one event. Synchronous; never throws; ships in the background. */
  log(event: LogEvent): void;
  /** Resolves once every batch logged so far has been written and shipped. */
  flush(): Promise<void>;
}

export interface AxiomConfig {
  /** Full ingest URL: https://<AXIOM_DOMAIN>/v1/ingest/<AXIOM_DATASET>. */
  ingestUrl: string;
  token: string;
}

export interface LoggerOptions {
  /** Stamped on every event as `service`, e.g. "delete-account". */
  service: string;
  userRef: UserRefFn | null;
  axiom: AxiomConfig | null;
  /** EdgeRuntime.waitUntil on Supabase; null under `deno test` or a plain Deno. */
  runInBackground: ((task: Promise<unknown>) => void) | null;
  fetch?: typeof fetch;
  /** Where the console copy goes. */
  write?: (line: string) => void;
  now?: () => Date;
  /** Cap on one ingest request, so a hung Axiom cannot hold the isolate open. */
  ingestTimeoutMs?: number;
}

export const USER_REF_UNCONFIGURED = 'unconfigured';
export const USER_REF_HASH_FAILED = 'hash_failed';
const DEFAULT_INGEST_TIMEOUT_MS = 3_000;
/** A valid host name, so a pasted URL or path cannot redirect the logs. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const DATASET_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Axiom settings from the environment: all three or none, like APPLE_*. */
export function axiomConfigFromEnv(env: Record<string, string | undefined>): { axiom: AxiomConfig } | { axiom: null; reason: string } {
  const token = env.AXIOM_TOKEN ?? '';
  const dataset = env.AXIOM_DATASET ?? '';
  const domain = (env.AXIOM_DOMAIN ?? '').toLowerCase();
  const set = [token, dataset, domain].filter((v) => v !== '').length;
  if (set === 0) return { axiom: null, reason: 'AXIOM_* secrets not set' };
  if (set < 3) return { axiom: null, reason: 'AXIOM_TOKEN, AXIOM_DATASET and AXIOM_DOMAIN must all be set' };
  if (!DOMAIN_PATTERN.test(domain)) return { axiom: null, reason: 'AXIOM_DOMAIN must be a bare host name, e.g. us-east-1.aws.edge.axiom.co' };
  if (!DATASET_PATTERN.test(dataset)) return { axiom: null, reason: 'AXIOM_DATASET has invalid characters' };
  return { axiom: { ingestUrl: `https://${domain}/v1/ingest/${dataset}`, token } };
}

export function createLogger(options: LoggerOptions): Logger {
  const doFetch = options.fetch ?? fetch;
  const write = options.write ?? ((line) => console.log(line));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.ingestTimeoutMs ?? DEFAULT_INGEST_TIMEOUT_MS;

  let batch: Promise<LogEvent>[] = [];
  const inFlight = new Set<Promise<void>>();

  async function sanitise(event: LogEvent, time: Date): Promise<LogEvent> {
    const { user_id: userId, ...rest } = event;
    const stamped: LogEvent = { _time: time.toISOString(), service: options.service, ...rest };
    if (userId === undefined) return stamped;
    let ref: string;
    if (!options.userRef) ref = USER_REF_UNCONFIGURED;
    else {
      try {
        ref = await options.userRef(String(userId));
      } catch {
        // Not swallowed: the line itself says the ref could not be computed.
        ref = USER_REF_HASH_FAILED;
      }
    }
    return { ...stamped, user_ref: ref };
  }

  async function ship(events: LogEvent[]): Promise<void> {
    for (const event of events) write(JSON.stringify(event));
    if (!options.axiom) return;
    try {
      const res = await doFetch(options.axiom.ingestUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.axiom.token}`, 'Content-Type': 'application/x-ndjson' },
        body: events.map((e) => JSON.stringify(e)).join('\n'),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Drained either way, or the connection is held until the isolate dies.
      const detail = res.ok ? '' : (await res.text()).slice(0, 200);
      if (!res.ok) write(JSON.stringify({ event: 'axiom_ingest_failed', service: options.service, status: res.status, dropped: events.length, body: detail }));
    } catch (cause) {
      write(JSON.stringify({ event: 'axiom_ingest_failed', service: options.service, dropped: events.length, message: String(cause) }));
    }
  }

  async function drain(): Promise<void> {
    // One macrotask: every event logged in the current tick joins this batch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = batch;
    batch = [];
    await ship(await Promise.all(pending));
  }

  return {
    log(event) {
      batch.push(sanitise(event, now()));
      if (batch.length > 1) return; // a drain for this batch is already scheduled
      const task = drain();
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
      options.runInBackground?.(task);
    },
    async flush() {
      while (inFlight.size > 0) await Promise.all([...inFlight]);
    },
  };
}

/** The standard wiring for a function's index.ts: env in, logger out, config problems logged. */
export function loggerFromEnv(
  service: string,
  env: Record<string, string | undefined>,
  runInBackground: LoggerOptions['runInBackground'],
): Logger {
  const refConfig = userRefFromEnv(env);
  const axiomConfig = axiomConfigFromEnv(env);
  const logger = createLogger({ service, userRef: refConfig.userRef, axiom: axiomConfig.axiom, runInBackground });
  if (!refConfig.userRef) logger.log({ event: 'log_pseudonymisation_disabled', reason: refConfig.reason });
  if (!axiomConfig.axiom) logger.log({ event: 'axiom_disabled', reason: axiomConfig.reason });
  return logger;
}
