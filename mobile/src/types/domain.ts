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

/**
 * `transition` stops get a short navigational cue; the rest are anchors.
 *
 * 'anchor' added in TASK-507 to match content strategy - and to close a real
 * drift: both seed files have been inserting poi_type 'anchor' since TASK-202,
 * while this union did not list it. TourBundleRepository casts the wire value
 * with `as PoiType`, so the mismatch never threw - it just meant the type was
 * quietly lying about what the database contains.
 */
export type PoiType = 'anchor' | 'historic_site' | 'cafe_anchor' | 'viewpoint' | 'transition';

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
   * `tours/<tour_id>/wp01_jaffa_gate.m4a`. Never an absolute URL - resolve
   * with signedAudioUrls() at download time, or map to a local file URI once
   * downloaded. The bucket is private, so there is no permanent public URL.
   */
  storagePath: string;
  /**
   * The real `audio_tracks.id`, for telemetry's FK.
   *
   * Distinct from `id` above, which is a synthetic `<waypoint_id>:audio` used
   * only to tell one loaded track from another on the device. Null for bundles
   * downloaded before TASK-507: get_tour_bundle() did not return it, and the
   * migration deliberately keeps it out of bundle_version_hash so existing
   * bundles are not invalidated. Populated as bundles naturally refresh.
   */
  audioTrackId: string | null;
  durationSeconds: number | null;
  format: string;
  sizeBytes: number;
  /*
   * NO lufsNormalization (PM decision, TASK-502). It was carried here as a
   * hardcoded -16, which get_tour_bundle never actually returns - a constant
   * dressed as a measurement. Since the pipeline guarantees -16 LUFS and the
   * client is forbidden from applying gain, nothing on the device may act on a
   * loudness figure, so holding one is a trap rather than a feature.
   */
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
