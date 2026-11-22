import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SWARM_FILE } from './swarm.js';

/** Prefix of a definition hash; the rest is a SHA-256 in hex. */
export const DEFS_HASH_PREFIX = 'd:';

const HASH_HEADER = 'swarmup-defs/1\n';

/** Folders of a task store whose files, at any depth, are definitions. */
export const DEF_FOLDERS = ['agents', 'workflows'] as const;

/** One definition file: its path in the store, with `/`, and its content's digest. */
export interface DefFile {
  path: string;
  /** SHA-256 in hex of the content with the BOM removed and CRLF turned into LF. */
  sha256: string;
  size: number;
  mtimeMs: number;
}

/** Text as the hash reads it: no BOM, LF line ends. */
export function normalText(buf: Buffer | string): string {
  const text = typeof buf === 'string' ? buf : buf.toString('utf8');
  return text.replace(/^FEFF/, '').replace(/\r\n/g, '\n');
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * The definition files of a store: `swarm.yaml` and every plain file under `agents/`. Links are
 * skipped, as `readAgentFiles` skips them: in a synced repo they could point anywhere. Sorted by
 * path.
 */
export function listDefFiles(rootDir: string): Array<Omit<DefFile, 'sha256'>> {
  const out: Array<Omit<DefFile, 'sha256'>> = [];
  const visit = (rel: string): void => {
    let s;
    try {
      s = lstatSync(join(rootDir, rel));
    } catch {
      return;
    }
    if (s.isFile()) out.push({ path: rel, size: s.size, mtimeMs: s.mtimeMs });
    else if (s.isDirectory()) {
      for (const name of readdirSync(join(rootDir, rel)).sort()) visit(`${rel}/${name}`);
    }
  };
  visit(SWARM_FILE);
  for (const f of DEF_FOLDERS) visit(f);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A cheap stamp of listed files: paths, sizes and change times, no content. */
export function fingerprintOf(files: ReadonlyArray<Omit<DefFile, 'sha256'>>): string {
  return files.map((f) => `${f.path}\0${f.size}\0${f.mtimeMs}`).join('\n');
}

/** A cheap stamp of the definition files of a store; it changes when any of them does. */
export function definitionsFingerprint(rootDir: string): string {
  return fingerprintOf(listDefFiles(rootDir));
}

/** Reads each file and adds its digest. */
export function digestFiles(
  rootDir: string,
  files: Array<Omit<DefFile, 'sha256'>>,
): { files: DefFile[]; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const out: DefFile[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = normalText(readFileSync(join(rootDir, f.path)));
    } catch {
      continue;
    }
    texts.set(f.path, text);
    out.push({ ...f, sha256: sha256(text) });
  }
  return { files: out, texts };
}

/**
 * The hash of a definition set: `d:` and the SHA-256 of a header line plus one line per file,
 * `<path> NUL <sha256 of its text>`, sorted by path. Line ends, a BOM and the order files are
 * read in do not change it.
 */
export function definitionHash(files: ReadonlyArray<Pick<DefFile, 'path' | 'sha256'>>): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${f.sha256}\n`)
    .join('');
  return DEFS_HASH_PREFIX + sha256(HASH_HEADER + lines);
}

/** The hash of the text files given by path, for tests and `defs hash` of loose files. */
export function hashTexts(texts: Record<string, string>): string {
  return definitionHash(
    Object.entries(texts).map(([path, text]) => ({ path, sha256: sha256(normalText(text)) })),
  );
}

/** The first 12 hex digits of a hash, with its prefix: what events and lists show. */
export function shortHash(hash: string): string {
  return hash.startsWith(DEFS_HASH_PREFIX)
    ? hash.slice(0, DEFS_HASH_PREFIX.length + 12)
    : hash.slice(0, 12);
}
