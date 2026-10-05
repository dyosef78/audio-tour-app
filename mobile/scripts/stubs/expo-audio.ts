/**
 * Fake `expo-audio` for the Node test harness (TASK-506).
 *
 * The player is controllable: a test drives `__emitStatus` to simulate the
 * status feed, which is the only way to exercise didJustFinish - and therefore
 * the only way to test that Audio Completion Rate is counted correctly.
 */

export interface AudioStatus {
  isLoaded: boolean;
  playing: boolean;
  currentTime: number;
  duration: number;
  didJustFinish: boolean;
}

type StatusListener = (status: AudioStatus) => void;

export class AudioPlayer {
  volume = 1;
  playing = false;
  removed = false;
  readonly uri: string;
  private listeners = new Set<StatusListener>();

  constructor(uri: string) {
    this.uri = uri;
  }

  addListener(_event: string, listener: StatusListener): { remove: () => void } {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  remove(): void {
    this.removed = true;
    this.listeners.clear();
  }
  setActiveForLockScreen(_active: boolean, _meta: { title: string }): void {}

  /** Last seek target. Resolves on a later microtask, like the native call. */
  seekedTo: number | null = null;
  async seekTo(seconds: number): Promise<void> {
    await Promise.resolve();
    this.seekedTo = seconds;
  }

  /** Test hook: push a status update through the real listener path. */
  emitStatus(status: Partial<AudioStatus>): void {
    const full: AudioStatus = {
      isLoaded: true,
      playing: this.playing,
      currentTime: 0,
      duration: 0,
      didJustFinish: false,
      ...status,
    };
    for (const listener of [...this.listeners]) listener(full);
  }
}

/** Every player created, so a test can reach the live one. */
export const players: AudioPlayer[] = [];

export function __resetPlayers(): void {
  players.length = 0;
}

export function createAudioPlayer(source: { uri: string }): AudioPlayer {
  const player = new AudioPlayer(source.uri);
  players.push(player);
  return player;
}

/** Every setAudioModeAsync call, for the redundant-reset tests (Epic 16). */
export const audioModeCalls: unknown[] = [];
let failNextAudioMode = false;
export function __failNextAudioMode(): void {
  failNextAudioMode = true;
}

export async function setAudioModeAsync(mode: unknown): Promise<void> {
  if (failNextAudioMode) {
    failNextAudioMode = false;
    throw new Error('AVAudioSession refused the category');
  }
  audioModeCalls.push(mode);
}
