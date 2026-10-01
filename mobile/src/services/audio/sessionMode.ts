import type { TransitMode } from '../../types/domain.ts';

/**
 * Which expo-audio interruptionMode a chapter runs under (PM, Epic 15).
 *
 *   iOS, every mode       'doNotMix'. Lock-screen controls are non-negotiable
 *                         while driving (a driver must pause without unlocking),
 *                         and only a non-mixable session gets Now Playing. A
 *                         Google Maps prompt may therefore pause the narration;
 *                         the engine models that (AUDIO_INTERRUPTED/RESUMED,
 *                         watchdog).
 *   Android, driving      'duckOthers'. On AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK
 *                         (a navigation prompt) expo-audio lowers OUR volume to
 *                         50% and keeps playing; in every other mode it pauses
 *                         (AudioModule.kt, audioFocusChangeListener).
 *   Android, otherwise    'doNotMix' (TASK-104).
 *
 * THE ANDROID FALLBACK. expo-audio's docs say setActiveForLockScreen needs
 * 'doNotMix', without which Android stops background audio after ~3 minutes.
 * Its source does not enforce that, so device QA decides. If QA shows the
 * cut-off, set this to 'doNotMix' - one line, nothing else changes.
 *
 * Biking is NOT given duckOthers: the PM directive names driving only.
 */
export const ANDROID_DRIVING_INTERRUPTION_MODE: 'duckOthers' | 'doNotMix' = 'duckOthers';

export type SessionInterruptionMode = 'doNotMix' | 'duckOthers';

export function interruptionModeFor(platform: string, mode: TransitMode): SessionInterruptionMode {
  if (platform === 'android' && mode === 'driving') return ANDROID_DRIVING_INTERRUPTION_MODE;
  return 'doNotMix';
}
