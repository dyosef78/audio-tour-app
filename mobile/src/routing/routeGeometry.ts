import { decodePolyline, distanceToRouteMeters, PolylineError, type RoutePoint } from '../../../shared/src/polyline';
import { routeToleranceMeters } from '../../../shared/src/routeTolerance';
import type { EncodedRoute, LatLng, TransitMode, Waypoint } from '../types/domain';

/**
 * Parsing and validating routes before anything draws one (TASK-604).
 *
 * Every route gets the same treatment whether it came from the offline bundle,
 * the disk cache or the network: decode with its DECLARED precision, then
 * prove it actually reaches the stops it is meant to connect. That is the check
 * that catches the polyline5/polyline6 mix-up the backend work documented - a
 * route decoded at the wrong precision is still valid coordinates, just in the
 * wrong hemisphere.
 */

/**
 * Wire shape -> EncodedRoute, or null.
 *
 * Precision is never defaulted: an absent or unexpected value rejects the
 * route rather than guessing 5, which is what every map library assumes.
 */
export function parseEncodedRoute(value: unknown): EncodedRoute | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['encoding'] !== 'polyline') return null;
  const precision = v['precision'];
  if (precision !== 5 && precision !== 6) return null;
  const polyline = v['polyline'];
  if (typeof polyline !== 'string' || polyline.length === 0) return null;
  const length = v['length_meters'];
  return {
    precision,
    polyline,
    lengthMeters: typeof length === 'number' && Number.isFinite(length) ? length : null,
  };
}

export type RouteValidation = { ok: true; points: LatLng[] } | { ok: false; reason: string };

export function decodeRoute(
  route: EncodedRoute,
  stops: readonly Waypoint[],
  transitMode: TransitMode,
): RouteValidation {
  let decoded: RoutePoint[];
  try {
    decoded = decodePolyline(route.polyline, route.precision);
  } catch (err) {
    return { ok: false, reason: err instanceof PolylineError ? err.message : 'route could not be decoded' };
  }

  if (decoded.length < 2) return { ok: false, reason: `route has ${decoded.length} point(s)` };

  if (decoded.some((p) => Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180)) {
    return { ok: false, reason: `coordinates out of range at precision ${route.precision} (wrong precision?)` };
  }

  const tolerance = routeToleranceMeters(transitMode);
  for (const stop of stops) {
    const gap = distanceToRouteMeters(
      { lat: stop.coordinate.latitude, lng: stop.coordinate.longitude },
      decoded,
    );
    if (gap > tolerance) {
      return { ok: false, reason: `${stop.name} is ${Math.round(gap)} m from the route (limit ${tolerance} m)` };
    }
  }

  return { ok: true, points: decoded.map((p) => ({ latitude: p.lat, longitude: p.lng })) };
}
