/**
 * TASK-401 - ffmpeg / ffprobe process layer.
 *
 * Everything that actually spawns a binary goes through here, so the rest of
 * the pipeline deals in arguments and strings and never in child processes.
 *
 * WHY execFile AND NOT fluent-ffmpeg
 *
 * `fluent-ffmpeg` is the obvious dependency and the wrong one for this job. It
 * has been effectively unmaintained for years, it builds the command line for
 * you - which is precisely the part we need to be able to read, review and
 * reproduce by hand when a track comes out 2 LU hot - and it swallows stderr,
 * which is where loudnorm prints its measurements. We would be adding a
 * dependency in order to work around it.
 *
 * `execFile` with an ARGUMENT ARRAY also closes the injection question by
 * construction. No shell is involved, so a narration file named
 * `intro"; rm -rf /.wav` is just an awkward filename. Anything that built a
 * command STRING - including a naive `exec` - would have to get quoting right
 * on both cmd.exe and sh, and CMS uploads are attacker-influenced input.
 *
 * WHERE THE BINARY COMES FROM  (D3, decided 28 Aug 2026)
 *
 *   1. FFMPEG_PATH / FFPROBE_PATH   - explicit, and it wins. This is how the
 *                                     container image and CI point at a
 *                                     known-good system build.
 *   2. `ffmpeg` / `ffprobe` on PATH - the developer-laptop case.
 *
 * Two steps, and deliberately no third. An earlier draft also probed for the
 * bundled-binary npm packages; that was withdrawn when the team chose a
 * system-level ffmpeg. A silent third source is exactly what makes "which build
 * actually ran" unanswerable - a bundled binary that quietly wins over the
 * system one gives you a different encoder set and a different loudnorm version
 * from production, while every log line looks identical.
 *
 * So if a laptop has no ffmpeg on PATH, the fix is to say which one to use:
 *
 *   FFMPEG_PATH=/path/to/ffmpeg FFPROBE_PATH=/path/to/ffprobe npm run media:doctor
 *
 * `media:doctor` prints the resolved path, so the answer is one command away
 * rather than a matter of inference.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MediaPipelineError } from './errors.ts';

const execFileAsync = promisify(execFile);

export type BinaryKind = 'ffmpeg' | 'ffprobe';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /**
   * Hard wall-clock limit. ffmpeg on a malformed file can spin indefinitely,
   * and an HTTP handler holding a wedged child process is how a CMS falls over.
   */
  timeoutMs?: number;
}

/** Ten minutes. Generous for a narration track, fatal for a wedged process. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * loudnorm's JSON, the filter list and the encoder list all arrive on stderr or
 * stdout as plain text. 16 MB is far more than any of them produce and still
 * bounded, which the default 1 MB is not enough for on a verbose build.
 */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const resolved = new Map<BinaryKind, string>();

/**
 * Resolve a binary once and prove it runs.
 *
 * The `-version` probe is not ceremony. FFMPEG_PATH can point at a file that
 * exists but is the wrong architecture, and PATH can hold a wrapper script that
 * resolves but cannot execute. Both fail here, naming the candidate that was
 * tried, instead of forty seconds into somebody's upload.
 */
async function resolveBinary(kind: BinaryKind): Promise<string> {
  const cached = resolved.get(kind);
  if (cached !== undefined) return cached;

  const envVar = kind === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const explicit = process.env[envVar];

  // Explicit first, then the bare name so the OS searches PATH.
  const candidates: string[] = explicit ? [explicit, kind] : [kind];

  const attempts: string[] = [];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['-version'], {
        timeout: 30_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      resolved.set(kind, candidate);
      return candidate;
    } catch (error) {
      attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new MediaPipelineError(
    'ffmpeg_missing',
    `Could not run ${kind}. Set ${envVar} to an absolute path, or put ${kind} on PATH.`,
    { detail: attempts.join('\n') },
  );
}

/** The path actually in use, for logging and for the doctor command. */
export async function binaryPath(kind: BinaryKind): Promise<string> {
  return resolveBinary(kind);
}

/**
 * Forget cached resolutions. Only useful in tests that manipulate env vars.
 */
export function resetBinaryCache(): void {
  resolved.clear();
}

async function run(
  kind: BinaryKind,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const bin = await resolveBinary(kind);

  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      // ffmpeg ignores SIGTERM while inside some demuxers. A timeout that does
      // not actually kill the process is worse than no timeout, because the
      // caller believes it has recovered.
      killSignal: 'SIGKILL',
    });
    return { stdout, stderr };
  } catch (error) {
    // execFile rejects with an Error carrying whatever the child had written.
    // That tail is the only useful diagnostic ffmpeg produces, so it is kept
    // rather than replaced with a generic message.
    const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
      ? (error as { stderr: string }).stderr
      : '';

    throw new MediaPipelineError('ffmpeg_failed', `${kind} exited non-zero.`, {
      detail: tail(stderr, 4000) || (error instanceof Error ? error.message : String(error)),
      cause: error,
    });
  }
}

export function runFfmpeg(args: readonly string[], options?: RunOptions): Promise<RunResult> {
  // -nostdin: without it ffmpeg competes for the parent's stdin and can block
  // forever when run from a server process that never closes it.
  // -hide_banner: keeps the build blurb out of the stderr we have to parse.
  return run('ffmpeg', ['-nostdin', '-hide_banner', ...args], options);
}

export function runFfprobe(args: readonly string[], options?: RunOptions): Promise<RunResult> {
  return run('ffprobe', ['-hide_banner', ...args], options);
}

export interface FfmpegCapabilities {
  ffmpegPath: string;
  ffprobePath: string;
  version: string;
  /** EBU R128 normalization. Absent from some minimal/embedded builds. */
  hasLoudnorm: boolean;
  /** The native AAC-LC encoder. This is the one we target - see presets.ts. */
  hasAacEncoder: boolean;
}

/**
 * Inspect the resolved build.
 *
 * Worth a dedicated call because both missing features fail LATE and unhelpfully
 * otherwise: no `loudnorm` surfaces as "No such filter" partway through an
 * upload, and no `aac` encoder as "Unknown encoder" after the analysis pass has
 * already burned the CPU.
 */
export async function inspectCapabilities(): Promise<FfmpegCapabilities> {
  const [ffmpegPath, ffprobePath] = await Promise.all([
    resolveBinary('ffmpeg'),
    resolveBinary('ffprobe'),
  ]);

  const versionResult = await runFfmpeg(['-version']);
  const version = (versionResult.stdout.split('\n')[0] ?? '').trim();

  const filters = await runFfmpeg(['-filters']);
  const encoders = await runFfmpeg(['-encoders']);

  return {
    ffmpegPath,
    ffprobePath,
    version,
    hasLoudnorm: /(^|\s)loudnorm(\s|$)/m.test(filters.stdout),
    // Encoder lines look like: " A....D aac    AAC (Advanced Audio Coding)".
    hasAacEncoder: /^\s*A\S*\s+aac\s/m.test(encoders.stdout),
  };
}

/** Throw unless the resolved build can do the two things this pipeline needs. */
export async function assertCapabilities(): Promise<FfmpegCapabilities> {
  const caps = await inspectCapabilities();

  const missing: string[] = [];
  if (!caps.hasLoudnorm) missing.push('the loudnorm filter (EBU R128)');
  if (!caps.hasAacEncoder) missing.push('the aac encoder');

  if (missing.length > 0) {
    throw new MediaPipelineError(
      'ffmpeg_capability_missing',
      `${caps.ffmpegPath} is missing ${missing.join(' and ')}. Install a full ffmpeg build.`,
      { detail: caps.version },
    );
  }

  return caps;
}

/** Last n characters, for error details that must stay bounded. */
export function tail(text: string, n: number): string {
  return text.length <= n ? text : `...${text.slice(-n)}`;
}
