/**
 * TASK-401 - ffprobe wrapper.
 *
 * Requirement 3 of the epic lives here and in pipeline.ts: `size_bytes` and
 * `duration_seconds` have to be RIGHT, because the mobile downloader compares
 * the byte count with `===` and rejects the whole bundle on a mismatch
 * (DownloadManager.transfer). A duration that is merely close is fine for the
 * UI; a size that is merely close is a bundle that can never be downloaded.
 *
 * So the two numbers come from different places on purpose:
 *   size     - fs.stat() on the artifact itself, never from ffprobe metadata
 *   duration - ffprobe, from the container
 */

import { stat } from 'node:fs/promises';

import { MediaPipelineError } from './errors.ts';
import { runFfprobe } from './ffmpeg.ts';

export interface ProbedAudio {
  /** Container duration in seconds, fractional. */
  durationSeconds: number;
  /** From fs.stat(), not from ffprobe. */
  sizeBytes: number;
  codec: string | null;
  /** ffprobe's `profile`, e.g. "LC" for AAC-LC. */
  profile: string | null;
  channels: number | null;
  sampleRateHz: number | null;
  bitRateBps: number | null;
  formatName: string | null;
  /** Album art counts as a video stream; it is why the encode passes -vn. */
  hasVideoStream: boolean;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  channels?: number;
  sample_rate?: string;
  bit_rate?: string;
  duration?: string;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
  };
}

/** ffprobe reports every number as a string, and "N/A" for anything it lacks. */
function numeric(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function probeAudio(file: string): Promise<ProbedAudio> {
  const { stdout } = await runFfprobe([
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (cause) {
    throw new MediaPipelineError('probe_failed', `ffprobe returned unparsable JSON for ${file}.`, {
      detail: stdout.slice(0, 500),
      cause,
    });
  }

  const streams = parsed.streams ?? [];
  const audio = streams.find((s) => s.codec_type === 'audio');

  if (audio === undefined) {
    throw new MediaPipelineError(
      'no_audio_stream',
      'The uploaded file contains no audio stream.',
      { detail: `streams: ${streams.map((s) => s.codec_type ?? '?').join(', ') || 'none'}` },
    );
  }

  // Container duration first: for AAC in MP4 it accounts for the edit list that
  // compensates encoder delay, which the raw stream duration does not.
  const duration = numeric(parsed.format?.duration) ?? numeric(audio.duration);

  if (duration === null || duration <= 0) {
    throw new MediaPipelineError(
      'probe_failed',
      'Could not determine a positive duration for the audio.',
      { detail: `format.duration=${parsed.format?.duration ?? 'N/A'}` },
    );
  }

  const { size } = await stat(file);

  return {
    durationSeconds: duration,
    sizeBytes: size,
    codec: audio.codec_name ?? null,
    profile: audio.profile ?? null,
    channels: audio.channels ?? null,
    sampleRateHz: numeric(audio.sample_rate),
    bitRateBps: numeric(audio.bit_rate) ?? numeric(parsed.format?.bit_rate),
    formatName: parsed.format?.format_name ?? null,
    hasVideoStream: streams.some((s) => s.codec_type === 'video'),
  };
}

/**
 * Codecs that have already thrown information away.
 *
 * Re-encoding one of these to AAC is a second generation of lossy loss, and it
 * is audible on sibilants in spoken word long before it shows up on a meter.
 * The pipeline does it anyway - refusing the upload would be worse - but it
 * says so, so the CMS can ask for the WAV.
 */
const LOSSY_CODECS = new Set([
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'wmav2',
  'ac3',
  'amr_nb',
  'amr_wb',
]);

export function isLossySource(probed: ProbedAudio): boolean {
  return probed.codec !== null && LOSSY_CODECS.has(probed.codec);
}
