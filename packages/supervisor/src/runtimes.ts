import type { AgentDef, Criterion, LogEntry, MapPrompt, ReviewArtifact } from '@swarmup/core';
import {
  actorSlug,
  criterionWhat,
  decisionLines,
  mapPromptLines,
  roleOf,
  RUN_KINDS,
  runtimeOf,
  SCRATCH_WRITER_ROLES,
} from '@swarmup/core';
import type { RuntimeConfig } from './config.js';
import { checkEffort, checkModel } from './config.js';
import type { BriefRefresh, RunContext } from './run-context.js';
import { briefRefreshLines, runContextLines } from './run-context.js';

/** Tools for a Claude role that lists none: edit, read and the usual dev commands. */
export const DEFAULT_CLAUDE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'Bash(git *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(pnpm *)',
  'Bash(node *)',
  'Bash(gh pr *)',
  'Bash(gh issue view *)',
  'Bash(gh run *)',
];

/**
 * Never allowed for a supervised Claude run (v1 lesson: kills by name took out other runs).
 * The list catches mistakes, not a determined run: the default allow list has `node`, `npx` and
 * `git`, and any of them can run a command this list never sees.
 */
export const CLAUDE_DENY = [
  // Force push: the flag before or after the refspec, or a `+` refspec.
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git push * --force*)',
  'Bash(git push * -f*)',
  'Bash(git push +*)',
  'Bash(git push * +*)',
  // Recursive delete from an absolute path, in any flag order.
  'Bash(rm -rf /*)',
  'Bash(rm -fr /*)',
  'Bash(rm -Rf /*)',
  'Bash(rm -fR /*)',
  'Bash(rm -r -f /*)',
  'Bash(rm -f -r /*)',
  'Bash(rm -R -f /*)',
  'Bash(rm -f -R /*)',
  'Bash(rm --recursive --force /*)',
  'Bash(rm --force --recursive /*)',
  // Ending processes by PID, by name, or through PowerShell or cmd.
  'Bash(kill *)',
  'Bash(taskkill*)',
  'Bash(pkill*)',
  'Bash(killall*)',
  'Bash(Stop-Process*)',
  'Bash(stop-process*)',
  'Bash(*| Stop-Process*)',
  'Bash(*|Stop-Process*)',
  'Bash(*| stop-process*)',
  'Bash(*|stop-process*)',
  'Bash(pwsh*Stop-Process*)',
  'Bash(pwsh*stop-process*)',
  'Bash(powershell*Stop-Process*)',
  'Bash(powershell*stop-process*)',
  'Bash(pwsh*taskkill*)',
  'Bash(powershell*taskkill*)',
  'Bash(cmd*taskkill*)',
];

/**
 * Denied to a Claude run that starts in a data root's checkout (AO-0135): switching its branch
 * puts the task store on a code branch. Code branches go in worktrees instead. Like
 * {@link CLAUDE_DENY}, this catches mistakes: `git -C <dir> checkout` passes, and that is how a
 * run switches branches inside its own worktree.
 */
export const STORE_CHECKOUT_DENY = ['Bash(git checkout*)', 'Bash(git switch*)'];

/** Denied to a run of a role that does not write (AO-0136), whatever its role file lists. */
export const READ_ONLY_DENY = ['Edit', 'Write', 'NotebookEdit'];

/**
 * Read-only commands every chat turn gets on top of its role file's `tools` (AO-0349), so the PM
 * sees releases, tags, PRs and CI runs before it answers, even with an older role file installed.
 * Each pattern names a reading subcommand, never a whole command group: `gh release *` would allow
 * `gh release delete`, `git tag *` would allow `git tag -d`. Tags are read with `-l` first:
 * `git tag -l` refuses `-d`, `-a` and `-f` alongside it, while `git tag --sort=x v1` creates `v1`.
 *
 * Claude checks each part of a piped or chained command on its own, so `gh release list | head`
 * also needs `head`, which no chat turn gets: use `--limit` or `-n` instead.
 *
 * The `git -C * ...` forms let the PM read another checkout. Their middle `*` spans spaces, so they
 * catch mistakes, not a determined run, like {@link CLAUDE_DENY}.
 */
export const CHAT_READ_TOOLS = [
  'Bash(git log *)',
  'Bash(git show *)',
  'Bash(git tag)',
  'Bash(git tag -l*)',
  'Bash(git tag --list*)',
  'Bash(git describe *)',
  'Bash(git -C * log *)',
  'Bash(git -C * show *)',
  'Bash(git -C * tag -l*)',
  'Bash(git -C * tag --list*)',
  'Bash(git -C * describe *)',
  'Bash(gh release list*)',
  'Bash(gh release view*)',
  'Bash(gh pr list*)',
  'Bash(gh pr view*)',
  'Bash(gh pr checks*)',
  'Bash(gh run list*)',
  'Bash(gh run view*)',
];

/** Tools of a chat turn whose role file lists none: it reads and acts through `swarmup` only. */
export const CHAT_TOOLS = ['Read', 'Grep', 'Glob', ...CHAT_READ_TOOLS];

/** A chat turn never gives a verdict or decides a vote: those stay with reviewers and people. */
export const CHAT_DENY = [
  'Bash(swarmup verdict*)',
  'Bash(swarmup decide*)',
  'Bash(ops verdict*)',
  'Bash(ops decide*)',
  'Edit',
  'Write',
];

/** The CLI every Claude run may call: `swarmup`, and its old name `ops` as an alias until 0.4. */
export const CLI_TOOLS = ['Bash(swarmup *)', 'Bash(ops *)'];

/**
 * One MCP server a run gets (W8), as the runtime starts it: always the proxy
 * `swarmup mcp exec <name> --run-dir <scratch>`, never the real server, so no secret is ever an
 * argument or in the run record. `env` holds no secret either (only `ELECTRON_RUN_AS_NODE`).
 */
export interface McpProxyEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The MCP servers of one run: the proxy entries, and for Claude the config file that lists them. */
export interface McpInvocation {
  entries: McpProxyEntry[];
  /** Claude: the `--mcp-config` file, `<scratch>/mcp.json`. */
  configFile?: string;
  /** `swarmupd.mcp.strict`: every Claude run gets `--strict-mcp-config`, even with no servers. */
  strict?: boolean;
}

/**
 * The proxy entry of each granted server. `cli` is how to start `swarmup`: a program and the
 * arguments before the command, such as Node and the CLI's entry file.
 */
export function mcpProxyEntries(
  names: readonly string[],
  runDir: string,
  cli: { command: string; args: string[]; env?: Record<string, string> },
): McpProxyEntry[] {
  return names.map((name) => ({
    name,
    command: cli.command,
    args: [...cli.args, 'mcp', 'exec', name, '--run-dir', runDir],
    ...(cli.env ? { env: { ...cli.env } } : {}),
  }));
}

/** Claude's `--mcp-config` file for the entries. */
export function claudeMcpJson(entries: readonly McpProxyEntry[]): string {
  const servers = Object.fromEntries(
    entries.map((e) => [
      e.name,
      { type: 'stdio', command: e.command, args: e.args, ...(e.env ? { env: e.env } : {}) },
    ]),
  );
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/**
 * A TOML string for a Codex `-c` value. A literal string ('...') where it can be one: it keeps
 * Windows backslashes as they are and has no `"`, which cannot reach a `.cmd` runtime (see
 * `quoteBatch`). Text with `'` or a line break falls back to a basic string.
 */
export function tomlString(s: string): string {
  if (!/['\r\n]/.test(s)) return `'${s}'`;
  return JSON.stringify(s);
}

/** Codex's `-c mcp_servers.<name>.*` overrides for the entries (checked on Codex 0.167). */
export function codexMcpArgs(entries: readonly McpProxyEntry[]): string[] {
  return entries.flatMap((e) => {
    const at = `mcp_servers.${e.name}`;
    const env = e.env
      ? [
          '-c',
          `${at}.env={${Object.entries(e.env)
            .map(([k, v]) => `${k}=${tomlString(v)}`)
            .join(',')}}`,
        ]
      : [];
    return [
      '-c',
      `${at}.command=${tomlString(e.command)}`,
      '-c',
      `${at}.args=[${e.args.map(tomlString).join(',')}]`,
      ...env,
    ];
  });
}

/** A Claude chat turn: the session it starts or resumes, with replies streamed as they come. */
export interface ChatInvocation {
  session: string;
  resume: boolean;
}

export interface Invocation {
  args: string[];
  unsetEnv: string[];
  /** Lines the run's prompt must end with, because of how the run starts. */
  note?: string;
  /** The model the arguments pass, for the run record; unset for the runtime's default. */
  model?: string;
  /** The reasoning effort the arguments pass, for the run record. */
  effort?: string;
}

/**
 * Where a Codex run of a role that does not write starts, and what it may write (AO-0138). The
 * sandbox always lets Codex write its working folder, so the run starts in its task store, not in
 * the checkout: `swarmup` writes there, and the checkout stays read-only. The other stores are added
 * as writable folders. `stores` lists the run's own store first; stores inside another one are
 * dropped, since the outer one covers them. The run's scratch folder is writable too (AO-0296):
 * `TEMP` points there, and it is in no repo, so logs and temp files of the run's commands have a
 * place. A scratch folder that holds the checkout or a store is left out: it would make them
 * writable.
 */
function codexReadOnlyDirs(
  stores: string[],
  checkout: string,
  scratch?: string,
): { cd: string; add: string[] } | null {
  const outer = stores.filter(
    (s, i) => !stores.some((o, j) => j !== i && containsPath(o, s) && (!sameDir(o, s) || j < i)),
  );
  if (outer.length === 0) return null;
  const add = outer.slice(1);
  if (
    scratch &&
    !outer.some((o) => containsPath(o, scratch)) &&
    ![checkout, ...outer].some((d) => containsPath(scratch, d))
  ) {
    add.push(scratch);
  }
  return { cd: outer[0]!, add };
}

/**
 * The folders of a repo's shared git metadata (`git rev-parse --git-common-dir`) that a writing
 * Codex run gets as writable folders, so it can commit in a worktree of its checkout (AO-0155).
 * Codex keeps the `.git` of each writable folder read-only, including the git dir a worktree's
 * `.git` file points to (`<common>/worktrees/<name>`, with its index, HEAD and lock files), so
 * the run gets that folder itself; a commit also writes `objects`, `refs` and `logs`. Adding all of
 * `<common>/worktrees` instead leaves the worktree's own folder read-only (Codex 0.167). The common
 * dir itself stays read-only: the run cannot change `config` or `hooks` (which swarmupd's own git
 * runs would load) or move the main checkout's `HEAD` and `index`.
 */
export const CODEX_GIT_DIRS = ['objects', 'refs', 'logs'] as const;

/** The prompt lines of a read-only Codex run that starts in its task store. */
export function readOnlyCodexNote(checkout: string, store: string, scratch?: string): string {
  const lines = [
    '',
    `This run may not change files in ${checkout}: Codex starts you in the task store (${store}),`,
    'the only place you can write, and `swarmup` works there. Read the code by path and run git with',
    `\`git -C ${checkout} ...\`.`,
  ];
  if (scratch) {
    lines.push(
      `You can also write your scratch folder, ${scratch.replace(/\\/g, '/')} ($SWARMUP_SCRATCH; TEMP`,
      'points there): put logs and other files that belong in no repo there, never in the task store.',
    );
  }
  lines.push(
    'Your sandbox keeps every `.git` read-only and has no network, so `swarmup sync` cannot commit',
    'or push here: swarmupd commits and pushes the task store when this run ends.',
    '',
  );
  return lines.join('\n');
}

function normalDir(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}

function sameDir(a: string, b: string): boolean {
  return normalDir(a) === normalDir(b);
}

/**
 * The `--add-dir` folders of a writing Codex run. Codex keeps the `.git` of every writable folder
 * read-only, and its Windows elevated sandbox refuses to run any command when another writable
 * folder lies under such a read-only `.git` ("cannot reopen writable descendants under read-only
 * carveouts"). Every shell call of the run then fails, so the run ends at once without touching
 * its task (171 runs of codex:engineer on AO-0173). So no writable folder may hold one of
 * `gitDirs`: a checkout that holds them is replaced by the task stores inside it, and a git dir
 * under `cwd` is left out (the run then cannot commit, but its commands run).
 */
export function codexWritableDirs(
  cwd: string,
  addDirs: string[],
  stores: string[],
  gitDirs: string[],
): string[] {
  const git = gitDirs.filter((g) => !containsPath(cwd, g));
  const holdsGit = (d: string): boolean => git.some((g) => containsPath(d, g));
  const add: string[] = [];
  const push = (d: string): void => {
    if (!add.some((a) => sameDir(a, d))) add.push(d);
  };
  for (const d of addDirs) {
    if (!holdsGit(d)) {
      push(d);
      continue;
    }
    for (const s of stores) {
      if (containsPath(d, s) && !containsPath(cwd, s) && !holdsGit(s)) push(s);
    }
  }
  for (const g of git) push(g);
  return add;
}

/** True when `child` is `parent` or a folder inside it. */
function containsPath(parent: string, child: string): boolean {
  const p = normalDir(parent);
  const c = normalDir(child);
  return c === p || c.startsWith(`${p}/`);
}

/** Claude permission paths use // for absolute paths and /c/... for Windows drives. */
function claudeAbsolutePattern(dir: string): string {
  const normalized = dir.replace(/\\/g, '/');
  const absolute = normalized.replace(/^([A-Za-z]):\//, (_, drive: string) => {
    return `/${drive.toLowerCase()}/`;
  });
  return `/${absolute}/**`;
}

/**
 * A model an agent or role file picks itself, or undefined. `default`, which the role file
 * templates carry, picks none: the run takes the provider's `model`. Passed on as
 * `--model default`, it would run Claude Code's own default (Fable) over the provider's choice.
 */
export function ownModel(model: string | null | undefined): string | undefined {
  return model && model !== 'default' ? model : undefined;
}

/**
 * The model of a run: the agent's own (`swarmupd.agents.<id>.model`, merged into `agent` by the
 * caller, or the role file's `model`), else the provider's. Checked here, because a role file's
 * value comes from a synced repo and must never read as a flag.
 */
export function runModel(rc: RuntimeConfig, agent: Pick<AgentDef, 'model' | 'file'> | undefined) {
  const own = ownModel(agent?.model);
  if (own) return checkModel(own, `${agent?.file || 'agent'}: model`);
  return rc.model ? checkModel(rc.model, 'provider model') : undefined;
}

/**
 * The reasoning effort of a run: the agent's own (`swarmupd.agents.<id>.effort`, merged into
 * `agent` by the caller, or the role file's `effort`), else the provider's. Checked here for the
 * same reason as {@link runModel}.
 */
export function runEffort(
  rc: RuntimeConfig,
  agent: Pick<AgentDef, 'effort' | 'file'> | undefined,
): string | undefined {
  if (agent?.effort !== undefined && agent.effort !== null && agent.effort !== '') {
    return checkEffort(agent.effort, `${agent.file || 'agent'}: effort`);
  }
  return rc.effort ? checkEffort(rc.effort, 'provider effort') : undefined;
}

/**
 * Builds the arguments for one run. The prompt always goes on stdin, because Claude's
 * `--allowedTools` takes several values and would swallow a trailing prompt argument.
 * `readOnly` marks a run of a role that does not write (`roleLimits(...).writes` is false): a
 * Claude run gets no `Edit` or `Write`, even when its role file lists them, so a qa or reviewer
 * run never leaves changes in a shared checkout (AO-0136), and a Codex run starts in its task
 * store instead of `cwd`, with only the task stores writable (`stores`, its own first; AO-0138).
 * `storeCheckout` marks a run whose folder is a data root's checkout: a Claude run there gets
 * {@link STORE_CHECKOUT_DENY} (AO-0135). `gitDirs` are git metadata folders a writing Codex run
 * may write besides `cwd` and `addDirs` (see {@link CODEX_GIT_DIRS}); other runs ignore them.
 * `scratch` is the run's scratch folder, which a read-only Codex run may write too (AO-0296);
 * other runs get it through `addDirs`. `fullAccess` starts a writing Codex run with
 * `--sandbox danger-full-access`: the caller sets it for a run in a task worktree, so the run
 * commits there like a Claude run; `gitDirs` and the `--add-dir` folders are then not needed.
 */
export function invocation(
  rc: RuntimeConfig,
  agentId: string,
  agent: AgentDef | undefined,
  cwd: string,
  addDirs: string[],
  roleDirs: string[] = [],
  chat?: ChatInvocation,
  readOnly = false,
  storeCheckout = false,
  stores: string[] = [],
  gitDirs: string[] = [],
  scratch?: string,
  fullAccess = false,
  mcp?: McpInvocation,
): Invocation {
  const runtime = runtimeOf(agentId);
  const model = runModel(rc, agent);
  const effort = runEffort(rc, agent);
  const inv = invocationArgs(
    rc,
    agentId,
    agent,
    cwd,
    addDirs,
    roleDirs,
    chat,
    readOnly,
    storeCheckout,
    stores,
    gitDirs,
    scratch,
    fullAccess,
    model,
    effort,
    mcp,
  );
  // Only Claude and Codex runs get the flags; other runtimes' `args` are the whole line.
  if (runtime !== 'claude' && runtime !== 'codex') return inv;
  return { ...inv, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function invocationArgs(
  rc: RuntimeConfig,
  agentId: string,
  agent: AgentDef | undefined,
  cwd: string,
  addDirs: string[],
  roleDirs: string[],
  chat: ChatInvocation | undefined,
  readOnly: boolean,
  storeCheckout: boolean,
  stores: string[],
  gitDirs: string[],
  scratch: string | undefined,
  fullAccess: boolean,
  model: string | undefined,
  effort: string | undefined,
  mcp: McpInvocation | undefined,
): Invocation {
  const runtime = runtimeOf(agentId);
  const base = rc.args ?? [];
  const mcpEntries = mcp?.entries ?? [];
  const unsetEnv = rc.unset_env ?? [];
  if (runtime === 'claude') {
    const own = agent?.tools ?? (chat ? CHAT_TOOLS : DEFAULT_CLAUDE_TOOLS);
    // A read-only role that drafts in its scratch folder (the improver, W6) may edit there and
    // nowhere else: the edit tools are allowed for the scratch folder alone, and denied in the
    // run's folder and every other folder it may read.
    const scratchWrites =
      readOnly && !chat && scratch !== undefined && SCRATCH_WRITER_ROLES.includes(roleOf(agentId));
    const denied = new Set([
      ...(chat ? CHAT_DENY : []),
      ...(readOnly ? (scratchWrites ? ['NotebookEdit'] : READ_ONLY_DENY) : []),
    ]);
    const scratchOnly = scratchWrites
      ? {
          allow: ['Edit', 'Write'].map((t) => `${t}(${claudeAbsolutePattern(scratch!)})`),
          deny: [cwd, ...addDirs]
            .filter((d) => normalDir(d) !== normalDir(scratch!))
            .flatMap((d) => ['Edit', 'Write'].map((t) => `${t}(${claudeAbsolutePattern(d)})`)),
        }
      : { allow: [], deny: [] };
    const tools = [
      ...own.filter((t) => !denied.has(t) && !(scratchWrites && (t === 'Edit' || t === 'Write'))),
      ...scratchOnly.allow,
      ...(chat ? CHAT_READ_TOOLS : []),
      ...CLI_TOOLS,
      // Every tool of each granted server; the proxy filters them by the server's tool rules.
      ...mcpEntries.map((e) => `mcp__${e.name}`),
    ];
    const roleFileDeny = roleDirs.flatMap((dir) => {
      const pattern = claudeAbsolutePattern(dir);
      return [`Edit(${pattern})`, `Write(${pattern})`];
    });
    const session = chat
      ? [chat.resume ? '--resume' : '--session-id', chat.session, '--include-partial-messages']
      : [];
    return {
      args: [
        ...base,
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'stream-json',
        '--verbose',
        ...(model ? ['--model', model] : []),
        ...(effort ? ['--effort', effort] : []),
        // `--mcp-config` takes several values, so a flag follows it.
        ...(mcpEntries.length > 0 && mcp?.configFile
          ? ['--mcp-config', mcp.configFile, '--strict-mcp-config']
          : mcp?.strict
            ? ['--strict-mcp-config']
            : []),
        ...session,
        '--allowedTools',
        [...new Set(tools)].join(','),
        '--disallowedTools',
        [
          ...new Set([
            ...CLAUDE_DENY,
            ...(storeCheckout ? STORE_CHECKOUT_DENY : []),
            ...denied,
            ...roleFileDeny,
            ...scratchOnly.deny,
          ]),
        ].join(','),
        ...addDirs.flatMap((d) => ['--add-dir', d]),
      ],
      unsetEnv,
    };
  }
  if (runtime === 'codex') {
    const exec = (sandbox: string, cd: string, add: string[]) => [
      ...base,
      'exec',
      ...(model ? ['-m', model] : []),
      ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
      ...codexMcpArgs(mcpEntries),
      '--json',
      '--sandbox',
      sandbox,
      '--skip-git-repo-check',
      '-C',
      cd,
      ...add.flatMap((d) => ['--add-dir', d]),
      '-',
    ];
    if (!readOnly && fullAccess) return { args: exec('danger-full-access', cwd, []), unsetEnv };
    if (!readOnly) {
      return {
        args: exec('workspace-write', cwd, codexWritableDirs(cwd, addDirs, stores, gitDirs)),
        unsetEnv,
      };
    }
    const dirs = codexReadOnlyDirs(stores, cwd, scratch);
    // With no task store to write, the run gets a read-only sandbox: its `swarmup` writes fail, but
    // the checkout stays as it was.
    if (!dirs) return { args: exec('read-only', cwd, []), unsetEnv };
    return {
      args: exec('workspace-write', dirs.cd, dirs.add),
      unsetEnv,
      note: readOnlyCodexNote(cwd, dirs.cd, dirs.add.includes(scratch ?? '') ? scratch : undefined),
    };
  }
  // Other runtimes: the config's args are the whole command line.
  return { args: base, unsetEnv };
}

export interface PromptInput {
  agent: string;
  task?: string;
  /** Path of the role file, when the root defines the agent. */
  roleFile?: string;
  /** The role file's reading list and writing style, repeated in the prompt. */
  role?: Pick<AgentDef, 'kb' | 'files' | 'style'>;
  /** Extra instructions, such as a schedule's prompt. */
  extra?: string;
  /** The run reviews `task` instead of working it. */
  review?: boolean;
  /** `task` is a question to the agent: the run answers it instead of working it. */
  question?: QuestionPrompt;
  /** `task` is a milestone whose plan tasks are closed: the run checks its `done_when`. */
  check?: MilestoneCheckPrompt;
  /**
   * The run's folder is the checkout of a data root (AO-0135): its branch carries the task store,
   * so the run makes code branches in worktrees. `branch` is the store branch, when known.
   */
  storeCheckout?: SharedCheckout;
  /** swarmupd started the run in the task's own worktree, made from the store checkout (AO-0168). */
  taskWorktree?: TaskWorktreePrompt;
  /** The run's scratch folder (`SWARMUP_SCRATCH`), for files that belong in no repo (AO-0230). */
  scratch?: string;
  /** Learn notes whose title or topic matches the task's words (AO-0049), best first. */
  notes?: { ref: string; title: string }[];
  /** The project map of the run's checkout, when it has one, with the nodes that match the task. */
  map?: MapPrompt;
  /**
   * The decisions in force for `task` (AO-0109), newest first, from `inForce` in the task's root:
   * what `swarmup decisions --log --task ID` lists. A run without a task has none.
   */
  decisions?: Array<Pick<LogEntry, 'id' | 'at' | 'text'>>;
  /** The task's current criteria, ids settled; listed in work and review prompts. */
  criteria?: Criterion[];
  /** A review run: the artifacts the review request names, and the commit they are read at (W8). */
  artifacts?: ReviewArtifactsPrompt;
  /**
   * What a work or review run would otherwise fetch first: the task text, its recent thread and
   * its chain of parents with their briefs (`run-context.ts`).
   */
  context?: RunContext;
  /** For a PM's inbox run: parents whose brief is behind their closed children. */
  briefs?: BriefRefresh[];
}

/** The rule that keeps a run's scratch files out of every repo (AO-0230). */
function scratchLines(scratch: string): string[] {
  return [
    `- Put scratch files (logs, test output, experiments, downloads, bundles) in ${scratch.replace(/\\/g, '/')}`,
    '  ($SWARMUP_SCRATCH; TEMP points there too). swarmupd removes it some days after the run.',
    '  Never leave them in the repo, its `out/` folder or the folder that holds the repo; what',
    '  must last goes in a commit, a task comment or `swarmup attach`.',
    '- Screenshots, rendered images, reports and test output a reviewer should see go in',
    '  $SWARMUP_SCRATCH/artifacts/ (or `swarmup run artifact PATH --label TEXT`): swarmupd keeps',
    '  them with the run, and `swarmup review` attaches them.',
  ];
}

/** The work a review request names (W8), for the review prompt. */
export interface ReviewArtifactsPrompt {
  /** The reviewed commit, when the review names one. */
  commit?: string;
  items: ReviewArtifact[];
}

/** The artifacts of a review, one line each, with the command that shows each file. */
export function artifactLines(task: string, a: ReviewArtifactsPrompt): string[] {
  if (a.items.length === 0) return [];
  const at = a.commit ? ` at ${a.commit.slice(0, 10)}` : '';
  return [
    `- The work to read${at} (\`swarmup artifact ${task}\` lists it):`,
    ...a.items.map((x, i) => {
      const label = x.label ? ` (${x.label})` : '';
      if (x.kind === 'url' || x.kind === 'doc') {
        return `  ${i + 1}. ${x.kind} ${x.ref}${x.rev ? ` revision ${x.rev}` : ''}${label}`;
      }
      if (x.kind === 'run') {
        // A file the run kept outside git (W4): read it through swarmup, not git.
        const size = x.bytes !== undefined ? `, ${x.bytes} bytes` : '';
        return `  ${i + 1}. run artifact \`${x.ref}\` (${x.type ?? 'file'}${size})${label}: \`swarmup artifact ${task} ${i + 1} --out FILE\``;
      }
      const show = a.commit ? `\`git show ${a.commit.slice(0, 10)}:${x.ref}\`` : `\`${x.ref}\``;
      return `  ${i + 1}. ${x.kind} \`${x.ref}\`${label}: ${show}`;
    }),
    '  Judge each piece as a reader of its channel would see it.',
  ];
}

/** Where a run that swarmupd started in a task worktree works, for its prompt. */
export interface TaskWorktreePrompt {
  path: string;
  /** The branch checked out there; null on a detached HEAD. */
  branch: string | null;
  /**
   * The checkout the worktree belongs to, with its branch when known: the store checkout, or a
   * code checkout of `swarmupd.code` that holds no task store (`code`; AO-0252).
   */
  store: SharedCheckout;
}

/**
 * A checkout runs share: a data root's checkout with its store branch, or a code checkout of
 * `swarmupd.code` (`code`) with its merge base (AO-0252).
 */
export interface SharedCheckout {
  top: string;
  branch?: string | null;
  code?: boolean;
}

/** A question task, with the tasks and projects its text references. */
export interface QuestionPrompt {
  /** Who asked. */
  from: string;
  title: string;
  body: string;
  tasks: Array<{ ref: string; status: string; title: string }>;
  projects: string[];
  /**
   * Earlier rounds, oldest first: each answer, and each reply the asker reopened the question
   * with. A reply as the last round is what this run answers.
   */
  rounds?: Array<{ from: string; kind: 'answer' | 'reply'; text: string }>;
}

/** The task lines of a question run's prompt. */
function questionLines(task: string, q: QuestionPrompt): string[] {
  const lines = [
    '',
    `Answer the question ${task} from ${q.from}. It is a question, not work: read what you need,`,
    'but do not edit files, build, commit or push.',
    '',
    `Question: ${q.title}`,
  ];
  if (q.body && q.body !== q.title) lines.push(...q.body.split('\n').map((l) => `> ${l}`));
  const rounds = q.rounds ?? [];
  if (rounds.length > 0) {
    lines.push('', 'The conversation so far, oldest first:');
    for (const r of rounds) {
      lines.push(`- ${r.from} ${r.kind === 'answer' ? 'answered' : 'replied'}:`);
      lines.push(...r.text.split('\n').map((l) => `  > ${l}`));
    }
    if (rounds[rounds.length - 1]!.kind === 'reply') {
      lines.push('', 'Answer the latest reply; you need not repeat earlier answers.');
    }
  }
  if (q.tasks.length > 0) {
    lines.push('', 'Tasks it references (read them with `swarmup show <id>`):');
    for (const t of q.tasks) lines.push(`- ${t.ref} (${t.status}): ${t.title}`);
  }
  if (q.projects.length > 0) {
    lines.push(
      '',
      'Projects it references (list their tasks with `swarmup list --project <name>`):',
      ...q.projects.map((p) => `- ${p}`),
    );
  }
  lines.push(
    '',
    `Run \`swarmup start ${task}\` with a one-line plan, then finish with exactly one command:`,
    `- \`swarmup done ${task} "your answer"\`: the answer goes to ${q.from}'s inbox. Write it so it`,
    '  reads on its own: name the tasks, files and decisions it is about.',
    `- \`swarmup ask ${task} "one question" --human\` when only a person can answer a part of it.`,
    `- \`swarmup handoff ${task} <agent> "why"\` when another agent should answer it.`,
  );
  return lines;
}

/** One message a chat turn answers: from the person in the app, or a channel post. */
export interface ChatPromptMessage {
  /**
   * The message's id in the chat. A message a person wrote in the app carries it in the prompt,
   * so the agent can name it as the source of a decision: `--source chat:<id>` (AO-0109).
   */
  id?: string;
  from: string;
  text: string;
  /** The channel of a post that mentions the agent, without `#`. */
  channel?: string;
}

export interface ChatPromptInput {
  agent: string;
  /** The human the chat belongs to. */
  human: string;
  /** The first turn of a session gets the role and the rules; later turns a short reminder. */
  first: boolean;
  roleFile?: string;
  role?: Pick<AgentDef, 'kb' | 'files' | 'style'>;
  messages: ChatPromptMessage[];
}

/**
 * The prompt of one chat turn. The session carries the context between turns, so only the first
 * turn repeats the role and the rules in full.
 */
export function chatPrompt(p: ChatPromptInput): string {
  const lines: string[] = [];
  if (p.first) {
    lines.push(
      `You are ${p.agent} in SwarmUp, in a chat with ${p.human} in the desktop app. Use the`,
      'swarmup skill; your id is in SWARMUP_AGENT. Each message of the chat is one turn of this session.',
    );
    if (p.roleFile) lines.push(`Read your role file first: ${p.roleFile}`);
    if (p.role?.kb && p.role.kb.length > 0) {
      lines.push(
        `Read the learn notes of these topics: ${p.role.kb.map((t) => `\`swarmup kb --topic ${t}\``).join(', ')}.`,
      );
    }
    if (p.role?.files && p.role.files.length > 0) {
      lines.push(`Read these files: ${p.role.files.join(', ')}.`);
    }
    if (p.role?.style?.trim()) lines.push('Writing style:', p.role.style.trim());
    lines.push(
      '',
      'Chat rules:',
      `- ${p.human} brainstorms and adds work here. Answer briefly in Markdown; name tasks by id`,
      '  (AO-0123) so the app links them.',
      '- You may create tasks (`swarmup new`), comment, assign, retype, set priority, park, post in',
      "  channels, file findings and answer agents' asks. Say in your reply what you changed.",
      `- Never give a verdict, decide a vote, or answer an ask that waits for ${p.human}; never`,
      '  claim, start or work a task yourself: hand work to agents with `swarmup new --to` or',
      '  `swarmup assign`.',
      `- When ${p.human} states a decision here, record it in the same turn with`,
      '  `swarmup decision "one line" --source chat:<message id>` (the id is on the message), and',
      '  give the new D- id and the one line in your reply, so it can be corrected. If it conflicts',
      '  with a decision in force (`swarmup decisions --log`), say so in the same reply and ask',
      '  whether it supersedes that one (`--supersedes D-ID`) or both stand.',
      ...(roleOf(p.agent) === 'pm' ? askCheckLines() : []),
      '- Do not edit files, build, commit or push.',
      '- Do not start background tasks, monitors or watchers; the turn ends when you stop.',
      '- Never kill a process; never print, store or export tokens or keys.',
    );
  } else {
    lines.push(
      `Next turn of the chat with ${p.human}. The chat rules of the first turn still hold: act only`,
      'through `swarmup`, no verdicts, no edits, say what you changed.',
    );
  }
  for (const m of p.messages) {
    lines.push('');
    if (m.channel) {
      lines.push(
        `${m.from} mentioned you in #${m.channel}. Answer there with`,
        `\`swarmup channel post ${m.channel} "..."\`, and sum up here what you answered:`,
      );
    } else {
      lines.push(m.id ? `${m.from} writes (message ${m.id}):` : `${m.from} writes:`);
    }
    lines.push('', m.text.trim());
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The rule for a run in a data root's checkout: a branch checked out there takes the task store
 * with it (AO-0133), so code branches live in worktrees inside the checkout, where the run may
 * edit.
 */
function storeCheckoutLines(co: SharedCheckout, task?: string): string[] {
  const top = co.top.replace(/\\/g, '/');
  const keep = co.branch ? `keep \`${co.branch}\` checked out` : 'keep its branch checked out';
  const what = co.code ? 'is the code checkout swarmupd merges into' : 'holds the task store';
  return [
    `- ${top} ${what}: ${keep} and never run \`git checkout\` or`,
    '  `git switch` there. Make code branches in a worktree inside it, such as',
    `  \`git worktree add out/wt-${task ?? '<task id>'} -b <branch> <base>\` (\`--detach <commit>\` to look at`,
    '  one), and work in that folder with `git -C <folder>`; undo a file with `git restore`.',
  ];
}

/**
 * The rule for a run swarmupd started in its task's worktree (AO-0168): the code work and commits
 * belong there, and the store checkout keeps its branch.
 */
function taskWorktreeLines(wt: TaskWorktreePrompt, task?: string): string[] {
  const path = wt.path.replace(/\\/g, '/');
  const top = wt.store.top.replace(/\\/g, '/');
  const on = wt.branch ? `on branch \`${wt.branch}\`` : 'on a detached HEAD';
  const keep = wt.store.branch
    ? `keep \`${wt.store.branch}\` checked out`
    : 'keep its branch checked out';
  // The store's own checkout keeps the wording runs had before AO-0252.
  if (!wt.store.code) {
    return [
      `- swarmupd started you in ${path}, the worktree of ${task ?? 'this task'}, ${on}: change, build`,
      '  and commit the code there; rename the branch if you like. `swarmup` here uses the task store',
      `  in ${top}: ${keep} there and never run \`git checkout\` or \`git switch\` in it.`,
    ];
  }
  return [
    `- swarmupd started you in ${path}, the worktree of ${task ?? 'this task'}, ${on}: change, build`,
    '  and commit the code there; rename the branch if you like. swarmupd merges into the code',
    `  checkout ${top}: ${keep} there and never run \`git checkout\` or \`git switch\` in it.`,
  ];
}

/**
 * A custom prompt (`--prompt-file`, a helper's instructions, a chat turn) with the store-checkout
 * rule appended when the run's folder is a data root's checkout, or the task-worktree rule when
 * swarmupd started it in its task's worktree, so no launch path skips it. Without either, the prompt
 * is returned unchanged.
 */
export function withStoreCheckoutRule(
  prompt: string,
  storeCheckout?: SharedCheckout,
  task?: string,
  taskWorktree?: TaskWorktreePrompt,
  scratch?: string,
): string {
  const lines = storeCheckout
    ? storeCheckoutLines(storeCheckout, task)
    : taskWorktree
      ? taskWorktreeLines(taskWorktree, task)
      : null;
  if (!lines) return prompt;
  if (scratch) lines.push(...scratchLines(scratch));
  const head = prompt.trimEnd();
  const rule = ['Rule for this folder:', ...lines].join('\n');
  return `${head ? `${head}\n\n` : ''}${rule}\n`;
}

/**
 * The rule that turns what a run learned into a learn note (AO-0049): the author writes one
 * before finishing; a reviewer writes one when the work took several review rounds.
 */
function learnRule(task: string, review: boolean): string[] {
  const command =
    `\`swarmup learn <topic> "<title>" --task ${task} ` + '-m "what, why, what to do instead"`';
  return review
    ? [
        '- If the work took several review rounds and the lesson is not in a learn note yet, write',
        `  one with ${command} before your verdict.`,
      ]
    : [
        '- Before you finish, ask yourself what the next agent should know (a gotcha, a fix that',
        `  took several tries). If anything, write it with ${command}.`,
      ];
}

/**
 * Where a work run finds the task's `done_when` (AO-0290) and what its review request owes. The
 * prompt names the field instead of quoting it, so `swarmup show` stays the one place to read it.
 */
const DONE_WHEN_WORK = [
  'If `swarmup show` prints a `done when:` list, the task is done when every line holds: run each',
  'command, and name the commands you ran and their output in your review request.',
];

/** A task's criteria, one line each: id, kind and what it checks. */
function criteriaList(criteria: readonly Criterion[]): string[] {
  return criteria.map((c) => `  - \`${c.id}\` (${c.kind}): ${criterionWhat(c)}`);
}

/** A work run's criteria, and the evidence its review request names for each. */
function criteriaWorkLines(criteria: readonly Criterion[]): string[] {
  const runs = criteria.some((c) => RUN_KINDS.has(c.kind));
  return [
    'Its criteria, by id:',
    ...criteriaList(criteria),
    'In your review request, name the evidence for each criterion by id: the command you ran and',
    'its output, the file or page that shows it, or what the reviewer should read.',
    ...(runs
      ? ['swarmupd runs the `command` and `check` criteria again when it merges the work.']
      : []),
  ];
}

/**
 * A review run's criteria and how it gives a result per criterion. It judges `prose`, `rubric`
 * and `human` criteria by reading the work, and leaves `command`, `check` and `map` criteria to
 * the merge and `swarmup criteria check`: reviewers run no tests or builds (2026-11-18).
 */
function criteriaReviewLines(task: string, criteria: readonly Criterion[]): string[] {
  return [
    "- The task's criteria, by id:",
    ...criteriaList(criteria),
    '- Give a result per criterion: `pass`, `fail` or `na`, with a `note` for each fail. Judge',
    '  `prose`, `rubric` and `human` criteria by reading the work; for a rubric, read the rubric',
    '  file and add a `score` from 0 to 1. Leave `command`, `check` and `map` criteria out: the',
    '  merge runs them.',
    `- Pass the results with the verdict: \`swarmup verdict ${task} changes "what to fix" --criteria-file -\``,
    '  with YAML on stdin, such as `c1: {result: fail, note: "the intro skips pricing"}`, or inline',
    '  with `--pass ID` and `--fail ID:"note"`. An approval gives no `fail`; any fail means changes.',
  ];
}

/** The same for a review run: the list is what the reviewer checks the request against. */
const DONE_WHEN_REVIEW = [
  '- If it prints a `done when:` list, check every line against the commands and output the request',
  '  names and against the diff; a line with no evidence is a reason for `changes`.',
];

/**
 * What a review run does (AO-0289). The reviewer judges the work: whether it does what the task
 * asks, the work itself (code, copy, design or content), what would make it better, and what
 * belongs in the knowledge base. It runs no tests, lint, typecheck, builds or installs: the merge
 * runs the checks of what changed, and the full suite runs before a release (2026-11-18). Work of
 * any kind comes to review, such as copy for a page, where a test run only costs time. It reviews
 * against the task text and its "Done when", so each round checks the same thing: style and
 * matters outside the task become findings, not change requests. It never edits, commits or
 * pushes. The role files of the reviewers say the same.
 */
function reviewLines(
  task: string,
  criteria: readonly Criterion[] = [],
  artifacts?: ReviewArtifactsPrompt,
): string[] {
  return [
    '',
    `Review ${task}: run \`swarmup show ${task}\` and check the work its review request names.`,
    ...(artifacts ? artifactLines(task, artifacts) : []),
    ...DONE_WHEN_REVIEW,
    ...(criteria.length > 0 ? criteriaReviewLines(task, criteria) : []),
    '- Review against the task text and its "Done when": approve work that meets them, and ask for',
    '  changes only where it does not. Leave style and matters outside the task out of the verdict;',
    `  file those with \`swarmup finding "<title>" --task ${task} -m "where, evidence, suggested fix"\`.`,
    '- Judge the work itself: does it do what the task asks, is it right and clear (code, copy,',
    '  design or content), what would make it better, and what belongs in the knowledge base. Read',
    '  the diff (`git show <commit>`, `git diff <base>...<commit>`) and the files around it.',
    '- Do not run tests, lint, typecheck, builds or installs: the merge runs the checks of what',
    '  changed, and the full test suite runs before a release. Copy, content and other work that is',
    '  not code gets read and judged, nothing else.',
    '- Never edit files, commit or push. Notes you keep go in `$SWARMUP_SCRATCH`, never in a repo.',
    'Finish with exactly one verdict:',
    `\`swarmup verdict ${task} approve "why"\` or \`swarmup verdict ${task} changes "what to fix, file:line"\`.`,
  ];
}

/** What the check run of a milestone needs from its plan (AO-0110, "Closing"). */
export interface MilestoneCheckPrompt {
  /** The milestone's one `done_when` line: the check. */
  doneWhen?: string;
  /** The failed checks so far, oldest first: each filed fix tasks. */
  failed: Array<{ event: string; actor: string; at: string; keys: string[]; note: string }>;
  /** The failed checks that may add fix tasks; the one after them asks instead. */
  fixRounds: number;
  /** The plan items whose task is parked: dropped work the result names by key. */
  parked: Array<{ key: string; task: string }>;
}

/**
 * The task lines of a milestone check (AO-0110, "Closing"): the `qa` run checks `done_when` on
 * the merged work and ends in one of three ways. A pass closes the milestone. A failed check
 * files one fix task per gap, which blocks the milestone again and ends the run's claim. After
 * `fixRounds` failed checks the next one files none and asks, because two rounds of fixes that
 * do not pass mean the plan or the check is wrong. The ask has no `--to`: it reaches the PM,
 * which forwards it to the person (AO-0173).
 */
function checkLines(task: string, c: MilestoneCheckPrompt): string[] {
  const lines = [
    '',
    `Check the milestone ${task}: every task of its plan is closed and its work is merged. Run`,
    `\`swarmup show ${task}\` and \`swarmup plan show ${task}\`, then \`swarmup start ${task}\` with a`,
    'one-line plan.',
    c.doneWhen
      ? `- The check is the milestone's \`done when:\` line: "${c.doneWhen}". Run it against the code`
      : "- The check is the milestone's `done when:` line. Run it against the code",
    '  and the product as they are now. You check; you change no code.',
    `- Record the evidence before you finish: \`swarmup checkpoint ${task} "..." --next "..."\` with`,
    '  the commands you ran and their output, the files you read and screenshots (`swarmup attach`).',
  ];
  if (c.parked.length > 0) {
    lines.push(
      `- Parked plan items, whose work was dropped: ${c.parked.map((p) => `\`${p.key}\` (${p.task})`).join(', ')}.`,
      '  Judge whether the check holds without them, and name each by key in your result.',
    );
  }
  const n = c.failed.length;
  if (n > 0) {
    lines.push(`- Failed checks so far: ${n}. Each filed fix tasks, which are closed now:`);
    for (const f of c.failed) {
      const note = f.note.split('\n')[0]?.trim();
      lines.push(
        `  - ${task}#${f.event} (${f.at.slice(0, 10)}, ${f.actor}): fixes ${f.keys.map((k) => `\`${k}\``).join(', ')}${note ? `; ${note}` : ''}`,
      );
    }
  }
  lines.push(
    'Finish with exactly one of these:',
    `- The check passes: \`swarmup done ${task} "check passed: <evidence>"\`.`,
  );
  if (n < c.fixRounds) {
    lines.push(
      '- The check fails: add one fix task per gap, and nothing else, with the plan items on stdin:',
      `  \`swarmup plan amend ${task} --kind fix --file - -m "check failed: <what failed, evidence>"\`.`,
      '  Each item is `key` (new, lowercase, such as `fix-signing`), `title`, `owner` (such as',
      '  `*:engineer`), `estimate` (`30m`, `2h`, `1d`), `done_when` (one line an agent can check),',
      '  `body` (the gap and its evidence) and, when the gap traces to a plan item, `for: <its key>`:',
      '    items:',
      '      - key: fix-signing',
      '        title: Sign the build in CI',
      "        owner: '*:engineer'",
      '        estimate: 2h',
      '        done_when: The CI build passes the signature check',
      '  The amendment blocks the milestone until the fix tasks close and merge, and it ends your',
      '  claim: stop after it, with no other finishing command. swarmupd starts the next check.',
    );
  } else {
    const nth = n === 2 ? 'third' : `${n + 1}th`;
    lines.push(
      `- The check fails: this is the ${nth} failed check, so add no fix tasks; \`swarmup plan amend`,
      '  --kind fix` is refused now. Fixes that do not pass twice mean the plan or the check is wrong.',
      `  Ask, without \`--to\`: \`swarmup ask ${task} "..." --recommend "<the option you would pick>"\`.`,
      `  The question names ${task}, says what failed in each check (the ${n} earlier ones and this`,
      '  one, with the evidence) and gives the options: change `done_when`, add work, or park the',
      '  milestone. It reaches the PM, which forwards it to the person.',
    );
  }
  return lines;
}

/** The first line of every message about a conflict with a decision (AO-0109). */
const CONTRADICTION = 'contradiction with D-NNNN (YYYY-MM-DD): <the line of the decision>';

/**
 * The PM's check before it answers an ask (AO-0109, "Contradiction checks", 2): an answer that
 * would break a decision in force goes to the person instead, as the PM's own ask with the two
 * ways out and a recommendation. An inbox run and the first chat turn of a PM carry it; the PM
 * role template says the same.
 */
export function askCheckLines(): string[] {
  return [
    '- Before you answer an ask, compare the answer you would give with the decisions in force',
    '  for its task: `swarmup decisions --log --task ID` (`swarmup answer` prints them too). If',
    '  the answer would break one, do not give it. Forward the ask to the person:',
    `  \`swarmup ask ID "${CONTRADICTION}. <who asks for what, ID#<event id>>.`,
    '  keep: <what the task does then>. change: <what replaces D-NNNN>." --recommend "keep: <why>"`',
    '  (or `change`). The answer of the person still goes to the agent that asked.',
  ];
}

/**
 * The PM's check of a decision a person just recorded (AO-0109, "Dawid's own changes of
 * direction"): a `record` item in its inbox. A conflict the record names in neither
 * `supersedes` nor `narrows` goes to the person as a comment, which blocks nothing.
 */
export function recordCheckLines(): string[] {
  return [
    '- A `record` item in your inbox is a decision a person just recorded. Compare it with the',
    '  decisions in force in its scope (`swarmup decisions --log --project P`, or `--task ID` for',
    '  a tree). If it conflicts with one that it names in neither `supersedes` nor `narrows`, tell',
    '  the person and block nothing:',
    '  `swarmup comment ID "D-0050 conflicts with D-0012 (YYYY-MM-DD): supersede D-0012, or keep',
    '  both?" --to human:<name>`, on the task of either decision; when neither has a task, post it',
    '  in a channel with `@human:<name>`. A record without a conflict needs nothing.',
  ];
}

/** One task of a plan check: its new plans and the decisions in force for it. */
export interface PlanCheckTask {
  task: string;
  title: string;
  plans: Array<{
    /** The id of the `start` or `checkpoint` event. */
    event: string;
    actor: string;
    /** `start`: the plan of `swarmup start`. `next`: the `--next` step of a checkpoint. */
    kind: 'start' | 'next';
    text: string;
  }>;
  decisions: Array<Pick<LogEntry, 'id' | 'at' | 'text'>>;
}

/** The longest plan text a plan check quotes, in characters. */
const PLAN_TEXT_MAX = 600;

/**
 * The instructions of a plan-check run (AO-0109, "Contradiction checks", 3), passed as the
 * prompt's `extra`: the new `start` plans and checkpoint `--next` steps of each task, with the
 * decisions in force for it, and what the PM does on a conflict. The worker holds the task, so
 * the PM cannot block it with `swarmup ask`: it tells the worker to stop and ask, and tells the
 * person, who decides between `keep` and `change`.
 */
export function planCheckPrompt(tasks: PlanCheckTask[], human = 'human:<name>'): string {
  const lines = [
    'Plan check: compare each new plan below with the decisions in force for its task. Do',
    'nothing else in this run: handle no inbox item and start no task.',
  ];
  for (const t of tasks) {
    lines.push('', `${t.task} · ${t.title}`);
    for (const p of t.plans) {
      const text = p.text.replace(/\s+/g, ' ').trim();
      const cut = text.length > PLAN_TEXT_MAX ? `${text.slice(0, PLAN_TEXT_MAX)}…` : text;
      const what = p.kind === 'start' ? 'Plan' : 'Next step';
      lines.push(`- ${what} by ${p.actor} (event ${p.event}): ${cut}`);
    }
    lines.push(...decisionLines(t.task, t.decisions));
  }
  lines.push(
    '',
    'For each plan:',
    '- It fits the decisions: write nothing.',
    '- It does what a decision rules out, or leaves out what one requires: the worker holds the',
    '  task, so you cannot block it with `swarmup ask`. Write two comments:',
    `  1. \`swarmup comment ID "${CONTRADICTION}.`,
    '     Your plan (event <id>) <what conflicts>. Stop that part and finish with swarmup ask ID',
    '     \\"contradiction with D-NNNN: ...\\"." --to <the worker>`',
    '  2. `swarmup comment ID "ID: contradiction with D-NNNN (YYYY-MM-DD): <the line of the',
    '     decision>. Plan by <worker> (ID#<event id>): <what it does>. keep: <what the task does',
    `     then>. change: <what replaces D-NNNN>. Recommended: keep, <why>." --to ${human}\``,
    '- Compare what the plan does, not its words. Read `swarmup show ID` when a plan is too short',
    '  to judge.',
    'When you have checked every plan, stop.',
  );
  return lines.join('\n');
}

/** The standard prompt for a supervised run. */
export function runPrompt(p: PromptInput): string {
  const lines = [
    `You are ${p.agent} in SwarmUp. Use the swarmup skill; your id is in SWARMUP_AGENT.`,
  ];
  if (p.roleFile) lines.push(`Read your role file first: ${p.roleFile}`);
  if (p.role?.kb && p.role.kb.length > 0) {
    lines.push(
      `Read the learn notes of these topics before you work: ${p.role.kb.map((t) => `\`swarmup kb --topic ${t}\``).join(', ')}.`,
    );
  }
  if (p.role?.files && p.role.files.length > 0) {
    lines.push(`Read these files before you work: ${p.role.files.join(', ')}.`);
  }
  if (p.role?.style?.trim()) lines.push('Writing style:', p.role.style.trim());
  if (p.notes && p.notes.length > 0) {
    lines.push(
      '',
      'Learn notes that may apply; read the ones that fit with `swarmup kb --read <ref>`:',
      ...p.notes.map((note) => `- \`${note.ref}\`: ${note.title}`),
    );
  }
  if (p.map) {
    lines.push(...mapPromptLines(p.map, p.review ? 'review' : p.question ? 'read' : 'work'));
  }
  if (p.extra) {
    lines.push('', p.extra.trim());
  } else if (p.task && p.review) {
    lines.push(...reviewLines(p.task, p.criteria, p.artifacts));
  } else if (p.task && p.question) {
    lines.push(...questionLines(p.task, p.question));
  } else if (p.task && p.check) {
    lines.push(...checkLines(p.task, p.check));
  } else if (p.task) {
    lines.push(
      '',
      `Work on ${p.task}: run \`swarmup show ${p.task}\`, then \`swarmup start ${p.task}\` with a one-line plan.`,
      ...DONE_WHEN_WORK,
      ...(p.criteria && p.criteria.length > 0 ? criteriaWorkLines(p.criteria) : []),
      'Finish it with exactly one finishing command (review, done, handoff, ask, block or release).',
    );
  } else {
    lines.push(
      '',
      'Run `swarmup inbox` and handle what waits for you, then `swarmup next` and work that task.',
    );
    // The PM answers agents' asks and gets each new decision record in its inbox (AO-0109).
    if (roleOf(p.agent) === 'pm') {
      lines.push(
        '',
        'Check asks and new decisions against the decision log:',
        ...askCheckLines(),
        ...recordCheckLines(),
      );
    }
  }
  if (p.task && p.context) lines.push(...runContextLines(p.task, p.context));
  if (!p.task && p.briefs) lines.push(...briefRefreshLines(p.briefs));
  // Inline, not a command to run: a line in the prompt is read every time (AO-0109). A question
  // run answers and changes nothing, so it has no plan to check and gets no list.
  if (p.task && !p.question && p.decisions && p.decisions.length > 0) {
    lines.push('', ...decisionLines(p.task, p.decisions, { check: true }));
  }
  lines.push(
    '',
    'Rules for supervised runs:',
    '- Do not start background tasks, monitors or watchers; this run ends when you stop.',
    '- Never kill a process you did not start in this run, and only by the PID your own command',
    '  printed; never kill by name, user or start time.',
    '- Never print, store or export tokens or keys.',
    '- Every message to a person (ask, review, comment to human:*) names the task id, and',
    '  ID#<event id> or the date and author for a comment; says in one or two sentences what it',
    '  is about; and states the decision or action needed. Never "see the comment of <date>".',
  );
  if (p.storeCheckout) lines.push(...storeCheckoutLines(p.storeCheckout, p.task));
  else if (p.taskWorktree) lines.push(...taskWorktreeLines(p.taskWorktree, p.task));
  if (p.scratch && !p.review) lines.push(...scratchLines(p.scratch));
  // Review runs end with a verdict and write nothing, so the work rules would contradict it.
  if (!p.review) {
    lines.push(
      '- Decide technical and process choices yourself: pick the option you would recommend and',
      '  say why in your finishing command; the reviewer checks it. Ask a person only about money,',
      '  accounts, publishing, deleting data or the goal of the task.',
    );
    // A question run changes nothing, so the commit and push rule does not apply to it.
    if (!p.question) {
      lines.push(
        '- If you cannot commit, push or open a PR here (no GitHub sign-in, read-only .git), never',
        '  ask for access: finish with `swarmup review` naming the commit and branch, or the changed',
        '  files and where they are; the orchestrator commits and pushes.',
      );
    }
  }
  if (p.task && !p.question) lines.push(...learnRule(p.task, p.review === true));
  lines.push(
    `- Before you stop, run \`swarmup sync --session-end\` (agent ${actorSlug(p.agent)}).`,
  );
  return `${lines.join('\n')}\n`;
}
