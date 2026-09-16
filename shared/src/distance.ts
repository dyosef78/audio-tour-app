/**
 * TASK-702 - great-circle distance between two points.
 *
 * Haversine on a sphere of the IUGG mean radius, the same radius polyline.ts
 * projects with. Accurate to ~0.5% - fine for ordering stops, not for billing.
 *
 * Import-free: loaded by Metro, Node type-stripping and Deno.
 */

import type { RoutePoint } from './polyline.ts';

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;

export function distanceMeters(a: RoutePoint, b: RoutePoint): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
