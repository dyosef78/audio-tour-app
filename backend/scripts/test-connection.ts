/**
 * TASK-303 - Supabase connectivity smoke test.
 * TASK-400 - reworked for the PRIVATE audio bucket.
 *
 * Reads a published tour back out through the Data API and checks it against
 * the invariants the migrations enforce. Replaces the verification
 * SELECTs that used to sit at the bottom of 02_seed_dummy_tour.sql - same
 * checks, but now exercising the real client path (PostgREST + Storage + RLS)
 * instead of a privileged psql session.
 *
 * WHAT CHANGED IN TASK-400
 *
 * Migration 20260827180000 flipped `audio-tracks` private, so getPublicUrl()
 * now returns a URL that 404s. This script used to print that URL and call it
 * "resolved", which proved nothing even while the bucket was public - the call
 * is pure string concatenation and contacts no server. It now mints signed URLs
 * the same way the mobile client does, in ONE batch, and then actually fetches
 * one. A URL that is never dereferenced is not a test.
 *
 * It also asserts the negative: the old public URL must NOT resolve. That is
 * the only check proving the flip landed on THIS environment, as opposed to
 * merely existing in the migrations directory.
 *
 * Run:  npm run test:db
 * Env:  SUPABASE_URL, SUPABASE_ANON_KEY               (see .env.example)
 *       SUPABASE_ADMIN_EMAIL, SUPABASE_ADMIN_PASSWORD (optional, see below)
 *       TEST_TOUR_ID                                  (optional, see below)
 *
 * Uses the ANON key deliberately. A service_role key bypasses RLS and would
 * make the policies from the enable_rls_policies migration untestable. Anon is
 * also sufficient for the happy path: audio_object_is_published() grants SELECT
 * on published objects to anon, so no session is needed to download a bundle.
 *
 * The optional admin credentials exercise the OTHER half of the storage
 * policies - audio_tracks_admin_read_all, which is what lets the CMS work with
 * unpublished audio. Email/password SIGNUP is disabled project-wide, but
 * sign-in for an already-provisioned admin still works. Skipped when unset, so
 * this stays a one-command check on a fresh clone.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'audio-tracks';

/**
 * WHICH TOUR TO VERIFY (TASK-500)
 *
 * This was a hardcoded 'aaaaaaaa-0000-4000-8000-000000000001' - the id inserted
 * by supabase/seed.sql. That file is applied ONLY by a local `supabase db reset`
 * via [db.seed] in config.toml; `supabase db push` never runs it, by design, so
 * dummy data cannot reach production.
 *
 * The consequence: the moment .env pointed SUPABASE_URL at the remote project,
 * that id existed nowhere, .single() matched zero rows, and PostgREST answered
 *
 *     Cannot coerce the result to a single JSON object
 *
 * which reads like a malformed query but only ever means "no such row on THIS
 * environment". It is not a symptom of missing audio: this read touches the
 * tours table alone, and it is step 1, before any track is looked at.
 *
 * So the tour is discovered rather than assumed. TEST_TOUR_ID wins when set;
 * otherwise the first published tour anon can see. One command is then correct
 * against the local seed AND the remote test tour with no edit to this file.
 */
const EXPLICIT_TOUR_ID = process.env.TEST_TOUR_ID;

/** Short: these URLs are minted to be dereferenced immediately and discarded. */
const SIGNED_URL_TTL_SECONDS = 60;

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const adminEmail = process.env.SUPABASE_ADMIN_EMAIL;
const adminPassword = process.env.SUPABASE_ADMIN_PASSWORD;

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

function assert(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

/**
 * Neither a pass nor a failure.
 *
 * Reserved for one specific situation: the seed inserts audio_tracks rows as
 * CLAIMS about storage, and nothing in the migrations or the seed uploads the
 * matching objects. On a fresh local stack every signature therefore fails with
 * "Object not found" - correct behaviour, not a broken policy. Counting that as
 * a failure would leave `npm run test:db` permanently red locally and teach
 * everyone to ignore it, which costs more than the check is worth.
 */
function skip(label: string, why: string): void {
  console.log(`  SKIP  ${label} - ${why}`);
}

/**
 * Does this URL actually serve bytes?
 *
 * HEAD first - no reason to pull a megabyte of narration to learn a status
 * code. Some proxies answer HEAD with 405 while GET works, so a single-byte
 * ranged GET is the fallback rather than treating 405 as a verdict.
 */
async function probe(target: string): Promise<{ status: number; length: number | null }> {
  let response = await fetch(target, { method: 'HEAD' });

  if (response.status === 405 || response.status === 501) {
    response = await fetch(target, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    // A 206 reports the full size in content-range: "bytes 0-0/1160000".
    const range = response.headers.get('content-range');
    const total = range?.split('/')[1];
    return { status: response.status, length: total ? Number(total) : null };
  }

  const length = response.headers.get('content-length');
  return { status: response.status, length: length === null ? null : Number(length) };
}

async function main(): Promise<void> {
  console.log(`Connecting to ${url}\n`);

  // --- 1. The tour row itself -------------------------------------------------
  console.log('Tour');

  // Selecting a LIST, not .single(). An empty catalogue is a diagnosable state
  // that deserves an actionable message, not PostgREST's coercion error.
  const query = supabase
    .from('tours')
    .select('id, title, topology, transit_mode, duration_minutes, status')
    .eq('status', 'published');

  const { data: candidates, error: tourError } = EXPLICIT_TOUR_ID
    ? await query.eq('id', EXPLICIT_TOUR_ID)
    : await query.order('id').limit(1);

  if (tourError) {
    console.error(`  FAIL  could not read tours: ${tourError.message}`);
    process.exit(1);
  }

  const tour = candidates?.[0];

  if (!tour) {
    console.error(
      EXPLICIT_TOUR_ID
        ? `  FAIL  no PUBLISHED tour with id ${EXPLICIT_TOUR_ID} is visible to the anon key.\n` +
            "        Either the id is wrong for this environment, or tours.status is not 'published'\n" +
            '        - tours_read_published hides every other row from anon.'
        : '  FAIL  this database exposes no published tours at all.\n' +
            `        Target: ${url}\n` +
            '        Local stack : supabase db reset   (applies supabase/seed.sql)\n' +
            '        Remote      : supabase db push, then run prod_test_seed.sql by hand\n' +
            '                      in the Dashboard SQL editor - db push does NOT seed.',
    );
    process.exit(1);
  }

  const tourId = tour.id;
  console.log(`  ${tour.title}`);
  console.log(
    `  ${tourId}${EXPLICIT_TOUR_ID ? '' : '  (auto-selected; set TEST_TOUR_ID to pin it)'}`,
  );

  // Enum-shaped columns are checked for VALIDITY, not against one seed's values.
  // Asserting duration_minutes === 90 only ever tested which seed happened to be
  // loaded, and would fail against any real tour.
  assert('topology is a known value', ['in_city', 'regional'].includes(tour.topology), tour.topology);
  assert(
    'transit_mode is a known value',
    ['walking', 'driving', 'cycling', 'transit'].includes(tour.transit_mode),
    tour.transit_mode,
  );
  assert('duration_minutes is positive', tour.duration_minutes > 0, String(tour.duration_minutes));

  // --- 2. Nested read across all four tables ----------------------------------
  // PostgREST derives this embedding from the foreign keys, which is the same
  // shape the offline bundle builder will need for PRD Screen 4.
  console.log('\nWaypoints (nested select across all 4 tables)');
  const { data: waypoints, error: wpError } = await supabase
    .from('waypoints')
    .select(
      'id, name, poi_type, sort_order, geofence_zones (zone_type, trigger_radius_meters), audio_tracks (format, size_bytes, lufs_normalization, storage_path, duration_seconds)',
    )
    .eq('tour_id', tourId)
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
  // Structural invariants, not a fixed count. A tour with no waypoints is broken
  // on any environment; a tour with two instead of four is not.
  assert('tour has at least one waypoint', waypoints.length > 0, `${waypoints.length} waypoints`);
  check('geofences present', waypoints.every((w) => w.geofence_zones.length === 1), true);
  check('audio present', waypoints.every((w) => w.audio_tracks.length === 1), true);

  // The AAC-only rule from migration 20260822001105. iOS cannot decode Opus and
  // fails SILENTLY - the player reports "playing" and sits at 0:00 - so a wrong
  // format here stays invisible until someone is standing at the waypoint.
  check('every track is AAC', waypoints.every((w) => w.audio_tracks[0]?.format === 'AAC'), true);
  check(
    'every track declares -16 LUFS',
    waypoints.every((w) => w.audio_tracks[0]?.lufs_normalization === -16),
    true,
  );

  // Offline bundle size, the number Screen 4 shows in its progress meter.
  console.log(
    `\nOffline bundle: ${(totalBytes / 1_000_000).toFixed(2)} MB, ` +
      `${Math.round(totalSeconds / 60)} min of audio across ${waypoints.length} tracks`,
  );

  // --- 3. RLS: writes must be rejected for the anon key -----------------------
  // The enable_rls_policies migration grants SELECT only. If this DELETE
  // succeeds, the anon key shipped in the mobile app can wipe the catalogue.
  console.log('\nRLS write protection');
  const { error: deleteError, count } = await supabase
    .from('tours')
    .delete({ count: 'exact' })
    .eq('id', tourId);

  const blocked = deleteError !== null || count === 0;
  assert(
    'anon DELETE on tours was blocked',
    blocked,
    blocked ? undefined : 'RLS IS NOT PROTECTING THIS TABLE',
  );

  // --- 4. Storage paths are still well-formed ---------------------------------
  console.log('\nStorage paths');

  // storage_path must be RELATIVE (TASK-305). An absolute URL here means either
  // a stale row or a CMS still writing the old format, and it would pin the row
  // to whichever project ref happened to be current when it was written.
  const absolutePaths = waypoints.filter((w) =>
    /^https?:\/\//.test(w.audio_tracks[0]?.storage_path ?? ''),
  );
  check('storage_paths are relative, not URLs', absolutePaths.length, 0);

  const misfiled = waypoints.filter(
    (w) => !(w.audio_tracks[0]?.storage_path ?? '').startsWith('tours/'),
  );
  check('storage_paths use the tours/ prefix', misfiled.length, 0);

  const paths = waypoints
    .map((w) => w.audio_tracks[0]?.storage_path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);

  const samplePath = paths[0];

  // --- 5. The bucket is genuinely private -------------------------------------
  //
  // This proves migration 20260827180000 was applied HERE, rather than merely
  // existing on disk. getPublicUrl() builds a string without contacting
  // anything, so the flip stays invisible to a client until the URL is
  // dereferenced - which is exactly why the shipped app failed silently.
  console.log('\nBucket privacy');

  if (samplePath === undefined) {
    assert('a seeded storage_path exists to test with', false, 'no audio_tracks rows');
  } else {
    const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(samplePath);
    const publicProbe = await probe(pub.publicUrl);
    assert(
      'the public CDN URL does NOT serve audio',
      publicProbe.status !== 200,
      publicProbe.status === 200
        ? 'THE BUCKET IS STILL PUBLIC - unpublishing does not retract audio'
        : `HTTP ${publicProbe.status}`,
    );
  }

  // --- 6. Signed URLs, batched exactly as the mobile client does them ---------
  //
  // One round trip for the whole bundle. Pairing is by `path` and never by
  // index: the Storage API does not promise response order, and two narration
  // tracks can share a byte count, so an index mix-up would slip past the size
  // check in DownloadManager.
  console.log('\nSigned URLs (anon, batched)');

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

  if (signError) {
    assert('createSignedUrls succeeds', false, signError.message);
  } else {
    const issued = new Map<string, string>();
    const refused = new Map<string, string>();

    for (const row of signed ?? []) {
      if (row.path === null) continue;
      if (row.error !== null) refused.set(row.path, row.error);
      else if (row.signedUrl !== null) issued.set(row.path, row.signedUrl);
    }

    // "Object not found" is the expected state of a freshly reset local stack:
    // the seed writes audio_tracks rows but uploads no objects. Anything else -
    // a permission error above all - is a real policy failure.
    const notFound = [...refused].filter(([, why]) => /not found/i.test(why));
    const denied = [...refused].filter(([, why]) => !/not found/i.test(why));

    for (const [path, why] of denied) {
      assert(`signing refused for ${path}`, false, why);
    }

    if (issued.size === 0 && notFound.length === paths.length) {
      skip(
        'signed URL round trip',
        'every seeded object is absent from storage; upload audio to exercise this',
      );
    } else {
      assert(
        'every published track was issued a URL',
        issued.size === paths.length,
        `${issued.size} of ${paths.length}`,
      );
    }

    // Dereference one. This is the part getPublicUrl() could never prove: that
    // the token is accepted, that the policy allows the read, and that the
    // bytes on disk are the bytes audio_tracks.size_bytes claims - the exact
    // figure DownloadManager compares against with ===.
    if (samplePath !== undefined) {
      const signedUrl = issued.get(samplePath);

      if (signedUrl === undefined) {
        skip('signed URL serves the object', 'no URL was issued for the sample path');
      } else {
        const expectedSize = waypoints.find(
          (w) => w.audio_tracks[0]?.storage_path === samplePath,
        )?.audio_tracks[0]?.size_bytes;

        const result = await probe(signedUrl);
        assert('signed URL serves the object', result.status === 200, `HTTP ${result.status}`);
        console.log(`  resolved: ${samplePath}\n         -> ${signedUrl.slice(0, 96)}...`);

        if (result.length !== null && expectedSize !== undefined) {
          assert(
            'served size matches audio_tracks.size_bytes',
            result.length === expectedSize,
            result.length === expectedSize
              ? `${result.length} bytes`
              : `${result.length} vs ${expectedSize} - the offline downloader would reject this file`,
          );
        }
      }
    }
  }

  // --- 7. Storage writes stay closed to the public key ------------------------
  console.log('\nStorage write protection');

  // list() goes through the Storage API and is evaluated against the SELECT
  // policy, so on a private bucket it enumerates PUBLISHED objects only. It no
  // longer proves the bucket exists - a missing bucket and an empty published
  // set both come back empty - which is why bucket existence is now proven by
  // the signing call above instead.
  const { error: listError } = await supabase.storage.from(BUCKET).list('tours');
  assert('anon can list published objects', listError === null, listError?.message);

  // Uploads must be rejected. If this ever passes, anyone with the app's anon
  // key can overwrite tour audio - note it would also leave a stray object
  // behind, since anon cannot delete it either.
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload('rls-probe/should-not-exist.m4a', new Blob([new Uint8Array([0])]), {
      contentType: 'audio/mp4',
    });

  assert(
    'anon upload was blocked',
    uploadError !== null,
    uploadError === null ? 'THE BUCKET IS WRITABLE BY THE PUBLIC KEY' : undefined,
  );

  // --- 8. Admin half of the storage policies (optional) -----------------------
  await checkAdminPath(samplePath);

  // --- Result -----------------------------------------------------------------
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

/**
 * Exercise audio_tracks_admin_read_all with a real admin session.
 *
 * Optional and non-fatal when unconfigured. The credentials belong to a human
 * CMS account, they cannot be provisioned by a migration, and requiring them
 * would break `npm run test:db` on a fresh clone for a check that is not about
 * the mobile client at all.
 *
 * Note what this does NOT prove. Confirming that an admin can read UNPUBLISHED
 * audio - the property the private bucket exists for - needs a draft tour with
 * a real object behind it, and the seed holds only one published tour. Raised
 * in the TASK-400 handover report.
 */
async function checkAdminPath(samplePath: string | undefined): Promise<void> {
  console.log('\nAdmin storage access');

  if (!adminEmail || !adminPassword) {
    skip(
      'admin session',
      'SUPABASE_ADMIN_EMAIL / SUPABASE_ADMIN_PASSWORD not set (see .env.example)',
    );
    return;
  }

  // A separate client. Signing in on `supabase` would silently upgrade every
  // check above from anon to admin on a re-run, which is the kind of thing that
  // makes a green suite meaningless.
  const admin: SupabaseClient = createClient(url as string, anonKey as string);

  const { error: signInError } = await admin.auth.signInWithPassword({
    email: adminEmail,
    password: adminPassword,
  });

  if (signInError) {
    assert('admin sign-in', false, signInError.message);
    return;
  }

  try {
    // is_cms_admin() reads app_admins live rather than trusting a JWT claim, so
    // this separates "signed in" from "actually an admin" - a distinction that
    // matters here precisely because open SSO makes `authenticated` a public
    // role.
    const { data: isAdmin, error: adminError } = await admin.rpc('is_cms_admin');
    assert(
      'signed-in account is a CMS admin',
      adminError === null && isAdmin === true,
      adminError?.message ?? `is_cms_admin() returned ${String(isAdmin)}`,
    );

    if (samplePath !== undefined) {
      const { data, error } = await admin.storage
        .from(BUCKET)
        .createSignedUrls([samplePath], SIGNED_URL_TTL_SECONDS);

      const row = data?.[0];

      if (error) {
        assert('admin can sign audio objects', false, error.message);
      } else if (row?.error != null && /not found/i.test(row.error)) {
        skip('admin can sign audio objects', 'the object is absent from storage');
      } else {
        assert(
          'admin can sign audio objects',
          typeof row?.signedUrl === 'string',
          row?.error ?? undefined,
        );
      }
    }
  } finally {
    // Leave no session behind in whatever storage the client picked up.
    await admin.auth.signOut();
  }
}

main().catch((err: unknown) => {
  console.error('\nUnexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
