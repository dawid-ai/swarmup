import { existsSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import type { McpConfig, UserConfig } from '@swarmup/core';
import {
  CHECKS_HASH_RE,
  TRIGGERS_HASH_RE,
  checkEffort,
  checkMcpConfig,
  checkModel,
  daemonSection,
  envVar,
  isActorId,
  isHuman,
  OpsError,
  parseDuration,
  READ_ONLY_ROLES,
  runtimeOf,
} from '@swarmup/core';
import type { ModelPrice } from './bench-cost.js';
import { checkBenchPrices } from './bench-cost.js';
import type { MergeCheck } from './merge-checks.js';
import type { NotifyConfig } from './notify.js';
import { checkNotify } from './notify.js';
import type { PublishConfig } from './publish.js';
import { checkPublishConfig } from './publish.js';

/** How to start one runtime. `{prompt}` is not used: the prompt always goes on stdin. */
export interface RuntimeConfig {
  /** Executable name or path, such as `claude` or `codex`. */
  command: string;
  /** Extra arguments placed before the generated ones. */
  args?: string[];
  /**
   * Model for this provider's runs, passed as `--model` (Claude) or `-m` (Codex). An agent's
   * `model` overrides it. Other providers get no model flag: their `args` are the whole line.
   */
  model?: string;
  /**
   * Reasoning effort for this provider's runs, passed as `--effort` (Claude) or
   * `-c model_reasoning_effort=` (Codex). An agent's `effort` overrides it. Other providers get
   * no effort flag.
   */
  effort?: string;
  /**
   * Usage windows that apply to one model, as window name to a word of the model's name, such as
   * `seven_day_overage_included: fable`. Such a window pauses only runs of that model. Merged over
   * the built-in map (`DEFAULT_MODEL_WINDOWS`); an empty value makes a window count for every run.
   */
  model_windows?: Record<string, string | null>;
  /** Environment variables removed for this runtime's runs. */
  unset_env?: string[];
  /** Most live runs of this provider on this PC; no limit when unset. */
  max_live?: number;
  /**
   * Codex only: `true` keeps a writing run in a task worktree in Codex's sandbox
   * (`workspace-write`). By default such a run gets `danger-full-access`, so it can commit: on
   * Windows the sandbox refuses git's writes to the shared `.git` from time to time.
   */
  sandbox_worktrees?: boolean;
  /** Overrides `usage_pause_at` for this provider. */
  pause_at?: number;
  /** Paused from Settings: swarmupd starts no new runs on this provider; live runs go on. */
  paused?: boolean;
  /**
   * Arguments, after `command` and `args`, of a status command that says whether the runtime is
   * signed in without calling a model (AO-0154). Defaults: `auth status` for Claude, `login
   * status` for Codex. `false`: no such command, so a signed-out runtime gets one run an hour.
   */
  sign_in_check?: string[] | false;
}

/** Limits for one role (the part after the colon), counted over every provider. */
export interface RoleConfig {
  /** The role changes files. Default true, except for `qa` and `reviewer`. */
  writes?: boolean;
  /** Most live runs of the role on one project. Default 1 if it writes, else 3. */
  per_project?: number;
  /** Most live runs of the role on all projects; no limit when unset. */
  max_live?: number;
  /**
   * Live runs per project while reviews pile up there (`review_backlog`). Default: twice
   * `per_project` for roles that only read, `per_project` for roles that write.
   */
  burst?: number;
  /** Providers in order of preference for tasks owned by `*:<role>`; default: `runtimes` order. */
  providers?: string[];
  /** Hand a `*:<role>` task to the next provider when the preferred ones have no room. Default true. */
  overflow?: boolean;
  /** Most helper runs (`swarmup spawn`) one run of this role may have live at once. Default 2. */
  max_children?: number;
}

/**
 * Built-in limits a config entry overrides key by key. One orchestrator run at a time, chat turns
 * included, so two runs never answer one ask differently.
 */
const ROLE_DEFAULTS: Record<string, RoleConfig> = { orchestrator: { max_live: 1 } };

export interface RoleLimits {
  writes: boolean;
  per_project: number;
  max_live?: number;
  burst: number;
  providers: string[];
  overflow: boolean;
  max_children: number;
}

export function roleLimits(cfg: OpsdConfig, role: string): RoleLimits {
  const r = { ...ROLE_DEFAULTS[role], ...cfg.roles[role] };
  const writes = r.writes ?? !READ_ONLY_ROLES.includes(role);
  const perProject = r.per_project ?? (writes ? 1 : 3);
  return {
    writes,
    per_project: perProject,
    max_live: r.max_live,
    burst: Math.max(perProject, r.burst ?? (writes ? perProject : perProject * 2)),
    providers: r.providers ?? Object.keys(cfg.runtimes),
    overflow: r.overflow ?? true,
    max_children: r.max_children ?? 2,
  };
}

export interface AgentRunConfig {
  /** Start a run when the agent has new inbox items or a task to claim. */
  wake?: boolean;
  /** Working directory for its runs; defaults to the top of the root's git repo. */
  cwd?: string;
  /** Default time budget for a run, such as `2h`. */
  budget?: string;
  /** Model for this agent's runs; overrides the role file's and the provider's. */
  model?: string;
  /** Reasoning effort for this agent's runs; overrides the role file's and the provider's. */
  effort?: string;
}

/** The desktop chat with the PM. */
export interface ChatConfig {
  /** The agent the chat talks to; a Claude agent, since each turn resumes its session. */
  agent: string;
  /** Channel posts that mention the agent continue the chat. */
  mentions: boolean;
  /** Time budget of one turn, such as `20m`; defaults to the agent's budget. */
  budget?: string;
}

export const DEFAULT_CHAT_AGENT = 'claude:pm';

export interface ScheduleConfig {
  name: string;
  /** Interval such as `30m` or `24h`. */
  every?: string;
  /** Daily local time such as `09:00`. */
  at?: string;
  /** The agent to run. */
  agent: string;
  /** The prompt; defaults to the standard work-the-queue prompt. */
  prompt?: string;
  task?: string;
  /** Kept in the config but starts no runs. */
  paused?: boolean;
}

/**
 * Merging approved work of one root (`swarmupd.merge.<root name>`). Kept per machine, in the user
 * config: the commands run here, and a task store's shared config never names what swarmupd runs.
 */
export interface MergeConfig {
  /** The branch approved work goes into, such as `v2`. */
  base: string;
  /** The checkout the base is built in; defaults to the top of the root's git repo. */
  checkout?: string;
  /**
   * Commands that must pass on the rebased work before the base moves, run in swarmupd's worktree.
   * An entry `{ run, paths }` runs only when the merge changes a file of `paths` (AO-0382).
   */
  checks?: MergeCheck[];
  /** Commands run in `checkout` after the base moved, such as `npm run build`. */
  build?: string[];
  /**
   * Commands run before `build` in each directory of `checkout` whose `package-lock.json`,
   * `npm-shrinkwrap.json` or `pnpm-lock.yaml` the merge changed, so the build sees new
   * dependencies (AO-0185). Defaults, in each of those directories, to
   * `pnpm install --frozen-lockfile` when it has a `pnpm-lock.yaml` (AO-0299), else to
   * `npm install --no-save --no-audit --no-fund` when it still has an npm lockfile, followed by
   * an install by name of the optional packages npm left out (AO-0229); `[]` turns it off. Also
   * run in `checkout` itself, once, when a `build` command fails without it, before one more
   * build (AO-0232).
   */
  install?: string[];
  /** Minutes each command may take; default 30. */
  timeout_minutes?: number;
  /**
   * The most approved tasks one merge takes together (AO-0381): rebased in turn onto one
   * candidate, checked once, and the base moved once. Default `DEFAULT_MERGE_BATCH`; 1 merges
   * each task alone.
   */
  batch?: number;
}

/** How many approved tasks one merge takes together when `swarmupd.merge.<root>.batch` is unset. */
export const DEFAULT_MERGE_BATCH = 8;

/**
 * Which files of one root count as tests and as check configuration, for the list of such changes
 * in a review run's prompt (`swarmupd.test_changes.<root name>`, AO-0291). A pattern without `/`
 * matches the file name in any folder; `*` and `?` stay inside one path segment, `**` crosses
 * folders. An unset list takes the defaults (`DEFAULT_TEST_PATTERNS`, `DEFAULT_CHECK_PATTERNS`).
 */
/**
 * Benchmarks the desktop app lists and runs (`docs/benchmarks.md`): set files beyond each root's
 * `.swarmup/benchmarks/`, and results folders beyond swarmupd's own `bench/`.
 */
export interface BenchConfig {
  /** Set files (`<set>.yaml`) or folders of them. */
  sets: string[];
  /** Folders whose subfolders are bench runs (each with a `summary.json` or `status.json`). */
  results: string[];
  /** USD per million tokens by model, over the built-in prices, for costs estimated from tokens. */
  prices?: Record<string, ModelPrice>;
}

/**
 * The LLM judge of `rubric` criteria (W7, `swarmupd.judge`): which runtime and model score the
 * work, how hard it thinks, how long one judgment may take, and whether swarmupd judges at merge.
 */
export interface JudgeConfig {
  /** `claude` or `codex`. Default `claude`. */
  runtime: string;
  /** The model; default `sonnet` for Claude, the runtime's own `model` for Codex. */
  model?: string;
  /** Reasoning effort; default `low`. */
  effort: string;
  /** Minutes one judgment may take before swarmupd stops it; default 5. */
  budget_min: number;
  /**
   * Judge a task's `rubric` criteria at merge, after its `command` and `check` criteria pass; a
   * score below `pass` sends the task back. Off unless set to true: each judgment spends tokens.
   */
  at_merge: boolean;
}

/** The judge when `swarmupd.judge` leaves a key out. */
export const DEFAULT_JUDGE: JudgeConfig = {
  runtime: 'claude',
  effort: 'low',
  budget_min: 5,
  at_merge: false,
};

/**
 * The benchmark gate of the self-improvement loop (W6, `swarmupd.improve.benchmark`): the set a
 * proposal is replayed on, base against variant, and the repo it runs in.
 */
export interface ImproveBenchConfig {
  /** A set file swarmupd lists: under `swarmupd.bench.sets` or a root's `benchmarks/`. */
  set: string;
  /** The repo under test. */
  repo: string;
  hidden_dir?: string;
  /** Entries of the set to run; all by default. */
  entries?: string[];
  /** Attempts per entry, for each of base and variant. Default 1. */
  repeat: number;
  /** Minutes each attempt may run; the set's own by default. */
  budget_min?: number;
}

/**
 * The self-improvement loop (W6, `swarmupd.improve`): when an agent's scores fail often enough,
 * swarmupd files a task for the improver; when a proposal is recorded and `benchmark` is set, it
 * replays the set with the base and the variant.
 */
export interface ImproveConfig {
  /** File improvement tasks on its own. Off unless set to true. */
  enabled: boolean;
  /**
   * File an improvement task for an agent with learn-note promotion candidates (W6): fold the
   * notes that keep mattering into its role file. Off unless set to true; independent of
   * `enabled`.
   */
  notes: boolean;
  /** Distinct failing task and run scores of one agent that file a task. Default 10. */
  threshold: number;
  /** Only scores of the last this many days count. Default 7. */
  max_age_days: number;
  /** Who works the task. Default `claude:improver`. */
  agent: string;
  /** Hours between looks at the scores. Default 3. */
  check_hours: number;
  /** The benchmark gate; off without it, since it spends tokens. */
  benchmark?: ImproveBenchConfig;
}

export const DEFAULT_IMPROVE: ImproveConfig = {
  enabled: false,
  notes: false,
  threshold: 10,
  max_age_days: 7,
  agent: 'claude:improver',
  check_hours: 3,
};

/** The model a Claude judge uses when `swarmupd.judge.model` is unset. */
export const DEFAULT_JUDGE_CLAUDE_MODEL = 'sonnet';

export interface TestChangesConfig {
  /** Test files. */
  tests?: string[];
  /** Test, lint and CI configuration, and files that hold package scripts. */
  checks?: string[];
}

/** The `swarmupd` section of the user config. */
export interface OpsdConfig {
  /**
   * The top-level keys the user config sets itself, not filled in from defaults (W5): team policy
   * in `swarm.yaml` fills only the others. Unset in a config built by hand; then every key counts
   * as set, and git policy changes nothing.
   */
  explicit?: string[];
  port: number;
  /** Seconds between supervisor ticks. */
  tick_seconds: number;
  /** Seconds between looks at the processes of live runs. */
  proc_seconds: number;
  /** Most live runs on this PC; defaults to the number of CPU cores. */
  max_runs: number;
  /**
   * Paused from the app, its tray icon or `swarmup daemon pause`: no new runs or schedules start. Live
   * runs, their helper runs, sync and the API go on. It stays paused until resumed.
   */
  paused: boolean;
  /** No new run while the PC has less free memory than this, in GB. */
  min_free_gb: number;
  /**
   * Share of a provider's usage window (0 to 1) at which swarmupd starts no new runs on it until the
   * window resets. The rest stays for the human's own sessions.
   */
  usage_pause_at: number;
  roles: Record<string, RoleConfig>;
  /** Minutes to pause a provider whose usage-limit error names no reset time. */
  usage_cooldown_minutes: number;
  /**
   * Minutes a task owned by name by an agent of a signed-out provider waits before swarmupd hands it
   * to the same role on another provider (AO-0154). 0 never hands it over.
   */
  signed_out_handoff_minutes: number;
  /**
   * Tasks waiting for review in one project at which swarmupd starts no new work there for roles
   * that write, and lets reviewers burst, so reviews catch up before more work piles on.
   */
  review_backlog: number;
  /**
   * Hours a review waits for a reviewer of the other provider that cannot run (paused for usage,
   * or signed out) before swarmupd moves it to a reviewer of the author's provider (AO-0341).
   * Counted from the later of the pause and the review request. 0 never moves it.
   */
  review_fallback_hours: number;
  /** Default run budget in minutes when neither the task nor the agent sets one. */
  budget_minutes: number;
  /** Minutes before the same agent is woken again for the same items. */
  wake_cooldown_minutes: number;
  /**
   * Minutes swarmupd starts no run on a task after a session of an agent outside swarmupd (one
   * with no `SWARMUP_RUN`) last wrote an event on it under its own claim, so that session can take
   * the task up again, say after a change request (AO-0236). 0 never waits.
   */
  outside_session_minutes: number;
  /**
   * Runs of a task in a row that end without finishing and with no work between them before
   * swarmupd stops starting it: it blocks the task for a PM and files a finding with what the run
   * logs say. 0 turns this off. Default 3.
   */
  stuck_runs: number;
  /**
   * `changes` verdicts on a task in a row, with no approval between them, before swarmupd stops
   * waking its author: it blocks the task for a PM with the count and the text of those verdicts
   * (AO-0288). 0 turns this off. Default 3.
   */
  review_rounds: number;
  /**
   * Minutes between two plan checks (AO-0109): swarmupd starts a PM run with the `start` plans
   * and checkpoint `--next` steps written since the last one, and the decisions in force for
   * their tasks, at most this often and only when there are any. 0 turns this off. Default 30.
   */
  plan_check_minutes: number;
  /** Commit, pull and push each root when its sync policy says so. */
  sync: boolean;
  /**
   * The default providers were written into the file (`swarmupd.seeded`). From then on the file's
   * `runtimes` are the only providers; before, the defaults fill in what the file leaves out.
   */
  seeded: boolean;
  runtimes: Record<string, RuntimeConfig>;
  agents: Record<string, AgentRunConfig>;
  schedules: ScheduleConfig[];
  /**
   * Per root name, whether this machine runs the root's git triggers (`triggers/*.yaml`, W5).
   * Off unless set to true: git never starts runs on a machine without its consent.
   */
  triggers: Record<string, boolean>;
  /**
   * Per root name, what a person trusted of the root's git definitions on this machine
   * (`swarmup defs trust`, W5 phase 4): the hash of the `swarm.yaml` merge checks (`checks`) and
   * of the trigger set (`triggers`). Each runs only while the root's set has the hash kept here.
   */
  trusted_defs: Record<string, TrustedDefs>;
  /**
   * Create tasks from the roots' repeats (`repeats/*.md`) each tick. On by default; set it to
   * false on every PC but one that shares a task store, so two PCs never fire the same slot.
   */
  repeats: boolean;
  /** Webhook notifications for the human; the URL is a secret and stays in the user config. */
  notify: NotifyConfig;
  chat: ChatConfig;
  /** Roots whose approved branches swarmupd merges, by root name. */
  merge: Record<string, MergeConfig>;
  /**
   * Per root name, the patterns of the test and check configuration files whose changes a review
   * run's prompt lists (AO-0291), or false for no list. A root without an entry gets the list
   * with the default patterns.
   */
  test_changes: Record<string, TestChangesConfig | false>;
  /**
   * Per root name, whether swarmupd pushes the repo's task branches with new commits at each sync and
   * deletes a merged one's remote branch. On for every root unless set to false.
   */
  push_branches: Record<string, boolean>;
  /**
   * Per root name, the code checkout of a root whose task store is a repo of its own (AO-0252).
   * Runs start there, task worktrees are made in it, and swarmupd pushes the merge base there after
   * each merge. Without an entry, the code is the repo the store is in.
   */
  code: Record<string, string>;
  /**
   * Start each run on a code task, of a role that writes, in the task's own worktree
   * (`out/wt-<ID>`, made on a task branch when missing) instead of the store checkout, so
   * engineers work side by side (AO-0168). On unless set to false: then such runs share the
   * store checkout, one writer at a time.
   */
  task_worktrees: boolean;
  /**
   * Remove a closed task's worktree `out/wt-<ID>` once it is clean and its commit is on a branch
   * (AO-0230). The branch stays, and a reopened task gets its worktree again from it. On unless
   * set to false.
   */
  reclaim_worktrees: boolean;
  /** Minutes a task stays closed before its worktree is removed, so a quick reopen keeps it. */
  reclaim_after_minutes: number;
  /** Days a run's scratch folder is kept after the run ends. */
  scratch_days: number;
  /**
   * Days a run's log and process ledger, and a merge's log, are kept after they end. The run
   * record stays, so `swarmup runs` and the reports keep the run.
   */
  log_days: number;
  /**
   * On Windows, make the files and folders a Codex sandbox session left in a task store again
   * under the signed-in user, and remove the stale locks it left, so the next session can write
   * them (AO-0287). On unless set to false.
   */
  repair_stores: boolean;
  /**
   * Run the root's merge `checks` on the reviewed commit before a review run that cannot run them
   * itself (a Codex run of a role that does not write), and put the results in its prompt
   * (AO-0296). Off unless set to true: a review judges the work and runs no checks; the merge runs
   * the checks of what changed, and the full suite runs before a release (2026-11-18).
   */
  review_checks: boolean;
  /**
   * Delete temp files older than an hour from each root's `.ops/tmp`. Off unless set to true:
   * swarmupd then only names them in its log.
   */
  remove_stale_temp: boolean;
  /**
   * When a task comes back with `changes` to the agent whose run did the work, the next work run
   * resumes that run's session instead of starting fresh (see `resume.ts`). On unless set to
   * false.
   */
  resume_on_changes: boolean;
  /** Hours after a run ended that its session may still be resumed. */
  resume_max_hours: number;
  bench: BenchConfig;
  judge: JudgeConfig;
  improve: ImproveConfig;
  /** MCP servers runs may get (W8): `swarmupd.mcp`, with values from `secrets.yml`. */
  mcp: McpConfig;
  /** Publish adapters (W8 phase 3): `swarmupd.publish.<root>.<name>`, see `publish.ts`. */
  publish: PublishConfig;
}

export const DEFAULT_PORT = 4747;

/**
 * The providers `swarmup setup`, the desktop's first start and swarmupd's first start write into the
 * user config (see `seedUserConfig`), and what "Reset to default" restores. After seeding, the
 * config is the only source of providers: code reads these for seeding and resetting only.
 */
export const DEFAULT_RUNTIMES: Record<string, RuntimeConfig> = {
  claude: { command: 'claude' },
  // Runs inherit swarmupd's environment and act as the human's accounts; task events record which
  // agent did what. Codex's sandbox blocks network and `.git` writes on its own.
  codex: { command: 'codex' },
};

/** Roles seeded as agents for each installed default provider, such as `claude:engineer`. */
export const DEFAULT_AGENT_ROLES = ['engineer', 'qa', 'reviewer', 'pm'];

/** Written as `swarmupd.seeded`; bump it when the seed adds something a seeded config should get. */
export const SEED_VERSION = 1;

// Moved to core, where the definition schemas check the same values (W5); kept here for callers.
export { checkEffort, checkModel };

const WINDOW_RE = /^[A-Za-z0-9_-]{1,60}$/;

function checkModelWindows(v: unknown, where: string): void {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new OpsError(`${where}: use window names, each with a model such as fable`, 2);
  }
  for (const [name, model] of Object.entries(v as Record<string, unknown>)) {
    if (!WINDOW_RE.test(name)) throw new OpsError(`${where}: bad window name '${name}'`, 2);
    if (model !== null && model !== '') checkModel(model, `${where}.${name}`);
  }
}

/**
 * The runtimes swarmupd starts. A seeded config lists every provider itself, so a removed one stays
 * removed. An older config gets the defaults with its entries merged into each by key, as
 * before, so a limit set from Settings (`runtimes.codex.max_live`) keeps the default command.
 */
function mergeRuntimes(raw: unknown, seeded: boolean): Record<string, RuntimeConfig> {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new OpsError('swarmupd.runtimes: use one entry per provider name', 2);
  }
  const out: Record<string, RuntimeConfig> = {};
  if (!seeded) for (const [name, rc] of Object.entries(DEFAULT_RUNTIMES)) out[name] = { ...rc };
  for (const [name, rc] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    if (rc === null || typeof rc !== 'object') {
      throw new OpsError(`swarmupd.runtimes.${name}: expected command, args and limits`, 2);
    }
    const merged = { ...out[name], ...rc } as RuntimeConfig;
    if (typeof merged.command !== 'string' || !merged.command.trim()) {
      throw new OpsError(`swarmupd.runtimes.${name}.command: name the program to start`, 2);
    }
    out[name] = merged;
  }
  return out;
}

/**
 * swarmupd's config from the user config's `swarmupd` section, or from the old `opsd` section
 * while the config has no `swarmupd` key, with defaults for what it leaves out.
 */
export function opsdConfig(
  user: UserConfig & { swarmupd?: Partial<OpsdConfig>; opsd?: Partial<OpsdConfig> },
): OpsdConfig {
  const raw: Partial<OpsdConfig> = daemonSection(user) ?? {};
  const seeded = (raw as { seeded?: unknown }).seeded !== undefined;
  const cfg: OpsdConfig = {
    explicit: Object.keys(raw)
      .filter(
        (k) =>
          (raw as Record<string, unknown>)[k] !== undefined &&
          (raw as Record<string, unknown>)[k] !== null,
      )
      .sort(),
    port: raw.port ?? DEFAULT_PORT,
    tick_seconds: raw.tick_seconds ?? 15,
    proc_seconds: raw.proc_seconds ?? 5,
    max_runs: raw.max_runs ?? Math.max(1, cpus().length),
    paused: raw.paused ?? false,
    min_free_gb: raw.min_free_gb ?? 4,
    usage_pause_at: raw.usage_pause_at ?? 0.9,
    roles: raw.roles ?? {},
    review_backlog: raw.review_backlog ?? 3,
    review_fallback_hours: raw.review_fallback_hours ?? 2,
    usage_cooldown_minutes: raw.usage_cooldown_minutes ?? 30,
    signed_out_handoff_minutes: raw.signed_out_handoff_minutes ?? 15,
    budget_minutes: raw.budget_minutes ?? 180,
    wake_cooldown_minutes: raw.wake_cooldown_minutes ?? 10,
    outside_session_minutes: raw.outside_session_minutes ?? 30,
    stuck_runs: raw.stuck_runs ?? 3,
    review_rounds: raw.review_rounds ?? 3,
    plan_check_minutes: raw.plan_check_minutes ?? 30,
    sync: raw.sync ?? true,
    seeded,
    runtimes: mergeRuntimes(raw.runtimes, seeded),
    // `claude:qa:` with nothing after it names the agent with no settings of its own.
    agents: Object.fromEntries(Object.entries(raw.agents ?? {}).map(([id, a]) => [id, a ?? {}])),
    schedules: raw.schedules ?? [],
    triggers: checkRootFlags((raw as { triggers?: unknown }).triggers, 'triggers'),
    trusted_defs: checkTrustedDefs((raw as { trusted_defs?: unknown }).trusted_defs),
    repeats: raw.repeats ?? true,
    notify: checkNotify((raw as { notify?: unknown }).notify),
    chat: {
      agent: raw.chat?.agent ?? DEFAULT_CHAT_AGENT,
      mentions: raw.chat?.mentions ?? true,
      budget: raw.chat?.budget,
    },
    merge: checkMerge((raw as { merge?: unknown }).merge),
    test_changes: checkTestChanges((raw as { test_changes?: unknown }).test_changes),
    push_branches: checkPushBranches((raw as { push_branches?: unknown }).push_branches),
    code: checkCode((raw as { code?: unknown }).code),
    task_worktrees: raw.task_worktrees ?? true,
    reclaim_worktrees: raw.reclaim_worktrees ?? true,
    reclaim_after_minutes: raw.reclaim_after_minutes ?? 60,
    scratch_days: raw.scratch_days ?? 2,
    log_days: raw.log_days ?? 14,
    repair_stores: raw.repair_stores ?? true,
    review_checks: raw.review_checks ?? false,
    remove_stale_temp: raw.remove_stale_temp ?? false,
    resume_on_changes: raw.resume_on_changes ?? true,
    resume_max_hours: raw.resume_max_hours ?? 24,
    bench: checkBench((raw as { bench?: unknown }).bench),
    judge: checkJudge((raw as { judge?: unknown }).judge),
    improve: checkImprove((raw as { improve?: unknown }).improve),
    mcp: checkMcpConfig((raw as { mcp?: unknown }).mcp),
    publish: checkPublishConfig((raw as { publish?: unknown }).publish),
  };
  const count = (v: unknown, name: string, min: number): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
      throw new OpsError(`swarmupd.${name}: use a whole number of at least ${min}`, 2);
    }
  };
  const amount = (v: unknown, name: string): void => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new OpsError(`swarmupd.${name}: use a number of at least 0`, 2);
    }
  };
  count(cfg.max_runs, 'max_runs', 0);
  if (typeof cfg.paused !== 'boolean') throw new OpsError('swarmupd.paused: use true or false', 2);
  if (typeof cfg.repeats !== 'boolean')
    throw new OpsError('swarmupd.repeats: use true or false', 2);
  if (typeof cfg.task_worktrees !== 'boolean') {
    throw new OpsError('swarmupd.task_worktrees: use true or false', 2);
  }
  if (typeof cfg.reclaim_worktrees !== 'boolean') {
    throw new OpsError('swarmupd.reclaim_worktrees: use true or false', 2);
  }
  if (typeof cfg.repair_stores !== 'boolean') {
    throw new OpsError('swarmupd.repair_stores: use true or false', 2);
  }
  if (typeof cfg.review_checks !== 'boolean') {
    throw new OpsError('swarmupd.review_checks: use true or false', 2);
  }
  if (typeof cfg.remove_stale_temp !== 'boolean') {
    throw new OpsError('swarmupd.remove_stale_temp: use true or false', 2);
  }
  if (typeof cfg.resume_on_changes !== 'boolean') {
    throw new OpsError('swarmupd.resume_on_changes: use true or false', 2);
  }
  amount(cfg.resume_max_hours, 'resume_max_hours');
  amount(cfg.reclaim_after_minutes, 'reclaim_after_minutes');
  amount(cfg.scratch_days, 'scratch_days');
  amount(cfg.log_days, 'log_days');
  amount(cfg.min_free_gb, 'min_free_gb');
  amount(cfg.tick_seconds, 'tick_seconds');
  amount(cfg.proc_seconds, 'proc_seconds');
  if (!(cfg.tick_seconds > 0 && cfg.proc_seconds > 0)) {
    throw new OpsError('swarmupd.tick_seconds and swarmupd.proc_seconds must be above 0', 2);
  }
  for (const [name, rc] of Object.entries(cfg.runtimes)) {
    if (rc.max_live !== undefined) count(rc.max_live, `runtimes.${name}.max_live`, 0);
    if (rc.paused !== undefined && typeof rc.paused !== 'boolean') {
      throw new OpsError(`swarmupd.runtimes.${name}.paused: use true or false`, 2);
    }
    if (rc.sandbox_worktrees !== undefined && typeof rc.sandbox_worktrees !== 'boolean') {
      throw new OpsError(`swarmupd.runtimes.${name}.sandbox_worktrees: use true or false`, 2);
    }
    if (rc.model !== undefined) checkModel(rc.model, `swarmupd.runtimes.${name}.model`);
    if (rc.effort !== undefined) checkEffort(rc.effort, `swarmupd.runtimes.${name}.effort`);
    if (rc.model_windows !== undefined) {
      checkModelWindows(rc.model_windows, `swarmupd.runtimes.${name}.model_windows`);
    }
    const check = rc.sign_in_check;
    if (
      check !== undefined &&
      check !== false &&
      (!Array.isArray(check) || check.length === 0 || check.some((a) => typeof a !== 'string'))
    ) {
      throw new OpsError(
        `swarmupd.runtimes.${name}.sign_in_check: use a list of arguments, such as [auth, status], or false`,
        2,
      );
    }
  }
  for (const [name, r] of Object.entries(cfg.roles)) {
    if (r.per_project !== undefined) count(r.per_project, `roles.${name}.per_project`, 0);
    if (r.max_live !== undefined) count(r.max_live, `roles.${name}.max_live`, 0);
    if (r.burst !== undefined) count(r.burst, `roles.${name}.burst`, 0);
    if (r.max_children !== undefined) count(r.max_children, `roles.${name}.max_children`, 0);
    for (const key of ['writes', 'overflow'] as const) {
      if (r[key] !== undefined && typeof r[key] !== 'boolean') {
        throw new OpsError(`swarmupd.roles.${name}.${key}: use true or false`, 2);
      }
    }
    if (
      r.providers !== undefined &&
      (!Array.isArray(r.providers) || r.providers.some((p) => typeof p !== 'string'))
    ) {
      throw new OpsError(`swarmupd.roles.${name}.providers: use a list of runtime names`, 2);
    }
  }
  count(cfg.review_backlog, 'review_backlog', 1);
  amount(cfg.review_fallback_hours, 'review_fallback_hours');
  count(cfg.budget_minutes, 'budget_minutes', 1);
  count(cfg.wake_cooldown_minutes, 'wake_cooldown_minutes', 0);
  count(cfg.outside_session_minutes, 'outside_session_minutes', 0);
  count(cfg.stuck_runs, 'stuck_runs', 0);
  count(cfg.review_rounds, 'review_rounds', 0);
  count(cfg.plan_check_minutes, 'plan_check_minutes', 0);
  if (typeof cfg.sync !== 'boolean') throw new OpsError('swarmupd.sync: use true or false', 2);
  for (const [id, a] of Object.entries(cfg.agents)) {
    if (a.wake !== undefined && typeof a.wake !== 'boolean') {
      throw new OpsError(`swarmupd.agents.${id}.wake: use true or false`, 2);
    }
    if (a.budget !== undefined) {
      // Text only: a bare number would pass here and crash the agent's next launch.
      if (typeof a.budget !== 'string') {
        throw new OpsError(`swarmupd.agents.${id}.budget: use a duration such as 90m or 2h`, 2);
      }
      parseDuration(a.budget);
    }
    if (a.model !== undefined) checkModel(a.model, `swarmupd.agents.${id}.model`);
    if (a.effort !== undefined) checkEffort(a.effort, `swarmupd.agents.${id}.effort`);
  }
  count(cfg.usage_cooldown_minutes, 'usage_cooldown_minutes', 1);
  count(cfg.signed_out_handoff_minutes, 'signed_out_handoff_minutes', 0);
  if (
    typeof cfg.usage_pause_at !== 'number' ||
    !(cfg.usage_pause_at > 0 && cfg.usage_pause_at <= 1)
  ) {
    throw new OpsError('swarmupd.usage_pause_at: use a share from 0 to 1, such as 0.9', 2);
  }
  for (const [name, rc] of Object.entries(cfg.runtimes)) {
    if (
      rc.pause_at !== undefined &&
      (typeof rc.pause_at !== 'number' || !(rc.pause_at > 0 && rc.pause_at <= 1))
    ) {
      throw new OpsError(`swarmupd.runtimes.${name}.pause_at: use a share from 0 to 1`, 2);
    }
  }
  checkChat(cfg.chat);
  const names = new Set<string>();
  for (const s of cfg.schedules) {
    if (names.has(s.name)) throw new OpsError(`swarmupd.schedules: '${s.name}' appears twice`, 2);
    names.add(s.name);
    if (!s.name || !s.agent)
      throw new OpsError('swarmupd.schedules: each needs a name and an agent', 2);
    if (!s.every === !s.at) {
      throw new OpsError(`swarmupd.schedules.${s.name}: set exactly one of every or at`, 2);
    }
    if (s.every) parseDuration(s.every);
    if (s.paused !== undefined && typeof s.paused !== 'boolean') {
      throw new OpsError(`swarmupd.schedules.${s.name}: paused is true or false`, 2);
    }
    if (s.at && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(s.at)) {
      throw new OpsError(`swarmupd.schedules.${s.name}: at must be a time from 00:00 to 23:59`, 2);
    }
  }
  return cfg;
}

function checkChat(c: ChatConfig): void {
  if (typeof c.agent !== 'string' || !isActorId(c.agent) || isHuman(c.agent)) {
    throw new OpsError('swarmupd.chat.agent: name an agent such as claude:pm', 2);
  }
  if (c.agent.includes('*')) {
    throw new OpsError('swarmupd.chat.agent: name one agent, not a wildcard', 2);
  }
  // Only Claude runs get a session to resume and a streamed reply (see `invocation`); on any
  // other runtime each turn would forget the last and the view would show no reply.
  if (runtimeOf(c.agent) !== 'claude') {
    throw new OpsError(
      'swarmupd.chat.agent: the chat runs on Claude for now (it resumes a session)',
      2,
    );
  }
  if (typeof c.mentions !== 'boolean') {
    throw new OpsError('swarmupd.chat.mentions: use true or false', 2);
  }
  if (c.budget !== undefined) {
    if (typeof c.budget !== 'string') {
      throw new OpsError('swarmupd.chat.budget: use a duration such as 20m', 2);
    }
    parseDuration(c.budget);
  }
}

function checkBench(raw: unknown): BenchConfig {
  if (raw === undefined || raw === null) return { sets: [], results: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError('swarmupd.bench: use sets and results, each a list of paths, and prices', 2);
  }
  const extra = Object.keys(raw).filter((k) => !['sets', 'results', 'prices'].includes(k));
  if (extra.length > 0) {
    throw new OpsError(`swarmupd.bench: unknown key ${extra[0]}; use sets, results and prices`, 2);
  }
  const paths = (v: unknown, name: string): string[] => {
    if (v === undefined || v === null) return [];
    const list = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new OpsError(`swarmupd.bench.${name}: use a list of paths`, 2);
    }
    return list as string[];
  };
  const b = raw as { sets?: unknown; results?: unknown; prices?: unknown };
  const prices = checkBenchPrices(b.prices);
  return {
    sets: paths(b.sets, 'sets'),
    results: paths(b.results, 'results'),
    ...(Object.keys(prices).length > 0 ? { prices } : {}),
  };
}

const JUDGE_KEYS = ['runtime', 'model', 'effort', 'budget_min', 'at_merge'];

/**
 * `swarmupd.judge`, checked, with {@link DEFAULT_JUDGE} for what it leaves out. Refuses an unknown
 * key, a runtime other than `claude` or `codex`, a bad model or effort, and a budget outside 1 to
 * 60 minutes, with exit 2.
 */
export function checkJudge(raw: unknown): JudgeConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_JUDGE };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError(`swarmupd.judge: use ${JUDGE_KEYS.join(', ')}`, 2);
  }
  const extra = Object.keys(raw).filter((k) => !JUDGE_KEYS.includes(k));
  if (extra.length > 0) {
    throw new OpsError(`swarmupd.judge: unknown key ${extra[0]}; use ${JUDGE_KEYS.join(', ')}`, 2);
  }
  const j = raw as Record<string, unknown>;
  const out: JudgeConfig = { ...DEFAULT_JUDGE };
  if (j.runtime !== undefined && j.runtime !== null) {
    if (j.runtime !== 'claude' && j.runtime !== 'codex') {
      throw new OpsError('swarmupd.judge.runtime: use claude or codex', 2);
    }
    out.runtime = j.runtime;
  }
  if (j.model !== undefined && j.model !== null && j.model !== '') {
    out.model = checkModel(j.model, 'swarmupd.judge.model');
  }
  if (j.effort !== undefined && j.effort !== null && j.effort !== '') {
    out.effort = checkEffort(j.effort, 'swarmupd.judge.effort');
  }
  if (j.budget_min !== undefined && j.budget_min !== null) {
    const b = j.budget_min;
    if (typeof b !== 'number' || !Number.isFinite(b) || b <= 0 || b > 60) {
      throw new OpsError('swarmupd.judge.budget_min: use minutes from 1 to 60', 2);
    }
    out.budget_min = b;
  }
  if (j.at_merge !== undefined && j.at_merge !== null) {
    if (typeof j.at_merge !== 'boolean') {
      throw new OpsError('swarmupd.judge.at_merge: use true or false', 2);
    }
    out.at_merge = j.at_merge;
  }
  return out;
}

const IMPROVE_KEYS = [
  'enabled',
  'notes',
  'threshold',
  'max_age_days',
  'agent',
  'check_hours',
  'benchmark',
];
const IMPROVE_BENCH_KEYS = ['set', 'repo', 'hidden_dir', 'entries', 'repeat', 'budget_min'];

/**
 * `swarmupd.improve`, checked, with {@link DEFAULT_IMPROVE} for what it leaves out. Refuses an
 * unknown key, a count below 1, an agent that is no `<runtime>:<role>`, and a benchmark without a
 * set or a repo, with exit 2.
 */
export function checkImprove(raw: unknown): ImproveConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_IMPROVE };
  const fail = (m: string): never => {
    throw new OpsError(`swarmupd.improve${m}`, 2);
  };
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(`: use ${IMPROVE_KEYS.join(', ')}`);
  const extra = Object.keys(raw as object).filter((k) => !IMPROVE_KEYS.includes(k));
  if (extra.length > 0) fail(`: unknown key ${extra[0]}; use ${IMPROVE_KEYS.join(', ')}`);
  const r = raw as Record<string, unknown>;
  const out: ImproveConfig = { ...DEFAULT_IMPROVE };
  if (r.enabled !== undefined && r.enabled !== null) {
    if (typeof r.enabled !== 'boolean') fail('.enabled: use true or false');
    out.enabled = r.enabled as boolean;
  }
  if (r.notes !== undefined && r.notes !== null) {
    if (typeof r.notes !== 'boolean') fail('.notes: use true or false');
    out.notes = r.notes as boolean;
  }
  const whole = (v: unknown, k: string): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1)
      fail(`.${k}: use a number of at least 1`);
    return v as number;
  };
  out.threshold = whole(r.threshold, 'threshold') ?? out.threshold;
  out.max_age_days = whole(r.max_age_days, 'max_age_days') ?? out.max_age_days;
  out.check_hours = whole(r.check_hours, 'check_hours') ?? out.check_hours;
  if (r.agent !== undefined && r.agent !== null) {
    if (typeof r.agent !== 'string' || !/^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/.test(r.agent)) {
      fail('.agent: use <runtime>:<role>, such as claude:improver');
    }
    out.agent = r.agent as string;
  }
  if (r.benchmark !== undefined && r.benchmark !== null) {
    const b = r.benchmark;
    if (typeof b !== 'object' || Array.isArray(b))
      fail(`.benchmark: use ${IMPROVE_BENCH_KEYS.join(', ')}`);
    const bx = b as Record<string, unknown>;
    const bad = Object.keys(bx).filter((k) => !IMPROVE_BENCH_KEYS.includes(k));
    if (bad.length > 0)
      fail(`.benchmark: unknown key ${bad[0]}; use ${IMPROVE_BENCH_KEYS.join(', ')}`);
    const path = (k: string, need: boolean): string | undefined => {
      const v = bx[k];
      if (v === undefined || v === null || v === '') {
        if (need) fail(`.benchmark.${k}: name a path`);
        return undefined;
      }
      if (typeof v !== 'string') fail(`.benchmark.${k}: name a path`);
      return v as string;
    };
    let entries: string[] | undefined;
    if (bx.entries !== undefined && bx.entries !== null) {
      const list = typeof bx.entries === 'string' ? bx.entries.split(',') : bx.entries;
      if (!Array.isArray(list) || list.some((e) => typeof e !== 'string')) {
        fail('.benchmark.entries: use a list of entry ids');
      }
      entries = (list as string[]).map((e) => e.trim()).filter(Boolean);
    }
    const hidden = path('hidden_dir', false);
    const budget = whole(bx.budget_min, 'benchmark.budget_min');
    out.benchmark = {
      set: path('set', true)!,
      repo: path('repo', true)!,
      ...(hidden ? { hidden_dir: hidden } : {}),
      ...(entries?.length ? { entries } : {}),
      repeat: whole(bx.repeat, 'benchmark.repeat') ?? 1,
      ...(budget !== undefined ? { budget_min: budget } : {}),
    };
  }
  return out;
}

function checkPushBranches(raw: unknown): Record<string, boolean> {
  return checkRootFlags(raw, 'push_branches');
}

/** What a person trusted of one root's git definitions (`swarmupd.trusted_defs.<root>`). */
export interface TrustedDefs {
  /** `c:` and the SHA-256 of the merge checks. */
  checks?: string;
  /** `t:` and the SHA-256 of the triggers. */
  triggers?: string;
}

function checkTrustedDefs(raw: unknown): Record<string, TrustedDefs> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError(
      'swarmupd.trusted_defs: use one entry per root name; swarmup defs trust writes them',
      2,
    );
  }
  const out: Record<string, TrustedDefs> = {};
  const usage = (root: string): string =>
    `swarmupd.trusted_defs.${root}: use what swarmup defs trust writes: checks (c: and 64 hex digits) and triggers (t: and 64 hex digits)`;
  for (const [root, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new OpsError(usage(root), 2);
    const { checks, triggers, ...rest } = v as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new OpsError(usage(root), 2);
    if (checks !== undefined && (typeof checks !== 'string' || !CHECKS_HASH_RE.test(checks))) {
      throw new OpsError(usage(root), 2);
    }
    if (
      triggers !== undefined &&
      (typeof triggers !== 'string' || !TRIGGERS_HASH_RE.test(triggers))
    ) {
      throw new OpsError(usage(root), 2);
    }
    out[root] = {
      ...(checks !== undefined ? { checks: checks as string } : {}),
      ...(triggers !== undefined ? { triggers: triggers as string } : {}),
    };
  }
  return out;
}

/** A map of root names to true or false, such as `swarmupd.triggers`. */
function checkRootFlags(raw: unknown, key: string): Record<string, boolean> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError(`swarmupd.${key}: use one entry per root name, true or false`, 2);
  }
  for (const [root, on] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof on !== 'boolean') {
      throw new OpsError(`swarmupd.${key}.${root}: use true or false`, 2);
    }
  }
  return { ...(raw as Record<string, boolean>) };
}

function checkCode(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError('swarmupd.code: use one entry per root name, each a folder', 2);
  }
  for (const [root, dir] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new OpsError(`swarmupd.code.${root}: use the folder of the code checkout`, 2);
    }
  }
  return { ...(raw as Record<string, string>) };
}

function checkMerge(raw: unknown): Record<string, MergeConfig> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError('swarmupd.merge: use one entry per root name, each with a base branch', 2);
  }
  const out: Record<string, MergeConfig> = {};
  const commands = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((c) => typeof c !== 'string' || !c.trim())) {
      throw new OpsError(`swarmupd.merge.${name}: use a list of commands`, 2);
    }
    return v as string[];
  };
  const checks = (v: unknown, name: string): MergeCheck[] | undefined => {
    if (v === undefined) return undefined;
    const usage = `swarmupd.merge.${name}: use a list of commands, each a command or { run, paths } with a list of path patterns`;
    if (!Array.isArray(v)) throw new OpsError(usage, 2);
    return v.map((c: unknown): MergeCheck => {
      if (typeof c === 'string' && c.trim()) return c;
      if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new OpsError(usage, 2);
      const { run, paths, ...rest } = c as Record<string, unknown>;
      const extra = Object.keys(rest);
      if (extra.length > 0) {
        throw new OpsError(`swarmupd.merge.${name}: unknown key ${extra[0]}; use run and paths`, 2);
      }
      if (
        typeof run !== 'string' ||
        !run.trim() ||
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.some((p) => typeof p !== 'string' || !p.trim() || p.trim() === '!')
      ) {
        throw new OpsError(usage, 2);
      }
      return { run, paths: paths as string[] };
    });
  };
  for (const [root, m] of Object.entries(raw as Record<string, unknown>)) {
    if (m === null || typeof m !== 'object' || Array.isArray(m)) {
      throw new OpsError(`swarmupd.merge.${root}: set base, and checks and build if needed`, 2);
    }
    const e = m as Record<string, unknown>;
    if (typeof e.base !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(e.base)) {
      throw new OpsError(`swarmupd.merge.${root}.base: name the branch to merge into`, 2);
    }
    if (e.checkout !== undefined && (typeof e.checkout !== 'string' || !e.checkout.trim())) {
      throw new OpsError(`swarmupd.merge.${root}.checkout: use a folder path`, 2);
    }
    const t = e.timeout_minutes;
    if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1)) {
      throw new OpsError(
        `swarmupd.merge.${root}.timeout_minutes: use a whole number of at least 1`,
        2,
      );
    }
    const b = e.batch;
    if (b !== undefined && (typeof b !== 'number' || !Number.isInteger(b) || b < 1)) {
      throw new OpsError(`swarmupd.merge.${root}.batch: use a whole number of at least 1`, 2);
    }
    out[root] = {
      base: e.base,
      checkout: e.checkout as string | undefined,
      checks: checks(e.checks, `${root}.checks`),
      build: commands(e.build, `${root}.build`),
      install: commands(e.install, `${root}.install`),
      timeout_minutes: t as number | undefined,
      ...(b !== undefined ? { batch: b as number } : {}),
    };
  }
  return out;
}

function checkTestChanges(raw: unknown): Record<string, TestChangesConfig | false> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpsError(
      'swarmupd.test_changes: use one entry per root name, each false or with tests and checks',
      2,
    );
  }
  const out: Record<string, TestChangesConfig | false> = {};
  const patterns = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined || v === null) return undefined;
    if (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new OpsError(`swarmupd.test_changes.${name}: use a list of path patterns`, 2);
    }
    return v as string[];
  };
  for (const [root, t] of Object.entries(raw as Record<string, unknown>)) {
    if (t === false) {
      out[root] = false;
      continue;
    }
    if (t === true || t === null) {
      out[root] = {};
      continue;
    }
    if (typeof t !== 'object' || Array.isArray(t)) {
      throw new OpsError(
        `swarmupd.test_changes.${root}: use false, or tests and checks, each a list of path patterns`,
        2,
      );
    }
    const e = t as Record<string, unknown>;
    out[root] = {
      tests: patterns(e.tests, `${root}.tests`),
      checks: patterns(e.checks, `${root}.checks`),
    };
  }
  return out;
}

/** swarmupd's state folder before the rename: `~/.agent-ops/opsd`. */
export function oldStateDir(): string {
  return join(homedir(), '.agent-ops', 'opsd');
}

/** swarmupd's state folder: `~/.swarmup/swarmupd`. */
export function newStateDir(): string {
  return join(homedir(), '.swarmup', 'swarmupd');
}

/** New state folders seen to exist in this process: they never go back to the old one. */
const stateDirSeen = new Set<string>();

/**
 * Machine-local supervisor state: run records, logs, the API token. Never committed.
 * `SWARMUP_STATE_DIR`, else `~/.swarmup/swarmupd`, else the old `~/.agent-ops/opsd` while it is
 * not moved yet (`migrateStateDir` moves it when swarmupd starts).
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return envVar(env, 'STATE_DIR') ?? pickStateDir(newStateDir(), oldStateDir());
}

/** `to`, unless it is missing and `from` exists: then `from`, until the move. */
export function pickStateDir(to: string, from: string): string {
  if (stateDirSeen.has(to)) return to;
  if (existsSync(to)) {
    stateDirSeen.add(to);
    return to;
  }
  return existsSync(from) ? from : to;
}
