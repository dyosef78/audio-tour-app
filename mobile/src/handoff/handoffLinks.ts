import type { LatLng, TransitMode } from '../types/domain.ts';

/**
 * Navigation handoff links (Epic 15, Slice 5). Pure: the RN shell
 * (services/handoff) checks which apps are installed and opens the result.
 *
 *   Google Maps   https://www.google.com/maps/dir/?api=1 - Google's documented
 *                 cross-platform Maps URLs. Opens the app when installed,
 *                 the website otherwise. Origin omitted = current location;
 *                 dir_action=navigate starts turn-by-turn straight away.
 *   Waze          https://waze.com/ul?ll=..&navigate=yes - one destination, no
 *                 waypoints. The server only offers it for a driving chapter
 *                 with no anchors (get_tour_bundle `providers`).
 *
 * THE BROWSER TRAP. Google honours up to 9 waypoints in the app but only 3 in
 * a mobile browser. Without the app, a 5-anchor scenic route would silently
 * become a different route. planHandoff() never lets that happen: it asks.
 */

export type HandoffProvider = 'google_maps' | 'waze';

export interface HandoffSpec {
  destination: LatLng;
  destinationLabel: string | null;
  /** Routing anchors, in order. */
  anchors: readonly LatLng[];
  /** What the server allows for this chapter. */
  providers: readonly HandoffProvider[];
}

/** Google Maps URLs: waypoints honoured by the app / by a mobile browser. */
export const GOOGLE_MAPS_MAX_WAYPOINTS = 9;
export const GOOGLE_MAPS_BROWSER_MAX_WAYPOINTS = 3;

const TRAVEL_MODE: Readonly<Record<TransitMode, string>> = {
  driving: 'driving',
  walking: 'walking',
  biking: 'bicycling',
};

/** 6 decimals = ~10 cm; more is noise, fewer moves the pin. */
const coord = (p: LatLng): string => `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;

function assertCoord(p: LatLng, what: string): void {
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) {
    throw new RangeError(`handoff: ${what} is not a valid coordinate (${p.latitude}, ${p.longitude})`);
  }
}

/**
 * The Google Maps URL. `includeAnchors: false` is the explicit, user-chosen
 * "navigate without the scenic route" fallback - never a silent truncation.
 * More than 9 anchors is a contract violation (the server caps them): thrown.
 */
export function googleMapsUrl(spec: HandoffSpec, mode: TransitMode, options: { includeAnchors?: boolean } = {}): string {
  assertCoord(spec.destination, 'destination');
  const anchors = options.includeAnchors === false ? [] : spec.anchors;
  if (anchors.length > GOOGLE_MAPS_MAX_WAYPOINTS) {
    throw new RangeError(`handoff: ${anchors.length} anchors; Google Maps accepts at most ${GOOGLE_MAPS_MAX_WAYPOINTS}`);
  }
  anchors.forEach((a, i) => assertCoord(a, `anchor ${i + 1}`));
  const params = [
    'api=1',
    `destination=${encodeURIComponent(coord(spec.destination))}`,
    `travelmode=${TRAVEL_MODE[mode]}`,
    ...(anchors.length > 0 ? [`waypoints=${encodeURIComponent(anchors.map(coord).join('|'))}`] : []),
    'dir_action=navigate',
  ];
  return `https://www.google.com/maps/dir/?${params.join('&')}`;
}

/** The Waze URL. Waze takes no waypoints: anchors here are a contract violation. */
export function wazeUrl(spec: HandoffSpec): string {
  assertCoord(spec.destination, 'destination');
  if (spec.anchors.length > 0) {
    throw new RangeError(`handoff: Waze takes no waypoints, but this chapter has ${spec.anchors.length} anchors`);
  }
  return `https://waze.com/ul?ll=${encodeURIComponent(coord(spec.destination))}&navigate=yes`;
}

export const GOOGLE_MAPS_STORE_URL: Readonly<Record<'ios' | 'android', string>> = {
  ios: 'https://apps.apple.com/app/id585027354',
  android: 'https://play.google.com/store/apps/details?id=com.google.android.apps.maps',
};

export type HandoffPlan =
  /** Open this URL. */
  | { kind: 'open'; url: string }
  /**
   * Google Maps is not installed and the scenic route needs more waypoints
   * than a browser honours. Ask: install the app, or go without the anchors.
   */
  | { kind: 'needs_app'; installUrl: string; withoutScenicUrl: string; anchorCount: number };

/**
 * What tapping a provider button should do. Refuses (throws) a provider the
 * server did not list for this chapter: offering it would route differently
 * from the tour's design.
 */
export function planHandoff(
  provider: HandoffProvider,
  spec: HandoffSpec,
  mode: TransitMode,
  installed: { googleMaps: boolean },
  platform: 'ios' | 'android',
): HandoffPlan {
  if (!spec.providers.includes(provider)) {
    throw new RangeError(`handoff: ${provider} is not offered for this chapter (${spec.providers.join(', ') || 'none'})`);
  }
  if (provider === 'waze') return { kind: 'open', url: wazeUrl(spec) };
  if (!installed.googleMaps && spec.anchors.length > GOOGLE_MAPS_BROWSER_MAX_WAYPOINTS) {
    return {
      kind: 'needs_app',
      installUrl: GOOGLE_MAPS_STORE_URL[platform],
      withoutScenicUrl: googleMapsUrl(spec, mode, { includeAnchors: false }),
      anchorCount: spec.anchors.length,
    };
  }
  return { kind: 'open', url: googleMapsUrl(spec, mode) };
}
