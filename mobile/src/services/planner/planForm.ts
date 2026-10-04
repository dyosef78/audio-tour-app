import { PLAN_CONTRACT_VERSION, type PlanTourOk, type PlanTourRequest, type TransitMode } from '../../../../shared/src/contracts/planTour.ts';
import type { GroupType, Interest } from '../../../../shared/src/vocabulary.ts';
import type { PlanResult } from './PlanClient.ts';

/**
 * The pure half of PlanScreen and PlanPreviewScreen (Epic 16 final slice).
 * No React Native, so test:plan can cover the request, the error copy and
 * the segment rows.
 */

export type PlanOrigin = { lon: number; lat: number; source: 'gps' | 'address'; label: string };

export interface PlanFormValues {
  cityId: string;
  origin: PlanOrigin;
  minutes: number;
  transitMode: TransitMode;
  groupType: GroupType;
  interests: readonly Interest[];
  includeDeepDives: boolean;
}

/** The time chips. Onboarding's 120/240/480 are among them, so its choice prefills one. */
export const PLAN_MINUTE_CHOICES: readonly number[] = [60, 120, 180, 240, 480];

/** "2026-10-04T14:05:00+03:00": the visitor's wall clock WITH its offset (contract: SmartSorter rule 1). */
export function localIsoWithOffset(d: Date): string {
  const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/** What a filled form asks. Incomplete forms never get here: the screen disables Plan. */
export function buildPlanRequest(v: PlanFormValues, now: Date): PlanTourRequest {
  if (v.interests.length === 0) throw new RangeError('buildPlanRequest: at least one interest');
  return {
    contract_version: PLAN_CONTRACT_VERSION,
    city_id: v.cityId,
    // The label never leaves the phone: the server sees coordinates only.
    origin: { lon: v.origin.lon, lat: v.origin.lat, source: v.origin.source },
    available_minutes: v.minutes,
    transit_mode: v.transitMode,
    group_type: v.groupType,
    interests: [...v.interests],
    context: { local_time: localIsoWithOffset(now) },
    include_deep_dives: v.includeDeepDives,
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

/** Visitor-facing copy for a failed plan. `retry` says whether the same form can simply be sent again. */
export function planErrorCopy(e: Extract<PlanResult, { kind: 'error' }>): { title: string; message: string; retry: boolean } {
  switch (e.code) {
    case 'no_candidates':
      return { title: 'Nothing to plan here yet', message: 'This city has no tours for that way of getting around. Try walking, or another city.', retry: false };
    case 'origin_out_of_range':
      return { title: 'Too far from the tours', message: 'Your starting point is too far from every tour in this city. Pick a start closer in, or a faster way of getting around.', retry: false };
    case 'plan_infeasible': {
      const short = e.shortfallS !== undefined ? ` About ${formatDuration(e.shortfallS)} more would fit the shortest one.` : '';
      return { title: 'Not enough time', message: `Even the shortest tour does not fit that time from where you start.${short}`, retry: false };
    }
    case 'rate_limited':
      return { title: 'Too many plans at once', message: `Please wait ${e.retryAfterS !== undefined ? formatDuration(e.retryAfterS) : 'a moment'} and try again.`, retry: true };
    case 'network':
    case 'timeout':
      return { title: 'No connection', message: 'Planning needs a connection. Your downloaded tours still work offline.', retry: true };
    case 'invalid_request':
    case 'unsupported_contract':
      return { title: 'Update the app', message: 'This version of the app cannot plan any more. Please update it.', retry: false };
    case 'internal':
    case 'bad_response':
      return { title: 'Planning failed', message: 'Something went wrong on our side. Please try again.', retry: true };
  }
}

export type SegmentRow =
  | { kind: 'transfer'; key: string; mode: TransitMode; durationS: number; distanceM: number; estimated: boolean; fromOrigin: boolean }
  | { kind: 'chapter'; key: string; tourId: string; chapterId: string; title: string; tourTitle: string | null; stops: number; extensions: number; durationS: number; estimated: boolean };

/** Titles: the chapter's own (from a downloaded manifest), else the tour's, else a placeholder. */
export interface TitleLookup {
  chapterTitle(tourId: string, chapterId: string): string | null;
  tourTitle(tourId: string): string | null;
}

export function segmentRows(plan: PlanTourOk, titles: TitleLookup): SegmentRow[] {
  let n = 0;
  return plan.segments.map((s, i): SegmentRow => {
    if (s.kind === 'transfer') {
      return { kind: 'transfer', key: `t${i}`, mode: s.mode, durationS: s.duration_s, distanceM: s.distance_m, estimated: s.cost_source === 'estimated', fromOrigin: s.from.kind === 'origin' };
    }
    n++;
    const tourTitle = titles.tourTitle(s.tour_id);
    return {
      kind: 'chapter',
      key: `c${i}`,
      tourId: s.tour_id,
      chapterId: s.chapter_id,
      title: titles.chapterTitle(s.tour_id, s.chapter_id) ?? tourTitle ?? `Stop group ${n}`,
      tourTitle,
      stops: s.waypoint_ids.length,
      extensions: s.kept_extension_ids.length,
      durationS: s.travel_s + s.dwell_s,
      estimated: s.cost_source === 'estimated',
    };
  });
}

/** The estimate card's numbers, "about" when any leg was estimated. */
export function estimateSummary(plan: PlanTourOk): { total: string; approximate: boolean; slack: string | null; deepDiveExtra: string | null } {
  const e = plan.estimate;
  return {
    total: formatDuration(e.total_s),
    approximate: plan.quality.legs_estimated > 0,
    slack: e.slack_s >= 60 ? formatDuration(e.slack_s) : null,
    deepDiveExtra: e.deep_dive_extra_s >= 60 ? formatDuration(e.deep_dive_extra_s) : null,
  };
}

/** The v2 upsell: only when the planner dropped high-value stops strictly for lack of time. */
export function upsellCopy(plan: PlanTourOk): string | null {
  const n = plan.quality.dropped_high_value_extensions;
  if (n <= 0) return null;
  return n === 1
    ? '1 more stop that matches your interests would fit with more time.'
    : `${n} more stops that match your interests would fit with more time.`;
}
