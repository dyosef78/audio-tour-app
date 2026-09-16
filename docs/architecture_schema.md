# System Architecture & Database Schema

> **Superseded in part.** [`ARCHITECTURE.md`](ARCHITECTURE.md) is the single source of truth. Where the two disagree (for example audio ducking, the public CDN, the zone-exit fade), it wins; see its §7.

**Version:** 2.1.0 (Audio standard fixed to AAC-LC)
**Status:** Approved for Mobile Development

## 1. Database Schema (Supabase PostgreSQL + PostGIS)
The backend utilizes Supabase (PostgreSQL 15+) with PostGIS for spatial data.

```sql
CREATE TABLE tours (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(255) NOT NULL,
    topology VARCHAR(50) NOT NULL,
    transit_mode VARCHAR(50) NOT NULL,
    duration_minutes INT NOT NULL
);

CREATE TABLE waypoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tour_id UUID REFERENCES tours(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    poi_type VARCHAR(50) NOT NULL,
    geom geometry(Point, 4326) NOT NULL,
    sort_order INT NOT NULL
);
CREATE INDEX idx_waypoints_geom ON waypoints USING GIST (geom);

CREATE TABLE geofence_zones (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    waypoint_id UUID REFERENCES waypoints(id) ON DELETE CASCADE,
    zone_type VARCHAR(50) NOT NULL,
    trigger_radius_meters INT,
    geom geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX idx_geofence_zones_geom ON geofence_zones USING GIST (geom);

CREATE TABLE audio_tracks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    waypoint_id UUID REFERENCES waypoints(id) ON DELETE CASCADE,
    storage_path VARCHAR(512) NOT NULL, -- Relative path in the 'audio-tracks' bucket; must end .m4a
    duration_seconds INT,
    format VARCHAR(20) DEFAULT 'AAC',  -- AAC-LC only; see section 2
    size_bytes BIGINT NOT NULL,
    lufs_normalization INT DEFAULT -16
);

{
  "bundle_version_hash": "a1b2c3d4e5",
  "tour_metadata": {
    "tour_id": "uuid",
    "transit_mode": "walking"
  },
  "waypoints": [
    {
      "waypoint_id": "uuid",
      "coordinates": [35.2279, 31.7766],
      "geofence": { "type": "radius", "radius_meters": 25 },
      "media": { 
        "storage_path": "tours/uuid/wp01_jaffa_gate.m4a", 
        "duration_seconds": 145,
        "size_bytes": 1250000 
      }
    }
  ]
}
## 2. Audio Format Standard — AAC-LC (`.m4a`)

**AAC-LC in an MP4 container (`.m4a`) is the only audio format accepted for client
delivery.** Opus was the original choice and has been abandoned. Do not reintroduce it.

### Why

iOS has no Ogg demuxer and no Opus decoder in AVFoundation, which is what
`expo-audio` wraps. An `.opus` file on iOS does not raise an error — the player
reports `playing` while `isLoaded` stays false and the position never leaves
0:00. It fails silently, which is considerably worse than failing loudly.

Android decodes Opus-in-Ogg fine from API 21, so this is an iOS constraint, not a
universal one. We standardise on AAC-LC because it is the only widely supported
codec that works natively on both platforms without a bundled decoder.

### Rules

- **Codec:** AAC-LC. Not HE-AAC (uneven Android support), not Opus, not Vorbis.
- **Container / extension:** `.m4a`. The extension is load-bearing — AVFoundation
  infers format from the URL extension for local files, so AAC bytes named
  `.opus` still fail. The extension must match the actual codec.
- **`audio_tracks.format`:** the string `AAC`.
- **Bucket MIME allowlist** on `audio-tracks` must permit `audio/mp4`,
  `audio/m4a` and `audio/x-m4a`. A wrong MIME type is rejected at upload, not at
  playback, so the failure appears in the CMS rather than on a device.
- **MP3** is acceptable as a fallback if a source cannot be re-encoded, but it
  needs `audio/mpeg` added to the allowlist first, and it has no gapless
  playback.

### Client safeguards

`AudioService` refuses `.opus`, `.ogg`, `.oga` and `.webm` on iOS before creating
a player, and runs two watchdogs — a 5s load timeout and an 8s stall timeout —
because `expo-audio` exposes no error event and `play()` never throws on an
undecodable source. Any failure resets the transport UI rather than leaving it
stuck at "playing 0:00".

### Publish-time checks worth adding

Two failure modes reached a device during Epic 2 and both are cheap to catch when
content is published:

1. A row whose `storage_path` does not resolve to an object in the bucket.
2. A file whose extension disagrees with its actual codec.
