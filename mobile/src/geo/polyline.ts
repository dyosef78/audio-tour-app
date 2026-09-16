/**
 * TASK-604 - Encoded Polyline codec and route geometry helpers.
 *
 * The algorithm is Google's Encoded Polyline format. PostGIS implements the
 * same one (ST_LineFromEncodedPolyline / ST_AsEncodedPolyline), so a string
 * this module decodes is a string the database accepts.
 *
 * PRECISION IS ALWAYS EXPLICIT. The format does not record it, and the two
 * values in real use are both called "polyline":
 *
 *   5  Google Directions, OSRM `geometries=polyline`, Mapbox `polyline`
 *   6  Valhalla, OSRM / Mapbox `polyline6`
 *
 * Reading one as the other fails silently in one direction. A precision-6
 * string read at 5 multiplies every coordinate by ten and leaves the valid
 * range, which a range check catches. A precision-5 string read at 6 divides
 * by ten and lands near 0,0 - still valid coordinates, in the Gulf of Guinea -
 * and only a distance-to-the-tour's-stops check notices. So nothing here
 * defaults it.
 *
 * ONE implementation, shared: the app decodes and validates every route with it
 * (routing/routeGeometry.ts), and backend/scripts/verify-bundle.ts decodes the
 * bundle route CI serves with it. Moved here from backend/cms in TASK-604 Part 2.
 * Import-free, so both Metro and Node type-stripping load it (see package.json).
 */

export type PolylinePrecision = 5 | 6;

export interface RoutePoint {
  lat: number;
  lng: number;
}

export class PolylineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolylineError';
  }
}

function encodeSigned(value: number): string {
  // Zig-zag: fold the sign into the low bit so small negatives stay short.
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

export function encodePolyline(points: readonly RoutePoint[], precision: PolylinePrecision): string {
  const factor = 10 ** precision;
  let prevLat = 0;
  let prevLng = 0;
  let out = '';
  for (const p of points) {
    // Deltas between ROUNDED integers, so rounding error never accumulates
    // along a long route.
    const lat = Math.round(p.lat * factor);
    const lng = Math.round(p.lng * factor);
    out += encodeSigned(lat - prevLat) + encodeSigned(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

/** Throws PolylineError on a character outside the alphabet or a truncated value. */
export function decodePolyline(encoded: string, precision: PolylinePrecision): RoutePoint[] {
  const factor = 10 ** precision;
  const points: RoutePoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const readSigned = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length) {
        throw new PolylineError(`Encoded polyline is truncated at character ${index}.`);
      }
      const code = encoded.charCodeAt(index++);
      if (code < 63 || code > 126) {
        throw new PolylineError(`Illegal polyline character ${JSON.stringify(encoded[index - 1])} at ${index - 1}.`);
      }
      const chunk = code - 63;
      result |= (chunk & 0x1f) << shift;
      shift += 5;
      if (chunk < 0x20) break;
      if (shift > 30) throw new PolylineError(`Polyline value too long at character ${index}.`);
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    lat += readSigned();
    lng += readSigned();
    // Divide the accumulated integer once, rather than summing floats.
    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Shortest distance from a point to a polyline, in metres.
 *
 * Equirectangular projection centred on the point: well under 1% error at the
 * scale of a tour (a few km), which is all a tolerance check needs. Not for
 * anything continental.
 */
export function distanceToRouteMeters(point: RoutePoint, route: readonly RoutePoint[]): number {
  if (route.length === 0) return Number.POSITIVE_INFINITY;
  const cosLat = Math.cos(rad(point.lat));
  const project = (p: RoutePoint): [number, number] => [
    rad(p.lng - point.lng) * EARTH_RADIUS_M * cosLat,
    rad(p.lat - point.lat) * EARTH_RADIUS_M,
  ];

  let best = Number.POSITIVE_INFINITY;
  const first = route[0] as RoutePoint;
  if (route.length === 1) return Math.hypot(...project(first));

  for (let i = 1; i < route.length; i++) {
    const [ax, ay] = project(route[i - 1] as RoutePoint);
    const [bx, by] = project(route[i] as RoutePoint);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    // The point is the origin of the projection, so project (0,0) onto AB.
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSq));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
