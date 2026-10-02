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
 * Usage (needs SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY):
 *   supabase db reset
 *   node --env-file-if-exists=.env backend/scripts/verify-bundle.ts
 *
 * Exits non-zero on the first failure, so it works as a CI gate unchanged.
 */

import { createClient } from '@supabase/supabase-js';

import { transcriptPathFor } from '../../mobile/src/transcript/sidecar.ts';
// The device's own codec and tolerance (shared/src), so CI checks the
// bundle route exactly the way the app will read it.
import { decodePolyline, distanceToRouteMeters, type RoutePoint } from '../../shared/src/polyline.ts';
import { routeToleranceMeters } from '../../shared/src/routeTolerance.ts';

const URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const ANON = process.env.SUPABASE_ANON_KEY;

if (!ANON) {
  console.error('SUPABASE_ANON_KEY is not set. `supabase start` prints it.');
  process.exit(1);
}

// service_role is used for ONE probe only - proving cms_upsert_tour still
// resolves now that anon cannot see it (section 3). Every content check stays
// on the anon client.
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SERVICE) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set. `supabase status` prints it (service_role key).');
  process.exit(1);
}

const supabase = createClient(URL, ANON);
const service = createClient(URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });

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

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/**
 * Audio checks shared by narration and Deep Dives (TASK-603), plus the
 * transcript contract: a transcript the bundle announces must sit exactly at
 * the sidecar path, because that is the only place the device looks.
 */
function checkMedia(label: string, media: any, expectedKind: 'narration' | 'deep_dive'): void {
  check(`${label} track_kind is ${expectedKind}`, media.track_kind === expectedKind, `track_kind = ${media.track_kind}`);
  check(
    `${label} storage_path is bucket-relative`,
    typeof media.storage_path === 'string' &&
      !/^https?:\/\//.test(media.storage_path) &&
      !media.storage_path.startsWith('/'),
    media.storage_path,
  );
  check(
    `${label} extension matches codec`,
    (media.format === 'AAC' && /\.m4a$/i.test(media.storage_path)) ||
      (media.format === 'MP3' && /\.mp3$/i.test(media.storage_path)),
    `${media.format} / ${media.storage_path}`,
  );
  check(`${label} has a positive size`, typeof media.size_bytes === 'number' && media.size_bytes > 0);

  if (media.transcript != null) {
    check(
      `${label} transcript is the sidecar of its audio`,
      media.transcript.storage_path === transcriptPathFor(media.storage_path),
      `${media.transcript.storage_path} vs ${transcriptPathFor(media.storage_path)}`,
    );
    check(
      `${label} transcript has a positive size`,
      typeof media.transcript.size_bytes === 'number' && media.transcript.size_bytes > 0,
    );
  }
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
    .select('id, title, status, duration_minutes, start_point, city_id');

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

  // --- 1b. Every tour sits under a city the app can list (TASK-1101) --------
  // A published tour with no city is listed under every city; one whose city
  // anon cannot read would put Discovery on a city picker with nothing in it.
  check(
    'every visible tour has a city',
    tours.every((t) => t.city_id !== null),
    'seed publishes a tour without city_id - cms_validate_tour would refuse it',
  );

  const { data: cities, error: citiesError } = await supabase.from('cities').select('id, slug, name');
  check('cities query succeeds', !citiesError, citiesError?.message);
  const visibleCityIds = new Set((cities ?? []).map((c) => c.id));
  check(
    "every visible tour's city is visible to anon",
    tours.every((t) => t.city_id === null || visibleCityIds.has(t.city_id)),
    'cities_read_with_published_tour is hiding a city that has a published tour',
  );
  const tourCityIds = new Set(tours.map((t) => t.city_id));
  check(
    'no city is visible without a published tour',
    (cities ?? []).every((c) => tourCityIds.has(c.id)),
    `anon can see empty cities: ${(cities ?? []).filter((c) => !tourCityIds.has(c.id)).map((c) => c.slug).join(', ')}`,
  );

  let deepDives = 0;
  let routes = 0;

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
    check(
      'tour_metadata carries tag arrays',
      isStringArray((bundle as any).tour_metadata?.audiences) &&
        isStringArray((bundle as any).tour_metadata?.interests),
      'TASK-603 migrations not applied, or get_tour_bundle regressed',
    );

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
      // `media` is the GEOFENCE narration. If a Deep Dive ever appears here,
      // entering the zone plays minutes of optional content instead.
      if (w.media) checkMedia(label, w.media, 'narration');

      if (w.deep_dive) {
        deepDives++;
        checkMedia(`${label} deep_dive`, w.deep_dive, 'deep_dive');
        check(
          `${label} deep_dive is not on a transition stop`,
          w.poi_type !== 'transition',
          'the app never offers one there',
        );
        check(
          `${label} deep_dive has its own file`,
          w.deep_dive.storage_path !== w.media?.storage_path,
          w.deep_dive.storage_path,
        );
      }

      check(
        `${label} tags are string arrays`,
        isStringArray(w.audiences) && isStringArray(w.interests),
      );

      // Epic 16: a catalogue session arms core stops only, so a missing or
      // misspelt role would silently drop the stop from every session.
      check(
        `${label} stop_role is core or extension`,
        w.stop_role === 'core' || w.stop_role === 'extension',
        `stop_role = ${JSON.stringify(w.stop_role)} - Epic 16 migrations not applied?`,
      );
    }

    // --- Route (TASK-604) ---------------------------------------------------
    // Decoded HERE, in the device's language, from what the bundle ships -
    // not trusted from the database. A route that decodes to the wrong place
    // (the classic polyline5/polyline6 mix-up) fails the per-stop distance.
    check("bundle carries a 'route' key", 'route' in (bundle as any), 'TASK-604 migration not applied');
    const route = (bundle as any).route;
    if (route != null) {
      routes++;
      check(
        'route is declared as a precision-6 encoded polyline',
        route.encoding === 'polyline' && route.precision === 6 && typeof route.polyline === 'string',
        JSON.stringify({ encoding: route.encoding, precision: route.precision }),
      );

      let points: RoutePoint[] = [];
      try {
        points = decodePolyline(route.polyline, 6);
      } catch (err) {
        check('route polyline decodes', false, String(err));
      }

      check('route has at least 2 points', points.length >= 2, `${points.length} point(s)`);
      check(
        'route coordinates are in range',
        points.every((p) => Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180),
      );
      check('route has a positive length', typeof route.length_meters === 'number' && route.length_meters > 0);

      const tolerance = routeToleranceMeters((bundle as any).tour_metadata?.transit_mode);
      for (const w of waypoints) {
        const [lon, lat] = w.coordinates ?? [];
        const gap = distanceToRouteMeters({ lat, lng: lon }, points);
        check(
          `wp${w.sort_order} "${w.name}" is within ${tolerance} m of the route`,
          gap <= tolerance,
          `${Math.round(gap)} m`,
        );
      }
    }
  }

  // Informational, not a failure: the local seed has one, a remote catalogue
  // may legitimately have none.
  console.log(`\n  INFO  ${deepDives} Deep Dive track(s) visible across the catalogue`);
  console.log(`  INFO  ${routes} tour(s) ship a route; the rest draw straight lines`);

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

  // Since 20261002120000 anon holds no EXECUTE on any cms_* function, so the
  // refusal must come from the GRANT, before the body runs. PostgREST can
  // report that two ways - the function hidden (PGRST202 / HTTP 404) or
  // Postgres' "permission denied for function" (42501) - and both are
  // accepted. What must NOT come back is the admin GUARD's 42501 ("Not
  // authorised: CMS administrator required"): that means anon reached the
  // function body, i.e. its grant is open again.
  const probeArgs = {
    p_tour_id: null,
    p_title: 'ci probe',
    p_topology: 'in_city',
    p_transit_mode: 'walking',
    p_duration_minutes: 5,
    p_interests: ['history'],
  };
  const { error: rpcError, status: rpcStatus } = await supabase.rpc('cms_upsert_tour', probeArgs);
  const hidden = rpcError?.code === 'PGRST202' || rpcStatus === 404;
  const denied = rpcError?.code === '42501' && /permission denied for function/i.test(rpcError.message);

  check(
    'anon calling cms_upsert_tour is refused at the GRANT layer, not by the admin guard',
    hidden || denied,
    rpcError ? `HTTP ${rpcStatus} ${rpcError.code}: ${rpcError.message}` : 'the call SUCCEEDED as anon',
  );
  console.log(`        (PostgREST answered HTTP ${rpcStatus} ${rpcError?.code ?? '-'}: ${rpcError?.message ?? ''})`);

  // PGRST202 alone proves nothing: it is also what a dropped or re-signatured
  // function returns. So prove the function still resolves - with exactly these
  // arguments, and without an ambiguous overload (PGRST203, which TASK-603's
  // DROP + CREATE once risked) - by calling it as service_role, which holds
  // EXECUTE but is no CMS admin: it must reach the guard.
  const { error: svcError } = await service.rpc('cms_upsert_tour', probeArgs);

  check(
    'cms_upsert_tour still resolves with these arguments and reaches the admin guard (service_role)',
    svcError?.code === '42501' && /Not authorised/.test(svcError.message),
    svcError ? `${svcError.code}: ${svcError.message}` : 'the call SUCCEEDED as service_role',
  );

  // --- 4. The planner read is service_role only (Epic 16) -------------------
  // Anon-executable, get_planner_candidates would be a compute endpoint
  // reachable straight through PostgREST, around plan-tour's rate limit. Same
  // two acceptable refusals as above; then service_role must get a well-formed
  // answer through REAL PostgREST - which also proves the optional
  // p_exclude_chapter_ids resolves by default and no overload is ambiguous.
  section('Planner RPC is service_role only');

  const plannerArgs = {
    p_city_id: tours[0]?.city_id,
    p_origin_lon: 34.78,
    p_origin_lat: 32.08,
    p_transit_mode: 'walking',
    p_group_type: 'solo',
    p_interests: ['history'],
    p_budget_seconds: 7200,
    p_include_deep_dives: false,
  };
  const { error: anonPlanError, status: anonPlanStatus } = await supabase.rpc('get_planner_candidates', plannerArgs);
  check(
    'anon calling get_planner_candidates is refused at the GRANT layer',
    anonPlanError?.code === 'PGRST202' || anonPlanStatus === 404
      || (anonPlanError?.code === '42501' && /permission denied for function/i.test(anonPlanError.message)),
    anonPlanError ? `HTTP ${anonPlanStatus} ${anonPlanError.code}: ${anonPlanError.message}` : 'the call SUCCEEDED as anon',
  );

  const { data: plan, error: svcPlanError } = await service.rpc('get_planner_candidates', plannerArgs);
  const p = plan as any;
  check('service_role gets candidates', !svcPlanError && p != null, svcPlanError?.message);
  check(
    'candidate payload has its documented shape',
    Array.isArray(p?.candidates) && Array.isArray(p?.transfers) && Array.isArray(p?.legs)
      && typeof p?.considered === 'number' && typeof p?.pruned === 'object' && p?.transfer_profile === 'pedestrian',
    JSON.stringify(p)?.slice(0, 200),
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
