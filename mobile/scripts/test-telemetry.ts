/**
 * TASK-506 - telemetry test suite.
 *
 * Runs the REAL TelemetryQueue, TelemetryService and AudioService in Node, with
 * AsyncStorage, react-native and expo-audio redirected to controllable stubs by
 * expo-stub-hooks.mjs. Nothing here reimplements the logic under test.
 *
 * The transport is a fake, and that is the point: the four PostgREST behaviours
 * this design turns on were established by probing the live table, and are
 * replayed here as scripted outcomes so the queue's response to each is pinned
 * down and cannot regress.
 *
 *   accepted     - the batch landed
 *   conflict     - 23505; for a batch this means the WHOLE statement rolled back
 *   rejected     - 23514/23503; this event will never be accepted
 *   unavailable  - no network
 *
 * Run:  npm run test:telemetry
 */

import { AudioService } from '../src/services/audio/AudioService.ts';
import { TelemetryQueue } from '../src/services/telemetry/TelemetryQueue.ts';
import { TelemetryService, uuidV4 } from '../src/services/telemetry/TelemetryService.ts';
import type {
  AudioEventContext,
  AudioTelemetryType,
} from '../src/services/telemetry/TelemetryService.ts';
import type {
  TelemetryEvent,
  TelemetryTransport,
  TransportOutcome,
} from '../src/services/telemetry/types.ts';
import type { AudioTrack, Waypoint } from '../src/types/domain.ts';
import { __reset as resetStorage, __dump } from './stubs/async-storage.ts';
import { players, __resetPlayers } from './stubs/expo-audio.ts';

// -----------------------------------------------------------------------------
// Tiny test harness
// -----------------------------------------------------------------------------

let failures = 0;
let checks = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  assert(label, Object.is(actual, expected), `got ${String(actual)}, expected ${String(expected)}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

// -----------------------------------------------------------------------------
// Scriptable transport
// -----------------------------------------------------------------------------

/**
 * A transport whose verdict is decided per call by a script.
 *
 * `sent` records every batch so a test can assert HOW the queue retried, not
 * merely that it eventually succeeded - the batch/individual fallback is the
 * subtle part and is invisible from the queue's return value alone.
 */
class ScriptedTransport implements TelemetryTransport {
  readonly sent: TelemetryEvent[][] = [];
  private script: ((events: readonly TelemetryEvent[]) => TransportOutcome) | null = null;

  program(fn: (events: readonly TelemetryEvent[]) => TransportOutcome): void {
    this.script = fn;
  }

  async send(events: readonly TelemetryEvent[]): Promise<TransportOutcome> {
    this.sent.push([...events]);
    return this.script?.(events) ?? { kind: 'accepted' };
  }

  reset(): void {
    this.sent.length = 0;
    this.script = null;
  }
}

function sampleEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    client_event_id: uuidV4(),
    device_id: '00000000-0000-4000-8000-000000000001',
    event_type: 'audio_started',
    tour_id: null,
    waypoint_id: null,
    audio_track_id: null,
    position_seconds: 0,
    track_seconds: 15,
    occurred_at: new Date().toISOString(),
    app_version: 'test',
    platform: 'ios',
    meta: null,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// 1. Durability
// -----------------------------------------------------------------------------

async function testDurability(): Promise<void> {
  heading('1. Durability');
  resetStorage();
  const transport = new ScriptedTransport();

  const queue = new TelemetryQueue(transport);
  await queue.enqueue(sampleEvent());
  await queue.enqueue(sampleEvent());
  eq('two events queued', await queue.size(), 2);

  // A brand new instance over the same storage: the app relaunching.
  const reopened = new TelemetryQueue(transport);
  eq('queue survives a restart', await reopened.size(), 2);

  // Concurrent enqueues must not lose writes to a read-modify-write race.
  resetStorage();
  const racy = new TelemetryQueue(transport);
  await Promise.all(Array.from({ length: 25 }, () => racy.enqueue(sampleEvent())));
  eq('25 concurrent enqueues all persist', await racy.size(), 25);
}

// -----------------------------------------------------------------------------
// 2. The happy path
// -----------------------------------------------------------------------------

async function testFlush(): Promise<void> {
  heading('2. Flush');
  resetStorage();
  const transport = new ScriptedTransport();
  const queue = new TelemetryQueue(transport);

  for (let i = 0; i < 3; i++) await queue.enqueue(sampleEvent());

  transport.program(() => ({ kind: 'accepted' }));
  const result = await queue.flushOnce();

  eq('all three delivered', result.delivered, 3);
  eq('queue drained', await queue.size(), 0);
  eq('sent as ONE batch', transport.sent.length, 1);
  assert('no .select() shape leaked into the payload', Array.isArray(transport.sent[0]));
}

// -----------------------------------------------------------------------------
// 3. Offline
// -----------------------------------------------------------------------------

async function testOffline(): Promise<void> {
  heading('3. Offline');
  resetStorage();
  const transport = new ScriptedTransport();
  const queue = new TelemetryQueue(transport);

  for (let i = 0; i < 3; i++) await queue.enqueue(sampleEvent());

  transport.program(() => ({ kind: 'unavailable', reason: 'network down' }));
  const result = await queue.flushOnce();

  assert('reported as offline', result.offline);
  eq('nothing delivered', result.delivered, 0);
  eq('everything retained', await queue.size(), 3);

  // Reconnect.
  transport.program(() => ({ kind: 'accepted' }));
  await queue.flushOnce();
  eq('drains once the network returns', await queue.size(), 0);
}

// -----------------------------------------------------------------------------
// 4. THE IMPORTANT ONE - a partly delivered batch must not wedge the queue
// -----------------------------------------------------------------------------

async function testBatchConflict(): Promise<void> {
  heading('4. Duplicate in a batch (the wedge that idempotency is for)');
  resetStorage();
  const transport = new ScriptedTransport();
  const queue = new TelemetryQueue(transport);

  const events = [sampleEvent(), sampleEvent(), sampleEvent()];
  for (const e of events) await queue.enqueue(e);

  // Reproduces the live behaviour exactly: PostgREST inserts a batch in one
  // statement, so a single already-delivered member rolls the whole thing back.
  // Sending them individually succeeds for the two new ones and 23505s the
  // replay - which is a SUCCESS, because the row is already in the table.
  const alreadyDelivered = events[1]?.client_event_id;
  transport.program((batch) => {
    if (batch.length > 1) {
      return batch.some((e) => e.client_event_id === alreadyDelivered)
        ? { kind: 'conflict' }
        : { kind: 'accepted' };
    }
    return batch[0]?.client_event_id === alreadyDelivered
      ? { kind: 'conflict' }
      : { kind: 'accepted' };
  });

  const result = await queue.flushOnce();

  eq('all three settled', result.delivered, 3);
  eq('queue fully drained - not wedged', await queue.size(), 0);
  assert(
    'fell back from one batch to per-event sends',
    transport.sent.length === 4 && transport.sent[0]?.length === 3,
    `${transport.sent.length} requests: ${transport.sent.map((b) => b.length).join(', ')}`,
  );
}

// -----------------------------------------------------------------------------
// 5. Poison events
// -----------------------------------------------------------------------------

async function testPoison(): Promise<void> {
  heading('5. Permanently rejected events are dropped, not retried forever');
  resetStorage();
  const transport = new ScriptedTransport();
  const queue = new TelemetryQueue(transport);

  const poison = sampleEvent({ track_seconds: 0 }); // violates track_seconds > 0
  await queue.enqueue(sampleEvent());
  await queue.enqueue(poison);
  await queue.enqueue(sampleEvent());

  transport.program((batch) => {
    const bad = batch.some((e) => e.client_event_id === poison.client_event_id);
    if (batch.length > 1) return bad ? { kind: 'conflict' } : { kind: 'accepted' };
    return bad
      ? { kind: 'rejected', reason: '23514: telemetry_events_track_seconds_check' }
      : { kind: 'accepted' };
  });

  const result = await queue.flushOnce();

  eq('the two good events delivered', result.delivered, 2);
  eq('the poison event dropped', result.dropped, 1);
  eq('queue drained rather than blocked', await queue.size(), 0);
}

// -----------------------------------------------------------------------------
// 6. Bounds
// -----------------------------------------------------------------------------

async function testBounds(): Promise<void> {
  heading('6. Bounds');
  resetStorage();
  const transport = new ScriptedTransport();
  const queue = new TelemetryQueue(transport);

  // Overflow the 500-event cap.
  const marker = sampleEvent({ meta: { keep: 'newest' } });
  for (let i = 0; i < 505; i++) await queue.enqueue(sampleEvent());
  await queue.enqueue(marker);

  eq('queue capped at MAX_QUEUED', await queue.size(), 500);

  transport.program(() => ({ kind: 'accepted' }));
  await queue.flushOnce();
  const firstBatch = transport.sent[0] ?? [];
  eq('drains in batches of 50', firstBatch.length, 50);

  // Give-up after repeated unavailability.
  resetStorage();
  const stubborn = new TelemetryQueue(transport);
  await stubborn.enqueue(sampleEvent());
  transport.program(() => ({ kind: 'unavailable', reason: 'still down' }));
  for (let i = 0; i < 10; i++) await stubborn.flushOnce();
  eq('gives up after MAX_ATTEMPTS rather than looping forever', await stubborn.size(), 0);
}

// -----------------------------------------------------------------------------
// 7. Event construction against the real CHECK constraints
// -----------------------------------------------------------------------------

async function testEventShape(): Promise<void> {
  heading('7. Event construction');
  resetStorage();
  const transport = new ScriptedTransport();
  const service = new TelemetryService(transport);

  await service.record('audio_started', {
    tourId: 'aaaaaaaa-0000-4000-8000-000000000001',
    waypointId: 'bbbbbbbb-0000-4000-8000-000000000001',
    positionSeconds: 12.3456,
    trackSeconds: 0, // must become null: the CHECK is track_seconds > 0
  });

  transport.program(() => ({ kind: 'accepted' }));
  await service.flush();

  const sent = transport.sent[0]?.[0];
  assert('an event reached the transport', sent !== undefined);
  if (!sent) return;

  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  assert('client_event_id is a valid UUID v4', V4.test(sent.client_event_id), sent.client_event_id);
  assert('device_id is a valid UUID v4', V4.test(sent.device_id), sent.device_id);
  assert('occurred_at is ISO 8601', !Number.isNaN(Date.parse(sent.occurred_at)), sent.occurred_at);
  eq('position rounded to numeric(10,2)', sent.position_seconds, 12.35);
  eq('track_seconds 0 becomes null (CHECK track_seconds > 0)', sent.track_seconds, null);
  eq('platform is a schema-legal tag', sent.platform, 'ios');
  eq('audio_track_id defaults to null when unknown', sent.audio_track_id, null);

  // ...and is carried when the manifest supplies it (TASK-507).
  transport.reset();
  transport.program(() => ({ kind: 'accepted' }));
  await service.record('audio_completed', {
    audioTrackId: 'dddddddd-0000-4000-8000-000000000001',
  });
  await service.flush();
  eq(
    'audio_track_id is carried when the manifest has it',
    transport.sent[0]?.[0]?.audio_track_id,
    'dddddddd-0000-4000-8000-000000000001',
  );

  // Idempotency keys must be unique per event and stable per retry.
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(uuidV4());
  eq('500 generated ids are unique', ids.size, 500);

  // The device id must be stable across the life of the install.
  const second = new TelemetryService(transport);
  await second.record('tour_started', {});
  transport.reset();
  transport.program(() => ({ kind: 'accepted' }));
  await second.flush();
  eq(
    'device_id is stable across service instances',
    transport.sent[0]?.[0]?.device_id,
    sent.device_id,
  );
}

// -----------------------------------------------------------------------------
// 8. Retry preserves the idempotency key
// -----------------------------------------------------------------------------

async function testRetryKeepsId(): Promise<void> {
  heading('8. A retry replays the SAME client_event_id');
  resetStorage();
  const transport = new ScriptedTransport();
  const queue = new TelemetryQueue(transport);

  const event = sampleEvent();
  await queue.enqueue(event);

  transport.program(() => ({ kind: 'unavailable', reason: 'lost response' }));
  await queue.flushOnce();

  transport.program(() => ({ kind: 'accepted' }));
  await queue.flushOnce();

  const first = transport.sent[0]?.[0]?.client_event_id;
  const second = transport.sent[1]?.[0]?.client_event_id;
  eq('the id is identical on both attempts', second, first);
  assert(
    'which is what lets the unique index turn the replay into a no-op',
    first === event.client_event_id,
  );
}

// -----------------------------------------------------------------------------
// 9. AudioService lifecycle -> KPI events
// -----------------------------------------------------------------------------

interface Recorded {
  type: AudioTelemetryType;
  context: AudioEventContext;
}

function fixtures(): { track: AudioTrack; waypoint: Waypoint } {
  const track: AudioTrack = {
    id: 'wp1:audio',
    waypointId: 'wp1',
    storagePath: 'tours/t1/wp01.m4a',
    audioTrackId: 'dddddddd-0000-4000-8000-000000000001',
    durationSeconds: 15,
    format: 'AAC',
    sizeBytes: 1000,
    localUri: 'file:///bundles/t1/media/tours/t1/wp01.m4a',
  };
  const waypoint: Waypoint = {
    id: 'wp1',
    tourId: 't1',
    name: 'Jaffa Gate',
    // NB: the seeds insert poi_type 'anchor', which is NOT in the PoiType union.
    // Using a legal value here rather than papering over that with a cast - the
    // drift is raised in the handover report.
    poiType: 'historic_site',
    coordinate: { latitude: 31.7766, longitude: 35.2279 },
    sortOrder: 1,
    geofence: null,
    audio: track,
  };
  return { track, waypoint };
}

async function testAudioLifecycle(): Promise<void> {
  heading('9. AudioService lifecycle -> KPI events');
  const { track, waypoint } = fixtures();

  // --- started + completed ---------------------------------------------------
  __resetPlayers();
  let recorded: Recorded[] = [];
  let audio = new AudioService();
  audio.setTelemetry({ recordAudio: (type, context) => recorded.push({ type, context }) });

  await audio.play(track, track.localUri ?? '', waypoint);
  eq('play() records audio_started', recorded[0]?.type, 'audio_started');
  eq('  tour_id is carried', recorded[0]?.context.tourId, 't1');
  eq('  waypoint_id is carried', recorded[0]?.context.waypointId, 'wp1');

  players.at(-1)?.emitStatus({ currentTime: 15, duration: 15, didJustFinish: true });
  eq('reaching the end records audio_completed', recorded[1]?.type, 'audio_completed');
  eq('  track_seconds from the real duration', recorded[1]?.context.trackSeconds, 15);

  await audio.stop('audio_stopped');
  eq('the stop after a completion records nothing more', recorded.length, 2);
  assert(
    '  so completions cannot also count as drop-off',
    !recorded.some((r) => r.type === 'audio_stopped'),
  );

  // --- skipped: one waypoint displaced by the next ---------------------------
  __resetPlayers();
  recorded = [];
  audio = new AudioService();
  audio.setTelemetry({ recordAudio: (type, context) => recorded.push({ type, context }) });

  await audio.play(track, track.localUri ?? '', waypoint);
  players.at(-1)?.emitStatus({ currentTime: 4, duration: 15, playing: true });

  const next = fixtures();
  next.track.id = 'wp2:audio';
  next.waypoint.id = 'wp2';
  next.waypoint.name = 'Tower of David';
  await audio.play(next.track, next.track.localUri ?? '', next.waypoint);

  const skip = recorded.find((r) => r.type === 'audio_skipped');
  assert('a displaced track records audio_skipped', skip !== undefined);
  eq('  attributed to the track that was abandoned', skip?.context.waypointId, 'wp1');
  eq('  with the position it reached', skip?.context.positionSeconds, 4);
  eq('  and the new track starts', recorded.at(-1)?.type, 'audio_started');
  eq('  attributed to the new waypoint', recorded.at(-1)?.context.waypointId, 'wp2');

  // --- stopped: walked out of the zone mid-narration -------------------------
  __resetPlayers();
  recorded = [];
  audio = new AudioService();
  audio.setTelemetry({ recordAudio: (type, context) => recorded.push({ type, context }) });

  await audio.play(track, track.localUri ?? '', waypoint);
  players.at(-1)?.emitStatus({ currentTime: 9, duration: 15, playing: true });
  await audio.fadeOutAndStop();

  const stopped = recorded.find((r) => r.type === 'audio_stopped');
  assert('a zone exit mid-track records audio_stopped', stopped !== undefined);
  eq('  with the drop-off position', stopped?.context.positionSeconds, 9);
  eq('  and the track length, for the fraction', stopped?.context.trackSeconds, 15);

  // --- pause (TASK-507) ------------------------------------------------------
  __resetPlayers();
  recorded = [];
  audio = new AudioService();
  audio.setTelemetry({ recordAudio: (type, context) => recorded.push({ type, context }) });

  await audio.play(track, track.localUri ?? '', waypoint);
  players.at(-1)?.emitStatus({ currentTime: 6, duration: 15, playing: true });
  audio.pause();

  const paused = recorded.find((r) => r.type === 'audio_paused');
  assert('pause() records audio_paused', paused !== undefined);
  eq('  with the position it paused at', paused?.context.positionSeconds, 6);
  eq('  and the real audio_tracks id', paused?.context.audioTrackId, track.audioTrackId);

  // A pause must not be terminal: the listen is still in flight, and the
  // completion that follows is the whole point of the KPI.
  audio.resume();
  eq('resume() records nothing - it would double-count the start', recorded.length, 2);

  players.at(-1)?.emitStatus({ currentTime: 15, duration: 15, didJustFinish: true });
  eq('a paused-then-resumed track still completes', recorded.at(-1)?.type, 'audio_completed');
  eq(
    '  exactly one audio_started for the whole listen',
    recorded.filter((r) => r.type === 'audio_started').length,
    1,
  );

  // And a pause that is never resumed must still report its abandonment.
  __resetPlayers();
  recorded = [];
  audio = new AudioService();
  audio.setTelemetry({ recordAudio: (type, context) => recorded.push({ type, context }) });
  await audio.play(track, track.localUri ?? '', waypoint);
  players.at(-1)?.emitStatus({ currentTime: 3, duration: 15, playing: true });
  audio.pause();
  await audio.fadeOutAndStop();
  assert(
    'a paused track abandoned mid-listen still reports audio_stopped',
    recorded.some((r) => r.type === 'audio_stopped'),
    recorded.map((r) => r.type).join(' -> '),
  );

  // --- a decode failure is not the tourist's fault ---------------------------
  __resetPlayers();
  recorded = [];
  audio = new AudioService();
  audio.setTelemetry({ recordAudio: (type, context) => recorded.push({ type, context }) });

  const bad: AudioTrack = { ...track, storagePath: 'tours/t1/wp01.opus' };
  await audio.play(bad, 'file:///bundles/t1/media/tours/t1/wp01.opus', waypoint);
  assert(
    'an undecodable track is never recorded as a skip',
    !recorded.some((r) => r.type === 'audio_skipped'),
    recorded.map((r) => r.type).join(', ') || 'no events',
  );

  // --- a throwing sink must not break playback -------------------------------
  __resetPlayers();
  audio = new AudioService();
  audio.setTelemetry({
    recordAudio: () => {
      throw new Error('sink exploded');
    },
  });
  let survived = true;
  try {
    await audio.play(track, track.localUri ?? '', waypoint);
  } catch {
    survived = false;
  }
  assert('a throwing telemetry sink cannot break playback', survived);
  await audio.stop();
}

// -----------------------------------------------------------------------------
// 10. Telemetry must never break a tour
// -----------------------------------------------------------------------------

async function testResilience(): Promise<void> {
  heading('10. Failure containment');
  resetStorage();
  const transport = new ScriptedTransport();
  const service = new TelemetryService(transport);

  transport.program(() => {
    throw new Error('transport exploded');
  });

  let threw = false;
  try {
    await service.record('audio_started', { tourId: 't1' });
    await service.flush();
  } catch {
    threw = true;
  }
  assert('a throwing transport does not propagate', !threw);

  // A storage failure must be survivable too.
  resetStorage();
  const { __setFailWrites } = await import('./stubs/async-storage.ts');
  __setFailWrites(true);
  let storageThrew = false;
  try {
    await new TelemetryService(transport).record('tour_started', {});
  } catch {
    storageThrew = true;
  }
  __setFailWrites(false);
  assert('a failing AsyncStorage does not propagate', !storageThrew);
}

// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// 11. Live contract check (opt-in: npm run test:telemetry -- --live)
// -----------------------------------------------------------------------------

/**
 * Pins the four PostgREST behaviours the whole design rests on, against the REAL
 * table.
 *
 * Everything above replays those behaviours from a script, which proves the
 * queue reacts correctly but would not notice if Supabase ever changed what it
 * returns. This does, and it WRITES NO NEW ROWS: every case is either a replay
 * of an id that already exists or a row the server must refuse.
 *
 * Opt-in because it needs credentials and a network, and the suite must stay
 * runnable on a fresh clone with neither.
 */
// -----------------------------------------------------------------------------
// 10b. Connectivity restored (TASK-605, Hybrid Offline-First)
// -----------------------------------------------------------------------------

async function testReconnect(): Promise<void> {
  heading('10b. Reconnect drains the queue immediately');
  resetStorage();
  const transport = new ScriptedTransport();
  transport.program(() => ({ kind: 'accepted' }));
  const service = new TelemetryService(transport);

  let online = false;
  const listeners = new Set<(online: boolean) => void>();
  const detach = service.attachNetwork({
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });

  await service.record('audio_started', { tourId: 't1' });
  await service.flush();
  eq('known offline: not even an attempt is made', transport.sent.length, 0);
  eq('known offline: the event is kept', await service.pendingCount(), 1);

  // Signal returns with the app open - no foregrounding, no timer.
  online = true;
  for (const listener of [...listeners]) listener(true);
  await service.flush(); // queued behind the flush the reconnect started

  eq('reconnect delivers at once, without waiting out the backoff', await service.pendingCount(), 0);
  eq('in a single request', transport.sent.length, 1);

  detach();
  eq('detach removes the network listener', listeners.size, 0);
  service.stop();
}

async function testLiveContract(): Promise<void> {
  heading('11. Live contract check');

  if (!process.env['SUPABASE_URL'] || !process.env['SUPABASE_ANON_KEY']) {
    console.log('  SKIP  SUPABASE_URL / SUPABASE_ANON_KEY not set');
    return;
  }

  const { SupabaseTelemetryTransport } = await import(
    '../src/services/telemetry/SupabaseTelemetryTransport.ts'
  );
  const transport = new SupabaseTelemetryTransport();

  const event = (o: Partial<TelemetryEvent>): TelemetryEvent =>
    sampleEvent({
      device_id: '00000000-dead-4000-8000-000000000000',
      position_seconds: null,
      track_seconds: null,
      app_version: 'live-contract-check',
      ...o,
    });

  // An id the contract probe already wrote. A replay must read as 'conflict',
  // which is what the queue treats as delivered.
  const replay = await transport.send([
    event({ client_event_id: '33333333-3333-4333-8333-000000000001' }),
  ]);
  eq('a replayed client_event_id maps to conflict', replay.kind, 'conflict');

  const badType = await transport.send([
    event({
      client_event_id: '44444444-4444-4444-8444-000000000001',
      event_type: 'pause' as TelemetryEvent['event_type'],
    }),
  ]);
  eq("an event_type outside the CHECK maps to rejected", badType.kind, 'rejected');

  const badDuration = await transport.send([
    event({ client_event_id: '44444444-4444-4444-8444-000000000002', track_seconds: 0 }),
  ]);
  eq('track_seconds = 0 maps to rejected', badDuration.kind, 'rejected');

  const badFk = await transport.send([
    event({
      client_event_id: '44444444-4444-4444-8444-000000000003',
      tour_id: '99999999-9999-4999-8999-999999999999',
    }),
  ]);
  eq('an unknown tour_id maps to rejected', badFk.kind, 'rejected');

  // --- has migration 20260828140000 landed? ----------------------------------
  //
  // Detected WITHOUT writing a row, by sending a valid 'audio_paused' carrying a
  // deliberately bad FK. Both outcomes are a rejection, but they name different
  // constraints, and that is the whole signal:
  //
  //   ..._event_type_check  -> the migration has NOT been applied; every
  //                            audio_paused the app records will queue, fail
  //                            forever, and be discarded as poison.
  //   ..._tour_id_fkey      -> the vocabulary accepts audio_paused; only the
  //                            fake tour id stopped it.
  const pausedProbe = await transport.send([
    event({
      client_event_id: '44444444-4444-4444-8444-000000000004',
      event_type: 'audio_paused',
      tour_id: '99999999-9999-4999-8999-999999999999',
    }),
  ]);
  const reason = pausedProbe.kind === 'rejected' ? pausedProbe.reason : String(pausedProbe.kind);
  const vocabularyAccepts = !reason.includes('event_type_check');

  if (vocabularyAccepts) {
    assert("'audio_paused' is in the deployed event vocabulary", true, 'migration 20260828140000 applied');
  } else {
    console.log("  WARN  'audio_paused' is NOT yet in the deployed vocabulary");
    console.log('        migration 20260828140000 is pending - run: npm run db:push');
    console.log('        until then every pause the app records is dropped as poison');
  }
}

async function main(): Promise<void> {
  console.log('TASK-506 - offline telemetry queue');

  await testDurability();
  await testFlush();
  await testOffline();
  await testBatchConflict();
  await testPoison();
  await testBounds();
  await testEventShape();
  await testRetryKeepsId();
  await testAudioLifecycle();
  await testResilience();
  await testReconnect();
  if (process.argv.includes('--live')) await testLiveContract();

  heading('Result');
  console.log(`  ${checks} checks, ${failures} failed`);
  console.log(`  storage keys in use: ${Object.keys(__dump()).join(', ') || 'none'}`);
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error('\nTest harness error:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
