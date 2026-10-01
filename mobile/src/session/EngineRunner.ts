import { reduce } from '../engine/reduce.ts';
import type { Effect, EngineEvent, EngineState, GpsFix, Progress } from '../engine/types.ts';
import type { TransitMode } from '../types/domain.ts';

/**
 * EngineRunner - the controller's event loop (Epic 15, slice 4).
 *
 * ONE WRITER. Every input - GPS batches, audio callbacks, the 1 Hz heartbeat,
 * the listener's taps - becomes an EngineEvent passed to dispatch(). dispatch
 * is the only code that changes engine state, and it never runs inside itself.
 *
 * ONE DRAIN, IN A FIXED ORDER (the PM's ordering directive):
 *
 *   1. reduce   every event waiting in the inbox, synchronously, in arrival
 *               order. Pure - no I/O, no awaits, cannot interleave.
 *   2. persist  the Progress, synchronously, if (and only if) its identity
 *               changed. Durable before step 4 starts.
 *   3. publish  the new state to the UI store, once per drain.
 *   4. effects  PLAY/STOP/RESUME to the audio shell, transit-mode changes,
 *               telemetry. None is awaited: their results come back later as
 *               events through dispatch().
 *
 * RE-ENTRANCY. An effect may call dispatch() synchronously (a player that
 * fails inside play(), expo-audio's synchronous onError). That event joins the
 * inbox and is drained by the SAME loop after the current effects - never
 * nested, never reordered ahead of a persist.
 *
 * FAILURES ARE REPORTED, NEVER SWALLOWED, AND NEVER STOP NARRATION:
 *   - persist throws  -> reportError('persist'); effects still run. PM policy
 *     (Epic 13, reaffirmed Epic 15): the listener's experience outranks
 *     surviving a process kill.
 *   - reduce throws   -> reportError('reduce'); that event is dropped (it is a
 *     caller bug: a stop outside the chapter, an unknown chapter) and the
 *     loop carries on with the state before it.
 *   - an effect port throws -> reportError('effect'); the remaining effects run.
 *
 * THE HEARTBEAT (PM): a 1 Hz TICK while the session runs. On Android React
 * Native pauses JS timers in the background, so this interval stops exactly
 * when the phone is pocketed - the engine therefore also advances its clock
 * on every FIX_BATCH, and LocationService delivers a fix every second even
 * standing still (engine mode). Both clocks reach the same advanceClock().
 */

export const HEARTBEAT_MS = 1_000;

export type ErrorContext = 'persist' | 'reduce' | 'effect';

export interface EngineRunnerPorts {
  /** Durable before returning; throws on failure. */
  persist(progress: Progress, state: EngineState): void;
  /** Non-blocking. Results return as AUDIO_* events. */
  audio(effect: Extract<Effect, { type: 'PLAY' | 'STOP' | 'RESUME' }>): void;
  /** Tracking sampling and audio-session mode for a new chapter. Non-blocking. */
  applyTransitMode(mode: TransitMode): void;
  /** Idle timeout: stop tracking (and say so); or start it again. Non-blocking. */
  tracking(effect: Extract<Effect, { type: 'SUSPEND_TRACKING' | 'RESUME_TRACKING' }>): void;
  telemetry(effect: Extract<Effect, { type: 'TELEMETRY' }>): void;
  /** The UI store. Called once per drain, after persisting. */
  publish(next: EngineState, prev: EngineState): void;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  reportError(context: ErrorContext, error: unknown, detail: string): void;
}

export class EngineRunner {
  private current: EngineState;
  private readonly inbox: EngineEvent[] = [];
  private draining = false;
  private stopped = false;
  private heartbeat: unknown = null;
  private readonly ports: EngineRunnerPorts;

  // Plain fields, not parameter properties: the engine runs under Node's
  // type stripping in tests (erasableSyntaxOnly).
  constructor(initial: EngineState, ports: EngineRunnerPorts) {
    this.current = initial;
    this.ports = ports;
  }

  get state(): EngineState {
    return this.current;
  }

  /** Begin: the heartbeat, then SESSION_STARTED (which replays a restored queue). */
  start(): void {
    if (this.heartbeat !== null) throw new Error('EngineRunner.start() called twice');
    this.heartbeat = this.ports.setInterval(() => this.dispatch({ type: 'TICK', at: this.ports.now() }), HEARTBEAT_MS);
    this.dispatch({ type: 'SESSION_STARTED', at: this.ports.now() });
  }

  /**
   * End. Stops the heartbeat and closes the inbox. Events arriving after this
   * are expected - a player's final status, a last fix in flight - and are
   * ignored: the session they belong to is over.
   */
  stop(): void {
    this.stopped = true;
    if (this.heartbeat !== null) this.ports.clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.inbox.length = 0;
  }

  /** One OS delivery of fixes, stamped with the shell's clock. */
  fixes(fixes: readonly GpsFix[]): void {
    this.dispatch({ type: 'FIX_BATCH', fixes, receivedAt: this.ports.now() });
  }

  dispatch(event: EngineEvent): void {
    if (this.stopped) return;
    this.inbox.push(event);
    if (this.draining) return; // re-entrant: the running drain picks it up
    this.draining = true;
    try {
      while (this.inbox.length > 0 && !this.stopped) this.drainOnce();
    } finally {
      this.draining = false;
    }
  }

  private drainOnce(): void {
    const events = this.inbox.splice(0);
    const prev = this.current;
    let state = prev;
    const effects: Effect[] = [];

    // 1. reduce
    for (const event of events) {
      try {
        const r = reduce(state, event);
        state = r.state;
        effects.push(...r.effects);
      } catch (err) {
        this.ports.reportError('reduce', err, event.type);
      }
    }
    this.current = state;

    // 2. persist - before any effect can start audio
    if (state.progress !== prev.progress) {
      try {
        this.ports.persist(state.progress, state);
      } catch (err) {
        this.ports.reportError('persist', err, 'progress not durable; narration continues');
      }
    }

    // 3. publish
    if (state !== prev) {
      try {
        this.ports.publish(state, prev);
      } catch (err) {
        this.ports.reportError('effect', err, 'publish');
      }
    }

    // 4. effects, in the order the reducer emitted them
    for (const fx of effects) {
      if (this.stopped) return;
      try {
        switch (fx.type) {
          case 'PLAY':
          case 'STOP':
          case 'RESUME':
            this.ports.audio(fx);
            break;
          case 'APPLY_TRANSIT_MODE':
            this.ports.applyTransitMode(fx.transitMode);
            break;
          case 'SUSPEND_TRACKING':
          case 'RESUME_TRACKING':
            this.ports.tracking(fx);
            break;
          case 'TELEMETRY':
            this.ports.telemetry(fx);
            break;
        }
      } catch (err) {
        this.ports.reportError('effect', err, fx.type);
      }
    }
  }
}
