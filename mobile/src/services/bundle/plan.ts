import { transcriptPathFor } from '../../transcript/sidecar';
import type { WireBundle, WireMedia } from './types';

/**
 * Which files a bundle download must fetch (TASK-603).
 *
 * Pure, and separate from TourBundleRepository, so it runs in the Node harness
 * without expo-file-system: this is where a transcript or a Deep Dive gets
 * into a bundle or silently does not, and that deserves a test.
 */

export type PlannedFileKind = 'narration' | 'deep_dive' | 'transcript';

export interface PlannedFile {
  /** Bucket-relative; also the file's identity and its path inside the bundle. */
  storagePath: string;
  sizeBytes: number;
  kind: PlannedFileKind;
}

export interface BundlePlan {
  files: PlannedFile[];
  /** Transcript entries that were skipped, for the log. Never fatal. */
  warnings: string[];
}

export function planBundleFiles(bundle: WireBundle): BundlePlan {
  // Keyed by path. Two waypoints may share one recording, and two download
  // tasks writing the same destination at once corrupt it.
  const files = new Map<string, PlannedFile>();
  const warnings: string[] = [];

  const add = (file: PlannedFile): void => {
    if (!files.has(file.storagePath)) files.set(file.storagePath, file);
  };

  const addMedia = (
    media: WireMedia | null | undefined,
    kind: 'narration' | 'deep_dive',
    label: string,
  ): void => {
    if (!media) return;
    add({ storagePath: media.storage_path, sizeBytes: media.size_bytes, kind });

    const transcript = media.transcript;
    if (transcript == null) return;

    // A transcript is an accessibility extra, so a malformed entry is dropped
    // with a warning. Audio problems stay fatal - an unplayable stop is not.
    if (
      typeof transcript.storage_path !== 'string' ||
      typeof transcript.size_bytes !== 'number' ||
      !Number.isFinite(transcript.size_bytes) ||
      transcript.size_bytes <= 0
    ) {
      warnings.push(`${label}: malformed transcript entry skipped.`);
      return;
    }

    // The device finds transcripts by convention (TranscriptRepository), so a
    // file saved anywhere else would download successfully and never display.
    const expected = transcriptPathFor(media.storage_path);
    if (transcript.storage_path !== expected) {
      warnings.push(
        `${label}: transcript ${transcript.storage_path} is not the sidecar of ` +
          `${media.storage_path} (expected ${expected ?? 'none'}); skipped.`,
      );
      return;
    }

    add({ storagePath: transcript.storage_path, sizeBytes: transcript.size_bytes, kind: 'transcript' });
  };

  for (const w of bundle.waypoints) {
    addMedia(w.media, 'narration', w.name);
    // Eager, not on demand: a Deep Dive chosen mid-walk has no signal to
    // download over. The size cost is in the TASK-603 handover.
    addMedia(w.deep_dive, 'deep_dive', `${w.name} (Deep Dive)`);
  }

  return { files: [...files.values()], warnings };
}
