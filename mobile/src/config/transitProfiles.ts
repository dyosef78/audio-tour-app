import { Accuracy } from 'expo-location';

import type { TransitMode } from '../types/domain';

/**
 * Per-transit-mode tuning for the Adaptive GPS and geofence engine.
 *
 * !! SOURCE NOTE !!
 * The numeric envelopes below come from PRD **v1.0.0 Section 3** ("השפעת אופן
 * התנועה על מנוע המערכת"). PRD v2.0.0 dropped that table - Screen 3 now says
 * only "Adaptive GPS transitions to high-accuracy when near a POI" without
 * giving numbers. These values are carried forward on the assumption they still
 * hold; see the handover report, they need PM confirmation.
 *
 *   walking : trigger 15-30 m, moderate adaptive sampling, 90-150 s narration
 *   biking  : trigger 50-80 m, medium sampling (15-25 km/h)
 *   driving : trigger 150-300 m (early trigger), frequent sampling (40-90 km/h)
 */
export interface TransitProfile {
  /** Fallback when a zone has no explicit trigger_radius_meters. */
  defaultTriggerRadiusMeters: number;
  /** Documented range, for validating content rather than driving runtime. */
  triggerRadiusRangeMeters: readonly [min: number, max: number];

  /**
   * Distance to the nearest waypoint at which Adaptive GPS escalates from
   * `coarse` to `fine`. Set well outside the trigger radius so the fix has
   * already sharpened before the user reaches the boundary - escalating at the
   * boundary itself would mean the first accurate fix arrives too late.
   */
  escalateWithinMeters: number;

  /** Battery-saving profile used when no waypoint is nearby. */
  coarse: GpsSampling;
  /** High-accuracy profile used near a waypoint. */
  fine: GpsSampling;

  /**
   * Re-entry cooldown (PRD Screen 4, "Debounce/Cooldown"). A user loitering on
   * a boundary must not retrigger the same track. Scaled to the mode: a driver
   * who loops a block should hear it again sooner than a walker on a bench.
   */
  retriggerCooldownMs: number;

  /**
   * Exit hysteresis. The exit boundary is this multiple of the entry radius, so
   * a GPS fix jittering across the edge does not produce enter/exit churn.
   */
  exitHysteresisFactor: number;
}

export interface GpsSampling {
  accuracy: Accuracy;
  /** Android only; minimum ms between updates. */
  timeInterval: number;
  /** Minimum metres of movement before an update fires. */
  distanceInterval: number;
}

export const TRANSIT_PROFILES: Record<TransitMode, TransitProfile> = {
  walking: {
    defaultTriggerRadiusMeters: 25,
    triggerRadiusRangeMeters: [15, 30],
    escalateWithinMeters: 120,
    coarse: { accuracy: Accuracy.Balanced, timeInterval: 10_000, distanceInterval: 25 },
    fine: { accuracy: Accuracy.High, timeInterval: 2_000, distanceInterval: 5 },
    retriggerCooldownMs: 10 * 60_000,
    exitHysteresisFactor: 1.6,
  },
  biking: {
    defaultTriggerRadiusMeters: 65,
    triggerRadiusRangeMeters: [50, 80],
    escalateWithinMeters: 300,
    coarse: { accuracy: Accuracy.Balanced, timeInterval: 6_000, distanceInterval: 40 },
    fine: { accuracy: Accuracy.High, timeInterval: 1_500, distanceInterval: 15 },
    retriggerCooldownMs: 5 * 60_000,
    exitHysteresisFactor: 1.5,
  },
  driving: {
    defaultTriggerRadiusMeters: 220,
    triggerRadiusRangeMeters: [150, 300],
    escalateWithinMeters: 900,
    coarse: { accuracy: Accuracy.Balanced, timeInterval: 4_000, distanceInterval: 100 },
    fine: { accuracy: Accuracy.BestForNavigation, timeInterval: 1_000, distanceInterval: 25 },
    retriggerCooldownMs: 3 * 60_000,
    exitHysteresisFactor: 1.4,
  },
};

export function profileFor(mode: TransitMode): TransitProfile {
  return TRANSIT_PROFILES[mode];
}
