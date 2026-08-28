/**
 * TASK-401 - the audio processing pipeline.
 *
 * Raw upload in, a normalised AAC-LC `.m4a` plus the exact metadata the
 * database and the mobile downloader need, out.
 *
 * SHAPE OF THE RUN
 *
 *   1. probe      - is this even audio, and is it within the limits
 *   2. measure    - full-file EBU R128 analysis                    (decode)
 *   3. encode     - static-gain normalise + AAC-LC into .m4a       (decode+encode)
 *   4. verify     - re-measure the ENCODED file                    (decode)
 *   5. describe   - byte count, duration, hash, warnings
 *
 * Three decode passes over a three-minute narration costs a couple of seconds
 * on any machine that can also run a CMS. It buys a track that is exactly on
 * target, was not compressed to get there, and whose recorded loudness is a
 * measured fact rather than a hopeful constant.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not upload, and it does not touch the database. The caller owns that
 * order, and the order is load-bearing: upload first, and write the
 * `audio_tracks` row only once Storage has confirmed the object. A row written
 * first is a claim about a file that may never arrive, which is exactly the
 * drift `cms_validate_tour`'s `audio_object_missing` check exists to catch.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline as streamPipeline } from 'node:stream/promises';

import { MediaPipelineError } from './errors.ts';
import { runFfmpeg } from './ffmpeg.ts';
import {
  buildLoudnormFilter,
  buildPreFilters,
  describeNormalization,
  measureLoudness,
  readNormalizationType,
  verifyEncodedLoudness,
  type LoudnessMeasurement,
} from './loudness.ts';
import { NARRATION_PRESET, type AudioPreset } from './presets.ts';
import { isLossySource, probeAudio, type ProbedAudio } from './probe.ts';

export interface ProcessAudioOptions {
  preset?: AudioPreset;
  /**
   * Skip the verification pass. Saves one decode and gives up the only proof
   * that the track hit its target - so it exists for batch re-runs of material
   * already verified once, not for the upload path.
   */
  verify?: boolean;
  timeoutMs?: number;
}

export interface LoudnessReport {
  integratedLufs: number;
  truePeakDb: number;
  loudnessRangeLu: number;
}

export interface ProcessedAudio {
  outputPath: string;

  // --- the three columns audio_tracks needs -----------------------------------
  /**
   * `audio_tracks.size_bytes`. From fs.stat() on the artifact, so it is the
   * byte count of the exact file that will be uploaded - which matters because
   * DownloadManager compares it with `===` and fails the bundle otherwise.
   */
  sizeBytes: number;
  /**
   * `audio_tracks.duration_seconds`. Integer, never zero: the column is INT and
   * `audio_tracks_duration_positive_check` requires > 0, so a 400 ms sting
   * rounds up to 1 rather than violating the constraint.
   */
  durationSeconds: number;
  /** The unrounded figure, for anything that wants real precision. */
  durationSecondsExact: number;
  /** `audio_tracks.format`. Fixed - see the AAC-LC standard migration. */
  format: 'AAC';
  /** `audio_tracks.lufs_normalization`, measured rather than assumed. */
  lufsNormalization: number;

  // --- upload metadata --------------------------------------------------------
  /** Content-Type for the Storage upload; on the bucket's MIME allowlist. */
  contentType: 'audio/mp4';
  /** Hex SHA-256 of the artifact. Useful for content-addressed naming. */
  sha256: string;

  // --- provenance -------------------------------------------------------------
  source: LoudnessReport & { codec: string | null; channels: number | null; sampleRateHz: number | null };
  encoded: LoudnessReport;
  /** "linear" when the target was hit with a single static gain. */
  normalizationType: string | null;
  /** Non-fatal findings a human should see in the CMS. */
  warnings: string[];
}

function toReport(m: LoudnessMeasurement): LoudnessReport {
  return {
    integratedLufs: m.integratedLufs,
    truePeakDb: m.truePeakDb,
    loudnessRangeLu: m.loudnessRangeLu,
  };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await streamPipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Reject a destination the database would refuse anyway, before doing work. */
function assertOutputPath(outputPath: string): void {
  if (!/\.m4a$/i.test(outputPath)) {
    throw new MediaPipelineError(
      'invalid_output_path',
      `Output must be a .m4a file, got ${outputPath}.`,
      {
        detail:
          'audio_tracks_extension_matches_format_check binds format=AAC to a .m4a extension, ' +
          'because AVFoundation infers container format from the extension and AAC bytes named ' +
          'otherwise fail silently on iOS.',
      },
    );
  }
}

function assertWithinLimits(probed: ProbedAudio, preset: AudioPreset): void {
  if (probed.durationSeconds > preset.maxSourceDurationSeconds) {
    throw new MediaPipelineError(
      'source_too_long',
      `Recording is ${Math.round(probed.durationSeconds)}s; the limit is ` +
        `${preset.maxSourceDurationSeconds}s.`,
    );
  }

  if (probed.sizeBytes > preset.maxSourceBytes) {
    throw new MediaPipelineError(
      'source_too_large',
      `Upload is ${(probed.sizeBytes / 1_048_576).toFixed(1)} MiB; the limit is ` +
        `${(preset.maxSourceBytes / 1_048_576).toFixed(0)} MiB.`,
    );
  }
}

function collectSourceWarnings(probed: ProbedAudio, measured: LoudnessMeasurement): string[] {
  const warnings: string[] = [];

  if (isLossySource(probed)) {
    warnings.push(
      `Source is already lossy (${probed.codec}). Re-encoding to AAC is a second generation of ` +
        'loss, audible on sibilants before it shows on any meter. Ask the producer for the WAV ' +
        'or FLAC master where one exists.',
    );
  }

  if (measured.truePeakDb > 0) {
    warnings.push(
      `Source true peak is ${measured.truePeakDb.toFixed(1)} dBTP - it was already clipped ` +
        'before it reached us. Normalisation moves the level but cannot restore the flattened ' +
        'waveform; the distortion survives into the master.',
    );
  }

  if (measured.loudnessRangeLu > 12) {
    warnings.push(
      `Source loudness range is ${measured.loudnessRangeLu.toFixed(1)} LU, which is wide for one ` +
        'person talking. Usually means the mic distance moved during the take. A single gain ' +
        'cannot even that out, so quiet passages will still disappear under street noise.',
    );
  }

  if (probed.sampleRateHz !== null && probed.sampleRateHz < 32_000) {
    warnings.push(
      `Source is ${probed.sampleRateHz} Hz. It will be upsampled to ` +
        'the output rate, which changes nothing about the bandwidth that was actually captured.',
    );
  }

  return warnings;
}

/**
 * Normalise and encode one narration file.
 *
 * `outputPath` is required rather than defaulted to a temp file. The caller
 * always knows where it wants the artifact, and a pipeline that invents
 * temporary paths is a pipeline that leaks them the first time an upload throws
 * between processing and cleanup.
 */
export async function processNarrationAudio(
  sourcePath: string,
  outputPath: string,
  options: ProcessAudioOptions = {},
): Promise<ProcessedAudio> {
  const preset = options.preset ?? NARRATION_PRESET;
  const verify = options.verify ?? true;
  const timeoutMs = options.timeoutMs;

  assertOutputPath(outputPath);

  // --- 1. Is this audio, and is it sane? --------------------------------------
  const probed = await probeAudio(sourcePath);
  assertWithinLimits(probed, preset);

  // --- 2. Measure the whole programme -----------------------------------------
  const measured = await measureLoudness(sourcePath, preset, { timeoutMs });
  const warnings = collectSourceWarnings(probed, measured);

  // --- 3. Encode -------------------------------------------------------------
  // The SAME pre-filters as the measurement pass. See the header of loudness.ts
  // for why that is not a detail.
  const chain = [...buildPreFilters(preset), buildLoudnormFilter(preset, measured)].join(',');

  const encodeRun = await runFfmpeg(
    [
      '-y',
      '-i',
      sourcePath,
      // First audio stream only, and no video: cover art travels as an mjpeg
      // video stream and the mp4 muxer will happily carry it into the bundle
      // the user waits to download.
      '-map',
      '0:a:0',
      '-vn',
      '-af',
      chain,
      // MANDATORY. loudnorm measures at 192 kHz internally and will hand the
      // encoder a 192 kHz stream if no rate is named - a silent 4x resample of
      // every track in the catalogue, for nothing. See presets.ts.
      '-ar',
      String(preset.sampleRateHz),
      '-ac',
      String(preset.channels),
      '-c:a',
      'aac',
      // AAC-LC explicitly. HE-AAC is smaller at these bitrates but decodes to
      // silence on some older Android builds, and the schema says LC.
      '-profile:a',
      'aac_low',
      '-b:a',
      `${preset.bitrateKbps}k`,
      // Drop everything the source carried: producer names, source file paths,
      // recording software, cover art metadata. None of it belongs in a public
      // bucket, and stripping it also makes two encodes of one source compare
      // equal far more often.
      '-map_metadata',
      '-1',
      // Move the moov atom to the front. Cheap, and it means a track can be
      // played while it is still arriving - which offline playback does not
      // need today but a "preview in the CMS" button will want tomorrow.
      '-movflags',
      '+faststart',
      outputPath,
    ],
    { timeoutMs },
  );

  // --- 4. Describe the artifact ------------------------------------------------
  // Size from stat(), never from ffprobe metadata: this exact number goes into
  // audio_tracks.size_bytes and DownloadManager compares it with ===.
  const { size: sizeBytes } = await stat(outputPath);

  if (sizeBytes === 0) {
    throw new MediaPipelineError('output_invalid', 'ffmpeg exited cleanly but wrote an empty file.');
  }

  if (sizeBytes > preset.maxOutputBytes) {
    throw new MediaPipelineError(
      'output_too_large',
      `Encoded file is ${(sizeBytes / 1_048_576).toFixed(1)} MiB, over the ` +
        `${(preset.maxOutputBytes / 1_048_576).toFixed(0)} MiB bucket limit.`,
      { detail: 'Shorten the recording or lower the bitrate for this track.' },
    );
  }

  const encodedProbe = await probeAudio(outputPath);

  if (encodedProbe.codec !== 'aac') {
    throw new MediaPipelineError(
      'output_invalid',
      `Expected an aac stream, got ${encodedProbe.codec ?? 'nothing'}.`,
    );
  }

  // --- 5. Verify the target was actually hit ----------------------------------
  let encoded: LoudnessReport = {
    integratedLufs: preset.integratedLufs,
    truePeakDb: preset.truePeakDb,
    loudnessRangeLu: measured.loudnessRangeLu,
  };

  if (verify) {
    const remeasured = await verifyEncodedLoudness(outputPath, preset, { timeoutMs });
    encoded = toReport(remeasured);

    const drift = Math.abs(remeasured.integratedLufs - preset.integratedLufs);

    if (drift > preset.toleranceLu) {
      throw new MediaPipelineError(
        'loudness_out_of_tolerance',
        `Encoded track measured ${remeasured.integratedLufs.toFixed(2)} LUFS, ` +
          `${drift.toFixed(2)} LU from the ${preset.integratedLufs} LUFS target.`,
        {
          detail:
            'Refusing to record lufs_normalization = ' +
            `${preset.integratedLufs} for a file that is not at ${preset.integratedLufs}. ` +
            'A drift this large usually means the source is unusually dense or unusually short.',
        },
      );
    }

    // 0 dBTP is not a taste question - it clips the DAC. Between the ceiling
    // and 0 the risk is real but hardware-dependent, so it is a warning.
    if (remeasured.truePeakDb >= 0) {
      throw new MediaPipelineError(
        'loudness_out_of_tolerance',
        `Encoded true peak is ${remeasured.truePeakDb.toFixed(2)} dBTP, at or above full scale.`,
        { detail: 'This will clip on playback. Reduce the bitrate target or de-click the source.' },
      );
    }

    if (remeasured.truePeakDb > preset.truePeakCeilingDb) {
      warnings.push(
        `Encoded true peak is ${remeasured.truePeakDb.toFixed(2)} dBTP, above the ` +
          `${preset.truePeakCeilingDb} dBTP ceiling. AAC decoding overshoots the source waveform, ` +
          'so inter-sample peaks may clip on cheap DACs.',
      );
    }
  }

  // Only the encode pass knows which mode loudnorm settled on - the analysis
  // pass had not decided yet - so this reads that run's log, not the earlier one.
  const normalizationType = readNormalizationType(encodeRun.stderr);

  const fallbackNote = describeNormalization(normalizationType);
  if (fallbackNote !== null) warnings.push(fallbackNote);

  // Round up rather than to nearest at the bottom end: the column is INT with a
  // > 0 CHECK, so a 400 ms cue must not become 0 and fail the insert.
  const durationSeconds = Math.max(1, Math.round(encodedProbe.durationSeconds));

  return {
    outputPath,
    sizeBytes,
    durationSeconds,
    durationSecondsExact: encodedProbe.durationSeconds,
    format: 'AAC',
    lufsNormalization: preset.integratedLufs,
    contentType: 'audio/mp4',
    sha256: await sha256File(outputPath),
    source: {
      ...toReport(measured),
      codec: probed.codec,
      channels: probed.channels,
      sampleRateHz: probed.sampleRateHz,
    },
    encoded,
    normalizationType,
    warnings,
  };
}
