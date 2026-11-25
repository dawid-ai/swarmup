// Run artifacts (W4): what a run produces besides commits (screenshots, rendered images,
// reports, test output, PDFs), kept with the run record so a reviewer, the person and scorers can
// see them after the run's scratch folder is gone. A run declares a file with
// `swarmup run artifact PATH`, or writes it into `<scratch>/artifacts/`; swarmupd copies them into
// `<state>/artifacts/<run>/` with a manifest, within limits, and prunes old folders. A file is
// only ever stored and served, never run. Paths that leave the run's folders, through `..`, a
// symlink or a junction, are refused.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { JudgeArtifact, OpsEvent, ReviewArtifact } from '@swarmup/core';
import { OpsError, reviewWithArtifacts } from '@swarmup/core';

/** The folder a run writes artifacts into, in its scratch folder; and swarmupd's kept folder. */
export const ARTIFACTS_FOLDER = 'artifacts';
/** The manifest in a run's kept folder. */
export const ARTIFACT_MANIFEST = 'manifest.json';

/** `swarmupd.artifacts`: how much of a run swarmupd keeps, and for how long. */
export interface ArtifactLimits {
  /** Most files kept per run. */
  max_files: number;
  /** Most megabytes kept per run, all files together. */
  max_mb: number;
  /** Days a run's kept artifacts stay after the run ends. */
  keep_days: number;
}

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = { max_files: 20, max_mb: 25, keep_days: 30 };

/** One kept file, in the manifest. */
export interface RunArtifact {
  /** Its file name in the kept folder: one segment, unique in the run. */
  name: string;
  /** Where swarmupd copied it from. */
  path: string;
  label?: string;
  bytes: number;
  /** Its media type, from the file name. */
  type: string;
  sha256: string;
  /** Named with `swarmup run artifact`; else found in `<scratch>/artifacts/`. */
  declared?: boolean;
}

/** `<state>/artifacts/<run>/manifest.json`. */
export interface RunArtifactManifest {
  run: string;
  /** When swarmupd last copied the files. */
  kept_at: string;
  artifacts: RunArtifact[];
  /** What `swarmup run artifact` named, so a later copy takes the newest bytes of each. */
  declared: Array<{ path: string; label?: string }>;
  /** Files left out, with why: over a limit, gone, or outside the run's folders. */
  skipped?: Array<{ path: string; why: string }>;
}

/** What a run record keeps of each artifact. */
export type RunArtifactBrief = Pick<RunArtifact, 'name' | 'label' | 'bytes' | 'type'>;

/** A declared path that swarmupd will not keep. */
export class ArtifactRefused extends OpsError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'ArtifactRefused';
  }
}

/** No such run artifact. */
export class NoRunArtifact extends Error {}

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  out: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

/** The media type of a file name; unknown ones are `application/octet-stream`. */
export function artifactType(name: string): string {
  return TYPES[extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Images a browser shows without running anything: served inline. SVG goes as a download. */
export const INLINE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);

/** True for a type the desktop previews as text. */
export function isTextType(type: string): boolean {
  return type.startsWith('text/') || type === 'application/json' || type === 'application/xml';
}

/** The kept folder of every run's artifacts, and of one run's. */
export function artifactsRoot(stateDir: string): string {
  return join(stateDir, ARTIFACTS_FOLDER);
}

export function runArtifactsDir(stateDir: string, run: string): string {
  if (!/^[0-9A-Za-z]{1,64}$/.test(run)) throw new OpsError(`bad run id '${run}'`, 2);
  return join(artifactsRoot(stateDir), run);
}

/** The run's manifest, or null when it kept nothing. */
export async function readManifest(
  stateDir: string,
  run: string,
): Promise<RunArtifactManifest | null> {
  try {
    const m = JSON.parse(
      await readFile(join(runArtifactsDir(stateDir, run), ARTIFACT_MANIFEST), 'utf8'),
    );
    return m && Array.isArray(m.artifacts) ? (m as RunArtifactManifest) : null;
  } catch {
    return null;
  }
}

const WINDOWS = process.platform === 'win32';

function norm(p: string): string {
  const r = resolve(p);
  return WINDOWS ? r.toLowerCase() : r;
}

/** True when `path` is `dir` or inside it; both real paths. */
function within(dir: string, path: string): boolean {
  const d = norm(dir);
  const p = norm(path);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * The real path of `path` when it, with every symlink and junction on the way resolved, is
 * inside one of `roots` (real paths too); else null. A missing path is null.
 */
export async function realInside(path: string, roots: readonly string[]): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return null;
  }
  for (const root of roots) {
    let r: string;
    try {
      r = await realpath(root);
    } catch {
      continue;
    }
    if (within(r, real)) return real;
  }
  return null;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

/** A file name safe on every OS and in a URL segment: the base name with odd characters as `_`. */
export function safeName(path: string): string {
  let name = basename(path.replace(/\\/g, '/'))
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '');
  if (!name) name = 'file';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = extname(name).slice(0, 16);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function uniqueName(want: string, taken: Set<string>): string {
  let name = want;
  const ext = extname(want);
  const stem = want.slice(0, want.length - ext.length);
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Files in `<scratch>/artifacts/`, sorted, at most 4 folders deep; symlinks and junctions skipped. */
async function folderFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (out.length >= 500) return;
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (depth < 4) await walk(p, depth + 1);
      } else if (e.isFile()) out.push(p);
    }
  };
  await walk(dir, 0);
  return out;
}

/** One copy at a time per run: a declaration and the run's end may come together. */
const chains = new Map<string, Promise<unknown>>();

function serial<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(job, job);
  const tail = next.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return next;
}

export interface KeepOptions {
  stateDir: string;
  run: string;
  /** The run's scratch folder: its `artifacts/` folder is swept, and declared paths may be in it. */
  scratch?: string;
  /** Folders besides the scratch folder a declared path may be in: the run's worktree. */
  roots: readonly string[];
  limits: ArtifactLimits;
  /** A path `swarmup run artifact` names, with its label. */
  declare?: { path: string; label?: string };
  now?: () => number;
}

/**
 * Copies a run's artifacts into its kept folder and writes the manifest: the declared files in
 * the order they were named, then the files in `<scratch>/artifacts/`, within `max_files` and
 * `max_mb`. A file kept before keeps its name, and a file gone since is removed. With `declare`,
 * the path must be a file inside the scratch folder or a root, or it is refused with
 * {@link ArtifactRefused}. Returns the manifest; one with no artifacts is not written.
 */
export function keepRunArtifacts(o: KeepOptions): Promise<RunArtifactManifest> {
  return serial(`${o.stateDir}\0${o.run}`, () => keep(o));
}

async function keep(o: KeepOptions): Promise<RunArtifactManifest> {
  const dir = runArtifactsDir(o.stateDir, o.run);
  const prev = await readManifest(o.stateDir, o.run);
  const allowed = [...(o.scratch ? [o.scratch] : []), ...o.roots];
  const maxBytes = Math.round(o.limits.max_mb * 1024 * 1024);
  const declared = [...(prev?.declared ?? [])];
  if (o.declare) {
    const abs = resolve(o.declare.path);
    const real = await realInside(abs, allowed);
    if (!real) {
      let exists = true;
      try {
        await lstat(abs);
      } catch {
        exists = false;
      }
      throw new ArtifactRefused(
        exists
          ? `${o.declare.path} is outside the run's scratch folder and worktree; keep only files the run made there`
          : `${o.declare.path}: no such file`,
      );
    }
    const st = await stat(real);
    if (!st.isFile()) throw new ArtifactRefused(`${o.declare.path} is not a file`);
    if (st.size > maxBytes) {
      throw new ArtifactRefused(
        `${o.declare.path} is ${mb(st.size)} MB; a run keeps ${o.limits.max_mb} MB at most (swarmupd.artifacts.max_mb)`,
      );
    }
    const at = declared.findIndex((d) => norm(d.path) === norm(real));
    const entry = {
      path: real,
      ...(o.declare.label?.trim() ? { label: o.declare.label.trim() } : {}),
    };
    if (at >= 0) declared[at] = entry;
    else {
      if (declared.length >= o.limits.max_files) {
        throw new ArtifactRefused(
          `run ${o.run} declared ${o.limits.max_files} artifacts already (swarmupd.artifacts.max_files)`,
        );
      }
      declared.push(entry);
    }
  }
  const candidates: Array<{ path: string; label?: string; declared: boolean; roots: string[] }> =
    declared.map((d) => ({ path: d.path, label: d.label, declared: true, roots: allowed }));
  if (o.scratch) {
    const folder = join(o.scratch, ARTIFACTS_FOLDER);
    for (const p of await folderFiles(folder)) {
      candidates.push({ path: p, declared: false, roots: [folder] });
    }
  }
  const prevNames = new Map((prev?.artifacts ?? []).map((a) => [norm(a.path), a.name]));
  const taken = new Set<string>([ARTIFACT_MANIFEST.toLowerCase()]);
  // Names kept before stay theirs, so links to them keep working.
  for (const c of candidates) {
    const n = prevNames.get(norm(c.path));
    if (n) taken.add(n.toLowerCase());
  }
  const kept: Array<RunArtifact & { data: Buffer }> = [];
  const skipped: Array<{ path: string; why: string }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const c of candidates) {
    const real = await realInside(c.path, c.roots);
    if (!real) {
      skipped.push({ path: c.path, why: 'gone, or outside the run folders' });
      continue;
    }
    if (seen.has(norm(real))) continue;
    seen.add(norm(real));
    let data: Buffer;
    try {
      const st = await stat(real);
      if (!st.isFile()) {
        skipped.push({ path: c.path, why: 'not a file' });
        continue;
      }
      if (kept.length >= o.limits.max_files) {
        skipped.push({ path: c.path, why: `over max_files (${o.limits.max_files})` });
        continue;
      }
      if (total + st.size > maxBytes) {
        skipped.push({ path: c.path, why: `over max_mb (${o.limits.max_mb} MB)` });
        continue;
      }
      data = await readFile(real);
    } catch {
      skipped.push({ path: c.path, why: 'unreadable' });
      continue;
    }
    if (total + data.length > maxBytes) {
      skipped.push({ path: c.path, why: `over max_mb (${o.limits.max_mb} MB)` });
      continue;
    }
    total += data.length;
    const before = prevNames.get(norm(c.path));
    const name = before ?? uniqueName(safeName(real), taken);
    kept.push({
      name,
      path: c.path,
      ...(c.label ? { label: c.label } : {}),
      bytes: data.length,
      type: artifactType(name),
      sha256: createHash('sha256').update(data).digest('hex'),
      ...(c.declared ? { declared: true } : {}),
      data,
    });
  }
  const manifest: RunArtifactManifest = {
    run: o.run,
    kept_at: new Date(o.now?.() ?? Date.now()).toISOString(),
    artifacts: kept.map(({ data: _data, ...a }) => a),
    declared,
    ...(skipped.length > 0 ? { skipped } : {}),
  };
  if (kept.length === 0 && declared.length === 0 && !prev) return manifest;
  await mkdir(dir, { recursive: true });
  const prevSha = new Map((prev?.artifacts ?? []).map((a) => [a.name, a.sha256]));
  for (const a of kept) {
    const file = join(dir, a.name);
    if (prevSha.get(a.name) === a.sha256) {
      try {
        if ((await stat(file)).size === a.bytes) continue;
      } catch {
        // Gone: write it again.
      }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, a.data);
    await rename(tmp, file);
  }
  const names = new Set(
    [ARTIFACT_MANIFEST, ...kept.map((a) => a.name)].map((n) => n.toLowerCase()),
  );
  for (const name of await readdir(dir)) {
    if (!names.has(name.toLowerCase())) await rm(join(dir, name), { force: true, recursive: true });
  }
  const tmp = join(dir, `${ARTIFACT_MANIFEST}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(manifest, null, 2));
  await rename(tmp, join(dir, ARTIFACT_MANIFEST));
  return manifest;
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

/** What a run record keeps of a manifest. */
export function artifactBriefs(m: RunArtifactManifest): RunArtifactBrief[] {
  return m.artifacts.map((a) => ({
    name: a.name,
    ...(a.label ? { label: a.label } : {}),
    bytes: a.bytes,
    type: a.type,
  }));
}

/** A run's kept artifacts as review artifacts of kind `run`, for the review that names them. */
export function runReviewArtifacts(
  run: string,
  list: ReadonlyArray<RunArtifactBrief & { sha256?: string }>,
): ReviewArtifact[] {
  return list.map((a) => ({
    kind: 'run',
    ref: a.name,
    run,
    ...(a.label ? { label: a.label } : {}),
    bytes: a.bytes,
    type: a.type,
    ...(a.sha256 ? { sha256: a.sha256 } : {}),
  }));
}

/**
 * The run artifacts the task's latest review with artifacts names, for a rubric with the
 * `artifacts` input: text files with their text (each cut at {@link VIEW_TEXT_MAX}), others by
 * name, type and size. A file no longer kept is left out.
 */
export async function judgeArtifactsOf(
  stateDir: string,
  events: readonly OpsEvent[],
): Promise<JudgeArtifact[]> {
  const items = (reviewWithArtifacts(events)?.artifacts ?? []).filter(
    (a) => a.kind === 'run' && a.run,
  );
  const out: JudgeArtifact[] = [];
  for (const a of items) {
    let got: { artifact: RunArtifact; data: Buffer };
    try {
      got = await readRunArtifact(stateDir, a.run!, a.ref);
    } catch {
      continue;
    }
    const { artifact, data } = got;
    out.push({
      name: artifact.name,
      type: artifact.type,
      bytes: artifact.bytes,
      ...(artifact.label ? { label: artifact.label } : {}),
      ...(isTextType(artifact.type)
        ? { text: data.subarray(0, VIEW_TEXT_MAX).toString('utf8') }
        : {}),
    });
  }
  return out;
}

/** One kept file of a run and its bytes; {@link NoRunArtifact} when the run kept no such file. */
export async function readRunArtifact(
  stateDir: string,
  run: string,
  name: string,
): Promise<{ artifact: RunArtifact; data: Buffer }> {
  const m = await readManifest(stateDir, run);
  const artifact = m?.artifacts.find((a) => a.name === name);
  if (!artifact) throw new NoRunArtifact(`run ${run} kept no artifact ${name}`);
  try {
    return { artifact, data: await readFile(join(runArtifactsDir(stateDir, run), artifact.name)) };
  } catch {
    throw new NoRunArtifact(`run ${run}: ${name} is gone from the kept folder`);
  }
}

/** The largest image and text the desktop view sends. */
export const VIEW_IMAGE_MAX = 8 * 1024 * 1024;
export const VIEW_TEXT_MAX = 256 * 1024;

/** `GET /api/runs/:id/artifacts/:name?view=1`: one artifact for the desktop to show. */
export interface RunArtifactView {
  name: string;
  label?: string;
  type: string;
  bytes: number;
  sha256: string;
  /** image: shown from a data URL; text: shown as text; file: listed for download only. */
  kind: 'image' | 'text' | 'file';
  data?: string;
  text?: string;
  /** text: cut at {@link VIEW_TEXT_MAX}. */
  cut?: boolean;
  /** Where swarmupd keeps it on this PC. */
  file: string;
}

export function artifactView(
  stateDir: string,
  artifact: RunArtifact,
  run: string,
  data: Buffer,
): RunArtifactView {
  const base = {
    name: artifact.name,
    ...(artifact.label ? { label: artifact.label } : {}),
    type: artifact.type,
    bytes: data.length,
    sha256: artifact.sha256,
    file: join(runArtifactsDir(stateDir, run), artifact.name),
  };
  if (artifact.type.startsWith('image/') && data.length <= VIEW_IMAGE_MAX) {
    return {
      ...base,
      kind: 'image',
      data: `data:${artifact.type};base64,${data.toString('base64')}`,
    };
  }
  if (isTextType(artifact.type)) {
    const cut = data.length > VIEW_TEXT_MAX;
    return {
      ...base,
      kind: 'text',
      text: data.subarray(0, VIEW_TEXT_MAX).toString('utf8'),
      ...(cut ? { cut } : {}),
    };
  }
  return { ...base, kind: 'file' };
}

/**
 * Headers for serving a kept file: plain images inline, everything else as a download of
 * `application/octet-stream` (an SVG, an HTML report and a PDF included), never sniffed, never
 * run as a page.
 */
export function artifactHeaders(
  a: Pick<RunArtifact, 'name' | 'type'>,
  bytes: number,
): Record<string, string> {
  const inline = INLINE_TYPES.has(a.type);
  const ascii = a.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return {
    'content-type': inline ? a.type : 'application/octet-stream',
    'content-length': String(bytes),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': 'private, no-cache',
  };
}

/**
 * Removes the kept folders of runs that ended more than `keepDays` ago. `endedAt` gives a run's
 * end (ms), `'running'` for a live run, or undefined when swarmupd has no record of it: then the
 * manifest's time counts, else the folder's. Returns how many it removed.
 */
export async function pruneRunArtifacts(
  stateDir: string,
  keepDays: number,
  now: number,
  endedAt: (run: string) => number | 'running' | undefined,
  stopping: () => boolean = () => false,
): Promise<number> {
  const root = artifactsRoot(stateDir);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  const cutoff = now - keepDays * 24 * 3_600_000;
  let removed = 0;
  for (const name of names) {
    if (stopping()) break;
    if (!/^[0-9A-Za-z]{1,64}$/.test(name)) continue;
    const ended = endedAt(name);
    if (ended === 'running') continue;
    let at = ended;
    if (at === undefined) {
      const m = await readManifest(stateDir, name);
      at = m ? Date.parse(m.kept_at) : undefined;
      if (at === undefined || Number.isNaN(at)) {
        try {
          at = (await stat(join(root, name))).mtimeMs;
        } catch {
          continue;
        }
      }
    }
    if (at > cutoff) continue;
    try {
      await rm(join(root, name), { recursive: true, force: true });
      removed++;
    } catch {
      // The next sweep tries again.
    }
  }
  return removed;
}
