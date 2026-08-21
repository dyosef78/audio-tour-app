# System Architecture & Database Schema
**Version:** 2.0.0 (Updated post-Supabase deployment)
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
    storage_path VARCHAR(512) NOT NULL, -- Relative path in Supabase 'audio-tracks' bucket
    duration_seconds INT,
    format VARCHAR(20) DEFAULT 'Opus',
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
        "storage_path": "tours/uuid/wp01_jaffa_gate.opus", 
        "duration_seconds": 145,
        "size_bytes": 1250000 
      }
    }
  ]
}