/**
 * TASK-401 - the mastering preset, and the reasoning behind every number in it.
 *
 * These values are the difference between "it plays" and "it sounds like a
 * radio production", so none of them is arbitrary and none should be changed
 * without reading why it is what it is.
 */

export interface AudioPreset {
  /** EBU R128 integrated loudness target, LUFS. */
  integratedLufs: number;
  /** Maximum true peak, dBTP. */
  truePeakDb: number;
  /** Loudness range target, LU. Only applied if loudnorm falls back to dynamic. */
  loudnessRangeLu: number;
  /** Output sample rate. MUST be set explicitly - see the note below. */
  sampleRateHz: number;
  /** 1 = mono downmix. */
  channels: number;
  /** AAC-LC bitrate. */
  bitrateKbps: number;
  /** High-pass corner for rumble removal, or null to leave the source alone. */
  highPassHz: number | null;
  /** How far the ENCODED file may sit from `integratedLufs` before we reject it. */
  toleranceLu: number;
  /** Ceiling for the re-measured true peak of the encoded file, dBTP. */
  truePeakCeilingDb: number;
  maxSourceDurationSeconds: number;
  maxSourceBytes: number;
  /** Must not exceed storage.buckets.file_size_limit for `audio-tracks`. */
  maxOutputBytes: number;
}

/**
 * The house sound for outdoor waypoint narration.
 *
 * -16 LUFS integrated
 *   The brief, and the right number for this product. Broadcast sits at -23
 *   LUFS (EBU R128) and music streaming around -14; -16 is the mobile/podcast
 *   convention, and it is what `audio_tracks.lufs_normalization` has recorded
 *   as the intent since the very first migration. On a phone speaker in a
 *   street, -23 is simply inaudible.
 *
 * -1.5 dBTP true peak
 *   NOT -1.0, and this is the detail that separates a clean master from a
 *   crackly one. Lossy encoding is not peak-preserving: the decoded AAC
 *   waveform is a reconstruction and routinely overshoots the source by
 *   0.5-1 dB. Normalising to -1.0 dBTP and then encoding can therefore hand
 *   the DAC inter-sample peaks above 0 dBFS, which clips in the analogue stage
 *   on exactly the cheap hardware our listeners are using. -1.5 dBTP buys the
 *   headroom back and costs nothing audible at -16 LUFS.
 *
 * LRA 7 LU
 *   The EBU default is 11, which is right for drama and wrong for a person
 *   talking outdoors next to traffic. A narrower range keeps the quiet ends of
 *   sentences above the noise floor of a city street.
 *
 *   Note this value usually does NOTHING: in linear mode loudnorm applies one
 *   static gain and leaves dynamics untouched. It takes effect only if the
 *   linear pass has to fall back to dynamic - see loudness.ts.
 *
 * 48 kHz, EXPLICITLY
 *   loudnorm runs its measurement at 192 kHz internally and will happily hand
 *   the encoder a 192 kHz stream if no output rate is set. That is a silent
 *   4x resample of every track, for nothing. Setting -ar is not optional.
 *
 * Mono
 *   Narration is one voice. A mono downmix halves the bundle - which is the
 *   number Screen 4's progress meter is counting down and the thing users wait
 *   on over cellular - and loses nothing, since nobody hears a stereo image
 *   through one earbud while walking. If a tour ever ships stereo field
 *   recordings, override `channels` for that track rather than changing this.
 *
 * 96 kbps AAC-LC
 *   Transparent for speech at mono/48k. 128 kbps is inaudibly better and 33%
 *   larger; 64 kbps starts to smear sibilants. At 96 kbps a 3-minute waypoint
 *   is about 2.2 MB, so a 10-stop tour lands near 22 MB - downloadable on hotel
 *   wifi before a walk, which is the actual product constraint.
 *
 * 80 Hz high-pass
 *   Handling noise, wind rumble and HVAC live below the voice. Removing them
 *   improves intelligibility on a small speaker AND frees bits the encoder
 *   spends better elsewhere. The male speaking fundamental starts around 85 Hz,
 *   so 80 Hz is under it.
 *
 * 1.0 LU tolerance
 *   Applied to the RE-MEASURED encoded file, not to the prediction. Linear
 *   normalisation is exact to within a few hundredths, so anything approaching
 *   1 LU means loudnorm fell back to dynamic mode or the encode moved the
 *   signal - both worth failing over rather than writing `lufs_normalization =
 *   -16` into a row that is not true.
 */
export const NARRATION_PRESET: AudioPreset = {
  integratedLufs: -16,
  truePeakDb: -1.5,
  loudnessRangeLu: 7,
  sampleRateHz: 48_000,
  channels: 1,
  bitrateKbps: 96,
  highPassHz: 80,
  toleranceLu: 1.0,
  truePeakCeilingDb: -1.0,
  maxSourceDurationSeconds: 60 * 60,
  maxSourceBytes: 500 * 1024 * 1024,
  // 50 MiB - storage.buckets.file_size_limit for audio-tracks, set by migration
  // 20260827160000. Rejecting here gives a real error message; letting Storage
  // reject it gives a 413 after the whole file has been uploaded.
  maxOutputBytes: 52_428_800,
};

/** A preset with selected fields overridden. Never mutate NARRATION_PRESET. */
export function withOverrides(preset: AudioPreset, overrides: Partial<AudioPreset>): AudioPreset {
  return { ...preset, ...overrides };
}
