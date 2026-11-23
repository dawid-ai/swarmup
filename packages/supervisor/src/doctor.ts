import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { freemem, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import type { UserConfig } from '@swarmup/core';
import {
  checksTrustProblem,
  formatProblem,
  loadDefinitions,
  SWARM_FILE,
  mcpSecretRefs,
  readSecrets,
  secretsExposure,
  secretsPath,
  userConfigPath,
  Workspace,
} from '@swarmup/core';
import type { OpsdConfig } from './config.js';
import { opsdConfig } from './config.js';
import { buildStamp, daemonCall, readDaemon } from './daemon.js';
import { resolveCommand } from './proc.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  /** Stable key, such as `config`, `root:<dir>` or `runtime:claude`. */
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What to do about a warn or fail. */
  fix?: string;
  /** A repair the desktop app can run. */
  action?: 'install-skills';
}

export interface DoctorOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Set when swarmupd runs the checks itself: its own build, so it does not call itself. */
  self?: { build?: string; pid: number };
  freeMem?: () => number;
  /** Free bytes on the disk that holds `dir`, or null when unknown. */
  diskFree?: (dir: string) => number | null;
  home?: string;
  /** The swarmup skill this install ships; null when there is none. Default: `bundledSkillFile()`. */
  skillFile?: string | null;
}

/** Disk space below which a root gets a warning: clones, logs and builds need room. */
const DISK_WARN_GB = 5;

function gitOut(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function defaultDiskFree(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Where each runtime keeps its sign-in, checked for existence only: the files are never read. An
 * API key in the environment counts too. Null when there is no way to tell (macOS Keychain, an
 * unknown runtime).
 */
function signedIn(runtime: string, env: NodeJS.ProcessEnv, home: string): boolean | null {
  if (runtime === 'claude') {
    if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
    const dir = env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
    return existsSync(join(dir, '.credentials.json')) ? true : null;
  }
  if (runtime === 'codex') {
    if (env.OPENAI_API_KEY || env.CODEX_API_KEY) return true;
    const dir = env.CODEX_HOME ?? join(home, '.codex');
    return existsSync(join(dir, 'auth.json')) ? true : null;
  }
  return null;
}

const gb = (bytes: number): string => `${(bytes / 2 ** 30).toFixed(1)} GB`;

const SKILL_PATH = join('skills', 'swarmup', 'SKILL.md');
/** Where the skill sat before the SwarmUp rename; a copy left there is flagged. */
const OLD_SKILL_PATH = join('skills', 'agent-ops', 'SKILL.md');

interface UserSkillLocation {
  runtime: string;
  dir: string;
  /** Canonical runtime homes receive the skill; ~/.agents is checked and migrated only. */
  install: boolean;
}

export interface SkillInstallOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The skill to install. Default: `bundledSkillFile()`. */
  skillFile?: string | null;
}

export interface SkillInstallResult {
  installed: string[];
  removed: string[];
  /** Old skill folders kept because they contain something besides SKILL.md. */
  kept: string[];
}

/**
 * The swarmup skill this install ships: `skills/` beside the bundle in the desktop app, or at
 * the top of a source checkout (three folders up from `packages/supervisor/dist`). Null when
 * neither exists.
 */
export function bundledSkillFile(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 4; up++) {
    const file = join(dir, SKILL_PATH);
    if (existsSync(file)) return file;
    dir = dirname(dir);
  }
  return null;
}

/**
 * User-level copies of the swarmup skill, which the runtimes load in place of the repo copy:
 * Claude Code from its config folder, Codex from its home and from `~/.agents`.
 */
function userSkillLocations(env: NodeJS.ProcessEnv, home: string): UserSkillLocation[] {
  const dirs: UserSkillLocation[] = [
    { runtime: 'Claude Code', dir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), install: true },
    { runtime: 'Codex', dir: env.CODEX_HOME ?? join(home, '.codex'), install: true },
    { runtime: 'Codex', dir: join(home, '.agents'), install: false },
  ];
  const seen = new Set<string>();
  const out: UserSkillLocation[] = [];
  for (const location of dirs) {
    if (seen.has(location.dir)) continue;
    seen.add(location.dir);
    out.push(location);
  }
  return out;
}

function homeFor(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32'
    ? (env.USERPROFILE ?? env.HOME ?? homedir())
    : (env.HOME ?? env.USERPROFILE ?? homedir());
}

/** True only when deleting the old skill folder cannot remove a person's other files. */
function oldSkillOnly(dir: string): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return (
      entries.length === 1 && entries[0]!.isFile() && entries[0]!.name.toLowerCase() === 'skill.md'
    );
  } catch {
    return false;
  }
}

/**
 * Installs the bundled skill into Claude Code and Codex's user homes. An old `agent-ops` folder is
 * removed only when its sole entry is SKILL.md; a folder with any other entry is left untouched.
 * The desktop calls this after an install/update and from Health checks' Fix button.
 */
export function installUserSkills(opts: SkillInstallOptions = {}): SkillInstallResult {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeFor(env);
  const bundled = opts.skillFile === undefined ? bundledSkillFile() : opts.skillFile;
  if (!bundled || !existsSync(bundled)) {
    throw new Error('this SwarmUp install does not contain skills/swarmup/SKILL.md');
  }
  const locations = userSkillLocations(env, home);
  const installed: string[] = [];
  for (const location of locations) {
    const file = join(location.dir, SKILL_PATH);
    // A location that is not installed by default (`~/.agents`) is only refreshed when a copy
    // already exists there, so its health warning clears without adding a second Codex copy.
    if (!location.install && !existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    copyFileSync(bundled, file);
    installed.push(file);
  }

  const removed: string[] = [];
  const kept: string[] = [];
  for (const location of locations) {
    const dir = dirname(join(location.dir, OLD_SKILL_PATH));
    if (!existsSync(dir)) continue;
    if (!oldSkillOnly(dir)) {
      kept.push(dir);
      continue;
    }
    rmSync(dir, { recursive: true });
    removed.push(dir);
  }
  return { installed, removed, kept };
}

/** Text with Windows line ends turned into `\n`, so a checkout with autocrlf still matches. */
const lf = (s: string): string => s.replace(/\r\n/g, '\n');

/** `## ` headings of `want` that `have` lacks, to say what a stale copy misses. */
function missingSections(want: string, have: string): string[] {
  const heads = (s: string) =>
    new Set([...s.matchAll(/^##+ (.+)$/gm)].map((m) => (m[1] ?? '').trim()));
  const got = heads(have);
  return [...heads(want)].filter((h) => !got.has(h));
}

/** One check per user-level skill copy: ok when it matches the shipped skill, else warn. */
function skillChecks(env: NodeJS.ProcessEnv, home: string, bundled: string | null): Check[] {
  if (!bundled) return [];
  let want: string;
  try {
    want = lf(readFileSync(bundled, 'utf8'));
  } catch {
    return [];
  }
  const locations = userSkillLocations(env, home);
  const leftovers = locations.flatMap((location): Check[] => {
    const file = join(location.dir, OLD_SKILL_PATH);
    if (!existsSync(file)) return [];
    const dir = dirname(file);
    const safe = oldSkillOnly(dir);
    return [
      {
        id: `skill:${file}`,
        label: `${location.runtime} skill`,
        status: 'warn',
        detail:
          `${file} is the skill under its old name agent-ops; runs now load the swarmup skill` +
          (safe ? '' : '; the folder has other files, so Fix will keep it'),
        fix: safe
          ? 'open Settings > Health checks and click Fix to install the current skill and remove this old folder'
          : 'open Settings > Health checks and click Fix to install the current skill; move or remove the other files by hand before deleting this old folder',
        action: 'install-skills',
      },
    ];
  });
  const current = locations.flatMap((location): Check[] => {
    const file = join(location.dir, SKILL_PATH);
    if (!existsSync(file)) {
      if (!location.install) return [];
      return [
        {
          id: `skill:${file}`,
          label: `${location.runtime} skill`,
          status: 'warn',
          detail: `${file} is not installed`,
          fix: 'open Settings > Health checks and click Fix to install the swarmup skill this app ships',
          action: 'install-skills',
        },
      ];
    }
    const id = `skill:${file}`;
    const label = `${location.runtime} skill`;
    let have: string;
    try {
      have = lf(readFileSync(file, 'utf8'));
    } catch (err) {
      return [
        {
          id,
          label,
          status: 'warn',
          detail: `${file} cannot be read: ${(err as Error).message}`,
          fix: 'open Settings > Health checks and click Fix to copy the skill this app ships over it',
          action: 'install-skills',
        },
      ];
    }
    if (have === want) return [{ id, label, status: 'ok', detail: `${file} matches this install` }];
    const missing = missingSections(want, have);
    return [
      {
        id,
        label,
        status: 'warn',
        detail:
          `${file} differs from the swarmup skill this install ships, and ${location.runtime} loads it ` +
          `instead of the repo copy` +
          (missing.length ? `; it lacks: ${missing.join(', ')}` : ''),
        fix: 'open Settings > Health checks and click Fix to copy the skill this app ships over it',
        action: 'install-skills',
      },
    ];
  });
  return [...current, ...leftovers];
}

/**
 * Checks this machine's setup: user config, data roots, the swarmupd config, runtimes on PATH and
 * signed in, user-level copies of the swarmup skill, swarmupd itself, and free memory and disk.
 * Never throws; every problem is a check.
 */
export async function doctor(opts: DoctorOptions): Promise<Check[]> {
  const { env } = opts;
  const home = opts.home ?? homeFor(env);
  const out: Check[] = [];
  const add = (c: Check): void => {
    out.push(c);
  };

  // User config.
  const file = userConfigPath(env);
  let user: UserConfig & { opsd?: Partial<OpsdConfig> } = {};
  if (!existsSync(file)) {
    add({
      id: 'config',
      label: 'User config',
      status: 'warn',
      detail: `${file} does not exist`,
      fix: 'run `swarmup setup`, or open the desktop app once',
    });
  } else {
    try {
      user = (YAML.parse(readFileSync(file, 'utf8')) ?? {}) as typeof user;
      add({ id: 'config', label: 'User config', status: 'ok', detail: file });
    } catch (err) {
      add({
        id: 'config',
        label: 'User config',
        status: 'fail',
        detail: `${file} is not valid YAML: ${(err as Error).message.split('\n')[0]}`,
        fix: 'fix the file by hand; swarmupd and the app refuse to edit it while it does not parse',
      });
    }
  }
  add(
    user.me
      ? { id: 'me', label: 'You', status: 'ok', detail: user.me }
      : {
          id: 'me',
          label: 'You',
          status: 'warn',
          detail: '`me` is not set: asks and reviews have no human to go to',
          fix: 'run `swarmup setup`',
        },
  );

  // Data roots.
  let ws: Workspace | null = null;
  try {
    ws = new Workspace({ cwd: opts.cwd, env, user });
    const roots = ws.roots;
    if (roots.length === 0) {
      add({
        id: 'roots',
        label: 'Data roots',
        status: 'fail',
        detail: 'no data root: not inside one, and the user config lists none',
        fix: 'run `swarmup init` in a repo, or add a root with `swarmup setup`',
      });
    }
    for (const r of roots) {
      const top = gitOut(r.dir, ['rev-parse', '--show-toplevel']);
      if (!top) {
        add({
          id: `root:${r.dir}`,
          label: `Root ${r.name}`,
          status: 'fail',
          detail: `${r.dir} is not inside a git repo`,
          fix: '`git init` the folder, or move the root into a repo',
        });
        continue;
      }
      const upstream = gitOut(r.dir, ['rev-parse', '--abbrev-ref', '@{u}']);
      add(
        upstream
          ? {
              id: `root:${r.dir}`,
              label: `Root ${r.name}`,
              status: 'ok',
              detail: `${r.dir} (syncs with ${upstream})`,
            }
          : {
              id: `root:${r.dir}`,
              label: `Root ${r.name}`,
              status: 'warn',
              detail: `${r.dir} has no upstream branch: swarmup sync commits but never pushes or pulls`,
              fix: 'push the branch once with `git push -u`',
            },
      );
      // `swarmup sync` and every agent run commit here; with no name and email git refuses (AO-0211).
      if (gitOut(r.dir, ['var', 'GIT_COMMITTER_IDENT'], env) === null) {
        add({
          id: `git-identity:${r.dir}`,
          label: `Git identity for ${r.name}`,
          status: 'fail',
          detail:
            'git has no user name and email here, so swarmup sync and agent runs cannot commit',
          fix: 'run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`',
        });
      }
    }
    // Decisions a person should look at (AO-0109): a vote decided twice without --force, a
    // decision file the two sides of a mirror hold with different content, and a record whose
    // source event does not exist.
    for (const p of ws.decisionProblems()) {
      add({
        id: `decision:${p.root}/${p.id}:${p.kind}`,
        label: `Decision ${p.root}/${p.id}`,
        status: 'warn',
        detail: p.detail,
        fix:
          p.kind === 'outcomes'
            ? `confirm the result with \`swarmup decide ${p.root}/${p.id} <choice> --force\``
            : p.kind === 'source'
              ? `read it with \`swarmup tally ${p.root}/${p.id}\`; if a sync has not brought the event yet, sync and check again; ` +
                `if the decision does not stand, replace it with \`swarmup decision "..." --supersedes ${p.id}\``
              : 'compare the two files and make them the same by hand; the next sync mirrors the rest',
      });
    }
    for (const p of ws.agentProblems()) {
      add({
        id: `agent-file:${p.file}`,
        label: 'Role file',
        status: 'warn',
        detail: `${p.file} is skipped: ${p.message}`,
        fix: 'fix the frontmatter by hand; quote any value that contains `: `',
      });
    }
  } catch (err) {
    add({
      id: 'roots',
      label: 'Data roots',
      status: 'fail',
      detail: (err as Error).message,
      fix: 'run `swarmup init` in a repo, or add a root with `swarmup setup`',
    });
  }

  // swarmupd config and runtimes.
  let cfg: OpsdConfig | null = null;
  try {
    cfg = opsdConfig(user);
    add({ id: 'opsd-config', label: 'swarmupd config', status: 'ok', detail: 'valid' });
  } catch (err) {
    add({
      id: 'opsd-config',
      label: 'swarmupd config',
      status: 'fail',
      detail: (err as Error).message,
      fix: `fix the swarmupd section of ${file}`,
    });
  }
  for (const [name, rc] of Object.entries(cfg?.runtimes ?? {})) {
    // The swarmupd config does not check commands, so anything can be here.
    const command = (rc as { command?: unknown } | null)?.command;
    if (typeof command !== 'string' || !command.trim()) {
      add({
        id: `runtime:${name}`,
        label: `Runtime ${name}`,
        status: 'fail',
        detail: 'no command set',
        fix: `set swarmupd.runtimes.${name}.command to the program to run`,
      });
      continue;
    }
    let path: string | null;
    try {
      path = resolveCommand(command, env);
    } catch {
      path = null;
    }
    if (!path) {
      add({
        id: `runtime:${name}`,
        label: `Runtime ${name}`,
        status: 'fail',
        detail: `'${command}' is not on PATH`,
        fix: `install ${name}, or set swarmupd.runtimes.${name}.command to its full path`,
      });
      continue;
    }
    const signed = signedIn(name, env, home);
    add(
      signed
        ? {
            id: `runtime:${name}`,
            label: `Runtime ${name}`,
            status: 'ok',
            detail: `${path}; signed in`,
          }
        : {
            id: `runtime:${name}`,
            label: `Runtime ${name}`,
            status: 'warn',
            detail: `${path}; cannot tell whether it is signed in`,
            fix: `run \`${command}\` once in a terminal and sign in, if runs fail to start`,
          },
    );
  }

  // Definitions as code (W5): problems in each root's swarm.yaml and agent files. Agent files a
  // root without swarm.yaml skips are reported above already.
  for (const r of ws?.roots ?? []) {
    if (r.isMirror) continue;
    let set;
    try {
      set = loadDefinitions(r.dir, {
        machineRuntimes: cfg ? Object.keys(cfg.runtimes) : undefined,
        machineAgents: cfg ? Object.keys(cfg.agents) : undefined,
        machineMcp: cfg ? Object.keys(cfg.mcp.servers) : undefined,
      });
    } catch (err) {
      add({
        id: `defs:${r.dir}`,
        label: `Definitions of ${r.name}`,
        status: 'fail',
        detail: (err as Error).message,
      });
      continue;
    }
    if (!set.present) continue;
    // Merge checks in git that this machine has not trusted, or that changed since (W5 phase 4).
    const trust = set.swarm
      ? checksTrustProblem(
          join(r.dir, SWARM_FILE),
          r.name,
          set.swarm.checks,
          cfg?.trusted_defs[r.name],
        )
      : null;
    const problems = trust ? [...set.problems, trust] : set.problems;
    const errors = problems.filter((p) => p.severity === 'error');
    const warnings = problems.length - errors.length;
    add({
      id: `defs:${r.dir}`,
      label: `Definitions of ${r.name}`,
      status: errors.length > 0 ? 'fail' : warnings > 0 ? 'warn' : 'ok',
      detail:
        problems.length === 0
          ? `swarm.yaml and ${set.agents.length} agent file(s) are valid`
          : problems.slice(0, 5).map(formatProblem).join('\n') +
            (problems.length > 5 ? `\n... and ${problems.length - 5} more` : ''),
      ...(problems.length > 0
        ? {
            fix:
              errors.length > 0
                ? `fix the files; swarmupd keeps the last good swarm.yaml of ${r.name} until then (\`swarmup validate --root ${r.name}\` lists every problem)`
                : `\`swarmup validate --root ${r.name}\` lists every problem`,
          }
        : {}),
    });
  }

  // MCP servers on roles (W8).
  for (const c of mcpChecks(env, cfg, ws)) add(c);

  // User-level skill copies.
  const bundled = opts.skillFile === undefined ? bundledSkillFile() : opts.skillFile;
  for (const c of skillChecks(env, home, bundled)) add(c);

  // swarmupd itself.
  if (opts.self) {
    add({
      id: 'opsd',
      label: 'swarmupd',
      status: 'ok',
      detail: `running, pid ${opts.self.pid}${opts.self.build ? `, build ${opts.self.build}` : ''}`,
    });
  } else {
    const info = readDaemon(env);
    if (!info) {
      add({
        id: 'opsd',
        label: 'swarmupd',
        status: 'warn',
        detail: 'not running: no schedules or wakes until it starts',
        fix: 'run `swarmup daemon start`, or open the desktop app',
      });
    } else {
      try {
        const health = await daemonCall<{ build?: string }>(info, 'GET', '/api/health');
        const here = buildStamp();
        // Same rule as the desktop: a different stamp means swarmupd runs other code than this install.
        const stale = health.build !== here;
        add(
          stale
            ? {
                id: 'opsd',
                label: 'swarmupd',
                status: 'warn',
                detail: `pid ${info.pid} runs an older build than this install`,
                fix: 'the desktop app restarts it once no run is live; or `swarmup daemon stop` then `swarmup daemon start`',
              }
            : {
                id: 'opsd',
                label: 'swarmupd',
                status: 'ok',
                detail: `pid ${info.pid} on port ${info.port}`,
              },
        );
      } catch (err) {
        add({
          id: 'opsd',
          label: 'swarmupd',
          status: 'fail',
          detail: `pid ${info.pid} does not answer: ${(err as Error).message}`,
          fix: 'run `swarmup daemon stop`, then `swarmup daemon start`',
        });
      }
    }
  }

  // Memory and disk.
  const minGb = cfg?.min_free_gb ?? 0;
  const mem = (opts.freeMem ?? freemem)();
  add(
    mem / 2 ** 30 < minGb
      ? {
          id: 'memory',
          label: 'Free memory',
          status: 'fail',
          detail: `${gb(mem)} free; min_free_gb is ${minGb}, so swarmupd starts no runs`,
          fix: 'close programs, or lower swarmupd.min_free_gb in Settings',
        }
      : {
          id: 'memory',
          label: 'Free memory',
          status: 'ok',
          detail: `${gb(mem)} free (min ${minGb} GB)`,
        },
  );
  const diskFree = opts.diskFree ?? defaultDiskFree;
  const seen = new Set<string>();
  for (const r of ws ? safeRoots(ws) : []) {
    const free = diskFree(r.dir);
    if (free === null) continue;
    // One line per disk: roots on the same device share their free space.
    let key: string;
    try {
      key = String(statSync(r.dir).dev);
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    add(
      free / 2 ** 30 < DISK_WARN_GB
        ? {
            id: `disk:${r.name}`,
            label: `Disk for ${r.name}`,
            status: 'warn',
            detail: `${gb(free)} free`,
            fix: 'free space: runs write logs and builds',
          }
        : {
            id: `disk:${r.name}`,
            label: `Disk for ${r.name}`,
            status: 'ok',
            detail: `${gb(free)} free`,
          },
    );
  }
  return out;
}

/**
 * MCP checks (W8): `secrets.yml` readable by others where the system can tell, secrets a server
 * reads that are not set, and server names role files ask for that this machine does not define.
 * Never a secret value.
 */
export function mcpChecks(
  env: NodeJS.ProcessEnv,
  cfg: OpsdConfig | null,
  ws: Workspace | null,
  platform: NodeJS.Platform = process.platform,
): Check[] {
  const out: Check[] = [];
  const exposed = secretsExposure(env, platform);
  if (exposed) {
    out.push({
      id: 'mcp:secrets',
      label: 'MCP secrets',
      status: 'warn',
      detail: exposed,
      fix: `run \`chmod 600 ${secretsPath(env)}\``,
    });
  }
  if (!cfg) return out;
  let secrets: Record<string, string> = {};
  try {
    secrets = readSecrets(env);
  } catch (err) {
    out.push({
      id: 'mcp:secrets',
      label: 'MCP secrets',
      status: 'fail',
      detail: (err as Error).message,
      fix: 'fix the file by hand, or set the values again in Settings > MCP servers',
    });
  }
  for (const [name, s] of Object.entries(cfg.mcp.servers)) {
    const unset = mcpSecretRefs(s).filter((k) => secrets[k] === undefined);
    if (unset.length === 0) continue;
    out.push({
      id: `mcp:${name}`,
      label: `MCP server ${name}`,
      status: 'warn',
      detail: `no value for ${unset.join(', ')} in secrets.yml, so runs cannot start it`,
      fix: 'set the value in Settings > MCP servers',
    });
  }
  let agents: Array<{ id: string; mcp?: string[] }> = [];
  try {
    agents = ws?.agents() ?? [];
  } catch {
    agents = [];
  }
  const asked = new Map<string, string[]>();
  for (const a of agents) {
    for (const n of a.mcp ?? []) {
      if (cfg.mcp.servers[n]) continue;
      asked.set(n, [...(asked.get(n) ?? []), a.id]);
    }
  }
  for (const [n, ids] of asked) {
    out.push({
      id: `mcp-missing:${n}`,
      label: `MCP server ${n}`,
      status: 'warn',
      detail: `${ids.join(', ')} ask for ${n}, which this machine does not define; their runs start without it`,
      fix: 'add it in Settings > MCP servers, or remove it from the role files',
    });
  }
  return out;
}

function safeRoots(ws: Workspace): Array<{ name: string; dir: string }> {
  try {
    return ws.roots;
  } catch {
    return [];
  }
}

/** One line per check for a terminal, with the fix under each warn or fail. */
export function formatChecks(checks: Check[]): string {
  const mark: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
  return checks
    .map(
      (c) =>
        `${mark[c.status]}  ${c.label}: ${c.detail}${c.fix && c.status !== 'ok' ? `\n      -> ${c.fix}` : ''}`,
    )
    .join('\n');
}
