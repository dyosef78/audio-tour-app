import type { Effect, EngineEvent, TrackKind } from '../../engine/types.ts';
import type { AudioTrack, Waypoint } from '../../types/domain.ts';
import type { PlaybackError, PlaybackSnapshot } from './AudioService.ts';

/**
 * AudioActor - the engine's audio shell (Epic 15, slice 3).
 *
 * Executes PLAY / STOP / RESUME and reports back as AUDIO_* events, each
 * carrying the GENERATION TOKEN of the PLAY it belongs to. The reducer ignores
 * any event whose token is not the one on air, so a stale callback can never
 * advance the queue, and the reducer's 5 s PLAY timeout can abandon a player
 * that never answers without racing it.
 *
 * ONE LANE. Commands run one at a time, in arrival order (a promise chain).
 * Slow work - resolving a stream, loading a player - delays only audio, never
 * a GPS fix (the reducer runs synchronously elsewhere).
 *
 * WHO OWNS THE STATUS FEED. AudioService has one player at a time and removes
 * the old player's listener before tearing it down, so every status update
 * belongs to the newest player - which is `current` here. A STOP clears
 * `current` synchronously, the moment the effect arrives, so nothing that
 * player says afterwards is reported.
 *
 * WHAT COUNTS AS STARTED. AudioService.play() returns before audio flows, and
 * an undecodable file can sit "playing" at 0:00 forever. So AUDIO_STARTED is
 * the first status with the playhead PAST ZERO - proof the source decoded.
 *
 * INTERRUPTIONS ARE INFERRED. expo-audio exposes no interruption event, only
 * playbackStatusUpdate. After STARTED, a status that stops playing without
 * finishing and without the listener's own pause is reported as an OS
 * interruption (an iOS doNotMix maps prompt); playing again is the resume. A
 * buffering stall reads the same way, which is harmless: the reducer's
 * watchdog only acts after a minute.
 */

/** The subset of AudioService the actor drives (a recording double in tests). */
export interface NarrationPlayer {
  play(track: AudioTrack, uri: string, waypoint: Waypoint): Promise<void>;
  stop(reason: 'audio_skipped' | 'audio_stopped' | null): Promise<void>;
  fadeOutAndStop(): Promise<void>;
  pause(): void;
  resume(): void;
  setOnStatus(listener: ((snapshot: PlaybackSnapshot) => void) | null): void;
  setOnError(listener: ((error: PlaybackError) => void) | null): void;
}

export interface PlayableSource {
  /** What to play for this stop and track, or null when nothing is playable. May throw. */
  resolve(stopId: string, track: TrackKind): Promise<{ track: AudioTrack; uri: string; waypoint: Waypoint } | null>;
}

export type AudioEngineEvent = Extract<
  EngineEvent,
  { type: 'AUDIO_STARTED' | 'AUDIO_ENDED' | 'AUDIO_FAILED' | 'AUDIO_INTERRUPTED' | 'AUDIO_RESUMED' }
>;

export interface AudioActorDeps {
  player: NarrationPlayer;
  source: PlayableSource;
  /** Into the engine (EngineRunner.dispatch). */
  sink: (event: AudioEngineEvent) => void;
  now: () => number;
  /** The transport UI's feed (position, isPlaying) - every status, whoever owns it. */
  onSnapshot?: (snapshot: PlaybackSnapshot) => void;
  /** A failure the UI should show. */
  onError?: (error: PlaybackError) => void;
  /** A command that threw inside the lane - reported, never swallowed. */
  reportError: (error: unknown, detail: string) => void;
}

interface OnAir {
  token: number;
  stopId: string;
  track: TrackKind;
  phase: 'resolving' | 'loading' | 'started';
  osPaused: boolean;
  userPaused: boolean;
}

type AudioCommand = Extract<Effect, { type: 'PLAY' | 'STOP' | 'RESUME' }>;

export class AudioActor {
  private current: OnAir | null = null;
  private lane: Promise<void> = Promise.resolve();
  private readonly deps: AudioActorDeps;

  constructor(deps: AudioActorDeps) {
    this.deps = deps;
    deps.player.setOnStatus((s) => this.onStatus(s));
    deps.player.setOnError((e) => this.onError(e));
  }

  /** The stop and track on air, for the UI. */
  get onAir(): { stopId: string; track: TrackKind } | null {
    return this.current === null ? null : { stopId: this.current.stopId, track: this.current.track };
  }

  execute(command: AudioCommand): void {
    switch (command.type) {
      case 'PLAY': {
        // Supersede synchronously: whatever was current stops being reported now.
        this.current = { token: command.token, stopId: command.stopId, track: command.track, phase: 'resolving', osPaused: false, userPaused: false };
        this.enqueue(`PLAY ${command.token}`, () => this.runPlay(command.token, command.stopId, command.track));
        return;
      }
      case 'STOP': {
        // Only the player this token owns. A STOP for a token already
        // superseded must not silence its successor.
        if (this.current?.token !== command.token) return;
        this.current = null;
        const { fade, reason } = command;
        this.enqueue(`STOP ${command.token}`, () =>
          fade
            ? this.deps.player.fadeOutAndStop()
            : this.deps.player.stop(reason === 'preempted' || reason === 'user_skip' ? 'audio_skipped' : 'audio_stopped'),
        );
        return;
      }
      case 'RESUME': {
        if (this.current?.token !== command.token) return;
        this.enqueue(`RESUME ${command.token}`, async () => {
          if (this.current?.token === command.token) this.deps.player.resume();
        });
        return;
      }
    }
  }

  /** The listener's pause. Reported so the engine's watchdog leaves it alone. */
  pauseByUser(): void {
    const c = this.current;
    if (c === null || c.phase !== 'started' || c.userPaused) return;
    c.userPaused = true;
    this.deps.player.pause();
    this.deps.sink({ type: 'AUDIO_INTERRUPTED', token: c.token, at: this.deps.now(), by: 'user' });
  }

  resumeByUser(): void {
    const c = this.current;
    if (c === null || !c.userPaused) return;
    c.userPaused = false;
    c.osPaused = false;
    this.deps.player.resume();
    this.deps.sink({ type: 'AUDIO_RESUMED', token: c.token, at: this.deps.now() });
  }

  /** Session over: silence, and stop reporting. Resolves once the player is down. */
  async dispose(): Promise<void> {
    this.current = null;
    this.deps.player.setOnStatus(null);
    this.deps.player.setOnError(null);
    this.enqueue('dispose', () => this.deps.player.stop('audio_stopped'));
    await this.lane;
  }

  /** Resolves when every queued command has run. For tests and teardown. */
  settled(): Promise<void> {
    return this.lane;
  }

  private enqueue(label: string, job: () => Promise<void>): void {
    this.lane = this.lane.then(job).catch((err: unknown) => this.deps.reportError(err, label));
  }

  private async runPlay(token: number, stopId: string, track: TrackKind): Promise<void> {
    const mine = (): boolean => this.current?.token === token;
    if (!mine()) return; // superseded or stopped before its turn

    let resolved: Awaited<ReturnType<PlayableSource['resolve']>>;
    try {
      resolved = await this.deps.source.resolve(stopId, track);
    } catch (err) {
      if (mine()) this.fail(token, `could not resolve ${track} for ${stopId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!mine()) return;
    if (resolved === null) {
      this.fail(token, `nothing playable for ${track} of ${stopId}`);
      return;
    }

    const c = this.current as OnAir;
    c.phase = 'loading';
    try {
      await this.deps.player.play(resolved.track, resolved.uri, resolved.waypoint);
    } catch (err) {
      if (mine()) this.fail(token, err instanceof Error ? err.message : String(err));
    }
    // Stopped (or timed out by the engine) while loading: no teardown here.
    // The STOP that superseded this token queued its own job BEHIND this one
    // in the lane, so it runs next and removes the late player; a newer PLAY
    // does the same through AudioService.play(), which stops the previous
    // player first. Its statuses meanwhile are not attributed: `current` is
    // already someone else (or no one).
  }

  private fail(token: number, message: string): void {
    this.current = null;
    this.deps.sink({ type: 'AUDIO_FAILED', token, at: this.deps.now(), message });
  }

  private onStatus(snapshot: PlaybackSnapshot): void {
    this.deps.onSnapshot?.(snapshot);
    const c = this.current;
    if (c === null) return;

    if (snapshot.didJustFinish) {
      this.current = null;
      this.deps.sink({ type: 'AUDIO_ENDED', token: c.token, at: this.deps.now() });
      return;
    }
    if (c.phase !== 'started') {
      if (snapshot.isPlaying && snapshot.positionSeconds > 0) {
        c.phase = 'started';
        this.deps.sink({ type: 'AUDIO_STARTED', token: c.token, at: this.deps.now() });
      }
      return;
    }
    if (!snapshot.isPlaying && !c.userPaused && !c.osPaused) {
      c.osPaused = true;
      this.deps.sink({ type: 'AUDIO_INTERRUPTED', token: c.token, at: this.deps.now(), by: 'os' });
    } else if (snapshot.isPlaying && c.osPaused) {
      c.osPaused = false;
      this.deps.sink({ type: 'AUDIO_RESUMED', token: c.token, at: this.deps.now() });
    }
  }

  private onError(error: PlaybackError): void {
    this.deps.onError?.(error);
    const c = this.current;
    if (c === null) return;
    this.fail(c.token, error.message);
  }
}
