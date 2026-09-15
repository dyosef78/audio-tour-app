/**
 * TASK-603 - CMS contracts that span the database, the backend and the device.
 *
 * Every check here guards a string that three codebases must agree on, and
 * where disagreement fails silently:
 *
 *   storage paths      a Deep Dive named like its narration overwrites it
 *   transcript paths   a sidecar at the wrong name downloads and never displays
 *   tag vocabulary     a tag the database accepts but the app cannot label
 *   bundle signature   a hash that moves re-downloads every tour on every phone
 *   transcripts        a file the CMS accepts but the phone cannot parse
 *
 * The SQL side is read from the migration FILES rather than a database, so this
 * runs anywhere with Node and no credentials.
 *
 * Run:  npm run test:cms
 */

import { readFileSync } from 'node:fs';

import { CmsIngestError } from '../cms/errors.ts';
import { buildAudioStoragePath, transcriptPathFor } from '../cms/storage-path.ts';
import { MAX_TRANSCRIPT_BYTES, checkTranscript } from '../cms/transcript-ingest.ts';

let failures = 0;
let checks = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` - ${detail}` : ''}`);
}

function eq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, `got ${a}, expected ${e}`);
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

function throwsCode(label: string, code: string, fn: () => unknown): void {
  try {
    fn();
    assert(label, false, 'did not throw');
  } catch (error) {
    assert(label, error instanceof CmsIngestError && error.code === code, String(error));
  }
}

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, MIGRATIONS), 'utf8');

const schemaSql = read('20260915120000_track_kind_tags_transcripts.sql');
const functionsSql = read('20260915120100_bundle_and_cms_track_kind_tags.sql');
const previousBundleSql = read('20260828150000_bundle_audio_track_id.sql');

// -----------------------------------------------------------------------------

heading('Storage paths per track kind');

const TOUR = 'aaaaaaaa-0000-4000-8000-000000000001';
const base = { tourId: TOUR, sortOrder: 2, waypointName: 'Tower of David' };

const narration = buildAudioStoragePath(base);
const deepDive = buildAudioStoragePath({ ...base, trackKind: 'deep_dive' });

eq('narration path is unchanged from before TASK-603', narration, `tours/${TOUR}/wp02_tower_of_david.m4a`);
eq('deep dive path carries the kind segment', deepDive, `tours/${TOUR}/wp02_tower_of_david.deep_dive.m4a`);
eq(
  'content-addressed deep dive keeps kind before hash',
  buildAudioStoragePath({ ...base, trackKind: 'deep_dive', contentAddressed: true, sha256: 'abcdef1234' }),
  `tours/${TOUR}/wp02_tower_of_david.deep_dive.abcdef12.m4a`,
);
assert('narration and deep dive can never overwrite each other', narration !== deepDive);
assert(
  'nor can their transcripts',
  transcriptPathFor(narration) !== transcriptPathFor(deepDive) && transcriptPathFor(deepDive) !== null,
);
throwsCode('a misspelt kind is refused rather than meaning narration', 'invalid_request', () =>
  buildAudioStoragePath({ ...base, trackKind: 'deepdive' as never }),
);

// -----------------------------------------------------------------------------

heading('transcript_path_for (SQL) matches transcriptPathFor (TS)');

// Re-implements the SQL expression from its own literals, so a change to the
// regex or replacement in the migration is seen here.
const sqlFn = /WHEN p_storage_path ~\* '([^']+)'\s+THEN regexp_replace\(p_storage_path, '([^']+)', '([^']+)', 'i'\)/.exec(
  schemaSql,
);
assert('transcript_path_for found in the migration', sqlFn !== null);

if (sqlFn) {
  const [, testRe, replaceRe, replacement] = sqlFn as unknown as [string, string, string, string];
  const sql = (p: string): string | null =>
    new RegExp(testRe, 'i').test(p) ? p.replace(new RegExp(replaceRe, 'i'), replacement) : null;

  for (const p of [narration, deepDive, 'tours/x/B.MP3', 'a.M4a', 'a.opus', 'a.m4a.bak', 'noext', 'd.m4a/f']) {
    eq(`${p}`, transcriptPathFor(p), sql(p));
  }
}

// -----------------------------------------------------------------------------

heading('Tag vocabulary: database == app');

function sqlVocabulary(fn: string): string[] {
  const match = new RegExp(`FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?ARRAY\\[([^\\]]*)\\]`).exec(schemaSql);
  return match ? [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string) : [];
}

// Read as TEXT, like the SQL side, rather than imported. options.ts sits in the
// Expo app, which Node/tsc treat as CommonJS; importing it here would mean
// re-typing the app's persistence modules as ESM just to run this check.
const optionsSource = readFileSync(
  new URL('../../mobile/src/personalization/options.ts', import.meta.url),
  'utf8',
);

function appIds(constName: string): string[] {
  const block = new RegExp(`export const ${constName}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`).exec(optionsSource);
  return block ? [...(block[1] ?? '').matchAll(/\bid: '([^']+)'/g)].map((m) => m[1] as string) : [];
}

for (const [fn, constName] of [
  ['audience_tag_vocabulary', 'GROUP_TYPES'],
  ['interest_tag_vocabulary', 'INTERESTS'],
] as const) {
  const db = sqlVocabulary(fn).sort();
  const app = appIds(constName).sort();
  // Both non-empty first: two failed extractions would otherwise compare equal.
  assert(`${fn}() extracted from the migration`, db.length > 0);
  assert(`${constName} ids extracted from options.ts`, app.length > 0);
  eq(`${fn}() == ${constName} ids`, db, app);
}

// -----------------------------------------------------------------------------

heading('bundle_version_hash signature is extended, never altered');

const normalise = (sql: string): string => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
const oldSql = normalise(previousBundleSql);
const newSql = normalise(functionsSql);

const fieldsStart = oldSql.indexOf("concat_ws(':', r.id::text");
const fieldsEndMarker = "coalesce(r.trigger_radius_meters::text, '')";
const oldFields = oldSql.slice(fieldsStart, oldSql.indexOf(fieldsEndMarker, fieldsStart) + fieldsEndMarker.length);

assert('previous signature fields located', fieldsStart >= 0 && oldFields.length > 100);
assert(
  'the nine original fields appear unchanged and in order',
  newSql.includes(oldFields),
  'the prefix of the signature changed - every existing bundle hash would move',
);
assert(
  'the first added argument is a CASE (NULL when absent), not a coalesce',
  newSql.includes(`${oldFields}, CASE WHEN`),
  'a coalesce(..., \'\') would append ":" to every existing signature',
);

const outer = "md5( concat_ws(':', tr.id::text, tr.title, tr.topology, tr.transit_mode, tr.duration_minutes::text, coalesce(a.signature, '')) )";
assert('the tour-level hash expression is unchanged', oldSql.includes(outer) && newSql.includes(outer));

// -----------------------------------------------------------------------------

heading('checkTranscript');

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const VALID = 'WEBVTT\n\n00:00.000 --> 00:04.000\nWelcome.\n\n00:04.000 --> 00:09.500\nSecond line.\n';

const good = checkTranscript(utf8(VALID), 10);
eq('valid file: cue count', good.cueCount, 2);
eq('valid file: no warnings', good.warnings, []);

eq(
  'BOM and CRLF accepted',
  checkTranscript(utf8(`﻿${VALID.replace(/\n/g, '\r\n')}`), 10).cueCount,
  2,
);
eq(
  'Hebrew UTF-8 accepted',
  checkTranscript(utf8('WEBVTT\n\n00:00.000 --> 00:03.000\nברוכים הבאים לסיור.\n'), 5).cueCount,
  1,
);

throwsCode('Windows-1255 (not UTF-8) refused', 'invalid_transcript', () =>
  checkTranscript(new Uint8Array([0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a, 0xe1, 0xf8, 0xe5]), null),
);
throwsCode('missing WEBVTT signature refused', 'invalid_transcript', () =>
  checkTranscript(utf8('00:00.000 --> 00:01.000\nhi\n'), null),
);
throwsCode('empty file refused', 'invalid_transcript', () => checkTranscript(new Uint8Array(0), null));
throwsCode('oversize file refused', 'invalid_transcript', () =>
  checkTranscript(new Uint8Array(MAX_TRANSCRIPT_BYTES + 1), null),
);
throwsCode('signature with no usable cues refused', 'invalid_transcript', () =>
  checkTranscript(utf8('WEBVTT\n\n00:05.000 --> 00:01.000\nbackwards\n'), null),
);

const long = checkTranscript(utf8(VALID), 6);
assert(
  'cues past the end of the audio warn (different take)',
  long.warnings.some((w) => w.includes('different take')),
  JSON.stringify(long.warnings),
);
const skipped = checkTranscript(utf8(`${VALID}\n00:20.000 --> 00:10.000\nbad\n`), null);
assert('unusable cue blocks warn', skipped.warnings.some((w) => w.includes('unusable')), JSON.stringify(skipped.warnings));

// -----------------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
