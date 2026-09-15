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
  canvas: '#FFFFFF',
  surface: '#F5F5F7',
  hairline: '#D1D1D6',
  accent: '#0C6C6A',
  accentSoft: '#E3F1F0',
  live: '#34C759',
  danger: '#FF6B57',

  sheet: '#1C1C1E',
  sheetRaised: '#2C2C2E',
  onSheet: '#FFFFFF',
  onSheetMuted: '#AEAEB2',
  onSheetFaint: '#6E6E73',
  sheetError: '#FF9F8A',
} as const;

/** Below 44 pt a control fails the platform touch-target guidance. */
export const MIN_TOUCH = 44;
