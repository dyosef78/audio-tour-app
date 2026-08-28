/**
 * TASK-401 - a bound on how many ffmpeg processes exist at once.
 *
 * ffmpeg is CPU-bound and will happily use every core it is given. An HTTP
 * handler that calls `processNarrationAudio` directly therefore has no
 * backpressure at all: ten simultaneous CMS uploads become ten ffmpeg
 * processes, the box thrashes, and every request - including the ones just
 * reading the tour list - gets slow. The failure looks like a database problem
 * and is not one.
 *
 * This is deliberately a semaphore and not a job queue. A real queue (pgmq,
 * BullMQ, a worker service) is the right answer once processing needs to
 * survive a deploy or report progress to a browser, and the pipeline is written
 * as a plain async function precisely so it can be lifted into one unchanged.
 * Until then, an in-process limit is the smallest thing that prevents the
 * failure above, and it needs no new infrastructure to run.
 */

import { availableParallelism } from 'node:os';

export interface ProcessingQueue {
  /** Run `task` once a slot is free. Rejections propagate to the caller. */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** Currently executing. */
  active: () => number;
  /** Waiting for a slot. */
  pending: () => number;
}

/**
 * Half the cores, at least one.
 *
 * Not all of them: this process still has to answer requests while encoding,
 * and ffmpeg's own threading already spreads a single encode across cores. The
 * useful knob is usually "how many uploads at once", not "how fast is one".
 */
export function defaultConcurrency(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

export function createProcessingQueue(limit: number = defaultConcurrency()): ProcessingQueue {
  const max = Math.max(1, Math.floor(limit));
  const waiting: Array<() => void> = [];
  let running = 0;

  function release(): void {
    running--;
    const next = waiting.shift();
    if (next !== undefined) next();
  }

  async function acquire(): Promise<void> {
    if (running < max) {
      running++;
      return;
    }

    await new Promise<void>((resolve) => {
      waiting.push(() => {
        running++;
        resolve();
      });
    });
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await task();
      } finally {
        // In `finally` so a thrown task does not permanently consume a slot -
        // which would degrade the service one failed upload at a time until it
        // stopped processing anything at all.
        release();
      }
    },
    active: () => running,
    pending: () => waiting.length,
  };
}
