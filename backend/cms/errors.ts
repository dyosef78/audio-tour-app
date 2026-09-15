/**
 * TASK-402 - failure taxonomy for CMS ingest.
 *
 * Separate from MediaPipelineError on purpose. That one is about the audio;
 * this one is about the round trip - configuration, permissions, storage, the
 * database. The CMS shows them differently, because "your recording is silent"
 * is for the producer and "the service role is misconfigured" is not.
 *
 * A caller that wants a single catch can use `isCmsIngestError` alongside
 * `isMediaPipelineError`; both carry a `code` and an optional `detail`.
 */

export type CmsErrorCode =
  /** SUPABASE_URL / SUPABASE_ANON_KEY missing. A deployment problem. */
  | 'not_configured'
  /** The caller passed something structurally wrong - a bad uuid, no source. */
  | 'invalid_request'
  /** The raw upload could not be read or written to the workspace. */
  | 'source_unreadable'
  /** Storage refused the object. Usually RLS, occasionally the MIME allowlist. */
  | 'upload_failed'
  /** cms_register_audio_track raised. The object has been rolled back. */
  | 'register_failed'
  /** A transcript failed validation with the device's own WebVTT parser. Nothing was uploaded. */
  | 'invalid_transcript'
  /** A transcript names an audio path no registered track uses. Nothing was uploaded. */
  | 'track_not_found'
  /** The lookup that proves the track exists could not run. Nothing was uploaded. */
  | 'lookup_failed';

export interface CmsIngestErrorOptions {
  detail?: string;
  cause?: unknown;
}

export class CmsIngestError extends Error {
  readonly code: CmsErrorCode;
  readonly detail: string | undefined;

  constructor(code: CmsErrorCode, message: string, options: CmsIngestErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'CmsIngestError';
    this.code = code;
    this.detail = options.detail;
  }
}

export function isCmsIngestError(value: unknown): value is CmsIngestError {
  return value instanceof CmsIngestError;
}
