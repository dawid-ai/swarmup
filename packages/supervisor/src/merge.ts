import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PATCH_KEY_ARGS, patchKey, ROOT_DIR_NAMES } from '@swarmup/core';
import { type GitFailure, gitAsync } from './git.js';
import { killTree } from './proc.js';

/** Where an approved task's work is, as its last review request names it. */
export interface MergeSource {
  /** The commit the reviewer approved, when the review names one. */
  commit?: string;
  branch?: string;
}

/** A name ends at a space, a colon, a comma, a bracket or a full stop that ends a sentence. */
const NAME = '`?([A-Za-z0-9._/-]+?)`?(?=[\\s:,;)]|\\.(?:\\s|$)|$)';

/** What a review request names as the work to merge. */
export interface ReviewSources {
  /** `<commit> on branch <name>`, the form the agent skill and swarmupd's own leftover reviews use. */
  named?: MergeSource;
  /**
   * The word after each other `branch`, in order. Prose gives words that are no branch ("this
   * branch does not touch it"), so only a name that is a branch in the repo counts.
   */
  loose: string[];
}

/** Reads what a review request names: `<commit> on branch <name>`, and each `branch <word>`. */
export function reviewSources(text: string): ReviewSources {
  const both = new RegExp(`\\b([0-9a-f]{7,40})\\s+on\\s+branch\\s+${NAME}`, 'm').exec(text);
  const named = both ? { commit: both[1], branch: both[2] } : undefined;
  const loose: string[] = [];
  for (const m of text.matchAll(new RegExp(`\\bbranch\\s+${NAME}`, 'gm'))) {
    if (m[1] !== named?.branch && !loose.includes(m[1]!)) loose.push(m[1]!);
  }
  return named ? { named, loose } : { loose };
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

/**
 * The install steps for a build in `top` after a merge changed the lockfiles in `dirs` (from
 * `lockfileDirs`): `installCommands` in each directory, in order. A step outside `top` names its
 * directory, so the merge event tells which install ran where.
 */
export function installSteps(
  install: string[] | undefined,
  top: string,
  dirs: string[],
): CommandEntry[] {
  return dirs.flatMap((dir) => {
    const cwd = dir === '.' ? top : join(top, ...dir.split('/'));
    return installCommands(install, cwd).map((command): CommandEntry =>
      dir === '.' ? command : { command, cwd, label: `${command} (in ${dir})` },
    );
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
}

/**
 * A command for `CommandRunner.runAll`: a bare command runs in the list's directory; else it runs
 * in `cwd`, and its steps and result name it by `label`.
 */
export type CommandEntry = string | { command: string; cwd: string; label: string };

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

/** How long one git command of a merge may take; rebases and fast-forwards take seconds. */
export const MERGE_GIT_TIMEOUT_MS = 5 * 60_000;

/**
 * How long one git command of a merge may take, in ms: one value for every command, or a function
 * of the command's arguments (`['merge', '-q', '--ff-only', ...]`), so a test can stop one command
 * fast and leave the others room under load (AO-0213).
 */
export type MergeGitTimeout = number | ((args: readonly string[]) => number);

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
   */
  constructor(
    readonly top: string,
    readonly worktree: string,
    stores: string[],
    private readonly env: NodeJS.ProcessEnv,
    private readonly gitTimeoutMs: MergeGitTimeout = MERGE_GIT_TIMEOUT_MS,
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

  /** Creates swarmupd's worktree, detached at `at`, unless it is there already. */
  async ensureWorktree(at: string): Promise<void> {
    if (existsSync(this.worktree)) {
      // A folder that is no worktree may be someone's: it stays for a person to look at.
      try {
        await this.git(this.worktree, ['rev-parse', '--git-dir']);
        return;
      } catch (err) {
        if (err instanceof GitTimeout) throw err;
        throw new Error(`${this.worktree} exists but is no git worktree; remove it`);
      }
    }
    mkdirSync(dirname(this.worktree), { recursive: true });
    // `-f` takes over swarmupd's own path when git still lists it after the folder was deleted;
    // other worktrees' entries are left alone.
    await this.git(this.top, ['worktree', 'add', '-q', '-f', '--detach', this.worktree, at]);
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
      return await gitAsync(cwd, args, { env: this.gitEnv(), timeoutMs, tree: true });
    } catch (err) {
      if ((err as GitFailure).code === 'ETIMEDOUT') {
        // Even with allowFail: a git command that hangs once likely hangs again.
        const took = formatTimeout(timeoutMs);
        const e = err as GitFailure;
        throw new GitTimeout(
          `\`git ${args.join(' ')}\` in ${cwd} timed out after ${took}; swarmupd stopped it`,
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
   */
  async runAll(
    commands: CommandEntry[],
    cwd: string,
    timeoutMs: number,
    onStep?: (step: CommandStep) => void,
  ): Promise<CommandResult[]> {
    const out: CommandResult[] = [];
    for (const [index, entry] of commands.entries()) {
      const e = typeof entry === 'string' ? { command: entry, cwd, label: entry } : entry;
      const step = { command: e.label, index, count: commands.length };
      onStep?.(step);
      const r = { ...(await this.run(e.command, e.cwd, timeoutMs)), command: e.label };
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

  private run(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
    if (this.stopped) return Promise.resolve({ ok: false, command, output: '', why: 'stopped' });
    return new Promise((res) => {
      const child = this.job
        ? spawn(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', JOB_LAUNCHER_ARG],
            {
              cwd,
              env: { ...this.env, SWARMUP_JOB_COMMAND: command },
              windowsHide: true,
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
        : spawn(command, {
            cwd,
            env: this.env,
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
