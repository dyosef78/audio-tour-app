/**
 * Wire shape returned by the `get_tour_bundle` RPC, and stored verbatim as
 * manifest.json inside a downloaded bundle.
 *
 * Snake_case is deliberate - this is the server contract, not a domain type.
 * `TourBundleRepository` maps it into the camelCase domain types in
 * `types/domain.ts` at load time, so exactly one module knows both shapes.
 *
 * EVERY KEY ADDED AFTER A RELEASE IS OPTIONAL. Manifests are written to disk and
 * read back by later builds, so a manifest from before TASK-507 or TASK-603
 * must still parse.
 */

import { STOP_ROLES } from '../../../../shared/src/vocabulary.ts';

/** [longitude, latitude] - GeoJSON axis order, as the manifest spec defines. */
export type LonLat = [number, number];

export type WireGeofence =
  | { type: 'radius'; radius_meters: number | null; center: LonLat }
  | { type: 'polygon'; ring: LonLat[] };

/** A WebVTT sidecar found beside the audio in storage (TASK-603). */
export interface WireTranscript {
  storage_path: string;
  size_bytes: number;
}

export interface WireMedia {
  /**
   * `audio_tracks.id`. Added by migration 20260828150000 (TASK-507).
   *
   * OPTIONAL, and it must stay optional: the migration keeps this field out of
   * bundle_version_hash so that adding it did not force every user to
   * re-download every byte of audio they already held. A manifest written before
   * TASK-507 therefore has no such key, and parsing must not reject it.
   */
  audio_track_id?: string | null;
  /** 'narration' under `media`, 'deep_dive' under `deep_dive`. Absent before TASK-603. */
  track_kind?: string;
  /** Relative to the `audio-tracks` bucket. Never an absolute URL. */
  storage_path: string;
  duration_seconds: number | null;
  size_bytes: number;
  format: string | null;
  /** Null when no transcript is published beside this track. Absent before TASK-603. */
  transcript?: WireTranscript | null;
}

export interface WireWaypoint {
  waypoint_id: string;
  name: string;
  poi_type: string;
  sort_order: number;
  coordinates: LonLat;
  geofence: WireGeofence | null;
  /** The geofence narration. Never a Deep Dive since TASK-603. */
  media: WireMedia | null;
  /** Optional extended track (TASK-603). */
  deep_dive?: WireMedia | null;
  /** Preference tags (TASK-603). Values may postdate this build - filter, do not trust. */
  audiences?: string[];
  interests?: string[];
  /** The chapter this stop belongs to (Epic 15). Absent before 20261001120100: the tour's one chapter. */
  chapter_id?: string;
  /** Direction-of-travel check (Epic 15). null = no check; absent before 20261001120100. */
  approach?: WireApproach | null;
  /** 'core' | 'extension' (Epic 16). Absent before 20261005120100: core. Checked by isWireBundle. */
  stop_role?: string;
}

/** Epic 15. Present only when the waypoint's bearing_policy is not 'ignore'. */
export interface WireApproach {
  bearing_deg: number;
  tolerance_deg: number;
  policy: string;
}

/** Epic 15: where a chapter hands navigation off to Google Maps / Waze. */
export interface WireHandoff {
  /** [longitude, latitude]. */
  destination: LonLat;
  destination_label: string | null;
  /** Routing anchors, in order. Never geofenced. */
  anchors: LonLat[];
  /** Decided by the server. A value this build does not know is dropped, not trusted. */
  providers: string[];
}

/** Epic 15: one chapter of the tour. */
export interface WireChapter {
  chapter_id: string;
  sort_order: number;
  title: string | null;
  transit_mode: string;
  sequence_policy: string;
  lookahead_stops: number;
  handoff: WireHandoff | null;
}

/**
 * The tour route (TASK-604): top-level `route` in get_tour_bundle. The server
 * always sends precision 6 and says so; parseEncodedRoute() still refuses one
 * whose precision is missing rather than assuming.
 */
export interface WireRoute {
  encoding: string;
  precision: number;
  polyline: string;
  length_meters?: number;
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
    audiences?: string[];
    interests?: string[];
  };
  waypoints: WireWaypoint[];
  /** Null when the tour has no route; absent from bundles made before TASK-604. */
  route?: WireRoute | null;
  /**
   * Epic 15. Absent from manifests saved before 20261001120100: the device then
   * synthesises the one plain chapter (engine/fromManifest.ts), which is
   * exactly what the server sends for every tour that has not been split.
   */
  chapters?: WireChapter[];
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
  const waypointsOk = b.waypoints.every(
    (w) =>
      typeof w?.waypoint_id === 'string' &&
      Array.isArray(w?.coordinates) &&
      w.coordinates.length === 2 &&
      w.coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
      // Epic 16. A role this build does not know is a newer server's: refused,
      // never guessed - reading it as core could narrate an extension.
      (w.stop_role === undefined || (STOP_ROLES as readonly string[]).includes(w.stop_role)),
  );
  if (!waypointsOk) return false;

  // Epic 15. Without `chapters` (a manifest from before 20261001120100) no
  // waypoint may name a chapter; with them, every waypoint must name one of
  // them. A manifest that disagrees with itself is refused, never repaired.
  if (b.chapters === undefined) return b.waypoints.every((w) => w.chapter_id === undefined);
  if (!Array.isArray(b.chapters) || b.chapters.length === 0) return false;
  const ids = new Set<string>();
  for (const c of b.chapters) {
    if (typeof c?.chapter_id !== 'string' || typeof c.transit_mode !== 'string' || ids.has(c.chapter_id)) return false;
    ids.add(c.chapter_id);
  }
  return b.waypoints.every((w) => typeof w.chapter_id === 'string' && ids.has(w.chapter_id));
}
