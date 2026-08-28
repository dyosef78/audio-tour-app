/**
 * TASK-401 - EBU R128 loudness normalization, done properly.
 *
 * THE ONE THING THAT MATTERS IN THIS FILE
 *
 * `loudnorm` has two completely different behaviours, and the difference
 * between them is the difference between a normalised track and a mangled one.
 *
 *   SINGLE PASS - the filter has not heard the file yet, so it works from a
 *   short lookahead window and adapts gain as it goes. That is a slow
 *   compressor. On speech it pumps: room tone swells in the gaps between
 *   sentences, and a loud gesture pulls the following words down. It also
 *   misses the target, typically by ~1 LU, because gating decisions made
 *   streaming cannot match gating decisions made over the whole programme.
 *
 *   TWO PASS - measure the whole file first, hand the measurements back to the
 *   filter, and it applies ONE STATIC GAIN. Nothing is compressed, nothing
 *   pumps, the dynamics of the performance survive intact, and the result lands
 *   on target to within hundredths of a LU.
 *
 * Two-pass costs one extra decode - about a second for a three-minute
 * narration - and it is the entire reason this pipeline exists rather than a
 * one-line ffmpeg invocation.
 *
 * THE SECOND THING THAT MATTERS
 *
 * The pre-filters (high-pass, mono downmix) MUST be identical in both passes.
 * Measuring the raw stereo file and then normalising a high-passed mono downmix
 * applies a gain computed for a different signal. It is a subtle, plausible-
 * looking bug - everything runs, nothing errors, tracks land a fraction of a LU
 * off and nobody can say why - so the chain is built once, here, and both
 * passes are handed the same array.
 */

import { MediaPipelineError } from './errors.ts';
import { runFfmpeg } from './ffmpeg.ts';
import type { AudioPreset } from './presets.ts';

/** Values loudnorm reports for the signal it was given, all in LUFS/dBTP/LU. */
export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDb: number;
  loudnessRangeLu: number;
  thresholdLufs: number;
  /**
   * loudnorm's own correction term. Passing it back in pass two is what makes
   * the result land on target rather than near it; dropping it is the most
   * common way a "two-pass" implementation quietly stays a one-pass one.
   */
  targetOffsetLu: number;
  /** Present on the second pass: "linear" or "dynamic". */
  normalizationType: string | null;
}

/**
 * Filters applied BEFORE loudnorm, in both passes.
 *
 * Order is deliberate. The high-pass runs first so the rumble it removes is not
 * part of what gets measured - low-frequency energy does influence the K-
 * weighted measurement, if less than mid energy does. The mono downmix is
 * expressed as a channel-count change on the output rather than a filter, so it
 * is `-ac` in the encode pass and `aformat` here; both produce the same signal
 * for measurement purposes.
 */
export function buildPreFilters(preset: AudioPreset): string[] {
  const filters: string[] = [];

  if (preset.highPassHz !== null) {
    filters.push(`highpass=f=${preset.highPassHz}`);
  }

  if (preset.channels === 1) {
    // Measure exactly what will be encoded. A stereo file whose channels
    // partially cancel measures louder before the downmix than after it.
    filters.push('aformat=channel_layouts=mono');
  }

  return filters;
}

/** The loudnorm filter string, for measurement (no measured values) or encode. */
export function buildLoudnormFilter(
  preset: AudioPreset,
  measured: LoudnessMeasurement | null,
): string {
  const parts = [
    `I=${preset.integratedLufs}`,
    `TP=${preset.truePeakDb}`,
    `LRA=${preset.loudnessRangeLu}`,
  ];

  if (measured !== null) {
    parts.push(
      `measured_I=${measured.integratedLufs}`,
      `measured_TP=${measured.truePeakDb}`,
      `measured_LRA=${measured.loudnessRangeLu}`,
      `measured_thresh=${measured.thresholdLufs}`,
      `offset=${measured.targetOffsetLu}`,
      // Ask for the static-gain path explicitly. loudnorm may still refuse it -
      // see describeNormalization() - but it must be requested to be granted.
      'linear=true',
    );
  }

  parts.push('print_format=json');

  return `loudnorm=${parts.join(':')}`;
}

/**
 * ffprobe-style numbers arrive as strings, and loudnorm emits "-inf" for a
 * silent programme. parseFloat turns that into NaN, which then propagates into
 * the filter string as `measured_I=NaN` and produces a baffling ffmpeg error
 * several seconds later. Catch it here where we can say what actually happened.
 */
function parseMeasurement(raw: unknown, key: string): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  if (typeof raw === 'string') {
    if (/^-?inf$/i.test(raw.trim())) {
      throw new MediaPipelineError(
        'source_silent',
        'The recording is silent, or too quiet for EBU R128 to measure.',
        { detail: `loudnorm reported ${key}=${raw}` },
      );
    }

    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }

  throw new MediaPipelineError(
    'measurement_unparsable',
    `loudnorm reported an unusable value for ${key}.`,
    { detail: String(raw) },
  );
}

/**
 * Pull loudnorm's JSON block out of stderr.
 *
 * It is printed last, after every warning ffmpeg felt like emitting, and it is
 * a flat object - no nesting - so the final brace pair delimits it exactly.
 */
function extractJson(stderr: string): Record<string, unknown> {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');

  if (start === -1 || end === -1 || end < start) {
    throw new MediaPipelineError(
      'measurement_unparsable',
      'loudnorm did not print a measurement block.',
      { detail: stderr.slice(-2000) },
    );
  }

  try {
    return JSON.parse(stderr.slice(start, end + 1)) as Record<string, unknown>;
  } catch (cause) {
    throw new MediaPipelineError(
      'measurement_unparsable',
      'loudnorm printed a measurement block that was not valid JSON.',
      { detail: stderr.slice(start, end + 1).slice(0, 1000), cause },
    );
  }
}

function toMeasurement(json: Record<string, unknown>, prefix: 'input' | 'output'): LoudnessMeasurement {
  const normalizationType = json['normalization_type'];

  return {
    integratedLufs: parseMeasurement(json[`${prefix}_i`], `${prefix}_i`),
    truePeakDb: parseMeasurement(json[`${prefix}_tp`], `${prefix}_tp`),
    loudnessRangeLu: parseMeasurement(json[`${prefix}_lra`], `${prefix}_lra`),
    thresholdLufs: parseMeasurement(json[`${prefix}_thresh`], `${prefix}_thresh`),
    // target_offset is only meaningful for the input measurement; the verify
    // pass has no use for it and reports 0.
    targetOffsetLu:
      prefix === 'input' ? parseMeasurement(json['target_offset'] ?? 0, 'target_offset') : 0,
    normalizationType: typeof normalizationType === 'string' ? normalizationType : null,
  };
}

/**
 * PASS 1 - analyse, decode only, produce no file.
 *
 * `-f null -` sends the decoded stream to the null muxer: the file is fully
 * decoded and filtered, so the measurement is real, but nothing is written and
 * nothing is encoded.
 */
export async function measureLoudness(
  input: string,
  preset: AudioPreset,
  options: { timeoutMs?: number } = {},
): Promise<LoudnessMeasurement> {
  const chain = [...buildPreFilters(preset), buildLoudnormFilter(preset, null)].join(',');

  const { stderr } = await runFfmpeg(
    [
      '-i',
      input,
      // First audio stream only. Album art is a video stream and would
      // otherwise make ffmpeg complain about a filtergraph it cannot wire up.
      '-map',
      '0:a:0',
      '-af',
      chain,
      '-f',
      'null',
      '-',
    ],
    options,
  );

  return toMeasurement(extractJson(stderr), 'input');
}

/**
 * PASS 3 - re-measure the ENCODED file.
 *
 * This is the check that makes `audio_tracks.lufs_normalization = -16` a fact
 * rather than an intention. It has to run on the encoded artifact and not on
 * the filter graph's prediction, because the AAC encoder is between the two:
 * quantisation moves the true peak, and on a very dense mix it can nudge the
 * integrated value as well.
 *
 * No pre-filters here on purpose. The encoded file is already mono and already
 * high-passed; re-applying the chain would measure a signal nobody will ever
 * hear.
 */
export async function verifyEncodedLoudness(
  file: string,
  preset: AudioPreset,
  options: { timeoutMs?: number } = {},
): Promise<LoudnessMeasurement> {
  const { stderr } = await runFfmpeg(
    [
      '-i',
      file,
      '-map',
      '0:a:0',
      '-af',
      buildLoudnormFilter(preset, null),
      '-f',
      'null',
      '-',
    ],
    options,
  );

  return toMeasurement(extractJson(stderr), 'input');
}

/**
 * Did loudnorm actually give us the static gain we asked for?
 *
 * `linear=true` is a REQUEST, not a guarantee. loudnorm silently downgrades to
 * dynamic mode when the gain needed to hit the target would push the true peak
 * past TP - which happens on recordings that are quiet overall but have one
 * loud transient, a door slam or a clipped consonant. The output is then
 * compressed rather than gained, and nothing in the exit code says so.
 *
 * The right answer is not to fail the upload: the file is still on target and
 * still perfectly listenable. It is to say so, so that a track which sounds
 * squashed has a recorded reason rather than a mystery.
 */
export function describeNormalization(normalizationType: string | null): string | null {
  if (normalizationType === null) return null;
  if (normalizationType === 'linear') return null;

  return (
    `loudnorm fell back to ${normalizationType} normalization instead of a single ` +
    'static gain, which means the source has a transient loud enough that the required gain ' +
    'would have breached the true-peak ceiling. The track is on target but its dynamics have ' +
    'been compressed. Consider de-clicking or re-recording the loud moment.'
  );
}

/**
 * Read `normalization_type` out of the ENCODE pass's stderr.
 *
 * It is reported only by the run that actually normalises - the analysis pass
 * has not decided anything yet - so this reads the second pass's output rather
 * than the measurement's. Deliberately non-throwing: an encode that produced a
 * good file must not fail because its log was shaped unexpectedly.
 */
export function readNormalizationType(stderr: string): string | null {
  try {
    const value = extractJson(stderr)['normalization_type'];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
