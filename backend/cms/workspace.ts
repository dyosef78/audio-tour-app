/**
 * TASK-402 - scratch space with cleanup that actually happens.
 *
 * Requirement 5 of the task: temporary raw and encoded files must be deleted
 * whether the upload succeeds or fails. The way that requirement is usually
 * missed is not carelessness - it is an early `return`, or a `throw` from the
 * middle of a function whose `unlink` sits at the bottom. So the lifetime is
 * expressed as a scope rather than as a pair of calls a future edit can
 * separate:
 *
 *     await withWorkspace(async (ws) => { ... });   // dir dies with the scope
 *
 * There is no `createWorkspace()` returning a directory the caller must
 * remember to destroy, because that is the API that leaks.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Workspace {
  /** Absolute path of this run's private directory. */
  readonly dir: string;
  /** Absolute path for a file inside it. The name is ours, never the caller's. */
  file: (name: string) => string;
}

export interface WorkspaceOptions {
  /**
   * Called when the directory could not be removed. Default logs a warning.
   *
   * A cleanup failure must never become the error the caller sees: it would
   * mask the real one, and it would turn a successful upload into a reported
   * failure. It still has to be visible, because silently leaking temp files is
   * how a box fills its disk over a quiet month.
   */
  onCleanupFailure?: (dir: string, error: unknown) => void;
}

function warn(dir: string, error: unknown): void {
  console.warn(
    `[cms] could not remove workspace ${dir}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Run `fn` with a private temp directory that is removed afterwards, always.
 *
 * `mkdtemp` rather than a name built from a request id or a waypoint uuid: it
 * is atomic and collision-free, so two concurrent uploads of the same waypoint
 * cannot land in the same directory and overwrite each other's intermediates.
 */
export async function withWorkspace<T>(
  fn: (workspace: Workspace) => Promise<T>,
  options: WorkspaceOptions = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'audio-tour-ingest-'));

  const workspace: Workspace = {
    dir,
    file: (name: string) => join(dir, name),
  };

  try {
    return await fn(workspace);
  } finally {
    try {
      // maxRetries is for Windows: a handle from the ffmpeg child can outlive
      // the process by a few milliseconds, and the first unlink then fails with
      // EBUSY on a directory that is about to be perfectly removable.
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      (options.onCleanupFailure ?? warn)(dir, error);
    }
  }
}

/**
 * Delete one file, best effort.
 *
 * For the caller's own upload temp file, which lives outside the workspace and
 * is therefore not covered by the scope above.
 */
export async function removeQuietly(
  path: string,
  onFailure: (path: string, error: unknown) => void = warn,
): Promise<void> {
  try {
    await rm(path, { force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    onFailure(path, error);
  }
}
