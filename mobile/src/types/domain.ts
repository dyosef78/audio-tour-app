/**
 * Domain types for the mobile client.
 *
 * These mirror the Supabase schema in docs/architecture_schema.md v2.0.0, but
 * are deliberately hand-written rather than imported from the generated
 * `backend/types/supabase.ts`, for two reasons:
 *
 *   1. The device works from a downloaded offline bundle, not from live rows.
 *      PostGIS `geometry` columns arrive as decoded coordinates here, not WKB.
 *   2. The mobile client should not break every time an unrelated backend
 *      column changes.
 *
 * Once `npm run types:generate` has been run in the repo root, the fetch layer
 * can map the generated Row types onto these.
 */

/** Longitude/latitude in WGS84 (SRID 4326), matching raw GPS fixes. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

export type TransitMode = 'walking' | 'biking' | 'driving';
export type Topology = 'in_city' | 'point_to_point' | 'star_loop';

/** `transition` stops get a short navigational cue; the rest are anchors. */
export type PoiType = 'historic_site' | 'cafe_anchor' | 'viewpoint' | 'transition';

export type ZoneType = 'radius' | 'polygon';

export interface Tour {
  id: string;
  title: string;
  topology: Topology;
  transitMode: TransitMode;
  durationMinutes: number;
}

/**
 * A radius zone carries a centre + radius; a polygon zone carries a ring.
 * Modelled as a discriminated union so the geofence check cannot read a radius
 * off a polygon zone or vice versa.
 */
export type GeofenceZone =
  | {
      id: string;
      waypointId: string;
      zoneType: 'radius';
      center: LatLng;
      radiusMeters: number;
    }
  | {
      id: string;
      waypointId: string;
      zoneType: 'polygon';
      /** Closed ring; first and last vertex are equal. */
      ring: LatLng[];
    };

export interface AudioTrack {
  id: string;
  waypointId: string;
  /**
   * Path RELATIVE to the `audio-tracks` Supabase Storage bucket, e.g.
   * `tours/<tour_id>/wp01_jaffa_gate.opus`. Never an absolute URL - resolve
   * with getPublicUrl(), or map to a local file URI once downloaded.
   */
  storagePath: string;
  durationSeconds: number | null;
  format: string;
  sizeBytes: number;
  lufsNormalization: number;
  /** Set by the offline bundle downloader once the file is on disk. */
  localUri?: string;
}

export interface Waypoint {
  id: string;
  tourId: string;
  name: string;
  poiType: PoiType;
  coordinate: LatLng;
  sortOrder: number;
  geofence: GeofenceZone | null;
  audio: AudioTrack | null;
}

/** A tour plus everything needed to run it with no network. */
export interface TourBundle {
  bundleVersionHash: string;
  tour: Tour;
  waypoints: Waypoint[];
}
