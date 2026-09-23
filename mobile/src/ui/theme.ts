/**
 * Shared tokens for the Epic 6 surfaces (onboarding, player sheet).
 *
 * Lifted from the palette the existing screens already use inline, so the new
 * UI matches rather than restyles the app. app.json pins the light interface
 * style; the player is dark on purpose, as it floats over the map.
 */
export const colors = {
  ink: '#1C1C1E',
  inkMuted: '#6E6E73',
  /**
   * Secondary text that can sit on a TINTED fill (a selected card or bubble).
   * inkMuted clears AA on white but falls to ~4.3:1 on accentSoft and the
   * interest tints; test:ui checks this one against all of them (TASK-1101).
   */
  inkSecondary: '#636366',
  canvas: '#FFFFFF',
  surface: '#F5F5F7',
  hairline: '#D1D1D6',
  accent: '#0C6C6A',
  accentSoft: '#E3F1F0',
  live: '#34C759',
  danger: '#FF6B57',
  /**
   * Destructive TEXT on light surfaces (TASK-1104). `danger` is 2.8:1 on white,
   * fine on the dark player sheet but below AA as text here. test:ui checks it.
   */
  dangerInk: '#C62F1E',

  sheet: '#1C1C1E',
  sheetRaised: '#2C2C2E',
  onSheet: '#FFFFFF',
  onSheetMuted: '#AEAEB2',
  onSheetFaint: '#6E6E73',
  sheetError: '#FF9F8A',
} as const;

/** Below 44 pt a control fails the platform touch-target guidance. */
export const MIN_TOUCH = 44;
