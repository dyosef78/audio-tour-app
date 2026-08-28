/**
 * TASK-401 - CLI for the audio pipeline.
 *
 * Two jobs:
 *
 *   doctor   - which ffmpeg am I actually using, and can it do this work?
 *   process  - normalise and encode one file, and print the row it implies
 *
 * `doctor` exists because every ffmpeg problem this project will ever have is
 * really the question "which binary ran". A developer laptop, a CI runner and a
 * production container routinely resolve three different builds with three
 * different encoder sets, and the symptom is always a filter that "does not
 * exist" halfway through someone's upload.
 *
 * Usage:
 *   npm run media:doctor
 *   npm run media:process -- <input> <output.m4a> [options]
 *
 * Options:
 *   --json          machine-readable result on stdout, nothing else
 *   --no-verify     skip the re-measurement pass (not for the upload path)
 *   --bitrate <k>   override the AAC bitrate in kbps
 *   --stereo        keep two channels instead of the mono downmix
 *   --lufs <n>      override the integrated target (default -16)
 */

import {
  MediaPipelineError,
  NARRATION_PRESET,
  inspectCapabilities,
  processNarrationAudio,
  withOverrides,
  type AudioPreset,
} from '../media/index.ts';

interface ParsedArgs {
  command: 'doctor' | 'process';
  input: string | null;
  output: string | null;
  json: boolean;
  verify: boolean;
  preset: AudioPreset;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let json = false;
  let verify = true;
  const overrides: Partial<AudioPreset> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--no-verify':
        verify = false;
        break;
      case '--stereo':
        overrides.channels = 2;
        break;
      case '--bitrate': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value) || value <= 0) fail('--bitrate needs a positive number of kbps.');
        overrides.bitrateKbps = value;
        break;
      }
      case '--lufs': {
        const value = Number(argv[++i]);
        if (!Number.isFinite(value)) fail('--lufs needs a number, e.g. -16.');
        overrides.integratedLufs = value;
        break;
      }
      default:
        if (arg === undefined) break;
        if (arg.startsWith('--')) fail(`Unknown option ${arg}.`);
        positional.push(arg);
    }
  }

  const first = positional[0];

  if (first === 'doctor') {
    return {
      command: 'doctor',
      input: null,
      output: null,
      json,
      verify,
      preset: NARRATION_PRESET,
    };
  }

  return {
    command: 'process',
    input: first ?? null,
    output: positional[1] ?? null,
    json,
    verify,
    preset: withOverrides(NARRATION_PRESET, overrides),
  };
}

async function doctor(json: boolean): Promise<number> {
  const caps = await inspectCapabilities();

  if (json) {
    console.log(JSON.stringify(caps, null, 2));
  } else {
    console.log('ffmpeg build in use\n');
    console.log(`  ffmpeg    ${caps.ffmpegPath}`);
    console.log(`  ffprobe   ${caps.ffprobePath}`);
    console.log(`  version   ${caps.version}`);
    console.log(`  loudnorm  ${caps.hasLoudnorm ? 'yes' : 'NO - EBU R128 unavailable'}`);
    console.log(`  aac       ${caps.hasAacEncoder ? 'yes' : 'NO - cannot encode AAC-LC'}`);

    if (!caps.hasLoudnorm || !caps.hasAacEncoder) {
      console.log(
        '\nThis build cannot run the pipeline. Install a full ffmpeg and point FFMPEG_PATH at it.',
      );
    }
  }

  return caps.hasLoudnorm && caps.hasAacEncoder ? 0 : 1;
}

async function process_(args: ParsedArgs): Promise<number> {
  if (args.input === null || args.output === null) {
    fail('Usage: npm run media:process -- <input> <output.m4a> [--json] [--no-verify]');
  }

  const result = await processNarrationAudio(args.input, args.output, {
    preset: args.preset,
    verify: args.verify,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  const mib = (result.sizeBytes / 1_048_576).toFixed(2);

  console.log(`\n${args.input}\n  -> ${result.outputPath}\n`);

  console.log('Loudness');
  console.log(
    `  source    ${result.source.integratedLufs.toFixed(2)} LUFS  ` +
      `${result.source.truePeakDb.toFixed(2)} dBTP  ` +
      `LRA ${result.source.loudnessRangeLu.toFixed(1)} LU`,
  );
  console.log(
    `  encoded   ${result.encoded.integratedLufs.toFixed(2)} LUFS  ` +
      `${result.encoded.truePeakDb.toFixed(2)} dBTP  ` +
      `LRA ${result.encoded.loudnessRangeLu.toFixed(1)} LU` +
      `${args.verify ? '' : '   (predicted - verification skipped)'}`,
  );
  console.log(`  gain      ${result.normalizationType ?? 'unknown'}`);

  console.log('\nArtifact');
  console.log(`  ${mib} MiB, ${result.durationSecondsExact.toFixed(2)}s, AAC-LC in .m4a`);
  console.log(`  sha256 ${result.sha256}`);

  // The point of the whole exercise: the exact values that go in the row.
  console.log('\naudio_tracks columns');
  console.log(`  size_bytes         ${result.sizeBytes}`);
  console.log(`  duration_seconds   ${result.durationSeconds}`);
  console.log(`  format             ${result.format}`);
  console.log(`  lufs_normalization ${result.lufsNormalization}`);

  if (result.warnings.length > 0) {
    console.log('\nWarnings');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }

  return 0;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const code = args.command === 'doctor' ? await doctor(args.json) : await process_(args);
  process.exit(code);
}

main().catch((error: unknown) => {
  if (error instanceof MediaPipelineError) {
    // Coded errors get the operator-facing treatment: what went wrong, and the
    // detail that says what to do about it.
    console.error(`\n${error.code}: ${error.message}`);
    if (error.detail !== undefined) console.error(`\n${error.detail}`);
    process.exit(1);
  }

  console.error('\nUnexpected error:', error instanceof Error ? error.stack : error);
  process.exit(1);
});
