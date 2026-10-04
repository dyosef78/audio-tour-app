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
 *   --kind <kind>        narration (default) or deep_dive (TASK-603)
 *   --transcript <file>  a WebVTT transcript to upload beside the track. It is
 *                        validated BEFORE the audio is encoded, so a bad file
 *                        costs nothing; the duration check runs after.
 *   --dry-run            process and name the file; touch neither Storage nor
 *                        the database. Needs no credentials at all.
 *   --content-addressed  append the content hash to the filename (decision D5)
 *   --json               machine-readable result
 *   --keep-source        do not delete the input file afterwards (default)
 *   --delete-source      delete the input file once ingested
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   SUPABASE_ADMIN_EMAIL                            - an app_admins account; a one-time
 *                                                     code is emailed and typed in (no passwords)
 *   FFMPEG_PATH, FFPROBE_PATH                       - if not on PATH
 *
 * The admin credentials are the point, not a convenience: there is no
 * service_role path through this service. See backend/cms/client.ts.
 */

import { readFile } from 'node:fs/promises';


import { MediaPipelineError } from '../media/index.ts';
import {
  CmsIngestError,
  checkTranscript,
  ingestTrackTranscript,
  ingestWaypointAudio,
  isTrackKind,
  type AudioIngestResult,
  type TrackKind,
  type TranscriptIngestResult,
} from '../cms/index.ts';
import { AdminSignInError, adminSessionFromEnv } from '../cms/adminSession.ts';

interface Args {
  file: string;
  tourId: string;
  waypointId: string;
  sortOrder: number;
  waypointName: string;
  trackKind: TrackKind;
  transcript: string | null;
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
      case '--kind':
      case '--transcript':
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
        '--sort <n> --name "Waypoint name" [--kind deep_dive] [--transcript file.vtt] ' +
        '[--dry-run] [--content-addressed] [--json]',
    );
  }

  const sortOrder = Number(sort);
  if (!Number.isInteger(sortOrder) || sortOrder < 0) fail('--sort must be a non-negative integer.');

  const kind = named.get('--kind') ?? 'narration';
  if (!isTrackKind(kind)) fail('--kind must be narration or deep_dive.');

  return {
    file, tourId, waypointId, sortOrder, waypointName: name, trackKind: kind,
    transcript: named.get('--transcript') ?? null, dryRun, contentAddressed, json, deleteSource,
  };
}

/**
 * The admin's access token, by email one-time code (Epic 16 Part 5 - no
 * static passwords for production admin access). backend/cms/adminSession.ts.
 */
async function adminAccessToken(): Promise<string> {
  try {
    return (await adminSessionFromEnv()).accessToken;
  } catch (cause) {
    if (cause instanceof AdminSignInError) fail(`${cause.message}
Use --dry-run to process and name a file without touching Storage or the database.`);
    throw cause;
  }
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
  console.log(`  track_kind         ${result.trackKind}`);
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

function reportTranscript(result: TranscriptIngestResult): void {
  console.log(`\nTranscript${result.uploaded ? '' : ' (dry run - validated only)'}`);
  console.log(`  audio-tracks/${result.storagePath}`);
  console.log(`  ${result.cueCount} cues, ${result.sizeBytes} bytes`);
  for (const warning of result.warnings) console.log(`  - ${warning}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Fail on a broken transcript before spending an encode on the audio. The
  // duration comparison needs the processed track, so it runs again after.
  if (args.transcript !== null) {
    try {
      checkTranscript(await readFile(args.transcript), null);
    } catch (error) {
      if (error instanceof CmsIngestError) throw error;
      fail(`Could not read ${args.transcript}.`);
    }
  }

  const accessToken = args.dryRun ? null : await adminAccessToken();

  const result = await ingestWaypointAudio({
    ...(accessToken === null ? {} : { accessToken }),
    tourId: args.tourId,
    waypointId: args.waypointId,
    sortOrder: args.sortOrder,
    waypointName: args.waypointName,
    trackKind: args.trackKind,
    contentAddressed: args.contentAddressed,
    dryRun: args.dryRun,
    source: { path: args.file, filename: args.file, deleteAfter: args.deleteSource },
  });

  const transcript =
    args.transcript === null
      ? null
      : await ingestTrackTranscript({
          ...(accessToken === null ? {} : { accessToken }),
          audioStoragePath: result.storagePath,
          source: { path: args.transcript },
          dryRun: args.dryRun,
          audioDurationSeconds: result.durationSeconds,
        });

  if (args.json) {
    console.log(JSON.stringify(transcript === null ? result : { ...result, transcript }, null, 2));
  } else {
    report(result, args.dryRun);
    if (transcript !== null) reportTranscript(transcript);
  }

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
