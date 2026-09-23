/**
 * A promise with an upper bound (Epic 11 device-QA fix).
 *
 * Resolves `{ timedOut: true }` instead of rejecting, so a caller has to decide
 * what "no answer" means rather than let it fall into a generic catch. The
 * timer is always cleared, so a fast promise leaves nothing pending. The
 * underlying work is NOT cancelled - pass it an AbortSignal for that.
 *
 * Pure: no React Native, so the Node harness runs it as-is.
 */

export type Raced<T> = { timedOut: false; value: T } | { timedOut: true };

export async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value): Raced<T> => ({ timedOut: false, value })),
      new Promise<Raced<T>>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
