/**
 * Variants (W5): sparse overlay folders, `variants/<name>/` in a task store, with the layout of
 * the definitions themselves. A variant's definitions are the base files with the overlay on top:
 * YAML deep-merges (maps merge, lists replace, `null` deletes), an agent file's frontmatter merges
 * the same way and a non-empty body replaces the base body, and `<path>.delete` removes a file.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { isActorId, OpsError, slugToActor } from '../ids.js';
import type { DefFile } from './hash.js';
import { definitionHash, normalText } from './hash.js';

/** The folder of a store that holds the variants. */
export const VARIANTS_DIR = 'variants';

/** A variant's name: lowercase letters, digits and dashes, starting with a letter or digit. */
export const VARIANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The file in a variant's folder that records its proposal; never part of the overlay. */
export const PROPOSAL_FILE = 'proposal.json';

/** An overlay path that removes the base file of the same path without the suffix. */
export const DELETE_SUFFIX = '.delete';

/** The most files one overlay may hold, and the most bytes one of them may have. */
export const OVERLAY_MAX_FILES = 50;
export const OVERLAY_MAX_BYTES = 256 * 1024;

/** Checks a variant name; exit 2 otherwise. */
export function checkVariantName(name: unknown): string {
  if (typeof name !== 'string' || !VARIANT_NAME_RE.test(name)) {
    throw new OpsError(
      `bad variant name '${String(name)}': use lowercase letters, digits and dashes, such as engineer-tests-first`,
      2,
    );
  }
  return name;
}

/** The folder of variant `name` in the store `rootDir`. */
export function variantDir(rootDir: string, name: string): string {
  return join(rootDir, VARIANTS_DIR, checkVariantName(name));
}

function plainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The variants of a store, by name: real folders under `variants/` with a valid name. */
export function listVariantNames(rootDir: string): string[] {
  const dir = join(rootDir, VARIANTS_DIR);
  if (!plainDir(dir)) return [];
  return readdirSync(dir)
    .filter((n) => VARIANT_NAME_RE.test(n) && plainDir(join(dir, n)))
    .sort();
}

/**
 * The overlay files of a folder, path (with `/`) to text as hashed (no BOM, LF line ends), sorted
 * by path. Every plain file counts, except {@link PROPOSAL_FILE} at the top and dot files; links
 * are refused, as are more than {@link OVERLAY_MAX_FILES} files or one over
 * {@link OVERLAY_MAX_BYTES}.
 */
export function readOverlay(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!plainDir(dir)) throw new OpsError(`${dir} is no folder`, 2);
  const visit = (rel: string): void => {
    const abs = rel ? join(dir, rel) : dir;
    for (const name of readdirSync(abs).sort()) {
      if (name.startsWith('.')) continue;
      const path = rel ? `${rel}/${name}` : name;
      if (path === PROPOSAL_FILE) continue;
      const s = lstatSync(join(abs, name));
      if (s.isSymbolicLink()) throw new OpsError(`${path} is a link; an overlay holds files`, 2);
      if (s.isDirectory()) visit(path);
      else if (s.isFile()) {
        if (s.size > OVERLAY_MAX_BYTES) {
          throw new OpsError(`${path} is over ${OVERLAY_MAX_BYTES / 1024} KB`, 2);
        }
        out.set(path, normalText(readFileSync(join(abs, name))));
        if (out.size > OVERLAY_MAX_FILES) {
          throw new OpsError(`an overlay holds at most ${OVERLAY_MAX_FILES} files`, 2);
        }
      }
    }
  };
  visit('');
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * An overlay from file texts by store path, as the app sends one (W6): each path relative, with
 * `/` and plain name segments, and the same limits as {@link readOverlay}.
 */
export function overlayFromFiles(files: Readonly<Record<string, unknown>>): Map<string, string> {
  const entries = Object.entries(files);
  if (entries.length === 0) throw new OpsError('the overlay holds no files', 2);
  if (entries.length > OVERLAY_MAX_FILES) {
    throw new OpsError(`an overlay holds at most ${OVERLAY_MAX_FILES} files`, 2);
  }
  const out = new Map<string, string>();
  for (const [path, text] of entries) {
    const segs = path.split('/');
    if (segs.some((s) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(s))) {
      throw new OpsError(`bad overlay path '${path}'`, 2);
    }
    if (typeof text !== 'string') throw new OpsError(`${path}: send the file text`, 2);
    if (Buffer.byteLength(text) > OVERLAY_MAX_BYTES) {
      throw new OpsError(`${path} is over ${OVERLAY_MAX_BYTES / 1024} KB`, 2);
    }
    out.set(path, normalText(text));
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `over` merged onto `base`: maps merge key by key, a list or a plain value replaces, and `null`
 * deletes (the result is `undefined`). Nulls inside a map the base lacks are dropped too.
 */
export function mergeValues(base: unknown, over: unknown): unknown {
  if (over === null) return undefined;
  if (!isRecord(over)) return over;
  const out: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) {
    const merged = mergeValues(out[k], v);
    if (merged === undefined) delete out[k];
    else out[k] = merged;
  }
  return out;
}

/** Applies `over` to the YAML document at `path`, keeping the base's comments and key order. */
function applyToDoc(doc: YAML.Document, path: string[], over: unknown): void {
  if (over === null) {
    if (path.length > 0 && doc.hasIn(path)) doc.deleteIn(path);
    return;
  }
  const here = path.length === 0 ? doc.contents : doc.getIn(path, true);
  if (isRecord(over) && YAML.isMap(here)) {
    for (const [k, v] of Object.entries(over)) applyToDoc(doc, [...path, k], v);
    return;
  }
  const value = mergeValues(undefined, over);
  if (path.length === 0) doc.contents = doc.createNode(value);
  else doc.setIn(path, doc.createNode(value));
}

/** YAML `over` merged onto YAML `base` by {@link mergeValues}, keeping the base's comments. */
export function mergeYamlText(base: string | undefined, over: string): string {
  const overDoc = YAML.parseDocument(over);
  if (overDoc.errors.length > 0) {
    throw new OpsError(
      `the overlay does not parse: ${overDoc.errors[0]!.message.split('\n')[0]}`,
      2,
    );
  }
  const value = overDoc.toJS() as unknown;
  if (value === null || value === undefined) return base ?? '';
  if (base === undefined || !base.trim()) {
    return YAML.stringify(mergeValues(undefined, value), { lineWidth: 0 });
  }
  const doc: YAML.Document = YAML.parseDocument(base);
  if (doc.errors.length > 0) {
    throw new OpsError(`the base file does not parse: ${doc.errors[0]!.message.split('\n')[0]}`, 2);
  }
  if (!YAML.isMap(doc.contents) || !isRecord(value)) {
    doc.contents = doc.createNode(mergeValues(doc.toJS(), value));
  } else applyToDoc(doc, [], value);
  return doc.toString({ lineWidth: 0 });
}

/** A Markdown file split into its frontmatter text (null without one) and body. */
export function splitFrontmatter(text: string): { yaml: string | null; body: string } {
  const src = normalText(text);
  if (!src.startsWith('---\n')) return { yaml: null, body: src };
  const end = src.indexOf('\n---', 4);
  if (end < 0) return { yaml: null, body: src };
  const after = src.indexOf('\n', end + 4);
  return {
    yaml: src.slice(4, end + 1),
    body: after < 0 ? '' : src.slice(after + 1).replace(/^\n/, ''),
  };
}

function joinFrontmatter(yaml: string | null, body: string): string {
  const text = body.trim();
  if (yaml === null) return text ? `${text}\n` : '';
  const head = yaml.endsWith('\n') || yaml === '' ? yaml : `${yaml}\n`;
  return `---\n${head}---\n${text ? `\n${text}\n` : ''}`;
}

/**
 * An agent file with an overlay file on top: the frontmatter merges as YAML, and a non-empty
 * overlay body replaces the base body. Without a base, the overlay is the file.
 */
export function mergeAgentText(base: string | undefined, over: string): string {
  if (base === undefined) return normalText(over);
  const b = splitFrontmatter(base);
  const o = splitFrontmatter(over);
  const overKeys = o.yaml !== null && o.yaml.trim() !== '' && YAML.parse(o.yaml) !== null;
  const yaml = overKeys ? mergeYamlText(b.yaml ?? '', o.yaml!) : b.yaml;
  const body = o.body.trim() ? o.body : b.body;
  return joinFrontmatter(yaml, body);
}

/** How an overlay file applies to its base file, by its path. */
function mergeOne(path: string, base: string | undefined, over: string): string {
  if (/^agents\/.+\.md$/.test(path)) return mergeAgentText(base, over);
  if (/\.ya?ml$/i.test(path)) return mergeYamlText(base, over);
  return normalText(over);
}

/**
 * The definition texts of a variant: `base` with each overlay file applied. A `<path>.delete`
 * file removes `<path>`. Sorted by path.
 */
export function applyOverlay(
  base: ReadonlyMap<string, string>,
  overlay: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map(base);
  for (const [path, text] of overlay) {
    if (path.endsWith(DELETE_SUFFIX)) {
      out.delete(path.slice(0, -DELETE_SUFFIX.length));
      continue;
    }
    out.set(path, mergeOne(path, base.get(path), text));
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** {@link DefFile}s of texts held in memory, with no size or change time from disk. */
export function textFiles(texts: ReadonlyMap<string, string>): DefFile[] {
  return [...texts].map(([path, text]) => ({
    path,
    sha256: sha256(text),
    size: Buffer.byteLength(text, 'utf8'),
    mtimeMs: 0,
  }));
}

/** The definition hash of texts held in memory. */
export function textsHash(texts: ReadonlyMap<string, string>): string {
  return definitionHash(textFiles(texts));
}

/** The paths an overlay changes in the base: the path itself, or the one a `.delete` removes. */
export function overlayTargets(overlay: ReadonlyMap<string, string>): string[] {
  return [
    ...new Set(
      [...overlay.keys()].map((p) =>
        p.endsWith(DELETE_SUFFIX) ? p.slice(0, -DELETE_SUFFIX.length) : p,
      ),
    ),
  ].sort();
}

/**
 * The agent ids an overlay changes: one per `agents/<runtime>-<role>.md` it holds, `<runtime>:<role>`
 * per addendum `agents/<role>/<runtime>.md`, and `*:<role>` per folder `agents/<role>/agent.md`,
 * which every runtime of the role reads.
 */
export function overlayAgents(overlay: ReadonlyMap<string, string>): string[] {
  const out = new Set<string>();
  for (const path of overlayTargets(overlay)) {
    const f = /^agents\/([a-z][a-z0-9-]*)\/([a-z][a-z0-9]*)\.md$/.exec(path);
    if (f) {
      out.add(f[2] === 'agent' ? `*:${f[1]}` : `${f[2]}:${f[1]}`);
      continue;
    }
    const m = /^agents\/([^/_][^/]*)\.md$/.exec(path);
    if (!m) continue;
    const head = splitFrontmatter(overlay.get(path) ?? '').yaml;
    let named: unknown;
    try {
      named = head ? (YAML.parse(head) as { id?: unknown } | null)?.id : undefined;
    } catch {
      named = undefined;
    }
    const id = typeof named === 'string' ? named : slugToActor(m[1]!);
    if (isActorId(id)) out.add(id);
  }
  return [...out].sort();
}
