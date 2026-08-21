/**
 * TASK-303 - Supabase connectivity smoke test.
 *
 * Reads the seeded Jerusalem walking tour back out through the Data API and
 * checks it against what the migrations inserted. Replaces the verification
 * SELECTs that used to sit at the bottom of 02_seed_dummy_tour.sql - same
 * checks, but now exercising the real client path (PostgREST + Storage + RLS)
 * instead of a privileged psql session. Also verifies the audio-tracks
 * bucket from TASK-304 exists and is read-only to the public key.
 *
 * Run:  npm run test:db
 * Env:  SUPABASE_URL, SUPABASE_ANON_KEY  (see .env.example)
 *
 * Uses the ANON key deliberately. A service_role key bypasses RLS and would
 * make the policies from the enable_rls_policies migration untestable.
 */

import { createClient } from '@supabase/supabase-js';

const SEED_TOUR_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BUCKET = 'audio-tracks';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  console.error(
    'Missing SUPABASE_URL or SUPABASE_ANON_KEY.\n' +
      'Copy .env.example to .env and fill it in, then run: npm run test:db',
  );
  process.exit(1);
}

const supabase = createClient(url, anonKey);

/** Tracks pass/fail so the process can exit non-zero for CI. */
let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

async function main(): Promise<void> {
  console.log(`Connecting to ${url}\n`);

  // --- 1. The tour row itself -------------------------------------------------
  console.log('Tour');
  const { data: tour, error: tourError } = await supabase
    .from('tours')
    .select('id, title, topology, transit_mode, duration_minutes')
    .eq('id', SEED_TOUR_ID)
    .single();

  if (tourError) {
    console.error(`  FAIL  could not read tours: ${tourError.message}`);
    console.error(
      '\nIf this is an empty result, the migrations may not have been applied.\n' +
        'Local:  supabase db reset      Remote: supabase db push',
    );
    process.exit(1);
  }

  console.log(`  ${tour.title}`);
  check('topology', tour.topology, 'in_city');
  check('transit_mode', tour.transit_mode, 'walking');
  check('duration_minutes', tour.duration_minutes, 90);

  // --- 2. Nested read across all four tables ----------------------------------
  // PostgREST derives this embedding from the foreign keys, which is the same
  // shape the offline bundle builder will need for PRD Screen 4.
  console.log('\nWaypoints (nested select across all 4 tables)');
  const { data: waypoints, error: wpError } = await supabase
    .from('waypoints')
    .select(
      'id, name, poi_type, sort_order, geofence_zones (zone_type, trigger_radius_meters), audio_tracks (format, size_bytes, lufs_normalization, storage_path, duration_seconds)',
    )
    .eq('tour_id', SEED_TOUR_ID)
    .order('sort_order');

  if (wpError) {
    console.error(`  FAIL  could not read waypoints: ${wpError.message}`);
    process.exit(1);
  }

  let totalBytes = 0;
  let totalSeconds = 0;
  for (const wp of waypoints) {
    const zone = wp.geofence_zones[0];
    const track = wp.audio_tracks[0];
    const radius = zone?.trigger_radius_meters;
    const extent = radius === null || radius === undefined ? 'polygon outline' : `r=${radius}m`;
    totalBytes += track?.size_bytes ?? 0;
    totalSeconds += track?.duration_seconds ?? 0;

    console.log(
      `  ${wp.sort_order}. ${wp.name.padEnd(36)} ${(wp.poi_type as string).padEnd(14)}` +
        ` ${(zone?.zone_type ?? 'NONE').padEnd(8)} ${extent.padEnd(16)}` +
        ` ${track ? `${String(track.duration_seconds ?? '?').padStart(3)}s ${(track.size_bytes / 1000).toFixed(0).padStart(4)} kB` : 'NO AUDIO'}`,
    );
  }

  console.log('');
  check('waypoint count', waypoints.length, 4);
  check('geofences present', waypoints.every((w) => w.geofence_zones.length === 1), true);
  check('audio present', waypoints.every((w) => w.audio_tracks.length === 1), true);

  // Offline bundle size, the number Screen 4 shows in its progress meter.
  console.log(
    `\nOffline bundle: ${(totalBytes / 1_000_000).toFixed(2)} MB, ` +
      `${Math.round(totalSeconds / 60)} min of audio across 4 tracks`,
  );

  // --- 3. RLS: writes must be rejected for the anon key -----------------------
  // The enable_rls_policies migration grants SELECT only. If this DELETE
  // succeeds, the anon key shipped in the mobile app can wipe the catalogue.
  console.log('\nRLS write protection');
  const { error: deleteError, count } = await supabase
    .from('tours')
    .delete({ count: 'exact' })
    .eq('id', SEED_TOUR_ID);

  const blocked = deleteError !== null || count === 0;
  if (!blocked) failures++;
  console.log(
    `  ${blocked ? 'PASS' : 'FAIL'}  anon DELETE on tours was ` +
      `${blocked ? 'blocked' : 'ALLOWED - RLS IS NOT PROTECTING THIS TABLE'}`,
  );

  // --- 4. Storage bucket ------------------------------------------------------
  // Verifies the create_audio_storage_bucket migration landed, and that its
  // read/write split behaves the same way the table policies do.
  console.log('\nStorage bucket "audio-tracks"');

  // list() goes through the authenticated Storage API, so it exercises the
  // SELECT policy. A missing bucket surfaces here as "Bucket not found".
  const { error: listError } = await supabase.storage.from(BUCKET).list('tours');
  const listOk = listError === null;
  if (!listOk) failures++;
  console.log(
    `  ${listOk ? 'PASS' : 'FAIL'}  anon can list objects` +
      `${listOk ? '' : ` - ${listError.message}`}`,
  );

  // storage_path must be RELATIVE now (TASK-305). An absolute URL here means
  // either a stale row or a CMS still writing the old format, and it would pin
  // the row to whichever project ref happened to be current when it was written.
  const absolutePaths = waypoints.filter((w) =>
    /^https?:\/\//.test(w.audio_tracks[0]?.storage_path ?? ''),
  );
  check('storage_paths are relative, not URLs', absolutePaths.length, 0);

  const misfiled = waypoints.filter(
    (w) => !(w.audio_tracks[0]?.storage_path ?? '').startsWith('tours/'),
  );
  check('storage_paths use the tours/ prefix', misfiled.length, 0);

  // Demonstrate the resolution path the app will actually use: relative path in
  // the database, playable URL built client-side against whatever host this
  // client is pointed at.
  const samplePath = waypoints[0]?.audio_tracks[0]?.storage_path;
  if (samplePath) {
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(samplePath);
    console.log(`  resolved: ${samplePath}\n         -> ${pub.publicUrl}`);
  }

  // Uploads must be rejected. If this ever passes, anyone with the app's anon
  // key can overwrite tour audio - note it would also leave a stray object
  // behind, since anon cannot delete it either.
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload('rls-probe/should-not-exist.opus', new Blob([new Uint8Array([0])]), {
      contentType: 'audio/ogg',
    });

  const uploadBlocked = uploadError !== null;
  if (!uploadBlocked) failures++;
  console.log(
    `  ${uploadBlocked ? 'PASS' : 'FAIL'}  anon upload was ` +
      `${uploadBlocked ? 'blocked' : 'ALLOWED - THE BUCKET IS WRITABLE BY THE PUBLIC KEY'}`,
  );

  // --- Result -----------------------------------------------------------------
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nUnexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
