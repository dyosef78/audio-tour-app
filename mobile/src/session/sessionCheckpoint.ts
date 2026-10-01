/**
 * The checkpoint's storage port and age limit, shared by the Epic 15 progress
 * repository (progressRepository.ts).
 *
 * Epic 13 introduced the checkpoint: the running tour, persisted so a process
 * Android killed mid-walk can pick it up again. Its v1 format (StopSequence's
 * order/passed) went with the strict sequence; v2 stores the engine's
 * Progress. What survives here is the part that was never about the format:
 *
 * SYNCHRONOUS, AND WHY NOT ASYNCSTORAGE: every AsyncStorage call is async, so a
 * kill between "stop reached" and the write landing loses the progress. It is
 * also one SQLite database capped at 6 MB on Android, shared with the auth
 * session. expo-file-system's File.write() and rename() are synchronous native
 * calls: when save() returns, the bytes are on disk.
 *
 * ATOMIC: a save writes a temp file, deletes the checkpoint, and renames the
 * temp into place. A kill at any point leaves one complete copy - the old
 * checkpoint, or the temp - and a load falls back to the temp.
 */

/**
 * A checkpoint older than this is discarded, not resumed. Measured from the
 * LAST progress change, so a long lunch on a full-day tour (480 min budget)
 * still resumes, while yesterday's abandoned tour does not come back.
 * PM-tunable.
 */
export const MAX_RESUME_AGE_MS = 12 * 60 * 60_000;

/**
 * Synchronous file operations. Every method may throw; callers decide. The
 * real one is sessionCheckpointFile.ts (expo-file-system); a replacement -
 * react-native-mmkv, if Android QA shows these writes stall the UI thread -
 * must stay synchronous (PM, Epic 15).
 */
export interface CheckpointIO {
  readMain(): string | null;
  readTemp(): string | null;
  writeTemp(text: string): void;
  /** Replace the checkpoint with the temp file (delete, then rename). */
  commitTemp(): void;
  /** Delete both files. */
  clear(): void;
}
