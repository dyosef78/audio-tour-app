/**
 * Optimistic navigation handoff (Epic 16, PM 5 Oct 2026).
 *
 * "Navigate with Google Maps" used to open Maps WITHOUT waiting for the
 * tracking restart a chapter change had queued. On Android that restart stops
 * the location foreground service and starts it again, and the start is only
 * allowed while the app is in the foreground - so opening Maps first could
 * leave the travel segment with no tracking and the arrival undetected.
 *
 * Now the handoff waits for the queued tracking work, BOUNDED: if it has not
 * settled within HANDOFF_TRACKING_TIMEOUT_MS, Maps opens anyway (PM: a late
 * or lost arrival is acceptable; a button that does nothing for seconds is
 * not). The work keeps running; what it ends as is reported once it ends:
 *
 *   settled in time      handoff, nothing to report
 *   timed out, then ok   'late'      - tracking was restarted after Maps opened
 *   timed out, then lost 'lost'      - the OS refused the start in the
 *                                      background; tracking is OFF until the
 *                                      visitor returns to the app, where the
 *                                      controller restarts it ('recovered')
 *
 * Waiting is an await, not a block: the JS and UI threads stay free and the
 * panel shows its spinner. The bound is on how long a tap may take to answer.
 *
 * Pure: timers are injected, so test:plan drives it without a device.
 */

export const HANDOFF_TRACKING_TIMEOUT_MS = 1_500;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SettleResult = { kind: 'settled' } | { kind: 'timed_out' };

/**
 * Wait for `work` at most `ms`. Never rejects: a failure of `work` within the
 * limit counts as settled (its own owner reports it); the timer is always
 * cleared, so a fast settle leaves nothing scheduled.
 */
export function settleWithin(work: Promise<unknown>, ms: number, timers: Timers): Promise<SettleResult> {
  return new Promise((resolve) => {
    let done = false;
    const handle = timers.setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ kind: 'timed_out' });
    }, ms);
    const finish = () => {
      if (done) return;
      done = true;
      timers.clearTimeout(handle);
      resolve({ kind: 'settled' });
    };
    work.then(finish, finish);
  });
}

export type LateOutcome = 'late' | 'lost';

/**
 * The handoff, ordered: wait (bounded) for `trackingWork`, then `open()` -
 * whatever the wait ended as. After a timeout, `onLate` hears how the work
 * ended, once, when it ends. Returns what the wait ended as.
 */
export async function optimisticHandoff(args: {
  trackingWork: Promise<unknown>;
  trackingLost: () => boolean;
  open: () => Promise<void>;
  onLate: (outcome: LateOutcome, waitedMs: number) => void;
  timers: Timers;
  now: () => number;
  timeoutMs?: number;
}): Promise<SettleResult> {
  const startedAt = args.now();
  const result = await settleWithin(args.trackingWork, args.timeoutMs ?? HANDOFF_TRACKING_TIMEOUT_MS, args.timers);
  if (result.kind === 'timed_out') {
    const report = () => args.onLate(args.trackingLost() ? 'lost' : 'late', args.now() - startedAt);
    args.trackingWork.then(report, report);
  }
  await args.open();
  return result;
}
