/**
 * Wire shape returned by the `get_tour_bundle` RPC, and stored verbatim as
 * manifest.json inside a downloaded bundle.
 *
 * Snake_case is deliberate - this is the server contract, not a domain type.
 * `TourBundleRepository` maps it into the camelCase domain types in
 * `types/domain.ts` at load time, so exactly one module knows both shapes.
 */

/** [longitude, latitude] - GeoJSON axis order, as the manifest spec defines. */
export type LonLat = [number, number];

export type WireGeofence =
  | { type: 'radius'; radius_meters: number | null; center: LonLat }
  | { type: 'polygon'; ring: LonLat[] };

export interface WireMedia {
  /** Relative to the `audio-tracks` bucket. Never an absolute URL. */
  storage_path: string;
  duration_seconds: number | null;
  size_bytes: number;
  format: string | null;
}

export interface WireWaypoint {
  waypoint_id: string;
  name: string;
  poi_type: string;
  sort_order: number;
  coordinates: LonLat;
  geofence: WireGeofence | null;
  media: WireMedia | null;
}

export interface WireBundle {
  /** Content-derived hash; changes whenever any tour content changes. */
  bundle_version_hash: string;
  tour_metadata: {
    tour_id: string;
    title: string;
    topology: string;
    transit_mode: string;
    duration_minutes: number;
  };
  waypoints: WireWaypoint[];
}

/** Aggregate progress for the Screen 2 bar. */
export interface BundleProgress {
  bytesWritten: number;
  totalBytes: number;
  filesCompleted: number;
  filesTotal: number;
  /** 0..1. Guaranteed finite even when the bundle has no audio. */
  fraction: number;
}

/**
 * Narrow runtime check.
 *
 * The manifest is read back from disk, where it may have been truncated by a
 * crash mid-write or written by an older build. Trusting a `JSON.parse` result
 * because TypeScript says it is a `WireBundle` is exactly how offline caches
 * fail in the field, so the shape is verified rather than asserted.
 */
export function isWireBundle(value: unknown): value is WireBundle {
  if (typeof value !== 'object' || value === null) return false;
  const b = value as Partial<WireBundle>;
  if (typeof b.bundle_version_hash !== 'string') return false;
  if (typeof b.tour_metadata?.tour_id !== 'string') return false;
  if (!Array.isArray(b.waypoints)) return false;
  return b.waypoints.every(
    (w) =>
      typeof w?.waypoint_id === 'string' &&
      Array.isArray(w?.coordinates) &&
      w.coordinates.length === 2 &&
      w.coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );
}
