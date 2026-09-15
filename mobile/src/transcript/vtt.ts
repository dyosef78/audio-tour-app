/**
 * WebVTT parsing and cue lookup for the karaoke transcript (TASK-602).
 *
 * Pure TypeScript with no React Native import, so the Node harness can exercise
 * it directly (npm run test:ui).
 *
 * Deliberately a SUBSET of WebVTT. Narration transcripts are sentence cues and
 * nothing else, so STYLE, REGION and cue settings (position, line, align) are
 * read past rather than honoured - the player lays text out itself. What is
 * handled carefully is the part that decides whether highlighting is correct:
 * timestamps, cue ordering, and stripping inline markup out of the text.
 */

export interface Cue {
  /** Seconds from the start of the track. */
  start: number;
  end: number;
  /** Plain text: inline tags stripped, entities decoded, lines joined. */
  text: string;
}

export interface ParsedVtt {
  cues: Cue[];
  /** Cue blocks that were present but unusable (bad timing, empty text). */
  skipped: number;
}

export class VttParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VttParseError';
  }
}

/** `hh:mm:ss.ttt` or `mm:ss.ttt`. Hours may exceed two digits per the spec. */
const TIMESTAMP = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;

function parseTimestamp(raw: string): number | null {
  const m = TIMESTAMP.exec(raw.trim());
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms) / 1000;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&lrm;': '‎',
  '&rlm;': '‏',
};

/**
 * Cue payload -> display text.
 *
 * Tags go before entities: decoding first would turn an escaped `&lt;b&gt;`
 * into a real-looking tag and then strip words the author meant to show.
 */
function cleanText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a WebVTT document.
 *
 * Throws only when the file is not WebVTT at all - the realistic cause is an
 * HTML error page or an audio file saved under a `.vtt` name, and rendering
 * that as a transcript would be worse than rendering none. A single malformed
 * cue is skipped and counted instead, so one typo cannot blank a whole stop.
 */
export function parseVtt(source: string): ParsedVtt {
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  // The signature must be exactly "WEBVTT", optionally followed by a space or
  // tab and a header comment.
  if (!/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/.test(text)) {
    throw new VttParseError('Not a WebVTT file: missing the WEBVTT signature.');
  }

  const blocks = text.split(/\n{2,}/).slice(1);
  const cues: Cue[] = [];
  let skipped = 0;

  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, all) => !(l === '' && i === all.length - 1));
    if (lines.length === 0) continue;

    const head = lines[0] ?? '';
    if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(head)) continue;

    // The identifier line is optional; the timing line is whichever of the
    // first two contains the arrow.
    const timingAt = head.includes('-->') ? 0 : 1;
    const timing = lines[timingAt];
    if (timing === undefined || !timing.includes('-->')) {
      skipped++;
      continue;
    }

    const [startRaw = '', rest = ''] = timing.split('-->');
    // Anything after the end timestamp is cue settings, which we ignore.
    const endRaw = rest.trim().split(/[ \t]+/)[0] ?? '';
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    const cueText = cleanText(lines.slice(timingAt + 1));

    if (start === null || end === null || end <= start || cueText === '') {
      skipped++;
      continue;
    }

    cues.push({ start, end, text: cueText });
  }

  // Stable sort: the spec requires ascending start times, but hand-edited
  // files break that, and cueIndexAt's binary search depends on it.
  cues.sort((a, b) => a.start - b.start);

  return { cues, skipped };
}

/**
 * Index of the cue to highlight at `seconds`: the last cue that has started.
 *
 * Returns -1 only before the first cue. Inside the silence BETWEEN two
 * sentences it stays on the previous one rather than dropping the highlight -
 * a transcript that blinks off at every full stop is harder to follow, which
 * matters most to the people relying on it.
 */
export function cueIndexAt(cues: readonly Cue[], seconds: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((cues[mid] as Cue).start <= seconds) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

const RTL_STRONG = /[֐-׿؀-ۿݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_STRONG = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;

/**
 * Whether a cue reads right-to-left, by its first strongly-directional letter.
 *
 * Needed per cue rather than per app: the Tel Aviv QA narration is Hebrew
 * while the UI chrome is English, and I18nManager is app-wide. A Hebrew line
 * that opens with a number or an English name ("Dubnov 8") must still align
 * right, which is why digits and punctuation are skipped.
 */
export function isRtlText(text: string): boolean {
  for (const ch of text) {
    if (RTL_STRONG.test(ch)) return true;
    if (LTR_STRONG.test(ch)) return false;
  }
  return false;
}
