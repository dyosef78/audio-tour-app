/**
 * The coords_key every cost cache row carries: "lon,lat;lon,lat" to 6 decimals.
 *
 * ONE formatter for writers and readers (route_legs_cache, chapter_leg_costs,
 * chapter_travel_matrix). A reader recomputes the key from the coordinates it
 * just loaded and ignores a row whose key differs: that is what closes the
 * race where a cost is written for a point the CMS has since moved
 * (20260917120000, INVALIDATION (2)). Two formatters could disagree by one
 * rounding and silently turn every row stale - so there is only this one.
 * Moved here from route-stops/legCache.ts for plan-tour (Epic 16).
 */

export interface KeyPoint {
  lon: number;
  lat: number;
}

export function coordsKey(from: KeyPoint, to: KeyPoint): string {
  return `${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}`;
}
