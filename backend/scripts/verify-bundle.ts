/**
 * verify-bundle.ts - post-`db reset` acceptance check
 *
 * Three migrations in a row have shipped correct SQL alongside a seed file that
 * silently stopped matching it:
 *
 *   TASK-301  poi_type       - seed used a value the new CHECK rejected
 *   TASK-302  tours.status   - seed left it defaulting to 'draft', so the
 *                              catalogue loaded invisible with no error
 *   TASK-303  storage_bucket - seed rows would have pointed at the wrong bucket
 *
 * Two of those three produce NO ERROR ANYWHERE. The reset succeeds, the
 * migration is right, and the app simply shows an empty list - which is not an
 * error condition, just an empty result. That is the specific failure mode this
 * script exists to catch.
 *
 * It runs as ANON on purpose. Checking as postgres proves the data exists;
 * checking as anon proves the mobile client can actually see it, which is the
 * thing that was broken twice.
 *
 * Usage:
 *   supabase db reset
 *   node --env-file-if-exists=.env backend/scripts/verify-bundle.ts
 *
 * Exits non-zero on the first failure, so it works as a CI gate unchanged.
 */

import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;

if (!ANON) {
  console.error('SUPABASE_ANON_KEY is not set. `supabase start` prints it.');
  process.exit(1);
}

const supabase = createClient(URL, ANON);

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Verifying seeded catalogue as anon against ${URL}`);

  // --- 1. The catalogue is visible at all ----------------------------------
  // Catches the TASK-302 class of bug: seeds that leave status defaulting to
  // 'draft'. The RLS policy then hides everything and nothing reports a problem.
  section('Catalogue visibility (anon)');

  const { data: tours, error: toursError } = await supabase
    .from('tours')
    .select('id, title, status, duration_minutes, start_point');

  check('tours query succeeds', !toursError, toursError?.message);
  if (toursError) return;

  check(
    'at least one tour is visible to anon',
    (tours?.length ?? 0) > 0,
    'seed loaded but nothing is published - the app would show an empty list',
  );
  if (!tours?.length) return;

  check(
    'every visible tour is published',
    tours.every((t) => t.status === 'published'),
    `RLS leaked non-published rows: ${tours
      .filter((t) => t.status !== 'published')
      .map((t) => t.status)
      .join(', ')}`,
  );

  check(
    'every visible tour has a start_point',
    tours.every((t) => t.start_point !== null),
    'the TASK-301 backfill or refresh trigger did not run',
  );

  // --- 2. The bundle is complete -------------------------------------------
  // This is the payload the mobile client actually consumes. Anything missing
  // here is a tour that downloads but does not work.
  for (const tour of tours) {
    section(`Bundle: ${tour.title}`);

    const { data: bundle, error: bundleError } = await supabase
      .rpc('get_tour_bundle', { p_tour_id: tour.id });

    check('get_tour_bundle returns', !bundleError && bundle != null, bundleError?.message);
    if (bundleError || !bundle) continue;

    const waypoints = (bundle as any).waypoints ?? [];

    check('bundle has a version hash', typeof (bundle as any).bundle_version_hash === 'string');
    check('bundle has waypoints', waypoints.length > 0, 'tour is visible but empty');

    for (const w of waypoints) {
      const label = `wp${w.sort_order} "${w.name}"`;

      // Coordinates. [lon, lat] - a swapped pair for this project's content
      // lands outside these bounds, so this doubles as a sanity check on the
      // ordering the whole codebase depends on.
      const [lon, lat] = w.coordinates ?? [];
      check(
        `${label} has coordinates`,
        typeof lon === 'number' && typeof lat === 'number',
      );
      check(
        `${label} coordinates are in range`,
        lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180,
        `lon ${lon}, lat ${lat}`,
      );

      // A waypoint with no geofence never fires; its audio is unreachable even
      // though every row looks complete.
      check(`${label} has a geofence`, w.geofence != null);

      if (w.geofence?.type === 'radius') {
        // THE DEGREES-VERSUS-METRES ASSERTION.
        // A radius buffered without the ::geography cast is ~111 km per unit.
        // The polygon is still valid, the bundle still parses, and the geofence
        // covers a continent. Nothing else in the stack notices.
        check(
          `${label} radius is plausible metres, not degrees`,
          w.geofence.radius_meters > 0 && w.geofence.radius_meters <= 1000,
          `radius_meters = ${w.geofence.radius_meters}`,
        );
      }

      // Media. Catches the TASK-303 class: a path that resolves to the wrong
      // place, or a codec/extension pair that fails silently on iOS.
      check(`${label} has media`, w.media != null, 'waypoint would play nothing');
      if (w.media) {
        check(
          `${label} storage_path is bucket-relative`,
          typeof w.media.storage_path === 'string' &&
            !/^https?:\/\//.test(w.media.storage_path) &&
            !w.media.storage_path.startsWith('/'),
          w.media.storage_path,
        );
        check(
          `${label} extension matches codec`,
          (w.media.format === 'AAC' && /\.m4a$/i.test(w.media.storage_path)) ||
            (w.media.format === 'MP3' && /\.mp3$/i.test(w.media.storage_path)),
          `${w.media.format} / ${w.media.storage_path}`,
        );
        check(
          `${label} has a positive size`,
          typeof w.media.size_bytes === 'number' && w.media.size_bytes > 0,
        );
      }
    }
  }

  // --- 3. Writes are still refused -----------------------------------------
  // A migration that accidentally adds a permissive policy is otherwise
  // invisible: everything keeps working, just for everyone.
  section('Anon is still read-only');

  const { error: writeError } = await supabase
    .from('tours')
    .insert({ title: 'ci probe', topology: 'in_city', transit_mode: 'walking', duration_minutes: 5 });

  check(
    'anon cannot insert tours',
    writeError != null,
    'RLS is not denying writes - an insert succeeded',
  );

  // --- Summary -------------------------------------------------------------
  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
