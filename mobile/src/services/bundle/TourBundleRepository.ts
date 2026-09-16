import { Directory } from 'expo-file-system';

import { parseGroupTypes, parseInterests } from '../../personalization/options';
import { signedAudioUrls } from '../supabase/client';
import { fetchTourBundle } from '../supabase/bundle';
import { DownloadManager, type DownloadItem } from './DownloadManager';
import { planBundleFiles } from './plan';
import { parseEncodedRoute } from '../../routing/routeGeometry';
import {
  bundleDir,
  bundlesRoot,
  manifestFile,
  mediaFile,
  partialDir,
  resolveLocalUri,
} from './paths';
import {
  isWireBundle,
  type BundleProgress,
  type WireBundle,
  type WireMedia,
  type WireWaypoint,
} from './types';
import type {
  AudioTrack,
  EncodedRoute,
  GeofenceZone,
  PoiType,
  TransitMode,
  Waypoint,
} from '../../types/domain';

/**
 * TourBundleRepository - the only module that knows bundles live on a filesystem.
 *
 * Everything downstream (LocationService, AudioService, the map) receives plain
 * domain objects with `localUri` already resolved, exactly as designed in Epic 1.
 */

export interface DownloadOptions {
  onProgress?: (progress: BundleProgress) => void;
  concurrency?: number;
}

export class TourBundleRepository {
  /** A bundle counts as present only if its manifest parses. */
  static isDownloaded(tourId: string): boolean {
    return this.readManifest(tourId) !== null;
  }

  static readManifest(tourId: string): WireBundle | null {
    const file = manifestFile(bundleDir(tourId));
    if (!file.exists) return null;
    try {
      const parsed: unknown = JSON.parse(file.textSync());
      return isWireBundle(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch metadata, download every track, and commit atomically.
   *
   * Order matters throughout: everything lands in `<tourId>.partial`, the
   * directory is renamed into place only after all files verify, and the
   * manifest is written last. The manifest's presence IS the completion marker,
   * so a bundle can never be observed half-built.
   */
  static async download(tourId: string, options: DownloadOptions = {}): Promise<WireBundle> {
    const remote = await fetchTourBundle(tourId);

    // Already have this exact version - nothing to do.
    const local = this.readManifest(tourId);
    if (local?.bundle_version_hash === remote.bundle_version_hash) {
      options.onProgress?.({
        bytesWritten: 0,
        totalBytes: 0,
        filesCompleted: 0,
        filesTotal: 0,
        fraction: 1,
      });
      return local;
    }

    // Narration, Deep Dives and transcript sidecars, de-duplicated by path
    // (TASK-603). Every file lands at its bucket path inside the bundle, which
    // is what lets TranscriptRepository find a transcript by convention.
    const plan = planBundleFiles(remote);
    for (const warning of plan.warnings) console.warn('[Bundle]', warning);

    // Signed in one batch, and deliberately BEFORE any directory is created:
    // an unpublished tour should fail here, having written nothing, rather than
    // leave an empty staging directory behind for the resume path to find.
    //
    // These tokens are minted fresh on every call, which is what makes a
    // resumed download work after its previous URLs have expired. Transcripts
    // sign through the same policy as audio since migration 20260915120000.
    const urls = await signedAudioUrls(plan.files.map((f) => f.storagePath));

    bundlesRoot().create({ intermediates: true, idempotent: true });

    const staging = partialDir(tourId);
    staging.create({ intermediates: true, idempotent: true });

    const items: DownloadItem[] = plan.files.map((f) => {
      const url = urls.get(f.storagePath);
      if (url === undefined) {
        // The bundle metadata and the storage objects are gated on the same
        // tours.status, so the realistic cause is an unpublish between the RPC
        // above and this call. Fail loudly: committing a manifest whose media
        // is unreachable is precisely what the atomic-commit design prevents.
        // A transcript is no exception - the bundle promised it.
        throw new Error(
          `No download URL was issued for ${f.storagePath} (${f.kind}). ` +
            'The tour may have been unpublished since its metadata was fetched.',
        );
      }

      return {
        storagePath: f.storagePath,
        url,
        destination: mediaFile(staging, f.storagePath),
        sizeBytes: f.sizeBytes,
      };
    });

    const manager = new DownloadManager(tourId, {
      concurrency: options.concurrency,
      onProgress: options.onProgress,
    });

    // A failure here propagates deliberately, leaving the staging directory in
    // place: its bytes are what make the next attempt cheap. Only a successful
    // run or an explicit discardPartial() clears it.
    await manager.run(items);

    // Manifest written into staging, so the committed directory is complete the
    // instant the rename lands.
    manifestFile(staging).write(JSON.stringify(remote));

    const final = bundleDir(tourId);
    if (final.exists) final.delete();
    staging.rename(tourId);

    return remote;
  }

  /** Discard a partially downloaded bundle and its persisted resume state. */
  static async discardPartial(tourId: string): Promise<void> {
    await new DownloadManager(tourId).cancel();
    const staging = partialDir(tourId);
    if (staging.exists) staging.delete();
  }

  /** Delete a downloaded bundle. Used by eviction and by "remove download". */
  static remove(tourId: string): void {
    const dir = bundleDir(tourId);
    if (dir.exists) dir.delete();
  }

  /** Every tourId currently holding a valid bundle. */
  static listDownloaded(): string[] {
    const root = bundlesRoot();
    if (!root.exists) return [];
    return root
      .list()
      .filter((entry): entry is Directory => entry instanceof Directory)
      .map((dir) => dir.name)
      .filter((name) => !name.endsWith('.partial'))
      .filter((tourId) => this.isDownloaded(tourId));
  }

  // ---------------------------------------------------------------------------
  // Hydration - wire shape in, Epic 1 domain types out
  // ---------------------------------------------------------------------------

  /**
   * Load a downloaded bundle as domain `Waypoint[]`, ready to hand straight to
   * `LocationService.loadTour()`.
   *
   * This is the read-time bridge: `localUri` is derived from `storage_path`
   * here and now, never read from stored state. That is what keeps the bundle
   * valid across the iOS container UUID rotation.
   */
  static loadWaypoints(tourId: string): Waypoint[] | null {
    const manifest = this.readManifest(tourId);
    if (!manifest) return null;

    return manifest.waypoints
      .map((w) => this.toWaypoint(tourId, w))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  static loadTransitMode(tourId: string): TransitMode | null {
    const manifest = this.readManifest(tourId);
    return manifest ? (manifest.tour_metadata.transit_mode as TransitMode) : null;
  }

  /**
   * The bundled route (TASK-604), shape-checked but not yet decoded - that
   * needs the session's active stops. Null for tours without a route and for
   * every bundle downloaded before the route migration.
   */
  static loadRoute(tourId: string): EncodedRoute | null {
    const manifest = this.readManifest(tourId);
    return manifest ? parseEncodedRoute(manifest.route) : null;
  }

  private static toWaypoint(tourId: string, w: WireWaypoint): Waypoint {
    const [longitude, latitude] = w.coordinates;

    return {
      id: w.waypoint_id,
      tourId,
      name: w.name,
      poiType: w.poi_type as PoiType,
      coordinate: { latitude, longitude },
      sortOrder: w.sort_order,
      geofence: this.toGeofence(w),
      audio: this.toAudio(tourId, w.waypoint_id, w.media, 'audio'),
      deepDive: this.toAudio(tourId, w.waypoint_id, w.deep_dive ?? null, 'deep_dive'),
      // Absent in pre-TASK-603 manifests, which parse as untagged.
      audiences: parseGroupTypes(w.audiences),
      interests: parseInterests(w.interests),
    };
  }

  /** Wire geofence -> the discriminated union the geometry helpers expect. */
  private static toGeofence(w: WireWaypoint): GeofenceZone | null {
    const g = w.geofence;
    if (!g) return null;

    if (g.type === 'polygon') {
      return {
        id: `${w.waypoint_id}:zone`,
        waypointId: w.waypoint_id,
        zoneType: 'polygon',
        ring: g.ring.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
      };
    }

    const [lon, lat] = g.center;
    return {
      id: `${w.waypoint_id}:zone`,
      waypointId: w.waypoint_id,
      zoneType: 'radius',
      center: { latitude: lat, longitude: lon },
      // A radius zone with no radius is unusable; fall back to 0 so the engine
      // simply never triggers it rather than throwing mid-walk.
      radiusMeters: g.radius_meters ?? 0,
    };
  }

  /**
   * `slot` becomes the synthetic id suffix. The session controller relies on
   * it: a zone exit stops only `<waypoint_id>:audio`, which is what lets a
   * Deep Dive keep playing after the listener walks on.
   */
  private static toAudio(
    tourId: string,
    waypointId: string,
    m: WireMedia | null,
    slot: 'audio' | 'deep_dive',
  ): AudioTrack | null {
    if (!m) return null;

    return {
      id: `${waypointId}:${slot}`,
      waypointId,
      storagePath: m.storage_path,
      // Absent from pre-TASK-507 manifests; null rather than undefined so the
      // telemetry payload shape is identical either way.
      audioTrackId: m.audio_track_id ?? null,
      durationSeconds: m.duration_seconds,
      format: m.format ?? 'AAC',
      sizeBytes: m.size_bytes,
      // Derived, never stored.
      localUri: resolveLocalUri(tourId, m.storage_path),
    };
  }
}
