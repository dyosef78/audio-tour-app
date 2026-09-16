/**
 * TASK-504 - end-to-end walk simulator.
 *
 * Proves the chain the field test would otherwise be the first to exercise:
 *
 *     scripted GPS fix -> geofence match -> OFFLINE file lookup -> audio trigger
 *
 * Design rule: this drives the REAL LocationService, the real geometry helpers
 * and the real transit profiles. A harness that reimplemented containment would
 * only ever prove that the reimplementation works. The two expo packages the
 * engine imports are stubbed at module-resolution time - see expo-stub-hooks.mjs
 * - and nothing else is faked except the audio sink, which cannot decode AAC in
 * Node and instead records what it was asked to play.
 *
 * The audio it looks up is REAL. The simulator signs, downloads and byte-checks
 * the tour's actual tracks into a local bundle laid out exactly as paths.ts lays
 * it out on a device, then asserts every trigger resolves to a `file://` URI
 * backed by bytes on disk. That is what makes "offline" a measured property
 * rather than a claim.
 *
 * Run:  npm run sim:walk
 *       npm run sim:walk -- --tour <uuid>     pin a tour
 *       npm run sim:walk -- --keep            keep the downloaded bundle
 *
 * Env:  SUPABASE_URL, SUPABASE_ANON_KEY (same as npm run test:db)
 */

import { createClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LocationService, type GeofenceEvent } from '../src/services/location/LocationService.ts';
import { distanceMeters } from '../src/services/location/geometry.ts';
import { profileFor } from '../src/config/transitProfiles.ts';
import { currentWatchOptions, resetCalls, restartCount } from './stubs/expo-location.ts';
import type { AudioTrack, LatLng, TransitMode, Waypoint } from '../src/types/domain.ts';

// -----------------------------------------------------------------------------
// Args + env
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argOf = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

const PINNED_TOUR_ID = argOf('--tour') ?? process.env.TEST_TOUR_ID;
const KEEP_BUNDLE = argv.includes('--keep');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY. Copy .env.example to .env first.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BUCKET = 'audio-tracks';
const SIM_BUNDLE_ROOT = resolvePath(import.meta.dirname, '.sim-bundle');

// -----------------------------------------------------------------------------
// Reporting
// -----------------------------------------------------------------------------

let failures = 0;

function pass(label: string, detail?: string): void {
  console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`);
}

function assert(label: string, ok: boolean, detail?: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

/**
 * Loud, but not a failure.
 *
 * Reserved for a known, accepted gap that no code change in this session closes
 * - currently the unapplied Adaptive GPS tier. Counting it as a failure would
 * leave the simulator permanently red and teach everyone to ignore the result,
 * which costs more than the warning is worth.
 */
function warn(label: string, detail: string): void {
  console.log(`  WARN  ${label}
        ${detail}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

// -----------------------------------------------------------------------------
// Geodesy for the scripted walk
// -----------------------------------------------------------------------------

const METRES_PER_DEG_LAT = 111_320;

/**
 * Offset a coordinate by a north/east displacement in metres.
 *
 * A local flat-earth step, which is correct at the scale of a walk across one
 * plaza. The engine under test uses haversine for its own measurements, so any
 * error here shows up as a slightly wrong step length, never as a wrong verdict.
 */
function offsetMeters(origin: LatLng, northM: number, eastM: number): LatLng {
  const latitude = origin.latitude + northM / METRES_PER_DEG_LAT;
  const longitude =
    origin.longitude + eastM / (METRES_PER_DEG_LAT * Math.cos((origin.latitude * Math.PI) / 180));
  return { latitude, longitude };
}

/** A point `distance` metres from `target`, on the bearing back towards `from`. */
function pointAtDistanceFrom(target: LatLng, from: LatLng, distance: number): LatLng {
  const total = distanceMeters(target, from);
  if (total === 0) return target;
  const f = distance / total;
  return {
    latitude: target.latitude + (from.latitude - target.latitude) * f,
    longitude: target.longitude + (from.longitude - target.longitude) * f,
  };
}

// -----------------------------------------------------------------------------
// The offline bundle - real bytes, laid out exactly as paths.ts does on device
// -----------------------------------------------------------------------------

/**
 * Mirrors mobile/src/services/bundle/paths.ts.
 *
 * Kept as a copy rather than an import because paths.ts pulls in
 * expo-file-system's Paths.document, which has no meaning in Node. The LAYOUT is
 * what matters and it is reproduced exactly: <root>/<tourId>/media/<storage_path>,
 * with the bucket path preserved verbatim. If those two ever diverge, the device
 * looks somewhere this simulator never checked.
 */
function localMediaPath(tourId: string, storagePath: string): string {
  return join(SIM_BUNDLE_ROOT, tourId, 'media', ...storagePath.split('/'));
}

interface WireMedia {
  /** Added by migration 20260828150000; absent from older manifests. */
  audio_track_id?: string | null;
  storage_path: string;
  duration_seconds: number | null;
  size_bytes: number;
  format: string | null;
}

interface WireGeofence {
  type: string;
  center?: [number, number];
  radius_meters?: number | null;
  ring?: [number, number][];
}

interface WireWaypoint {
  waypoint_id: string;
  name: string;
  poi_type: string;
  sort_order: number;
  coordinates: [number, number];
  geofence: WireGeofence | null;
  media: WireMedia | null;
}

interface WireBundle {
  bundle_version_hash: string;
  tour_metadata: { tour_id: string; title: string; transit_mode: string };
  waypoints: WireWaypoint[];
}

async function resolveTourId(): Promise<string> {
  if (PINNED_TOUR_ID) return PINNED_TOUR_ID;
  const { data, error } = await supabase
    .from('tours')
    .select('id')
    .eq('status', 'published')
    .order('id')
    .limit(1);
  if (error) throw new Error(`could not list tours: ${error.message}`);
  const id = data?.[0]?.id as string | undefined;
  if (!id) throw new Error('this database exposes no published tours; see npm run test:db');
  return id;
}

/**
 * Fetch the bundle, sign every track in ONE batch, download, and verify size.
 *
 * Deliberately the same contract DownloadManager enforces on device: URLs are
 * paired by storage_path and never by index, and the size check is `===` with no
 * tolerance. If this step passes, a real download of the same tour will too.
 */
async function materialiseBundle(tourId: string): Promise<WireBundle> {
  const { data, error } = await supabase.rpc('get_tour_bundle', { p_tour_id: tourId });
  if (error) throw new Error(`get_tour_bundle failed: ${error.message}`);
  const bundle = data as WireBundle | null;
  if (!bundle) throw new Error(`get_tour_bundle returned nothing for ${tourId}`);

  const media = bundle.waypoints.map((w) => w.media).filter((m): m is WireMedia => m !== null);
  const paths = [...new Set(media.map((m) => m.storage_path))];

  const { data: signed, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(paths, 300);
  if (signError) throw new Error(`could not sign audio URLs: ${signError.message}`);

  // Keyed by path, exactly as signedAudioUrls() does. Index pairing would hand
  // track 3's bytes to track 1 and the size check could not reliably catch it.
  const urls = new Map<string, string>();
  for (const row of signed ?? []) {
    if (row.error !== null || row.path === null || row.signedUrl === null) continue;
    urls.set(row.path, row.signedUrl);
  }

  for (const m of media) {
    const destination = localMediaPath(tourId, m.storage_path);

    if (existsSync(destination) && statSync(destination).size === m.size_bytes) {
      pass(`cached ${m.storage_path}`, `${m.size_bytes} bytes`);
      continue;
    }

    const url = urls.get(m.storage_path);
    if (url === undefined) {
      assert(`signed URL issued for ${m.storage_path}`, false, 'tour may be unpublished');
      continue;
    }

    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);

    // Strict equality, no tolerance - the rule DownloadManager enforces.
    assert(
      `downloaded ${m.storage_path}`,
      bytes.byteLength === m.size_bytes,
      `${bytes.byteLength} bytes vs size_bytes ${m.size_bytes}`,
    );
  }

  return bundle;
}

/** Wire shape -> domain Waypoint, mirroring TourBundleRepository.toWaypoint(). */
function toWaypoints(tourId: string, bundle: WireBundle): Waypoint[] {
  return bundle.waypoints
    .map((w): Waypoint => {
      const [longitude, latitude] = w.coordinates;
      const g = w.geofence;

      const audio: AudioTrack | null = w.media
        ? {
            id: `${w.waypoint_id}:audio`,
            waypointId: w.waypoint_id,
            storagePath: w.media.storage_path,
            audioTrackId: w.media.audio_track_id ?? null,
            durationSeconds: w.media.duration_seconds,
            format: w.media.format ?? 'AAC',
            sizeBytes: w.media.size_bytes,
            // Derived at read time from storage_path - never persisted, which is
            // what keeps a bundle valid across the iOS container UUID rotation.
            localUri: pathToFileURL(localMediaPath(tourId, w.media.storage_path)).href,
          }
        : null;

      const geofence: Waypoint['geofence'] =
        g === null
          ? null
          : g.type === 'polygon'
            ? {
                id: `${w.waypoint_id}:zone`,
                waypointId: w.waypoint_id,
                zoneType: 'polygon',
                ring: (g.ring ?? []).map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
              }
            : {
                id: `${w.waypoint_id}:zone`,
                waypointId: w.waypoint_id,
                zoneType: 'radius',
                center: {
                  latitude: g.center?.[1] ?? latitude,
                  longitude: g.center?.[0] ?? longitude,
                },
                radiusMeters: g.radius_meters ?? 0,
              };

      return {
        id: w.waypoint_id,
        tourId,
        name: w.name,
        poiType: w.poi_type as Waypoint['poiType'],
        coordinate: { latitude, longitude },
        sortOrder: w.sort_order,
        geofence,
        audio,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

// -----------------------------------------------------------------------------
// Audio sink - stands in for AudioService, which cannot decode AAC in Node
// -----------------------------------------------------------------------------

interface PlayCall {
  waypointName: string;
  trackId: string;
  uri: string;
  atMs: number;
}

/**
 * Records what the session controller would have played.
 *
 * It enforces the property TASK-503 asks about and that a device test would
 * struggle to observe: that the URI handed to the player is a LOCAL file. A
 * stream URL reaching this point fails the run rather than quietly working
 * because the simulator happens to be online.
 */
class RecordingAudioSink {
  readonly plays: PlayCall[] = [];
  readonly stops: { waypointName: string; atMs: number }[] = [];
  private current: string | null = null;

  play(track: AudioTrack, uri: string, waypointName: string, atMs: number): void {
    if (!uri.startsWith('file://')) {
      assert(`${waypointName}: trigger uses a local file`, false, `got ${uri.slice(0, 60)}`);
    }
    this.plays.push({ waypointName, trackId: track.id, uri, atMs });
    this.current = track.id;
  }

  /**
   * Mirrors TourSessionController's exit branch: an exit silences the track the
   * exiting waypoint owns, and nothing else. Passing the owning track id rather
   * than stopping unconditionally is the whole point - see Phase E.
   */
  stop(waypointName: string, atMs: number, ownedTrackId: string | null): void {
    if (ownedTrackId === null || this.current !== ownedTrackId) return;
    this.stops.push({ waypointName, atMs });
    this.current = null;
  }

  get nowPlaying(): string | null {
    return this.current;
  }

  reset(): void {
    this.plays.length = 0;
    this.stops.length = 0;
  }
}

// -----------------------------------------------------------------------------
// The walk
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const tourId = await resolveTourId();
  console.log(`Simulating against ${SUPABASE_URL}`);
  console.log(`Tour ${tourId}`);

  heading('1. Materialise the offline bundle (sign -> download -> byte-check)');
  const bundle = await materialiseBundle(tourId);
  const waypoints = toWaypoints(tourId, bundle);
  const transitMode = (bundle.tour_metadata.transit_mode ?? 'walking') as TransitMode;
  const profile = profileFor(transitMode);

  console.log(`\n  ${bundle.tour_metadata.title}  [${transitMode}]`);
  for (const w of waypoints) {
    const zone = w.geofence;
    const extent = zone?.zoneType === 'radius' ? `r=${zone.radiusMeters}m` : 'polygon';
    console.log(
      `  ${w.sortOrder}. ${w.name.padEnd(26)} ${extent.padEnd(10)} ${w.audio ? 'audio' : 'NO AUDIO'}`,
    );
  }

  // Narrowed once, into locals. Mixing `target?.geofence` and `target.geofence`
  // in a single guard defeats TypeScript's narrowing of the nested property, and
  // the closures below would drop it again in any case.
  const target = waypoints[0];
  const targetZone = target?.geofence ?? null;
  const targetAudio = target?.audio ?? null;
  if (
    target === undefined ||
    targetZone === null ||
    targetZone.zoneType !== 'radius' ||
    targetAudio === null
  ) {
    console.error('\nThe first waypoint needs a radius geofence and an audio track to simulate.');
    process.exit(1);
  }
  const centre = targetZone.center;
  const radius = targetZone.radiusMeters;
  const exitRadius = radius * profile.exitHysteresisFactor;

  // Every trigger must resolve to bytes on disk. Checked before the walk so a
  // missing file is reported as a missing file, not as a geofence failure.
  heading('2. Offline file lookup');
  for (const w of waypoints) {
    if (!w.audio?.localUri) continue;
    const path = localMediaPath(tourId, w.audio.storagePath);
    const onDisk = existsSync(path) ? statSync(path).size : -1;
    assert(
      `${w.name}: local file present at the exact declared size`,
      onDisk === w.audio.sizeBytes,
      `${onDisk} bytes vs ${w.audio.sizeBytes}`,
    );
    assert(`${w.name}: localUri is a file:// URI`, w.audio.localUri.startsWith('file://'));
  }

  // --- wire the real engine to the recording sink ----------------------------
  const sink = new RecordingAudioSink();
  const events: GeofenceEvent[] = [];
  const service = new LocationService(transitMode);
  service.loadTour(waypoints, transitMode);

  // Mirrors TourSessionController.handleGeofence().
  service.setCallbacks({
    onGeofence: (event) => {
      events.push(event);
      const track = event.waypoint.audio;
      if (event.type === 'enter') {
        if (track?.localUri) sink.play(track, track.localUri, event.waypoint.name, event.timestamp);
      } else {
        sink.stop(event.waypoint.name, event.timestamp, track?.id ?? null);
      }
    },
  });

  // A virtual clock: the re-trigger cooldown is ten minutes and nobody should
  // wait ten minutes for a test to finish.
  let clock = Date.now();
  const step = (fix: LatLng, advanceMs: number): void => {
    clock += advanceMs;
    service.onFix(fix, 8, clock);
  };

  // --- Phase A: approach from outside ---------------------------------------
  heading(`3. Phase A - walk in from 150 m (entry radius ${radius} m)`);
  const approachFrom = offsetMeters(centre, -150, -40);
  for (let d = 150; d >= 0; d -= 10) {
    step(pointAtDistanceFrom(centre, approachFrom, d), 8_000);
  }
  const entersA = events.filter((e) => e.type === 'enter' && e.waypoint.id === target.id);
  assert('exactly one enter fired on approach', entersA.length === 1, `${entersA.length} enters`);
  assert('narration was triggered', sink.plays.length === 1, `${sink.plays.length} play calls`);
  if (sink.plays[0]) {
    assert('the trigger played a local file', sink.plays[0].uri.startsWith('file://'));
    console.log(`        -> ${sink.plays[0].uri.split('/').pop()}`);
  }

  // --- Phase B: linger on the boundary with jitter ---------------------------
  heading(`4. Phase B - linger on the edge with GPS jitter (exit needs ${exitRadius.toFixed(0)} m)`);
  const beforeB = { plays: sink.plays.length, stops: sink.stops.length };
  // Jitter around the entry boundary: a real fix wanders several metres either
  // side of it while the user stands still reading a plaque.
  const jitter = [18, 23, 19, 27, 21, 24, 17, 29, 22, 26, 20, 28];
  for (const d of jitter) {
    step(pointAtDistanceFrom(centre, approachFrom, d), 5_000);
  }
  assert(
    'boundary jitter caused NO audio restart',
    sink.plays.length === beforeB.plays,
    `${sink.plays.length - beforeB.plays} extra plays`,
  );
  assert(
    'boundary jitter caused NO spurious exit',
    sink.stops.length === beforeB.stops,
    `${sink.stops.length - beforeB.stops} stops`,
  );
  console.log(`        jitter spanned ${Math.min(...jitter)}-${Math.max(...jitter)} m from centre`);

  // --- Phase C: genuine exit, then immediate re-entry ------------------------
  heading('5. Phase C - leave properly, then walk straight back in');
  const beforeC = sink.plays.length;
  step(pointAtDistanceFrom(centre, approachFrom, exitRadius + 6), 10_000);
  const exited = events.some((e) => e.type === 'exit' && e.waypoint.id === target.id);
  assert('crossing the hysteresis boundary fired an exit', exited);

  step(pointAtDistanceFrom(centre, approachFrom, radius - 5), 30_000);
  assert(
    'immediate re-entry did not replay the narration',
    sink.plays.length === beforeC,
    `${sink.plays.length - beforeC} replays inside the ${profile.retriggerCooldownMs / 60_000} min window`,
  );

  // --- Phase D: cooldown expiry ---------------------------------------------
  //
  // Before TASK-902 a return after the cooldown replayed the stop. Entry is now
  // sequenced: a narrated stop is passed and never re-armed, however long the
  // visitor is away, so the cooldown no longer decides this.
  heading(`6. Phase D - return after the ${profile.retriggerCooldownMs / 60_000} min cooldown`);
  const beforeD = sink.plays.length;
  step(pointAtDistanceFrom(centre, approachFrom, exitRadius + 6), 5_000);
  step(pointAtDistanceFrom(centre, approachFrom, radius - 5), profile.retriggerCooldownMs + 60_000);
  assert(
    'a return after the cooldown does not replay a stop already narrated (TASK-902)',
    sink.plays.length === beforeD,
    `${sink.plays.length - beforeD} replays`,
  );

  // --- Phase E: adjacent waypoints, on a FRESH engine ------------------------
  //
  // Deliberately a new LocationService. Phases A-D passed waypoint 1, and a stop
  // that cannot fire would mask the very thing this phase exists to test: what
  // happens when one waypoint is entered and another exited on the SAME fix.
  // Since TASK-902 only the next stop in order is armed, so the walk goes 1 -> 2.
  const second = waypoints[1];
  if (second?.geofence?.zoneType === 'radius' && second.audio) {
    heading('7. Phase E - out-of-order arrival, then one fix that exits a zone and enters the next');

    const gap = distanceMeters(centre, second.geofence.center);
    const secondExit = second.geofence.radiusMeters * profile.exitHysteresisFactor;
    const entrySum = radius + second.geofence.radiusMeters;
    const exitSum = exitRadius + secondExit;

    console.log(`        ${target.name} <-> ${second.name}: ${gap.toFixed(1)} m apart`);
    console.log(
      `        entry radii ${radius}+${second.geofence.radiusMeters} = ${entrySum} m ` +
        `(${entrySum > gap ? 'OVERLAP' : 'clear'})`,
    );
    console.log(
      `        exit radii  ${exitRadius.toFixed(0)}+${secondExit.toFixed(0)} = ${exitSum.toFixed(0)} m ` +
        `(${exitSum > gap ? 'OVERLAP - a single fix can enter one and exit the other' : 'clear'})`,
    );

    const freshSink = new RecordingAudioSink();
    const fresh = new LocationService(transitMode);
    fresh.loadTour(waypoints, transitMode);
    fresh.setCallbacks({
      onGeofence: (event) => {
        const track = event.waypoint.audio;
        if (event.type === 'enter') {
          if (track?.localUri) {
            freshSink.play(track, track.localUri, event.waypoint.name, event.timestamp);
          }
        } else {
          freshSink.stop(event.waypoint.name, event.timestamp, track?.id ?? null);
        }
      },
    });

    let t = Date.now();
    // Stand at the SECOND waypoint first: it is scheduled after the first, so
    // it is not armed and must stay silent (TASK-902)...
    t += 20_000;
    fresh.onFix(second.geofence.center, 8, t);
    assert(
      `${second.name}, scheduled second, stays silent when reached first`,
      freshSink.plays.length === 0,
      freshSink.plays.at(-1)?.waypointName,
    );

    // ...then the FIRST, which is armed and narrates...
    t += 20_000;
    fresh.onFix(centre, 8, t);
    assert(
      `${target.name} narration started on arrival`,
      freshSink.nowPlaying === targetAudio.id,
      freshSink.plays.at(-1)?.waypointName,
    );

    // ...then back to the second. That single fix is inside waypoint 2 and clear
    // of waypoint 1's widened exit boundary, so the engine emits an exit and an
    // enter together - the exit first, since TASK-902.
    t += 20_000;
    fresh.onFix(second.geofence.center, 8, t);

    const started = freshSink.plays.at(-1);
    assert(
      `${second.name} narration started on arrival, now that it is armed`,
      started?.trackId === second.audio.id,
      started?.waypointName,
    );

    const silencedAfterStart =
      started !== undefined && freshSink.stops.some((s) => s.atMs >= started.atMs && s.waypointName !== target.name);
    assert(
      'the arriving waypoint is still playing after the fix is processed',
      freshSink.nowPlaying === second.audio.id,
      silencedAfterStart
        ? `an exit silenced ${second.name} in the same fix - ` +
            'handleGeofence() stops whatever is playing, not the track that exited'
        : `nowPlaying=${freshSink.nowPlaying ?? 'nothing'}`,
    );
  }

  // --- Adaptive GPS (TASK-505) ----------------------------------------------
  //
  // The tier DECISION was always testable. What matters now is whether the tier
  // reaches the OS: before TASK-505, applyAdaptiveGps() updated bookkeeping and
  // fired onSamplingChange but never restarted the watcher, so the device ran
  // permanently on coarse - a 25 m movement filter against a 20 m trigger
  // radius. These checks read the calls the service actually made, via the
  // recording stub, so that failure mode cannot pass again.
  heading('8. Adaptive GPS - does the chosen tier reach the OS?');
  console.log(
    `        coarse ${profile.coarse.timeInterval / 1000}s / ${profile.coarse.distanceInterval}m` +
      `   fine ${profile.fine.timeInterval / 1000}s / ${profile.fine.distanceInterval}m` +
      `   escalate within ${profile.escalateWithinMeters}m`,
  );

  const gps = new LocationService(transitMode);
  gps.loadTour(waypoints, transitMode);
  const tiers: string[] = [];
  gps.setCallbacks({ onSamplingChange: (tier) => tiers.push(tier) });

  resetCalls();
  await gps.start();

  const opened = currentWatchOptions();
  assert(
    'start() opens a watcher on the coarse tier',
    opened?.distanceInterval === profile.coarse.distanceInterval,
    `distanceInterval=${opened?.distanceInterval}m`,
  );

  // Far away, then walk in. A tier change is applied only once the dwell window
  // has elapsed, so the virtual clock advances generously between fixes.
  let gpsClock = Date.now();
  const gpsStep = (fix: LatLng, advanceMs: number): void => {
    gpsClock += advanceMs;
    gps.onFix(fix, 12, gpsClock);
  };

  gpsStep(offsetMeters(centre, 2_000, 2_000), 60_000);
  assert('stays coarse far from every zone', gps.getTier() === 'coarse', `tier ${gps.getTier()}`);

  gpsStep(pointAtDistanceFrom(centre, approachFrom, profile.escalateWithinMeters - 20), 60_000);
  assert('escalates to fine on approach', gps.getTier() === 'fine', `tier ${gps.getTier()}`);

  // The whole point of TASK-505: the escalation must have reconfigured the OS.
  await gps.settled();
  const fine = currentWatchOptions();
  assert(
    'the escalation actually restarted the watcher on fine sampling',
    fine?.distanceInterval === profile.fine.distanceInterval &&
      fine?.accuracy === profile.fine.accuracy,
    `watcher is now ${fine?.distanceInterval}m / accuracy ${fine?.accuracy}`,
  );
  assert(
    'the live movement filter is finer than the trigger radius',
    (fine?.distanceInterval ?? Infinity) < radius,
    `${fine?.distanceInterval}m filter vs a ${radius}m radius`,
  );

  // --- thrash resistance -----------------------------------------------------
  // A user pacing the escalation boundary. Distance hysteresis should hold the
  // tier; the dwell window should stop anything that slips through from
  // reconfiguring the hardware on every fix.
  const beforeThrash = restartCount();
  const pacing = [-6, 6, -4, 8, -8, 4, -2, 10, -10, 2];
  for (const delta of pacing) {
    gpsStep(
      pointAtDistanceFrom(centre, approachFrom, profile.escalateWithinMeters + delta),
      30_000,
    );
  }
  await gps.settled();
  const thrash = restartCount() - beforeThrash;
  assert(
    'pacing the escalation boundary does not thrash the GPS',
    thrash === 0,
    thrash === 0
      ? `${pacing.length} boundary crossings, 0 restarts (hysteresis band ends at ` +
        `${(profile.escalateWithinMeters * 1.25).toFixed(0)}m)`
      : `${thrash} restarts across ${pacing.length} fixes`,
  );

  // --- de-escalation ---------------------------------------------------------
  gpsStep(offsetMeters(centre, 2_000, 2_000), 60_000);
  await gps.settled();
  assert('falls back to coarse when clear', gps.getTier() === 'coarse', `tier ${gps.getTier()}`);
  const back = currentWatchOptions();
  assert(
    'the fall-back restarted the watcher on coarse sampling',
    back?.distanceInterval === profile.coarse.distanceInterval,
    `watcher is now ${back?.distanceInterval}m`,
  );

  // --- dwell window ----------------------------------------------------------
  // Hysteresis alone cannot cover a user who genuinely crosses the whole band in
  // seconds - a passenger on a bus, say. The dwell window is the second defence:
  // a change arriving too soon after the last applied one is DEFERRED, so the
  // hardware is reconfigured at most once per TIER_DWELL_MS. The deferred change
  // re-decides from the newest fix when it fires, which is why nothing is lost.
  const beforeDwell = restartCount();
  const tierBeforeDwell = gps.getTier();
  gpsStep(pointAtDistanceFrom(centre, approachFrom, profile.escalateWithinMeters - 40), 2_000);
  await gps.settled();
  assert(
    'a tier change arriving inside the dwell window is deferred, not applied',
    gps.getTier() === tierBeforeDwell && restartCount() === beforeDwell,
    `tier ${gps.getTier()} after ${restartCount() - beforeDwell} restart(s), 2s since the last change`,
  );

  await gps.stop();
  console.log(`        tier transitions: ${tiers.join(' -> ')}`);

  // --- Result ---------------------------------------------------------------
  heading('Result');
  console.log(`  ${events.length} geofence events across the scripted walk`);
  if (!KEEP_BUNDLE) {
    rmSync(SIM_BUNDLE_ROOT, { recursive: true, force: true });
    console.log('  simulated bundle removed (pass --keep to retain it)');
  } else {
    console.log(`  bundle kept at ${SIM_BUNDLE_ROOT}`);
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nSimulator error:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
