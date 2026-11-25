import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { envVar } from './env.js';
import { assertActor, isHuman, OpsError } from './ids.js';

export const SYNC_POLICIES = ['manual', 'checkpoint', 'coordinated'] as const;
export type SyncPolicy = (typeof SYNC_POLICIES)[number];

/** `<root>/config.yml`: shared by everyone who uses the root. A root has `swarmup: 2`. */
export interface RootConfig {
  swarmup?: 2;
  name: string;
  /** Task id prefix, such as `T` for `T-0001`. */
  id_prefix: string;
  /** Who answers asks and reviews when no one is named. */
  human?: string;
  sync: {
    policy: SyncPolicy;
    pull_minutes: number;
    push_minutes: number;
    remote?: string;
    /**
     * The branch that holds the store. Sync commits only while the root's checkout is on it.
     * Default: the branch this clone learned on its first sync, the one holding the newest store
     * commit.
     */
    branch?: string;
  };
  leases: {
    claim_minutes: number;
    work_minutes: number;
  };
  /**
   * Mirror this project root into the SwarmUp Master Repo (`master` in the user config), as
   * `<master>/mirrors/<name>/`. Opt-in per project root.
   */
  mirror?: boolean;
  /**
   * The project of a task that names none. Default: `name`. swarmupd counts runs per project, so every
   * task in one checkout should resolve to one project.
   */
  project?: string;
  /**
   * Old project names and the project each now reads as, such as `v2: swarmup`. Tasks keep the
   * name they were filed with in `task.md`; every reader sees the new one.
   */
  project_aliases?: Record<string, string>;
  /**
   * `swarmup new` and `POST /api/tasks` refuse work without a checkable criterion: one in
   * `done_when` that is not prose. Default false: they print a note instead.
   */
  require_checkable_criteria?: boolean;
  /**
   * Task types whose work happens in a workspace on a branch (W8): swarmupd gives a run on one its
   * own worktree, and `swarmup review` refuses an agent's request that leaves the checkout
   * uncommitted. Default `DEFAULT_WORKSPACE_TYPES`; a content project adds `docs` and `content`.
   */
  workspace_types?: string[];
}

/** Task types whose work happens on a branch when a root sets no `workspace_types`. */
export const DEFAULT_WORKSPACE_TYPES: readonly string[] = ['task', 'bug', 'feature'];

/**
 * The task types of `root` whose work happens in a workspace on a branch: its `workspace_types`,
 * else `DEFAULT_WORKSPACE_TYPES`. A list that is not a list of names reads as the default.
 */
export function workspaceTypes(root: { config: Pick<RootConfig, 'workspace_types'> }): Set<string> {
  const list = root.config.workspace_types;
  const ok =
    Array.isArray(list) && list.length > 0 && list.every((t) => typeof t === 'string' && t.trim());
  return new Set(ok ? list.map((t) => t.trim()) : DEFAULT_WORKSPACE_TYPES);
}

/** Per-machine settings, never committed: `SWARMUP_CONFIG` or the user config file. */
export interface UserConfig {
  /** The human using this machine, such as `human:dawid`. */
  me?: string;
  /** Data roots to read besides the one found from the working directory. */
  roots?: string[];
  /**
   * Per-root options, keyed by the folder as `roots` lists it (AO-0353). Kept beside `roots` so
   * that list stays plain folders for every reader, older builds included.
   */
  root_options?: Record<string, RootOptions>;
  /**
   * The SwarmUp Master Repo: one data root for every project. It is read like any root, its
   * mirror roots show the projects that mirror into it, and mirrored project roots sync with it.
   */
  master?: string;
  /** Machine name for sync commit messages; left out when unset. */
  machine?: string;
  /**
   * Task number block for this machine. Block 0 allocates 1-9999, block 1 allocates 10001-19999,
   * so machines that create tasks between syncs never pick the same id.
   */
  id_block?: number;
}

/** One root's options in the user config (`root_options.<folder>`). */
export interface RootOptions {
  /** No reader loads an archived root: it is off the board and swarmupd runs none of its tasks. */
  archived?: boolean;
  /**
   * The root's own name, recorded when it is archived. Its Master Repo mirror stays hidden by this
   * name even when the folder goes missing or cannot be read.
   */
  name?: string;
  /** The name the app shows for the project; the root's own `name` stays its id. */
  label?: string;
}

/** The options the user config holds for a root, or an empty object. */
export function rootOptionsOf(user: UserConfig, root: string): RootOptions {
  const all = user.root_options;
  if (!all || typeof all !== 'object') return {};
  for (const [key, value] of Object.entries(all)) {
    if (value && typeof value === 'object' && sameRoot(key, root)) return value;
  }
  return {};
}

/** The folders the user config marks archived. */
export function archivedRoots(user: UserConfig): string[] {
  return archivedEntries(user).map(([key]) => key);
}

function archivedEntries(user: UserConfig): [string, RootOptions][] {
  const all = user.root_options;
  if (!all || typeof all !== 'object') return [];
  return Object.entries(all).filter(([, o]) => o && typeof o === 'object' && o.archived === true);
}

/**
 * The root names of the archived roots: the name each folder's config holds, and the one recorded
 * at archive time, so a folder that is gone or unreadable still hides its Master Repo mirror.
 */
export function archivedRootNames(user: UserConfig): string[] {
  const names = new Set<string>();
  for (const [key, opts] of archivedEntries(user)) {
    if (typeof opts.name === 'string' && opts.name) names.add(opts.name);
    const name = existsSync(key) ? rootNameOf(storeDirIn(key) ?? key) : null;
    if (name) names.add(name);
  }
  return [...names];
}

/** The user config key that holds swarmupd's settings, such as `swarmupd.agents`. */
export const DAEMON_KEY = 'swarmupd';
/** The same key before the rename. Read when the config has no `swarmupd` key. */
export const OLD_DAEMON_KEY = 'opsd';

/**
 * swarmupd's section of a user config: `swarmupd`, else the old `opsd`. The two are never merged:
 * a config with both uses `swarmupd` alone, so one section holds every setting. An empty
 * `swarmupd:` counts as present, the same as in `daemonKeyIn`: reads and edits use one key.
 */
export function daemonSection(user: UserConfig): Record<string, unknown> | undefined {
  const u = user as Record<string, unknown>;
  const section = Object.hasOwn(u, DAEMON_KEY) ? u[DAEMON_KEY] : u[OLD_DAEMON_KEY];
  return section && typeof section === 'object' && !Array.isArray(section)
    ? (section as Record<string, unknown>)
    : undefined;
}

/**
 * The key an edit of the user config writes swarmupd's settings under: `swarmupd`, or the old
 * `opsd` while the file holds only that one. An edit never renames or moves a person's section.
 * A section left empty (`swarmupd:` with no value) becomes an empty map here, because `setIn`
 * refuses to write a setting under a null.
 */
export function daemonKeyIn(doc: YAML.Document): string {
  const key = !doc.has(DAEMON_KEY) && doc.has(OLD_DAEMON_KEY) ? OLD_DAEMON_KEY : DAEMON_KEY;
  if (doc.has(key) && doc.get(key) == null) doc.set(key, doc.createNode({}));
  return key;
}

/** The store folder inside a repo. */
export const ROOT_DIR_NAME = '.swarmup';
export const ID_BLOCK_SIZE = 10_000;

/** The store folder of `repo`: `.swarmup/` when it holds a config.yml, else null. */
export function storeDirIn(repo: string): string | null {
  const dir = join(repo, ROOT_DIR_NAME);
  return existsSync(join(dir, 'config.yml')) ? dir : null;
}

/** True when `name` is the store folder name. */
export function isStoreDirName(name: string): boolean {
  return name === ROOT_DIR_NAME;
}

export function defaultRootConfig(name: string, prefix = 'T', human?: string): RootConfig {
  return {
    swarmup: 2,
    name,
    id_prefix: prefix,
    human,
    sync: { policy: 'checkpoint', pull_minutes: 10, push_minutes: 30 },
    leases: { claim_minutes: 60, work_minutes: 240 },
  };
}

export function readRootConfig(dir: string): RootConfig {
  const file = join(dir, 'config.yml');
  if (!existsSync(file)) throw new OpsError(`${dir} is not a data root: no config.yml`, 2);
  const raw = (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as Partial<RootConfig>;
  if (raw.swarmup !== 2) {
    throw new OpsError(`${file}: expected 'swarmup: 2'`, 2);
  }
  // The format key is checked above; the folded config does not carry it.
  const rest = { ...raw };
  delete rest.swarmup;
  const base = defaultRootConfig(raw.name ?? 'default', raw.id_prefix ?? 'T', raw.human);
  return {
    ...base,
    ...rest,
    id_prefix: (raw.id_prefix ?? 'T').toUpperCase(),
    sync: { ...base.sync, ...(raw.sync ?? {}) },
    leases: { ...base.leases, ...(raw.leases ?? {}) },
  } as RootConfig;
}

/** The user config folder: `%APPDATA%\swarmup` or `~/.config/swarmup`. */
function userConfigDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'swarmup');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'swarmup');
}

/** `SWARMUP_CONFIG`, else `%APPDATA%\swarmup\config.yml` (`~/.config/swarmup/config.yml`). */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return envVar(env, 'CONFIG') ?? join(userConfigDir(env), 'config.yml');
}

/** The file migrations log to, in the user config folder: `migrations.log`. */
export const MIGRATION_LOG = 'migrations.log';

/**
 * Appends `line`, with the time, to `<dir>/migrations.log`. Never throws: a migration that cannot
 * log still counts as done.
 */
export function logMigration(dir: string, line: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, MIGRATION_LOG), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Nowhere to log.
  }
}

/** The folder of the migration log: the user config folder, whatever `SWARMUP_CONFIG` says. */
export function migrationLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(userConfigPath(env));
}

export function readUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const file = userConfigPath(env);
  if (!existsSync(file)) return {};
  return (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as UserConfig;
}

/** `human:<OS user name>`, cleaned into a valid id, for a first-start default. */
export function defaultHumanId(): string {
  let name = '';
  try {
    name = userInfo().username;
  } catch {
    // No user name on this system.
  }
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '');
  return `human:${clean || 'me'}`;
}

export interface SetupResult {
  path: string;
  created: boolean;
  changed: boolean;
  /** The `me` the config has now: an existing one is never replaced. */
  me: string;
  roots: string[];
}

/**
 * Writes the user config on a first start: `me` and the data roots to load. A missing file is
 * created where the platform expects it, never over a file another process created meanwhile. An
 * existing one keeps everything, comments and roots included, and only gains a missing `me`.
 */
export function setupUserConfig(
  input: { me: string; roots?: string[] },
  env: NodeJS.ProcessEnv = process.env,
  /** For tests: runs right before the exclusive create, as another start could. */
  hooks: { beforeCreate?: () => void } = {},
): SetupResult {
  const me = assertActor(input.me.trim(), 'me');
  if (!isHuman(me)) throw new OpsError(`me must be a person: human:<name>, not ${me}`, 2);
  const file = userConfigPath(env);
  // An existing config only gains a missing me; the roots given are not used, so not checked.
  if (existsSync(file)) return addMe(file, me);
  // A repo and its store folder name one root; the repo is the spelling kept.
  const roots: string[] = [];
  for (const raw of input.roots ?? []) {
    if (!raw.trim()) continue;
    const r = checkRoot(raw);
    if (!roots.some((x) => sameRoot(x, r))) roots.push(r);
  }
  mkdirSync(dirname(file), { recursive: true });
  hooks.beforeCreate?.();
  try {
    // `wx`: create only; a file another start wrote first is kept and handled as existing.
    const doc = new YAML.Document(roots.length > 0 ? { me, roots } : { me });
    writeFileSync(file, doc.toString(), { flag: 'wx' });
    return { path: file, created: true, changed: true, me, roots };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return addMe(file, me);
}

/**
 * A data root as the user config lists it: the repo that holds `.swarmup/` (or a dedicated data
 * repo). Throws when the folder is not a data root.
 */
export function checkRoot(raw: string): string {
  const r = rootFolder(resolve(raw.trim()));
  const dir = storeDirIn(r) ?? r;
  try {
    readRootConfig(dir);
  } catch (err) {
    throw new OpsError(`${r} is not a data root: ${(err as Error).message}`, 2);
  }
  return r;
}

/** Whether two spellings name one root (a repo and its store folder count as one). */
export function sameRoot(x: string, y: string): boolean {
  const p = canonical(rootFolder(resolve(x)));
  const q = canonical(rootFolder(resolve(y)));
  return process.platform === 'win32' ? p.toLowerCase() === q.toLowerCase() : p === q;
}

/**
 * Changes the user config in place, keeping comments and everything `change` leaves alone.
 * `check` sees the result before it is written and throws to refuse it; nothing is written then.
 * The write goes to a temporary file first, so a crash never leaves half a config. `env` has no
 * default on purpose: the caller names whose config it edits (swarmupd passes its own env).
 */
export function editUserConfig(
  env: NodeJS.ProcessEnv,
  change: (doc: YAML.Document) => void,
  check: (next: UserConfig) => void = () => {},
): UserConfig {
  const file = userConfigPath(env);
  const doc = existsSync(file)
    ? YAML.parseDocument(readFileSync(file, 'utf8'))
    : new YAML.Document({});
  if (doc.errors.length > 0) {
    throw new OpsError(`${file}: ${doc.errors[0]!.message}; fix the file by hand first`, 2);
  }
  change(doc);
  const next = (doc.toJS() ?? {}) as UserConfig;
  check(next);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, doc.toString());
  renameSync(tmp, file);
  return next;
}

/** Adds `me` to an existing user config that lacks it, keeping everything else. */
function addMe(file: string, me: string): SetupResult {
  const doc = YAML.parseDocument(readFileSync(file, 'utf8'));
  let changed = false;
  if (!doc.get('me')) {
    doc.set('me', me);
    changed = true;
    writeFileSync(file, doc.toString());
  }
  const listed = ((doc.toJS() as { roots?: string[] } | null)?.roots ?? []).map(String);
  return { path: file, created: false, changed, me: String(doc.get('me')), roots: listed };
}

/** A root's store folder (`.swarmup`) stands for the repo that holds it. */
function rootFolder(p: string): string {
  return isStoreDirName(basename(p)) ? dirname(p) : p;
}

/**
 * The folder to suggest as a first root: the repo of the data root found from `start`, or none.
 */
export function suggestedRoot(start: string): string | null {
  const found = findRootUp(start);
  if (!found) return null;
  return rootFolder(found);
}

/** Walks up from `start` and returns the first store folder or dedicated data root. */
export function findRootUp(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const store = storeDirIn(dir);
    if (store) return store;
    if (existsSync(join(dir, 'config.yml')) && isRootConfig(join(dir, 'config.yml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isRootConfig(file: string): boolean {
  try {
    return /^swarmup:\s*2\s*$/m.test(readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

function canonical(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * With `SWARMUP_ROOTS` set, `1` here makes `SWARMUP_ROOTS` the whole list: no root is found from the
 * folder. swarmupd sets it for a run whose folder holds a copy of a root it knows, such as a task
 * worktree on a branch of the store checkout (AO-0168): that copy is stale, and `swarmup` would
 * otherwise claim and report in it.
 */
export const ROOTS_ONLY_ENV = 'SWARMUP_ROOTS_ONLY';
/** The name of {@link ROOTS_ONLY_ENV} after the prefix, for {@link envVar}. */
export const ROOTS_ONLY_NAME = 'ROOTS_ONLY';

/**
 * Lists data root folders: the one found from `cwd` first (unless {@link ROOTS_ONLY_ENV} says
 * not to), then `SWARMUP_ROOTS` (path-delimiter separated) or the user config's `roots`. Duplicates
 * are dropped.
 */
export function discoverRoots(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  user: UserConfig = readUserConfig(env),
): string[] {
  const found: string[] = [];
  const rootsEnv = envVar(env, 'ROOTS');
  const local = rootsEnv && envVar(env, ROOTS_ONLY_NAME) === '1' ? null : findRootUp(cwd);
  // An archived root (AO-0353) is left out wherever it comes from. A supervised run keeps the
  // roots swarmupd gave it in SWARMUP_ROOTS, so a run that started before the archive can finish;
  // swarmupd itself removes RUN before it discovers roots, so an inherited ROOTS cannot bypass it.
  const archived = archivedRoots(user);
  const isArchived = (p: string): boolean => archived.some((a) => sameRoot(a, p));
  const supervisedRun = Boolean(envVar(env, 'RUN'));
  if (local && !isArchived(local)) found.push(local);
  const listed = rootsEnv
    ? rootsEnv.split(delimiter).filter((r) => r && (supervisedRun || !isArchived(r)))
    : [
        ...(user.roots ?? []).map(String).filter((r) => !isArchived(r)),
        ...(user.master ? [user.master] : []),
      ];
  for (const r of listed) found.push(rootDirOf(r));
  const seen = new Set<string>();
  const roots = found.filter((p) => {
    const key = pathKey(p);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Mirror roots in a Master Repo show projects this machine does not have; a project root that
  // is loaded hides its own copy.
  const names = new Set(roots.map(rootNameOf).filter((n): n is string => n !== null));
  // An archived project stays off the board through its Master Repo copy too.
  for (const name of archivedRootNames(user)) names.add(name);
  for (const dir of [...roots]) {
    if (isMirrorDir(dir)) continue;
    for (const m of mirrorDirs(dir)) {
      const name = rootNameOf(m);
      if (!name || names.has(name) || seen.has(pathKey(m))) continue;
      names.add(name);
      seen.add(pathKey(m));
      roots.push(m);
    }
  }
  return roots;
}

/** A path given as a repo or as its data root folder, as the data root folder. */
export function rootDirOf(path: string): string {
  const p = resolve(path);
  return storeDirIn(p) ?? p;
}

function pathKey(p: string): string {
  return process.platform === 'win32' ? canonical(p).toLowerCase() : canonical(p);
}

/** True when both paths name the same folder. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** The name in a data root's config, or null when it has none that reads. */
export function rootNameOf(dir: string): string | null {
  try {
    return readRootConfig(dir).name;
  } catch {
    return null;
  }
}

/** `<root>/mirrors/<name>` inside a data root: a Master Repo's copy of a project root. */
export function isMirrorDir(dir: string): boolean {
  const parent = dirname(dir);
  return basename(parent) === 'mirrors' && existsSync(join(dirname(parent), 'config.yml'));
}

/** The mirror roots inside a data root, if it is a Master Repo. */
export function mirrorDirs(dir: string): string[] {
  const base = join(dir, 'mirrors');
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(base, d.name, 'config.yml')))
      .map((d) => join(base, d.name));
  } catch {
    return [];
  }
}
