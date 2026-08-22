# Product Requirements Document (PRD) & User Flows
**Version:** 2.1.0 (Audio standard fixed to AAC-LC)
**Status:** Approved for Development

## 1. Core Vision & Experience
The application delivers hands-free, hyper-personalized, location-based audio tours. The core engine relies on offline-first caching and local Geofencing to trigger audio automatically without active internet[cite: 1].

## 2. Key User Flows & Screens

### Screen 1: Tour Discovery (Home)
* **UI Elements:** List/Grid of available tours.
* **Data:** Fetched via Supabase API. Displays title, topology type, and transit mode[cite: 2].
* **Action:** Tapping a tour navigates to Screen 2.

### Screen 2: Tour Detail & Pre-fetch (Offline Bundle)
* **UI Elements:** Tour description, map preview, and a prominent "Download Tour" button.
* **Logic (TASK-201):** Tapping download fetches the tour metadata, POI coordinates, and all associated audio files (AAC-LC `.m4a`) from the Supabase Storage public CDN into the device's local file system[cite: 2, 3].
* **State:** Displays a progress bar. Once 100% downloaded, the "Start Tour" button unlocks.

### Screen 3: Active Map & Geofencing Engine (TASK-101 & 102)
* **UI Elements:** Full-screen Map (React Native Maps). Shows a polyline of the route and markers for Anchor POIs and Transition POIs[cite: 3].
* **User Location:** A pulsing blue dot showing the user's live position.
* **Geofence Visualizer:** (Debug mode) Semi-transparent circles/polygons around POIs[cite: 2].
* **Background Logic:** Adaptive GPS transitions to high-accuracy when near a POI[cite: 2]. The local Geofence engine triggers the associated audio track immediately upon entering a zone[cite: 1].

### Screen 4: Smart Audio Player (Sticky Bottom Sheet)
* **UI Elements:** Play/Pause, Seek bar (using `duration_seconds` from DB), and a karaoke-style scrolling VTT transcript for accessibility[cite: 3].
* **Audio Logic (TASK-103):** 
  * Background playback allowed (screen locked)[cite: 2].
  * Audio Ducking: Lowers volume to 20% during OS navigation alerts[cite: 3].
  * Debounce/Cooldown: Prevents re-triggering the same audio if the user steps in and out of the boundary[cite: 2, 3].
  * Zone Exit: Gradual fade-out/pause if the user strays far from the POI[cite: 3].
---

## 4. Audio Format Constraint (added v2.1.0)

All narration ships as **AAC-LC in `.m4a`**. Opus is not used for client delivery.

iOS cannot decode Opus natively, and — importantly for QA — it fails *silently*:
the player reports as playing while the position stays at 0:00. If a stop
produces no sound, check the file format before suspecting the geofence engine.

Full rationale and the encoding rules are in `architecture_schema.md` section 2.
