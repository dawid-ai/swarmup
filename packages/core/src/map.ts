import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import YAML from 'yaml';
import { parseDoc } from './frontmatter.js';
import { OpsError } from './ids.js';
import { topicWords } from './kb.js';

// The project map: linked Markdown nodes in `.swarmup/map/` of the folder the work is in, which
// say what each part of the project is for. Agents keep them true as part of their work;
// `checkMap` finds what a change left out, with no model.

/** Where a project keeps its map, relative to the top of its folder. */
export const MAP_DIR = '.swarmup/map';

/**
 * The generated one-line-per-node list. Not `INDEX.md`: on Windows and macOS that is the same
 * file as the root node `index.md`.
 */
export const MAP_INDEX_FILE = '_INDEX.md';

/** Files in the map folder that are not nodes, lowercased. */
const NOT_NODES = new Set([MAP_INDEX_FILE.toLowerCase(), 'readme.md']);

/** Most characters in a node's `summary`. */
export const MAP_SUMMARY_MAX = 120;
/** Most body lines of a node, and of the root node. */
export const MAP_BODY_MAX = 60;
export const MAP_ROOT_BODY_MAX = 40;
/** The id of the root node, `.swarmup/map/index.md`. */
export const MAP_ROOT_ID = 'index';

export const MAP_TYPES = ['code', 'website', 'campaign'] as const;
export type MapType = (typeof MAP_TYPES)[number];

/** The built-in node kinds, by project type; `.swarmup/map/kinds.yml` adds more. */
export const MAP_KINDS: Record<MapType | 'any', string[]> = {
  code: ['module', 'service', 'entry', 'data', 'flow'],
  website: ['page', 'section', 'component', 'content-source'],
  campaign: ['campaign', 'audience', 'message', 'channel', 'asset', 'calendar', 'metric'],
  any: ['root', 'goal', 'area'],
};

/**
 * Changed paths that need no node: the map and the task store, lockfiles and build output. The
 * map's `ignore` file adds more, in the same syntax.
 */
export const MAP_DEFAULT_IGNORE = [
  '.swarmup/',
  '.agent-ops/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.DS_Store',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
];

export interface MapNode {
  id: string;
  /** Path of the node file, relative to the map folder, with `/`. */
  file: string;
  kind: string;
  summary: string;
  covers: string[];
  links: string[];
  verified?: string;
  review_after?: string;
  /** The root's project type, from its frontmatter. */
  type?: string;
  body: string;
  bodyLines: number;
  /** What is wrong with the file itself: bad frontmatter, a field of the wrong type. */
  problems: string[];
}

export interface ProjectMap {
  /** The top of the project folder. */
  top: string;
  /** The map folder. */
  dir: string;
  nodes: MapNode[];
  kinds: Set<string>;
  /** The map's own ignore patterns, without the defaults. */
  ignore: string[];
}

/** The top of the folder `cwd` is in: its git top level, else `cwd`. */
export function projectTop(cwd: string): string {
  try {
    return resolve(
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return resolve(cwd);
  }
}

/** The map folder of the project at `top`, or null when it has none. */
export function mapDirOf(top: string): string | null {
  const dir = join(top, ...MAP_DIR.split('/'));
  try {
    return statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** A path with `/` separators and no leading `./` or `/`. */
export function slashPath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '');
}

/** The node id of a file in the map folder: `core.md` and `core/index.md` are both `core`. */
export function nodeIdOf(file: string): string {
  const f = slashPath(file).replace(/\.md$/i, '');
  if (f === 'index') return MAP_ROOT_ID;
  return f.endsWith('/index') ? f.slice(0, -'/index'.length) : f;
}

function stringList(v: unknown, field: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  problems.push(`\`${field}\` must be a list of strings`);
  return [];
}

function dateText(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return undefined;
}

/** Reads one node file. Never throws: what is wrong goes in `problems`. */
export function parseNode(file: string, text: string): MapNode {
  const problems: string[] = [];
  let data: Record<string, unknown> = {};
  let body = text.replace(/\r\n/g, '\n');
  try {
    const doc = parseDoc<Record<string, unknown>>(text);
    if (doc.data && typeof doc.data === 'object' && !Array.isArray(doc.data)) data = doc.data;
    body = doc.body;
  } catch (err) {
    problems.push(`bad frontmatter: ${(err as Error).message.split('\n')[0]}`);
  }
  const lines = body.replace(/\s+$/, '').split('\n');
  const bodyLines = lines.length === 1 && lines[0] === '' ? 0 : lines.length;
  const kind = typeof data.kind === 'string' ? data.kind.trim() : '';
  const summary = typeof data.summary === 'string' ? data.summary.trim() : '';
  if (!kind) problems.push('no `kind`');
  if (!summary) problems.push('no `summary`');
  const verified = data.verified === undefined ? undefined : String(data.verified);
  const reviewAfter = dateText(data.review_after);
  if (data.review_after !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(reviewAfter ?? '')) {
    problems.push('`review_after` must be a date such as 2026-12-01');
  }
  return {
    id: nodeIdOf(file),
    file: slashPath(file),
    kind,
    summary,
    covers: stringList(data.covers, 'covers', problems).map((c) => c.trim()),
    links: stringList(data.links, 'links', problems).map((l) => l.trim()),
    ...(verified ? { verified } : {}),
    ...(reviewAfter ? { review_after: reviewAfter } : {}),
    ...(typeof data.type === 'string' ? { type: data.type } : {}),
    body,
    bodyLines,
    problems,
  };
}

/** Kinds from `kinds.yml`: a list of names, or a map from name to what it is for. */
export function parseKinds(text: string): string[] {
  const data: unknown = YAML.parse(text);
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? Array.isArray((data as { kinds?: unknown }).kinds)
        ? ((data as { kinds: unknown[] }).kinds as unknown[])
        : Object.keys(data)
      : [];
  return list.filter((k): k is string => typeof k === 'string').map((k) => k.trim());
}

/** Patterns of an ignore file: one per line, `#` starts a comment. */
export function parseIgnore(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean);
}

function nodeFiles(dir: string, sub = ''): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(dir, sub)).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const rel = sub ? `${sub}/${name}` : name;
    let st;
    try {
      st = statSync(join(dir, rel));
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...nodeFiles(dir, rel));
    else if (/\.md$/i.test(name) && !(sub === '' && NOT_NODES.has(name.toLowerCase())))
      out.push(rel);
  }
  return out;
}

/** Reads the map of the project at `top`, or null when it has none. */
export function readMap(top: string): ProjectMap | null {
  const dir = mapDirOf(top);
  if (!dir) return null;
  const nodes = nodeFiles(dir).map((f) => parseNode(f, readFileSync(join(dir, f), 'utf8')));
  nodes.sort((a, b) => (a.id === MAP_ROOT_ID ? -1 : b.id === MAP_ROOT_ID ? 1 : cmp(a.id, b.id)));
  const kinds = new Set(Object.values(MAP_KINDS).flat());
  const read = (name: string): string | null => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  const kindsText = read('kinds.yml');
  if (kindsText) {
    try {
      for (const k of parseKinds(kindsText)) kinds.add(k);
    } catch {
      // checkMap reports it.
    }
  }
  const ignoreText = read('ignore');
  return {
    top: resolve(top),
    dir,
    nodes,
    kinds,
    ignore: ignoreText ? parseIgnore(ignoreText) : [],
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- Paths and patterns --------------------------------------------------------------------------

export function isUrl(entry: string): boolean {
  return /^https?:\/\//i.test(entry.trim());
}

/** A `covers` entry without its `#anchor`, as a path from the project top. */
export function coverPath(entry: string): string {
  const hash = entry.indexOf('#');
  return slashPath(hash >= 0 ? entry.slice(0, hash) : entry).replace(/\/+$/, '');
}

function hasGlob(p: string): boolean {
  return /[*?[]/.test(p);
}

/** The regular expression body of a glob: `*` and `?` stay in one segment, `**` crosses them. */
function globBody(p: string): string {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return re;
}

/**
 * Whether a `covers` entry covers `path` (from the project top, either separator). An entry is a
 * path from the top: a file, or a folder that covers everything in it. `*` and `?` stay inside one
 * segment and `**` crosses folders; a glob that matches a folder covers what is in it too.
 */
export function coverMatcher(entry: string): (path: string) => boolean {
  let m = matchers.get(entry);
  if (!m) {
    m = makeCoverMatcher(entry);
    matchers.set(entry, m);
  }
  return m;
}

const matchers = new Map<string, (path: string) => boolean>();

function makeCoverMatcher(entry: string): (path: string) => boolean {
  if (isUrl(entry)) return () => false;
  const p = coverPath(entry);
  if (!p) return () => false;
  if (!hasGlob(p))
    return (path) => {
      const s = slashPath(path);
      return s === p || s.startsWith(`${p}/`);
    };
  const re = new RegExp(`^${globBody(p)}(?:/.*)?$`);
  return (path) => re.test(slashPath(path));
}

/**
 * Whether a path is ignored by `patterns` (gitignore-like): a pattern with no `/` but a trailing
 * one matches a name in any folder (`dist/`, `yarn.lock`); a leading `/` or one inside anchors it
 * at the top. A folder pattern covers what is in it. `!` takes paths out again; the last pattern
 * that matches decides.
 */
export function ignoreMatcher(patterns: string[]): (path: string) => boolean {
  const rules = patterns.map((raw) => {
    const not = raw.startsWith('!');
    let p = (not ? raw.slice(1) : raw).trim().replace(/\\/g, '/');
    const anchored = p.startsWith('/') || p.replace(/\/+$/, '').includes('/');
    p = p.replace(/^\/+/, '').replace(/\/+$/, '');
    const body = globBody(p);
    return { not, re: new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}(?:/.*)?$`) };
  });
  return (path) => {
    const s = slashPath(path);
    let on = false;
    for (const r of rules) if (r.re.test(s)) on = !r.not;
    return on;
  };
}

/**
 * Resolves a link of `from` to a node id: relative to `from`'s folder first, then to the map top.
 * A link that starts with `/` is from the map top only; `/` alone is the root node.
 */
export function resolveLink(from: MapNode, link: string, ids: Set<string>): string | null {
  const raw = link.trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (raw.startsWith('/')) {
    const id = nodeIdOf(raw.replace(/^\/+/, '') || MAP_ROOT_ID);
    return ids.has(id) ? id : null;
  }
  const fromDir = from.file.includes('/') ? posix.dirname(from.file) : '';
  for (const t of [posix.normalize(fromDir ? `${fromDir}/${raw}` : raw), posix.normalize(raw)]) {
    if (t.startsWith('..')) continue;
    const id = nodeIdOf(t);
    if (ids.has(id)) return id;
  }
  return null;
}

// ---- Files of the project ------------------------------------------------------------------------

function git(top: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: top,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function isGit(top: string): boolean {
  try {
    git(top, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

const WALK_SKIP = new Set(['.git', 'node_modules', '.swarmup', '.agent-ops']);

/** The project's files, from its top with `/`: what git tracks or would add, else a folder walk. */
export function projectFiles(top: string): string[] {
  if (isGit(top)) {
    try {
      return git(top, ['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    } catch {
      // A folder walk below.
    }
  }
  const out: string[] = [];
  const walk = (sub: string): void => {
    let names: string[];
    try {
      names = readdirSync(join(top, sub));
    } catch {
      return;
    }
    for (const name of names) {
      if (WALK_SKIP.has(name)) continue;
      const rel = sub ? `${sub}/${name}` : name;
      try {
        if (statSync(join(top, rel)).isDirectory()) walk(rel);
        else out.push(rel);
      } catch {
        // Gone or unreadable.
      }
    }
  };
  walk('');
  return out;
}

export interface MapChange {
  path: string;
  deleted: boolean;
}

/** The commit that `mapBase` compares with, and the name it came from. */
export interface MapBase {
  ref: string;
  commit: string;
}

/**
 * Where the work left its base: the merge base of HEAD with `base`, else with the remote's default
 * branch, `main` or `master`. Null outside git or with none of them.
 */
export function mapBase(top: string, base?: string): MapBase | null {
  if (!isGit(top)) return null;
  const tries = base ? [base] : ['origin/HEAD', 'main', 'master', 'origin/main', 'origin/master'];
  for (const ref of tries) {
    try {
      const commit = git(top, ['merge-base', ref, 'HEAD']).trim();
      if (commit) return { ref, commit };
    } catch {
      // Next.
    }
  }
  if (base) throw new OpsError(`no merge base with ${base}: is it a branch or commit here?`, 2);
  return null;
}

/** What changed since `base` (a commit), committed or not, untracked files included. */
export function changedSince(top: string, base: string): MapChange[] {
  const seen = new Map<string, MapChange>();
  const parts = git(top, ['diff', '--name-status', '--no-renames', '-z', base, '--'])
    .split('\0')
    .filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    seen.set(parts[i + 1]!, { path: parts[i + 1]!, deleted: parts[i]!.startsWith('D') });
  }
  for (const f of git(top, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (f) seen.set(f, { path: f, deleted: false });
  }
  return [...seen.values()].sort((a, b) => cmp(a.path, b.path));
}

// ---- _INDEX.md ---------------------------------------------------------------------------------

export const MAP_INDEX_HEADER = [
  '# Project map index',
  '',
  '<!-- Generated by `swarmup map index`; do not edit. Run it again after you change a node. -->',
  '',
];

/** One node's line: `id — kind — summary`. */
export function nodeLine(n: Pick<MapNode, 'id' | 'kind' | 'summary'>): string {
  return `\`${n.id}\` — ${n.kind || '?'} — ${n.summary.replace(/\s+/g, ' ')}`;
}

/** The text `swarmup map index` writes to `_INDEX.md`. */
export function mapIndexText(map: ProjectMap): string {
  return [...MAP_INDEX_HEADER, ...map.nodes.map((n) => `- ${nodeLine(n)}`)].join('\n') + '\n';
}

/** Writes `_INDEX.md`; returns its path. */
export function writeMapIndex(map: ProjectMap): string {
  const file = join(map.dir, MAP_INDEX_FILE);
  writeFileSync(file, mapIndexText(map));
  return file;
}

/** Text compared for staleness: line endings, trailing blanks and a formatter's wrap ignored. */
function indexShape(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

// ---- Check ---------------------------------------------------------------------------------------

export interface MapProblem {
  code:
    | 'uncovered'
    | 'covers-nothing'
    | 'missing-link'
    | 'too-long'
    | 'no-review-after'
    | 'bad-node'
    | 'unknown-kind'
    | 'no-root'
    | 'stale-index'
    | 'bad-kinds'
    | 'node-not-updated'
    | 'review-due';
  message: string;
  node?: string;
  path?: string;
}

export interface MapCheck {
  /** False when the project has no map: nothing was checked. */
  hasMap: boolean;
  errors: MapProblem[];
  warnings: MapProblem[];
  base?: MapBase;
  changed: number;
  nodes: number;
}

export interface MapCheckOptions {
  /** The branch or commit the change started from; see {@link mapBase}. */
  base?: string;
  /** The date `review_after` is compared with, `YYYY-MM-DD`; default today. */
  today?: string;
  /** The changes, instead of reading them from git (tests, review prompts). */
  changes?: MapChange[];
}

/** The nodes whose `covers` cover `path`. */
export function nodesCovering(map: ProjectMap, path: string): MapNode[] {
  return map.nodes.filter((n) => n.covers.some((c) => coverMatcher(c)(path)));
}

/**
 * Checks the map of the project at `top` against itself and against what changed since the base:
 * deterministic, with no model. Errors fail the check; warnings are for the reviewer.
 */
export function checkMap(top: string, opts: MapCheckOptions = {}): MapCheck {
  const map = readMap(top);
  if (!map) return { hasMap: false, errors: [], warnings: [], changed: 0, nodes: 0 };
  const errors: MapProblem[] = [];
  const warnings: MapProblem[] = [];
  const ids = new Set(map.nodes.map((n) => n.id));
  // Listed only when a glob needs it: a plain path is looked up on disk.
  let listed: string[] | undefined;
  const files = (): string[] => (listed ??= projectFiles(map.top));
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  if (!ids.has(MAP_ROOT_ID)) {
    errors.push({ code: 'no-root', message: `${MAP_DIR}/index.md is missing (kind \`root\`)` });
  }
  const kindsFile = join(map.dir, 'kinds.yml');
  if (existsSync(kindsFile)) {
    try {
      parseKinds(readFileSync(kindsFile, 'utf8'));
    } catch (err) {
      errors.push({ code: 'bad-kinds', message: `kinds.yml: ${(err as Error).message}` });
    }
  }
  for (const n of map.nodes) {
    const at = `${MAP_DIR}/${n.file}`;
    for (const p of n.problems)
      errors.push({ code: 'bad-node', node: n.id, message: `${at}: ${p}` });
    if (n.kind && !map.kinds.has(n.kind)) {
      errors.push({
        code: 'unknown-kind',
        node: n.id,
        message: `${at}: unknown kind \`${n.kind}\` (add it to ${MAP_DIR}/kinds.yml)`,
      });
    }
    if (n.summary.length > MAP_SUMMARY_MAX) {
      errors.push({
        code: 'too-long',
        node: n.id,
        message: `${at}: summary has ${n.summary.length} characters, over ${MAP_SUMMARY_MAX}`,
      });
    }
    const max = n.id === MAP_ROOT_ID ? MAP_ROOT_BODY_MAX : MAP_BODY_MAX;
    if (n.bodyLines > max) {
      errors.push({
        code: 'too-long',
        node: n.id,
        message: `${at}: body has ${n.bodyLines} lines, over ${max}; split it into linked nodes`,
      });
    }
    if (n.covers.some(isUrl) && !n.review_after) {
      errors.push({
        code: 'no-review-after',
        node: n.id,
        message: `${at}: covers a URL but has no \`review_after\` date`,
      });
    }
    if (n.review_after && n.review_after < today) {
      warnings.push({
        code: 'review-due',
        node: n.id,
        message: `${at}: past its review_after date ${n.review_after}`,
      });
    }
    for (const c of n.covers) {
      if (isUrl(c)) continue;
      const p = coverPath(c);
      const hit = hasGlob(p)
        ? files().some(coverMatcher(c))
        : !!p && existsSync(join(map.top, ...p.split('/')));
      if (!hit) {
        errors.push({
          code: 'covers-nothing',
          node: n.id,
          path: c,
          message: `${at}: covers \`${c}\`, which matches no file`,
        });
      }
    }
    for (const l of n.links) {
      if (!resolveLink(n, l, ids)) {
        errors.push({
          code: 'missing-link',
          node: n.id,
          message: `${at}: links to \`${l}\`, which is no node`,
        });
      }
    }
  }
  const indexFile = join(map.dir, MAP_INDEX_FILE);
  const index = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
  if (index === null || indexShape(index) !== indexShape(mapIndexText(map))) {
    errors.push({
      code: 'stale-index',
      message: `${MAP_DIR}/_INDEX.md is ${index === null ? 'missing' : 'out of date'}: run \`swarmup map index\``,
    });
  }

  let base: MapBase | undefined;
  let changes = opts.changes;
  if (!changes) {
    const b = mapBase(map.top, opts.base);
    if (b) {
      base = b;
      changes = changedSince(map.top, b.commit);
    }
  }
  changes ??= [];
  const ignored = ignoreMatcher([...MAP_DEFAULT_IGNORE, ...map.ignore]);
  const mapPrefix = `${MAP_DIR}/`;
  const changedNodes = new Set(
    changes
      .filter((c) => c.path.startsWith(mapPrefix))
      .map((c) => nodeIdOf(c.path.slice(mapPrefix.length))),
  );
  const stale = new Map<string, string[]>();
  for (const c of changes) {
    if (c.path.startsWith(mapPrefix)) continue;
    const covering = nodesCovering(map, c.path);
    if (covering.length === 0 && !c.deleted && !ignored(c.path)) {
      errors.push({
        code: 'uncovered',
        path: c.path,
        message: `${c.path} changed but no node covers it: add it to a node's \`covers\` or to ${MAP_DIR}/ignore`,
      });
    }
    for (const n of covering) {
      if (!changedNodes.has(n.id)) stale.set(n.id, [...(stale.get(n.id) ?? []), c.path]);
    }
  }
  for (const [id, paths] of stale) {
    const n = map.nodes.find((x) => x.id === id)!;
    const more = paths.length > 3 ? ` and ${paths.length - 3} more` : '';
    warnings.push({
      code: 'node-not-updated',
      node: id,
      message: `${MAP_DIR}/${n.file}: ${paths.slice(0, 3).join(', ')}${more} changed but the node did not; is it still true?`,
    });
  }
  return {
    hasMap: true,
    errors,
    warnings,
    ...(base ? { base } : {}),
    changed: changes.length,
    nodes: map.nodes.length,
  };
}

// ---- Search ----------------------------------------------------------------------------------

export interface MapHit {
  node: MapNode;
  score: number;
}

/**
 * Nodes that match any of `words`, best first: a word in the id counts most, then the summary and
 * kind, then `covers`, then the body. No words lists every node in id order.
 */
export function searchMap(map: ProjectMap, words: string[], limit = 10): MapHit[] {
  const terms = words.map((w) => w.toLowerCase().trim()).filter(Boolean);
  if (terms.length === 0) return map.nodes.map((node) => ({ node, score: 0 }));
  const hits: MapHit[] = [];
  for (const node of map.nodes) {
    const id = node.id.toLowerCase();
    const summary = node.summary.toLowerCase();
    const covers = node.covers.join(' ').toLowerCase();
    const body = node.body.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (id.includes(t)) score += 6;
      if (summary.includes(t)) score += 4;
      if (node.kind.toLowerCase() === t) score += 2;
      if (covers.includes(t)) score += 2;
      if (body.includes(t)) score += 1;
    }
    if (score > 0) hits.push({ node, score });
  }
  hits.sort((a, b) => b.score - a.score || cmp(a.node.id, b.node.id));
  return hits.slice(0, limit);
}

/** The node `id` names: exact, or the one node whose id ends in `/<id>`. */
export function findNode(map: ProjectMap, id: string): MapNode {
  const want = nodeIdOf(slashPath(id.replace(/^\.swarmup\/map\//, '')));
  const exact = map.nodes.find((n) => n.id === want);
  if (exact) return exact;
  const tail = map.nodes.filter((n) => n.id.endsWith(`/${want}`));
  if (tail.length === 1) return tail[0]!;
  if (tail.length > 1) {
    throw new OpsError(`'${id}' names several nodes: ${tail.map((n) => n.id).join(', ')}`, 2);
  }
  throw new OpsError(`no map node '${id}': run \`swarmup map\` to list them`, 1);
}

/** The nodes `node` links to, and the ones that link to it. */
export function nodeNeighbours(
  map: ProjectMap,
  node: MapNode,
): { links: MapNode[]; from: MapNode[] } {
  const ids = new Set(map.nodes.map((n) => n.id));
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const links = node.links
    .map((l) => resolveLink(node, l, ids))
    .filter((x): x is string => !!x)
    .map((id) => byId.get(id)!);
  const from = map.nodes.filter(
    (n) => n.id !== node.id && n.links.some((l) => resolveLink(n, l, ids) === node.id),
  );
  return { links, from };
}

/** A path from `cwd` (absolute or relative), as a path from the project top. */
export function pathInProject(top: string, cwd: string, path: string): string {
  const abs = isAbsolute(path) ? path : resolve(cwd, path);
  return relative(top, abs).split(sep).join('/');
}

// ---- Run prompts -----------------------------------------------------------------------------

/** What a run's prompt says about the project's map. */
export interface MapPrompt {
  /** The root node's summary. */
  root: string;
  /** Nodes that may matter to the task, best first. */
  nodes: Array<{ id: string; kind: string; summary: string }>;
  /** `map check` warnings for the reviewed change, when a caller computed them off the launch. */
  warnings?: string[];
  /** For a review run: the `map check` command that lists the reviewed change's warnings. */
  check?: string;
}

/** The words of a node id or a task text an id can match: short ones too (`map`, `ui`, `cli`). */
function idWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (raw.length < 2 || /^\d+$/.test(raw)) continue;
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

/**
 * The nodes that may matter to a task, best first: the ones that cover its files, then the ones
 * whose id (3 points), summary or kind (2 points) share a word with its title, or with its
 * description (1 point). Words that more than half the nodes share count for nothing.
 */
export function mapNodesFor(
  map: ProjectMap,
  task: { title: string; body?: string; files?: string[] },
  limit = 5,
): MapNode[] {
  const nodes = map.nodes.filter((n) => n.id !== MAP_ROOT_ID);
  const score = new Map<string, number>();
  const add = (id: string, s: number): void => {
    score.set(id, (score.get(id) ?? 0) + s);
  };
  for (const f of task.files ?? []) {
    for (const n of nodesCovering(map, f)) if (n.id !== MAP_ROOT_ID) add(n.id, 10);
  }
  const text = `${task.title}\n${task.body ?? ''}`;
  const title = new Set([...topicWords(task.title), ...idWords(task.title)]);
  const all = new Set([...topicWords(text), ...idWords(text)]);
  const words = new Map(
    nodes.map((n) => {
      const id = idWords(n.id);
      return [n.id, { id, head: topicWords(`${n.summary} ${n.kind}`) }] as const;
    }),
  );
  const freq = new Map<string, number>();
  for (const w of words.values()) {
    for (const x of new Set([...w.id, ...w.head])) freq.set(x, (freq.get(x) ?? 0) + 1);
  }
  const common = (w: string): boolean => nodes.length >= 4 && (freq.get(w) ?? 0) > nodes.length / 2;
  for (const n of nodes) {
    const { id, head } = words.get(n.id)!;
    let s = 0;
    for (const w of new Set([...id, ...head])) {
      if (common(w) || !all.has(w)) continue;
      s += title.has(w) ? (id.has(w) ? 3 : 2) : 1;
    }
    if (s > 0) add(n.id, s);
  }
  return nodes
    .filter((n) => (score.get(n.id) ?? 0) >= 2)
    .sort((a, b) => score.get(b.id)! - score.get(a.id)! || cmp(a.id, b.id))
    .slice(0, limit);
}

/** The map block of a run's prompt for the project at `top`, or null when it has no map. */
export function mapPromptOf(
  top: string,
  task: { title: string; body?: string; files?: string[] },
  limit = 5,
): MapPrompt | null {
  const map = readMap(top);
  if (!map) return null;
  const root = map.nodes.find((n) => n.id === MAP_ROOT_ID);
  return {
    root: root?.summary ?? '',
    nodes: mapNodesFor(map, task, limit).map(({ id, kind, summary }) => ({ id, kind, summary })),
  };
}

/**
 * The `map check` warnings for a reviewed commit, against the map the checkout at `top` has: what
 * changed between where `commit` left `base` and `commit`. Empty when git cannot tell.
 */
export function mapReviewWarnings(top: string, commit: string, base?: string): string[] {
  try {
    const b = base ?? mapBase(top)?.ref;
    if (!b) return [];
    const out = git(top, ['diff', '--name-status', '--no-renames', '-z', `${b}...${commit}`]);
    const parts = out.split('\0').filter(Boolean);
    const changes: MapChange[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      changes.push({ path: parts[i + 1]!, deleted: parts[i]!.startsWith('D') });
    }
    if (changes.length === 0) return [];
    return checkMap(top, { changes })
      .warnings.filter((w) => w.code === 'node-not-updated')
      .map((w) => w.message);
  } catch {
    return [];
  }
}

/**
 * The lines of a run's prompt about the map. A work run is told to keep the nodes true, a review
 * run to check that the change left none wrong, and a question run (`read`) only where they are.
 */
export function mapPromptLines(m: MapPrompt, mode: 'work' | 'review' | 'read' = 'work'): string[] {
  const lines = ['', `Project map (\`${MAP_DIR}/\`): ${m.root || 'the root node has no summary'}`];
  if (m.nodes.length > 0) {
    lines.push('Map nodes that may apply; read the ones that fit with `swarmup map show <id>`:');
    for (const n of m.nodes) lines.push(`- \`${n.id}\` (${n.kind}): ${n.summary}`);
  } else {
    lines.push(
      'Find the nodes that apply with `swarmup map <words>` or `swarmup map --file <path>`.',
    );
  }
  if (mode === 'review') {
    lines.push(
      'Check whether the change made any map node wrong or left a changed area without one; if',
      'so, ask for the node fix with the work.',
    );
    if (m.warnings && m.warnings.length > 0) {
      lines.push(
        '`swarmup map check` warns about this change:',
        ...m.warnings.slice(0, 10).map((w) => `- ${w}`),
      );
    } else if (m.check) {
      lines.push(
        `Run \`${m.check}\` in the reviewed checkout: its warnings name nodes whose files changed`,
        'while the node did not.',
      );
    }
  } else if (mode === 'work') {
    lines.push(
      'Read nodes on demand, not all of them. Keep them true: when your change makes a node wrong',
      'or adds an area no node covers, update or add the node on the task branch in the same',
      'commit, then run `swarmup map index` and `swarmup map check` before you ask for review.',
    );
  }
  return lines;
}

// ---- Init ------------------------------------------------------------------------------------

const WEBSITE_FRAMEWORKS = new Set([
  'next',
  'nuxt',
  'astro',
  'sveltekit',
  'hugo',
  'jekyll',
  'mkdocs',
  'gatsby',
  'docusaurus',
  'eleventy',
]);

/**
 * The project type of the folder at `top`: a website when it is mostly pages or uses a site
 * framework, code when it has a package manifest or source files, else a campaign (content).
 */
export function detectMapType(
  top: string,
  survey?: { stacks: string[]; frameworks: string[] },
): MapType {
  if (survey?.frameworks.some((f) => WEBSITE_FRAMEWORKS.has(f))) return 'website';
  const files = projectFiles(top).filter((f) => !f.startsWith('.'));
  const count = (re: RegExp): number => files.filter((f) => re.test(f)).length;
  const pages = count(/\.(html?|astro|mdx|njk|liquid|hbs|vue|svelte)$/i);
  const code = count(/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|rb|php|c|cc|cpp|h|swift)$/i);
  const docs = count(/\.(md|txt|docx?)$/i);
  if (pages > 0 && pages >= code) return 'website';
  if ((survey?.stacks.length ?? 0) > 0 || code > 0) return 'code';
  return docs > 0 || files.length === 0 ? 'campaign' : 'code';
}

const MAP_README = `# Project map

This folder holds the project map: linked Markdown nodes that say what each part of the project
is for, so an agent reads the one or two nodes it needs instead of the whole project.

- A node is \`<name>.md\` or \`<name>/index.md\`; its id is the path without \`.md\` or \`/index\`.
  \`index.md\` here is the root node.
- Frontmatter: \`kind\`, \`summary\` (at most 120 characters), \`covers\` (paths or globs from the
  project top, an \`#anchor\` suffix allowed, or http(s) URLs), \`links\` (node ids, relative to the
  node's folder or to this folder), \`verified\` (a commit, optional) and \`review_after\` (a date,
  required when \`covers\` has a URL).
- Body: purpose, how it works, invariants, entry points, gotchas. At most 60 lines; the root at
  most 40. Split a longer node into linked ones.
- Kinds: code \`module, service, entry, data, flow\`; website \`page, section, component,
  content-source\`; campaign \`campaign, audience, message, channel, asset, calendar, metric\`;
  any project \`goal\` and \`area\`. \`kinds.yml\` here adds more.
- \`ignore\` lists changed paths that need no node, one glob per line.
- \`_INDEX.md\` is generated by \`swarmup map index\`; never edit it.

Commands: \`swarmup map <words>\`, \`swarmup map --file <path>\`, \`swarmup map show <id>\`,
\`swarmup map index\` and \`swarmup map check [--base REF]\`.
`;

const IGNORE_TEXT = `# Changed paths that need no map node, one glob per line (gitignore-like). Built in:
# the map and the task store, node_modules/, dist/, build/, out/, coverage/ and lockfiles.
`;

const ROOT_BODY: Record<MapType, string> = {
  code: 'Areas: link the top modules, services and entry points here.',
  website: 'Areas: link the top pages, sections and content sources here.',
  campaign: 'Areas: link the campaigns, audiences, channels and calendar here.',
};

export interface MapInit {
  dir: string;
  type: MapType;
  files: string[];
}

/** Writes a new map: the root node, `ignore`, `README.md` and `_INDEX.md`. Writes no content. */
export function initMap(top: string, opts: { type?: MapType; name?: string } = {}): MapInit {
  if (mapDirOf(top)) throw new OpsError(`${join(top, MAP_DIR)} exists already`, 1);
  if (opts.type && !MAP_TYPES.includes(opts.type)) {
    throw new OpsError(`no map type '${opts.type}': use ${MAP_TYPES.join(', ')}`, 2);
  }
  const type = opts.type ?? detectMapType(top);
  const dir = join(top, ...MAP_DIR.split('/'));
  mkdirSync(dir, { recursive: true });
  const name = opts.name ?? posix.basename(top.split(sep).join('/'));
  const root = [
    '---',
    'kind: root',
    `type: ${type}`,
    `summary: 'What ${name.replace(/'/g, "''")} is, in one line (replace this).'`,
    'links: []',
    '---',
    '',
    `# ${name}`,
    '',
    'What the project is, who it is for and where its work happens.',
    '',
    ROOT_BODY[type],
    '',
  ].join('\n');
  writeFileSync(join(dir, 'index.md'), root);
  writeFileSync(join(dir, 'ignore'), IGNORE_TEXT);
  writeFileSync(join(dir, 'README.md'), MAP_README);
  writeMapIndex(readMap(top)!);
  return { dir, type, files: ['index.md', 'ignore', 'README.md', '_INDEX.md'] };
}
