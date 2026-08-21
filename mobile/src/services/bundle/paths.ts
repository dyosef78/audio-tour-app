import { Directory, File, Paths } from 'expo-file-system';

/**
 * Deterministic local paths for downloaded bundles.
 *
 * The rule from the approved TASK-201 proposal: NEVER persist an absolute file
 * URI. On iOS the app container UUID rotates across reinstalls and some OS
 * updates, so a stored absolute path can be dead on next launch - and the
 * failure mode is silent 404s in the field with no network to recover from.
 *
 * Instead, every local path is derived at read time from the bucket-relative
 * `storage_path` the database already gives us. Nothing filesystem-shaped is
 * ever written down.
 *
 * Layout, one directory per tour so a bundle can be committed or evicted whole:
 *
 *   <document>/bundles/<tourId>/manifest.json
 *   <document>/bundles/<tourId>/media/tours/<tourId>/wp01_jaffa_gate.opus
 *                               ^^^^^ the bucket path, preserved verbatim
 */

const BUNDLES = 'bundles';
const MEDIA = 'media';
const MANIFEST = 'manifest.json';

/** Document, never cache: the OS may evict cache under storage pressure, and
 *  audio disappearing mid-walk is the exact failure offline-first prevents. */
export function bundlesRoot(): Directory {
  return new Directory(Paths.document, BUNDLES);
}

export function bundleDir(tourId: string): Directory {
  return new Directory(bundlesRoot(), tourId);
}

/** Staging directory. Renamed onto `bundleDir` only once everything verifies. */
export function partialDir(tourId: string): Directory {
  return new Directory(bundlesRoot(), `${tourId}.partial`);
}

export function manifestFile(dir: Directory): File {
  return new File(dir, MANIFEST);
}

/**
 * Reject anything that could escape the bundle directory.
 *
 * `storage_path` is server-controlled, so this is defence in depth rather than
 * a live threat - but a path containing `..` would let a compromised or simply
 * buggy CMS row write anywhere in the app container.
 */
export function isSafeStoragePath(storagePath: string): boolean {
  if (storagePath.length === 0) return false;
  if (storagePath.startsWith('/') || storagePath.includes('\\')) return false;
  if (storagePath.includes('://')) return false;
  return storagePath.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Local file for a track, inside the given bundle (or staging) directory. */
export function mediaFile(dir: Directory, storagePath: string): File {
  if (!isSafeStoragePath(storagePath)) {
    throw new Error(`Unsafe storage_path rejected: ${storagePath}`);
  }
  return new File(dir, MEDIA, ...storagePath.split('/'));
}

/**
 * The read-time bridge the geofencing engine consumes.
 * Pure derivation - no lookup table, no stored path.
 */
export function resolveLocalUri(tourId: string, storagePath: string): string {
  return mediaFile(bundleDir(tourId), storagePath).uri;
}
