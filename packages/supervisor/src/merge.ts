import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { MergeSource } from '@swarmup/core';
import { PATCH_KEY_ARGS, patchKey, reviewSources, ROOT_DIR_NAMES, samePath } from '@swarmup/core';
import { type GitFailure, gitAsync, type TreeStop } from './git.js';
import { killTree } from './proc.js';
import { withoutScriptEnv } from './runenv.js';

export { reviewSources };
export type { MergeSource, ReviewSources } from '@swarmup/core';

/**
 * Whether nothing is at `path`: true only when the file system says so (`ENOENT`, or `ENOTDIR`
 * for a parent that is a file). Any other failure to look (no access, a busy or unplugged
 * drive) throws, because a path that cannot be looked at is not proven missing; `existsSync`
 * answers false for both (AO-0300).
 */
export function pathGone(path: string, stat: (p: string) => unknown = statSync): boolean {
  try {
    stat(path);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw err;
  }
}

/**
 * Reads the branch and commit from a review request: `<commit> on branch <name>`, else the first
 * `branch <word>` (its tip). Without a repo to check the word against; see `pickMergeSource`.
 */
export function mergeSource(text: string): MergeSource | null {
  const s = reviewSources(text);
  return s.named ?? (s.loose[0] ? { branch: s.loose[0] } : null);
}

/**
 * Picks what to merge from a task's review requests, newest first, using `has` to check names
 * against the repo (AO-0153):
 *
 * 1. The newest review's `<commit> on branch <name>`, as it is: a commit missing from the repo
 *    gets a note to the human, not an older commit.
 * 2. Else the first `branch <word>` in it that is a branch.
 * 3. Else the newest earlier review that names a branch: that branch's tip, which holds what the
 *    approved review describes even after a rebase. A commit with no branch left counts as it is.
 *
 * Returns null when no review names a branch or commit the repo has.
 */
export function pickMergeSource(
  reviews: string[],
  has: { branch: (name: string) => boolean; commit: (sha: string) => boolean },
): MergeSource | null {
  for (const [i, text] of reviews.entries()) {
    const s = reviewSources(text);
    if (i === 0 && s.named) return s.named;
    if (i > 0 && s.named) {
      if (has.branch(s.named.branch!)) return { branch: s.named.branch };
      if (has.commit(s.named.commit!)) return s.named;
    }
    const branch = s.loose.find((b) => has.branch(b));
    if (branch) return { branch };
  }
  return null;
}

/** The folders of the code swarmupd itself runs, relative to the engine repo. */
export const OPSD_CODE = ['packages/supervisor/', 'packages/core/'];

/**
 * Which of `files` change the code swarmupd runs: files under `OPSD_CODE`, without tests and
 * Markdown, which never load in a running swarmupd.
 */
export function opsdCodeChanges(files: string[]): string[] {
  return files.filter(
    (f) =>
      OPSD_CODE.some((d) => f.startsWith(d)) &&
      !/(^|\/)test\//.test(f) &&
      !f.toLowerCase().endsWith('.md'),
  );
}

/** Lockfiles whose change in a merge leaves the build checkout's installed dependencies behind. */
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];

/**
 * The install swarmupd runs in the build checkout when a merge changed a lockfile and the config
 * names none (AO-0185). Not `npm ci`: that deletes `node_modules` first, and in a checkout that
 * swarmupd or the desktop app runs from, locked files stop it halfway and leave both broken. `npm install`
 * changes only the packages that differ from the lockfile, and `--no-save` keeps it from
 * rewriting `package-lock.json`, which would leave the checkout with changes of its own.
 */
export const DEFAULT_INSTALL = 'npm install --no-save --no-audit --no-fund';

/** Which of `files` are lockfiles, at any depth. */
export function lockfileChanges(files: string[]): string[] {
  return files.filter((f) => LOCKFILES.includes(f.slice(f.lastIndexOf('/') + 1)));
}

/**
 * The directories, relative to the checkout and with `/` separators, whose lockfile is among
 * `files`: `.` for the checkout itself. Sorted, each once.
 */
export function lockfileDirs(files: string[]): string[] {
  const dirs = lockfileChanges(files).map((f) => {
    const cut = f.lastIndexOf('/');
    return cut < 0 ? '.' : f.slice(0, cut);
  });
  return [...new Set(dirs)].sort();
}

/**
 * The commands that install dependencies in `dir` before the build: the configured `install`,
 * or `DEFAULT_INSTALL` when `dir` has an npm lockfile.
 */
export function installCommands(install: string[] | undefined, dir: string): string[] {
  if (install) return install;
  return LOCKFILES.some((f) => existsSync(join(dir, f))) ? [DEFAULT_INSTALL] : [];
}

/** The machine npm installs for: `process.platform`, `process.arch` and, on Linux, the C library. */
export interface InstallPlatform {
  os: string;
  cpu: string;
  libc?: string;
}

/** The platform swarmupd runs on, as npm's `os`, `cpu` and `libc` fields name it. */
export function installPlatform(): InstallPlatform {
  if (process.platform !== 'linux') return { os: process.platform, cpu: process.arch };
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })
    ?.header;
  return {
    os: process.platform,
    cpu: process.arch,
    libc: header?.glibcVersionRuntime ? 'glibc' : 'musl',
  };
}

/** Whether `value` passes an `os`, `cpu` or `libc` list of a lockfile entry; `!x` excludes `x`. */
function platformAllows(list: unknown, value: string | undefined): boolean {
  if (!Array.isArray(list) || list.length === 0 || value === undefined) return true;
  const names = list.filter((v): v is string => typeof v === 'string');
  if (names.includes(`!${value}`)) return false;
  const wanted = names.filter((v) => !v.startsWith('!'));
  return wanted.length === 0 || wanted.includes(value);
}

/** Whether an `os`, `cpu` or `libc` list of a lockfile entry names `value` itself, not only `!x`. */
function platformNames(list: unknown, value: string | undefined): boolean {
  return value !== undefined && Array.isArray(list) && list.includes(value);
}

/** A package name and a version as npm writes them; both go into a shell command. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PACKAGE_VERSION = /^[0-9][0-9A-Za-z.+-]*$/;

/** Looks up the registry npm installs a package of `scope` (`@x`, or none) from; see `npmRegistry`. */
export type RegistryLookup = (scope: string | undefined) => string | undefined;

/**
 * The registry that `npm install <name>@<version>` in `dir` fetches a package of `scope` from, as
 * npm's own configuration says (`.npmrc` files, environment): `@scope:registry` when set, or
 * `registry`. `undefined` when npm does not answer with an http(s) URL.
 *
 * `env` goes to npm without what a package manager's script added (`withoutScriptEnv`): the
 * `npm_config_registry` of a swarmupd started with `pnpm swarmup` is the engine checkout's
 * registry, and npm would take it over the `.npmrc` in `dir` (AO-0307).
 */
export function npmRegistry(
  dir: string,
  scope: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const clean = withoutScriptEnv(env);
  const get = (key: string): string | undefined => {
    // `shell` because npm is `npm.cmd` on Windows; the key is a checked scope name or a constant.
    const r = spawnSync(`npm config get ${key}`, {
      cwd: dir,
      env: clean,
      shell: true,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    });
    const value = r.status === 0 ? r.stdout.trim() : '';
    return /^https?:\/\//i.test(value) ? value : undefined;
  };
  return (scope !== undefined ? get(`${scope}:registry`) : undefined) ?? get('registry');
}

/**
 * Whether a lockfile entry comes from the registry that `name@version` installs from, so that
 * the install by name fetches the same package. A git, file or tarball dependency also has a
 * plain `version` (the one in its `package.json`), and only `resolved` tells its source;
 * installed by name, the registry package of that name would take its place.
 *
 * A registry entry has no `resolved` (npm's `omit-lockfile-registry-resolved`), or the URL of
 * this package's tarball in the configured registry (`registry`, a `RegistryLookup`):
 * `<registry>/<name>/-/<name without scope>-<version>.tgz`, same scheme, host and port. The
 * shape of the path alone proves nothing: a tarball on any other host can have it. So another
 * host counts as not from a registry, also a mirror of the configured one, and so does a
 * registry with another tarball layout.
 */
function fromRegistry(
  name: string,
  version: string,
  resolved: unknown,
  registry: RegistryLookup,
): boolean {
  if (resolved === undefined) return true;
  if (typeof resolved !== 'string' || !/^https?:\/\//i.test(resolved)) return false;
  const scope = name.startsWith('@') ? name.slice(0, name.indexOf('/')) : undefined;
  const base = name.slice(name.indexOf('/') + 1);
  try {
    const from = registry(scope);
    if (from === undefined) return false;
    const home = new URL(from);
    const url = new URL(resolved);
    if (url.origin !== home.origin || url.username !== '' || url.password !== '') return false;
    const root = decodeURIComponent(home.pathname).replace(/\/+$/, '');
    return decodeURIComponent(url.pathname) === `${root}/${name}/-/${base}-${version}.tgz`;
  } catch {
    return false;
  }
}

/**
 * The optional packages that the lockfile in `dir` places in `dir/node_modules` for `platform`
 * and that are not installed, as `name@version` for `npm install`, sorted (AO-0229).
 *
 * `npm install` can leave them out and say `up to date`, or even remove them: for some dependency
 * graphs it builds a tree without the platform packages that the lockfile lists (seen with
 * `lightningcss-win32-x64-msvc` under a root `lightningcss` that vite and vitest share), and only
 * `npm ci` installs the lockfile as written. A package installed by name stays.
 *
 * Only top-level `node_modules/<name>` entries count: a nested package can't be installed by
 * name, and `npm install` did restore those. Entries for another platform, links, bundled
 * packages and anything that does not come from the configured registry (`fromRegistry`) are
 * left alone. `registry` is asked only for a missing package with a `resolved` URL, once a scope.
 *
 * Only a package that names this platform in `os`, `cpu` or `libc` counts. An optional package
 * with no such list, or with exclusions only (`!aix`), can be missing on purpose: npm leaves it
 * out when its install fails or `--omit=optional` is set, and the build goes on. Installed by
 * name, the same failure would stop the merge build.
 */
export function missingOptionalPackages(
  dir: string,
  platform: InstallPlatform = installPlatform(),
  registry: RegistryLookup = (scope) => npmRegistry(dir, scope),
): string[] {
  const known = new Map<string, string | undefined>();
  const lookup: RegistryLookup = (scope) => {
    const key = scope ?? '';
    if (!known.has(key)) known.set(key, registry(scope));
    return known.get(key);
  };
  const file = ['npm-shrinkwrap.json', 'package-lock.json']
    .map((f) => join(dir, f))
    .find((f) => existsSync(f));
  if (!file) return [];
  let packages: unknown;
  try {
    packages = (JSON.parse(readFileSync(file, 'utf8')) as { packages?: unknown }).packages;
  } catch {
    return [];
  }
  if (typeof packages !== 'object' || packages === null) return [];
  const specs: string[] = [];
  for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
    const folder = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key)?.[1];
    if (!folder || typeof value !== 'object' || value === null) continue;
    const e = value as Record<string, unknown>;
    if (e.optional !== true || e.link === true || e.inBundle === true) continue;
    if (typeof e.version !== 'string' || !PACKAGE_VERSION.test(e.version)) continue;
    if (!PACKAGE_NAME.test(folder)) continue;
    if (e.name !== undefined && (typeof e.name !== 'string' || !PACKAGE_NAME.test(e.name)))
      continue;
    if (
      !platformAllows(e.os, platform.os) ||
      !platformAllows(e.cpu, platform.cpu) ||
      !platformAllows(e.libc, platform.libc)
    ) {
      continue;
    }
    if (
      !platformNames(e.os, platform.os) &&
      !platformNames(e.cpu, platform.cpu) &&
      !platformNames(e.libc, platform.libc)
    ) {
      continue;
    }
    if (existsSync(join(dir, 'node_modules', ...folder.split('/'), 'package.json'))) continue;
    // Last, because it can run npm: only for a package that is missing.
    const name = typeof e.name === 'string' ? e.name : folder;
    if (!fromRegistry(name, e.version, e.resolved, lookup)) continue;
    // An alias keeps its folder name: `<folder>@npm:<name>@<version>`.
    const alias = typeof e.name === 'string' && e.name !== folder ? `npm:${e.name}@` : '';
    specs.push(`${folder}@${alias}${e.version}`);
  }
  return specs.sort();
}

/**
 * The command that installs the optional packages `DEFAULT_INSTALL` left out of `dir`
 * (`missingOptionalPackages`), or `null` when none is missing.
 */
export function repairInstallCommand(
  dir: string,
  platform?: InstallPlatform,
  registry?: RegistryLookup,
): string | null {
  const missing = missingOptionalPackages(dir, platform, registry);
  return missing.length > 0 ? `${DEFAULT_INSTALL} ${missing.join(' ')}` : null;
}

/**
 * The install steps for a build in `top` after a merge changed the lockfiles in `dirs` (from
 * `lockfileDirs`): `installCommands` in each directory, in order. A step outside `top` names its
 * directory, so the merge event tells which install ran where. After the default install comes a
 * step that looks at `node_modules` then, and installs by name what the install left out.
 */
export function installSteps(
  install: string[] | undefined,
  top: string,
  dirs: string[],
  platform?: InstallPlatform,
  registry?: RegistryLookup,
): CommandEntry[] {
  return dirs.flatMap((dir) => {
    const cwd = dir === '.' ? top : join(top, ...dir.split('/'));
    const entry = (command: string): FixedCommand =>
      dir === '.' ? command : { command, cwd, label: `${command} (in ${dir})` };
    const steps = installCommands(install, cwd).map(entry);
    if (install || steps.length === 0) return steps;
    const repair: CommandEntry = () => {
      const command = repairInstallCommand(cwd, platform, registry);
      return command === null ? null : entry(command);
    };
    return [...steps, repair];
  });
}

/** Whether `top` holds the SwarmUp engine, whose `packages/supervisor` swarmupd runs. */
export function isEngineRepo(top: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(join(top, 'packages', 'supervisor', 'package.json'), 'utf8'),
    ) as { name?: string };
    return pkg.name === '@swarmup/supervisor';
  } catch {
    return false;
  }
}

/** What swarmupd knows about the code it runs, for the notice after a merge changes it. */
export interface OpsdSelf {
  /** The folder of swarmupd's own code. */
  dir: string;
  /** Reads the build stamp from disk now; a stamp other than swarmupd's start stamp is a new build. */
  stamp: () => string;
}

/**
 * The notice to the human after a merge into the engine repo changed swarmupd's code: the running
 * swarmupd does not have it yet, and what makes it live. `runs`: whether swarmupd runs from the checkout
 * the base was built in, from another install (the desktop app), or unknown. `built`: the build
 * after the merge wrote a build other than the one swarmupd started with.
 */
export function notLiveNotice(o: {
  task: string;
  what: string;
  base: string;
  commit: string;
  files: string[];
  top: string;
  runs: 'checkout' | 'installed' | 'unknown';
  built: boolean;
  pid: number;
  version?: string;
}): string {
  const shown = o.files.slice(0, 3).map((f) => `\`${f}\``);
  const more = o.files.length > 3 ? ` and ${o.files.length - 3} more` : '';
  const head =
    `${o.task}: swarmupd merged ${o.what} into \`${o.base}\` as ${o.commit.slice(0, 7)}, which changes ` +
    `swarmupd's own code (${shown.join(', ')}${more}). The running swarmupd (pid ${o.pid}` +
    `${o.version ? `, ${o.version}` : ''}) does not have it yet.`;
  const restart =
    'restart swarmupd with **Restart swarmupd** in the tray, **Restart** in Settings or `swarmup daemon restart`; live runs keep going';
  if (o.runs === 'checkout') {
    return o.built
      ? `${head} The build in \`${o.top}\` has it: ${restart}.`
      : `${head} Build \`${o.top}\` (\`npm run build\`), then ${restart}.`;
  }
  if (o.runs === 'installed') {
    return (
      `${head} swarmupd runs the installed app, not \`${o.top}\`, so a restart does not load it: ` +
      'it goes live once you install a new build of the app (a release, then **Restart and ' +
      'install** in Settings > Updates).'
    );
  }
  return (
    `${head} If swarmupd runs from \`${o.top}\`, build it and restart swarmupd; if it runs the installed ` +
    'app, it goes live once you install a new build of the app.'
  );
}

/** Whether `dir` is `top` or inside it. */
export function insideDir(top: string, dir: string): boolean {
  const rel = relative(resolve(top), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** What one command run printed and how it ended. */
export interface CommandResult {
  ok: boolean;
  command: string;
  /** The end of what it printed, stdout and stderr together. */
  output: string;
  /** Why it failed: `exit <code>`, `timed out after <n> min` or `stopped`. */
  why?: string;
  /**
   * The wall clock jumped while it ran: the PC slept, or swarmupd stopped responding. Tests and
   * timeouts then fail on wake, so a failure says nothing about the code (AO-0151).
   */
  interrupted?: boolean;
  /** It ran past its timeout and swarmupd stopped it. */
  timedOut?: boolean;
  /**
   * Its place, from 0, in the list `CommandRunner.runAll` got. Not its place in the results when
   * an earlier function entry had nothing to run.
   */
  entry?: number;
}

/**
 * A command for `CommandRunner.runAll`: a bare command runs in the list's directory; else it runs
 * in `cwd`, and its steps and result name it by `label`. A function is asked for its command when
 * its turn comes, so it can depend on what the earlier commands left; `null` means nothing to
 * run, and the list is one step shorter.
 */
export type FixedCommand = string | { command: string; cwd: string; label: string };
export type CommandEntry = FixedCommand | (() => FixedCommand | null);

/** One command of a `CommandRunner.runAll` list: as it starts, and with `result` once it ends. */
export interface CommandStep {
  command: string;
  /** Its place in the list, from 0. */
  index: number;
  count: number;
  result?: CommandResult;
}

/** How much of a command's output swarmupd keeps. */
const OUTPUT_KEEP = 64 * 1024;

/** How often a running command looks at the wall clock, to notice that the PC slept. */
const CLOCK_TICK_MS = 1_000;

/** A gap between two looks this long means the PC slept or swarmupd stopped responding. */
export const CLOCK_GAP_MS = 60_000;

/**
 * Git work for merging approved branches: rebasing in a worktree of swarmupd's own, and moving the
 * base branch forward without ever forcing it.
 */
/** A git command of a merge that ran past its timeout; never read as a conflict or a no. */
export class GitTimeout extends Error {
  /** The merge stage it hung in, where the caller knows it better than the merge step does. */
  stage?: string;

  /**
   * @param output What git and what it started printed before swarmupd stopped them, for the note
   *   that tells why the merge ended.
   */
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
  }
}

/**
 * What a git timeout says swarmupd did about the command. With `treeLeft`, why the stop did not
 * reach what git started, it does not claim the tree stopped: a hook may still run and write in
 * the checkout (AO-0251).
 */
export function gitStopNote(treeLeft?: string): string {
  if (!treeLeft) return 'swarmupd stopped it';
  return `swarmupd stopped git, but what git started, such as a hook, may still run: ${treeLeft}`;
}

/** How long one git command of a merge may take; rebases and fast-forwards take seconds. */
export const MERGE_GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * How long one git command of a merge may take, in ms: one value for every command, or a function
 * of the command's arguments (`['merge', '-q', '--ff-only', ...]`), so a test can stop one command
 * fast and leave the others room under load (AO-0213).
 */
export type MergeGitTimeout = number | ((args: readonly string[]) => number);

/**
 * Whether `dir` is a linked worktree whose repo is gone: its `.git` is a file that names a
 * `worktrees/<name>` folder that no longer exists, as after the old code checkout was deleted
 * (AO-0275). Only `git worktree add` writes such a file, so the folder is no one's own work; a
 * folder with anything else in `.git`, or with none, is not stale.
 */
export function staleWorktree(dir: string): boolean {
  const file = join(dir, '.git');
  let text: string;
  try {
    if (!statSync(file).isFile()) return false;
    text = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const named = /^gitdir: (.+)$/.exec(text.trim())?.[1]?.trim();
  if (!named) return false;
  const gitDir = resolve(dir, named);
  // A submodule's `.git` file names `modules/<name>`; that folder is part of someone's checkout.
  if (basename(dirname(gitDir)).toLowerCase() !== 'worktrees') return false;
  return !existsSync(gitDir);
}

export class MergeRepo {
  private readonly excludes: string[];

  /**
   * @param top The checkout the base branch is built in.
   * @param worktree swarmupd's own worktree for rebases and checks; created on first use.
   * @param stores Task store folders, whose files never count as code changes.
   * @param env The environment git and the commands run with.
   * @param gitTimeoutMs How long one git command may take before swarmupd stops it and what it
   *   started, such as a hook; the merge then ends and frees its checkout (AO-0172). A function
   *   gives each command its own limit.
   * @param stopTree Stops a timed-out git's tree; tests replace it.
   */
  constructor(
    readonly top: string,
    readonly worktree: string,
    stores: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly gitTimeoutMs: MergeGitTimeout = MERGE_GIT_TIMEOUT_MS,
    private readonly stopTree?: TreeStop,
  ) {
    this.excludes = ROOT_DIR_NAMES.map((n) => `:(exclude,glob)**/${n}/**`);
    for (const dir of stores) {
      const rel = relative(resolve(top), resolve(dir));
      if (rel === '' || rel.startsWith('..') || rel.includes(':')) continue;
      this.excludes.push(`:(exclude,literal)${rel.split(sep).join('/')}`);
    }
  }

  /** The commit `rev` names in the repo, or null. */
  async commit(rev: string): Promise<string | null> {
    try {
      return (
        (await this.git(this.top, ['rev-parse', '--verify', '-q', `${rev}^{commit}`])).trim() ||
        null
      );
    } catch (err) {
      if (err instanceof GitTimeout) throw err;
      return null;
    }
  }

  /**
   * Creates swarmupd's worktree, detached at `at`, unless it is there already. A worktree left
   * from another repo, as after the code checkout moved, is removed there and made again from
   * `top`: its repo lacks the commits to merge (AO-0273). One whose repo is gone is deleted and
   * made again (AO-0275).
   */
  async ensureWorktree(at: string): Promise<void> {
    if (existsSync(this.worktree)) {
      let own: string;
      try {
        own = await this.commonDir(this.worktree);
      } catch (err) {
        if (err instanceof GitTimeout) throw err;
        if (staleWorktree(this.worktree)) {
          // No repo is left to remove it from, so the folder goes as it is.
          rmSync(this.worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
          return this.addWorktree(at);
        }
        // A folder that is no worktree may be someone's: it stays for a person to look at.
        throw new Error(`${this.worktree} exists but is no git worktree; remove it`);
      }
      if (samePath(own, await this.commonDir(this.top))) return;
      // Only a linked worktree whose top folder is this one is swarmupd's to remove; a folder
      // inside someone's checkout is not.
      const [gitDir, topLevel] = lines(
        await this.git(this.worktree, [
          'rev-parse',
          '--path-format=absolute',
          '--git-dir',
          '--show-toplevel',
        ]),
      );
      if (!gitDir || !topLevel || samePath(gitDir, own) || !samePath(topLevel, this.worktree)) {
        throw new Error(
          `${this.worktree} belongs to the repo at ${own}, not to ${this.top}; remove it`,
        );
      }
      // Run from outside the folder: Windows deletes no folder a process works in.
      const there = ['--git-dir', own, 'worktree'];
      await this.git(this.top, [...there, 'remove', '--force', this.worktree]);
      await this.git(this.top, [...there, 'prune'], { allowFail: true });
    }
    await this.addWorktree(at);
  }

  /** Adds swarmupd's worktree, detached at `at`, where no folder is in the way. */
  private async addWorktree(at: string): Promise<void> {
    mkdirSync(dirname(this.worktree), { recursive: true });
    // `-f` takes over swarmupd's own path when git still lists it after the folder was deleted;
    // other worktrees' entries are left alone.
    await this.git(this.top, ['worktree', 'add', '-q', '-f', '--detach', this.worktree, at]);
  }

  /**
   * Checks out `commit` as it is in swarmupd's worktree, detached, for checks on what a review
   * names (AO-0296). Untracked files of an earlier round go; ignored ones (installed packages,
   * builds) stay.
   */
  async checkOut(commit: string): Promise<void> {
    const wt = this.worktree;
    await this.git(wt, ['rebase', '--abort'], { allowFail: true });
    await this.git(wt, ['checkout', '-q', '-f', '--detach', commit]);
    await this.git(wt, ['clean', '-q', '-f', '-d']);
  }

  /**
   * Replays `commit` and the commits before it that `onto` lacks onto `onto`, in swarmupd's worktree.
   * Returns the new commit, or the conflict git reported (the rebase is undone).
   */
  async rebase(commit: string, onto: string): Promise<{ head: string } | { conflict: string }> {
    const wt = this.worktree;
    await this.git(wt, ['rebase', '--abort'], { allowFail: true });
    await this.git(wt, ['checkout', '-q', '-f', '--detach', commit]);
    // Untracked files of an earlier merge go; ignored ones (installed packages, builds) stay.
    await this.git(wt, ['clean', '-q', '-f', '-d']);
    try {
      await this.git(wt, ['rebase', '-q', onto]);
    } catch (err) {
      if (err instanceof GitTimeout) throw err;
      const out = errorText(err);
      let files = '';
      try {
        files = (await this.git(wt, ['diff', '--name-only', '--diff-filter=U'])).trim();
      } catch {
        // No rebase in progress: the message says why.
      }
      await this.git(wt, ['rebase', '--abort'], { allowFail: true });
      return {
        conflict: files ? `conflicts in ${files.split('\n').join(', ')}\n\n${out}` : out,
      };
    }
    return { head: (await this.git(wt, ['rev-parse', 'HEAD'])).trim() };
  }

  /** Whether two commits have the same files outside task stores. */
  async sameCode(a: string, b: string): Promise<boolean> {
    try {
      await this.git(this.top, ['diff', '--quiet', a, b, '--', '.', ...this.excludes]);
      return true;
    } catch (err) {
      if (err instanceof GitTimeout) throw err;
      return false;
    }
  }

  /**
   * Moves `base` from `from` to `to`, which must be a descendant. Where `base` is checked out, it
   * merges there with `--ff-only`, so the work tree follows and local changes are never lost;
   * elsewhere it updates the ref only if it is still at `from`. Returns `moved` when `base` is no
   * longer at `from`; throws on any other refusal.
   */
  async fastForward(base: string, from: string, to: string): Promise<'done' | 'moved'> {
    if ((await this.commit(`refs/heads/${base}`)) !== from) return 'moved';
    const at = await this.checkedOut(base);
    try {
      if (at) await this.git(at, ['merge', '-q', '--ff-only', to]);
      else await this.git(this.top, ['update-ref', `refs/heads/${base}`, to, from]);
    } catch (err) {
      if (err instanceof GitTimeout) throw err;
      // A commit (a task store sync, say) landed on the base in between.
      if ((await this.commit(`refs/heads/${base}`)) !== from) return 'moved';
      throw new Error(errorText(err));
    }
    return 'done';
  }

  /** The worktree that has `branch` checked out, or null. */
  async checkedOut(branch: string): Promise<string | null> {
    const out = await this.git(this.top, ['worktree', 'list', '--porcelain']);
    let path: string | null = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
      else if (line.trim() === `branch refs/heads/${branch}` && path) return resolve(path);
    }
    return null;
  }

  /** Files that differ between two commits, outside task stores. */
  async changedFiles(a: string, b: string): Promise<string[]> {
    return lines(
      await this.git(this.top, ['diff', '--name-only', a, b, '--', '.', ...this.excludes]),
    );
  }

  /** Task store files that differ between two commits. */
  async storeFiles(a: string, b: string): Promise<string[]> {
    const code = new Set(await this.changedFiles(a, b));
    return lines(await this.git(this.top, ['diff', '--name-only', a, b])).filter(
      (f) => !code.has(f),
    );
  }

  /**
   * The {@link patchKey}s of the commits on `head` that `onto` lacks: what moving the base from
   * `onto` to `head` approves for the task store sync to push (AO-0193).
   */
  async patchKeys(onto: string, head: string): Promise<string[]> {
    const out: string[] = [];
    for (const c of lines(
      await this.git(this.top, ['rev-list', '--no-merges', head, `^${onto}`]),
    )) {
      const key = patchKey(await this.git(this.top, [...PATCH_KEY_ARGS, c]));
      if (key) out.push(key);
    }
    return out;
  }

  /** Whether `rev` names a commit: for picking a merge source while a tick plans. */
  async hasCommit(rev: string): Promise<boolean> {
    const out = await this.git(this.top, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], {
      allowFail: true,
    });
    return out.trim() !== '';
  }

  /** The names of the repo's local branches, in one git call. */
  async branches(): Promise<Set<string>> {
    const out = await this.git(this.top, ['for-each-ref', '--format=%(refname)', 'refs/heads'], {
      allowFail: true,
    });
    return new Set(
      lines(out)
        .filter((l) => l.startsWith('refs/heads/'))
        .map((l) => l.slice('refs/heads/'.length)),
    );
  }

  /**
   * `git worktree list --porcelain -z` of the repo. A failure throws: the caller decides what an
   * unread list means.
   */
  worktreeList(): Promise<string> {
    return this.git(this.top, ['worktree', 'list', '--porcelain', '-z']);
  }

  /**
   * Whether the folder of a worktree that git lists is gone ({@link pathGone}). Anything else
   * that keeps swarmupd from looking at it throws: the caller decides what an unread worktree
   * means.
   */
  worktreeGone(path: string): boolean {
    return pathGone(path);
  }

  /**
   * The tip of the local branch `branch` when its only parent is `parent`, else null (no such
   * branch too). A git failure throws, so an unread branch never counts as a missing one.
   */
  async branchOn(branch: string, parent: string): Promise<string | null> {
    const ref = `refs/heads/${branch}`;
    const out = await this.git(this.top, [
      'for-each-ref',
      '--format=%(refname) %(objectname) %(parent)',
      ref,
    ]);
    for (const l of lines(out)) {
      const [name, tip, ...parents] = l.trim().split(' ');
      if (name === ref && tip) return parents.length === 1 && parents[0] === parent ? tip : null;
    }
    return null;
  }

  /** The folder that holds the refs and objects of the repo `cwd` is in. */
  private async commonDir(cwd: string): Promise<string> {
    return (
      await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return { ...this.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' };
  }

  private async git(
    cwd: string,
    args: string[],
    opts: { allowFail?: boolean } = {},
  ): Promise<string> {
    const timeoutMs =
      typeof this.gitTimeoutMs === 'function' ? this.gitTimeoutMs(args) : this.gitTimeoutMs;
    try {
      return await gitAsync(cwd, args, {
        env: this.gitEnv(),
        timeoutMs,
        tree: true,
        stopTree: this.stopTree,
      });
    } catch (err) {
      if ((err as GitFailure).code === 'ETIMEDOUT') {
        // Even with allowFail: a git command that hangs once likely hangs again.
        const took = formatTimeout(timeoutMs);
        const e = err as GitFailure;
        throw new GitTimeout(
          `\`git ${args.join(' ')}\` in ${cwd} timed out after ${took}; ${gitStopNote(e.treeLeft)}`,
          `${e.stdout ?? ''}${e.stderr ?? ''}`,
        );
      }
      if (opts.allowFail) return '';
      throw err;
    }
  }
}

/**
 * How long a command that has exited may keep its output open, through a process it started,
 * before swarmupd stops reading it: a leftover nothing could end must not hold a merge or a stop.
 */
const DRAIN_MS = 5_000;

/** How long a stop waits for the watch to end the command's processes before ending the shell. */
const WATCH_STOP_MS = 15_000;

/**
 * Follows the processes of each command a `CommandRunner` starts, so a stop ends all of them and
 * none outlives the command. swarmupd implements it with its process ledger.
 */
export interface CommandWatch {
  /** The command started as the shell `pid`; `running` says whether that shell still runs. */
  started(pid: number, running: () => boolean): void;
  /** Ends every process of the command; the runner ends the shell itself afterwards. */
  stop(pid: number): Promise<void>;
  /** The shell exited: ends what the command left behind. */
  ended(pid: number): Promise<void>;
}

/** The launcher's exit code when it could not run the command in a job object. */
export const JOB_FAILED = 125;

/**
 * Windows: runs `SWARMUP_JOB_COMMAND` through `cmd.exe` inside a job object of its own, then exits
 * with the command's exit code. The job ends every process in it when its last handle closes, and
 * only the launcher holds that handle, so ending the launcher ends the whole tree: processes
 * started detached and their children too, since the job allows no breakaway. This needs no
 * process list and no `OpenProcess` on other processes, both of which a sandbox may refuse. The
 * shell starts suspended and runs only once it is in the job; when the shell exits, the launcher
 * ends what it left behind. Without a job, nothing runs (exit `JOB_FAILED`).
 */
const JOB_LAUNCHER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class OpsJob {
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo { public int cb; public IntPtr reserved, desktop, title; public int x, y, xSize, ySize, xChars, yChars, fill, flags; public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr; }
  [StructLayout(LayoutKind.Sequential)] struct ProcInfo { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long a, b; public uint flags; public UIntPtr min, max; public uint active; public UIntPtr affinity; public uint priority, cls; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct ExtLimits { public BasicLimits basic; public IoCounters io; public UIntPtr a, b, c, d; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtLimits info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcInfo pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  static int Fail(string step) { Console.Error.WriteLine("swarmupd could not run the command in a job object: " + step + " failed with error " + Marshal.GetLastWin32Error()); return ${JOB_FAILED}; }
  public static int Run(string command) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return Fail("CreateJobObject");
    ExtLimits limits = new ExtLimits();
    limits.basic.flags = 0x2000;
    if (!SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtLimits)))) return Fail("SetInformationJobObject");
    string shell = Environment.GetEnvironmentVariable("ComSpec");
    if (String.IsNullOrEmpty(shell)) shell = "cmd.exe";
    StartupInfo si = new StartupInfo();
    si.cb = Marshal.SizeOf(typeof(StartupInfo));
    si.flags = 0x100;
    si.stdIn = GetStdHandle(-10); si.stdOut = GetStdHandle(-11); si.stdErr = GetStdHandle(-12);
    ProcInfo pi;
    StringBuilder line = new StringBuilder("\\"" + shell + "\\" /d /s /c \\"" + command + "\\"");
    if (!CreateProcessW(null, line, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero, null, ref si, out pi)) return Fail("CreateProcess");
    if (!AssignProcessToJobObject(job, pi.process)) { int r = Fail("AssignProcessToJobObject"); TerminateProcess(pi.process, 1); return r; }
    ResumeThread(pi.thread);
    WaitForSingleObject(pi.process, 0xFFFFFFFF);
    uint code;
    if (!GetExitCodeProcess(pi.process, out code)) code = 1;
    TerminateJobObject(job, 1);
    return (int)code;
  }
}
'@
} catch { [Console]::Error.WriteLine('swarmupd could not run the command in a job object: ' + $_); exit ${JOB_FAILED} }
$command = $env:SWARMUP_JOB_COMMAND
Remove-Item Env:SWARMUP_JOB_COMMAND
exit [OpsJob]::Run($command)
`;

/** `powershell.exe -EncodedCommand` takes the script as base64 of UTF-16LE. */
const JOB_LAUNCHER_ARG = Buffer.from(JOB_LAUNCHER, 'utf16le').toString('base64');

/** Runs commands one after the other through the shell; stops at the first that fails. */
export class CommandRunner {
  private current?: { pid: number; stop: () => void };
  private stopped = false;
  private readonly killTree: (pid: number) => void;
  private readonly watch?: CommandWatch;
  private readonly job: boolean;
  private readonly now: () => number;

  /**
   * @param opts.killTree Off Windows: stops the command's process group; tests replace it.
   * @param opts.watch Off Windows: follows and ends each command's processes. On Windows each
   *   command runs in a job object instead (see `JOB_LAUNCHER`), which ends the whole tree with
   *   the launcher; `taskkill /T`, a process list and kills by PID can each be refused there.
   * @param opts.job Whether to use the job launcher; on Windows by default. Tests turn it off.
   * @param opts.now The wall clock, in ms; a jump in it marks a command `interrupted`.
   */
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    opts: {
      killTree?: (pid: number) => void;
      watch?: CommandWatch;
      job?: boolean;
      now?: () => number;
    } = {},
  ) {
    this.killTree = opts.killTree ?? killTree;
    this.job = opts.job ?? process.platform === 'win32';
    this.watch = this.job ? undefined : opts.watch;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Runs `commands` in order, in `cwd` unless an entry names its own, and stops at the first that
   * fails. `onStep` hears of each command as it starts, and again with its result once it ends.
   * `env` replaces the runner's environment for these commands: what depends on the folder they
   * run in, such as its shared Electron (AO-0306).
   */
  async runAll(
    commands: CommandEntry[],
    cwd: string,
    timeoutMs: number,
    onStep?: (step: CommandStep) => void,
    env: NodeJS.ProcessEnv = this.env,
  ): Promise<CommandResult[]> {
    const out: CommandResult[] = [];
    let count = commands.length;
    for (const [at, given] of commands.entries()) {
      const entry = typeof given === 'function' ? given() : given;
      if (entry === null) {
        count -= 1;
        continue;
      }
      const e = typeof entry === 'string' ? { command: entry, cwd, label: entry } : entry;
      const step = { command: e.label, index: out.length, count };
      onStep?.(step);
      const ran = await this.run(e.command, e.cwd, timeoutMs, env);
      const r = { ...ran, command: e.label, entry: at };
      onStep?.({ ...step, result: r });
      out.push(r);
      if (!r.ok) break;
    }
    return out;
  }

  /** Stops the command running now, and every later one. */
  stop(): void {
    this.stopped = true;
    this.current?.stop();
  }

  private run(
    command: string,
    cwd: string,
    timeoutMs: number,
    env: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    if (this.stopped) return Promise.resolve({ ok: false, command, output: '', why: 'stopped' });
    return new Promise((res) => {
      const child = this.job
        ? spawn(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', JOB_LAUNCHER_ARG],
            {
              cwd,
              env: { ...env, SWARMUP_JOB_COMMAND: command },
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
        : spawn(command, {
            cwd,
            env,
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            // Its own process group off Windows, so a timeout stops what it started too.
            detached: process.platform !== 'win32',
          });
      let output = '';
      const keep = (b: Buffer): void => {
        output += b.toString('utf8');
        if (output.length > OUTPUT_KEEP * 2) output = output.slice(-OUTPUT_KEEP);
      };
      child.stdout?.on('data', keep);
      child.stderr?.on('data', keep);
      let why: string | undefined;
      const pid = child.pid;
      const running = (): boolean => child.exitCode === null && child.signalCode === null;
      if (pid !== undefined) this.watch?.started(pid, running);
      let killing = false;
      // Only this command's own processes: the job launcher by the handle its spawn returned,
      // which ends the job and so the tree; else the watch's, checked by creation time, then the
      // shell by its handle, while it still runs.
      const kill = (reason: string): void => {
        why ??= reason;
        if (pid === undefined || !running() || killing) return;
        killing = true;
        if (this.job) {
          child.kill();
          return;
        }
        void bounded(this.watch?.stop(pid), WATCH_STOP_MS).then(() => {
          if (!running()) return;
          // Off Windows the group gets SIGTERM first and SIGKILL later.
          if (process.platform !== 'win32') this.killTree(pid);
          child.kill();
        });
      };
      // A sleeping PC runs no timers: the first look after the wake sees a gap. Comparing the
      // wall clock with the monotonic one would not work, since on Windows both count the sleep.
      let interrupted = false;
      let timedOut = false;
      let seen = this.now();
      const look = (): void => {
        const t = this.now();
        if (t - seen >= CLOCK_GAP_MS) interrupted = true;
        seen = t;
      };
      const clock = setInterval(look, CLOCK_TICK_MS);
      // A timeout may fire on wake before the first look; it looks first.
      const timer = setTimeout(() => {
        look();
        timedOut = true;
        kill(`timed out after ${Math.round(timeoutMs / 60_000)} min`);
      }, timeoutMs);
      if (pid !== undefined) this.current = { pid, stop: () => kill('stopped') };
      let settled = false;
      let drain: NodeJS.Timeout | undefined;
      const done = (code: number | null, err?: Error): void => {
        if (settled) return;
        settled = true;
        look();
        clearInterval(clock);
        clearTimeout(timer);
        clearTimeout(drain);
        child.stdout?.destroy();
        child.stderr?.destroy();
        this.current = undefined;
        const tail = output.slice(-OUTPUT_KEEP);
        if (err) why ??= err.message;
        if (
          this.job &&
          code === JOB_FAILED &&
          tail.includes('swarmupd could not run the command')
        ) {
          why ??= 'could not run in a job object';
        }
        const ok = !why && code === 0;
        const result: CommandResult = {
          ok,
          command,
          output: tail,
          why: ok ? undefined : (why ?? `exit ${code}`),
        };
        if (interrupted) result.interrupted = true;
        if (timedOut && !ok) result.timedOut = true;
        // What the command left behind ends before the next command starts.
        const after = pid === undefined ? undefined : this.watch?.ended(pid);
        void bounded(after, WATCH_STOP_MS * 2).then(() => res(result));
      };
      child.on('error', (err) => done(null, err));
      child.on('close', (code) => done(code));
      // A process the command left behind may hold the output open; it does not hold swarmupd.
      child.on('exit', (code) => {
        drain = setTimeout(() => done(code), DRAIN_MS);
      });
    });
  }
}

/** Waits for `p`, at most `ms`; never rejects. */
function bounded(p: Promise<void> | undefined, ms: number): Promise<void> {
  if (!p) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((r) => {
    timer = setTimeout(r, ms);
  });
  return Promise.race([p.catch(() => {}), limit]).finally(() => clearTimeout(timer));
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function errorText(err: unknown): string {
  const e = err as { stdout?: string; stderr?: string; message?: string };
  const text = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
  return text || (e.message ?? String(err));
}

/** A timeout for a message: `5 min`, or seconds under a minute. */
function formatTimeout(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}
