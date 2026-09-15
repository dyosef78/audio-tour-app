/**
 * TASK-603 - WebVTT transcript upload, beside an already-registered track.
 *
 * PM decision: transcripts are a CONVENTION, not a row. A track at
 * `tours/<id>/wp01_x.m4a` has its transcript at `tours/<id>/wp01_x.vtt`, and
 * get_tour_bundle() discovers it in storage. So there is no RPC to call here -
 * the whole job is to refuse a bad file before it reaches devices, then put a
 * good one at the one path anything will ever look for.
 *
 * VALIDATED WITH THE DEVICE'S OWN PARSER. checkTranscript() imports
 * mobile/src/transcript/vtt.ts rather than a server-side approximation of it,
 * so "the CMS accepted it" and "the phone can read it" cannot disagree. SQL
 * cannot read object contents, so this is the only place that check can live.
 *
 * ORDER: the track must already be registered. A transcript uploaded first
 * would sit beside nothing, and cms_validate_tour reports that as
 * transcript_orphaned rather than letting it pass silently.
 */

import { readFile } from 'node:fs/promises';

import { parseVtt, VttParseError } from '../../mobile/src/transcript/vtt.ts';
import { AUDIO_BUCKET, createAdminScopedClient } from './client.ts';
import { CmsIngestError } from './errors.ts';
import { isSafeStoragePath, transcriptPathFor } from './storage-path.ts';

/**
 * Well above any narration transcript - an hour of speech is ~100 KB of VTT -
 * and far below anything the device would struggle to read synchronously.
 */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024;

/**
 * Exactly this string. It is what migration 20260915120000 appends to the
 * bucket allowlist, and a variant such as `text/vtt; charset=utf-8` is not
 * guaranteed to match it.
 */
export const TRANSCRIPT_CONTENT_TYPE = 'text/vtt';

/** A transcript may end this far past its audio before we call it a mismatch. */
const END_TOLERANCE_SECONDS = 2;

export interface TranscriptCheck {
  cueCount: number;
  skippedCues: number;
  lastCueEndSeconds: number;
  warnings: string[];
}

/**
 * Validate transcript bytes. Throws `invalid_transcript` on anything a device
 * could not display; returns warnings for things it can display but probably
 * should not.
 *
 * Pure - no network - so a dry run and the tests use it directly.
 */
export function checkTranscript(
  bytes: Uint8Array,
  audioDurationSeconds: number | null,
): TranscriptCheck {
  if (bytes.byteLength === 0) {
    throw new CmsIngestError('invalid_transcript', 'The transcript file is empty.');
  }
  if (bytes.byteLength > MAX_TRANSCRIPT_BYTES) {
    throw new CmsIngestError(
      'invalid_transcript',
      `The transcript is ${bytes.byteLength} bytes; the limit is ${MAX_TRANSCRIPT_BYTES}.`,
      { detail: 'A narration transcript this large is almost certainly the wrong file.' },
    );
  }

  // fatal: true, because WebVTT is UTF-8 by definition and a Windows-1255
  // Hebrew export would otherwise decode "successfully" into mojibake that
  // every device would faithfully display.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new CmsIngestError('invalid_transcript', 'The transcript is not valid UTF-8.', {
      detail: 'Re-export it as UTF-8. Legacy encodings are the usual cause for Hebrew text.',
      cause,
    });
  }

  let parsed: ReturnType<typeof parseVtt>;
  try {
    parsed = parseVtt(text);
  } catch (cause) {
    throw new CmsIngestError(
      'invalid_transcript',
      cause instanceof VttParseError ? cause.message : 'The transcript could not be parsed.',
      { cause },
    );
  }

  if (parsed.cues.length === 0) {
    throw new CmsIngestError('invalid_transcript', 'The transcript has no usable cues.', {
      detail: 'Every cue block was missing a valid "start --> end" line or had no text.',
    });
  }

  const warnings: string[] = [];
  const lastCueEndSeconds = Math.max(...parsed.cues.map((c) => c.end));

  if (parsed.skipped > 0) {
    warnings.push(
      `${parsed.skipped} cue block(s) were unusable (bad timing or no text) and will not be shown.`,
    );
  }

  if (audioDurationSeconds !== null && lastCueEndSeconds > audioDurationSeconds + END_TOLERANCE_SECONDS) {
    warnings.push(
      `Cues run to ${lastCueEndSeconds.toFixed(1)} s but the audio is ${audioDurationSeconds} s. ` +
        'The timings are probably from a different take; highlighting will drift.',
    );
  }

  return { cueCount: parsed.cues.length, skippedCues: parsed.skipped, lastCueEndSeconds, warnings };
}

export interface TranscriptIngestRequest {
  /** The signed-in admin's access token. Not needed when `dryRun` is set. */
  accessToken?: string;
  /** storage_path of the REGISTERED audio track this transcript belongs to. */
  audioStoragePath: string;
  source: { path?: string; bytes?: Uint8Array };
  /** Validate only. Touches neither Storage nor the database. */
  dryRun?: boolean;
  /** Used by a dry run, which cannot look the track up. */
  audioDurationSeconds?: number;
}

export interface TranscriptIngestResult {
  storagePath: string;
  sizeBytes: number;
  cueCount: number;
  skippedCues: number;
  /** audio_tracks.id the transcript was attached beside, or null on a dry run. */
  trackId: string | null;
  uploaded: boolean;
  warnings: string[];
}

async function readSource(source: TranscriptIngestRequest['source']): Promise<Uint8Array> {
  if (source.bytes !== undefined) return source.bytes;
  if (source.path === undefined) {
    throw new CmsIngestError('invalid_request', 'source needs either a path or bytes.');
  }
  try {
    return await readFile(source.path);
  } catch (cause) {
    throw new CmsIngestError('source_unreadable', `Could not read ${source.path}.`, { cause });
  }
}

/**
 * Validate a transcript and upload it beside its audio.
 *
 * Replaces any existing transcript at that path - which is what a correction
 * is. The bundle hash includes the object's eTag, so the correction reaches
 * devices on their next bundle refresh.
 */
export async function ingestTrackTranscript(
  request: TranscriptIngestRequest,
): Promise<TranscriptIngestResult> {
  const storagePath = transcriptPathFor(request.audioStoragePath);
  if (storagePath === null || !isSafeStoragePath(request.audioStoragePath)) {
    throw new CmsIngestError(
      'invalid_request',
      `Not a registrable audio path: ${request.audioStoragePath}`,
      { detail: 'Transcripts attach to .m4a or .mp3 tracks only.' },
    );
  }

  const dryRun = request.dryRun === true;
  if (!dryRun && !request.accessToken) {
    throw new CmsIngestError(
      'invalid_request',
      'accessToken is required. Forward the signed-in admin session - see client.ts.',
    );
  }

  const bytes = await readSource(request.source);

  if (dryRun) {
    const check = checkTranscript(bytes, request.audioDurationSeconds ?? null);
    return {
      storagePath,
      sizeBytes: bytes.byteLength,
      cueCount: check.cueCount,
      skippedCues: check.skippedCues,
      trackId: null,
      uploaded: false,
      warnings: check.warnings,
    };
  }

  const supabase = createAdminScopedClient(request.accessToken as string);

  // limit(1), not maybeSingle(): two waypoints may legitimately share one
  // recording, and then one transcript serves both.
  const { data: tracks, error: lookupError } = await supabase
    .from('audio_tracks')
    .select('id, duration_seconds')
    .eq('storage_path', request.audioStoragePath)
    .limit(1);

  if (lookupError) {
    throw new CmsIngestError('lookup_failed', `Could not look up ${request.audioStoragePath}.`, {
      detail: lookupError.message,
      cause: lookupError,
    });
  }

  const track = (tracks ?? [])[0] as { id: string; duration_seconds: number | null } | undefined;
  if (track === undefined) {
    throw new CmsIngestError(
      'track_not_found',
      `No registered track uses ${request.audioStoragePath}.`,
      { detail: 'Ingest and register the audio first; a transcript beside nothing is never downloaded.' },
    );
  }

  // Validated BEFORE upload, against the real duration. Nothing invalid is
  // ever written, so there is nothing to roll back.
  const check = checkTranscript(bytes, track.duration_seconds);

  const { error: uploadError } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(storagePath, bytes, { contentType: TRANSCRIPT_CONTENT_TYPE, upsert: true });

  if (uploadError) {
    throw new CmsIngestError('upload_failed', `Storage refused ${storagePath}: ${uploadError.message}`, {
      detail:
        'A MIME rejection means migration 20260915120000 (text/vtt on the allowlist) is not ' +
        'applied. Otherwise the session is usually not in app_admins.',
      cause: uploadError,
    });
  }

  return {
    storagePath,
    sizeBytes: bytes.byteLength,
    cueCount: check.cueCount,
    skippedCues: check.skippedCues,
    trackId: track.id,
    uploaded: true,
    warnings: check.warnings,
  };
}
