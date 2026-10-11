/**
 * In-memory `expo-file-system` for the Node harness (Epic 17, TASK-1702).
 *
 * The controller test runs the REAL TourBundleRepository, checkpoint file and
 * plan store, so their file layout and atomic temp+rename are exercised, not
 * re-described. Only the synchronous surface those modules use is supplied:
 * File/Directory construction from parts, exists, textSync, write, delete,
 * rename, create, list, uri, sizeBytes. A call outside it throws, so a module
 * growing a new dependency fails the harness loudly instead of half-working.
 */

const files = new Map<string, string>();
const dirs = new Set<string>(['/document']);

type Part = string | File | Directory;

function join(parts: Part[]): string {
  const segments = parts.flatMap((p) => (typeof p === 'string' ? p.split('/') : p.path.split('/'))).filter((s) => s.length > 0);
  return `/${segments.join('/')}`;
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

export class File {
  readonly path: string;
  constructor(...parts: Part[]) {
    this.path = join(parts);
  }
  get uri(): string {
    return `file://${this.path}`;
  }
  get exists(): boolean {
    return files.has(this.path);
  }
  get sizeBytes(): number {
    const text = files.get(this.path);
    if (text === undefined) throw new Error(`stub fs: ${this.path} does not exist`);
    return Buffer.byteLength(text);
  }
  textSync(): string {
    const text = files.get(this.path);
    if (text === undefined) throw new Error(`stub fs: ${this.path} does not exist`);
    return text;
  }
  write(text: string): void {
    if (__failWrites) throw new Error(`stub fs: write refused (${this.path})`);
    dirs.add(parentOf(this.path));
    files.set(this.path, text);
  }
  delete(): void {
    if (!files.delete(this.path)) throw new Error(`stub fs: delete of missing ${this.path}`);
  }
  rename(name: string): void {
    const text = this.textSync();
    files.delete(this.path);
    files.set(`${parentOf(this.path)}/${name}`, text);
  }
}

export class Directory {
  readonly path: string;
  constructor(...parts: Part[]) {
    this.path = join(parts);
  }
  get uri(): string {
    return `file://${this.path}/`;
  }
  get exists(): boolean {
    return dirs.has(this.path);
  }
  create(_options?: { intermediates?: boolean; idempotent?: boolean }): void {
    dirs.add(this.path);
  }
  delete(): void {
    for (const p of [...files.keys()]) if (p.startsWith(`${this.path}/`)) files.delete(p);
    for (const d of [...dirs]) if (d === this.path || d.startsWith(`${this.path}/`)) dirs.delete(d);
  }
  list(): (File | Directory)[] {
    const prefix = `${this.path}/`;
    const names = new Set<string>();
    for (const p of [...files.keys(), ...dirs]) {
      if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]!);
    }
    return [...names].sort().map((n) => (files.has(prefix + n) ? new File(this, n) : new Directory(this, n)));
  }
  get name(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }
}

/** Imported by DownloadManager; the harness seeds bundles instead of downloading them. */
export class DownloadTask {
  constructor() {
    throw new Error('stub fs: DownloadTask is not supported - seed bundles with __writeFile');
  }
}
export type DownloadPauseState = unknown;

export const Paths = {
  document: new Directory('/document'),
};

let __failWrites = false;
export function __setFailWrites(fail: boolean): void {
  __failWrites = fail;
}

export function __resetFs(): void {
  files.clear();
  dirs.clear();
  dirs.add('/document');
  __failWrites = false;
}

/** Test seeding and inspection. */
export function __writeFile(path: string, text: string): void {
  dirs.add(parentOf(path));
  files.set(path, text);
}
export function __readFile(path: string): string | undefined {
  return files.get(path);
}
