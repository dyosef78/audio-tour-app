/**
 * TASK-401 - public surface of the media pipeline.
 *
 * Import from here, not from the individual modules: the split between
 * loudness.ts, probe.ts and ffmpeg.ts is an implementation detail and is likely
 * to move when processing is lifted into a worker.
 *
 * Typical use from a CMS upload handler:
 *
 *   const queue = createProcessingQueue();
 *   ...
 *   const result = await queue.run(() =>
 *     processNarrationAudio(tempUploadPath, `${workDir}/wp01_jaffa_gate.m4a`),
 *   );
 *
 *   // 1. object first
 *   await supabase.storage.from('audio-tracks').upload(storagePath, file, {
 *     contentType: result.contentType,
 *   });
 *
 *   // 2. row second - never the other way round. See pipeline.ts.
 *   //    size_bytes / duration_seconds / format / lufs_normalization all come
 *   //    straight off `result`.
 */

export { MediaPipelineError, isMediaPipelineError } from './errors.ts';
export type { MediaErrorCode } from './errors.ts';

export { assertCapabilities, binaryPath, inspectCapabilities } from './ffmpeg.ts';
export type { FfmpegCapabilities } from './ffmpeg.ts';

export { isLossySource, probeAudio } from './probe.ts';
export type { ProbedAudio } from './probe.ts';

export { NARRATION_PRESET, withOverrides } from './presets.ts';
export type { AudioPreset } from './presets.ts';

export { processNarrationAudio } from './pipeline.ts';
export type { LoudnessReport, ProcessAudioOptions, ProcessedAudio } from './pipeline.ts';

export { createProcessingQueue, defaultConcurrency } from './queue.ts';
export type { ProcessingQueue } from './queue.ts';
