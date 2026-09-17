/**
 * TASK-508 - Tel Aviv Field QA seed, with Hebrew placeholder narration.
 *
 * Builds one published, walkable, 8-stop tour in north-central Tel Aviv so the
 * geofence engine, Adaptive GPS and the player UX can be exercised on a real
 * pavement rather than in the simulator.
 *
 * It runs the SAME path the CMS runs - cms_upsert_tour, then
 * cms_replace_tour_waypoints, then backend/cms's ingest service per stop, then
 * cms_publish_tour. Nothing here writes a table directly and nothing uses a
 * service_role key, so if this script can seed the tour then the CMS can too,
 * and if RLS would refuse the CMS it refuses this. A seeding script that took a
 * shortcut around the API would prove nothing about the API.
 *
 * -----------------------------------------------------------------------------
 * MODES - pick the smallest one that answers your question
 *
 *   --plan        Route geometry only. Prints every leg, every pairwise
 *                 clearance, and the hysteresis verdict. No network, no ffmpeg,
 *                 no credentials, no writes. Run this after ANY coordinate edit.
 *
 *   --tts-only <dir>
 *                 Synthesise the eight Hebrew MP3s into <dir> and stop, so a
 *                 Hebrew speaker can listen to the copy before it is committed
 *                 to a bucket. Needs network only.
 *
 *   --dry-run     Plan + TTS + the full media pipeline (probe, measure, encode,
 *                 verify). Proves the audio hits -16 LUFS. Needs ffmpeg and
 *                 ffprobe; touches neither Storage nor the database.
 *
 *   (default)     All of the above, then upload, register, validate, publish,
 *                 and read the bundle back as an ANONYMOUS client to prove the
 *                 mobile app can actually fetch what we just wrote.
 *
 * Env:
 *   SUPABASE_URL, SUPABASE_ANON_KEY
 *   SUPABASE_ADMIN_EMAIL, SUPABASE_ADMIN_PASSWORD   - a row in public.app_admins
 *   FFMPEG_PATH, FFPROBE_PATH                       - if not on PATH
 *
 * There is no service_role path, by design. Every cms_* function calls
 * assert_cms_admin() -> is_cms_admin() -> auth.uid(), which is NULL under a
 * service key: the guard would reject it. See backend/cms/client.ts.
 * -----------------------------------------------------------------------------
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { MediaPipelineError } from '../media/index.ts';
import { CmsIngestError, ingestWaypointAudio } from '../cms/index.ts';

// =============================================================================
// 1. The spacing rule
//
// This is the part of the file most likely to be edited by someone adding a
// stop, and the part most likely to be got wrong, so it comes first.
//
// The engine does not use one boundary per zone, it uses two. Entry is tested
// against trigger_radius_meters; exit is tested against
// trigger_radius_meters * exitHysteresisFactor, so a GPS fix trembling on the
// edge cannot produce an enter/exit storm. The consequence is that the
// clearance two waypoints need is set by the EXIT radii, not the entry radii:
//
//     gap  >  (radius_a + radius_b) * exitHysteresisFactor
//
// Comparing against the bare radii is the obvious version and it is wrong. It
// shipped once, on the Jerusalem test tour, where 20 + 25 = 45 m looked clear
// of a 58.7 m gap while the real boundaries were 32 + 40 = 72 m and overlapped.
// The symptom was narration cutting out at Jaffa Gate: one fix emitted enter(1)
// and exit(2) together and the exit stopped the track the enter had just
// started. See the comment block in prod_test_seed.sql and Phase E of
// `npm run sim:walk`.
//
// TourSessionController has since been taught to stop only the track the
// EXITING waypoint owns, which defuses that specific failure. It does not
// defuse the other one: where ENTRY circles overlap, a single fix sits inside
// two zones and fires enter(a) then enter(b), and the second narration replaces
// the first mid-sentence. There is no clean mitigation for that in the client -
// the content simply must not ask for it.
//
// MIRRORED CONSTANT, DELIBERATELY.
// The authority is mobile/src/config/transitProfiles.ts. It cannot be imported
// here: it pulls in expo-location, which is a React Native dependency and not
// installable in the backend workspace. So the number is copied, the way
// storage-path.ts copies isSafeStoragePath from the mobile client - with the
// duplication called out rather than hidden. If the profile changes, change it
// here too; --plan is what tells you whether the change broke the route.
// =============================================================================

const EXIT_HYSTERESIS_FACTOR = { walking: 1.6, biking: 1.5, driving: 1.4 } as const;

/** Documented trigger-radius envelope per mode, also from transitProfiles.ts. */
const TRIGGER_RADIUS_RANGE = {
  walking: [15, 30],
  biking: [50, 80],
  driving: [150, 300],
} as const;

type TransitMode = keyof typeof EXIT_HYSTERESIS_FACTOR;

// =============================================================================
// 2. The route
// =============================================================================

const TOUR_TITLE = '[QA] Tel Aviv Field Walk - TASK-508';
const TRANSIT_MODE: TransitMode = 'walking';
/** cities.slug created by migration 20260918090000 (TASK-1101). */
const CITY_SLUG = 'tel-aviv';
const TOPOLOGY = 'in_city';

/**
 * 45 minutes: ~2.4 km of pavement including the walk back from stop 8 to stop 1
 * (32 min at a real 4.5 km/h) plus dwell time at eight stops.
 *
 * cms_validate_tour will raise the `duration_implausible` WARNING against this,
 * because the placeholder narration totals a few minutes rather than the ~4.5
 * it wants to see. That warning is correct and is left to fire: it is the
 * database noticing that this tour holds synthesised stand-ins rather than
 * finished narration, which is exactly what a reviewer should be told. Warnings
 * do not block publication. Do not tune duration_minutes down to silence it -
 * that would trade a true signal for a tidy log.
 */
const DURATION_MINUTES = 45;

/**
 * 20 m, uniform.
 *
 * Inside the walking envelope of 15-30 m and at the tight end of it, which is
 * what the task asked for and what makes a QA walk informative: a 30 m zone
 * fires so early that a tester cannot tell a working geofence from a lucky one.
 * It is also comfortably above typical urban GPS error, which 15 m is not.
 *
 * Uniform rather than per-stop because every gap on this route clears 64 m -
 * see --plan - so there is no stop that needs shrinking, and a single number is
 * one fewer thing for a field tester to hold in their head.
 */
const TRIGGER_RADIUS_METERS = 20;

interface Stop {
  /** sort_order, and the wpNN prefix in the storage path. */
  sortOrder: number;
  /**
   * Stored in waypoints.name and used for the storage-path slug.
   *
   * English on purpose. slugifyWaypointName folds Hebrew to nothing and falls
   * back to the literal string "waypoint", so a Hebrew name here would give the
   * bucket eight files called wp01_waypoint.m4a .. wp08_waypoint.m4a. Unique,
   * because the wpNN prefix carries uniqueness, but unreadable in a listing at
   * the exact moment somebody is trying to work out which file is broken.
   */
  name: string;
  lat: number;
  lng: number;
  /** The narration. Hebrew, as supplied by the PM - do not paraphrase. */
  text: string;
}

/**
 * The eight anchors.
 *
 * !! ONE COORDINATE HAS BEEN CHANGED FROM THE BRIEF - see STOP_8_RELOCATION !!
 */
const ROUTE: readonly Stop[] = [
  {
    sortOrder: 1,
    name: "Be'eri 36 (Start)",
    lat: 32.0833,
    lng: 34.7891,
    text: 'ברוכים הבאים לסיור שלנו בתל אביב. אנחנו מתחילים כאן, ברחוב בארי 36, בלב הצפון הישן והשקט של העיר.',
  },
  {
    sortOrder: 2,
    name: "The Memorial (Be'eri / Weizmann)",
    lat: 32.0825,
    lng: 34.79,
    text: 'הגענו לאנדרטת ההנצחה בפינת הרחובות בארי וויצמן. עצרו לרגע להתבונן סביב ולכבד את המקום.',
  },
  {
    sortOrder: 3,
    name: 'Ichilov Hospital (Weizmann St)',
    lat: 32.0818,
    lng: 34.7906,
    text: 'מימינכם נמצא בית החולים איכילוב, המרכז הרפואי הגדול של תל אביב. המשיכו ללכת לאורך רחוב ויצמן.',
  },
  {
    sortOrder: 4,
    name: 'Tel Aviv Museum of Art',
    lat: 32.0779,
    lng: 34.7874,
    text: 'הגעתם למוזיאון תל אביב לאמנות. המבנה האדריכלי המרשים שלפניכם מארח את מיטב התערוכות בישראל.',
  },
  {
    sortOrder: 5,
    name: 'The Cameri Theater',
    lat: 32.0775,
    lng: 34.7865,
    text: 'ממש לידנו נמצא תיאטרון הקאמרי, התיאטרון העירוני של תל אביב, שמציג את מיטב המחזות והשחקנים.',
  },
  {
    sortOrder: 6,
    name: 'Beit Ariela Library',
    lat: 32.0789,
    lng: 34.7876,
    text: 'זוהי ספריית בית אריאלה המחודשת. מעבר להיותה ספרייה, מדובר במרכז תרבות שוקק חיים.',
  },
  {
    sortOrder: 7,
    name: 'Dubnov 8 Bistro',
    lat: 32.076,
    lng: 34.785,
    text: 'זמן להפסקה קולינרית. מסעדת דובנוב שמונה מציעה חוויית ביסטרו קלאסית בלב גינה תל אביבית ירוקה ורגועה.',
  },
  {
    sortOrder: 8,
    name: 'Arcaffe Museum Plaza',
    // !! CHANGED. Brief said 32.0778, 34.7870. See STOP_8_RELOCATION below.
    lat: 32.0778,
    lng: 34.7882,
    text: 'לקראת סיום הסיור, תוכלו ליהנות מקפה מצוין כאן ברחבת המוזיאון. תודה שטיילתם איתנו!',
  },
];

/**
 * WHY STOP 8 MOVED, AND WHAT TO DO IF YOU DISAGREE
 *
 * The brief put Arcaffe at 32.0778, 34.7870. That is 39.3 m from the Museum
 * (stop 4) and 57.7 m from the Cameri (stop 5). At a 20 m radius the rule at
 * the top of this file demands 64 m, so both pairs fail - and the Museum pair
 * fails so badly that even the bare ENTRY circles overlap (20 + 20 = 40 m
 * against a 39.3 m gap). A tester standing on the plaza would be inside two
 * zones at once and would hear the museum narration cut off by the cafe's.
 * That is precisely the class of bug this walk exists to catch, so shipping it
 * deliberately would make the QA walk uninformative.
 *
 * Shrinking the radius does not rescue it. Clearing 39.3 m needs
 * 39.3 / (2 * 1.6) = 12.3 m, which is below the 15 m floor of the walking
 * envelope and below ordinary urban GPS error - the zone would often not fire
 * at all. Removing the geofence is not available either: cms_validate_tour
 * treats a waypoint without a zone as an ERROR and refuses to publish.
 *
 * So the only free variable is the coordinate. 34.7870 -> 34.7882 moves the
 * stop ~113 m due east, onto the museum complex's Shaul HaMelech frontage. It
 * stays honestly "רחבת המוזיאון", it is now 76 m from the Museum and 160 m from
 * the Cameri, and it sits on the walk back north-east toward stop 1 rather than
 * doubling the tester back over ground they covered at stop 4.
 *
 * This is a CONTENT decision made on ENGINEERING grounds and it is the PM's to
 * overrule. If you want the original spot back, put it back and run --plan; the
 * script will refuse to seed and tell you exactly which pairs are too close.
 * The three ways out, in the order I would try them:
 *
 *   1. Move stop 8 somewhere else on the plaza that clears 64 m from stops 4
 *      and 5. --plan checks any candidate in a second.
 *   2. Drop stop 8 and fold its outro line into stop 4 or stop 7. Seven stops
 *      is still a complete QA route.
 *   3. Accept it and lose the finding. Not recommended: the whole point of a
 *      field walk is to hear the engine misbehave in a street, and this would
 *      guarantee one misbehaviour that is our own content's fault.
 */
const STOP_8_RELOCATION = { fromLat: 32.0778, fromLng: 34.787, toLat: 32.0778, toLng: 34.7882 };

// =============================================================================
// 3. Geometry
// =============================================================================

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Haversine. Metres. Fine at street scale; this is not a survey instrument. */
function distanceMeters(a: Stop, b: Stop): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

interface Clearance {
  a: Stop;
  b: Stop;
  gapMeters: number;
  requiredMeters: number;
  /** True when the bare entry circles overlap - the worse of the two failures. */
  entryOverlap: boolean;
}

/**
 * Every pair, not just consecutive ones.
 *
 * A route that doubles back - which this one does, around the museum complex -
 * puts non-adjacent stops next to each other in space while they are far apart
 * in sort_order. evaluateGeofences() iterates every waypoint on every fix and
 * neither knows nor cares about tour order, so checking only neighbours would
 * have missed the stop 4 / stop 8 collision entirely.
 */
function auditClearances(stops: readonly Stop[], radius: number, mode: TransitMode): Clearance[] {
  const required = radius * 2 * EXIT_HYSTERESIS_FACTOR[mode];
  const out: Clearance[] = [];

  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const a = stops[i];
      const b = stops[j];
      if (a === undefined || b === undefined) continue;

      const gapMeters = distanceMeters(a, b);
      out.push({ a, b, gapMeters, requiredMeters: required, entryOverlap: gapMeters < radius * 2 });
    }
  }

  return out.sort((x, y) => x.gapMeters - y.gapMeters);
}

function printPlan(): Clearance[] {
  const [min, max] = TRIGGER_RADIUS_RANGE[TRANSIT_MODE];
  const factor = EXIT_HYSTERESIS_FACTOR[TRANSIT_MODE];
  const required = TRIGGER_RADIUS_METERS * 2 * factor;

  console.log(`\nRoute: ${TOUR_TITLE}`);
  console.log(`  ${ROUTE.length} anchor stops, ${TRANSIT_MODE}, ${TRIGGER_RADIUS_METERS} m radii`);
  console.log(`  exit hysteresis x${factor} -> every pair must clear ${required.toFixed(1)} m`);

  if (TRIGGER_RADIUS_METERS < min || TRIGGER_RADIUS_METERS > max) {
    console.log(
      `  WARNING radius ${TRIGGER_RADIUS_METERS} m is outside the documented ` +
        `${TRANSIT_MODE} envelope of ${min}-${max} m.`,
    );
  }

  console.log('\nLegs');
  let walked = 0;
  for (let i = 0; i < ROUTE.length - 1; i++) {
    const a = ROUTE[i];
    const b = ROUTE[i + 1];
    if (a === undefined || b === undefined) continue;
    const d = distanceMeters(a, b);
    walked += d;
    console.log(`  ${a.sortOrder} -> ${b.sortOrder}  ${d.toFixed(0).padStart(4)} m   ${b.name}`);
  }

  const first = ROUTE[0];
  const last = ROUTE[ROUTE.length - 1];
  let closure = 0;
  if (first !== undefined && last !== undefined) {
    closure = distanceMeters(last, first);
    console.log(
      `  ${last.sortOrder} -> ${first.sortOrder}  ${closure.toFixed(0).padStart(4)} m   ` +
        `${first.name}  (loop closure, not a leg)`,
    );
  }
  console.log(
    `  total ${(walked / 1000).toFixed(2)} km walked, ` +
      `${((walked + closure) / 1000).toFixed(2)} km with the return`,
  );

  const clearances = auditClearances(ROUTE, TRIGGER_RADIUS_METERS, TRANSIT_MODE);
  const violations = clearances.filter((c) => c.gapMeters < c.requiredMeters);

  console.log('\nTightest pairs');
  for (const c of clearances.slice(0, 5)) {
    const verdict = c.entryOverlap
      ? 'ENTRY OVERLAP - two zones fire from one fix'
      : c.gapMeters < c.requiredMeters
        ? 'EXIT OVERLAP - enter(a)+exit(b) from one fix'
        : `ok (+${(c.gapMeters - c.requiredMeters).toFixed(1)} m margin)`;
    console.log(
      `  ${String(c.a.sortOrder)} <-> ${String(c.b.sortOrder)}  ` +
        `${c.gapMeters.toFixed(1).padStart(6)} m   ${verdict}`,
    );
  }

  if (STOP_8_RELOCATION.fromLng !== STOP_8_RELOCATION.toLng) {
    console.log(
      `\nNOTE stop 8 sits at ${STOP_8_RELOCATION.toLat}, ${STOP_8_RELOCATION.toLng}, not the ` +
        `briefed ${STOP_8_RELOCATION.fromLat}, ${STOP_8_RELOCATION.fromLng}.\n` +
        '     Read STOP_8_RELOCATION in this file before changing it back.',
    );
  }

  console.log(
    violations.length === 0
      ? `\nSPACING: PASS - no pair closer than ${required.toFixed(1)} m.\n`
      : `\nSPACING: FAIL - ${violations.length} pair(s) too close.\n`,
  );

  return violations;
}

// =============================================================================
// 4. Text to speech
//
// WHY THIS IS TWENTY LINES AND NOT A DEPENDENCY
//
// The brief suggested google-tts-api. That package does not synthesise
// anything: it builds a translate.google.com/translate_tts URL and hands it
// back, and the caller still writes the fetch. What is below is that URL and
// that fetch. Adding a package to package.json for a string template, when the
// whole feature is explicitly temporary and will be deleted the moment real
// voice recordings arrive, buys a dependency somebody has to remember to
// remove.
//
// WHAT THIS IS NOT
//
// This endpoint is undocumented, unversioned, rate-limited and not covered by
// any terms that let us ship its output in a product. It is fine for a QA walk
// - the audio exists so a tester can tell which stop fired - and it is not fine
// for anything a customer pays for. The tracks it produces are labelled in the
// tour title so nobody mistakes them for finished narration.
//
// Hebrew is why it earns its place at all: a Field QA walk in Tel Aviv wants
// Hebrew, and the alternative on offer was synthetic beeps, which cannot tell a
// tester whether stop 4 or stop 8 is playing.
// =============================================================================

/** The endpoint's hard limit per request. */
const TTS_MAX_CHARS = 200;

/**
 * Split on sentence boundaries so a chunk break never lands mid-word.
 *
 * All eight briefed texts fit in one chunk (the longest is 99 characters), so
 * this never fires today. It exists because the copy is the thing most likely
 * to be edited, and the failure without it is a 400 from Google that reads as a
 * network problem rather than as "your paragraph got longer".
 */
function chunkText(text: string): string[] {
  if (text.length <= TTS_MAX_CHARS) return [text];

  const chunks: string[] = [];
  let current = '';

  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (current.length + sentence.length + 1 <= TTS_MAX_CHARS) {
      current = current.length === 0 ? sentence : `${current} ${sentence}`;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    // A single sentence over the limit is cut on length; nothing smarter is
    // worth it for placeholder audio.
    current = sentence.length <= TTS_MAX_CHARS ? sentence : sentence.slice(0, TTS_MAX_CHARS);
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function fetchTtsChunk(text: string, index: number, total: number): Promise<Buffer> {
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8' +
    `&q=${encodeURIComponent(text)}` +
    '&tl=he' +
    `&total=${total}&idx=${index}` +
    `&textlen=${text.length}` +
    '&client=tw-ob&prev=input&ttsspeed=1';

  // Without a browser-ish UA the endpoint answers 403.
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

  if (!response.ok) {
    throw new Error(
      `Google TTS returned ${response.status} for chunk ${index + 1}/${total}. ` +
        'This endpoint is unofficial and rate-limits by IP; wait a minute and retry, or ' +
        'supply pre-recorded audio instead.',
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  // 0xFFEx/0xFFFx is an MPEG frame sync. A rate-limit page comes back as HTML
  // with a 200, and would otherwise reach ffmpeg as a file that "is not audio"
  // three steps later, where the real cause is invisible.
  if (bytes.length < 512 || bytes[0] !== 0xff || (bytes[1] ?? 0) < 0xe0) {
    throw new Error(
      `Google TTS returned ${bytes.length} bytes that are not an MP3 frame. ` +
        'Almost always an IP rate-limit served as an HTML page with status 200.',
    );
  }

  return bytes;
}

/**
 * One stop's narration as a single MP3 buffer.
 *
 * Multiple chunks are concatenated as raw MPEG frames. That is legitimate for
 * MP3 - the format is a stream of self-describing frames with no global header
 * - and it does not need ffmpeg. It would leave the joins slightly rough, which
 * would matter if this were the shipped master; the pipeline re-encodes to AAC
 * from a full decode immediately afterwards, and this is placeholder audio.
 */
async function synthesise(stop: Stop): Promise<Buffer> {
  const chunks = chunkText(stop.text);
  const buffers: Buffer[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    buffers.push(await fetchTtsChunk(chunk, i, chunks.length));
    // Serial, with a gap. Eight parallel requests from one IP is how you get
    // rate-limited into an HTML page that pretends to be audio.
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  return Buffer.concat(buffers);
}

// =============================================================================
// 5. Database
// =============================================================================

interface WaypointRow {
  id: string;
  name: string;
  sort_order: number;
}

async function adminClient(): Promise<SupabaseClient> {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  const email = process.env['SUPABASE_ADMIN_EMAIL'];
  const password = process.env['SUPABASE_ADMIN_PASSWORD'];

  if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');
  if (!email || !password) {
    throw new Error(
      'SUPABASE_ADMIN_EMAIL and SUPABASE_ADMIN_PASSWORD must be set - they must name an ' +
        'account that has a row in public.app_admins.\n' +
        'There is no service_role fallback: every cms_* function resolves auth.uid(), which a ' +
        'service key leaves NULL, so the guard rejects it. See backend/cms/client.ts.\n' +
        'Use --dry-run to exercise TTS and the media pipeline without any credentials.',
    );
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`Could not sign in as ${email}: ${error?.message ?? 'no session returned'}`);
  }

  const { data: isAdmin, error: adminError } = await supabase.rpc('is_cms_admin');
  if (adminError) throw new Error(`is_cms_admin() failed: ${adminError.message}`);
  if (isAdmin !== true) {
    throw new Error(
      `${email} signed in but is not a CMS admin - there is no row for it in public.app_admins. ` +
        'Every write below would fail with 42501.',
    );
  }

  return supabase;
}

async function accessTokenOf(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined) throw new Error('Admin session vanished between sign-in and use.');
  return token;
}

/**
 * Find this tour, or create it.
 *
 * Re-runnable by TITLE rather than by a hard-coded uuid, because cms_upsert_tour
 * is the only sanctioned way in and it does not accept a caller-chosen id: pass
 * NULL and it INSERTs with a generated one, pass an id that does not exist and
 * it raises no_data_found. Looking the row up first is what makes a second run
 * update the tour it made on the first rather than accumulating a new one per
 * invocation.
 *
 * The lookup needs the admin session because a draft tour is invisible to anon
 * - tours_read_published gates on status, and this tour is a draft until the
 * last step.
 */
async function upsertTour(supabase: SupabaseClient): Promise<string> {
  const { data: existing, error: lookupError } = await supabase
    .from('tours')
    .select('id')
    .eq('title', TOUR_TITLE)
    .limit(1);

  if (lookupError) throw new Error(`Could not look up the tour: ${lookupError.message}`);

  const existingId = (existing?.[0] as { id?: string } | undefined)?.id;

  const { data, error } = await supabase.rpc('cms_upsert_tour', {
    p_tour_id: existingId ?? null,
    p_title: TOUR_TITLE,
    p_topology: TOPOLOGY,
    p_transit_mode: TRANSIT_MODE,
    p_duration_minutes: DURATION_MINUTES,
  });

  if (error) throw new Error(`cms_upsert_tour failed: ${error.message}`);

  const id = (data as { id?: string } | null)?.id;
  if (id === undefined) throw new Error('cms_upsert_tour returned no id.');

  console.log(`  tour ${existingId === undefined ? 'created' : 'updated'}  ${id}`);
  await assignCity(supabase, id);
  return id;
}

/**
 * Put the tour under Tel Aviv (TASK-1101). cms_validate_tour refuses to publish
 * a tour with no city, and migration 20260918090000 creates the `tel-aviv` row,
 * so a missing row here means that migration has not been pushed.
 */
async function assignCity(supabase: SupabaseClient, tourId: string): Promise<void> {
  const { data: city, error: cityError } = await supabase
    .from('cities')
    .select('id')
    .eq('slug', CITY_SLUG)
    .maybeSingle();
  if (cityError) throw new Error(`Could not look up city ${CITY_SLUG}: ${cityError.message}`);
  const cityId = (city as { id?: string } | null)?.id;
  if (cityId === undefined) {
    throw new Error(`City ${CITY_SLUG} does not exist. Push migration 20260918090000_cities.sql first.`);
  }

  const { error } = await supabase.rpc('cms_set_tour_city', { p_tour_id: tourId, p_city_id: cityId });
  if (error) throw new Error(`cms_set_tour_city failed: ${error.message}`);
}

/**
 * Write all eight waypoints and their zones, then read the ids back.
 *
 * The read-back is not optional. cms_replace_tour_waypoints returns counts, not
 * ids - it INSERTs with generated uuids for any entry whose `id` is null - and
 * the ingest service needs a waypoint id per stop. Matching on sort_order is
 * safe because waypoints_tour_sort_order_key makes it unique within a tour.
 */
async function replaceWaypoints(
  supabase: SupabaseClient,
  tourId: string,
): Promise<Map<number, WaypointRow>> {
  const payload = ROUTE.map((stop) => ({
    id: null,
    name: stop.name,
    // Every stop is an anchor: each one has its own narration and is a place
    // the tester is meant to stop at. 'transition' would be right for a "turn
    // left here" cue, and there are none on this route.
    poi_type: 'anchor',
    lon: stop.lng,
    lat: stop.lat,
    sort_order: stop.sortOrder,
    geofence: { type: 'radius', radius_meters: TRIGGER_RADIUS_METERS },
  }));

  const { data, error } = await supabase.rpc('cms_replace_tour_waypoints', {
    p_tour_id: tourId,
    p_waypoints: payload,
  });

  if (error) throw new Error(`cms_replace_tour_waypoints failed: ${error.message}`);

  const result = data as { upserted: number; deleted: number; orphaned_objects: string[] };
  console.log(`  waypoints upserted ${result.upserted}, deleted ${result.deleted}`);

  // Every entry above carries id: null, so a re-run deletes the previous eight
  // and inserts eight fresh ones. Their audio_tracks rows cascade away with
  // them, but the OBJECTS do not - SQL cannot reach the Storage API. The RPC
  // hands the paths back precisely so the caller can finish the job.
  if (result.orphaned_objects.length > 0) {
    console.log(
      `  removing ${result.orphaned_objects.length} orphaned object(s) from a previous run`,
    );
    const { error: removeError } = await supabase.storage
      .from('audio-tracks')
      .remove(result.orphaned_objects);
    if (removeError) {
      console.log(`  WARNING could not remove orphans: ${removeError.message}`);
      console.log(`           ${result.orphaned_objects.join('\n           ')}`);
    }
  }

  const { data: rows, error: readError } = await supabase
    .from('waypoints')
    .select('id,name,sort_order')
    .eq('tour_id', tourId)
    .order('sort_order');

  if (readError) throw new Error(`Could not read waypoints back: ${readError.message}`);

  const byOrder = new Map<number, WaypointRow>();
  for (const row of (rows ?? []) as WaypointRow[]) byOrder.set(row.sort_order, row);

  if (byOrder.size !== ROUTE.length) {
    throw new Error(`Expected ${ROUTE.length} waypoints back, got ${byOrder.size}.`);
  }

  return byOrder;
}

async function validate(supabase: SupabaseClient, tourId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('cms_validate_tour', { p_tour_id: tourId });
  if (error) throw new Error(`cms_validate_tour failed: ${error.message}`);

  const findings = (data ?? []) as { severity: string; code: string; detail: string }[];

  if (findings.length === 0) {
    console.log('  clean - no errors, no warnings');
    return true;
  }

  for (const f of findings) {
    console.log(`  ${f.severity.toUpperCase().padEnd(7)} ${f.code}: ${f.detail}`);
  }
  return findings.every((f) => f.severity !== 'error');
}

/**
 * Read the tour back the way the phone will.
 *
 * A separate, ANONYMOUS client - not the admin one. The admin session can see
 * drafts and can read every object in the bucket, so verifying through it would
 * prove nothing about what a tourist's app can reach. This is the only step
 * that actually tests the thing the handover claims.
 */
async function verifyAsAnonymousClient(tourId: string): Promise<void> {
  const url = process.env['SUPABASE_URL'];
  const anonKey = process.env['SUPABASE_ANON_KEY'];
  if (!url || !anonKey) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set.');

  const anon = createClient(url, anonKey, { auth: { persistSession: false } });

  const { data, error } = await anon.rpc('get_tour_bundle', { p_tour_id: tourId });
  if (error) throw new Error(`get_tour_bundle failed for an anonymous client: ${error.message}`);

  // `media`, NOT `audio`. The key names here mirror
  // mobile/src/services/bundle/types.ts (WireWaypoint / WireMedia) exactly,
  // because the whole point of this step is to read the payload the way the
  // device reads it. An earlier version of this function guessed `audio` and
  // reported "0 of 8 waypoints carry audio" against a tour that was in fact
  // perfectly seeded - a verification step that fails for its own reasons is
  // worse than none, because it sends you debugging the wrong system.
  const bundle = data as {
    bundle_version_hash: string;
    waypoints: {
      name: string;
      geofence: { radius_meters?: number } | null;
      media: { storage_path: string; size_bytes: number; duration_seconds: number | null } | null;
    }[];
  } | null;

  if (bundle === null) throw new Error('get_tour_bundle returned null to an anonymous client.');

  const paths = bundle.waypoints
    .map((w) => w.media?.storage_path)
    .filter((p): p is string => p !== undefined);

  const totalBytes = bundle.waypoints.reduce((n, w) => n + (w.media?.size_bytes ?? 0), 0);
  const totalSeconds = bundle.waypoints.reduce((n, w) => n + (w.media?.duration_seconds ?? 0), 0);
  const zoned = bundle.waypoints.filter((w) => w.geofence !== null).length;

  console.log(`  bundle_version_hash  ${bundle.bundle_version_hash}`);
  console.log(`  waypoints            ${bundle.waypoints.length}`);
  console.log(`  geofence zones       ${zoned}`);
  console.log(`  audio tracks         ${paths.length}`);
  console.log(`  total audio          ${totalSeconds}s in ${totalBytes.toLocaleString()} bytes`);

  // A waypoint the device cannot trigger is as broken as one it cannot hear,
  // and cms_validate_tour only checks this for the admin's view of the rows.
  if (zoned !== bundle.waypoints.length) {
    throw new Error(
      `Only ${zoned} of ${bundle.waypoints.length} waypoints carry a geofence in the bundle.`,
    );
  }

  if (paths.length !== ROUTE.length) {
    throw new Error(`Only ${paths.length} of ${ROUTE.length} waypoints carry audio in the bundle.`);
  }

  // The bucket is private since 20260827180000. The client gets bytes only if
  // the storage policy will sign for it, which is gated on the same published
  // status - so this is the step that proves publishing actually unlocked the
  // media, not just the metadata.
  const { data: signed, error: signError } = await anon.storage
    .from('audio-tracks')
    .createSignedUrls(paths, 60);

  if (signError) {
    throw new Error(`Anonymous client could not sign the audio URLs: ${signError.message}`);
  }

  const failed = (signed ?? []).filter((s) => s.signedUrl === null || s.error !== null);
  if (failed.length > 0) {
    throw new Error(`${failed.length} object(s) would not sign for an anonymous client.`);
  }

  console.log(`  signed URLs          ${signed?.length ?? 0}/${paths.length} OK`);
}

// =============================================================================
// 6. Entry point
// =============================================================================

interface Args {
  plan: boolean;
  dryRun: boolean;
  ttsOnly: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  let plan = false;
  let dryRun = false;
  let ttsOnly: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--plan':
        plan = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--tts-only': {
        const value = argv[++i];
        if (value === undefined) {
          console.error('--tts-only needs an output directory.');
          process.exit(1);
        }
        ttsOnly = value;
        break;
      }
      default:
        console.error(`Unknown option ${String(arg)}.`);
        process.exit(1);
    }
  }

  return { plan, dryRun, ttsOnly };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ALWAYS, in every mode. Seeding a route whose zones overlap wastes a field
  // walk, and a field walk costs an afternoon and a pair of shoes.
  const violations = printPlan();

  if (violations.length > 0) {
    console.error('Refusing to seed a route with overlapping geofences.');
    console.error('Fix the coordinates or the radius, then re-run --plan.\n');
    process.exit(1);
  }

  if (args.plan) return;

  if (args.ttsOnly !== null) {
    const dir = resolve(args.ttsOnly);
    await mkdir(dir, { recursive: true });
    console.log(`Synthesising Hebrew narration into ${dir}\n`);

    for (const stop of ROUTE) {
      const mp3 = await synthesise(stop);
      const index = String(stop.sortOrder).padStart(2, '0');
      await writeFile(resolve(dir, `wp${index}.mp3`), mp3);
      console.log(`  wp${index}  ${String(mp3.length).padStart(7)} bytes  ${stop.name}`);
    }

    console.log('\nListen to these before seeding. Nothing was uploaded.\n');
    return;
  }

  // Sign in BEFORE spending a minute on TTS and three ffmpeg passes per stop.
  // A bad password should cost a second, not the whole encode.
  const supabase = args.dryRun ? null : await adminClient();
  const accessToken = supabase === null ? null : await accessTokenOf(supabase);

  let tourId: string | null = null;
  let waypoints: Map<number, WaypointRow> = new Map();

  if (supabase !== null) {
    console.log('Tour and waypoints');
    tourId = await upsertTour(supabase);
    waypoints = await replaceWaypoints(supabase, tourId);
  }

  console.log(
    `\nNarration  (TTS -> EBU R128 -16 LUFS -> AAC-LC` +
      `${supabase === null ? ', dry run' : ' -> bucket -> audio_tracks'})`,
  );

  const allWarnings: string[] = [];

  for (const stop of ROUTE) {
    const waypoint = waypoints.get(stop.sortOrder);
    const mp3 = await synthesise(stop);

    const result = await ingestWaypointAudio({
      ...(accessToken === null ? {} : { accessToken }),
      // A dry run never reaches the database, but assertValidRequest still
      // wants syntactically valid uuids, so it gets the nil-ish uuid rather
      // than a fake that might one day collide with something real.
      tourId: tourId ?? '00000000-0000-4000-8000-000000000000',
      waypointId: waypoint?.id ?? '00000000-0000-4000-8000-000000000000',
      sortOrder: stop.sortOrder,
      waypointName: stop.name,
      dryRun: supabase === null,
      source: { bytes: mp3, filename: `wp${stop.sortOrder}.mp3` },
    });

    console.log(
      `  wp${String(stop.sortOrder).padStart(2, '0')}  ` +
        `${String(result.durationSeconds).padStart(3)}s  ` +
        `${String(result.sizeBytes).padStart(7)}B  ` +
        `${result.loudness.encoded.integratedLufs.toFixed(2).padStart(7)} LUFS  ` +
        `${result.loudness.encoded.truePeakDb.toFixed(2).padStart(6)} dBTP  ` +
        `${result.storagePath}`,
    );

    // The lossy-source warning fires on every stop by construction - the TTS
    // endpoint hands back MP3 - so it is collected rather than printed eight
    // times. It is also true and worth keeping: it is the pipeline correctly
    // objecting that this is placeholder audio.
    for (const w of result.warnings) if (!allWarnings.includes(w)) allWarnings.push(w);
  }

  if (allWarnings.length > 0) {
    console.log('\nPipeline warnings (deduplicated across stops)');
    for (const w of allWarnings) console.log(`  - ${w}`);
  }

  if (supabase === null || tourId === null) {
    console.log('\nDRY RUN - nothing was uploaded, registered or published.\n');
    return;
  }

  console.log('\nValidation');
  const publishable = await validate(supabase, tourId);
  if (!publishable) {
    console.error('\nRefusing to publish: cms_validate_tour reported errors.\n');
    process.exitCode = 1;
    return;
  }

  const { error: publishError } = await supabase.rpc('cms_publish_tour', { p_tour_id: tourId });
  if (publishError) throw new Error(`cms_publish_tour failed: ${publishError.message}`);
  console.log('  published');

  console.log('\nVerification as an anonymous mobile client');
  await verifyAsAnonymousClient(tourId);

  console.log(`\nDone. TEST_TOUR_ID=${tourId}\n`);
}

// process.exitCode rather than process.exit(), and the difference is not
// stylistic. supabase-js issues its requests through undici, which keeps
// sockets alive between calls; calling process.exit() from here tears the
// process down while one of those handles is mid-close, and libuv on Windows
// notices - "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" lands
// underneath the real error message and looks far more alarming than the thing
// that actually went wrong. Setting the code and letting the loop drain gets
// the same exit status with none of that.
//
// The process.exit() calls in parseArgs() and the spacing check are left alone
// deliberately: both run before anything has opened a socket, so there is no
// handle to race, and exiting immediately there is the correct behaviour.
main().catch((error: unknown) => {
  if (error instanceof CmsIngestError || error instanceof MediaPipelineError) {
    console.error(`\n${error.code}: ${error.message}`);
    if (error.detail !== undefined) console.error(`\n${error.detail}`);
    process.exitCode = 1;
    return;
  }

  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
