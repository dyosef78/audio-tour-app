/**
 * TASK-402 - CMS upload -> media pipeline -> Storage -> audio_tracks.
 *
 * THE ORDER IS THE DESIGN
 *
 *   1. process     the raw upload into a normalised .m4a  (never in place)
 *   2. upload      the artifact to the private bucket
 *   3. register    the row, which the database refuses unless the object is
 *                  already there AND its byte count matches
 *
 * Registering first would write a claim about a file that may never arrive -
 * exactly the drift cms_validate_tour()'s `audio_object_missing` check exists
 * to find hours later, in front of a Publish button. Uploading first means the
 * worst case is an object with no row, which is inert: it costs storage, it is
 * listed by the reconciliation queries in backend/database/queries/, and no
 * user is ever pointed at it.
 *
 * That asymmetry is why step 3 failing UNDOES step 2. An orphaned object is
 * cheap but not free, and the moment we know the row will not exist is the only
 * moment we still know the object's path for certain.
 *
 * WHAT CAN STILL GO WRONG, HONESTLY
 *
 * There is no distributed transaction between Storage and Postgres and there
 * cannot be. If the process dies between the upload and the register, an
 * orphaned object survives. That window is milliseconds wide, the residue is
 * harmless, and the reconciliation queries already exist to sweep it - which is
 * a better trade than the alternative failure, a published tour whose audio
 * 404s in a street with no signal.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';

import {
  processNarrationAudio,
  type AudioPreset,
  type LoudnessReport,
} from '../media/index.ts';
import { AUDIO_BUCKET, createAdminScopedClient } from './client.ts';
import { CmsIngestError } from './errors.ts';
import { buildAudioStoragePath } from './storage-path.ts';
import { removeQuietly, withWorkspace, type Workspace } from './workspace.ts';

import type { SupabaseClient } from '@supabase/supabase-js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extensions we will name the scratch copy with. Anything else gets `.bin`. */
const KNOWN_SOURCE_EXTENSIONS = new Set([
  '.wav', '.flac', '.aiff', '.aif', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.mp4', '.mov',
]);

export interface AudioIngestSource {
  /** A file already on disk - typically the framework's multipart temp file. */
  path?: string;
  /** Raw bytes, when the CMS buffered the upload itself. */
  bytes?: Uint8Array;
  /**
   * The client-supplied filename.
   *
   * Used for an extension hint and for log lines, and for NOTHING else. It
   * never reaches the storage path - see storage-path.ts.
   */
  filename?: string;
  /**
   * Delete `path` when we are finished with it.
   *
   * Defaults to false, because the caller owns that file and it might be a
   * master somebody dragged in rather than a temp upload. An HTTP handler
   * working from a multipart temp file should pass true - that is the raw file
   * requirement 5 is about.
   */
  deleteAfter?: boolean;
}

export interface AudioIngestRequest {
  /** The signed-in admin's access token. Not needed when `dryRun` is set. */
  accessToken?: string;
  tourId: string;
  waypointId: string;
  /** waypoints.sort_order, for the filename. */
  sortOrder: number;
  waypointName: string;
  source: AudioIngestSource;
  preset?: AudioPreset;
  /** See StoragePathInput.contentAddressed. Off by default (decision D5). */
  contentAddressed?: boolean;
  /** Process and name the file, but touch neither Storage nor the database. */
  dryRun?: boolean;
  timeoutMs?: number;
}

export interface AudioIngestResult {
  /** audio_tracks.id, or null on a dry run. */
  trackId: string | null;
  storagePath: string;
  sizeBytes: number;
  durationSeconds: number;
  format: 'AAC';
  lufsNormalization: number;
  sha256: string;
  /** True when this replaced an existing track for the waypoint. */
  replaced: boolean;
  loudness: {
    source: LoudnessReport;
    encoded: LoudnessReport;
    normalizationType: string | null;
  };
  /** Audio findings from the pipeline, plus any cleanup we could not complete. */
  warnings: string[];
}

/** The jsonb cms_register_audio_track returns. */
interface RegistrationRow {
  track_id: string;
  storage_path: string;
  replaced: boolean;
  orphaned_object: string | null;
}

function isRegistrationRow(value: unknown): value is RegistrationRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<RegistrationRow>;
  return typeof row.track_id === 'string' && typeof row.storage_path === 'string';
}

function assertValidRequest(request: AudioIngestRequest): void {
  if (!UUID.test(request.tourId)) {
    throw new CmsIngestError('invalid_request', `tourId is not a uuid: ${request.tourId}`);
  }
  if (!UUID.test(request.waypointId)) {
    throw new CmsIngestError('invalid_request', `waypointId is not a uuid: ${request.waypointId}`);
  }
  if (request.source.path === undefined && request.source.bytes === undefined) {
    throw new CmsIngestError('invalid_request', 'source needs either a path or bytes.');
  }
  if (request.dryRun !== true && !request.accessToken) {
    throw new CmsIngestError(
      'invalid_request',
      'accessToken is required. Forward the signed-in admin session - see client.ts.',
    );
  }
}

/**
 * Get the raw upload onto disk where ffmpeg can read it.
 *
 * Bytes are written into the workspace, so they are covered by its cleanup. A
 * caller-supplied path is used IN PLACE rather than copied: the file can be
 * half a gigabyte, and duplicating it to gain nothing is a good way to fill a
 * disk during a busy editing session.
 */
async function materialiseSource(source: AudioIngestSource, ws: Workspace): Promise<string> {
  if (source.bytes !== undefined) {
    // The extension is a hint for ffmpeg's demuxer probing, never a decision:
    // ffprobe identifies the real format regardless, and probe.ts rejects
    // anything without an audio stream.
    const hint = extname(source.filename ?? '').toLowerCase();
    const extension = KNOWN_SOURCE_EXTENSIONS.has(hint) ? hint : '.bin';
    const target = ws.file(`source${extension}`);

    try {
      await writeFile(target, source.bytes);
    } catch (cause) {
      throw new CmsIngestError('source_unreadable', 'Could not write the upload to disk.', {
        cause,
      });
    }

    return target;
  }

  return source.path as string;
}

async function uploadArtifact(
  supabase: SupabaseClient,
  storagePath: string,
  localPath: string,
  contentType: string,
): Promise<void> {
  // The pipeline has already refused anything over the bucket's 50 MiB limit,
  // so this read is bounded. Streaming would be tidier and is the change to
  // make if narration ever grows into hour-long walking commentaries.
  let body: Buffer;
  try {
    body = await readFile(localPath);
  } catch (cause) {
    throw new CmsIngestError('source_unreadable', 'Could not read the processed file.', { cause });
  }

  const { error } = await supabase.storage.from(AUDIO_BUCKET).upload(storagePath, body, {
    contentType,
    // The path is derived from ids we own, so a collision means "this waypoint
    // already had a track" - which is a replacement, not an accident. Without
    // this, a retry after a failed registration would 409 forever.
    upsert: true,
  });

  if (error) {
    throw new CmsIngestError('upload_failed', `Storage refused ${storagePath}: ${error.message}`, {
      detail:
        'Usually the admin session is not in app_admins, so audio_tracks_admin_insert does not ' +
        'apply. A MIME rejection means contentType is off the bucket allowlist.',
      cause: error,
    });
  }
}

async function registerTrack(
  supabase: SupabaseClient,
  waypointId: string,
  storagePath: string,
  sizeBytes: number,
  durationSeconds: number,
  lufsNormalization: number,
): Promise<RegistrationRow> {
  const { data, error } = await supabase.rpc('cms_register_audio_track', {
    p_waypoint_id: waypointId,
    p_storage_path: storagePath,
    p_size_bytes: sizeBytes,
    p_duration_seconds: durationSeconds,
    // Measured by the verification pass, not assumed from the column default.
    p_lufs_normalization: lufsNormalization,
  });

  if (error) {
    throw new CmsIngestError('register_failed', `Could not register the track: ${error.message}`, {
      detail: error.hint ?? error.details ?? undefined,
      cause: error,
    });
  }

  if (!isRegistrationRow(data)) {
    throw new CmsIngestError(
      'register_failed',
      'cms_register_audio_track returned an unexpected shape.',
      { detail: JSON.stringify(data)?.slice(0, 300) },
    );
  }

  return data;
}

/**
 * Remove an object, recording rather than raising on failure.
 *
 * Every call site here is a compensating action running after something else
 * already decided the outcome. Throwing would replace a precise error with a
 * vaguer one, or fail a request whose real work succeeded. What matters is that
 * the path ends up somewhere a human can read it.
 */
async function removeObject(
  supabase: SupabaseClient,
  storagePath: string,
  warnings: string[],
  what: string,
): Promise<void> {
  const { error } = await supabase.storage.from(AUDIO_BUCKET).remove([storagePath]);

  if (error) {
    warnings.push(
      `Could not delete ${what} (${storagePath}): ${error.message}. It is now an orphaned ` +
        'object in the audio-tracks bucket - see backend/database/queries/ for the sweep.',
    );
  }
}

/**
 * Process one narration upload and record it against its waypoint.
 *
 * Resolves only when the object is in the bucket AND the row describes it. Any
 * earlier failure leaves no row, and no object it can find and remove.
 */
export async function ingestWaypointAudio(
  request: AudioIngestRequest,
): Promise<AudioIngestResult> {
  assertValidRequest(request);

  const dryRun = request.dryRun === true;
  const warnings: string[] = [];

  // Built before any work: a bad token or missing configuration should cost
  // nothing, not a full encode.
  const supabase = dryRun ? null : createAdminScopedClient(request.accessToken as string);

  return withWorkspace(async (ws) => {
    try {
      const sourcePath = await materialiseSource(request.source, ws);

      // --- 1. process -------------------------------------------------------
      // Output into the workspace, never beside the input: the CMS temp
      // directory is not ours to write into, and an encode that lands next to
      // the raw file is one somebody eventually forgets to delete.
      const processed = await processNarrationAudio(sourcePath, ws.file('normalised.m4a'), {
        ...(request.preset !== undefined ? { preset: request.preset } : {}),
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      });

      warnings.push(...processed.warnings);

      const storagePath = buildAudioStoragePath({
        tourId: request.tourId,
        sortOrder: request.sortOrder,
        waypointName: request.waypointName,
        sha256: processed.sha256,
        ...(request.contentAddressed !== undefined
          ? { contentAddressed: request.contentAddressed }
          : {}),
      });

      const common = {
        storagePath,
        sizeBytes: processed.sizeBytes,
        durationSeconds: processed.durationSeconds,
        format: processed.format,
        lufsNormalization: processed.lufsNormalization,
        sha256: processed.sha256,
        loudness: {
          source: {
            integratedLufs: processed.source.integratedLufs,
            truePeakDb: processed.source.truePeakDb,
            loudnessRangeLu: processed.source.loudnessRangeLu,
          },
          encoded: processed.encoded,
          normalizationType: processed.normalizationType,
        },
        warnings,
      };

      if (supabase === null) {
        return { ...common, trackId: null, replaced: false };
      }

      // --- 2. upload --------------------------------------------------------
      await uploadArtifact(supabase, storagePath, processed.outputPath, processed.contentType);

      // --- 3. register ------------------------------------------------------
      let registration: RegistrationRow;
      try {
        registration = await registerTrack(
          supabase,
          request.waypointId,
          storagePath,
          processed.sizeBytes,
          processed.durationSeconds,
          processed.lufsNormalization,
        );
      } catch (error) {
        // The row will not exist, so the object must not either. This is the
        // last point at which we still know its path with certainty.
        await removeObject(supabase, storagePath, warnings, 'the object just uploaded');
        throw error;
      }

      // A replacement that changed the filename leaves the old object behind
      // with nothing referencing it. The database cannot delete it - SQL has no
      // route to the Storage API - which is why the RPC hands the path back.
      if (registration.orphaned_object !== null) {
        await removeObject(
          supabase,
          registration.orphaned_object,
          warnings,
          'the replaced object',
        );
      }

      return {
        ...common,
        trackId: registration.track_id,
        replaced: registration.replaced,
      };
    } finally {
      // The workspace dies with this scope either way. This is only for the
      // caller's own raw file, which lives outside it.
      if (request.source.deleteAfter === true && request.source.path !== undefined) {
        await removeQuietly(request.source.path);
      }
    }
  });
}
