/**
 * TASK-402 - CLI for the ingest service.
 *
 * The same code path an HTTP controller takes, driven from a terminal. That
 * matters for two reasons: it is how the pipeline gets exercised before any CMS
 * exists, and it is how somebody backfills the existing catalogue without
 * anyone writing a one-off script that skips the validation.
 *
 * Usage:
 *   npm run cms:ingest -- <file> --tour <uuid> --waypoint <uuid> \
 *                          --sort <n> --name "Jaffa Gate" [options]
 *
 * Options:
 *   --dry-run            process and name the file; touch neither Storage nor
 *                        the database. Needs no credentials at all.
 *   --content-addressed  append the content hash to the filename (decision D5)
 *   --json               machine-readable result
 *   --keep-source        do not delete the input file afterwards (default)
 *   --delete-source      delete the input file once ingested
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   SUPABASE_ADMIN_EMAIL, SUPABASE_ADMIN_PASSWORD   - an app_admins account
 *   FFMPEG_PATH, FFPROBE_PATH                       - if not on PATH
 *
 * The admin credentials are the point, not a convenience: there is no
 * service_role path through this service. See backend/cms/client.ts.
 */

import { createClient } from '@supabase/supabase-js';

import { MediaPipelineError } from '../media/index.ts';
import { CmsIngestError, ingestWaypointAudio, type AudioIngestResult } from '../cms/index.ts';

interface Args {
  file: string;
  tourId: string;
  waypointId: string;
  sortOrder: number;
  waypointName: string;
  dryRun: boolean;
  contentAddressed: boolean;
  json: boolean;
  deleteSource: boolean;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const named = new Map<string, string>();
  let dryRun = false;
  let contentAddressed = false;
  let json = false;
  let deleteSource = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case '--dry-run': dryRun = true; break;
      case '--content-addressed': contentAddressed = true; break;
      case '--json': json = true; break;
      case '--delete-source': deleteSource = true; break;
      case '--keep-source': deleteSource = false; break;
      case '--tour':
      case '--waypoint':
      case '--sort':
      case '--name': {
        const value = argv[++i];
        if (value === undefined) fail(`${arg} needs a value.`);
        named.set(arg, value);
        break;
      }
      default:
        if (arg.startsWith('--')) fail(`Unknown option ${arg}.`);
        positional.push(arg);
    }
  }

  const file = positional[0];
  const tourId = named.get('--tour');
  const waypointId = named.get('--waypoint');
  const sort = named.get('--sort');
  const name = named.get('--name');

  if (file === undefined || tourId === undefined || waypointId === undefined ||
      sort === undefined || name === undefined) {
    fail(
      'Usage: npm run cms:ingest -- <file> --tour <uuid> --waypoint <uuid> ' +
        '--sort <n> --name "Waypoint name" [--dry-run] [--content-addressed] [--json]',
    );
  }

  const sortOrder = Number(sort);
  if (!Number.isInteger(sortOrder) || sortOrder < 0) fail('--sort must be a non-negative integer.');

  return { file, tourId, waypointId, sortOrder, waypointName: name, dryRun, contentAddressed, json, deleteSource };
}

/**
 * Trade the admin's email and password for an access token.
 *
 * A browser CMS would already hold this from its session; the CLI has to sign
 * in for itself. Email/password SIGNUP is disabled project-wide, which does not
 * prevent sign-in for an account that already exists.
 */
async function adminAccessToken(): Promise<string> {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const email = process.env['SUPABASE_ADMIN_EMAIL'];
  const password = process.env['SUPABASE_ADMIN_PASSWORD'];

  if (!url || !anonKey) fail('SUPABASE_URL and SUPABASE_ANON_KEY must be set. See .env.example.');
  if (!email || !password) {
    fail(
      'SUPABASE_ADMIN_EMAIL and SUPABASE_ADMIN_PASSWORD must be set for a real ingest.\n' +
        'Use --dry-run to process and name a file without touching Storage or the database.',
    );
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    fail(`Could not sign in as ${email}: ${error?.message ?? 'no session returned'}`);
  }

  return data.session.access_token;
}

function report(result: AudioIngestResult, dryRun: boolean): void {
  console.log(`\n${dryRun ? 'DRY RUN - nothing was uploaded or registered' : 'Ingested'}\n`);

  console.log('Storage');
  console.log(`  audio-tracks/${result.storagePath}`);
  console.log(`  sha256 ${result.sha256}`);

  console.log('\nLoudness');
  console.log(
    `  source    ${result.loudness.source.integratedLufs.toFixed(2)} LUFS  ` +
      `${result.loudness.source.truePeakDb.toFixed(2)} dBTP`,
  );
  console.log(
    `  encoded   ${result.loudness.encoded.integratedLufs.toFixed(2)} LUFS  ` +
      `${result.loudness.encoded.truePeakDb.toFixed(2)} dBTP  ` +
      `(${result.loudness.normalizationType ?? 'unknown'})`,
  );

  console.log('\naudio_tracks row');
  console.log(`  track_id           ${result.trackId ?? '- (dry run)'}`);
  console.log(`  storage_path       ${result.storagePath}`);
  console.log(`  size_bytes         ${result.sizeBytes}`);
  console.log(`  duration_seconds   ${result.durationSeconds}`);
  console.log(`  format             ${result.format}`);
  console.log(`  lufs_normalization ${result.lufsNormalization}`);
  if (!dryRun) console.log(`  replaced           ${result.replaced}`);

  if (result.warnings.length > 0) {
    console.log('\nWarnings');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const result = await ingestWaypointAudio({
    ...(args.dryRun ? {} : { accessToken: await adminAccessToken() }),
    tourId: args.tourId,
    waypointId: args.waypointId,
    sortOrder: args.sortOrder,
    waypointName: args.waypointName,
    contentAddressed: args.contentAddressed,
    dryRun: args.dryRun,
    source: { path: args.file, filename: args.file, deleteAfter: args.deleteSource },
  });

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else report(result, args.dryRun);

  process.exit(0);
}

main().catch((error: unknown) => {
  if (error instanceof CmsIngestError || error instanceof MediaPipelineError) {
    console.error(`\n${error.code}: ${error.message}`);
    if (error.detail !== undefined) console.error(`\n${error.detail}`);
    process.exit(1);
  }

  console.error('\nUnexpected error:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
