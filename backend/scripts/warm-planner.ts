/**
 * Epic 16 Part 4 - `npm run planner:warm -- --city <slug|id> [--dry-run] [--max-minutes N]`
 *
 * Drives the warm-costs reconciler until a city's planner costs are complete:
 * call, read { remaining, stopped }, call again. Each call is one bounded,
 * budgeted batch on the server; this loop only decides WHEN to call next.
 * Safe to stop and re-run at any time - the server recomputes what is missing.
 *
 * Signs in as a CMS ADMIN (SUPABASE_ADMIN_EMAIL / SUPABASE_ADMIN_PASSWORD):
 * no service-role key ever sits on a laptop. Also needs SUPABASE_URL and
 * SUPABASE_ANON_KEY. The npm script reads .env and mobile/.env.
 *
 * Exit codes: 0 complete (or dry run), 2 time ran out with cells remaining,
 * 1 an error.
 */

import { createClient } from '@supabase/supabase-js';

interface Args {
  city: string;
  dryRun: boolean;
  maxMinutes: number;
}

function parseArgs(argv: readonly string[]): Args {
  let city = '';
  let dryRun = false;
  let maxMinutes = 30;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city') city = argv[++i] ?? '';
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--max-minutes') maxMinutes = Number(argv[++i]);
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!city) throw new Error('--city <slug|id> is required');
  if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 240) throw new Error('--max-minutes must be 1..240');
  return { city, dryRun, maxMinutes };
}

interface Batch {
  status: string;
  needed?: { legs: number; transfers: number };
  missing_before?: number;
  requests?: number;
  filled_cells?: number;
  remaining?: number;
  stopped?: string;
  retry_after_s?: number;
  code?: string;
  detail?: string;
  request_id?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const email = process.env.SUPABASE_ADMIN_EMAIL;
  const password = process.env.SUPABASE_ADMIN_PASSWORD;
  if (!url || !anonKey || !email || !password) {
    console.error('Needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_ADMIN_EMAIL and SUPABASE_ADMIN_PASSWORD (mobile/.env).');
    return 1;
  }

  // No auto-refresh: its timer would keep the process alive after the loop
  // ends. A run is bounded by --max-minutes (<= 240), and each batch re-reads
  // the session, so an expiring token is refreshed explicitly below.
  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
  if (signInError) {
    console.error(`Sign-in failed: ${signInError.message}`);
    return 1;
  }

  const deadline = Date.now() + args.maxMinutes * 60_000;
  let totalFilled = 0;
  for (let batch = 1; ; batch++) {
    let { data: session } = await supabase.auth.getSession();
    if (session.session && session.session.expires_at !== undefined && session.session.expires_at * 1000 - Date.now() < 120_000) {
      ({ data: session } = await supabase.auth.refreshSession());
    }
    const token = session.session?.access_token;
    if (!token) {
      console.error('Lost the admin session.');
      return 1;
    }
    const res = await fetch(`${url}/functions/v1/warm-costs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: args.city, dry_run: args.dryRun }),
      signal: AbortSignal.timeout(120_000),
    });
    const b = (await res.json()) as Batch;
    if (!res.ok || b.status !== 'ok') {
      console.error(`warm-costs ${res.status} ${b.code ?? ''}: ${b.detail ?? JSON.stringify(b)} (request ${b.request_id ?? '-'})`);
      return 1;
    }
    if (batch === 1) {
      console.log(`City ${args.city}: needs ${b.needed!.legs} legs + ${b.needed!.transfers} transfers; ${b.missing_before} missing.`);
    }
    if (args.dryRun) {
      console.log(`Dry run: nothing requested. ~${Math.ceil((b.missing_before ?? 0) / 3)}-${b.missing_before} Valhalla requests to complete.`);
      return 0;
    }
    totalFilled += b.filled_cells ?? 0;
    console.log(`  batch ${batch}: ${b.requests} requests, ${b.filled_cells} cells filled, ${b.remaining} remaining (${b.stopped})`);

    if (b.stopped === 'done' || b.remaining === 0) {
      console.log(`Complete: ${totalFilled} cells filled this run.`);
      return 0;
    }
    if (b.stopped === 'routing_errors') console.warn('  the provider is failing; backing off before the next batch');
    const wait = b.stopped === 'budget' ? (b.retry_after_s ?? 30) * 1000 : b.stopped === 'routing_errors' ? 60_000 : 1_000;
    if (Date.now() + wait > deadline) {
      console.warn(`Stopped after ${args.maxMinutes} min with ${b.remaining} cells remaining - re-run to continue.`);
      return 2;
    }
    await sleep(wait);
  }
}

// exitCode, not process.exit(): exiting while fetch's sockets are closing trips
// a libuv assertion on Windows (seen 4 Oct 2026).
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
