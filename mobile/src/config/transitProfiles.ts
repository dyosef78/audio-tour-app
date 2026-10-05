import { Accuracy } from 'expo-location';

import type { TransitMode } from '../types/domain';

/**
 * GPS sampling per transit mode (Epic 15).
 *
 * One setting per mode, pinned for the whole chapter (architecture plan,
 * Approach A): the swept test cannot step over a zone whatever the interval,
 * so there is no coarse tier to save battery on and no tier change to make
 * from the background - which Android forbids (Epic 13). The values are the
 * pre-Epic-15 "fine" tier.
 *
 * Everything that DECIDES - trigger rules, hysteresis, queue expiry, re-anchor
 * - lives in engine/config.ts, which is pure and testable. This file holds
 * only what the native location API needs, because Accuracy comes from
 * expo-location.
 *
 * distanceInterval is not here on purpose: LocationService always asks for 0,
 * so a fix arrives every timeInterval even standing still. That stream is the
 * engine's clock in the background, where Android pauses JS timers.
 */
export interface GpsSampling {
  accuracy: Accuracy;
  /** Android: ms between updates. iOS ignores it and delivers on movement. */
  timeInterval: number;
}

export const TRANSIT_SAMPLING: Readonly<Record<TransitMode, GpsSampling>> = {
  walking: { accuracy: Accuracy.High, timeInterval: 2_000 },
  biking: { accuracy: Accuracy.High, timeInterval: 1_500 },
  driving: { accuracy: Accuracy.BestForNavigation, timeInterval: 1_000 },
};

export function samplingFor(mode: TransitMode): GpsSampling {
  return TRANSIT_SAMPLING[mode];
}

/** Finest first: the order the profiles above refine in (interval down, accuracy up). */
const FINENESS: readonly TransitMode[] = ['driving', 'biking', 'walking'];

/**
 * The finest sampling any of `modes` needs (Epic 16, PM 5 Oct 2026). A
 * planned session is PINNED to it for its whole length, so no chapter change
 * restarts tracking - on Android a restart stops and re-starts the location
 * foreground service, which the OS only allows in the foreground, and a plan
 * changes mode exactly when the visitor is about to leave for Google Maps.
 * A walking-only plan stays on the walking profile; a driving plan samples
 * at the driving rate on its walking chapters too (a battery cost the PM
 * accepted - and while it drives, Maps holds the GPS on anyway).
 */
export function finestMode(modes: readonly TransitMode[]): TransitMode {
  const found = FINENESS.find((m) => modes.includes(m));
  if (found === undefined) throw new RangeError('finestMode: no transit modes');
  return found;
}
