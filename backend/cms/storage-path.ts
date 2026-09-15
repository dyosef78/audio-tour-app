/**
 * TASK-402 - where a processed track lives in the bucket.
 *
 * THE PATH IS DERIVED SERVER-SIDE, NEVER TAKEN FROM THE UPLOAD.
 *
 * The client's filename is used for nothing except an extension hint and a log
 * line. Every segment of the real path comes from ids the server already holds,
 * so a multipart part named `../../../../etc/passwd` or
 * `../../tours/<other-tour>/wp01.m4a` cannot influence where bytes land. That
 * second one is the interesting attack: not escaping the bucket, but writing
 * over another tour's narration from inside it.
 *
 * Shape, unchanged from architecture_schema.md and both seed files:
 *
 *     tours/<tour_id>/wp01_jaffa_gate.m4a              narration
 *     tours/<tour_id>/wp01_jaffa_gate.deep_dive.m4a    Deep Dive   (TASK-603)
 *     tours/<tour_id>/wp01_jaffa_gate.vtt              transcript of the first
 *     tours/<tour_id>/wp01_jaffa_gate.deep_dive.vtt    ... and of the second
 *
 * The kind segment is not cosmetic. Uploads use upsert, so without it a Deep
 * Dive for a waypoint would be written OVER that waypoint's narration file -
 * and the size check in cms_register_audio_track would then refuse the
 * narration row that still describes it, with nothing pointing at the cause.
 */

import { transcriptPathFor } from '../../mobile/src/transcript/sidecar.ts';
import { CmsIngestError } from './errors.ts';

/**
 * Single definition shared with the device, not a mirror: a naming convention
 * with two implementations is a naming convention with two behaviours.
 */
export { transcriptPathFor };

/** Mirrors the audio_tracks_track_kind_check constraint. */
export const TRACK_KINDS = ['narration', 'deep_dive'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

export function isTrackKind(value: unknown): value is TrackKind {
  return typeof value === 'string' && (TRACK_KINDS as readonly string[]).includes(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long enough to stay readable in a bucket listing, short enough for any FS. */
const MAX_SLUG_LENGTH = 40;

export interface StoragePathInput {
  tourId: string;
  /** waypoints.sort_order - what makes the filename unique within a tour. */
  sortOrder: number;
  waypointName: string;
  /** Defaults to 'narration', whose paths are unchanged from before TASK-603. */
  trackKind?: TrackKind;
  /** Required when `contentAddressed` is set. */
  sha256?: string;
  /**
   * Append the first 8 hex digits of the content hash to the filename.
   *
   * OFF by default, which is decision D5 left as it was found. The deterministic
   * name matches every existing example in the docs and both seed files, and
   * the risk of reusing it is narrower than it first looked: get_tour_bundle()
   * folds storage_path, size_bytes AND duration_seconds into
   * bundle_version_hash, so a re-record changes the hash as soon as its byte
   * count differs - which it essentially always does. The stale-file window is
   * only a replacement whose size and rounded duration both match the old take
   * exactly.
   *
   * Turning this on closes even that, at the cost of orphaning an object on
   * every single re-record rather than overwriting in place. The ingest service
   * deletes those orphans, so the cost is real but bounded.
   */
  contentAddressed?: boolean;
}

/**
 * Waypoint name to a filename fragment.
 *
 * Diacritics are folded rather than stripped outright, so "Zion Gate" and
 * "Zión Gate" do not collapse to different-looking mush. Names in scripts with
 * no Latin transliteration - Hebrew and Arabic, which this tour catalogue is
 * full of - reduce to nothing and fall back to `waypoint`. That is fine and not
 * a collision risk: the `wpNN_` prefix carries uniqueness within a tour, and
 * the slug is only there to make a bucket listing readable by a human.
 */
export function slugifyWaypointName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    // The slice can leave a trailing underscore behind.
    .replace(/_+$/, '');

  return slug.length > 0 ? slug : 'waypoint';
}

/**
 * Mirror of the mobile client's `paths.isSafeStoragePath`.
 *
 * Duplicated deliberately. The device applies it to what the database hands it;
 * this applies it to what we are about to put in the database. A path that
 * fails either check should never have existed, and the cheapest place to be
 * certain is both ends.
 */
export function isSafeStoragePath(storagePath: string): boolean {
  if (storagePath.length === 0) return false;
  if (storagePath.startsWith('/') || storagePath.includes('\\')) return false;
  if (storagePath.includes('://')) return false;
  return storagePath.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function buildAudioStoragePath(input: StoragePathInput): string {
  if (!UUID.test(input.tourId)) {
    throw new CmsIngestError('invalid_request', `tourId is not a uuid: ${input.tourId}`);
  }

  if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0) {
    throw new CmsIngestError(
      'invalid_request',
      `sortOrder must be a non-negative integer, got ${input.sortOrder}`,
    );
  }

  // Checked at runtime too: this is called from JavaScript controllers where
  // the type is only a hope, and a misspelt kind would silently mean narration.
  if (input.trackKind !== undefined && !isTrackKind(input.trackKind)) {
    throw new CmsIngestError(
      'invalid_request',
      `trackKind must be one of ${TRACK_KINDS.join(', ')}, got ${String(input.trackKind)}`,
    );
  }
  const kindSegment = input.trackKind === 'deep_dive' ? '.deep_dive' : '';

  // Zero-padded so a bucket listing sorts the way the tour plays. Beyond 99
  // stops it simply grows a digit, which sorts wrong at 100 but is honest -
  // and no walking tour has a hundred stops.
  const index = String(input.sortOrder).padStart(2, '0');

  let suffix = '';
  if (input.contentAddressed === true) {
    if (input.sha256 === undefined || input.sha256.length < 8) {
      throw new CmsIngestError(
        'invalid_request',
        'contentAddressed requires the sha256 of the processed file.',
      );
    }
    suffix = `.${input.sha256.slice(0, 8)}`;
  }

  const path =
    `tours/${input.tourId}/wp${index}_${slugifyWaypointName(input.waypointName)}` +
    `${kindSegment}${suffix}.m4a`;

  // Belt and braces. Every input above is already constrained, so reaching this
  // means one of those constraints was loosened and the traversal guard was the
  // thing that noticed.
  if (!isSafeStoragePath(path)) {
    throw new CmsIngestError('invalid_request', `Refusing to build an unsafe storage path: ${path}`);
  }

  return path;
}
