/**
 * TASK-401 - failure taxonomy for the audio pipeline.
 *
 * Coded rather than string-matched. The CMS has to tell three very different
 * situations apart and say something useful about each:
 *
 *   - the operator uploaded the wrong thing        -> fix the file
 *   - the loudness target could not be met         -> fix the recording
 *   - ffmpeg is missing or built without loudnorm  -> fix the server
 *
 * A single `Error` with prose forces the UI to regex the message, which breaks
 * the first time a message is reworded.
 */

export type MediaErrorCode =
  /** No usable ffmpeg/ffprobe could be resolved. Deployment problem. */
  | 'ffmpeg_missing'
  /** ffmpeg exists but lacks the loudnorm filter or the aac encoder. */
  | 'ffmpeg_capability_missing'
  /** ffmpeg ran and exited non-zero. `detail` holds the tail of stderr. */
  | 'ffmpeg_failed'
  /** ffprobe could not read the file, or returned unparsable JSON. */
  | 'probe_failed'
  /** The upload contains no audio stream at all - a video, an image, a PDF. */
  | 'no_audio_stream'
  /** Digital silence, or so quiet that EBU R128 gating finds nothing to measure. */
  | 'source_silent'
  /** Longer than the preset allows. Bounds CPU on a shared box. */
  | 'source_too_long'
  /** Larger than the preset allows. Bounds disk and read time. */
  | 'source_too_large'
  /** loudnorm printed something that was not the JSON block we expect. */
  | 'measurement_unparsable'
  /** The encoded file missed the LUFS target by more than the tolerance. */
  | 'loudness_out_of_tolerance'
  /** The encoded file exceeds the bucket's file_size_limit. */
  | 'output_too_large'
  /** ffmpeg exited 0 but produced nothing, or produced an unreadable file. */
  | 'output_invalid'
  /** The caller asked for an output path the database would reject. */
  | 'invalid_output_path';

export interface MediaPipelineErrorOptions {
  /** Operator-facing extra context: an stderr tail, a measured value. */
  detail?: string;
  cause?: unknown;
}

export class MediaPipelineError extends Error {
  readonly code: MediaErrorCode;
  readonly detail: string | undefined;

  // Explicit field assignment rather than parameter properties: the root
  // tsconfig sets `erasableSyntaxOnly`, so this module has to survive plain
  // type-stripping under `node file.ts` with no build step.
  constructor(code: MediaErrorCode, message: string, options: MediaPipelineErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'MediaPipelineError';
    this.code = code;
    this.detail = options.detail;
  }
}

/** Narrowing helper for callers that catch broadly, as HTTP handlers must. */
export function isMediaPipelineError(value: unknown): value is MediaPipelineError {
  return value instanceof MediaPipelineError;
}
