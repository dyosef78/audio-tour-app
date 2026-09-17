import type { Interest } from '../personalization/options';

/**
 * Per-interest colours for the Interests bubbles (TASK-1101).
 *
 * `strong` is used as text on `soft` (selected bubble), as text on white (the
 * highlight chips) and behind a white tick, so it must clear WCAG AA 4.5:1
 * against both. `npm run test:ui` computes the ratios; change a value and it
 * tells you.
 */
export const INTEREST_TINTS: Record<Interest, { soft: string; strong: string }> = {
  culinary: { soft: '#FDEBDD', strong: '#A3461A' },
  history: { soft: '#F4ECDD', strong: '#7D5A1C' },
  art_culture: { soft: '#F4E6F2', strong: '#833A7B' },
  nature: { soft: '#E3F2E6', strong: '#2A6E3E' },
  architecture: { soft: '#E6EDF6', strong: '#355784' },
};

/** WCAG 2.x contrast ratio between two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const channel = (i: number): number => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
