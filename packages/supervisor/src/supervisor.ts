import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { freemem, homedir, tmpdir } from 'node:os';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import type {
  AgentDef,
  OpsEvent,
  Priority,
  Root,
  Route,
  TaskView,
  UserConfig,
} from '@swarmup/core';
import type { SyncResult } from '@swarmup/core';
import {
  assertActor,
  canClaimType,
  editUserConfig,
  formatMinutes,
  OpsError,
  parseDuration,
  redactSecrets,
  parseTokens,
  isHuman,
  isWildcard,
  needsHumanReview,
  ownerMatches,
  readUserConfig,
  roleInactive,
  roleOf,
  runtimeOf,
  mirrorPartners,
  presenceSlug,
  projectRefs,
  findRootUp,
  rootNameOf,
  ROOTS_ONLY_ENV,
  QUESTION_TYPE,
  READ_ONLY_CAN_CLAIM,
  takesGroupWork,
  taskRefs,
  writePresence,
  syncAllAsync,
  syncDue,
  storeBranch,
  ulid,
  userConfigPath,
  Workspace,
  execOffThread,
  OPEN_STATUSES,
  MERGE_ACTOR,
} from '@swarmup/core';
import { Checkout, leftoverBranch } from './checkout.js';
import type { GitDirs } from './checkout.js';
import type { MergeConfig, OpsdConfig, ScheduleConfig } from './config.js';
import type {
  CommandResult,
  CommandStep,
  CommandWatch,
  MergeGitTimeout,
  MergeSource,
  OpsdSelf,
} from './merge.js';
import {
  CommandRunner,
  GitTimeout,
  insideDir,
  installSteps,
  isEngineRepo,
  lockfileDirs,
  MergeRepo,
  notLiveNotice,
  opsdCodeChanges,
  pickMergeSource,
  reviewSources,
} from './merge.js';
import type { NotifyItem } from './notify.js';
import { BranchPusher, gitError } from './push.js';
import { dropEnv, runEnv } from './runenv.js';
import { deleteEnvVars, envPairs, OLD_ENV_PREFIX, ROOTS_ONLY_NAME } from '@swarmup/core';
import { Notifier } from './notify.js';
import { opsdConfig, roleLimits, stateDir } from './config.js';
import type { ProviderUsage, UsageState } from './quota.js';
import {
  claudeUsage,
  clock,
  codexHome,
  codexUsage,
  findRollout,
  lastCodexLimits,
  mergeUsage,
  usagePause,
} from './quota.js';
import type { Launch, Spawned } from './proc.js';
import {
  isAlive,
  killTree,
  processStart,
  processStartSync,
  resolveCommand,
  RUNS_OUTLIVE_OPSD,
  spawnHidden,
} from './proc.js';
import type { KillResult, ProcEntry, ProcInfo, ProcLedger, ProcLister, ProcView } from './procs.js';
import { applyKills, startMs, survivors, systemLister, track, viewLedger } from './procs.js';
import type { Leftovers, RunRecord } from './runs.js';
import { RunStore } from './runs.js';
import type { RunFailure } from './stuck.js';
import { failureKey, failureNote, runFailure, unfinishedRuns } from './stuck.js';
import { Chat } from './chat.js';
import type { ChatInvocation, QuestionPrompt } from './runtimes.js';
import { CODEX_GIT_DIRS, invocation, runPrompt, withStoreCheckoutRule } from './runtimes.js';
import { UsageMeter } from './usage.js';
import type { TaskWorktree, WorktreeEntry } from './worktree.js';
import {
  CODE_TASK_TYPES,
  clearStaleIndexLock,
  deleteWorktree,
  isLink,
  MAKING_LOCK,
  makeTaskWorktree,
  makeTaskWorktreeSync,
  parseWorktreeList,
  taskBranch,
  taskIdOfWorktree,
  taskWorktreePath,
  worktreeAt,
  worktreeBranch,
} from './worktree.js';
import { repairRoot, type SandboxLister, staleTempFiles } from './store-repair.js';
import { gitAsync } from './git.js';
import type { SignInAnswer } from './signin.js';
import { runSignInCheck, SIGN_IN_CHECK_TIMEOUT_MS, SIGN_IN_CHECKS, signInSteps } from './signin.js';

/** Most referenced tasks a question's prompt lists; the agent reads more with `swarmup show`. */
const QUESTION_REFS = 20;

/** Most learn notes a task run's prompt lists; the agent finds more with `swarmup kb`. */
const TASK_NOTES = 3;

/**
 * What a question run's prompt carries (AO-0063): who asked, the question, and each task and
 * project the text references, so the agent starts with the context the asker pointed at.
 * References that resolve to no task are left out; the question text still has them.
 */
export function questionPrompt(ws: Workspace, ref: string, v: TaskView): QuestionPrompt {
  const shown = ws.showEvents(ref);
  const body = shown.body.trim();
  // Earlier rounds (AO-0134): each answer (`done`) and each reply the asker reopened it with.
  const rounds: QuestionPrompt['rounds'] = [];
  for (const e of shown.events) {
    const said = e.body.trim();
    if (!said) continue;
    if (e.type === 'done') rounds.push({ from: e.actor, kind: 'answer', text: said });
    else if (e.type === 'reopen') rounds.push({ from: e.actor, kind: 'reply', text: said });
  }
  const text = [
    v.meta.title,
    body,
    ...rounds.filter((r) => r.kind === 'reply').map((r) => r.text),
  ].join('\n');
  const tasks: QuestionPrompt['tasks'] = [];
  for (const r of taskRefs(text)) {
    if (tasks.length >= QUESTION_REFS) break;
    try {
      const t = ws.view(r);
      if (t.root === v.root && t.meta.id === v.meta.id) continue;
      tasks.push({ ref: r, status: t.status, title: t.meta.title });
    } catch {
      // Not a task this workspace can see: the question text keeps the reference.
    }
  }
  return {
    from: v.meta.created_by,
    title: v.meta.title,
    body,
    tasks,
    projects: projectRefs(text),
    ...(rounds.length > 0 ? { rounds } : {}),
  };
}

/** Why nothing starts while swarmupd is paused. */
export const PAUSED =
  'swarmupd is paused: resume it in Settings, from the tray icon or with `swarmup daemon resume`';

/** Why no run starts on a provider the config does not list, such as one removed in Settings. */
export function noProvider(provider: string): string {
  return `no provider '${provider}' in Settings > Providers: add it back, or hand the work to an agent of another provider`;
}

/** Why a stop that keeps runs is refused where runs end with swarmupd. */
export function liveRunsEndMessage(live: number): string {
  const runs = live === 1 ? '1 live run' : `${live} live runs`;
  return `${runs} would end with swarmupd on this system: stop with --kill-runs to end them, or pause new runs and stop after they finish`;
}

export interface SupervisorOptions {
  env?: NodeJS.ProcessEnv;
  /** Folder the roots are discovered from. */
  cwd?: string;
  user?: UserConfig;
  config?: OpsdConfig;
  stateDir?: string;
  now?: () => number;
  /** Lists the machine's processes for the run ledgers; defaults to the system lister. */
  procs?: ProcLister;
  /** Free memory in bytes; defaults to the OS figure. */
  freeMem?: () => number;
  /** The build swarmupd runs, for machine presence. */
  build?: string;
  version?: string;
  /** Whether runs outlive this swarmupd; defaults to the platform's `RUNS_OUTLIVE_OPSD`. */
  runsOutlive?: boolean;
  /**
   * Where swarmupd's own code is and how to read its build stamp now, for the notice after a merge
   * changes that code (AO-0156). Without it, the notice cannot tell what makes the change live.
   */
  self?: OpsdSelf;
  /**
   * How long one git command of a merge may take, or a function of its arguments that says it;
   * defaults to `MERGE_GIT_TIMEOUT_MS`.
   */
  mergeGitTimeoutMs?: MergeGitTimeout;
  /**
   * Lists what a Codex sandbox user owns in the task stores, for the store repair (AO-0287).
   * Without it swarmupd repairs nothing; `startDaemon` passes `listSandboxOwned`.
   */
  sandboxOwned?: SandboxLister;
}

/** Kill rounds for what an ended run left behind before swarmupd gives up and warns. */
const REAP_ROUNDS = 3;
/** How long an ended run waits for its killed helpers to end before its wrap-up goes on. */
const HELPER_END_MS = 30_000;
/** How far back the startup sweep looks for ended runs with processes left. */
const SWEEP_DAYS = 7;
/** Reads of an adopted run's creation time, after one at adoption failed, and the wait between. */
const ADOPT_RECHECKS = 5;
const ADOPT_RECHECK_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `sleep` that ends early, without leaving a timer behind, when `signal` aborts. */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((r) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      r();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** The actor swarmupd writes merge events, send-backs and notes as. */
export { MERGE_ACTOR };
/** Who tells the human that a checkout's changes hold writing runs (AO-0137), and where. */
export const DIRTY_ACTOR = 'opsd:checkout';
/** Who gives ownerless work a role group as its owner (AO-0140). */
export const ROUTE_ACTOR = 'opsd:router';
/** Who files the finding on a task whose runs keep ending without finishing. */
export const WATCH_ACTOR = 'opsd:watch';
const DIRTY_CHANNEL = 'general';
/** Who tells the human that a runtime's runs keep failing at once, such as on a sign-in (AO-0150). */
export const RUNTIME_ACTOR = 'opsd:runtime';
/** A run that ends with an error this soon after it started counts as a failed start. */
export const FAST_FAIL_MS = 10_000;
/** Minutes before the next run of a runtime after 1, 2 and 3 failed starts in a row. */
export const BACKOFF_MINUTES = [1, 5, 15] as const;
/**
 * After this many failed starts in a row, swarmupd tells the human once and starts a run of that
 * runtime only once an hour, until a run works again.
 */
export const BACKOFF_STOP = BACKOFF_MINUTES.length + 1;
export const BACKOFF_STOPPED_MINUTES = 60;

/** Failed starts in a row of one runtime, and when its next run may start. */
interface RuntimeBackoff {
  failures: number;
  until: number;
  /** The human was told this runtime stopped. */
  told: boolean;
}

/** Minutes between sign-in checks of a signed-out provider (AO-0154). */
export const SIGN_IN_CHECK_MINUTES = 3;
/** Without a sign-in check swarmupd can use, a signed-out provider gets one run this often. */
export const SIGNED_OUT_TRY_MINUTES = 60;
/**
 * A run that cannot sign in this soon after a sign-in check said "signed in" makes swarmupd stop
 * trusting that check: it may only look for stored credentials, not whether they still work.
 */
const CHECK_DOUBT_MS = 30 * 60_000;
/** After failing to make a task worktree, swarmupd tries again this much later (AO-0168). */
const WORKTREE_RETRY_MS = 10 * 60_000;
/** A checkout no run was planned or launched in for this long is no longer read each tick. */
const WANTED_CHECKOUT_MS = 10 * 60_000;
/** How often swarmupd reclaims closed tasks' worktrees and old scratch folders (AO-0230). */
export const HOUSEKEEPING_MS = 10 * 60_000;
/** The actor swarmupd notes a reclaimed worktree on its task as. */
export const WORKTREE_ACTOR = 'opsd:worktree';
/** The file in the state folder that keeps each reclaimed worktree's branch, by task ref. */
const RECLAIMED_FILE = 'reclaimed-worktrees.json';

/** What swarmupd kept of a task worktree it removed: where its work is. */
interface ReclaimedWorktree {
  path: string;
  branch: string;
  head: string;
  at: string;
  /** The checks passed and the folder is being deleted; the next sweep finishes it. */
  removing?: boolean;
}
/** The file in the state folder that keeps each provider's `SignInState`. */
export const SIGN_IN_FILE = 'signin.json';

/** A provider swarmupd saw signed out (AO-0154). */
export interface SignedOut {
  /** When swarmupd saw it, in ms. */
  since: number;
  /** The run that could not sign in; none when a sign-in check found it. */
  run?: string;
  /** That run's task, as `root/id`. */
  task?: string;
  /** The human was told. */
  told: boolean;
  /**
   * No sign-in check can tell: none is set, its answer cannot be read, or it said "signed in"
   * while runs still could not sign in. swarmupd then starts one run an hour instead.
   */
  no_check?: boolean;
  /** When the next sign-in check, or with `no_check` the next run, is due, in ms. */
  next: number;
}

/** What `signin.json` in the state folder keeps per provider. */
export interface SignInState {
  /** Set while the provider is signed out. */
  out?: SignedOut;
  /** How the last signed-out spell ended, and whether the human was told of it. */
  cleared?: { at: number; by: 'check' | 'run' | 'resume'; told: boolean };
  /** The provider's sign-in check said "signed in" while runs still could not sign in. */
  check_unreliable?: boolean;
}

/** A signed-out provider as `GET /api/usage`, `swarmup usage` and the app's banner show it. */
export interface SignedOutView {
  since: string;
  run?: string;
  task?: string;
  /** How to sign in again, such as "run `codex login`". */
  steps: string;
  /** swarmupd checks the sign-in with the CLI's status command; false: one run an hour tries it. */
  check: boolean;
  /** When the next check or try is due. */
  next: string;
}

/** One provider in `usageReport`. */
export type ProviderReport = ProviderUsage & {
  paused: string | null;
  live: number;
  signed_out?: SignedOutView;
};

export function signedOutView(provider: string, out: SignedOut): SignedOutView {
  return {
    since: new Date(out.since).toISOString(),
    ...(out.run ? { run: out.run } : {}),
    ...(out.task ? { task: out.task } : {}),
    steps: signInSteps(provider),
    check: !out.no_check,
    next: new Date(out.next).toISOString(),
  };
}

/** Why work of a signed-out provider waits, for `swarmup waits`, `swarmup usage` and the app. */
export function signedOutText(provider: string, out: SignedOut, now = Date.now()): string {
  const next = !out.no_check
    ? `swarmupd checks every ${SIGN_IN_CHECK_MINUTES} min and starts its runs once it is signed in`
    : out.next > now
      ? `swarmupd starts one ${provider} run to try the sign-in at ${clock(out.next)}`
      : `swarmupd starts one ${provider} run to try the sign-in once none is live`;
  return (
    `${provider} is signed out since ${clock(out.since)}: ${signInSteps(provider)}; ${next}, ` +
    'or resume it in the app or with `swarmup daemon resume`'
  );
}

/** Rebase, check and fast-forward rounds before a merge gives up on a base that keeps moving. */
const MERGE_ATTEMPTS = 5;
/** Pause between those rounds. */
const MERGE_RETRY_MS = 2_000;
/** How long the task store sync may push a merged commit as approved (AO-0193). */
const APPROVED_DAYS = 30;
/** How often a merge that holds its checkout looks whether the writing run there has ended. */
const MERGE_HOLD_POLL_MS = 1_000;

/** One approved task to merge, and where. */
interface MergeJob {
  cfg: MergeConfig;
  /** The checkout the base is built in. */
  top: string;
  src: MergeSource;
  /** The work as the review names it, such as `abc1234 on branch claude/x`. */
  what: string;
  /** Who gets the task back when the merge fails. */
  author: string;
  /** The root's human, who gets notes on merges swarmupd cannot do. */
  human?: string;
  root: string;
}

/**
 * A base swarmupd moved forward whose build has not run to its end, kept in `merge-builds.json` so the
 * next swarmupd runs it when this one stops during the build.
 */
interface PendingBuild {
  ref: string;
  root: string;
  /** The checkout the base is built in. */
  top: string;
  base: string;
  branch?: string;
  /** The commit the base moved to. */
  commit: string;
  what: string;
  author: string;
  human?: string;
  /** The merge event's text before the build's result; null once the merge event is written. */
  text: string | null;
  /** Files of swarmupd's own code the merge changed, in the engine repo; the human hears of them. */
  opsdCode?: string[];
  /**
   * The directories, relative to `top`, whose lockfile the merge changed (`lockfileDirs`): the
   * build installs dependencies in each first (AO-0185). `true`, saved by an earlier swarmupd, means
   * the checkout itself.
   */
  install?: string[] | true;
}

/** A merged task branch whose remote branch swarmupd deletes once the remote's base has the merge. */
interface PendingDelete {
  /** The repo's checkout, as branch pushing knows it. */
  top: string;
  branch: string;
  /** The commit the reviewer approved; the remote branch is deleted only up to it. */
  approved: string;
  base: string;
  /** The commit the base moved to with the merge. */
  commit: string;
  /** The task, for the log. */
  ref: string;
  /**
   * The remote's base tip when a round last found it without `commit`. Rounds skip the check
   * until that tip moves, so pending deletes cost no git call per round (AO-0164).
   */
  remote_tip?: string;
}

/** Commits swarmupd merged into one base of one repo, which the task store sync may push. */
interface ApprovedScope {
  /** The repo's top folder, as merging knows it. */
  top: string;
  base: string;
  /** Per {@link patchKey}, when swarmupd approved it (ISO time). */
  keys: Record<string, string>;
}

/** `approved.json` in the state folder (AO-0193). */
interface ApprovedState {
  scopes: ApprovedScope[];
}

/** What branch pushing keeps between rounds, per repo checkout. */
interface BranchState {
  /** Per repo and branch, the `<tip> <remote tip>` a round left alone. */
  seen: Record<string, Record<string, string>>;
  /** Per repo and branch, the approved commit swarmupd merged. */
  merged: Record<string, Record<string, string>>;
  deletes: PendingDelete[];
}

export interface LaunchRequest {
  agent: string;
  task?: string;
  /** The whole prompt; defaults to the standard prompt for the agent and task. */
  prompt?: string;
  /** Instructions, such as a schedule's prompt, that the standard prompt carries with its rules. */
  extra?: string;
  cwd?: string;
  /** Time budget such as `2h`; defaults to the delegation, the agent config, then swarmupd's. */
  budget?: string;
  /** Token budget such as `400k`; defaults to the delegation's. */
  tokens?: string;
  schedule?: string;
  /** Review `task` (it waits for this agent's verdict) instead of claiming it. */
  review?: boolean;
  /**
   * Start a helper of this live run (`swarmup spawn`): it works under the parent's claim, on the
   * parent's task and in its folder, and stops when the parent ends.
   */
  parent?: string;
  /** A turn of the desktop chat: the Claude session it starts or resumes. */
  chat?: ChatInvocation;
}

interface LiveRun {
  record: RunRecord;
  /** Missing for runs adopted from an earlier swarmupd: no exit event, only liveness. */
  child?: ChildProcess;
  meter: UsageMeter;
  offset: number;
  /** Keeps a UTF-8 character split across two reads whole. */
  decoder: StringDecoder;
  killReason?: string;
  /** Windows: the launcher, until swarmupd has recorded its PID and sent it the command. */
  launch?: Launch;
  /** Rate limit events already taken into the usage state. */
  rateLimitsRead?: number;
  /** Codex: the run's session file, once found. */
  rollout?: string;
  /** Usage-limit errors already taken into the usage state. */
  limitHitsRead?: number;
}

interface WakeState {
  keys: string[];
  at: number;
}

/** A checkout's state as opsd read it; `head` is undefined until something needs it. */
interface KnownCheckout {
  changes: string[] | Error;
  head?: string | null;
  /** The checkout's git dirs as git named them; undefined until something needs them. */
  gitDirs?: GitDirs | null;
}

/** A writing run that cannot start because its checkout has changes (AO-0137). */
interface DirtyHold {
  agent: string;
  /** The task the run would work on, if any. */
  task?: string;
  /** The first changed file, and how many there are. */
  file: string;
  count: number;
}

/** `dirty-checkouts.json`: the checkouts the human was told about, until each is clean again. */
type DirtyNotices = Record<string, { file: string; at: string }>;

/** A non-review inbox item of an agent: its key, and the task it is about. */
interface InboxKey {
  key: string;
  root: string;
  id: string;
}

type WakeKind = 'review' | 'inbox' | 'task';

/** What a limit check counts: a live run, or one the wake plan has started on paper. */
type PlannedRun = Pick<
  RunRecord,
  'agent' | 'project' | 'root' | 'task' | 'parent' | 'question' | 'inbox' | 'chat'
> & {
  cwd?: string;
};

interface PlanStep {
  c: WakeCandidate;
  /** The agent that starts it, or null when it waits. */
  agent: string | null;
  reason: string;
}

interface WakeCandidate {
  kind: WakeKind;
  /** Review and task candidates: the task. */
  ref?: string;
  root?: string;
  id?: string;
  project: string;
  title: string;
  priority: Priority;
  created: string;
  /** Inbox candidates: the inbox keys to record once a run of the agent started. */
  keys?: string[];
  /** Task candidates: the work resumes after an answer or a change request. */
  resume?: boolean;
  /** The task's owner: one agent, a wildcard, or null for anyone. */
  owner?: string | null;
  /** The reviewer the task expects (a delegation); its provider never takes the task. */
  avoid?: string;
  /** Task candidates: a question to the agent, which role limits do not hold (AO-0063). */
  question?: boolean;
  /** Task candidates: the task type, checked against each agent's `can_claim` (AO-0126). */
  type?: string;
  /** Review runs: the request's `task:event` key, so each request gets one run. */
  key?: string;
  /** Task candidates: the session outside swarmupd that worked on it last, while it may go on. */
  outside?: OutsideSession;
  /** Agents that may take it, best first. */
  agents: string[];
}

/** A session of an agent with no `SWARMUP_RUN` that wrote on a task under its own claim. */
export interface OutsideSession {
  agent: string;
  /** When it last wrote an event on the task, in ms. */
  at: number;
}

/** Events swarmupd writes as the agent, which say nothing about a session of the agent. */
const SUPERVISOR_EVENTS = new Set(['run-start', 'run-end', 'renew']);
/** Events with which anyone sends a task to an owner: what a session did before counts no more. */
const ROUTING_EVENTS = new Set(['handoff', 'delegate', 'assign']);
/** Events with which a session gives its task away or closes it: it works on it no more. */
const GIVES_UP_EVENTS = new Set([...ROUTING_EVENTS, 'release', 'done', 'park']);

/**
 * The session outside swarmupd that worked on a claimable task last, or null. The task's newest
 * claim is one this clone made with no run (`record`, from `.ops/claims`; swarmupd binds a claim
 * to the run it launches, and a run's own claim names it), that agent's newest event since does
 * not give the task away, and nobody routed the task after it. Such a session often works on
 * without a claim, say after a change request, and a run started beside it writes in the same
 * worktree (AO-0236).
 */
export function outsideSession(
  events: OpsEvent[],
  record: { token?: string; run?: string },
): OutsideSession | null {
  if (!record.token || record.run) return null;
  const claimAt = events.findLastIndex((e) => e.type === 'claim');
  const claim = events[claimAt];
  if (!claim || claim.token !== record.token) return null;
  const last = events
    .slice(claimAt)
    .findLast((e) =>
      e.actor === claim.actor ? !SUPERVISOR_EVENTS.has(e.type) : ROUTING_EVENTS.has(e.type),
    );
  if (!last || GIVES_UP_EVENTS.has(last.type)) return null;
  return { agent: claim.actor, at: Date.parse(last.at) };
}

/** A task waking agents could take, and why no run has started on it. */
export interface WaitItem {
  /** `review`, `inbox` (new items an agent was not started for) or `task` (a claim). */
  kind: 'review' | 'inbox' | 'task';
  /** The task, for reviews and claims. */
  task?: string;
  title: string;
  project: string;
  review: boolean;
  /** Agents that may take it, best first. */
  agents: string[];
  reason: string;
  /** Set when the merge under way holds the checkout this work would start in (AO-0161). */
  merge?: true;
}

/** What the merge under way does now (AO-0161). */
export type MergeStep = 'rebase' | 'checks' | 'waiting' | 'build';

/** The merge under way, as `GET /api/waits`, `swarmup runs` and the app show it (AO-0161). */
export interface MergeStatus {
  /** The task, as `root/id`. */
  task: string;
  /** What is merged, such as `3f2a9c1 on branch ao-0012-login-retry`. */
  what: string;
  base: string;
  /** The checkout the base is built in. */
  top: string;
  /**
   * `rebase` onto the base, `checks` in swarmupd's worktree, `waiting` for the writing run in the
   * checkout to end, or `build` of the base moved forward.
   */
  step: MergeStep;
  /** Whether the checkout takes no new writing run now. */
  holds: boolean;
  started_at: string;
  /** The check or build command running now. */
  command?: { text: string; index: number; count: number; started_at: string };
  /** How long each check or build command may run. */
  timeout_minutes: number;
}

/**
 * Events: `run` (a run started, changed or ended), `warn` (message), `merge` (a line on the
 * merge under way), `tick`, `sync`, `branches` (a round of pushing task branches: repo, remote,
 * pushed, held).
 */
export class Supervisor extends EventEmitter {
  private cfg: OpsdConfig;
  readonly store: RunStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly build?: string;
  private readonly version?: string;
  private readonly self?: OpsdSelf;
  private readonly mergeGitTimeoutMs?: MergeGitTimeout;
  /** Tasks whose merge check timed out once; the next timeout sends the task back (AO-0172). */
  private readonly mergeTimedOut = new Set<string>();
  private user: UserConfig;
  private readonly now: () => number;
  private readonly live = new Map<string, LiveRun>();
  /** Runs whose process ended and whose wrap-up (`wrapUp`) has not finished. */
  private readonly ending = new Map<string, RunRecord>();
  /** Who waits for a run to end and finish its wrap-up. */
  private readonly endWaiters = new Map<string, Array<() => void>>();
  private readonly gitTops = new Map<string, string>();
  /** What opsd last read of each checkout top: its changes and HEAD (AO-0215). */
  private readonly checkoutStates = new Map<string, KnownCheckout>();
  /**
   * During a tick's schedules, wake and dirty notices: each wanted checkout's state, read off
   * the event loop at the tick's start. Launches use it, so they run no git (AO-0215).
   */
  private tickStates: Map<string, KnownCheckout> | null = null;
  /** Checkout tops runs were planned or launched in, and when last; each tick reads these. */
  private readonly wantedTops = new Map<string, number>();
  /** While `waits` plans: a state read earlier counts, since that plan starts nothing. */
  private staleStatesOk = false;
  /**
   * The last `waits` answer, the state it was planned from and when (AO-0166): planning takes
   * ~220 ms on a large store, and the app asks for it at every refresh.
   */
  private waitsMemo: { sig: string; at: number; items: WaitItem[] } | null = null;
  /** Counts finished ticks: a tick starts runs and routes work, so each one plans `waits` anew. */
  private ticks = 0;
  /** During a tick's schedules and wake: writing runs held by a checkout's changes, per checkout. */
  private dirtyHolds: Map<string, DirtyHold> | null = null;
  /** Task worktrees swarmupd is making, by path (AO-0168); a run starts there once it is made. */
  private readonly makingWorktrees = new Map<string, Promise<void>>();
  /** When swarmupd last failed to make a task worktree, by path: runs use the checkout meanwhile. */
  private readonly worktreeFailed = new Map<string, number>();
  /** The housekeeping sweep under way: worktree reclaim and scratch cleanup (AO-0230). */
  private housekeeping?: Promise<void>;
  /** When the last housekeeping sweep started, in ms; 0 before the first. */
  private housekeptAt = 0;
  /** What swarmupd last warned about each worktree it leaves in place, so it warns once. */
  private readonly reclaimWarned = new Map<string, string>();
  /** Task worktrees swarmupd is checking or deleting, by path: no run starts there meanwhile. */
  private readonly reclaiming = new Set<string>();
  private timer?: NodeJS.Timeout;
  private procTimer?: NodeJS.Timeout;
  private ticking = false;
  private lister?: ProcLister;
  private readonly listerOpt?: ProcLister;
  private readonly sandboxOwned?: SandboxLister;
  /** The store repair under way, and whether a run asked for another one meanwhile. */
  private repairing?: Promise<void>;
  private repairAgain = false;
  /** Process work runs one step at a time, so two snapshots never write one ledger at once. */
  private procChain: Promise<void> = Promise.resolve();
  /**
   * Store syncs and branch pushes run one at a time, with git off the event loop (AO-0165), so
   * two rounds never write `branches.json` or a root's sync stamp at once.
   */
  private syncChain: Promise<void> = Promise.resolve();
  /** Roots by folder that API writes asked to sync, while their queued sync has not started. */
  private confirmRoots: Map<string, Root> | null = null;
  private killingAll = false;
  private stopping = false;
  /** Aborted by `stop`: cancels background reads that would otherwise keep swarmupd alive. */
  private readonly stopAbort = new AbortController();
  private closed = false;
  private readonly freeMem: () => number;
  private usage: UsageState;
  /**
   * Per runtime, its failed starts in a row (AO-0150). Kept in memory: a restart of swarmupd tries
   * the runtime again.
   */
  private readonly backoff = new Map<string, RuntimeBackoff>();
  /**
   * Per provider, whether it is signed out (AO-0154). Kept in `signin.json`, so a restart neither
   * tells the human again nor forgets it, and `swarmup usage` reads it without swarmupd.
   */
  private signIn: Record<string, SignInState>;
  /** Providers whose sign-in check runs now. */
  private readonly signInChecking = new Set<string>();
  /** The sign-in checks running now, which `close` waits for. */
  private readonly signInRuns = new Set<Promise<SignInAnswer>>();
  /** Providers whose first sign-in check after swarmupd started has not answered yet. */
  private readonly startChecks = new Set<string>();
  /** Whether live runs keep going after this swarmupd exits; see `RUNS_OUTLIVE_OPSD`. */
  readonly runsOutlive: boolean;
  /** The desktop chat with the orchestrator; each turn is a run under the usual limits. */
  readonly chat: Chat;
  /**
   * The merge under way, if any. While `holds` is set, its checkout takes no new writing run:
   * from the fast-forward of the base until the build is over. The rebase and the checks run in
   * swarmupd's own worktree and hold nothing (AO-0160).
   */
  private merging: {
    ref: string;
    top: string;
    base: string;
    what: string;
    runner: CommandRunner;
    done: Promise<void>;
    holds: boolean;
    step: MergeStep;
    startedAt: number;
    command: { text: string; index: number; count: number; startedAt: number } | null;
    timeoutMs: number;
  } | null = null;
  /** The process ledger of the merge command running now, if any. */
  private mergeProc: { ledger: ProcLedger; running: () => boolean } | null = null;
  /** A look at the processes earlier merge commands left behind, before the next merge starts. */
  private mergeClearing: Promise<void> | null = null;
  /** The look for the next task to merge, while git answers it. */
  private mergePlan: Promise<void> | null = null;
  /** Per task, the last event already looked at for a merge, so unchanged tasks are not read again. */
  private readonly mergeSeen = new Map<string, string>();
  /** Approved tasks swarmupd found nothing to merge for, by the last event they had then. */
  private readonly mergeNone = new Map<string, string>();

  constructor(opts: SupervisorOptions = {}) {
    super();
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? process.cwd();
    this.user = opts.user ?? readUserConfig(this.env);
    this.cfg = opts.config ?? opsdConfig(this.user);
    this.store = new RunStore(opts.stateDir ?? stateDir(this.env));
    this.now = opts.now ?? Date.now;
    this.listerOpt = opts.procs;
    this.sandboxOwned = opts.sandboxOwned;
    this.freeMem = opts.freeMem ?? freemem;
    this.build = opts.build;
    this.version = opts.version;
    this.self = opts.self;
    this.mergeGitTimeoutMs = opts.mergeGitTimeoutMs;
    this.runsOutlive = opts.runsOutlive ?? RUNS_OUTLIVE_OPSD;
    this.usage = this.store.readJson<UsageState>('usage.json', {});
    this.signIn = this.store.readJson<Record<string, SignInState>>(SIGN_IN_FILE, {});
    this.chat = new Chat(this, this.now);
  }

  /** The swarmupd section of the user config, with defaults; `reloadConfig` replaces it. */
  get config(): OpsdConfig {
    return this.cfg;
  }

  /**
   * Reads the user config again after the app changed it: roots, limits, agents and schedules
   * apply from the next tick. The port and tick interval apply at the next start.
   */
  reloadConfig(): void {
    const user = readUserConfig(this.env);
    const cfg = opsdConfig(user);
    // Resuming swarmupd or a runtime in Settings tries a stopped or signed-out runtime again at once
    // (AO-0150, AO-0154).
    for (const p of new Set([...this.backoff.keys(), ...Object.keys(this.signIn)])) {
      if (
        (this.cfg.paused && !cfg.paused) ||
        (this.cfg.runtimes[p]?.paused && !cfg.runtimes[p]?.paused)
      ) {
        this.backoff.delete(p);
        this.clearSignedOut(p, 'resume');
      }
    }
    this.user = user;
    this.cfg = { ...cfg, port: this.cfg.port, tick_seconds: this.cfg.tick_seconds };
  }

  /** Where swarmupd reads its user config. */
  get configPath(): string {
    return userConfigPath(this.env);
  }

  /** The env and folder swarmupd runs with, for `doctor` to check the same setup swarmupd uses. */
  get context(): { env: NodeJS.ProcessEnv; cwd: string } {
    return { env: this.env, cwd: this.cwd };
  }

  /**
   * Changes swarmupd's own user config file (never another one) and reloads it. `check` throws to
   * refuse the result before anything is written.
   */
  editConfig(
    change: Parameters<typeof editUserConfig>[1],
    check?: Parameters<typeof editUserConfig>[2],
  ): void {
    editUserConfig(this.env, change, check);
    this.reloadConfig();
  }

  /** The user config swarmupd runs with. */
  get userConfig(): UserConfig {
    return this.user;
  }

  /** When each schedule last started a run (ms), by name. */
  scheduleRuns(): Record<string, number> {
    return this.store.readJson<Record<string, number>>('schedules.json', {});
  }

  /** Starts a schedule's run now, under the usual limits; records it like a scheduled start. */
  runScheduleNow(name: string): RunRecord {
    const s = this.config.schedules.find((x) => x.name === name);
    if (!s) throw new OpsError(`no schedule '${name}'`, 2);
    const ws = this.ws(s.agent);
    const why = this.scheduleBlocker(ws, s);
    if (why) throw new OpsError(`${s.agent} cannot start now: ${why}`);
    const run = this.launch({
      agent: s.agent,
      task: s.task,
      extra: s.prompt || undefined,
      schedule: s.name,
    });
    const last = this.scheduleRuns();
    last[s.name] = this.now();
    this.store.writeJson('schedules.json', last);
    return run;
  }

  /**
   * A fresh workspace (fresh index read) acting as `actor`, or as the user config's `me`. The
   * supervisor's own `SWARMUP_AGENT` is ignored, so API calls never act as whoever started swarmupd.
   * `helper` marks a helper run's workspace, which may not change task state.
   */
  ws(actor?: string, run?: string, helper = false): Workspace {
    const env = { ...this.env };
    deleteEnvVars(env, ['AGENT', 'RUN', 'PARENT_RUN', 'RUN_TOKEN', 'RUN_STATE_DIR']);
    return new Workspace({
      cwd: this.cwd,
      env,
      user: this.user,
      actor,
      run,
      helper,
      now: this.now,
      queueConfirm: (roots) => this.confirmSync(roots),
    });
  }

  /**
   * Queues the sync a claim, handoff, verdict or ask needs under `coordinated` sync (AO-0169), so
   * the API write returns at once instead of running git on the event loop. Writes that come
   * while one waits join it. A claim that lost the race stops its run when the sync reports it.
   */
  private confirmSync(roots: Root[]): void {
    if (this.confirmRoots) {
      for (const r of roots) this.confirmRoots.set(r.dir, r);
      return;
    }
    const pending = new Map(roots.map((r) => [r.dir, r]));
    this.confirmRoots = pending;
    void this.syncWork(async () => {
      // From here on, a new write queues its own sync: this one may have read its files already.
      this.confirmRoots = null;
      const results = await syncAllAsync([...pending.values()], this.user, {
        pull: true,
        push: true,
        approved: this.approved(),
        now: this.now(),
      });
      for (const { root, result } of results) this.synced(root.name, result);
    });
  }

  /** The live run whose API token is `token`, or undefined. */
  runByToken(token: string): RunRecord | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    return this.liveRecords().find((r) => r.status === 'running' && r.token_sha256 === hash);
  }

  // ---- Limits ----------------------------------------------------------------------------------

  /**
   * Live run records, and runs still ending: until swarmupd has reaped a run, waited for its
   * helpers and committed what it left, it counts against every limit and holds its checkout.
   */
  private liveRecords(): RunRecord[] {
    return [...[...this.live.values()].map((l) => l.record), ...this.ending.values()];
  }

  /**
   * A run that may change files in its checkout: a top-level run of a role that writes. A chat
   * turn has Edit and Write denied, so it never holds a checkout, and swarmupd commits nothing after
   * it (AO-0136). Question runs are left to each caller: they never hold a checkout either.
   */
  private writingRun(r: Pick<PlannedRun, 'agent' | 'parent' | 'chat'>): boolean {
    return !r.parent && !r.chat && roleLimits(this.config, roleOf(r.agent)).writes;
  }

  /**
   * Why a run of `agent` on `project` cannot start now, or null when every limit has room: the
   * PC (runs and free memory), the provider (live runs and its usage allowance), the role (per
   * project and in all), and, for a run that writes, the checkout `cwd` it would work in. A
   * question run meets only the PC and provider limits, and role limits never count it. A chat
   * turn meets the role limits but not the checkout's: it writes no files.
   */
  blocker(
    agent: string,
    project: string,
    opts: {
      burst?: boolean;
      child?: boolean;
      question?: boolean;
      chat?: boolean;
      live?: PlannedRun[];
      cwd?: string;
      /** The task the run would work on: named when a checkout's changes hold it. */
      task?: string;
    } = {},
  ): string | null {
    // Helper runs belong to a live run, which a pause lets finish.
    if (this.config.paused && !opts.child) return PAUSED;
    const live: PlannedRun[] = opts.live ?? this.liveRecords();
    if (live.length >= this.config.max_runs) {
      return `${live.length} runs live; max_runs is ${this.config.max_runs}`;
    }
    const freeGb = this.freeMem() / 2 ** 30;
    if (freeGb < this.config.min_free_gb) {
      return `${freeGb.toFixed(1)} GB of memory free; min_free_gb is ${this.config.min_free_gb}`;
    }
    const provider = runtimeOf(agent);
    const rc = this.config.runtimes[provider];
    if (!rc) return noProvider(provider);
    if (rc.paused) return `${provider} is paused in Settings`;
    // Signed out: every run of the provider fails, chat turns and helpers too (AO-0154).
    const signedOut = this.signedOutPause(provider, live);
    if (signedOut) return signedOut;
    if (rc.max_live !== undefined) {
      const n = live.filter((r) => runtimeOf(r.agent) === provider).length;
      if (n >= rc.max_live) return `${n} ${provider} runs live; max_live is ${rc.max_live}`;
    }
    const paused = usagePause(
      provider,
      this.usage[provider],
      rc.pause_at ?? this.config.usage_pause_at,
      this.now(),
    );
    if (paused) return paused;
    // The human sends a chat turn: it tries the runtime whatever its failed starts.
    const backoff = opts.chat ? null : this.backoffPause(provider);
    if (backoff) return backoff;
    // A helper works under its parent's claim and scope: role limits count the parent only.
    if (opts.child) return null;
    // A Codex session starts on a store the last one's leftovers are repaired in (AO-0287).
    const repair = provider === 'codex' ? this.repairHold() : null;
    if (repair) return repair;
    // A question run answers and writes nothing: project and checkout limits are for work.
    if (opts.question) return null;
    const role = roleOf(agent);
    const lim = roleLimits(this.config, role);
    const mine = live.filter((r) => !r.parent && !r.question && roleOf(r.agent) === role);
    const here = mine.filter((r) => (r.project ?? r.root) === project).length;
    const cap = opts.burst ? lim.burst : lim.per_project;
    if (here >= cap) {
      return `${here} ${role} run(s) live on ${project}; ${opts.burst ? 'burst' : 'per_project'} is ${cap}`;
    }
    if (lim.max_live !== undefined && mine.length >= lim.max_live) {
      return `${mine.length} ${role} runs live; max_live is ${lim.max_live}`;
    }
    // Two runs that write in one checkout commit and test each other's half-done changes,
    // whatever project their tasks name; so one writing run per checkout, over every role.
    // A run may start in a subfolder, so runs compare the top of their git checkout.
    if (lim.writes && !opts.chat && opts.cwd) {
      const top = this.checkoutTop(opts.cwd);
      const other = live.find(
        (r) =>
          !r.question &&
          r.cwd !== undefined &&
          this.writingRun(r) &&
          samePath(this.checkoutTop(r.cwd), top),
      );
      if (other) {
        const what = other.task ? ` on ${other.root ? `${other.root}/` : ''}${other.task}` : '';
        return `${other.agent} works${what} in ${top}; one writing run per checkout`;
      }
      // A merge moves the checkout's branch and builds it; a writer there waits for that part.
      if (this.merging?.holds && samePath(this.merging.top, top)) return this.mergeHold(top);
      // A writing run starts on a clean checkout, so what it leaves is its own work alone.
      const gitTop = this.gitTopOf(resolve(opts.cwd));
      if (gitTop) {
        const changes = this.changesIn(gitTop);
        if (changes instanceof Error) {
          return `git cannot read the changes in ${gitTop}: ${changes.message}`;
        }
        if (changes.length > 0) {
          if (this.dirtyHolds && !this.dirtyHolds.has(gitTop)) {
            this.dirtyHolds.set(gitTop, {
              agent,
              task: opts.task,
              file: changes[0]!,
              count: changes.length,
            });
          }
          const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
          return `checkout has uncommitted changes in ${gitTop}: ${changes[0]}${more}`;
        }
      }
    }
    return null;
  }

  /** A checkout's changes outside task stores, or the error git gave. */
  private changesIn(top: string): string[] | Error {
    return this.knownCheckout(top).changes;
  }

  /** The commit checked out at `top`, or null in a repo without one. */
  private headOf(top: string): string | null {
    this.wantedTops.set(top, this.now());
    const known = this.tickStates?.get(top);
    if (known?.head !== undefined) return known.head;
    const head = this.checkout(top).head();
    if (known) known.head = head;
    return head;
  }

  /**
   * The git dirs of the checkout that holds `dir`, as git named them when the tick or the API
   * launch read the checkout, off the event loop; null outside a repo. Git runs now only for a
   * checkout neither has read: `git rev-parse` at each launch of a writing Codex run held
   * swarmupd's API for 0.2-1.5 s under load (AO-0215).
   */
  private gitDirsOf(dir: string): GitDirs | null {
    const top = this.gitTopOf(dir);
    if (!top) return null;
    this.wantedTops.set(top, this.now());
    const known = this.tickStates?.get(top);
    if (known?.gitDirs !== undefined) return known.gitDirs;
    const found = this.checkout(top).gitDirs();
    if (known) known.gitDirs = found;
    return found;
  }

  /**
   * What opsd knows of the checkout at `top`: the state the tick read at its start, or any
   * earlier one while `waits` plans. Otherwise git reads its changes now, on the event loop: a
   * launch from the API, or a checkout no tick has read yet. Each tick then reads it again.
   */
  private knownCheckout(top: string): KnownCheckout {
    this.wantedTops.set(top, this.now());
    const known =
      this.tickStates?.get(top) ?? (this.staleStatesOk ? this.checkoutStates.get(top) : undefined);
    if (known) return known;
    let changes: string[] | Error;
    try {
      changes = this.checkout(top).changes();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      changes = new Error(msg);
    }
    const found: KnownCheckout = { changes };
    this.checkoutStates.set(top, found);
    this.tickStates?.set(top, found);
    return found;
  }

  /**
   * Reads the changes and HEAD of each checkout runs were planned or launched in during the last
   * {@link WANTED_CHECKOUT_MS}, with git off the event loop. A writing run's launch ran
   * `git status` and `git rev-parse` synchronously, which held swarmupd's API for 0.3-1.8 s each
   * under load (AO-0215).
   */
  private async readCheckouts(): Promise<Map<string, KnownCheckout>> {
    const cutoff = this.now() - WANTED_CHECKOUT_MS;
    for (const [top, at] of this.wantedTops) {
      if (at >= cutoff) continue;
      this.wantedTops.delete(top);
      this.checkoutStates.delete(top);
    }
    const read = new Map<string, KnownCheckout>();
    await Promise.all(
      [...this.wantedTops.keys()].map(async (top) => {
        try {
          const state = await this.checkout(top).stateAsync();
          read.set(top, state);
          this.checkoutStates.set(top, state);
        } catch {
          // A launch there reads it itself.
        }
      }),
    );
    return read;
  }

  /**
   * Learns the git top and state of a checkout swarmupd just made, off the event loop, so the tick
   * that starts its first run reads it with the others and runs no git for it.
   */
  private async learnCheckout(dir: string): Promise<void> {
    try {
      const top = await this.gitTopAsync(dir);
      if (!top) return;
      this.gitTops.set(resolve(dir), top);
      this.wantedTops.set(top, this.now());
      this.checkoutStates.set(top, await this.checkout(top).stateAsync());
    } catch {
      // The tick finds it the usual way.
    }
  }

  /**
   * Learn notes that match a task's title and description (AO-0049), for its run's prompt. A note
   * that cannot be read never stops the run: the prompt then lists none.
   */
  private taskNotes(ws: Workspace, ref: string): { ref: string; title: string }[] {
    try {
      return ws.taskNotes(ref, TASK_NOTES).map(({ ref: noteRef, title }) => ({
        ref: noteRef,
        title,
      }));
    } catch {
      return [];
    }
  }

  /** Git work on the checkout at `top`, with every task store swarmupd knows left out. */
  private checkout(top: string): Checkout {
    return new Checkout(
      top,
      this.ws().roots.map((r) => r.dir),
      this.env,
    );
  }

  /**
   * The checkout a top-level run of `agent` works in: the launch's folder, else the agent's
   * `cwd`, else the code checkout of the task's root (or the first root; see {@link codeTopOf}).
   */
  checkoutOf(ws: Workspace, agent: string, rootName?: string, cwd?: string): string {
    const root = (rootName ? ws.roots.find((r) => r.name === rootName) : undefined) ?? ws.roots[0];
    return resolve(
      cwd ??
        this.config.agents[agent]?.cwd ??
        (root ? this.codeTopOf(root) : this.gitTopOf(this.cwd)) ??
        this.cwd,
    );
  }

  /**
   * The checkout a folder belongs to: the top of its git work tree (each linked worktree is its
   * own), else the folder itself.
   */
  private checkoutTop(dir: string): string {
    const abs = resolve(dir);
    return this.gitTopOf(abs) ?? abs;
  }

  /**
   * The shared checkout of a data root that `cwd` is in: the root's own checkout, with its store
   * branch (null when none is known yet), or the root's code checkout of `swarmupd.code` (AO-0252),
   * with its merge base (`code` set). Null when `cwd` is in neither. Each linked worktree is a
   * checkout of its own, so a run in a worktree is in none.
   */
  private storeCheckoutOf(
    ws: Workspace,
    cwd: string,
  ): { top: string; branch: string | null; code?: true } | null {
    const top = this.gitTopOf(resolve(cwd));
    if (!top) return null;
    for (const root of ws.roots) {
      const rootTop = this.gitTopOf(resolve(root.dir));
      if (rootTop && samePath(rootTop, top)) return { top, branch: storeBranch(root) };
    }
    for (const root of ws.roots) {
      if (!this.config.code[root.name]) continue;
      const codeTop = this.codeTopOf(root);
      if (codeTop && samePath(codeTop, top)) {
        return { top, branch: this.config.merge[root.name]?.base ?? null, code: true };
      }
    }
    return null;
  }

  /**
   * The worktree a task run of `agent` works in instead of the store checkout (AO-0168), or null
   * when the run starts where it did before. With `task_worktrees` on, a run gets one when it
   * works on a code task ({@link CODE_TASK_TYPES}) for a role that writes, has no folder of its
   * own in Settings, and would otherwise start in a data root's checkout. Every such run would
   * share that checkout, and the one-writer-per-checkout rule of `blocker` would let only one
   * engineer work at a time; each in its own `out/wt-<ID>`, they work side by side. A worktree
   * that is there is reused, so a task's later runs go on with its branch. Null too after a
   * failed `git worktree add` (for {@link WORKTREE_RETRY_MS}) and when something that is not a
   * worktree is in the way.
   */
  private codeWorktree(
    ws: Workspace,
    agent: string,
    rootName: string | undefined,
    id: string | undefined,
    type: string | undefined,
  ): TaskWorktree | null {
    if (!this.config.task_worktrees) return null;
    if (!rootName || !id || !type || !CODE_TASK_TYPES.has(type)) return null;
    if (!roleLimits(this.config, roleOf(agent)).writes) return null;
    if (this.config.agents[agent]?.cwd) return null;
    const root = ws.roots.find((r) => r.name === rootName);
    if (!root || root.isMirror) return null;
    const store = this.storeCheckoutOf(ws, this.checkoutOf(ws, agent, rootName));
    if (!store) return null;
    const path = taskWorktreePath(store.top, id);
    const failed = this.worktreeFailed.get(path);
    if (failed !== undefined && this.now() - failed < WORKTREE_RETRY_MS) return null;
    const at = worktreeAt(path);
    if (at === 'other') return null;
    return {
      top: store.top,
      path,
      // A worktree swarmupd reclaimed comes back on the branch its work is on (AO-0230).
      branch:
        (at === 'none' ? this.reclaimedBranch(`${rootName}/${id}`) : null) ??
        taskBranch(runtimeOf(agent), id),
      base: this.config.merge[rootName]?.base,
      // Git writes the worktree's `.git` before it checks out the files. A worktree swarmupd is
      // removing is made again once it is gone (AO-0230).
      ready: at === 'worktree' && !this.makingWorktrees.has(path) && !this.reclaimHolds(path),
    };
  }

  /**
   * Starts making `wt` off the event loop, unless that is under way; the run starts at a later
   * tick, once it is there. A failure is logged, and runs use the checkout until the retry.
   */
  private makeWorktree(wt: TaskWorktree, ref: string): void {
    if (this.stopping || this.makingWorktrees.has(wt.path) || this.reclaimHolds(wt.path)) return;
    this.emit('worktree', `${ref}: making ${wt.path}`);
    const made = makeTaskWorktree(wt, this.env)
      .then(async () => {
        this.worktreeFailed.delete(wt.path);
        await this.learnCheckout(wt.path);
        this.emit('worktree', `${ref}: ${wt.path} ready`);
      })
      .catch((err: unknown) => {
        this.worktreeFailed.set(wt.path, this.now());
        this.emit('warn', `${ref}: cannot make worktree ${wt.path}: ${gitError(err)}`);
      })
      .finally(() => this.makingWorktrees.delete(wt.path));
    this.makingWorktrees.set(wt.path, made);
  }

  /**
   * The branch of the task's worktree swarmupd reclaimed, or null. No git call here: wake plans
   * read it, and `makeTaskWorktree` makes the branch anew from the base if it is gone.
   */
  private reclaimedBranch(ref: string): string | null {
    const rec = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {})[ref];
    return rec && !rec.removing ? rec.branch : null;
  }

  /** Starts a housekeeping sweep when one is due, off the event loop (AO-0230). */
  private housekeepingTick(): void {
    if (this.stopping || this.housekeeping) return;
    if (this.housekeptAt && this.now() - this.housekeptAt < HOUSEKEEPING_MS) return;
    // Git work of a merge or a new worktree comes first: on Windows each extra git process slows
    // theirs, and a merge step has a timeout. The sweep waits for a tick with neither.
    if (this.merging || this.mergePlan || this.makingWorktrees.size > 0) return;
    void this.housekeep();
  }

  /**
   * Reclaims the worktrees of closed tasks and removes old run scratch folders now, or joins the
   * sweep under way. Each step only logs what fails, and the next sweep tries again.
   */
  housekeep(): Promise<void> {
    if (this.housekeeping) return this.housekeeping;
    this.housekeptAt = this.now();
    const sweep = (async () => {
      if (this.config.reclaim_worktrees) await this.reclaimWorktrees();
      this.safe(() => this.pruneScratch());
      await this.repairStores();
    })()
      .catch((err: unknown) => {
        this.emit('warn', `housekeeping failed: ${String(err)}`);
      })
      .finally(() => {
        this.housekeeping = undefined;
      });
    this.housekeeping = sweep;
    return sweep;
  }

  /**
   * For each store checkout: removes a task worktree that a crash left half made (it still has
   * {@link MAKING_LOCK}), and the worktree of each task closed for `reclaim_after_minutes` that
   * no run works in, no merge waits on, has no uncommitted change, and whose commit is on a
   * branch. The branch stays, and the task gets a note naming it. A worktree that fails a check
   * stays, with one warning per reason.
   */
  private async reclaimWorktrees(): Promise<void> {
    const ws = this.ws(WORKTREE_ACTOR);
    const tops = new Map<string, Root[]>();
    for (const root of ws.roots) {
      if (root.isMirror) continue;
      const top = this.codeTopOf(root);
      if (!top) continue;
      const key = [...tops.keys()].find((t) => samePath(t, top)) ?? top;
      tops.set(key, [...(tops.get(key) ?? []), root]);
    }
    for (const [top, roots] of tops) {
      if (this.stopping) return;
      // A removal a crash or a locked file cut off goes on first, checks done (see `reclaimOne`).
      const records = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {});
      for (const [ref, rec] of Object.entries(records)) {
        if (this.stopping) return;
        if (rec.removing && taskIdOfWorktree(top, rec.path)) await this.finishReclaim(ws, top, ref);
      }
      let list: WorktreeEntry[];
      try {
        list = parseWorktreeList(await gitAsync(top, ['worktree', 'list', '--porcelain', '-z']));
      } catch (err) {
        this.emit('warn', `cannot list the worktrees of ${top}: ${gitError(err)}`);
        continue;
      }
      for (const wt of list) {
        if (this.stopping) return;
        const id = taskIdOfWorktree(top, wt.path);
        if (id) await this.reclaimOne(ws, top, roots, wt, id);
      }
    }
  }

  /**
   * True while swarmupd removes the worktree at `path`, or a removal a crash cut off waits to be
   * finished: no run may start there and no worktree may be made there meanwhile (AO-0230).
   */
  private reclaimHolds(path: string): boolean {
    return this.reclaimHoldOf(path) !== null;
  }

  /**
   * The held worktree (see {@link reclaimHolds}) that `dir` is or is inside, or null. Every
   * launch checks its final folder against it, whatever chose that folder (AO-0230).
   */
  private reclaimHoldOf(dir: string): string | null {
    const all = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {});
    const held = [
      ...this.reclaiming,
      ...Object.values(all)
        .filter((r) => r.removing)
        .map((r) => r.path),
    ];
    return held.find((p) => insideDir(p, dir)) ?? null;
  }

  /** True when a live or ending run works inside `path`. */
  private runsIn(path: string): boolean {
    return [...this.liveRecords(), ...this.ending.values()].some(
      (r) => r.cwd !== undefined && insideDir(path, resolve(r.cwd)),
    );
  }

  /**
   * Reclaims one task worktree if every check passes. From the first check to the end of the
   * deletion the path is reserved ({@link reclaimHolds}), so no run starts there while git
   * answers, and the task's status and runs are checked again after the last git call. The
   * removal is saved as under way before the folder is touched, so a crash or a file Windows
   * holds open only delays it: the next sweep finishes it (see {@link finishReclaim}).
   */
  private async reclaimOne(
    ws: Workspace,
    top: string,
    roots: Root[],
    wt: WorktreeEntry,
    id: string,
  ): Promise<void> {
    const path = resolve(wt.path);
    if (this.makingWorktrees.has(path) || this.reclaimHolds(path) || this.runsIn(path)) return;
    if (isLink(path)) {
      this.warnOnce(
        path,
        `the worktree ${path} is a junction or symlink; swarmupd leaves it alone`,
      );
      return;
    }
    if (!existsSync(path)) {
      // Someone deleted the folder; git keeps its record until a prune.
      await gitAsync(top, ['worktree', 'prune']).catch(() => '');
      return;
    }
    if (wt.locked === MAKING_LOCK) {
      // Half made: git stopped mid-checkout, and no run ever started in it. The next run makes it
      // again on the same branch.
      this.reclaiming.add(path);
      try {
        if (await this.deleteTaskWorktree(top, path)) {
          this.emit('worktree', `${id}: removed ${path}, which a crash left half made`);
        }
      } finally {
        this.reclaiming.delete(path);
      }
      return;
    }
    if (wt.locked !== null) return; // Someone locked it on purpose.
    const ref = roots
      .map((r) => `${r.name}/${id}`)
      .find((r) => {
        try {
          ws.view(r);
          return true;
        } catch {
          return false;
        }
      });
    if (!ref || !this.closedLongEnough(ws, ref)) return;
    // Reserved in the same step as the checks above: no launch can slip in between.
    this.reclaiming.add(path);
    this.emit('worktree', `${ref}: checking ${path} for removal`);
    try {
      let changes: string[];
      try {
        changes = (await gitAsync(path, ['status', '--porcelain'])).split(/\r?\n/).filter(Boolean);
      } catch (err) {
        this.warnOnce(path, `cannot read the worktree ${path}: ${gitError(err)}; left in place`);
        return;
      }
      if (changes.length > 0) {
        const more = changes.length > 1 ? ` and ${changes.length - 1} more` : '';
        this.warnOnce(
          path,
          `${ref} is closed, but its worktree ${path} has uncommitted changes ` +
            `(${changes[0]!.slice(3)}${more}); left in place. Commit or discard them, and swarmupd ` +
            'removes it.',
        );
        return;
      }
      const held = wt.head
        ? (
            await gitAsync(top, [
              'for-each-ref',
              '--count=1',
              '--contains',
              wt.head,
              '--format=%(refname)',
              'refs/heads',
            ]).catch(() => '')
          ).trim()
        : '';
      if (!held || !wt.branch) {
        this.warnOnce(
          path,
          `${ref} is closed, but its worktree ${path} is on ${wt.branch ? 'a commit' : 'a detached HEAD'} ` +
            `${wt.head.slice(0, 8)} that no branch holds; left in place.`,
        );
        return;
      }
      // Again after the git calls: the task may have been reopened meanwhile, or a run that was
      // ending may still hold the folder.
      if (!this.closedLongEnough(ws, ref) || this.runsIn(path)) return;
      const all = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {});
      all[ref] = {
        path,
        branch: wt.branch,
        head: wt.head,
        at: new Date(this.now()).toISOString(),
        removing: true,
      };
      this.store.writeJson(RECLAIMED_FILE, all);
      await this.finishReclaim(ws, top, ref, true);
    } finally {
      this.reclaiming.delete(path);
    }
  }

  /** The task is done or parked, has been for `reclaim_after_minutes`, and no merge waits. */
  private closedLongEnough(ws: Workspace, ref: string): boolean {
    let v: TaskView;
    try {
      v = ws.view(ref);
    } catch {
      return false;
    }
    if (v.status !== 'done' && v.status !== 'parked') return false;
    if (this.now() - Date.parse(v.updatedAt) < this.config.reclaim_after_minutes * 60_000) {
      return false;
    }
    return !this.mergeWaits(ws, ref);
  }

  /**
   * Deletes the worktree a saved reclaim names, then notes on its task where the work is.
   * `checked`: `reclaimOne` checked it just now and holds the path. Otherwise this resumes a
   * removal a crash or a locked file cut off. While its record says `removing`, no run can start
   * in the folder ({@link reclaimHolds}), so it still holds what passed the checks minus what the
   * deletion took. It is checked anyway: no run inside, the same branch and commit, and nothing
   * in `git status` but deleted files. Otherwise swarmupd drops the removal and leaves the folder.
   * A task reopened meanwhile does not stop it: a half-deleted worktree is of no use to a run,
   * which gets a new one from the branch once this one is gone.
   */
  private async finishReclaim(
    ws: Workspace,
    top: string,
    ref: string,
    checked = false,
  ): Promise<void> {
    const rec = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {})[ref];
    if (!rec?.removing) return;
    if (!checked) {
      if ([...this.reclaiming].some((p) => samePath(p, rec.path)) || this.runsIn(rec.path)) {
        return;
      }
      this.reclaiming.add(rec.path);
      this.emit('worktree', `${ref}: finishing the removal of ${rec.path}`);
    }
    try {
      if (!checked) {
        const changed = await this.changedSinceChecks(rec);
        if (changed) {
          const all = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {});
          delete all[ref];
          this.store.writeJson(RECLAIMED_FILE, all);
          this.emit(
            'warn',
            `${ref}: swarmupd stopped removing the worktree ${rec.path}: ${changed}; left in place`,
          );
          return;
        }
      }
      if (!(await this.deleteTaskWorktree(top, rec.path))) return;
    } finally {
      if (!checked) this.reclaiming.delete(rec.path);
    }
    const all = this.store.readJson<Record<string, ReclaimedWorktree>>(RECLAIMED_FILE, {});
    all[ref] = { ...rec, removing: undefined };
    this.store.writeJson(RECLAIMED_FILE, all);
    this.emit('worktree', `${ref}: removed ${rec.path}; its work stays on branch ${rec.branch}`);
    this.safe(() =>
      ws.comment(
        ref,
        `${ref}: swarmupd removed the task's worktree \`${rec.path.replace(/\\/g, '/')}\`, ` +
          `closed and clean. Its work stays on branch \`${rec.branch}\` at ${rec.head.slice(0, 8)}; ` +
          'a reopened task gets the worktree again from that branch.',
      ),
    );
  }

  /**
   * Why the folder of a removal under way is no longer what passed the checks, or null when it
   * still is: gone or empty (the deletion got that far), or a worktree on the same branch and
   * commit with nothing in `git status` but deleted files. `deleteWorktree` deletes `.git` last,
   * so a folder it cut off is still a worktree git reads. A folder that is no worktree, or that
   * git cannot read, was replaced or damaged by something else: it stays.
   */
  private async changedSinceChecks(rec: ReclaimedWorktree): Promise<string | null> {
    // Checked without following it: through a link, git would read and swarmupd would delete
    // another folder.
    if (isLink(rec.path)) return 'its path is a junction or symlink now';
    let names: string[];
    try {
      names = readdirSync(rec.path);
    } catch {
      return existsSync(rec.path) ? 'swarmupd cannot read the folder' : null;
    }
    if (names.length === 0) return null;
    if (worktreeAt(rec.path) !== 'worktree') return 'it is no git worktree any more';
    let head: string;
    let branch: string;
    let status: string[];
    try {
      head = (await gitAsync(rec.path, ['rev-parse', 'HEAD'])).trim();
      branch = (
        await gitAsync(rec.path, ['symbolic-ref', '-q', '--short', 'HEAD']).catch(() => '')
      ).trim();
      status = (await gitAsync(rec.path, ['status', '--porcelain'])).split(/\r?\n/).filter(Boolean);
    } catch (err) {
      return `git cannot read it (${gitError(err)})`;
    }
    if (head !== rec.head || branch !== rec.branch) {
      return `it is on ${branch || 'a detached HEAD'} at ${head.slice(0, 8)} now`;
    }
    const other = status.find((l) => !/^( D|D |DD) /.test(l));
    return other ? `it has a change that is no deletion (${other.slice(3)})` : null;
  }

  /**
   * {@link deleteWorktree}, then forgets what swarmupd knew of the folder; false on failure. A
   * stop kills the deletion, so it never holds the stop (AO-0244); the next swarmupd finishes it.
   */
  private async deleteTaskWorktree(top: string, path: string): Promise<boolean> {
    try {
      await deleteWorktree(top, path, { signal: this.stopAbort.signal });
    } catch (err) {
      if (this.stopping) return false;
      this.warnOnce(path, `cannot remove the worktree ${path}: ${String(err)}; tries again later`);
      return false;
    }
    this.reclaimWarned.delete(path);
    // Folders inside it are no git checkout any more; a later worktree there is a new one.
    for (const dir of [...this.gitTops.keys()]) {
      if (insideDir(path, dir)) this.gitTops.delete(dir);
    }
    this.waitsMemo = null;
    return true;
  }

  /**
   * The names in each folder next to a writing run's checkout, so its wrap-up can name what
   * appeared there (AO-0230): the folder that holds the store checkout (unless that is a home,
   * temp or drive-root folder), and for a run in a task worktree, the store checkout and its `out/`.
   */
  private aroundSnapshot(top: string, storeTop?: string): Record<string, string[]> {
    const dirs: string[] = [];
    const parent = dirname(storeTop ?? top);
    // A home, temp or drive-root folder changes all the time for other reasons.
    const busy = [homedir(), tmpdir()].some((d) => samePath(parent, d));
    if (parent !== dirname(parent) && !busy) dirs.push(parent);
    if (storeTop) dirs.push(storeTop, join(storeTop, 'out'));
    const out: Record<string, string[]> = {};
    for (const d of dirs) {
      try {
        out[d] = readdirSync(d);
      } catch {
        // A folder that cannot be read is not watched.
      }
    }
    return out;
  }

  /** Paths that appeared in the folders of `r.around` since the run started; worktrees aside. */
  private strays(r: RunRecord): string[] {
    const found: string[] = [];
    for (const [dir, before] of Object.entries(r.around ?? {})) {
      const had = new Set(before);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (had.has(name)) continue;
        // Task worktrees in `out/` are swarmupd's own.
        if (basename(dir) === 'out' && name.startsWith('wt-')) continue;
        found.push(join(dir, name));
      }
    }
    return found;
  }

  /**
   * True when the task's newest verdict approves it and swarmupd has not merged it yet. Like
   * `awaitsMerge` in core's fold, only a merge event or a `no_merge` note of swarmupd settles
   * it: after a note that the merge failed, the work is still not in the base, so the task's
   * worktree stays and the tasks blocked on it keep waiting (AO-0228).
   */
  private mergeWaits(ws: Workspace, ref: string): boolean {
    const after = this.afterApproval(ws, ref)?.wrote;
    return !!after && !after.some((e) => e.type === 'merge' || e.no_merge);
  }

  /**
   * The time of the newest verdict of a task whose root swarmupd merges, and what swarmupd wrote
   * after it, a note of a failed merge included; null when that verdict does not approve the
   * task.
   */
  private afterApproval(ws: Workspace, ref: string) {
    const root = ref.slice(0, ref.lastIndexOf('/'));
    if (!this.config.merge[root]) return null;
    const { events } = ws.showEvents(ref);
    let at = events.length - 1;
    while (at >= 0 && events[at]!.type !== 'verdict') at--;
    const verdict = events[at];
    if (!verdict || verdict.verdict !== 'approve' || verdict.actor === MERGE_ACTOR) return null;
    return { at: verdict.at, wrote: events.slice(at + 1).filter((e) => e.actor === MERGE_ACTOR) };
  }

  /** Warns about a worktree swarmupd leaves in place, once per path and message. */
  private warnOnce(path: string, message: string): void {
    if (this.reclaimWarned.get(path) === message) return;
    this.reclaimWarned.set(path, message);
    this.emit('warn', message);
  }

  /** Removes the scratch folders of runs that ended more than `scratch_days` ago (AO-0230). */
  private pruneScratch(): void {
    const dir = join(this.store.dir, 'scratch');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    const cutoff = this.now() - this.config.scratch_days * 24 * 3_600_000;
    for (const name of names) {
      const r = this.store.get(name);
      if (r?.status === 'running' || this.live.has(name) || this.ending.has(name)) continue;
      const path = join(dir, name);
      // A run swarmupd no longer has a record of counts from the folder's last change.
      let endedAt: number;
      try {
        endedAt = r?.ended_at ? Date.parse(r.ended_at) : statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (endedAt > cutoff) continue;
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        this.emit('warn', `cannot remove the scratch folder ${path}: ${String(err)}`);
      }
    }
  }

  /**
   * Repairs each task store after Codex sandbox sessions (AO-0287, see `store-repair.ts`): makes
   * the files and folders the sandbox user owns again under the signed-in user, and removes the
   * stale locks a crashed session left, so the next session can write them. Runs in each
   * housekeeping sweep and after each Codex run ends; a call during a repair gets one more
   * repair after it, since the listing under way may have passed what the caller's run left.
   *
   * Stale temp files in `.ops/tmp` are named in the log, and deleted only when
   * `swarmupd.remove_stale_temp` is on. Each failure is logged once; the next repair tries again.
   */
  repairStores(): Promise<void> {
    if (!this.sandboxOwned || !this.config.repair_stores || this.stopping) {
      return Promise.resolve();
    }
    if (this.repairing) {
      this.repairAgain = true;
      return this.repairing;
    }
    const list = this.sandboxOwned;
    const repair = (async () => {
      do {
        this.repairAgain = false;
        await this.repairStoresOnce(list);
      } while (this.repairAgain && !this.stopping);
    })()
      .catch((err: unknown) => {
        this.warnOnce('store-repair', `cannot repair the task stores: ${String(err)}`);
      })
      .finally(() => {
        this.repairing = undefined;
      });
    this.repairing = repair;
    return repair;
  }

  /**
   * Why a Codex run cannot start now, or null: a Codex run is in its wrap-up, which ends by
   * starting the repair of what its sandbox session left, or a repair is under way. Without the
   * hold, the next session starts on files and folders it cannot replace, and on folders the
   * repair moves. Two Codex runs that overlap are not repaired between. Helpers are not held:
   * their parent's session already runs.
   */
  private repairHold(): string | null {
    if (!this.sandboxOwned || !this.config.repair_stores) return null;
    const ending = [...this.ending.values()].find((r) => runtimeOf(r.agent) === 'codex');
    if (ending) {
      return (
        `swarmupd repairs the task stores once the Codex run ${ending.id} has ended; ` +
        'Codex runs start after that'
      );
    }
    return this.repairing
      ? 'swarmupd repairs what Codex sessions left in the task stores; Codex runs start after that'
      : null;
  }

  private async repairStoresOnce(list: SandboxLister): Promise<void> {
    const roots = this.ws().roots;
    const owned = await list(
      roots.map((r) => r.dir),
      this.env,
    );
    for (const root of roots) {
      if (this.stopping) return;
      // A root inside another, such as a mirror in the Master Repo, takes its own entries.
      const mine = owned.filter((o) => {
        const at = roots
          .filter((r) => inside(o.path, r.dir))
          .sort((a, b) => b.dir.length - a.dir.length)[0];
        return at === root;
      });
      if (mine.length > 0) {
        // Under the git lock: a sync that ran meanwhile could commit a folder half moved.
        const res = await root.lockAsync('git', () => repairRoot(root, mine));
        if (res.files + res.dirs + res.locks > 0) {
          this.emit(
            'repair',
            `${root.name}: made ${res.files} file(s) and ${res.dirs} folder(s) of the Codex ` +
              `sandbox user again, removed ${res.locks} stale lock(s)`,
          );
        }
        for (const f of res.failed) {
          this.warnOnce(f.path, `cannot repair ${f.path} for the next Codex session: ${f.why}`);
        }
      }
      const stale = staleTempFiles(root, this.now());
      if (stale.length === 0) continue;
      const dir = join(root.opsDir, 'tmp');
      if (!this.config.remove_stale_temp) {
        this.warnOnce(
          dir,
          `${stale.length} temp file(s) older than an hour in ${dir}; nothing reads them. ` +
            'Set swarmupd.remove_stale_temp: true to have swarmupd delete such files',
        );
        continue;
      }
      let removed = 0;
      for (const path of stale) {
        try {
          rmSync(path, { force: true });
          removed += 1;
        } catch (err) {
          this.warnOnce(path, `cannot remove the stale temp file ${path}: ${String(err)}`);
        }
      }
      if (removed > 0) this.emit('repair', `${root.name}: removed ${removed} stale temp file(s)`);
    }
  }

  /**
   * A run in `cwd` must not use a data root found from its folder when that root is a copy of
   * one swarmupd knows: a task worktree holds the store as of its branch (AO-0168). Returns the
   * name of the root it copies, or null when `cwd` holds no such copy.
   */
  private rootCopyAt(ws: Workspace, cwd: string): string | null {
    const local = findRootUp(cwd);
    if (!local || ws.roots.some((r) => samePath(r.dir, local))) return null;
    const name = rootNameOf(local);
    return name && ws.roots.some((r) => r.name === name) ? name : null;
  }

  /** `gitTop`, remembered per folder once found, since wake planning asks for it every tick. */
  private gitTopOf(dir: string): string | null {
    const known = this.gitTops.get(dir);
    // A worktree someone removed is no checkout any more (AO-0230).
    if (known && existsSync(known)) return known;
    if (known) this.gitTops.delete(dir);
    const top = gitTop(dir);
    if (top) this.gitTops.set(dir, top);
    return top;
  }

  /**
   * {@link gitTopOf} with git off the event loop, so later `gitTopOf` calls for `dir` find it
   * remembered. A swarmupd that just started knows no top yet, and a resumed or adopted run's
   * wrap-up asked git for each one synchronously (AO-0205).
   */
  private async gitTopAsync(dir: string): Promise<string | null> {
    const known = this.gitTops.get(dir);
    if (known && existsSync(known)) return known;
    if (known) this.gitTops.delete(dir);
    let top: string;
    try {
      top = (await execOffThread('git', ['rev-parse', '--show-toplevel'], { cwd: dir }))
        .trim()
        .replace(/\//g, process.platform === 'win32' ? '\\' : '/');
    } catch {
      return null;
    }
    if (!top) return null;
    this.gitTops.set(dir, top);
    return top;
  }

  /**
   * The folder of a root's code: `swarmupd.code.<root>` when its store is a repo of its own
   * (AO-0252), else the root's own folder, whose git top is then the code checkout.
   */
  private codeDirOf(root: Pick<Root, 'name' | 'dir'>): string {
    const code = this.config.code[root.name];
    return resolve(code ?? root.dir);
  }

  /** The checkout of a root's code (see {@link codeDirOf}), or null when it is no git checkout. */
  private codeTopOf(root: Pick<Root, 'name' | 'dir'>): string | null {
    return this.gitTopOf(this.codeDirOf(root));
  }

  /** {@link codeTopOf} with git off the event loop. */
  private codeTopAsync(root: Pick<Root, 'name' | 'dir'>): Promise<string | null> {
    return this.gitTopAsync(this.codeDirOf(root));
  }

  /** Whether `top` is the git checkout a task store is in (not only a code checkout). */
  private holdsStore(top: string): boolean {
    return this.ws().roots.some((r) => {
      const t = this.gitTopOf(resolve(r.dir));
      return t !== null && samePath(t, top);
    });
  }

  /** Why a schedule's run cannot start now, or null. */
  private scheduleBlocker(ws: Workspace, s: ScheduleConfig): string | null {
    const inactive = roleInactive(ws.agent(s.agent));
    if (inactive) return inactive;
    const found = s.task ? ws.resolve(s.task) : undefined;
    const root = found?.root.name;
    // The folder launch uses: a code task's worktree (AO-0168), else the checkout.
    const wt = found
      ? this.codeWorktree(ws, s.agent, root, found.id, ws.view(`${root}/${found.id}`).meta.type)
      : null;
    return this.blocker(s.agent, this.projectOf(ws, s.task), {
      cwd: wt ? wt.path : this.checkoutOf(ws, s.agent, root),
      task: s.task,
    });
  }

  /** The project a run counts against: the task's project, else its root's default project. */
  projectOf(ws: Workspace, ref?: string): string {
    if (ref) {
      const v = ws.view(ref);
      return v.meta.project ?? v.root;
    }
    return ws.roots[0]?.projectName() ?? 'default';
  }

  /**
   * What swarmupd knows about each provider's usage allowance, with whether it pauses new runs, and
   * whether it is signed out (AO-0154).
   */
  usageReport(): Record<string, ProviderReport> {
    const out: Record<string, ProviderReport> = {};
    const providers = new Set([...Object.keys(this.config.runtimes), ...Object.keys(this.usage)]);
    const live = this.liveRecords();
    for (const p of providers) {
      const u = this.usage[p] ?? { windows: {}, updated_at: 0 };
      const pauseAt = this.config.runtimes[p]?.pause_at ?? this.config.usage_pause_at;
      const so = this.signIn[p]?.out;
      out[p] = {
        ...u,
        paused: this.config.runtimes[p]?.paused
          ? `${p} is paused in Settings`
          : (this.signedOutPause(p, live) ??
            usagePause(p, this.usage[p], pauseAt, this.now()) ??
            this.backoffPause(p)),
        live: live.filter((r) => runtimeOf(r.agent) === p).length,
        ...(so ? { signed_out: signedOutView(p, so) } : {}),
      };
    }
    return out;
  }

  // ---- Signed out (AO-0154) --------------------------------------------------------------------

  /** The provider's signed-out state, or null while it is signed in. */
  signedOut(provider: string): SignedOut | null {
    return this.signIn[provider]?.out ?? null;
  }

  private saveSignIn(): void {
    this.store.writeJson(SIGN_IN_FILE, this.signIn);
    this.emit('signin');
  }

  /**
   * Why no run of the provider starts now because it is signed out, or null. Without a sign-in
   * check swarmupd can use, one run an hour may start to try the sign-in, when none of the provider
   * is live or planned (`live`).
   */
  private signedOutPause(provider: string, live: PlannedRun[]): string | null {
    if (this.startChecks.has(provider)) return `swarmupd checks whether ${provider} is signed in`;
    const out = this.signIn[provider]?.out;
    if (!out) return null;
    if (
      out.no_check &&
      this.now() >= out.next &&
      !live.some((r) => runtimeOf(r.agent) === provider)
    ) {
      return null;
    }
    return signedOutText(provider, out, this.now());
  }

  /** The status command that checks the provider's sign-in, or null when it has none. */
  private signInCheck(provider: string): { file: string; args: string[] } | null {
    const rc = this.config.runtimes[provider];
    if (!rc || rc.sign_in_check === false) return null;
    const check = rc.sign_in_check ?? SIGN_IN_CHECKS[provider];
    const file = check ? resolveCommand(rc.command, this.env) : null;
    // `args` go first, as for a run: a wrapped runtime such as `wsl claude` checks the wrapped CLI.
    return check && file ? { file, args: [...(rc.args ?? []), ...check] } : null;
  }

  /**
   * Notes that the provider is signed out: from a run that could not sign in, or from a sign-in
   * check. swarmupd starts no run of it until it is signed in again. The human hears of it once:
   * after the sign-in check that follows a failed run says how swarmupd resumes.
   */
  private markSignedOut(provider: string, how: 'run' | 'check', r?: RunRecord): void {
    const now = this.now();
    const st = (this.signIn[provider] ??= {});
    if (st.out) {
      // A trial run, or one that was live before, could not sign in either.
      if (st.out.no_check) st.out.next = now + SIGNED_OUT_TRY_MINUTES * 60_000;
      this.saveSignIn();
      return;
    }
    // The check said "signed in" a moment ago, and a run still could not sign in.
    const doubt = st.cleared?.by === 'check' && now - st.cleared.at < CHECK_DOUBT_MS;
    if (doubt && how === 'run') st.check_unreliable = true;
    const noCheck = !this.signInCheck(provider) || st.check_unreliable === true;
    st.out = {
      since: now,
      ...(r ? { run: r.id } : {}),
      ...(r?.task && r.root ? { task: `${r.root}/${r.task}` } : {}),
      // The same spell as the one a check ended a moment ago: the human already knows.
      told: doubt ? (st.cleared?.told ?? false) : false,
      ...(noCheck ? { no_check: true } : {}),
      next: now + (noCheck ? SIGNED_OUT_TRY_MINUTES : SIGN_IN_CHECK_MINUTES) * 60_000,
    };
    delete st.cleared;
    this.backoff.delete(provider);
    this.saveSignIn();
    this.emit(
      'warn',
      `${provider} is signed out${r ? ` (run ${r.id} could not sign in)` : ''}; no new ${provider} runs until it is signed in`,
    );
    // After a failed run, the check runs first, so the notice says how swarmupd goes on.
    if (how === 'run' && !noCheck) void this.checkSignIn(provider);
    else this.tellSignedOut(provider);
  }

  /** Ends the provider's signed-out state; true if it was signed out. */
  private clearSignedOut(provider: string, by: 'check' | 'run' | 'resume'): boolean {
    const st = this.signIn[provider];
    if (!st?.out) return false;
    st.cleared = { at: this.now(), by, told: st.out.told };
    delete st.out;
    this.saveSignIn();
    const how = { check: 'its sign-in check says so', run: 'a run worked', resume: 'resumed' }[by];
    this.emit('warn', `${provider} is signed in again (${how}); its runs start again`);
    return true;
  }

  /**
   * Starts runs of signed-out providers again, or of `provider` only: the app's **Resume** and
   * `swarmup daemon resume`. Clears failed-start waits too. Returns the providers it resumed.
   */
  resumeSignIn(provider?: string): string[] {
    const names = provider ? [provider] : Object.keys(this.signIn);
    const resumed = names.filter((p) => this.clearSignedOut(p, 'resume'));
    for (const p of provider ? [provider] : [...this.backoff.keys()]) this.backoff.delete(p);
    return resumed;
  }

  /**
   * Runs the provider's sign-in check, which sends no prompt, and acts on its answer. Checks run
   * one at a time per provider; never throws.
   */
  async checkSignIn(provider: string): Promise<void> {
    if (this.signInChecking.has(provider)) return;
    const check = this.signInCheck(provider);
    let answer: SignInAnswer = 'unknown';
    this.signInChecking.add(provider);
    try {
      if (check) {
        const env = runEnv(this.env, {});
        dropEnv(env, this.config.runtimes[provider]?.unset_env ?? []);
        // `stop` ends the check; `close` waits for it.
        const running = runSignInCheck(
          check.file,
          check.args,
          env,
          SIGN_IN_CHECK_TIMEOUT_MS,
          this.stopAbort.signal,
        );
        this.signInRuns.add(running);
        try {
          answer = await running;
        } finally {
          this.signInRuns.delete(running);
        }
      }
    } finally {
      this.signInChecking.delete(provider);
      this.startChecks.delete(provider);
    }
    if (this.stopping || this.closed) return;
    this.safe(() => this.takeSignInAnswer(provider, answer));
  }

  private takeSignInAnswer(provider: string, answer: SignInAnswer): void {
    const st = this.signIn[provider];
    const out = st?.out;
    const now = this.now();
    if (answer === 'out') {
      if (!out) return this.markSignedOut(provider, 'check');
      out.next = now + SIGN_IN_CHECK_MINUTES * 60_000;
      this.saveSignIn();
      return this.tellSignedOut(provider);
    }
    if (!out) return;
    if (answer === 'in' && !st.check_unreliable) {
      this.clearSignedOut(provider, 'check');
      return;
    }
    // No answer swarmupd can use: one run an hour tries the sign-in instead.
    if (!out.no_check) {
      out.no_check = true;
      out.next = now + SIGNED_OUT_TRY_MINUTES * 60_000;
      this.saveSignIn();
    }
    this.tellSignedOut(provider);
  }

  /** Each tick: checks the sign-in of each signed-out provider whose check is due. */
  private signInTick(): void {
    const now = this.now();
    for (const [p, st] of Object.entries(this.signIn)) {
      const out = st.out;
      if (!out || out.no_check || now < out.next) continue;
      out.next = now + SIGN_IN_CHECK_MINUTES * 60_000;
      void this.checkSignIn(p);
    }
  }

  /**
   * At start: checks the sign-in of each provider an agent runs on, and starts none of its runs
   * until the check answers, so an expired session does not start a burst of failing runs.
   */
  private startSignInChecks(): void {
    const agents = [...Object.keys(this.config.agents), this.config.chat.agent];
    for (const p of Object.keys(this.config.runtimes)) {
      if (!agents.some((a) => runtimeOf(a) === p) || !this.signInCheck(p)) continue;
      this.startChecks.add(p);
      void this.checkSignIn(p);
    }
  }

  /**
   * Tells the human once per signed-out spell, in their inbox (a mention, which the desktop app
   * shows as a notification) and through the app's banner: which provider, how to sign in, how
   * swarmupd resumes, and which reviews wait for it.
   */
  private tellSignedOut(provider: string): void {
    const out = this.signIn[provider]?.out;
    if (!out || out.told) return;
    out.told = true;
    this.saveSignIn();
    this.safe(() => {
      const ws = this.ws(RUNTIME_ACTOR);
      const human = this.user.me ?? ws.roots[0]?.config.human;
      if (!human) return;
      const how = out.run
        ? `run ${out.run}${out.task ? ` on ${out.task}` : ''} could not sign in`
        : 'its sign-in check says so';
      const resume = out.no_check
        ? `swarmupd cannot check the sign-in without a run, so it starts one ${provider} run an hour, next at ${clock(out.next)}`
        : `swarmupd checks the sign-in every ${SIGN_IN_CHECK_MINUTES} minutes and starts ${provider} runs again by itself`;
      const reviews = ws
        .list()
        .filter(
          (v) =>
            v.status === 'needs-review' &&
            v.reviewer !== null &&
            !isHuman(v.reviewer) &&
            runtimeOf(v.reviewer) === provider,
        )
        .map((v) => v.meta.id);
      const text =
        `${provider} is signed out on this PC: ${how}. swarmupd starts no ${provider} runs until you ` +
        `sign in again: ${signInSteps(provider)}. ${resume}; to resume now, click **Resume** in ` +
        'the app or run `swarmup daemon resume`.' +
        (reviews.length > 0 ? ` Reviews that wait for ${provider}: ${reviews.join(', ')}.` : '');
      ws.post(DIRTY_CHANNEL, text, { to: [human], task: out.task });
    });
  }

  /**
   * Hands a task owned by name by an agent of a signed-out provider, such as the author a review
   * sent back, to the same role on another provider once the provider has been signed out for
   * `signed_out_handoff_minutes`. Work that has a worktree goes to no provider that cannot
   * commit there (AO-0155). Work owned by `*:<role>` needs none of this: the wake plan already
   * passes over a signed-out provider.
   */
  private signedOutHandoffs(): void {
    const minutes = this.config.signed_out_handoff_minutes;
    if (minutes <= 0) return;
    const now = this.now();
    const grace = minutes * 60_000;
    const out = new Map<string, number>();
    for (const [p, st] of Object.entries(this.signIn)) {
      if (st.out && now - st.out.since >= grace) out.set(p, st.out.since);
    }
    if (out.size === 0) return;
    const ws = this.ws(RUNTIME_ACTOR);
    const waking = this.wakingAgents().filter((a) => !roleInactive(ws.agent(a)));
    const live = this.liveRecords();
    for (const v of ws.list()) {
      const owner = v.owner;
      if (v.status !== 'todo' || v.claimedBy || !owner || isHuman(owner) || isWildcard(owner))
        continue;
      const from = runtimeOf(owner);
      const since = out.get(from);
      if (since === undefined) continue;
      // The grace counts from when this task began to wait: a send-back to the signed-out
      // provider's agent waits its full grace too.
      const todoAt = v.todoSince ? Date.parse(v.todoSince) : NaN;
      if (Number.isFinite(todoAt) && now - todoAt < grace) continue;
      if (live.some((r) => r.root === v.root && r.task === v.meta.id)) continue;
      const role = roleOf(owner);
      const worktree = this.taskWorktree(ws, v);
      const reviewer = v.delegation?.review;
      const order = roleLimits(this.config, role).providers;
      const rank = (a: string): number => {
        const i = order.indexOf(runtimeOf(a));
        return i < 0 ? order.length : i;
      };
      const to = waking
        .filter((a) => roleOf(a) === role && runtimeOf(a) !== from)
        .filter((a) => !this.signIn[runtimeOf(a)]?.out)
        .filter((a) => !(reviewer && !isHuman(reviewer) && runtimeOf(reviewer) === runtimeOf(a)))
        .sort((a, b) => rank(a) - rank(b))[0];
      if (!to) continue;
      const where = worktree
        ? `Its work is on branch \`${worktree.branch ?? '(detached HEAD)'}\` in the worktree \`${worktree.path}\`.`
        : 'swarmupd found no worktree for it; its events name the branch, if any.';
      const note =
        `${v.meta.id}: ${from} is signed out on this PC since ${clock(since)}, so ${owner} cannot ` +
        `work on it; swarmupd hands it to ${to} after ${minutes} min. ${where} Go on from the ` +
        'latest checkpoint and comments.';
      this.safe(() => {
        ws.handoff(`${v.root}/${v.meta.id}`, to, note);
        this.emit(
          'warn',
          `${v.root}/${v.meta.id}: handed from ${owner} to ${to}; ${from} is signed out`,
        );
      });
    }
  }

  /** The linked worktree a task's work is in (`out/wt-<id>` or a branch naming the id), or null. */
  private taskWorktree(ws: Workspace, v: TaskView): { path: string; branch: string | null } | null {
    const root = ws.roots.find((r) => r.name === v.root);
    const top = root ? this.codeTopOf(root) : null;
    if (!top) return null;
    let list: Array<{ path: string; branch: string | null }>;
    try {
      list = this.checkout(top).worktrees();
    } catch {
      return null;
    }
    const id = v.meta.id.toLowerCase();
    return (
      list.find(
        (w) =>
          !samePath(w.path, top) &&
          (basename(w.path).toLowerCase().includes(id) ||
            (w.branch ?? '').toLowerCase().includes(id)),
      ) ?? null
    );
  }

  /** Takes new usage readings from a run's output into the usage state. */
  private readUsage(l: LiveRun): void {
    const provider = runtimeOf(l.record.agent);
    let reading: ProviderUsage | null = null;
    if (l.meter.rateLimitSeen !== (l.rateLimitsRead ?? 0)) {
      l.rateLimitsRead = l.meter.rateLimitSeen;
      reading = claudeUsage(l.meter.rateLimit, this.now());
    } else if (l.meter.threadId) {
      l.rollout ??= findRollout(codexHome(this.env), l.meter.threadId) ?? undefined;
      if (l.rollout) reading = codexUsage(lastCodexLimits(l.rollout), this.now());
    }
    if (l.meter.limitHits !== (l.limitHitsRead ?? 0)) {
      l.limitHitsRead = l.meter.limitHits;
      // A reset the provider named wins; the cooldown only covers an error without one, and
      // never shortens a refusal already known.
      const known = reading?.limited_until ?? this.usage[provider]?.limited_until ?? 0;
      const until =
        l.meter.limitHit?.resetsAt ??
        (reading?.limited_until ||
          Math.max(known, this.now() + this.config.usage_cooldown_minutes * 60_000));
      reading = { ...(reading ?? { windows: {} }), limited_until: until, updated_at: this.now() };
      this.emit(
        'warn',
        `run ${l.record.id}: ${provider} hit its usage limit; no new ${provider} runs until ${new Date(until).toISOString()}`,
      );
    }
    if (!reading) return;
    this.usage[provider] = mergeUsage(this.usage[provider], reading);
    this.store.writeJson('usage.json', this.usage);
  }

  /** Why no new run of the provider starts now after its failed starts, or null (AO-0150). */
  private backoffPause(provider: string): string | null {
    const b = this.backoff.get(provider);
    if (!b || b.until <= this.now()) return null;
    return (
      `${provider} runs ended with an error within ${FAST_FAIL_MS / 1000} s ${b.failures} ` +
      `time(s) in a row; next try at ${clock(b.until)}`
    );
  }

  /**
   * A run that could not sign in puts its provider in the signed-out state (AO-0154). A run that
   * ended with an error within `FAST_FAIL_MS` counts as a failed start of its runtime, and swarmupd
   * waits longer before each next run (AO-0150); without this, an expired sign-in made swarmupd
   * start and release a run every tick for hours. A run that works clears the count, and the
   * signed-out state when it started after it. A usage limit has its own pause (`readUsage`) and
   * counts as neither. A chat turn can fail at once on its own session, so it never counts as a
   * failed start.
   */
  private noteRunHealth(l: LiveRun, r: RunRecord): void {
    if (l.meter.limitHits > 0 || r.reason === 'lost') return;
    const provider = runtimeOf(r.agent);
    if (l.meter.authFailed) {
      this.markSignedOut(provider, 'run', r);
      return;
    }
    const ms = Date.parse(r.ended_at ?? r.started_at) - Date.parse(r.started_at);
    const quick = ms < FAST_FAIL_MS;
    if (!(r.reason === 'exit' && r.exit !== 0 && quick && !r.chat)) {
      // A run stopped soon after its start, such as by a person, says nothing either way.
      if (r.exit === 0 || !quick) {
        this.backoff.delete(provider);
        const out = this.signIn[provider]?.out;
        // A run that was live before the sign-in failed proves nothing about it now.
        if (out && Date.parse(r.started_at) >= out.since) this.clearSignedOut(provider, 'run');
      }
      return;
    }
    const prev = this.backoff.get(provider);
    const failures = (prev?.failures ?? 0) + 1;
    const stopped = failures >= BACKOFF_STOP;
    const minutes = stopped ? BACKOFF_STOPPED_MINUTES : BACKOFF_MINUTES[failures - 1]!;
    const b: RuntimeBackoff = {
      failures,
      until: this.now() + minutes * 60_000,
      told: prev?.told ?? false,
    };
    this.backoff.set(provider, b);
    this.emit(
      'warn',
      `run ${r.id}: ${provider} ended with exit ${r.exit ?? '-'} after ${ms} ms; no new ${provider} runs until ${clock(b.until)}`,
    );
    if (stopped && !b.told) {
      b.told = true;
      this.tellStopped(provider, b, r);
    }
  }

  /** Tells the human once that a runtime's runs keep failing at once, and what to do. */
  private tellStopped(provider: string, b: RuntimeBackoff, r: RunRecord): void {
    this.safe(() => {
      const ws = this.ws(RUNTIME_ACTOR);
      const human = this.user.me ?? ws.roots[0]?.config.human;
      if (!human) return;
      const task = r.task && r.root ? `${r.root}/${r.task}` : undefined;
      const what = `ended with an error within ${FAST_FAIL_MS / 1000} s ${b.failures} times in a row`;
      const fix = `Check the log of run ${r.id} with \`swarmup logs ${r.id}\``;
      const text =
        `${task ?? 'opsd'}: ${provider} runs ${what}; the last was run ${r.id}. ` +
        `swarmupd starts the next ${provider} run at ${clock(b.until)}, then once an hour until one ` +
        `works. ${fix}; to try again sooner, pause and resume ${provider} in Settings or ` +
        `restart swarmupd.`;
      ws.post(DIRTY_CHANNEL, text, { to: [human], task });
    });
  }

  /** Every run, newest first; with `live`, the running ones only. */
  runs(opts: { live?: boolean } = {}): RunRecord[] {
    if (opts.live) {
      // Every running record is in `live` once `adopt` ran, so the store is not read: with
      // 1,500 runs on disk that took ~85 ms per call, and the app asks for live runs and health
      // several times per refresh (AO-0164).
      return [...this.live.values()]
        .map((l) => l.record)
        .filter((r) => r.status === 'running')
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }
    return this.store.list().map((r) => this.live.get(r.id)?.record ?? r);
  }

  run(id: string): RunRecord {
    const r = this.live.get(id)?.record ?? this.store.get(id);
    if (!r) throw new OpsError(`no run ${id}`, 2);
    return r;
  }

  /** The run's record while it is live, or undefined once it ended or when swarmupd never ran it. */
  liveRun(id: string): RunRecord | undefined {
    return this.live.get(id)?.record;
  }

  liveFor(agent: string): RunRecord | undefined {
    return [...this.live.values()].find((l) => l.record.agent === agent)?.record;
  }

  // ---- Launch and end ------------------------------------------------------------------------

  /**
   * {@link launch} for the API: reads the checkouts first, off the event loop, as a tick does,
   * so the launch runs no git in a checkout opsd has seen before (AO-0215).
   */
  async launchFresh(req: LaunchRequest): Promise<RunRecord> {
    const states = await this.readCheckouts();
    // A tick's launches run without an await, so none is under way here.
    this.tickStates = states;
    try {
      return this.launch(req);
    } finally {
      this.tickStates = null;
    }
  }

  launch(req: LaunchRequest): RunRecord {
    if (this.stopping) throw new OpsError('swarmupd is stopping');
    const agent = assertActor(req.agent, 'agent');
    const runtime = runtimeOf(agent);
    const rc = this.config.runtimes[runtime];
    if (!rc) throw new OpsError(noProvider(runtime), 2);
    const id = ulid(this.now());
    const ws = this.ws(agent, id);
    const def = ws.agent(agent);
    const inactive = roleInactive(def);
    if (inactive) throw new OpsError(inactive);
    const file = resolveCommand(rc.command, this.env);
    if (!file) throw new OpsError(`'${rc.command}' is not on PATH`, 2);

    let task: string | undefined;
    let rootName: string | undefined;
    let ref: string | undefined;
    let heldHere = false;
    let delegation: { budget_minutes?: number; tokens?: number } | null = null;
    let question: QuestionPrompt | undefined;
    let taskType: string | undefined;
    const parent = req.parent ? this.live.get(req.parent)?.record : undefined;
    if (req.parent) {
      if (!parent) throw new OpsError(`parent run ${req.parent} is not live`);
      if (parent.parent) throw new OpsError('a helper run cannot start helpers of its own');
      if (parent.review || !parent.task || !parent.root) {
        throw new OpsError('only a run working on a task can start helpers');
      }
      const parentRef = `${parent.root}/${parent.task}`;
      if (!this.ws(parent.agent, parent.id).holdsClaim(parentRef)) {
        throw new OpsError(`run ${parent.id} no longer holds ${parentRef}`);
      }
      if (!req.prompt) throw new OpsError('a helper run needs a prompt', 2);
      const max = roleLimits(this.config, roleOf(parent.agent)).max_children;
      const kids = this.liveRecords().filter((r) => r.parent === parent.id).length;
      if (kids >= max) {
        throw new OpsError(`run ${parent.id} has ${kids} helper(s) live; max_children is ${max}`);
      }
      task = parent.task;
      rootName = parent.root;
    }
    if (req.task && !parent) {
      const { root, id } = ws.resolve(req.task);
      task = id;
      rootName = root.name;
      ref = `${root.name}/${id}`;
      const v = ws.view(ref);
      delegation = v.delegation;
      taskType = v.meta.type;
      if (!req.review && v.meta.type === QUESTION_TYPE) question = questionPrompt(ws, ref, v);
      if (req.review) {
        if (v.status !== 'needs-review' || !ownerMatches(v.reviewer, agent)) {
          throw new OpsError(`${ref} does not wait for ${agent}'s review`);
        }
      }
      const running = this.liveRecords().find((r) => r.root === root.name && r.task === id);
      if (running) throw new OpsError(`${ref} already has a live run (${running.id})`);
      // A claim by the same agent id from another clone is another run's; ws.claim refuses it.
      if (!req.review) {
        // Held by this clone without this run: bind it to the new run, unless a live run owns it.
        heldHere = this.ws(agent).holdsClaim(ref, { anyRun: true });
        if (heldHere) {
          const owner = root.claimRecord(id).run;
          if (owner && this.live.has(owner))
            throw new OpsError(`${ref} is held by live run ${owner}`);
        }
      }
    }
    const project = parent
      ? (parent.project ?? parent.root ?? this.projectOf(ws))
      : this.projectOf(ws, ref);
    // Reviewers may burst in a project whose reviews pile up.
    const burst =
      req.review === true && this.reviewBacklog(ws.list(), project) >= this.config.review_backlog;
    const agentCfg = this.config.agents[agent] ?? {};
    // A code task of a role that writes works in a worktree of its own, not in the store
    // checkout every such run would share (AO-0168).
    let worktree =
      !parent && !req.cwd && !req.review && !req.chat && !question && ref
        ? this.codeWorktree(ws, agent, rootName, task, taskType)
        : null;
    // A helper always works in its parent's folder.
    const folder = (): string =>
      parent?.cwd
        ? resolve(parent.cwd)
        : worktree
          ? worktree.path
          : this.checkoutOf(ws, agent, rootName, req.cwd);
    const blockedIn = (dir: string): string | null =>
      this.blocker(agent, project, {
        burst,
        child: parent !== undefined,
        question: question !== undefined,
        chat: req.chat !== undefined,
        cwd: dir,
      });
    // Whatever chose the folder (an explicit `cwd`, the agent's folder, a helper's parent), no run
    // starts inside a worktree swarmupd is checking or deleting (AO-0230). Checked before
    // `blocker`, which reads git there, and again for the folder the launch ends up with.
    const refuseHeld = (dir: string): void => {
      const held = this.reclaimHoldOf(dir);
      if (!held) return;
      throw new OpsError(
        `swarmupd is removing the worktree ${held}; start the run once it is gone` +
          (ref ? `, and swarmupd makes the task's worktree again from its branch` : ''),
      );
    };
    let cwd = folder();
    if (!worktree) refuseHeld(cwd);
    let blocked = blockedIn(cwd);
    if (blocked) throw new OpsError(blocked);
    if (worktree && !worktree.ready) {
      // Wake makes worktrees off the event loop before it starts a run; a launch from the API
      // or a schedule cannot wait for a tick, so it makes one here.
      if (this.makingWorktrees.has(worktree.path)) {
        throw new OpsError(
          `swarmupd is making the worktree ${worktree.path} for ${ref}; start the run once it is there`,
        );
      }
      if (this.reclaimHolds(worktree.path)) {
        throw new OpsError(
          `swarmupd is removing the worktree ${worktree.path} of ${ref}; start the run once it is ` +
            'gone, and swarmupd makes it again from the task branch',
        );
      }
      try {
        makeTaskWorktreeSync(worktree, this.env);
        this.worktreeFailed.delete(worktree.path);
        this.emit('worktree', `${ref}: made ${worktree.path}`);
      } catch (err) {
        this.worktreeFailed.set(worktree.path, this.now());
        this.emit('warn', `${ref}: cannot make worktree ${worktree.path}: ${gitError(err)}`);
        // The run starts in the checkout, as before worktrees, if that has room.
        worktree = null;
        cwd = folder();
        blocked = blockedIn(cwd);
        if (blocked) throw new OpsError(blocked);
      }
    }
    refuseHeld(cwd);
    // What a top-level run leaves is committed on a branch from the commit it started on. A
    // writing run starts on a clean checkout (see `blocker`). Any other run, such as a qa or
    // reviewer run, gets a start commit only when it finds the checkout clean, so its wrap-up
    // never takes changes a person or another run made before it (AO-0136). A chat turn cannot
    // edit files and opsd commits nothing after it, so it skips the three git reads: they held
    // opsd's API for some 0.3-0.6 s after each chat message (AO-0171).
    let base: string | undefined;
    let around: Record<string, string[]> | undefined;
    if (!parent && !req.chat) {
      // A git that a crash or kill cut off mid-write leaves `index.lock`, and every git command in
      // the worktree fails until it is gone (AO-0230). No run works there: `blocker` said so.
      if (worktree && clearStaleIndexLock(worktree.path, this.now())) {
        this.emit('worktree', `${ref}: removed a stale index.lock in ${worktree.path}`);
      }
      const top = this.gitTopOf(cwd);
      const writes = this.writingRun({ agent });
      if (top && (writes || this.cleanCheckout(top))) base = this.headOf(top) || undefined;
      if (top && writes) around = this.aroundSnapshot(top, worktree?.top);
    }
    // Everything that can fail on bad input runs before the claim, so a refused launch leaves
    // the task as it was.
    const budget = req.budget
      ? parseDuration(req.budget)
      : (delegation?.budget_minutes ??
        (agentCfg.budget ? parseDuration(agentCfg.budget) : undefined) ??
        def?.budget_min ??
        this.config.budget_minutes);
    const tokenBudget = req.tokens ? parseTokens(req.tokens) : delegation?.tokens;
    const mirrorRoot = rootName
      ? ws.roots.find((r) => r.name === rootName && r.isMirror)
      : undefined;
    if (mirrorRoot && !parent && !req.cwd && !agentCfg.cwd) {
      throw new OpsError(
        `${rootName} is a project mirrored in the Master Repo and has no checkout here: add the ` +
          `project's root to this machine, or give the run a folder (swarmupd.agents.${agent}.cwd)`,
        2,
      );
    }
    // The run's own scratch folder, outside every checkout: logs, test output and experiments go
    // here instead of the repo, `out/` or the folder above it (AO-0230).
    const scratch = join(this.store.dir, 'scratch', id);
    mkdirSync(scratch, { recursive: true });
    const addDirs = [...ws.roots.map((r) => this.gitTopOf(r.dir) ?? r.dir), scratch].filter(
      (d, i, all) => all.indexOf(d) === i && !inside(d, cwd),
    );
    const roleDirs = ws.roots.map((r) => join(r.dir, 'agents'));
    if (req.chat && (req.task || req.parent)) {
      throw new OpsError('a chat turn works on no task', 2);
    }
    // The agent's model in Settings wins over its role file's, which wins over the provider's.
    const runDef = agentCfg.model
      ? ({
          ...(def ?? { id: agent, status: 'active', file: '', body: '' }),
          model: agentCfg.model,
        } as AgentDef)
      : def;
    const readOnly = !roleLimits(this.config, roleOf(agent)).writes;
    // A run in a data root's checkout makes code branches in worktrees (AO-0135).
    const storeCheckout = this.storeCheckoutOf(ws, cwd) ?? undefined;
    // A run that swarmupd starts in the task's worktree is told where it is (AO-0168).
    const taskWorktree = worktree
      ? {
          path: worktree.path,
          branch: worktreeBranch(worktree.path),
          store: { ...this.storeCheckoutOf(ws, worktree.top), top: worktree.top },
        }
      : undefined;
    // The folder holds a stale copy of a root (a worktree on a store branch): `swarmup` in the run
    // must use the real root, so only SWARMUP_ROOTS counts, with the copied root first.
    const copied = this.rootCopyAt(ws, cwd);
    const rootDirs = ws.roots
      .slice()
      .sort((a, b) => Number(b.name === copied) - Number(a.name === copied))
      .map((r) => r.dir);
    // Task stores, the one in the run's checkout first: a read-only Codex run starts there.
    const checkoutTop = this.gitTopOf(cwd) ?? cwd;
    const stores = ws.roots
      .map((r) => r.dir)
      .sort((a, b) => Number(inside(b, checkoutTop)) - Number(inside(a, checkoutTop)));
    // A writing Codex run may commit in a worktree of its checkout (AO-0155).
    const gitDirs =
      runtimeOf(agent) === 'codex' && !readOnly ? codexGitDirsOf(this.gitDirsOf(cwd)) : [];
    const inv = invocation(
      rc,
      agent,
      runDef,
      cwd,
      addDirs,
      roleDirs,
      req.chat,
      readOnly,
      storeCheckout !== undefined,
      stores,
      gitDirs,
    );
    // Custom prompts are used as given, so only a standard task prompt lists related notes.
    const notes = req.prompt === undefined && ref ? this.taskNotes(ws, ref) : [];
    // A custom prompt is used as given, plus the store-checkout rule when it applies, plus the
    // read-only Codex note.
    const prompt =
      (req.prompt !== undefined
        ? withStoreCheckoutRule(
            req.prompt,
            storeCheckout,
            task,
            taskWorktree,
            readOnly ? undefined : scratch,
          )
        : runPrompt({
            agent,
            task,
            roleFile: def?.file,
            role: def,
            review: req.review,
            question,
            extra: req.extra,
            storeCheckout,
            taskWorktree,
            scratch: readOnly || req.chat ? undefined : scratch,
            notes,
          })) + (inv.note ?? '');

    // Claim before the process starts, so two runs never race for one task.
    let claimedHere = false;
    // A review run holds no claim.
    if (ref && heldHere && !req.review) ws.bindClaim(ref);
    if (ref && !heldHere && !req.review) {
      ws.claim(ref);
      claimedHere = true;
    }
    let spawned: Spawned | undefined;
    let record: RunRecord;
    // The run's own API token: swarmupd acts as this run's agent for it, never as the human.
    const runToken = randomBytes(24).toString('hex');
    try {
      // Each variable under both prefixes: a `swarmup` built before the rename reads `OPS_*`.
      const env = runEnv(
        this.env,
        envPairs({
          AGENT: agent,
          RUN: id,
          RUN_TOKEN: runToken,
          // Where the token is valid: `swarmup` uses it only for the swarmupd on this state folder.
          RUN_STATE_DIR: this.store.dir,
          PARENT_RUN: parent?.id,
          ROOTS: rootDirs.join(delimiter),
          SCRATCH: scratch,
          ...(copied ? { [ROOTS_ONLY_NAME]: '1' } : {}),
        }),
      );
      // Temp files of the run and the tools it starts land in its scratch folder too. Windows
      // names are case-insensitive, so other spellings go first.
      for (const k of Object.keys(env)) if (/^(temp|tmp|tmpdir)$/i.test(k)) delete env[k];
      env.TEMP = scratch;
      env.TMP = scratch;
      env.TMPDIR = scratch;
      // Only a run in a root's copy ignores the root found from its folder.
      if (!copied) dropEnv(env, [ROOTS_ONLY_ENV, OLD_ENV_PREFIX + ROOTS_ONLY_NAME]);
      dropEnv(env, inv.unsetEnv);
      const log = this.store.logPath(id);
      const fd = openSync(log, 'a');
      try {
        spawned = spawnHidden(file, inv.args, { cwd, env, out: fd });
      } finally {
        closeSync(fd);
      }
      record = {
        id,
        agent,
        task,
        root: rootName,
        project,
        review: req.review || undefined,
        question: question ? true : undefined,
        parent: parent?.id,
        schedule: req.schedule,
        // Matches the prompt choice above: only the standard prompt reads the inbox.
        inbox:
          !task && req.prompt === undefined && req.extra === undefined && !req.chat
            ? true
            : undefined,
        chat: req.chat ? true : undefined,
        pid: spawned.pid,
        image: spawned.image,
        command: [rc.command, ...inv.args].join(' '),
        cwd,
        log,
        started_at: new Date(this.now()).toISOString(),
        status: 'running',
        budget_minutes: budget,
        token_budget: tokenBudget,
        tokens: 0,
        // Read before the record is saved, so an adopting swarmupd always has it to check. Windows:
        // the command starts only after `handOver` has read the launcher's off the event loop;
        // reading the shell's here asked PowerShell synchronously, 0.2-1.2 s on every launch
        // and chat turn (AO-0171). A swarmupd that stops before then leaves nothing running.
        proc_start: spawned.launch ? undefined : (processStartSync(spawned.pid) ?? undefined),
        shim_pid: spawned.launch ? spawned.pid : undefined,
        token_sha256: sha256(runToken),
        base,
        scratch,
        around,
      };
      this.store.save(record);
    } catch (err) {
      // Undo only what this launch did: its own process and its own claim. On Windows the
      // command has not started yet, and without `go` it never does.
      if (spawned) killOwnChild(spawned);
      if (claimedHere && ref) {
        const why = err instanceof Error ? err.message : String(err);
        this.safe(() => ws.release(ref, `launch failed: ${why}`));
      }
      throw err;
    }
    const child = spawned.child;
    const liveRun: LiveRun = {
      record,
      child,
      meter: new UsageMeter(),
      offset: 0,
      decoder: new StringDecoder('utf8'),
      launch: spawned.launch,
    };
    this.live.set(id, liveRun);
    // A signed-out provider without a sign-in check: this run is its try for the next hour.
    const signedOut = this.signIn[runtime]?.out;
    if (signedOut?.no_check) {
      signedOut.next = this.now() + SIGNED_OUT_TRY_MINUTES * 60_000;
      this.saveSignIn();
    }
    child.on('exit', (code) => this.finish(id, code));
    if (spawned.launch) void this.handOver(liveRun, spawned.launch, prompt);
    else {
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt);
    }
    if (notes.length > 0 && ref) {
      // Usage accounting must never stop a run whose prompt was already built. Resolve the
      // display refs back to notes only here, after the process successfully started.
      this.safe(() =>
        ws.recordNotesShown(
          notes.map((note) => ws.kbNote(note.ref)),
          { actor: agent, task: ref, run: id },
        ),
      );
    }
    void this.trackProcs();
    if (task) {
      this.safe(() =>
        ws.recordRun(
          `${rootName}/${task}`,
          'run-start',
          { run: id },
          `${runtime} run, budget ${formatMinutes(budget)}${tokenBudget ? `, ${tokenBudget} tokens` : ''}`,
        ),
      );
    }
    this.emit('run', record);
    return record;
  }

  /** Stops a run and its process tree. */
  kill(id: string, reason = 'killed'): RunRecord {
    const l = this.live.get(id);
    if (!l) throw new OpsError(`run ${id} is not live`);
    l.killReason = reason;
    const r = l.record;
    if (l.launch) {
      // Nothing started past the launcher yet: closing the channel and the shell ends the run.
      this.abortLaunch(l);
      return r;
    }
    if (l.child && process.platform !== 'win32') {
      // Its own child, not reaped yet: the PID and the process group cannot be reused.
      killTree(r.pid);
      return r;
    }
    if (!l.child && !this.procLister().precise) {
      // Adopted, on a platform without exact creation times: the PID cannot be checked at the
      // moment of a kill, so swarmupd leaves it alone.
      this.emit('warn', `run ${id}: cannot check adopted PID ${r.pid} here; stop it yourself`);
      this.finish(id, null);
      return r;
    }
    void this.killByLedger(id);
    return r;
  }

  /**
   * Stops the run's root and every descendant the ledger confirms, each checked at the moment of
   * the kill. No tree kill: Windows matches a tree by parent PID alone, which can reach a process
   * whose parent PID was reused. A run swarmupd started is also stopped through its own process
   * handle, whatever the ledger finds. A snapshot that fails or does not list the root does not
   * leave it running: the root is then killed by its recorded PID and creation time (see
   * `killRoot`).
   */
  private killByLedger(id: string): Promise<void> {
    return this.procWork(async () => {
      const l = this.live.get(id);
      if (!l) return;
      const ledger = this.ledgerOf(l.record);
      // The root still needs a kill unless a snapshot showed it gone or it was killed below.
      let rootLeft = true;
      try {
        const now = Date.now();
        const snap = await this.snapshot();
        track(ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
        const left = survivors(ledger, snap);
        await this.killVerified(left);
        this.store.saveProcs(ledger);
        // Listed but not a survivor: the PID runs another process now, so the root is gone. A
        // survivor whose kill did not take gets one more try, which warns if it fails again.
        const root = left.find((e) => e.pid === ledger.root_pid);
        const listed = snap.some((p) => p.pid === ledger.root_pid);
        rootLeft = !listed || (root !== undefined && !root.killed_at);
      } finally {
        if (rootLeft) await this.killRoot(id, ledger);
        if (l.child) {
          if (l.child.exitCode === null) l.child.kill('SIGKILL');
        } else {
          // An adopted run sends no exit event.
          this.finish(id, null);
        }
      }
    });
  }

  /**
   * Kills the run's root by its recorded PID and creation time, checked at the moment of the kill,
   * for when no snapshot showed it. Windows: the root is the launcher, which runs outside swarmupd's
   * job; ending only the hidden `cmd.exe` would leave it and the command running, and its own job
   * ends the command with it. Warns when it cannot, so the run is not taken for stopped.
   */
  private async killRoot(id: string, ledger: ProcLedger): Promise<void> {
    const pid = ledger.root_pid;
    const start = ledger.root_start;
    const cannot = (why: string): void => {
      this.emit('warn', `run ${id}: cannot stop PID ${pid} (${why}); stop it yourself`);
    };
    if (start === null) return cannot('no creation time on record');
    let res: KillResult | undefined;
    try {
      res = (await this.procLister().kill([{ pid, start }])).get(pid);
    } catch (err) {
      return cannot(err instanceof Error ? err.message : String(err));
    }
    if (res === 'killed') {
      const entries = ledger.entries.filter((e) => e.pid === pid && e.start === start);
      if (entries.length > 0) {
        applyKills(entries, new Map([[pid, res]]), Date.now());
        this.safe(() => this.store.saveProcs(ledger));
      }
    } else if (res !== 'gone' && res !== 'other') {
      cannot(res === 'error' ? 'the kill failed' : 'no answer from the process lister');
    }
  }

  private finish(id: string, exit: number | null): void {
    const l = this.live.get(id);
    if (!l) return;
    this.live.delete(id);
    l.launch?.abort();
    l.launch = undefined;
    this.readLog(l);
    l.meter.end();
    const r = l.record;
    r.status = 'ended';
    r.ended_at = new Date(this.now()).toISOString();
    r.exit = l.killReason ? null : exit;
    r.reason = l.killReason ?? (l.child ? 'exit' : 'lost');
    r.tokens = l.meter.tokens;
    this.noteRunHealth(l, r);
    // Saved with the end, so a swarmupd that stops before the wrap-up is over resumes it.
    r.wrap_up = 'pending';
    this.store.save(r);
    this.ending.set(id, r);
    this.startWrapUp(r);
  }

  /**
   * Starts the wrap-up of a run in `ending`. Helpers end with their parent. A helper that ended
   * first may still be in its own wrap-up, reaping descendants that can write: the parent waits
   * for it too. `resumed`: the run ended under an earlier swarmupd, so its helpers that ended there
   * count as well.
   */
  private startWrapUp(r: RunRecord, resumed = false): void {
    const id = r.id;
    const helpers = [
      ...new Set(
        [...this.liveRecords(), ...(resumed ? this.store.list() : [])]
          .filter((c) => c.parent === id)
          .map((c) => c.id),
      ),
    ];
    for (const child of helpers) {
      if (this.live.has(child)) this.safe(() => this.kill(child, 'parent-ended'));
    }
    void this.wrapUp(r, helpers).catch((err) => {
      this.emit('warn', `run ${id}: wrap-up failed: ${String(err)}`);
      this.ended(id);
    });
  }

  /**
   * Saves how far a run's wrap-up got, onto the stored record: `reap` keeps `procs_left` there.
   */
  private wrapStep(r: RunRecord, patch: Partial<RunRecord>): void {
    Object.assign(r, patch);
    const stored = this.store.get(r.id);
    if (stored) r.procs_left = stored.procs_left;
    this.store.save({ ...(stored ?? r), ...patch });
  }

  /**
   * After a run's process ended: reaps its descendants and waits for its helpers to end, so
   * nothing the run started still writes; then commits what it left, records the run's end on
   * its task, frees or sends the task for review, and syncs. Each step is saved on the run
   * (`wrap_up`), so a swarmupd that resumes the wrap-up after a restart skips the steps done.
   */
  private async wrapUp(r: RunRecord, helpers: string[]): Promise<void> {
    const id = r.id;
    if ((r.wrap_up ?? 'pending') === 'pending') {
      // The commit step reads the git top of the run's folder and of each live run's.
      await Promise.all([r, ...this.liveRecords()].map((o) => this.gitTopAsync(resolve(o.cwd))));
      await this.commitStep(r, helpers);
    }
    const left = r.leftovers ?? null;
    if (r.task && r.root) {
      const ref = `${r.root}/${r.task}`;
      // As the run: only the run's own claim is renewed or released.
      const ws = this.ws(r.agent, id);
      const minutes = Math.round(
        (Date.parse(r.ended_at ?? r.started_at) - Date.parse(r.started_at)) / 60_000,
      );
      if (r.wrap_up === 'committed') {
        const strays = this.strays(r);
        if (strays.length > 0) {
          this.emit('warn', `run ${id}: new next to its checkout: ${strays.join(', ')}`);
        }
        const notes = [
          left ? leftoverNote(left) : (r.not_committed ?? ''),
          strays.length > 0 ? straysNote(strays) : '',
        ].filter(Boolean);
        this.safe(() =>
          ws.recordRun(
            ref,
            'run-end',
            {
              run: id,
              exit: r.exit,
              reason: r.reason,
              minutes,
              tokens: r.tokens || undefined,
            },
            notes.join('\n\n'),
          ),
        );
        this.wrapStep(r, { wrap_up: 'recorded' });
      }
      if (r.wrap_up === 'recorded') this.settleTask(r, ws, ref, left);
    } else if (left && r.wrap_up === 'committed') {
      this.emit('warn', `run ${id}: ${leftoverNote(left)}`);
    }
    // A run ends like a session: commit and push what it changed. Sandboxed runtimes (Codex)
    // cannot write .git themselves.
    if (this.config.sync) void this.syncAfterRun(r);
    this.wrapStep(r, { wrap_up: 'done' });
    this.ended(id);
    this.emit('run', r);
  }

  /**
   * The first wrap-up step: once the run's descendants are reaped and its helpers ended, commits
   * what the run left, or says why it does not.
   */
  private async commitStep(r: RunRecord, helpers: string[]): Promise<void> {
    const id = r.id;
    await this.reap(id);
    let timer: NodeJS.Timeout | undefined;
    const helpersEnded =
      helpers.length === 0 ||
      (await Promise.race([
        Promise.all(helpers.map((h) => this.whenEnded(h))).then(() => true),
        new Promise<boolean>((res) => {
          timer = setTimeout(() => res(false), HELPER_END_MS);
        }),
      ]).finally(() => clearTimeout(timer)));
    // Sandboxed runtimes (Codex) cannot commit: what the run left goes to a branch of its own.
    let left: Leftovers | null = null;
    let notCommitted = '';
    const procsLeft = this.store.get(id)?.procs_left ?? 0;
    // A helper's descendants that survived its reap can write as well.
    const helperProcsLeft = helpers.reduce((n, h) => n + (this.store.get(h)?.procs_left ?? 0), 0);
    try {
      if (!helpersEnded) notCommitted = 'helper runs still running';
      else if (procsLeft > 0) notCommitted = `${procsLeft} process(es) of the run still alive`;
      else if (helperProcsLeft > 0) {
        notCommitted = `${helperProcsLeft} process(es) of its helpers still alive`;
      }
      if (notCommitted) {
        // Something the run started may still write: a commit now could miss its work.
        if (this.writesLeftovers(r) && this.leftoverTop(r)) {
          notCommitted = `left changes uncommitted: ${notCommitted}`;
          this.emit('warn', `run ${id}: ${notCommitted}`);
        } else notCommitted = '';
      } else {
        // Every process of the run is gone, so an `index.lock` in its task worktree is one its
        // killed git left; it would fail the commit below and every later run there (AO-0230).
        const top = this.gitTopOf(resolve(r.cwd));
        const shared = this.liveRecords().some(
          (o) => o.id !== r.id && top !== null && insideDir(top, resolve(o.cwd)),
        );
        if (top && !shared && this.writesLeftovers(r) && clearStaleIndexLock(top, this.now(), 0)) {
          this.emit('worktree', `run ${id}: removed the index.lock its git left in ${top}`);
        }
        left = await this.commitLeftovers(r);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notCommitted = `cannot commit what it left in ${r.cwd}: ${msg}`;
      this.emit('warn', `run ${id}: ${notCommitted}`);
    }
    this.wrapStep(r, {
      wrap_up: 'committed',
      leftovers: left ?? undefined,
      not_committed: notCommitted || undefined,
    });
  }

  /** Frees the run's task, or sends it for review with what swarmupd committed. */
  private settleTask(r: RunRecord, ws: Workspace, ref: string, left: Leftovers | null): void {
    const id = r.id;
    this.safe(() => {
      const v = ws.view(ref);
      // Only a claim this clone holds; a claim that lost a race belongs to the winner.
      if (ws.holdsClaim(ref) && (v.status === 'claimed' || v.status === 'in-progress')) {
        if (left && !r.review) {
          try {
            ws.review(ref, leftoverReview(r, left, false), this.reviewerFor(ws, v, r.agent));
            return;
          } catch (err) {
            this.emit('warn', `run ${id}: cannot send ${ref} for review: ${String(err)}`);
          }
        }
        const failure = runFailure(r.log);
        const note = [
          `run ${id} ended (${r.reason}, exit ${r.exit ?? '-'}) without finishing`,
          failureNote(failure),
        ]
          .filter(Boolean)
          .join('\n\n');
        const streak = unfinishedRuns(ws.showEvents(ref).events) + 1;
        if (this.isStuck(r, streak) && this.stopStuck(r, ws, ref, streak, failure)) return;
        ws.release(ref, note);
      } else if (left && !r.review && v.status === 'needs-review') {
        // The run asked for review naming files it could not commit: tell the reviewer where
        // they are now.
        ws.comment(ref, leftoverReview(r, left, true), v.reviewer ?? undefined);
      }
    });
    this.wrapStep(r, { wrap_up: 'settled' });
  }

  /**
   * True when the run is the `stuck_runs`-th in a row to end on its task without finishing. A run
   * a person stopped, and a provider that is paused for a sign-in, a usage limit or failed starts,
   * say nothing about the task: those have their own pause and message.
   */
  private isStuck(r: RunRecord, streak: number): boolean {
    const limit = this.config.stuck_runs;
    if (limit <= 0 || streak < limit || r.review || r.chat) return false;
    if (!['exit', 'budget', 'tokens'].includes(r.reason ?? '')) return false;
    const provider = runtimeOf(r.agent);
    const rc = this.config.runtimes[provider];
    const paused =
      this.signedOutPause(provider, []) ??
      (rc
        ? usagePause(
            provider,
            this.usage[provider],
            rc.pause_at ?? this.config.usage_pause_at,
            this.now(),
          )
        : null) ??
      this.backoffPause(provider);
    return !paused;
  }

  /**
   * Stops a task whose runs keep ending without finishing: blocks it for a PM, with what the
   * last run's log says, instead of freeing it for the next run, and files one finding per kind
   * of failure so the cause is tracked. The block is the run's own act under its claim, like the
   * release it replaces. False when the block fails; the task is then freed as before.
   */
  private stopStuck(
    r: RunRecord,
    ws: Workspace,
    ref: string,
    streak: number,
    failure: RunFailure,
  ): boolean {
    const pm = this.pmFor(ws, r.agent);
    const finding = this.stuckFinding(r, ref, streak, failure, pm);
    const what = failureNote(failure);
    const body = [
      `${ref}: swarmupd stopped starting this task. ${streak} runs of ${r.agent} in a row ended ` +
        `without finishing and with no work on the task; the last was run ${r.id} ` +
        `(${r.reason}, exit ${r.exit ?? '-'}).`,
      [
        what || '- The run log has no error lines.',
        finding ? `- Tracked as ${finding}.` : '',
        `- Log: \`swarmup logs ${r.id}\``,
        `- Decision needed: fix the cause, or hand the task to another agent, then unblock it.`,
      ]
        .filter(Boolean)
        .join('\n'),
    ].join('\n\n');
    try {
      ws.block(ref, body, { to: pm });
    } catch (err) {
      this.emit('warn', `run ${r.id}: cannot block stuck ${ref}: ${String(err)}`);
      return false;
    }
    this.emit(
      'warn',
      `run ${r.id}: ${ref} stopped after ${streak} unfinished runs of ${r.agent}; waits for ${pm ?? 'the human'}`,
    );
    return true;
  }

  /**
   * The PM who hears about a stuck task: a waking, active PM of another provider than the stuck
   * run's, and not signed out, in the PM role's provider order. Never one of the stuck run's own
   * provider, since that provider may be the one that is broken: with none left, undefined, and
   * the block goes to the human.
   */
  private pmFor(ws: Workspace, agent: string): string | undefined {
    const mine = runtimeOf(agent);
    const order = roleLimits(this.config, 'pm').providers;
    const rank = (a: string): number => {
      const i = order.indexOf(runtimeOf(a));
      return i < 0 ? order.length : i;
    };
    return this.wakingAgents()
      .filter((a) => roleOf(a) === 'pm' && runtimeOf(a) !== mine)
      .filter((a) => !roleInactive(ws.agent(a)) && !this.signIn[runtimeOf(a)]?.out)
      .sort((a, b) => rank(a) - rank(b))[0];
  }

  /**
   * Files a finding for the PM on a stuck run's failure, or adds the task to the open finding on
   * the same kind of failure, so one broken sandbox across many tasks is one finding. Returns its
   * id, or undefined when it cannot write it.
   */
  private stuckFinding(
    r: RunRecord,
    ref: string,
    streak: number,
    failure: RunFailure,
    pm: string | undefined,
  ): string | undefined {
    try {
      const ws = this.ws(WATCH_ACTOR);
      const key = failureKey(failure);
      const title = `${r.agent} runs end without finishing: ${key}`;
      const open = ws
        .views()
        .find(
          (v) => v.meta.type === 'finding' && v.meta.title === title && OPEN_STATUSES.has(v.status),
        );
      const line = `${ref}: ${streak} runs in a row, the last run ${r.id}.`;
      if (open) {
        const id = `${open.root}/${open.meta.id}`;
        ws.comment(id, `Also stuck: ${line}`, pm);
        return id;
      }
      const body = [
        `swarmupd stopped a task after ${streak} runs of ${r.agent} in a row ended without ` +
          `finishing and with no work on it. The same failure on other tasks is added here.`,
        [`- ${line}`, failureNote(failure), `- Log: \`swarmup logs ${r.id}\``]
          .filter(Boolean)
          .join('\n'),
        `Triage: find why the runs fail (sandbox, sign-in, tools, prompt), fix it or file the fix, ` +
          `then unblock the stopped tasks.`,
      ].join('\n\n');
      const { meta } = ws.finding({ title, body, owner: pm, priority: 'p1', task: ref });
      return meta.id;
    } catch (err) {
      this.emit('warn', `run ${r.id}: cannot file a finding for stuck ${ref}: ${String(err)}`);
      return undefined;
    }
  }

  /** A run's wrap-up is over: it no longer counts as live, and who waited for it goes on. */
  private ended(id: string): void {
    // What a Codex sandbox session made, the next session cannot replace (AO-0287). The repair
    // starts before the run leaves `ending`, so `repairHold` holds Codex runs with no gap
    // between; a wrap-up that failed gets its repair too.
    const r = this.ending.get(id);
    if (r && runtimeOf(r.agent) === 'codex') void this.repairStores();
    this.ending.delete(id);
    const waiters = this.endWaiters.get(id) ?? [];
    this.endWaiters.delete(id);
    for (const w of waiters) w();
  }

  /** Resolves once the run has ended and finished its wrap-up. */
  private whenEnded(id: string): Promise<void> {
    if (!this.live.has(id) && !this.ending.has(id)) return Promise.resolve();
    return new Promise((res) => {
      const list = this.endWaiters.get(id) ?? [];
      list.push(res);
      this.endWaiters.set(id, list);
    });
  }

  /**
   * A run whose leftovers swarmupd commits: a top-level run of a role that writes, or any other
   * top-level run that started on a clean checkout and so has a start commit (AO-0136).
   */
  private writesLeftovers(r: RunRecord): boolean {
    return !r.parent && (this.writingRun(r) || r.base !== undefined);
  }

  /** True when git reads the checkout `top` and finds no changes outside task stores. */
  private cleanCheckout(top: string): boolean {
    const changes = this.changesIn(top);
    return !(changes instanceof Error) && changes.length === 0;
  }

  /** The git checkout a run's leftovers would be committed in, or null when it has none. */
  private leftoverTop(r: RunRecord): string | null {
    const top = this.gitTopOf(resolve(r.cwd));
    if (!top) return null;
    const co = this.checkout(top);
    return co.isStore ? null : top;
  }

  /**
   * Commits what a top-level run of a role that writes left in its checkout (outside task
   * stores) on a new branch `<runtime>/<task>-<run>` from the commit the run started on, and
   * restores those files there. Null when the run left nothing, as runs that commit themselves
   * do. Rejects when the checkout's HEAD is no longer that commit, or the run has none recorded.
   * Git runs off the event loop, so the API keeps answering while a run wraps up (AO-0205).
   */
  private async commitLeftovers(r: RunRecord): Promise<Leftovers | null> {
    if (!this.writesLeftovers(r)) return null;
    const top = this.gitTopOf(resolve(r.cwd));
    if (!top) return null;
    // Another writing run in the checkout owns changes there too; leave them to a person.
    const other = this.liveRecords().find(
      (o) => o.id !== r.id && this.writingRun(o) && samePath(this.checkoutTop(o.cwd), top),
    );
    if (other) {
      this.emit('warn', `run ${r.id}: ${other.id} works in ${top}; its changes stay uncommitted`);
      return null;
    }
    const co = this.checkout(top);
    let title = `Run ${r.id}`;
    if (r.task && r.root) {
      const ref = `${r.root}/${r.task}`;
      this.safe(() => {
        title = this.ws().view(ref).meta.title;
      });
    }
    const into = await co.branchAsync();
    const commit = await co.commitLeftovers(
      leftoverBranch(runtimeOf(r.agent), r.id, r.task),
      `${title}\n\nChanges left by run ${r.id} (${r.agent}).\n`,
      r.base ?? null,
    );
    return commit ? { ...commit, top, into } : null;
  }

  /**
   * The reviewer to name for what a run left, or undefined to let `ws.review` route it. It routes a
   * task whose type or labels need the person (AO-0173), the delegation's reviewer and the default
   * reviewer of another provider itself; naming one here would skip the person's categories.
   * Without a reviewer role, the first active `qa` agent of another provider, else the person.
   */
  private reviewerFor(ws: Workspace, v: TaskView, author: string): string | undefined {
    if (needsHumanReview(v.meta) || v.delegation?.review || ws.defaultReviewer(author)) {
      return undefined;
    }
    const mine = runtimeOf(author);
    for (const provider of Object.keys(this.config.runtimes)) {
      if (provider === mine) continue;
      const id = `${provider}:qa`;
      if (ws.agent(id)?.status === 'active') return id;
    }
    return undefined;
  }

  /**
   * Queues the commit and push of what a run changed. The run's wrap-up does not wait for it: git
   * runs off the event loop, after any sync already under way.
   */
  private syncAfterRun(r: RunRecord): Promise<void> {
    return this.syncWork(async () => {
      const ws = this.ws();
      const roots = ws.roots.filter((root) => !r.root || root.name === r.root);
      const targets = [
        ...new Set(roots.flatMap((root) => mirrorPartners(root, ws.roots, this.user))),
      ];
      const results = await syncAllAsync(targets, this.user, {
        sessionEnd: true,
        approved: this.approved(),
        now: this.now(),
      });
      for (const { root, result } of results) this.synced(root.name, result);
      // What the run committed to its branch leaves this machine with the sync.
      await this.pushBranches(roots);
    });
  }

  /**
   * Reports a sync and stops live runs whose claim lost to one pushed first from another clone.
   * The run writes nothing more and no release is written: the task belongs to the winner.
   */
  private synced(root: string, res: SyncResult): void {
    this.emit('sync', { root, ...res });
    for (const lost of res.lost) {
      for (const l of [...this.live.values()]) {
        const r = l.record;
        // A claim can lose in a mirror root, reported by its Master Repo's sync.
        if (r.root === (lost.root ?? root) && r.task === lost.task && r.agent === lost.actor) {
          this.emit('warn', `run ${r.id}: ${r.agent} lost the claim on ${lost.task}; stopping it`);
          this.safe(() => this.kill(r.id, 'lost-claim'));
        }
      }
    }
  }

  /** Reads everything the run wrote since the last read, in bounded chunks, and counts tokens. */
  private readLog(l: LiveRun): void {
    let size: number;
    try {
      size = statSync(l.record.log).size;
    } catch {
      return;
    }
    if (size <= l.offset) return;
    const fd = openSync(l.record.log, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size - l.offset, 1024 * 1024));
      while (l.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - l.offset), l.offset);
        if (n <= 0) break;
        l.offset += n;
        l.meter.feed(l.decoder.write(buf.subarray(0, n)));
      }
    } finally {
      closeSync(fd);
    }
    l.record.tokens = l.meter.tokens;
    this.safe(() => this.readUsage(l));
  }

  // ---- Processes -----------------------------------------------------------------------------

  /**
   * Queues process work. The chain never breaks: a failure becomes a `warn`. With `rethrow`, the
   * caller also gets the error.
   */
  private procWork(fn: () => Promise<void>, rethrow = false): Promise<void> {
    const run = this.procChain.then(fn);
    const safe = run.catch((err: unknown) => {
      if (!rethrow) {
        this.emit('warn', `processes: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    this.procChain = safe;
    return rethrow ? run : safe;
  }

  /** Queues sync work: store syncs and branch pushes. A failure becomes a `warn`. */
  private syncWork(fn: () => Promise<void>): Promise<void> {
    const safe = this.syncChain.then(fn).catch((err: unknown) => {
      this.emit('warn', err instanceof Error ? err.message : String(err));
    });
    this.syncChain = safe;
    return safe;
  }

  private procLister(): ProcLister {
    if (this.closed) throw new Error('swarmupd is stopping');
    this.lister ??= this.listerOpt ?? systemLister();
    return this.lister;
  }

  private snapshot(): Promise<ProcInfo[]> {
    try {
      return this.procLister().list();
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** Ledgers need exact creation times; elsewhere swarmupd keeps none (fail closed). */
  private ledgerOn(): boolean {
    return !this.closed && this.procLister().precise;
  }

  /** Kills each entry only if its PID still runs the recorded process at the moment of the kill. */
  private async killVerified(entries: ProcEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const results = await this.procLister().kill(entries);
    applyKills(entries, results, Date.now());
  }

  private ledgerOf(r: RunRecord): ProcLedger {
    const ledger = this.store.procs(r.id);
    if (!ledger) {
      return { run: r.id, root_pid: r.pid, root_start: startMs(r.proc_start), entries: [] };
    }
    // Windows: the launcher takes over from the hidden cmd.exe as the root, so a ledger that
    // never saw it while the shell lived still finds it and what it started.
    if (r.shim_pid !== undefined && ledger.root_pid === r.shim_pid && r.pid !== r.shim_pid) {
      ledger.root_pid = r.pid;
      ledger.root_start = startMs(r.proc_start);
    }
    return ledger;
  }

  /** Adds the processes live runs started since the last look to their ledgers. */
  trackProcs(): Promise<void> {
    return this.procWork(async () => {
      const merge = this.mergeProc;
      if ((this.live.size === 0 && !merge) || !this.ledgerOn()) return;
      // The time before the snapshot: a process it shows alive was alive at that time or later.
      const now = Date.now();
      const snap = await this.snapshot();
      for (const l of [...this.live.values()]) {
        const ledger = this.ledgerOf(l.record);
        track(ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
        this.store.saveProcs(ledger);
      }
      if (merge) this.trackMerge(merge, snap, now);
    });
  }

  /**
   * Adds a merge command's processes from a snapshot to its ledger. The shell joins by PID while
   * the runner still holds it unreaped, so its creation time comes from the snapshot.
   */
  private trackMerge(
    m: { ledger: ProcLedger; running: () => boolean },
    snap: ProcInfo[],
    now: number,
  ): void {
    if (m.ledger.root_start === null && m.running()) {
      m.ledger.root_start = snap.find((p) => p.pid === m.ledger.root_pid)?.start ?? null;
    }
    track(m.ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
  }

  /**
   * Off Windows, where each merge command runs in a job object of its own instead (see
   * `CommandRunner`): follows each merge command's processes in a ledger, like a run's. A stop kills every one of
   * them, checked by creation time, and what a command leaves behind is killed when it exits.
   * What survives every kill is kept in `merge-procs.json`, and no merge or build starts in this
   * or the next swarmupd until it is gone, so a leftover build never races a new one.
   */
  private mergeWatch(): CommandWatch {
    let m: { ledger: ProcLedger; running: () => boolean } | null = null;
    const look = async (): Promise<ProcInfo[] | null> => {
      if (!m || !this.ledgerOn()) return null;
      const now = Date.now();
      const snap = await this.snapshot();
      this.trackMerge(m, snap, now);
      return snap;
    };
    return {
      started: (pid, running) => {
        m = { ledger: { run: 'merge', root_pid: pid, root_start: null, entries: [] }, running };
        this.mergeProc = m;
        void this.procWork(async () => void (await look()));
      },
      stop: () =>
        this.procWork(async () => {
          const snap = await look();
          if (m && snap) await this.killVerified(survivors(m.ledger, snap));
        }),
      ended: () =>
        this.procWork(async () => {
          const ledger = m?.ledger;
          for (let round = 0; ledger; round++) {
            const snap = await look();
            if (!snap) break;
            const left = survivors(ledger, snap);
            if (left.length === 0) break;
            if (round >= REAP_ROUNDS) {
              const list = left.map((e) => `${e.name} ${e.pid}`).join(', ');
              this.emit('warn', `merge: still alive after ${REAP_ROUNDS} kills: ${list}`);
              this.saveMergeLeftovers([...this.mergeLeftovers(), ...left]);
              break;
            }
            await this.killVerified(left);
            await sleep(500);
          }
          if (this.mergeProc === m) this.mergeProc = null;
          m = null;
        }),
    };
  }

  /** Processes merge commands left behind that no kill ended, by PID and creation time. */
  private mergeLeftovers(): ProcEntry[] {
    return this.store.readJson<ProcEntry[]>('merge-procs.json', []);
  }

  private saveMergeLeftovers(left: ProcEntry[]): void {
    this.store.writeJson('merge-procs.json', left);
  }

  /**
   * Looks at the leftovers of earlier merge commands, kills the ones still running and keeps
   * those no kill ends; the next merge starts once none is left.
   */
  private clearMergeLeftovers(): void {
    this.mergeClearing = this.procWork(async () => {
      if (this.closed) return;
      // Without exact creation times no ledger was kept, so nothing can be told apart.
      if (!this.procLister().precise) return this.saveMergeLeftovers([]);
      const ledger: ProcLedger = {
        run: 'merge',
        root_pid: 0,
        root_start: null,
        entries: this.mergeLeftovers(),
      };
      let alive = survivors(ledger, await this.snapshot());
      if (alive.length > 0) {
        await this.killVerified(alive);
        await sleep(500);
        alive = survivors(ledger, await this.snapshot());
      }
      this.saveMergeLeftovers(alive);
      if (alive.length > 0) {
        const list = alive.map((e) => `${e.name} ${e.pid}`).join(', ');
        this.emit('warn', `merge: waiting for what an earlier merge left running: ${list}`);
      }
    }).finally(() => {
      this.mergeClearing = null;
      if (this.mergeLeftovers().length === 0) void this.mergeTick();
    });
  }

  /**
   * Windows: once the launcher reports in, the record names it (PID, image and creation time,
   * read while it waits for the command), and only then does the launcher get the command. An
   * swarmupd that adopts the run later follows a process that outlives this one; if this swarmupd exits
   * first, the launcher starts nothing. A launch that fails here ends the run.
   */
  private async handOver(l: LiveRun, launch: Launch, prompt: string): Promise<void> {
    const r = l.record;
    try {
      const pid = await launch.ready;
      const start = await processStart(pid);
      if (l.launch !== launch) return;
      if (!start) throw new Error(`launcher ${pid} is gone`);
      r.pid = pid;
      r.image = launch.image;
      r.proc_start = start;
      this.store.save(r);
      l.launch = undefined;
      launch.go(prompt);
      // A stop while it launched left this run's handle referenced; it now outlives swarmupd.
      if (this.stopping) l.child?.unref();
      this.emit('run', r);
    } catch (err) {
      if (l.launch !== launch) return;
      this.emit('warn', `run ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      l.killReason ??= 'launch-failed';
      this.abortLaunch(l);
    }
  }

  /** Ends a run whose launcher has not had the command: it exits without starting anything. */
  private abortLaunch(l: LiveRun): void {
    l.launch?.abort();
    l.launch = undefined;
    if (l.child && l.child.exitCode === null) l.child.kill('SIGKILL');
  }

  /**
   * After a run ends: one last look for its processes, including children whose parent already
   * exited, then kill every one still alive, checking each again until none is left or
   * `REAP_ROUNDS` kills failed. Leftovers stay on the run as `procs_left`.
   */
  reap(id: string): Promise<void> {
    return this.procWork(async () => {
      for (let round = 0; ; round++) {
        const r = this.store.get(id);
        if (!r || r.status !== 'ended' || !this.ledgerOn()) return;
        const now = Date.now();
        const snap = await this.snapshot();
        const ledger = this.ledgerOf(r);
        track(ledger, snap, now, this.lister?.ownPids?.() ?? [], this.lister?.clockSlack ?? 0);
        const left = survivors(ledger, snap);
        const give = left.length > 0 && round >= REAP_ROUNDS;
        if (left.length > 0 && !give) await this.killVerified(left);
        this.store.saveProcs(ledger);
        // Only a checked result counts: none left, or what survived every kill round.
        const settled = left.length === 0 || give;
        if (settled && (r.procs_left ?? 0) !== left.length) {
          r.procs_left = left.length || undefined;
          this.store.save(r);
          this.emit('run', r);
        }
        if (left.length === 0) return;
        if (give) {
          const list = left.map((e) => `${e.name} ${e.pid}`).join(', ');
          this.emit('warn', `run ${id}: still alive after ${REAP_ROUNDS} kills: ${list}`);
          return;
        }
        await sleep(500);
      }
    });
  }

  /** At startup: reaps ended runs of the last days whose ledgers still have processes alive. */
  sweep(): Promise<void> {
    const since = Date.now() - SWEEP_DAYS * 24 * 60 * 60_000;
    const due = this.store.list().filter((r) => {
      if (r.status !== 'ended' || Date.parse(r.ended_at ?? r.started_at) < since) return false;
      return this.store.procs(r.id)?.entries.some((e) => !e.gone_at) ?? false;
    });
    return Promise.all(due.map((r) => this.reap(r.id))).then(() => undefined);
  }

  /** The run's processes, each marked alive or not from a fresh snapshot. */
  async procs(id: string): Promise<ProcView[]> {
    const r = this.run(id);
    const snap = await this.snapshot();
    return viewLedger(this.ledgerOf(r), snap);
  }

  /**
   * Kills what an ended run left behind; a live run is stopped with `kill` instead. With `pid`,
   * kills that one ledger process, unsure ones included, after a human checked it.
   */
  async reapNow(id: string, pid?: number): Promise<ProcView[]> {
    const r = this.run(id);
    if (r.status !== 'ended') {
      throw new OpsError(`run ${id} is live: kill the run to stop its processes`);
    }
    if (pid === undefined) {
      await this.reap(id);
      return this.procs(id);
    }
    await this.procWork(async () => {
      const ledger = this.ledgerOf(r);
      const snap = await this.snapshot();
      const hit = survivors(ledger, snap, { unsure: true }).filter((e) => e.pid === pid);
      if (hit.length === 0) throw new OpsError(`no live process ${pid} in run ${id}'s ledger`);
      const results = await this.procLister().kill(hit);
      applyKills(hit, results, Date.now());
      const res = results.get(pid);
      if (res === 'other') throw new OpsError(`PID ${pid} runs another process now; left alone`);
      if (res === 'error') throw new OpsError(`could not kill ${pid}`);
      this.store.saveProcs(ledger);
    }, true);
    return this.procs(id);
  }

  // ---- The loop ------------------------------------------------------------------------------

  /**
   * Picks up runs an earlier swarmupd started that are still alive; the rest are marked lost. Runs
   * that ended under it before their wrap-up was over finish it here.
   */
  adopt(): void {
    const records = this.store.list();
    // In `ending` before any run is adopted, so a parent that turns out to have ended waits for
    // its helpers' wrap-ups.
    const unwrapped = records.filter(
      (r) =>
        r.status === 'ended' &&
        r.wrap_up !== undefined &&
        r.wrap_up !== 'done' &&
        !this.ending.has(r.id),
    );
    for (const r of unwrapped) this.ending.set(r.id, r);
    for (const r of records) {
      if (r.status !== 'running' || this.live.has(r.id)) continue;
      const l: LiveRun = {
        record: r,
        meter: new UsageMeter(),
        offset: 0,
        decoder: new StringDecoder('utf8'),
      };
      this.live.set(r.id, l);
      const same = sameProcess(r);
      if (same === false) this.finish(r.id, null);
      else if (same === 'unknown') void this.recheckAdopted(l);
    }
    for (const r of unwrapped) {
      this.emit('warn', `run ${r.id}: resuming its wrap-up (${r.wrap_up}) after a restart`);
      this.startWrapUp(r, true);
    }
  }

  /**
   * An adopted run whose creation time could not be read at adoption: reads it again without
   * blocking, and ends the run as lost once it shows another process. Until then it counts as the
   * run's; a kill checks the creation time at the moment of the kill either way. `stop` cancels
   * the wait and the pending read, so neither keeps swarmupd from exiting; the next swarmupd checks again.
   */
  private async recheckAdopted(l: LiveRun): Promise<void> {
    const r = l.record;
    const signal = this.stopAbort.signal;
    this.emit(
      'warn',
      `run ${r.id}: could not read the creation time of PID ${r.pid}; checking again`,
    );
    for (let attempt = 0; attempt < ADOPT_RECHECKS; attempt++) {
      if (attempt > 0) await sleepUnless(ADOPT_RECHECK_MS, signal);
      if (this.stopping || this.live.get(r.id) !== l) return;
      const now = await processStart(r.pid, signal);
      if (this.stopping || this.live.get(r.id) !== l) return;
      if (now === r.proc_start) return;
      if (now !== null || !isAlive(r.pid)) {
        this.finish(r.id, null);
        return;
      }
    }
    this.emit('warn', `run ${r.id}: creation time of PID ${r.pid} still unreadable; kept adopted`);
  }

  start(): void {
    this.adopt();
    this.safe(() => this.startSignInChecks());
    this.safe(() => this.chat.resume());
    void this.sweep();
    this.timer = setInterval(() => void this.tick(), this.config.tick_seconds * 1000);
    // Processes are looked at more often than the tick, so short-lived parents are seen.
    this.procTimer = setInterval(() => void this.trackProcs(), this.config.proc_seconds * 1000);
  }

  /**
   * Stops the loop. Runs keep going unless `killRuns`; the next swarmupd adopts them. Where runs
   * cannot outlive swarmupd (`runsOutlive` off), they are stopped like `killRuns`, so they end with
   * their claims released instead of being cut off when this process exits.
   */
  stop(opts: { killRuns?: boolean } = {}): void {
    this.stopping = true;
    this.stopAbort.abort();
    // A merge stops before the base moves; the next swarmupd starts it again.
    this.merging?.runner.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.procTimer) clearInterval(this.procTimer);
    this.procTimer = undefined;
    this.chat.close();
    if (opts.killRuns || !this.runsOutlive) {
      this.killingAll = true;
      for (const id of [...this.live.keys()]) this.kill(id, 'shutdown');
      return;
    }
    // Live runs stay with the next swarmupd: their handles must not keep this process alive, or
    // a stop or restart waits for every run to end. A run still launching keeps its handle
    // until `close` settles it.
    for (const l of this.live.values()) {
      if (l.launch) continue;
      l.child?.unref();
      (l.child?.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    }
  }

  /**
   * Stops accepting launches if no run is live, and says whether it did. Checked and set in one
   * step, so no launch can slip in between; for a shutdown that must not stop agents.
   */
  quiesceIfIdle(): boolean {
    if (this.live.size > 0 || this.ending.size > 0) return false;
    this.stopping = true;
    return true;
  }

  /**
   * After `stop`: waits for killed runs to end (up to 10 s) and for the cleanup of their
   * processes, then closes the process lister. Windows: a run left to the next swarmupd whose
   * launcher has not had its command yet gets up to 5 s to finish launching; after that it ends
   * here, with its claim released, since only a recorded launcher outlives swarmupd.
   */
  async close(): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (this.killingAll && this.live.size > 0 && Date.now() < deadline) await sleep(50);
    const launching = (): LiveRun[] => [...this.live.values()].filter((l) => l.launch);
    const settle = Date.now() + 5_000;
    while (launching().length > 0 && Date.now() < settle) await sleep(50);
    const cut = launching();
    for (const l of cut) {
      l.killReason ??= 'shutdown';
      this.abortLaunch(l);
    }
    const ends = Date.now() + 10_000;
    while (cut.some((l) => this.live.get(l.record.id) === l) && Date.now() < ends) await sleep(50);
    // Ended runs finish their wrap-up: reaping, helpers, the leftover commit, the task events.
    const wrapped = Date.now() + HELPER_END_MS + 10_000;
    while (this.ending.size > 0 && Date.now() < wrapped) await sleep(50);
    // A merge plan under way starts nothing once swarmupd stops; it ends at its next git answer.
    await this.mergePlan;
    await this.merging?.done;
    // A sync or push under way finishes, so no rebase or commit is cut off halfway.
    await this.syncChain;
    await this.procChain;
    // A worktree under way is finished, so git leaves no half-made one behind.
    await Promise.all([...this.makingWorktrees.values()]);
    // A reclaim under way stops at its next worktree; the one git is removing is finished.
    await this.housekeeping;
    // `stop` aborted them; each ends at once.
    await Promise.all([...this.signInRuns]);
    this.closed = true;
    this.lister?.close();
    this.lister = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.trackProcs();
      this.watchRuns();
      this.safe(() => this.writePresences());
      if (this.config.sync) await this.syncRoots();
      // Before the wake plan, so a build swarmupd starts again holds its checkout from this tick.
      await this.mergeTick();
      // After the merge step, which may move a checkout; the rest of the tick runs no await, so
      // the states hold for its launches.
      const states = await this.readCheckouts();
      this.tickStates = states;
      this.dirtyHolds = new Map();
      try {
        this.safe(() => this.signInTick());
        // Before wake, so work handed over from a signed-out provider starts this tick.
        if (!this.stopping) this.safe(() => this.signedOutHandoffs());
        this.runSchedules();
        // Before wake, so a task a repeat creates now can start this tick.
        this.safe(() => this.runRepeats());
        // Before wake: a person waiting for a reply comes before inbox work of the same agent.
        if (!this.stopping) this.safe(() => this.chat.tick());
        // Before wake, so an accepted finding gets its owner and starts in the same tick.
        if (!this.stopping) this.routeOwners();
        this.wake();
      } finally {
        const holds = this.dirtyHolds;
        this.dirtyHolds = null;
        this.safe(() => this.dirtyTick(holds));
        this.tickStates = null;
      }
      this.safe(() => this.notifyTick());
      this.housekeepingTick();
      this.emit('tick');
    } finally {
      this.ticks++;
      this.ticking = false;
    }
  }

  /** This machine's presence in each root it syncs, so other clones see it alive. */
  private writePresences(): void {
    if (!presenceSlug(this.user.machine)) return;
    const live = this.liveRecords();
    const p = {
      machine: this.user.machine!,
      last_seen: new Date(this.now()).toISOString(),
      live_runs: live.length,
      version: this.version,
      build: this.build,
      agents: [...new Set(live.map((r) => r.agent))].sort(),
    };
    for (const root of this.ws().roots) {
      if (root.isMirror) continue;
      writePresence(root, p, undefined, this.now());
    }
  }

  /**
   * Tells the human, once per checkout until it is clean again, that its uncommitted changes
   * hold a writing run while no run works there to commit them (AO-0137). Before, the hold
   * showed only in `swarmup waits` and the app's Waiting list. A checkout with a live or ending run
   * is left alone: the changes may be that run's work, which its wrap-up commits.
   */
  private dirtyTick(holds: Map<string, DirtyHold>): void {
    const told = this.store.readJson<DirtyNotices>('dirty-checkouts.json', {});
    let changed = false;
    // A checkout no run waits on any more is forgotten once clean, so new changes there are news.
    for (const top of Object.keys(told)) {
      if (holds.has(top)) continue;
      const changes = this.changesIn(top);
      if (!(changes instanceof Error) && changes.length === 0) {
        delete told[top];
        changed = true;
      }
    }
    const live = this.liveRecords();
    for (const [top, hold] of holds) {
      if (told[top]) continue;
      if (live.some((r) => r.cwd !== undefined && samePath(this.checkoutTop(r.cwd), top))) continue;
      const ws = this.ws(DIRTY_ACTOR);
      const human = this.user.me ?? ws.roots[0]?.config.human;
      if (!human) continue;
      const what = hold.task ? ` on ${hold.task}` : '';
      const more = hold.count > 1 ? ` and ${hold.count - 1} more` : '';
      const text =
        `${hold.agent} waits to work${what} in ${top}, but that checkout has uncommitted ` +
        `changes and no run works in it: ${hold.file}${more}. Commit, stash or discard them, ` +
        `and writing runs start there again.`;
      try {
        ws.post(DIRTY_CHANNEL, text, { to: [human], task: hold.task });
      } catch (err) {
        // Recorded anyway, so a refused post warns once instead of every tick.
        this.emit('warn', `cannot tell ${human} about the changes in ${top}: ${String(err)}`);
      }
      told[top] = { file: hold.file, at: new Date(this.now()).toISOString() };
      changed = true;
    }
    if (changed) this.store.writeJson('dirty-checkouts.json', told);
  }

  private notifier?: Notifier;

  /** Offers new inbox items for the human and failed runs to the webhook, if one is set. */
  private notifyTick(): void {
    const cfg = this.config.notify;
    if (!cfg.webhook) return;
    this.notifier ??= new Notifier(this.store, (m) => this.emit('warn', m));
    const items: NotifyItem[] = [];
    const me = this.user.me;
    if (me) {
      const ws = this.ws();
      for (const it of ws.inbox(me)) {
        // Asks and reviews come from the task's state: key them by the event that started this
        // round, so a second round on the same task is news too.
        let event = it.event;
        if (!event && (it.kind === 'ask' || it.kind === 'review')) {
          const types = it.kind === 'ask' ? ['ask', 'block'] : ['review'];
          event = [...ws.showEvents(it.task).events]
            .reverse()
            .find((e) => types.includes(e.type))?.id;
        }
        items.push({
          key: `${it.kind}:${it.task}:${event ?? ''}`,
          kind: it.kind,
          line: `${it.task} ${it.kind}: ${it.summary || it.title}`,
        });
      }
    }
    const day = this.now() - 86_400_000;
    for (const r of this.store.list()) {
      if (r.status !== 'ended' || !r.ended_at || Date.parse(r.ended_at) < day) continue;
      const failed =
        (r.reason === 'exit' && r.exit !== 0) ||
        r.reason === 'lost' ||
        r.reason === 'budget' ||
        r.reason === 'tokens';
      if (!failed) continue;
      items.push({
        key: `run:${r.id}`,
        kind: 'run-failed',
        line: `run of ${r.agent}${r.task ? ` on ${r.root}/${r.task}` : ''} ended: ${r.reason === 'exit' ? `exit ${r.exit}` : r.reason}`,
      });
    }
    this.notifier.offer(items, cfg);
    // flush never throws, but nothing a webhook does may reach the tick.
    this.notifier.flush(cfg, this.now()).catch(() => this.emit('warn', 'notify: send failed'));
  }

  /** Sends a sample message to the webhook; the result never holds the URL. */
  async notifyTest(): Promise<{ ok: boolean; error?: string }> {
    const cfg = this.config.notify;
    if (!cfg.webhook) return { ok: false, error: 'no webhook set' };
    let error: string | undefined;
    const n = new Notifier(this.store, (m) => {
      error = m;
    });
    const ok = await n.send(
      cfg.webhook,
      'SwarmUp: test message from swarmupd. Notifications work.',
    );
    return ok ? { ok } : { ok, error };
  }

  private watchRuns(): void {
    const now = this.now();
    for (const [id, l] of [...this.live]) {
      // A helper whose parent is gone (also after a swarmupd restart) ends with it.
      if (l.record.parent && !this.live.has(l.record.parent)) {
        if (!l.killReason) this.safe(() => this.kill(id, 'parent-ended'));
        continue;
      }
      if (!l.child && !isAlive(l.record.pid)) {
        this.finish(id, null);
        continue;
      }
      const before = l.record.tokens;
      this.readLog(l);
      const r = l.record;
      if (now - Date.parse(r.started_at) > r.budget_minutes * 60_000) {
        this.kill(id, 'budget');
        continue;
      }
      if (r.token_budget && r.tokens > r.token_budget) {
        this.kill(id, 'tokens');
        continue;
      }
      if (r.tokens !== before) {
        this.store.save(r);
        this.emit('run', r);
      }
      if (r.task && r.root) this.safe(() => this.renewLease(r, now));
    }
  }

  /** Renews the run's claim when less than half of the lease is left. */
  private renewLease(r: RunRecord, now: number): void {
    const ws = this.ws(r.agent, r.id);
    const ref = `${r.root}/${r.task}`;
    const v = ws.view(ref);
    if (!ws.holdsClaim(ref) || !v.leaseUntil) return;
    const leases = ws.resolve(ref).root.config.leases;
    const full = (v.status === 'claimed' ? leases.claim_minutes : leases.work_minutes) * 60_000;
    if (Date.parse(v.leaseUntil) - now < full / 2) ws.renew(ref, r.id);
  }

  /** Syncs the roots whose pull or push is due, then pushes task branches where a push is. */
  private syncRoots(): Promise<void> {
    const ws = this.ws();
    const pushing: Root[] = [];
    const due = ws.roots.filter((root) => {
      const d = syncDue(root, this.now());
      if (d.push) pushing.push(root);
      return d.pull || d.push;
    });
    if (due.length === 0) return Promise.resolve();
    // A due root brings its mirror partner, so the copy in the Master Repo keeps up.
    const targets = [...new Set(due.flatMap((root) => mirrorPartners(root, ws.roots, this.user)))];
    void this.syncWork(async () => {
      const results = await syncAllAsync(targets, this.user, {
        auto: true,
        approved: this.approved(),
        now: this.now(),
      });
      for (const { root, result } of results) this.synced(root.name, result);
    });
    return this.syncWork(() => this.pushBranches(pushing));
  }

  // ---- Pushing task branches ------------------------------------------------------------------

  /**
   * Pushes the task branches of each repo the roots live in, those with commits no base and no
   * remote branch holds, so unmerged work is not only on this machine. Then deletes the remote
   * branches of merged work whose base the remote has. A repo is skipped when any of its roots
   * has `swarmupd.push_branches.<root>` set to false.
   */
  private async pushBranches(roots: Root[]): Promise<void> {
    const repos = new Map<string, Root[]>();
    // Each root's code checkout: the store's own repo, or `swarmupd.code` (AO-0252).
    for (const root of roots) {
      const top = await this.codeTopAsync(root);
      if (!top) continue;
      const key = [...repos.keys()].find((t) => samePath(t, top)) ?? top;
      repos.set(key, [...(repos.get(key) ?? []), root]);
    }
    if (repos.size === 0) return;
    const state = this.branchState();
    const prefixes = Object.keys(this.config.runtimes).map((r) => `${r}/`);
    for (const [top, inRepo] of repos) {
      if (inRepo.some((r) => this.config.push_branches[r.name] === false)) continue;
      const pusher = new BranchPusher(top, this.commandEnv());
      const head = await pusher.headBranch();
      const bases = [
        ...new Set([
          ...(head ? [head] : []),
          ...inRepo.flatMap((r) => this.config.merge[r.name]?.base ?? []),
        ]),
      ];
      const round = await pusher.pushNew({
        prefixes,
        bases,
        merged: state.merged[top] ?? {},
        seen: state.seen[top] ?? {},
      });
      state.seen[top] = round.seen;
      this.emit('branches', { top, ...round });
      for (const h of round.held) this.emit('warn', `push of ${h.branch}: ${h.why}`);
      if (round.error) this.emit('warn', round.error);
      if (round.remote && !round.error) {
        const remote = round.remote;
        const tracking = await pusher.tips([`refs/remotes/${remote}`]);
        const kept: PendingDelete[] = [];
        for (const d of state.deletes) {
          const baseTip = tracking.get(`refs/remotes/${remote}/${d.base}`);
          if (d.top !== top || !(await this.deleteMerged(pusher, remote, d, baseTip))) kept.push(d);
        }
        state.deletes = kept;
      }
      // Merged tips that are no longer a branch's tip need no remembering. One ref listing
      // answers the common cases, a branch still at its approved tip or gone, without a git call
      // per branch: on Windows each costs about 60 ms (AO-0164).
      const merged = state.merged[top];
      if (merged && Object.keys(merged).length > 0) {
        const tips = await pusher.tips(['refs/heads']);
        for (const [b, approved] of Object.entries(merged)) {
          const tip = tips.get(`refs/heads/${b}`);
          if (tip === approved) continue;
          if (!tip || !(await pusher.isAncestor(tip, approved))) delete merged[b];
        }
      }
    }
    this.store.writeJson('branches.json', state);
  }

  /** Pushes a merged `commit` as `base` from a code checkout with no task store (AO-0252). */
  private async pushBase(ref: string, top: string, base: string, commit: string): Promise<void> {
    const why = await new BranchPusher(top, this.commandEnv()).pushBase(base, commit);
    if (why) this.emit('warn', `merge of ${ref}: ${why}`);
    else this.emit('merge', `${ref}: pushed ${base} (${short(commit)}) from ${top}`);
  }

  /**
   * Deletes the remote branch of work swarmupd merged, once the remote's base has the merged commit.
   * Returns true when the delete is settled: done, not needed, or refused for good. `baseTip` is
   * the remote base's tip from this round's ref listing; while it is the one a round already
   * found without the commit, nothing is asked of git.
   */
  private async deleteMerged(
    pusher: BranchPusher,
    remote: string,
    d: PendingDelete,
    baseTip: string | undefined,
  ): Promise<boolean> {
    if (baseTip && d.remote_tip === baseTip) return false;
    if (!(await pusher.isAncestor(d.commit, `refs/remotes/${remote}/${d.base}`))) {
      if (baseTip) d.remote_tip = baseTip;
      return false;
    }
    try {
      const r = await pusher.deleteRemote(remote, d.branch, d.approved);
      if (r === 'deleted') {
        this.emit('warn', `push: deleted ${remote}/${d.branch}, merged into ${d.base} (${d.ref})`);
      } else if (r !== 'absent') {
        this.emit('warn', `push: ${r} (${d.ref})`);
      }
      return true;
    } catch (err) {
      this.emit('warn', `push: could not delete ${remote}/${d.branch}: ${gitError(err)}`);
      return false;
    }
  }

  /**
   * Remembers commits swarmupd merged into `base` of the repo at `top`, by {@link patchKey}, for
   * {@link approved}. Keys older than {@link APPROVED_DAYS} days go: by then the sync has pushed
   * the commit, or a person has to.
   */
  private approveCommits(top: string, base: string, keys: string[]): void {
    if (keys.length === 0) return;
    const scopes = this.approvedScopes();
    let scope = scopes.find((s) => s.base === base && samePath(s.top, top));
    if (!scope) {
      scope = { top, base, keys: {} };
      scopes.push(scope);
    }
    const at = new Date(this.now()).toISOString();
    for (const k of keys) scope.keys[k] = at;
    this.store.writeJson('approved.json', { scopes } satisfies ApprovedState);
  }

  /**
   * The approvals in `approved.json` younger than {@link APPROVED_DAYS} days, per repo and base.
   * A file without `scopes` (AO-0193's first, unscoped form) approves nothing.
   */
  private approvedScopes(): ApprovedScope[] {
    const s = this.store.readJson<Partial<ApprovedState>>('approved.json', {});
    const now = this.now();
    const out: ApprovedScope[] = [];
    for (const scope of Array.isArray(s.scopes) ? s.scopes : []) {
      if (typeof scope?.top !== 'string' || typeof scope.base !== 'string') continue;
      const keys: Record<string, string> = {};
      for (const [k, at] of Object.entries(scope.keys ?? {})) {
        // An unreadable date is NaN, which fails the test: such a key goes too.
        if (now - Date.parse(at) < APPROVED_DAYS * 86_400_000) keys[k] = at;
      }
      if (Object.keys(keys).length > 0) out.push({ top: scope.top, base: scope.base, keys });
    }
    return out;
  }

  /**
   * For the task store sync, the patch keys of commits swarmupd merged into a branch of a repo: a
   * base that holds merged code is pushed with its store commits instead of held back for good
   * (AO-0193). Read when the sync asks, so expiry and merges since the sync began count.
   */
  private approved(): (top: string, branch: string) => ReadonlySet<string> {
    return (top, branch) =>
      new Set(
        this.approvedScopes()
          .filter((s) => s.base === branch && samePath(s.top, top))
          .flatMap((s) => Object.keys(s.keys)),
      );
  }

  /** What branch pushing keeps between rounds, in `branches.json`. */
  private branchState(): BranchState {
    const s = this.store.readJson<Partial<BranchState>>('branches.json', {});
    return { seen: s.seen ?? {}, merged: s.merged ?? {}, deletes: s.deletes ?? [] };
  }

  /**
   * Remembers a branch swarmupd merged: its approved tip is not pushed again, and its remote branch
   * is deleted once the remote's base has `commit`.
   */
  private branchMerged(
    ref: string,
    rootName: string,
    branch: string,
    approved: string,
    base: string,
    commit: string,
  ): void {
    if (this.config.push_branches[rootName] === false) return;
    // A review that names a base as its branch (`<commit> on branch v2`) merges nothing to clean
    // up: the base's remote branch is never deleted (AO-0193).
    if (branch === base || Object.values(this.config.merge).some((m) => m.base === branch)) return;
    const root = this.ws().roots.find((r) => r.name === rootName);
    const top = root ? this.codeTopOf(root) : null;
    if (!top) return;
    // Queued: a push round under way holds `branches.json` until it ends.
    void this.syncWork(async () => {
      const state = this.branchState();
      state.merged[top] = { ...state.merged[top], [branch]: approved };
      state.deletes = [
        ...state.deletes.filter((d) => d.top !== top || d.branch !== branch),
        { top, branch, approved, base, commit, ref },
      ];
      this.store.writeJson('branches.json', state);
    });
  }

  // ---- Merging approved work ------------------------------------------------------------------

  /**
   * Starts merging one approved task of a root with `swarmupd.merge` set, when no merge runs and no
   * writing run is live in the checkout the base is built in. A task qualifies when its last
   * verdict approves it, came after swarmupd first saw the root's merge setting, has nothing from
   * swarmupd after it, and the review it approved names a branch. Planning asks git which branches
   * and commits exist, off the event loop (AO-0169); a tick that comes meanwhile shares it.
   */
  private mergeTick(): Promise<void> {
    if (this.mergePlan) return this.mergePlan;
    const plan = this.planMerge()
      .catch((err: unknown) => {
        this.emit('warn', `merge: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.mergePlan === plan) this.mergePlan = null;
      });
    this.mergePlan = plan;
    return plan;
  }

  /** Whether merge planning stops: swarmupd stops, or a merge or a leftover cleanup is under way. */
  private mergeHalted(): boolean {
    return !!(this.merging || this.stopping || this.mergeClearing);
  }

  private async planMerge(): Promise<void> {
    if (this.mergeHalted()) return;
    // What an earlier merge command left running goes first, so nothing races it.
    if (this.mergeLeftovers().length > 0) {
      this.clearMergeLeftovers();
      return;
    }
    const merge = this.config.merge;
    // A build an earlier swarmupd stopped after moving a base goes first.
    for (const p of Object.values(this.pendingBuilds())) {
      const cfg = merge[p.root];
      if (!cfg || cfg.base !== p.base) {
        this.dropPendingBuild(p.ref);
        continue;
      }
      if (!this.writerIn(p.top)) {
        this.emit(
          'warn',
          `merge of ${p.ref}: building ${p.base} again; the earlier build did not finish`,
        );
        this.startMerge(
          { ref: p.ref, top: p.top, base: p.base, what: p.what, human: p.human, cfg, holds: true },
          (runner) => this.buildMerged(p, cfg, runner),
        );
      }
      return;
    }
    if (Object.keys(merge).length === 0) return;
    const ws = this.ws();
    const since = this.mergeSince(ws.roots.filter((r) => merge[r.name]).map((r) => r.name));
    const views = ws.views();
    this.freeMergeWaiters(ws, views, since);
    const done = views
      .filter((v) => v.status === 'done' && merge[v.root] && v.updatedAt >= since[v.root]!)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const v of done) {
      const ref = `${v.root}/${v.meta.id}`;
      if (v.lastEvent && this.mergeSeen.get(ref) === v.lastEvent) continue;
      const job = await this.mergeJob(ws, ref, merge[v.root]!, since[v.root]!);
      // A stop, or a merge another way started, while git answered.
      if (this.mergeHalted()) return;
      // A reopen or a newer verdict that came while git answered makes the job stale; the next
      // tick reads the task again.
      const now = this.ws().view(ref);
      if (now.status !== 'done' || now.lastEvent !== v.lastEvent) continue;
      if (!job) {
        if (v.lastEvent) {
          this.mergeSeen.set(ref, v.lastEvent);
          this.mergeNone.set(ref, v.lastEvent);
        }
        continue;
      }
      // The checkout's writing run finishes first; this task waits for the next tick.
      if (this.writerIn(job.top)) continue;
      this.startMerge(
        { ref, top: job.top, base: job.cfg.base, what: job.what, human: job.human, cfg: job.cfg },
        (runner) => this.mergeOne(ref, job, runner),
      );
      return;
    }
  }

  /**
   * Notes on approved tasks that other tasks wait on, and that swarmupd merges nothing for, that
   * no merge comes: a task blocked on approved work waits for the merge event (AO-0228), and
   * without the note it would wait for good with nobody told. An approval from before the root's
   * merge setting (by the time of the verdict, whatever came after it), and reviews whose only `branch <word>` is prose, have nothing to merge: the
   * note frees the waiters. Reviews that name `<commit> on branch <name>` the repo lacks (found
   * by an earlier tick's `mergeJob`) are work that is missing from the base: the waiters stay
   * blocked, and the note tells the human. Once per approval: nothing follows a note, or the
   * note of a merge that failed.
   */
  private freeMergeWaiters(ws: Workspace, views: TaskView[], since: Record<string, string>): void {
    const waited = new Set(ws.mergeWaited());
    if (waited.size === 0) return;
    for (const v of views) {
      const ref = `${v.root}/${v.meta.id}`;
      if (!waited.has(ref) || v.status !== 'done' || !v.awaitsMerge) continue;
      const from = since[v.root];
      if (!from) continue;
      const approval = this.afterApproval(ws, ref);
      // swarmupd wrote about this approval already, say that its merge failed.
      if (approval?.wrote.length !== 0) continue;
      // The approval's own time, as `mergeJob` reads it: a later comment moves `updatedAt`
      // past the merge setting, and the approval is still one swarmupd never merges.
      const before = approval.at < from;
      if (!before && !(v.lastEvent && this.mergeNone.get(ref) === v.lastEvent)) continue;
      const id = v.meta.id;
      const named =
        !before &&
        ws.showEvents(ref).events.some((e) => e.type === 'review' && !!reviewSources(e.body).named);
      if (named) {
        this.mergeNote(
          ref,
          `swarmupd cannot merge ${id}: its review requests name a commit and a branch, and the repo has neither. The tasks blocked on ${id} stay blocked: reopen ${id} to get the work merged, or free each of them with \`swarmup unblock\`.`,
          ws.roots.find((r) => r.name === v.root)?.config.human,
        );
        continue;
      }
      const why = before
        ? `it was approved before swarmupd merged approved work of ${v.root}`
        : 'no review request names a branch or commit';
      this.mergeNothing(
        ref,
        `swarmupd merges nothing for ${id}: ${why}. The tasks blocked on it go on.`,
      );
    }
  }

  /** Whether a top-level writing run is live in the checkout `top`. */
  private writerIn(top: string): boolean {
    return this.liveRecords().some(
      (r) => this.writingRun(r) && samePath(this.checkoutTop(r.cwd), top),
    );
  }

  /**
   * Runs `work` as the merge under way in the checkout `top`; `holds` says whether it holds the
   * checkout from the start, as a build does (see `holdCheckout`).
   */
  private startMerge(
    job: {
      ref: string;
      top: string;
      base: string;
      what: string;
      human: string | undefined;
      cfg: MergeConfig;
      holds?: boolean;
    },
    work: (runner: CommandRunner) => Promise<void | 'again'>,
  ): void {
    const { ref, top, base, what, human } = job;
    const holds = job.holds ?? false;
    const runner = new CommandRunner(this.commandEnv(), {
      watch: this.mergeWatch(),
      now: this.now,
    });
    const startedAt = this.now();
    this.merging = {
      ref,
      top,
      base,
      what,
      runner,
      done: Promise.resolve(),
      holds,
      // A build that holds from the start is all there is of it.
      step: holds ? 'build' : 'rebase',
      startedAt,
      command: null,
      timeoutMs: mergeTimeout(job.cfg),
    };
    const merging = this.merging;
    this.mergeLine(
      ref,
      holds
        ? `builds ${base} again in ${top}; holds it from new writing runs`
        : `starts: ${what} into ${base}, built in ${top}`,
    );
    this.mergeChanged();
    let again = false;
    merging.done = work(runner)
      .then((r) => {
        again = r === 'again';
      })
      .catch((err) => {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        this.emit('warn', `merge of ${ref}: ${msg}`);
        if (err instanceof GitTimeout) {
          // The step it hung in and what it printed last, so the human sees why (AO-0172).
          const output = redactSecrets(err.output);
          const out = lastLines(output);
          const log = this.mergeLog(ref, output);
          const parts = [
            `swarmupd could not merge ${what}: ${firstLines(msg)} (stage: ${err.stage ?? merging.step}).`,
            out ? `Last output:\n\n\`\`\`\n${out}\n\`\`\`` : 'It printed nothing.',
          ];
          if (log) parts.push(`Full output: ${log}`);
          this.mergeNote(ref, parts.join('\n\n'), human);
          return;
        }
        this.mergeNote(ref, `swarmupd could not merge ${what}: ${firstLines(msg)}`, human);
      })
      .finally(() => {
        // The one more merge after a check timed out is for this merge only (AO-0172).
        if (!again) this.mergeTimedOut.delete(ref);
        // A merge that wrote nothing is not tried again until the task changes; one stopped
        // with swarmupd is, by the next swarmupd, and one the PC's sleep broke, by the next tick.
        this.safe(() => {
          const last = this.ws().view(ref).lastEvent;
          if (last && !this.stopping && !again) this.mergeSeen.set(ref, last);
        });
        this.mergeLine(ref, `ends after ${elapsed(this.now() - startedAt)}`);
        this.merging = null;
        this.mergeChanged();
      });
  }

  /**
   * The merge under way, if any: the task, its checkout, and whether it holds the checkout from
   * new writing runs now.
   */
  get merge(): { ref: string; top: string; base: string; holds: boolean } | null {
    if (!this.merging) return null;
    const { ref, top, base, holds } = this.merging;
    return { ref, top, base, holds };
  }

  /** The merge under way, if any, with its step, its command and their times (AO-0161). */
  mergeStatus(): MergeStatus | null {
    const m = this.merging;
    if (!m) return null;
    const iso = (ms: number): string => new Date(ms).toISOString();
    return {
      task: m.ref,
      what: m.what,
      base: m.base,
      top: m.top,
      step: m.step,
      holds: m.holds,
      started_at: iso(m.startedAt),
      ...(m.command
        ? {
            command: {
              text: m.command.text,
              index: m.command.index,
              count: m.command.count,
              started_at: iso(m.command.startedAt),
            },
          }
        : {}),
      timeout_minutes: Math.round(m.timeoutMs / 60_000),
    };
  }

  /** Why a writing run in the checkout `top` waits for the merge under way. */
  private mergeHold(top: string): string {
    return `${this.mergeHoldStart()}${top}; it holds the checkout until its build ends`;
  }

  /** The start of `mergeHold`'s text, which `waits` looks for to mark the work it holds. */
  private mergeHoldStart(): string {
    const m = this.merging;
    return m ? `swarmupd merges ${m.ref} into ${m.base} in ` : '\0';
  }

  /** Moves the merge under way to `step`, and logs it unless it stays the same. */
  private mergeStep(step: MergeStep, line?: string): void {
    const m = this.merging;
    if (!m) return;
    if (m.step !== step && line) this.mergeLine(m.ref, line);
    m.step = step;
    m.command = null;
    this.mergeChanged();
  }

  /**
   * Tells listeners (the API's event stream, so open app windows) that the merge under way
   * started, moved on or ended: `merge-status` carries `mergeStatus()`, null once it ended.
   */
  private mergeChanged(): void {
    this.emit('merge-status', this.mergeStatus());
  }

  /** A line in opsd.log on the merge of `ref` (AO-0161). */
  private mergeLine(ref: string, text: string): void {
    this.emit('merge', `${ref}: ${text}`);
  }

  /**
   * Follows the check or build command of the merge under way: keeps it for `mergeStatus` and
   * logs its start and its result.
   */
  private mergeCommand(kind: 'check' | 'build', s: CommandStep): void {
    const m = this.merging;
    if (!m) return;
    const label = `${kind} ${s.index + 1}/${s.count} \`${s.command}\``;
    if (!s.result) {
      m.command = { text: s.command, index: s.index, count: s.count, startedAt: this.now() };
      const where = kind === 'check' ? "swarmupd's worktree" : m.top;
      const mins = Math.round(m.timeoutMs / 60_000);
      this.mergeLine(m.ref, `${label} starts in ${where}, timeout ${mins} min`);
      this.mergeChanged();
      return;
    }
    const took = m.command ? elapsed(this.now() - m.command.startedAt) : '?';
    const how = s.result.ok ? 'passed' : `failed (${s.result.why ?? 'exit ?'})`;
    this.mergeLine(m.ref, `${label} ${how} after ${took}`);
    m.command = null;
    this.mergeChanged();
  }

  /**
   * Holds the merge's checkout `top` from new writing runs, then waits for any writing run that
   * started there during the checks to end, so the base never moves under it. Returns 'stopped'
   * when swarmupd stops first, 'waited' after a wait, else 'free'.
   */
  private async holdCheckout(ref: string, top: string): Promise<'free' | 'waited' | 'stopped'> {
    if (this.merging && !this.merging.holds) {
      this.merging.holds = true;
      this.mergeLine(ref, `holds ${top} from new writing runs until the build ends`);
      this.mergeChanged();
    }
    let waited = false;
    while (this.writerIn(top)) {
      if (this.stopping) return 'stopped';
      if (!waited) {
        this.mergeStep('waiting');
        this.emit('warn', `merge of ${ref}: waits for the writing run in ${top} to end`);
      }
      waited = true;
      await sleep(MERGE_HOLD_POLL_MS);
    }
    if (this.stopping) return 'stopped';
    return waited ? 'waited' : 'free';
  }

  /**
   * Resolves once the merge under way, if any, is over; and first, a look at what earlier merge
   * commands left running, with the merge it lets start.
   */
  async mergeSettled(): Promise<void> {
    await this.mergeClearing;
    await this.mergePlan;
    await this.merging?.done;
  }

  /** When swarmupd first saw each root's merge setting; only verdicts after it are merged. */
  private mergeSince(roots: string[]): Record<string, string> {
    const since = this.store.readJson<Record<string, string>>('merge.json', {});
    let changed = false;
    for (const r of roots) {
      if (since[r]) continue;
      since[r] = new Date(this.now()).toISOString();
      changed = true;
    }
    if (changed) this.store.writeJson('merge.json', since);
    return since;
  }

  /** What merging `ref` takes, or null when the task has nothing for swarmupd to merge. */
  private async mergeJob(
    ws: Workspace,
    ref: string,
    cfg: MergeConfig,
    since: string,
  ): Promise<MergeJob | null> {
    const { events } = ws.showEvents(ref);
    let at = events.length - 1;
    while (at >= 0 && events[at]!.type !== 'verdict') at--;
    const verdict = events[at];
    if (!verdict || verdict.verdict !== 'approve' || verdict.actor === MERGE_ACTOR) return null;
    if (verdict.at < since) return null;
    if (events.slice(at + 1).some((e) => e.actor === MERGE_ACTOR)) return null;
    const reviews = events
      .slice(0, at)
      .reverse()
      .filter((e) => e.type === 'review');
    const review = reviews[0];
    if (!review) return null;
    const root = ws.resolve(ref).root;
    const top = cfg.checkout ? resolve(cfg.checkout) : this.codeTopOf(root);
    if (!top) return null;
    const repo = new MergeRepo(top, '', [], this.commandEnv());
    const texts = reviews.map((e) => e.body);
    // A first pass that finds nothing lists every commit the pick may ask about; git answers
    // them off the event loop, and the second pass picks from the answers.
    const commits = new Set<string>();
    pickMergeSource(texts, {
      branch: () => false,
      commit: (sha) => {
        commits.add(sha);
        return false;
      },
    });
    // Each git answer may come after a stop; planning then ends there, not after every probe.
    const branches = await repo.branches();
    if (this.mergeHalted()) return null;
    const found = new Set<string>();
    for (const sha of commits) {
      if (await repo.hasCommit(sha)) found.add(sha);
      if (this.mergeHalted()) return null;
    }
    const src = pickMergeSource(texts, {
      branch: (name) => branches.has(name),
      commit: (sha) => found.has(sha),
    });
    if (!src) return null;
    const what = src.commit
      ? `${src.commit} on branch ${src.branch}`
      : `branch ${src.branch ?? '?'}`;
    const v = ws.view(ref);
    const author = v.owner && !v.owner.includes('*') ? v.owner : review.actor;
    return { cfg, top, src, what, author, human: root.config.human, root: root.name };
  }

  /**
   * Rebases the approved commit onto the base in swarmupd's worktree, runs the checks there, moves
   * the base forward, and builds it in its checkout. A conflict or a failed check sends the
   * task back to its author; nothing is ever forced. When the base moved in the meantime (a
   * task store sync, say), the rebase runs again, and the checks too unless only task store
   * files changed.
   */
  private async mergeOne(
    ref: string,
    job: MergeJob,
    runner: CommandRunner,
  ): Promise<void | 'again'> {
    const { cfg, top, src } = job;
    const repo = new MergeRepo(
      top,
      join(this.store.dir, 'merge', job.root.replace(/[^A-Za-z0-9._-]/g, '-')),
      this.ws().roots.map((r) => r.dir),
      this.commandEnv(),
      this.mergeGitTimeoutMs,
    );
    const source = src.commit
      ? await repo.commit(src.commit)
      : src.branch
        ? ((await repo.commit(`refs/heads/${src.branch}`)) ?? (await repo.commit(src.branch)))
        : null;
    if (!source) {
      const missing = src.commit ? `commit ${src.commit}` : `branch ${src.branch}`;
      this.mergeNote(
        ref,
        `swarmupd cannot merge ${job.what}: ${missing} is not in ${top}`,
        job.human,
      );
      return;
    }
    if (!(await repo.commit(`refs/heads/${cfg.base}`))) {
      this.mergeNote(
        ref,
        `swarmupd cannot merge ${job.what}: no branch ${cfg.base} in ${top}`,
        job.human,
      );
      return;
    }
    const timeout = mergeTimeout(cfg);
    let checked: string | null = null;
    let checks: CommandResult[] = [];
    let merged: { head: string; onto: string } | null = null;
    let refused = '';
    let waited = false;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS && !merged; attempt++) {
      if (attempt > 0) await sleep(MERGE_RETRY_MS);
      if (this.stopping) return;
      const onto = (await repo.commit(`refs/heads/${cfg.base}`))!;
      this.mergeStep('rebase', `rebases onto ${cfg.base} (${short(onto)}) again`);
      await repo.ensureWorktree(onto);
      const r = await repo.rebase(source, onto);
      if ('conflict' in r) {
        this.mergeBack(
          ref,
          job.what,
          job.author,
          `it does not rebase onto ${cfg.base} (${short(onto)})`,
          r.conflict,
        );
        return;
      }
      if (r.head === onto) {
        this.mergeRecord(
          { ref, base: cfg.base, branch: src.branch, commit: onto },
          `${job.what} is already in ${cfg.base}; nothing to merge.`,
        );
        if (src.branch) {
          this.safe(() => this.branchMerged(ref, job.root, src.branch!, source, cfg.base, onto));
        }
        return;
      }
      // Task store files on a branch would overwrite the live store in the checkout.
      const store = await repo.storeFiles(onto, r.head);
      if (store.length > 0) {
        const more = store.length > 3 ? ` and ${store.length - 3} more` : '';
        this.mergeBack(
          ref,
          job.what,
          job.author,
          `it changes task store files (${store.slice(0, 3).join(', ')}${more}); take them out of the branch`,
          '',
        );
        return;
      }
      if (!checked || !(await repo.sameCode(checked, r.head))) {
        // The checks run in swarmupd's worktree: writing runs in the checkout go on meanwhile.
        if (this.merging) this.merging.holds = false;
        this.mergeStep('checks');
        checks = await runner.runAll(cfg.checks ?? [], repo.worktree, timeout, (s) =>
          this.mergeCommand('check', s),
        );
        const failed = checks.find((c) => !c.ok);
        // Stopped with swarmupd: the next swarmupd merges it from the start.
        if (failed?.why === 'stopped') return;
        // The PC slept during the checks: the next tick merges it from the start (AO-0151).
        if (failed?.interrupted) {
          this.emit(
            'warn',
            `merge of ${ref}: \`${failed.command}\` failed (${failed.why}) after the PC slept or swarmupd stopped responding; merging again`,
          );
          return 'again';
        }
        // A check that hangs may be the machine, not the code: merged again once (AO-0172).
        if (failed?.timedOut && !this.mergeTimedOut.has(ref)) {
          this.mergeTimedOut.add(ref);
          this.emit(
            'warn',
            `merge of ${ref}: \`${failed.command}\` ${failed.why}; swarmupd stopped it and merges once more`,
          );
          return 'again';
        }
        if (failed) {
          this.mergeBack(
            ref,
            job.what,
            job.author,
            `\`${failed.command}\` failed (${failed.why}) on it rebased onto ${cfg.base} (${short(onto)})`,
            failed.output,
          );
          return;
        }
        checked = r.head;
      }
      // Moving the base changes the checkout: from here until the build is over, it is held.
      const hold = await this.holdCheckout(ref, top);
      if (hold === 'stopped') return;
      if (hold === 'waited' && !waited) {
        // The base likely moved during the wait (task store syncs): rebase onto it again, without
        // counting the wait as a failed attempt. New writing runs wait now, so this happens once.
        waited = true;
        if ((await repo.commit(`refs/heads/${cfg.base}`)) !== onto) {
          attempt--;
          continue;
        }
      }
      // Recorded before the base moves, so no task store sync sees the merged commits unapproved.
      this.approveCommits(top, cfg.base, await repo.patchKeys(onto, r.head));
      try {
        if ((await repo.fastForward(cfg.base, onto, r.head)) === 'done')
          merged = { head: r.head, onto };
        else refused = `${cfg.base} kept moving`;
      } catch (err) {
        // A hung git is not tried again while the checkout stays held (AO-0172).
        if (err instanceof GitTimeout) {
          err.stage = 'fast-forward';
          throw err;
        }
        // Local changes in the way, or a lock another git command holds: tried again shortly.
        refused = firstLines(err instanceof Error ? err.message : String(err));
      }
    }
    if (!merged) {
      const why = `${cfg.base} did not move: ${refused}`;
      this.mergeNote(ref, `swarmupd could not merge ${job.what}; ${why}`, job.human);
      return;
    }
    if (src.branch) {
      const { branch } = src;
      const { head } = merged;
      this.safe(() => this.branchMerged(ref, job.root, branch, source, cfg.base, head));
    }
    // A code checkout with no task store (`swarmupd.code`) has no store sync to push its base, so the
    // merged commit is pushed here (AO-0252). A `merge.checkout` without `swarmupd.code` is left as
    // it was: nothing pushed its base before.
    if (
      this.config.code[job.root] &&
      !this.holdsStore(top) &&
      this.config.push_branches[job.root] !== false
    ) {
      const head = merged.head;
      void this.syncWork(() => this.pushBase(ref, top, cfg.base, head));
    }
    const changed = await repo.changedFiles(merged.onto, merged.head);
    const files = changed.length;
    const installDirs = lockfileDirs(changed);
    const opsdCode = isEngineRepo(top) ? opsdCodeChanges(changed) : [];
    const passed =
      checks.length > 0
        ? ` Checks passed: ${checks.map((c) => `\`${c.command}\``).join(', ')}.`
        : '';
    // Saved before the build, so a swarmupd that stops during it leaves the build to the next one.
    const pending: PendingBuild = {
      ref,
      root: job.root,
      top,
      base: cfg.base,
      branch: src.branch,
      commit: merged.head,
      what: job.what,
      author: job.author,
      human: job.human,
      ...(opsdCode.length > 0 ? { opsdCode } : {}),
      ...(installDirs.length > 0 ? { install: installDirs } : {}),
      text: `Merged ${job.what} into ${cfg.base} as ${short(merged.head)}, rebased onto ${short(merged.onto)} (${files} file(s)).${passed}`,
    };
    this.savePendingBuild(pending);
    await this.buildMerged(pending, cfg, runner);
  }

  /**
   * Runs the build of a base swarmupd moved forward, in its checkout, and records the merge with the
   * build's result. A failed build sends the task back. A build stopped with swarmupd stays pending:
   * the merge is recorded now, and the next swarmupd runs the build again and comments on the result.
   */
  private async buildMerged(
    p: PendingBuild,
    cfg: MergeConfig,
    runner: CommandRunner,
  ): Promise<void> {
    const timeout = mergeTimeout(cfg);
    this.mergeStep('build', `moved ${p.base} to ${short(p.commit)}; builds it in ${p.top}`);
    // The checks installed new dependencies in swarmupd's worktree only; the checkout gets them here.
    const steps = cfg.build ?? [];
    const dirs = p.install === true ? ['.'] : (p.install ?? []);
    const install = steps.length > 0 ? installSteps(cfg.install, p.top, dirs) : [];
    let build = await runner.runAll([...install, ...steps], p.top, timeout, (s) =>
      this.mergeCommand('build', s),
    );
    let installs = install.length;
    // An install step with nothing to do leaves no result (AO-0229), so a result's place in the
    // list it came from, not in `build`, tells an install from a build step.
    const isInstall = (c: CommandResult): boolean => (c.entry ?? build.indexOf(c)) < installs;
    let broke = build.find((c) => !c.ok);
    // A build step that fails in a checkout swarmupd did not install in may only miss its
    // dependencies: `node_modules` gone, behind a lockfile another commit changed, or in the
    // middle of someone's install. The checks passed on this code, so the checkout gets one
    // install and the build one more try before anyone hears of it (AO-0232).
    let first: CommandResult | null = null;
    const again = dirs.includes('.') ? [] : installSteps(cfg.install, p.top, ['.']);
    if (
      broke &&
      !isInstall(broke) &&
      broke.why !== 'stopped' &&
      !broke.interrupted &&
      again.length > 0
    ) {
      first = broke;
      this.emit(
        'warn',
        `merge of ${p.ref}: build \`${broke.command}\` failed (${broke.why}) in ${p.top}; swarmupd installs the dependencies there and builds once more`,
      );
      build = await runner.runAll([...again, ...steps], p.top, timeout, (s) =>
        this.mergeCommand('build', s),
      );
      installs = again.length;
      broke = build.find((c) => !c.ok);
    }
    // Stopped with swarmupd, or broken by the PC's sleep: the build stays pending, and the next swarmupd,
    // or for a sleep the next tick, runs it again.
    if (broke?.why === 'stopped' || broke?.interrupted) {
      const why =
        broke.why === 'stopped'
          ? 'was stopped with swarmupd; the next swarmupd runs the build again'
          : `failed (${broke.why}) after the PC slept or swarmupd stopped responding; swarmupd runs the build again`;
      if (p.text !== null) {
        this.mergeRecord(p, `${p.text} Build: \`${broke.command}\` ${why}.`);
        this.savePendingBuild({ ...p, text: null });
      } else if (broke.interrupted) {
        this.emit('warn', `merge of ${p.ref}: build \`${broke.command}\` ${why}`);
      }
      return;
    }
    const commands = build.map((c) => `\`${c.command}\``).join(', ');
    if (p.text !== null) {
      const built =
        build.length === 0
          ? ''
          : broke
            ? ` Build: \`${broke.command}\` failed (${broke.why}).`
            : first
              ? ` Built with ${commands}, after \`${first.command}\` failed (${first.why}) before the install.`
              : ` Built with ${commands}.`;
      this.mergeRecord(p, `${p.text}${built}`);
    } else if (!broke && build.length > 0) {
      this.mergeNote(
        p.ref,
        `Built ${p.base} with ${commands} after the earlier build did not finish (${short(p.commit)}).`,
      );
    }
    this.dropPendingBuild(p.ref);
    // Once per merge: a build stopped with swarmupd returned above, and the next swarmupd tells.
    this.tellNotLive(p, build.length > 0 && !broke);
    if (!broke) return;
    // A failed install says nothing about the merged code: the human hears of it, and the task
    // stays closed (AO-0232).
    if (isInstall(broke)) {
      this.mergeEnvFailure(p, broke);
      return;
    }
    const retried = first ? ', also after swarmupd installed the dependencies there' : '';
    this.mergeBack(
      p.ref,
      p.what,
      p.author,
      `${p.base} has it as ${short(p.commit)}, but \`${broke.command}\` failed (${broke.why}) in ${p.top}${retried}; fix it in a new commit`,
      broke.output,
    );
  }

  /**
   * Tells the human that the checkout of a merged base could not get its dependencies, so its
   * build did not run. The merge stands and the task keeps its state: the author has nothing to
   * fix. The output goes to a log file, without lines that look like secrets.
   */
  private mergeEnvFailure(p: PendingBuild, broke: CommandResult): void {
    this.safe(() => {
      const ws = this.ws(MERGE_ACTOR);
      const human = this.user.me ?? p.human ?? ws.roots[0]?.config.human;
      const safe = redactSecrets(broke.output);
      const log = this.mergeLog(p.ref, safe);
      const out = lastLines(safe);
      const head =
        `${ws.resolve(p.ref).id}: swarmupd merged ${p.what} into \`${p.base}\` as ${short(p.commit)}, ` +
        `but could not install the dependencies in \`${p.top}\`: \`${broke.command}\` failed ` +
        `(${broke.why}), so the build there did not run. This is the checkout, not the merged ` +
        'code: the task stays as it is.';
      const tail =
        `Action: once no other install runs in \`${p.top}\`, install the dependencies and run ` +
        `the build there.${log ? ` Full output: ${log}` : ''}`;
      const fence = '```';
      ws.comment(
        p.ref,
        out ? `${head}\n\n${fence}\n${out}\n${fence}\n\n${tail}` : `${head} ${tail}`,
        human,
      );
    });
  }

  /** Builds an earlier swarmupd left pending, by task. */
  private pendingBuilds(): Record<string, PendingBuild> {
    return this.store.readJson<Record<string, PendingBuild>>('merge-builds.json', {});
  }

  private savePendingBuild(p: PendingBuild): void {
    this.store.writeJson('merge-builds.json', { ...this.pendingBuilds(), [p.ref]: p });
  }

  private dropPendingBuild(ref: string): void {
    const all = this.pendingBuilds();
    if (!(ref in all)) return;
    delete all[ref];
    this.store.writeJson('merge-builds.json', all);
  }

  /** The merge event, with the commit the base moved to. */
  private mergeRecord(
    p: { ref: string; base: string; branch?: string; commit: string },
    text: string,
  ): void {
    this.ws(MERGE_ACTOR).recordMerge(
      p.ref,
      { commit: p.commit, into: p.base, branch: p.branch },
      text,
    );
  }

  /**
   * Sends the task back to its author with what failed and the end of its output. Lines that look
   * like secrets are taken out of the output before it is kept anywhere, log file included.
   */
  private mergeBack(ref: string, what: string, author: string, why: string, output: string): void {
    const safe = redactSecrets(output);
    const log = this.mergeLog(ref, safe);
    const head = `swarmupd did not merge ${what}: ${why}.`;
    const tail = `Fix it on the branch and ask for review again.${log ? ` Full output: ${log}` : ''}`;
    const out = lastLines(safe);
    this.ws(MERGE_ACTOR).sendBack(
      ref,
      out ? `${head}\n\n\`\`\`\n${out}\n\`\`\`\n\n${tail}` : `${head} ${tail}`,
      author,
    );
  }

  /**
   * Tells the human once, after a merge into the engine repo changed swarmupd's own code, that this
   * swarmupd does not run it yet and what makes it live: a restart when swarmupd runs from the checkout
   * that was just built, a build first when it was not, or a new build of the app when swarmupd runs
   * the installed app (AO-0156).
   */
  private tellNotLive(p: PendingBuild, built: boolean): void {
    if (!p.opsdCode?.length) return;
    this.safe(() => {
      const ws = this.ws(MERGE_ACTOR);
      const human = this.user.me ?? p.human ?? ws.roots[0]?.config.human;
      if (!human) return;
      const self = this.self;
      const runs = !self ? 'unknown' : insideDir(p.top, self.dir) ? 'checkout' : 'installed';
      let fresh = false;
      if (runs === 'checkout' && built) {
        try {
          fresh = self!.stamp() !== this.build;
        } catch {
          // Unreadable: the notice says to build first, which is never wrong.
        }
      }
      const text = notLiveNotice({
        task: ws.resolve(p.ref).id,
        what: p.what,
        base: p.base,
        commit: p.commit,
        files: p.opsdCode!,
        top: p.top,
        runs,
        built: fresh,
        pid: process.pid,
        version: this.version,
      });
      ws.post(DIRTY_CHANNEL, text, { to: [human], task: p.ref });
    });
  }

  /**
   * A comment from swarmupd on a merge it did not do, for a person. The work is still not in the
   * base, so the tasks blocked on `ref` keep waiting (AO-0228).
   */
  private mergeNote(ref: string, text: string, to?: string): void {
    this.safe(() => this.ws(MERGE_ACTOR).comment(ref, text, to));
  }

  /** A comment from swarmupd that it has nothing to merge for `ref`; tasks blocked on it go on. */
  private mergeNothing(ref: string, text: string): void {
    this.safe(() => this.ws(MERGE_ACTOR).noMerge(ref, text));
  }

  /** Keeps a merge's whole output, already without secrets, in swarmupd's state folder; returns the file, or null. */
  private mergeLog(ref: string, output: string): string | null {
    if (!output) return null;
    try {
      const dir = join(this.store.dir, 'merge', 'logs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${ref.replace(/[^A-Za-z0-9._-]/g, '-')}-${ulid(this.now())}.log`);
      writeFileSync(file, output);
      return file;
    } catch {
      return null;
    }
  }

  /**
   * The environment merge commands run with: swarmupd's, without any run's identity. As for an
   * agent run (`runEnv`), without the desktop app's host flags and its `SWARMUP_DAEMON_ENTRY`: a
   * check that starts swarmupd (this repo's own tests) must start its checkout's build, not the
   * installed app's (AO-0235).
   */
  private commandEnv(): NodeJS.ProcessEnv {
    const env = runEnv(this.env, {});
    deleteEnvVars(env, ['AGENT', 'RUN', 'PARENT_RUN', 'ROOTS']);
    return env;
  }

  /**
   * Creates the tasks of due repeats (AO-0142). Paused swarmupd creates none; on resume or the next
   * start each repeat fires once for the latest slot it missed.
   */
  private runRepeats(): void {
    if (!this.config.repeats || this.config.paused || this.stopping) return;
    const fired = this.ws().fireRepeats();
    if (fired.length > 0) this.emit('repeats', fired);
  }

  private runSchedules(): void {
    if (this.config.schedules.length === 0) return;
    const last = this.store.readJson<Record<string, number>>('schedules.json', {});
    const now = this.now();
    let changed = false;
    for (const s of this.config.schedules) {
      if (s.paused || !scheduleDue(s, last[s.name], now)) continue;
      this.safe(() => {
        const ws = this.ws(s.agent);
        if (this.scheduleBlocker(ws, s)) return;
        if (s.task && this.liveRecords().some((r) => r.task === ws.resolve(s.task!).id)) return;
        this.launch({
          agent: s.agent,
          task: s.task,
          extra: s.prompt || undefined,
          schedule: s.name,
        });
        // Recorded only after the launch worked, so a failed launch is retried next tick.
        last[s.name] = now;
        changed = true;
      });
    }
    if (changed) this.store.writeJson('schedules.json', last);
  }

  /**
   * Bottleneck first: reviews; then tasks that resume after an answer or a change request; then
   * new claims; last, runs that only read an inbox, since they name no work. Within each,
   * priority, then the project with the fewest live runs, then age.
   */
  private sortCandidates(pending: WakeCandidate[], live: PlannedRun[]): void {
    // Someone waits for a question's answer, as for resumed work.
    const rank = (c: WakeCandidate): number =>
      c.kind === 'review' ? 0 : c.kind === 'task' ? (c.resume || c.question ? 1 : 2) : 3;
    const order: Record<Priority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };
    const liveIn = (project: string): number =>
      live.filter((r) => !r.question && (r.project ?? r.root) === project).length;
    pending.sort(
      (x, y) =>
        rank(x) - rank(y) ||
        (order[x.priority] ?? 9) - (order[y.priority] ?? 9) ||
        liveIn(x.project) - liveIn(y.project) ||
        (x.created < y.created ? -1 : x.created > y.created ? 1 : 0),
    );
  }

  /**
   * Tasks in a project that wait for review by an agent swarmupd runs. Reviews that wait for a
   * person, or for an agent with no swarmupd entry, do not load the agent reviewers; counting them
   * held every writer until the person reviewed (AO-0094).
   */
  private reviewBacklog(views: TaskView[], project: string): number {
    const agents = Object.keys(this.config.agents);
    return views.filter(
      (v) =>
        v.status === 'needs-review' &&
        (v.meta.project ?? v.root) === project &&
        v.reviewer !== null &&
        !isHuman(v.reviewer) &&
        agents.some((a) => ownerMatches(v.reviewer, a)),
    ).length;
  }

  private wakingAgents(): string[] {
    return Object.entries(this.config.agents)
      .filter(([, c]) => c.wake)
      .map(([a]) => a);
  }

  /**
   * The routes `routeOwners` writes: ownerless work and the role group that wakes for it. Uses
   * the role limits `wakeCandidates` filters by, so a routed task has an agent it may start.
   */
  private plannedRoutes(ws: Workspace = this.ws()): Route[] {
    const waking = this.wakingAgents().filter((a) => !roleInactive(ws.agent(a)));
    return ws.routes(waking, (a) => roleLimits(this.config, roleOf(a)));
  }

  /**
   * Gives each open task without a working owner a role group from its type and labels (AO-0140):
   * a finding a person accepted, or work whose owner no configured agent answers to. Recorded as
   * an `assign` event from `ROUTE_ACTOR` with the reason.
   */
  private routeOwners(): void {
    this.safe(() => {
      const ws = this.ws(ROUTE_ACTOR);
      for (const r of this.plannedRoutes(ws)) {
        if (r.blocker) continue;
        this.safe(() => ws.route(`${r.view.root}/${r.view.meta.id}`, r.to, r.reason));
      }
    });
  }

  /**
   * What the waking agents could start now: review requests (one run each, no claim), new inbox
   * items an agent was not started for (one run per agent), and claimable tasks (one candidate
   * per task). A task more than one agent may take (owned by `*:<role>` or by nobody) lists its
   * agents in the role's provider order.
   */
  private wakeCandidates(
    agents: string[],
    reviewed: Record<string, string[]>,
    state: Record<string, WakeState>,
    inboxItems: Map<string, InboxKey[]> = new Map(),
  ): WakeCandidate[] {
    const byTask = new Map<string, WakeCandidate>();
    const now = this.now();
    // Every task read once for all agents: each inbox and queue read them all again (AO-0171).
    const views = this.ws().snapshot();
    // The session outside swarmupd that worked on a task last, read once per task.
    const outside = new Map<string, OutsideSession | null>();
    const outsideOf = (ws: Workspace, ref: string, events?: OpsEvent[]): OutsideSession | null => {
      let found = outside.get(ref);
      if (found === undefined) {
        try {
          const { root, id } = ws.resolve(ref);
          found = outsideSession(events ?? ws.showEvents(ref).events, root.claimRecord(id));
        } catch {
          // Not a task: a channel or a vote.
          found = null;
        }
        outside.set(ref, found);
      }
      return found;
    };
    for (const agent of agents) {
      this.safe(() => {
        const ws = this.ws(agent);
        const inbox = ws.inbox(agent, { views });
        for (const item of inbox) {
          if (item.kind !== 'review') continue;
          const v = ws.view(item.task);
          if (v.status !== 'needs-review' || !ownerMatches(v.reviewer, agent)) continue;
          const ref = `${v.root}/${v.meta.id}`;
          // Keyed by the review request itself, so a later request after changes gets a run too.
          const request = [...ws.showEvents(ref).events].reverse().find((e) => e.type === 'review');
          const key = `${ref}:${request?.id ?? item.event ?? ''}`;
          if (reviewed[agent]?.includes(key)) continue;
          byTask.set(`review:${ref}`, {
            kind: 'review',
            ref,
            root: v.root,
            id: v.meta.id,
            project: v.meta.project ?? v.root,
            title: v.meta.title,
            priority: v.meta.priority,
            created: v.meta.created_at,
            key,
            agents: [agent],
          });
        }
        // Mentions of the chat agent continue the chat instead of waking an inbox run.
        const chatMentions = this.config.chat.mentions && agent === this.config.chat.agent;
        const items = inbox
          .filter((i) => i.kind !== 'review' && !(chatMentions && i.kind === 'mention'))
          .map((i) => ({
            key: `${i.task}:${i.event ?? i.kind}`,
            root: i.root,
            id: i.task.split('/').pop() ?? i.task,
          }));
        inboxItems.set(agent, items);
        const keys = items.map((i) => i.key);
        const prev = state[agent] ?? { keys: [], at: 0 };
        // An item about a task that a session outside swarmupd may still work on wakes no inbox
        // run either: that run would take the task up beside the session (AO-0236).
        const fresh = items
          .filter((i) => {
            const s = outsideOf(ws, `${i.root}/${i.id}`);
            return !(s && this.outsideHold(s));
          })
          .map((i) => i.key)
          .filter((k) => !prev.keys.includes(k));
        const cooled = now - prev.at >= this.config.wake_cooldown_minutes * 60_000;
        if (fresh.length > 0 && cooled) {
          byTask.set(`inbox:${agent}`, {
            kind: 'inbox',
            project: this.projectOf(ws),
            title: `${fresh.length} new inbox item(s) for ${agent}`,
            priority: 'p1',
            created: '',
            keys,
            agents: [agent],
          });
        }
        for (const v of ws.queue(agent, { views })) {
          const ref = `${v.root}/${v.meta.id}`;
          const events = ws.showEvents(ref).events;
          // Work that comes back after an answer or a change request finishes before new work.
          const last = [...events]
            .reverse()
            .find((e) =>
              ['answer', 'verdict', 'unblock', 'claim', 'release', 'handoff', 'delegate'].includes(
                e.type,
              ),
            );
          const resume =
            last?.type === 'answer' ||
            last?.type === 'unblock' ||
            (last?.type === 'verdict' && last.verdict === 'changes');
          const c = byTask.get(ref) ?? {
            kind: 'task' as const,
            resume,
            ref,
            root: v.root,
            id: v.meta.id,
            project: v.meta.project ?? v.root,
            title: v.meta.title,
            priority: v.meta.priority,
            created: v.meta.created_at,
            owner: v.owner ?? null,
            avoid: v.delegation?.review,
            question: v.meta.type === QUESTION_TYPE || undefined,
            type: v.meta.type,
            outside: outsideOf(ws, ref, events) ?? undefined,
            agents: [],
          };
          c.agents.push(agent);
          byTask.set(ref, c);
        }
      });
    }
    for (const c of byTask.values()) {
      // A task owned by one agent, or by one provider (`claude:*`), stays with it.
      if (c.kind !== 'task' || (c.owner && !c.owner.startsWith('*:'))) continue;
      // `*:<role>` and unowned tasks: only the role's providers, in their order; never the
      // provider of the reviewer the task expects; without overflow, only the first provider.
      const order = (x: string): string[] => roleLimits(this.config, roleOf(x)).providers;
      c.agents = c.agents.filter((x) => {
        if (c.avoid && !isHuman(c.avoid) && runtimeOf(c.avoid) === runtimeOf(x)) return false;
        return takesGroupWork(x, roleLimits(this.config, roleOf(x)));
      });
      c.agents.sort((x, y) => order(x).indexOf(runtimeOf(x)) - order(y).indexOf(runtimeOf(y)));
    }
    return [...byTask.values()];
  }

  /**
   * Plans what wake starts, without starting anything: candidates bottleneck first, re-sorted
   * after each planned run, which counts against the limits like a live one. `wake` carries the
   * plan out and `waits` reports it, so both always agree.
   */
  private planWake(): {
    steps: PlanStep[];
    state: Record<string, WakeState>;
    reviewed: Record<string, string[]>;
    inboxItems: Map<string, InboxKey[]>;
  } {
    const state = this.store.readJson<Record<string, WakeState>>('wake.json', {});
    const reviewed = this.store.readJson<Record<string, string[]>>('reviews.json', {});
    const inboxItems = new Map<string, InboxKey[]>();
    const agents = this.wakingAgents();
    if (agents.length === 0) return { steps: [], state, reviewed, inboxItems };
    const planWs = this.ws();
    const views = planWs.list();
    const live: PlannedRun[] = [...this.liveRecords()];
    const pending = this.wakeCandidates(agents, reviewed, state, inboxItems);
    const steps: PlanStep[] = [];
    // A tick plans from the checkout states it read at its start (`tickStates`).
    this.planSteps(pending, live, views, planWs, steps);
    return { steps, state, reviewed, inboxItems };
  }

  /** Plans each pending candidate in turn into `steps`; see `planWake`. */
  private planSteps(
    pending: WakeCandidate[],
    live: PlannedRun[],
    views: TaskView[],
    planWs: Workspace,
    steps: PlanStep[],
  ): void {
    while (pending.length > 0) {
      this.sortCandidates(pending, live);
      const c = pending.shift()!;
      if (c.kind === 'inbox') {
        // One run reads an agent's inbox; a live or planned run of the agent comes back to it.
        const agent = c.agents[0]!;
        if (live.some((r) => r.agent === agent)) {
          steps.push({ c, agent: null, reason: `a run of ${agent} is live or starting` });
          continue;
        }
      } else if (live.some((r) => r.root === c.root && r.task === c.id)) {
        continue;
      }
      // No agent starts beside a session outside swarmupd that may still work on the task.
      const outside = c.kind === 'task' && c.outside ? this.outsideHold(c.outside) : null;
      if (outside) {
        steps.push({ c, agent: null, reason: outside });
        continue;
      }
      const backlog = this.reviewBacklog(views, c.project);
      const held = backlog >= this.config.review_backlog;
      const reasons: string[] = [];
      let chosen: string | null = null;
      let chosenCwd: string | undefined;
      /** The worktree swarmupd makes before the chosen run starts, when it is not there yet. */
      let chosenWorktree: string | undefined;
      for (const agent of c.agents) {
        // An inbox run reads the agent's whole inbox, across projects, so it may already work on
        // this task; a second run beside it duplicates that work (AO-0128). This one starts
        // after it. A run with its own prompt, such as a schedule's, reads no inbox.
        if (live.some((r) => r.agent === agent && r.inbox)) {
          reasons.push(`${agent}: an inbox run of ${agent} is live or starting`);
          continue;
        }
        if (
          c.kind === 'task' &&
          !c.question &&
          held &&
          roleLimits(this.config, roleOf(agent)).writes
        ) {
          reasons.push(`${agent}: ${backlog} reviews wait in ${c.project}; new work there waits`);
          continue;
        }
        // A paused or proposed role still lists its reviews and inbox here, so `swarmup waits`
        // shows why they wait; it starts no run until a person sets it active.
        const role = planWs.agent(agent);
        const inactive = roleInactive(role);
        if (inactive) {
          reasons.push(`${agent}: ${inactive}`);
          continue;
        }
        // The queue lists a task owned by `*:<role>` whatever its type; a run must not start
        // on a type the role file does not allow. A task assigned to the agent by name stays
        // claimable whatever its type, as in core, so its run starts.
        if (
          c.kind === 'task' &&
          c.type !== undefined &&
          (!c.owner || isWildcard(c.owner)) &&
          !canClaimType(role, c.type, agent)
        ) {
          const types = role?.can_claim?.length ? role.can_claim : READ_ONLY_CAN_CLAIM;
          reasons.push(`${agent}: role takes only ${types.join(', ')}`);
          continue;
        }
        // A code task's run works in the task's worktree, which holds no other writer (AO-0168).
        const wt =
          c.kind === 'task' && !c.question
            ? this.codeWorktree(planWs, agent, c.root, c.id, c.type)
            : null;
        const cwd = wt ? wt.path : this.checkoutOf(planWs, agent, c.root);
        const why = this.blocker(agent, c.project, {
          burst: c.kind === 'review' && held,
          question: c.question,
          live,
          cwd,
          task: c.kind === 'inbox' ? undefined : c.ref,
        });
        if (!why) {
          chosen = agent;
          chosenCwd = cwd;
          if (wt && !wt.ready) chosenWorktree = wt.path;
          break;
        }
        reasons.push(`${agent}: ${why}`);
      }
      if (c.agents.length === 0) {
        reasons.push(
          'no waking agent may take it (role providers, overflow or the expected reviewer)',
        );
      }
      if (chosen) {
        live.push({
          agent: chosen,
          project: c.project,
          root: c.root,
          task: c.id,
          question: c.question,
          inbox: c.kind === 'inbox' || undefined,
          cwd: chosenCwd,
        });
        steps.push({
          c,
          agent: chosen,
          reason: chosenWorktree
            ? `starts once swarmupd has made its worktree ${chosenWorktree}`
            : 'starts at the next tick',
        });
      } else {
        steps.push({ c, agent: null, reason: reasons.join('; ') });
      }
    }
  }

  /**
   * Why a task waits for the session outside swarmupd that worked on it last, or null once
   * `outside_session_minutes` have passed since that session's last event (AO-0236).
   */
  private outsideHold(s: OutsideSession): string | null {
    const wait = this.config.outside_session_minutes;
    const ago = Math.max(0, Math.floor((this.now() - s.at) / 60_000));
    if (wait <= 0 || ago >= wait) return null;
    return (
      `a session of ${s.agent} outside swarmupd worked on it ${ago} min ago and may still do; ` +
      `a run starts in ${wait - ago} min unless that session claims it (outside_session_minutes)`
    );
  }

  /**
   * What waking agents could start, in wake order, with why each waits. Starts nothing. Then the
   * tasks that wait on an id no configured agent answers to, which no wake ever starts.
   */
  waits(): WaitItem[] {
    const ws = this.ws();
    // The plan holds until a tick ends, the tasks, roles, live runs, merge or worktrees change,
    // or a tick's time passes, so free memory, usage and cooldowns count again (AO-0166).
    const sig = this.waitsSignature(ws);
    const memo = this.waitsMemo;
    if (memo && memo.sig === sig && this.now() - memo.at < this.config.tick_seconds * 1000) {
      return [...memo.items];
    }
    const items = this.planWaits(ws);
    this.waitsMemo = { sig, at: this.now(), items };
    return [...items];
  }

  /**
   * What `waits` plans from, as a string that changes when it does: the tick count, swarmupd's
   * settings, live runs, the merge under way, the worktrees being made, and the stamps of each
   * root's settings, roles, inbox read markers, channels, votes and tasks. Stats files only, so it costs a few ms, not a plan.
   */
  private waitsSignature(ws: Workspace): string {
    const stamp = (path: string): string => {
      try {
        const s = statSync(path);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return '-';
      }
    };
    const files = (dir: string): string[] => {
      try {
        return readdirSync(dir).sort();
      } catch {
        return [];
      }
    };
    const m = this.merging;
    const parts: string[] = [
      String(this.ticks),
      JSON.stringify(this.config),
      this.liveRecords()
        .map((r) => `${r.id}:${r.status}`)
        .join(','),
      m ? `${m.ref}>${m.base}:${m.step}` : '',
      [...this.makingWorktrees.keys()].sort().join(','),
      [...this.reclaiming].sort().join(','),
      this.repairHold() ?? '',
      [...this.worktreeFailed].map(([p, at]) => `${p}@${at}`).join(','),
    ];
    for (const root of ws.roots) {
      parts.push(root.dir, stamp(join(root.dir, 'config.yml')), stamp(join(root.dir, 'tasks')));
      const agents = join(root.dir, 'agents');
      for (const f of files(agents)) parts.push(f, stamp(join(agents, f)));
      // Inbox read markers: an agent that read its inbox has no new items to wake for.
      const read = join(root.opsDir, 'read');
      for (const f of files(read)) parts.push(f, stamp(join(read, f)));
      // Channel mentions and votes reach the inbox too. A message is a new file in its channel's
      // folder; a ballot is a file in `ballots`, and `outcome.md` records the decision.
      const channels = join(root.dir, 'channels');
      parts.push(stamp(channels));
      for (const c of files(channels)) {
        parts.push(c, stamp(join(channels, c)), stamp(join(channels, c, 'channel.yml')));
      }
      const decisions = join(root.dir, 'decisions');
      parts.push(stamp(decisions));
      for (const d of files(decisions)) {
        const dir = join(decisions, d);
        const ballots = join(dir, 'ballots');
        parts.push(d, stamp(dir), stamp(join(dir, 'decision.md')), stamp(join(dir, 'outcome.md')));
        parts.push(stamp(ballots));
        for (const b of files(ballots)) parts.push(b, stamp(join(ballots, b)));
      }
      // An event is a new file in the task's `events` folder, which changes the folder's stamp.
      for (const id of root.listTaskIds()) {
        const dir = root.liveDir(id);
        parts.push(id, stamp(join(dir, 'task.md')), stamp(join(dir, 'events')));
      }
    }
    return parts.join('\n');
  }

  /** Plans what `waits` reports; see there. */
  private planWaits(ws: Workspace): WaitItem[] {
    const key = (v: TaskView): string => `${v.root}/${v.meta.id}`;
    // Ownerless work: swarmupd routes it at the next tick, or says why it cannot (AO-0140).
    const routes = new Map(this.plannedRoutes(ws).map((r) => [key(r.view), r]));
    const routeNote = (r: Route | undefined): string =>
      !r
        ? ''
        : r.blocker
          ? `; swarmupd cannot route it: ${r.blocker}`
          : `; swarmupd routes it to ${r.to} at the next tick`;
    const held = this.mergeHoldStart();
    // The plan only reports: the checkout states a tick read before do, so it runs no git.
    this.staleStatesOk = true;
    let steps: PlanStep[];
    try {
      steps = this.planWake().steps;
    } finally {
      this.staleStatesOk = false;
    }
    const planned: WaitItem[] = steps.map(({ c, agent, reason }) => ({
      kind: c.kind,
      task: c.ref,
      title: c.title,
      project: c.project,
      review: c.kind === 'review',
      agents: c.agents,
      // An unowned task no agent may take says what routing does about it.
      reason: reason + (c.kind === 'task' && !agent && c.ref ? routeNote(routes.get(c.ref)) : ''),
      // Work that waits for the merge under way says so, so the app shows it with the merge.
      ...(!agent && reason.includes(held) ? { merge: true as const } : {}),
    }));
    const stranded: WaitItem[] = ws.stranded().map((s) => ({
      kind: s.role === 'reviewer' ? 'review' : 'task',
      task: key(s.view),
      title: s.view.meta.title,
      project: s.view.meta.project ?? s.view.root,
      review: s.role === 'reviewer',
      agents: [],
      reason: s.reason + (s.role === 'owner' ? routeNote(routes.get(key(s.view))) : ''),
    }));
    const listed = new Set([...planned, ...stranded].map((w) => w.task));
    const unrouted: WaitItem[] = [...routes.values()]
      .filter((r) => r.blocker && !listed.has(key(r.view)))
      .map((r) => ({
        kind: 'task',
        task: key(r.view),
        title: r.view.meta.title,
        project: r.view.meta.project ?? r.view.root,
        review: false,
        agents: [],
        reason: `${r.why}${routeNote(r)}`,
      }));
    return [...planned, ...stranded, ...unrouted];
  }

  /** Starts the runs `planWake` plans, recording reviews and inbox items only once started. */
  private wake(): void {
    const { steps, state, reviewed, inboxItems } = this.planWake();
    let reviewsChanged = false;
    let stateChanged = false;
    /** Inbox keys each agent's started runs read: all for an inbox run, a task's own for others. */
    const read = new Map<string, Set<string>>();
    const inboxRun = new Set<string>();
    let wakeWs: Workspace | undefined;
    for (const { c, agent } of steps) {
      if (!agent) continue;
      // A code task's worktree is made off the event loop first; the run starts at a later tick.
      if (c.kind === 'task' && !c.question && c.ref) {
        wakeWs ??= this.ws();
        const wt = this.codeWorktree(wakeWs, agent, c.root, c.id, c.type);
        if (wt && !wt.ready) {
          this.makeWorktree(wt, c.ref);
          continue;
        }
      }
      let ok = false;
      this.safe(() => {
        if (c.kind === 'inbox') this.launch({ agent });
        else this.launch({ agent, task: c.ref, review: c.kind === 'review' });
        ok = true;
      });
      if (!ok) continue;
      const seen = read.get(agent) ?? new Set<string>();
      for (const item of inboxItems.get(agent) ?? []) {
        // An inbox run reads every item; a task or review run reads its task's history only.
        if (c.kind === 'inbox' || (item.root === c.root && item.id === c.id)) seen.add(item.key);
      }
      read.set(agent, seen);
      if (c.kind === 'inbox') inboxRun.add(agent);
      if (c.kind === 'review' && c.key) {
        (reviewed[agent] ??= []).push(c.key);
        reviewed[agent] = reviewed[agent]!.slice(-500);
        reviewsChanged = true;
      }
    }
    // Items count as seen only once a run read them, so a message on another task still wakes
    // an inbox run later; a failed launch uses none up.
    for (const [agent, seen] of read) {
      if (seen.size === 0 && !inboxRun.has(agent)) continue;
      const prev = state[agent] ?? { keys: [], at: 0 };
      const current = (inboxItems.get(agent) ?? []).map((i) => i.key);
      state[agent] = {
        keys: current.filter((k) => prev.keys.includes(k) || seen.has(k)),
        at: inboxRun.has(agent) ? this.now() : prev.at,
      };
      stateChanged = true;
    }
    if (reviewsChanged) this.store.writeJson('reviews.json', reviewed);
    if (stateChanged) this.store.writeJson('wake.json', state);
  }

  private safe(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.emit('warn', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Stops a process this swarmupd just started. Windows: closes the launcher's channel, so it exits
 * without starting the command, and ends the hidden `cmd.exe` through Node's own handle.
 * Unix: its process group, which an unreaped child keeps.
 */
function killOwnChild(spawned: Spawned): void {
  if (spawned.launch) {
    spawned.launch.abort();
    spawned.child.kill('SIGKILL');
  } else killTree(spawned.pid);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function scheduleDue(
  s: { every?: string; at?: string },
  last: number | undefined,
  now: number,
): boolean {
  if (s.every) return last === undefined || now - last >= parseDuration(s.every) * 60_000;
  if (!s.at) return false;
  const [h, m] = s.at.split(':').map(Number);
  const today = new Date(now);
  today.setHours(h!, m!, 0, 0);
  return now >= today.getTime() && (last === undefined || last < today.getTime());
}

/**
 * Whether the record's PID still runs the process swarmupd started. True: alive, with the recorded
 * creation time. False: gone, another creation time, or none on record. `unknown`: alive, but its
 * creation time cannot be read now (Windows asks PowerShell, which a loaded machine can hold past
 * its timeout); `adopt` then reads it again in the background. Kills check the creation time at
 * the moment of the kill either way.
 */
function sameProcess(r: RunRecord): boolean | 'unknown' {
  if (!isAlive(r.pid) || !r.proc_start) return false;
  const now = processStartSync(r.pid);
  if (now === null) return isAlive(r.pid) ? 'unknown' : false;
  return now === r.proc_start;
}

function gitTop(dir: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dirname(dir) === dir ? dir : dir,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\//g, process.platform === 'win32' ? '\\' : '/');
  } catch {
    return null;
  }
}

/**
 * The git folders a writing Codex run in `dir` may write; git names them now, synchronously.
 * A launch takes them from the checkout's state instead ({@link codexGitDirsOf}).
 */
export function codexGitDirs(dir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const top = gitTop(dir);
  return top ? codexGitDirsOf(new Checkout(top, [], env).gitDirs()) : [];
}

/**
 * The git folders a writing Codex run may write in a checkout whose git dirs are `found`: in a
 * worktree, its own git dir (`<common>/worktrees/<name>`) and the {@link CODEX_GIT_DIRS} of the
 * repo's common dir; none when git named no repo. In the main checkout they all lie under the
 * checkout's read-only `.git`, so {@link codexWritableDirs} leaves them out. `logs` is made when
 * missing, since the run cannot make folders in the common dir itself.
 *
 * `found` must be git's own answer. Reading `.git` and `commondir` as files skips git's checks
 * (a valid git dir, `safe.directory`), and a malformed pointer then makes folders outside the
 * repo writable.
 */
export function codexGitDirsOf(found: GitDirs | null): string[] {
  if (!found) return [];
  const { own, common: abs } = found;
  const dirs: string[] = [];
  if (own !== abs && existsSync(own)) dirs.push(own);
  for (const name of CODEX_GIT_DIRS) {
    const d = join(abs, name);
    if (name === 'logs') {
      try {
        mkdirSync(d, { recursive: true });
      } catch {
        // Left out below; the run then reports what it could not write.
      }
    }
    if (existsSync(d)) dirs.push(d);
  }
  return dirs;
}

/** The run-end note on what swarmupd committed for the run. */
function leftoverNote(l: Leftovers): string {
  const n = l.files.length;
  let note = `left ${n} changed file(s); swarmupd committed them as ${l.commit.slice(0, 7)} on branch ${l.branch}`;
  if (l.kept.length > 0) {
    note += `. ${l.kept.length} file(s) changed again after the commit and stay in ${l.top}: ${l.kept.slice(0, 5).join(', ')}`;
  }
  return note;
}

/**
 * The run-end note for paths that appeared next to the run's checkout while it worked (AO-0230).
 * Another run or a person may have made them, so the note names them and changes nothing.
 */
export function straysNote(paths: string[]): string {
  const shown = paths.slice(0, 10).map((p) => `\`${p.replace(/\\/g, '/')}\``);
  const more = paths.length > 10 ? `, and ${paths.length - 10} more` : '';
  return (
    `new next to the checkout while the run worked (it, another run or a person made them): ` +
    `${shown.join(', ')}${more}. Scratch belongs in the run's scratch folder.`
  );
}

/** The review request (or, when the run already asked for one, the comment) for what it left. */
function leftoverReview(r: RunRecord, l: Leftovers, asked: boolean): string {
  const how = asked
    ? `run ${r.id} (${r.agent}) asked for review with ${l.files.length} file(s) it could not commit`
    : `run ${r.id} (${r.agent}) ended without \`swarmup review\` and left ${l.files.length} changed file(s)`;
  const into = l.into ? ` Merge into ${l.into} after approval.` : '';
  return `${l.commit.slice(0, 7)} on branch ${l.branch}: ${how} in ${l.top}; swarmupd committed them from ${l.base.slice(0, 7)} and restored the checkout.${into}`;
}

/** A commit id in short form. */
function short(commit: string): string {
  return commit.slice(0, 7);
}

/** How long each check or build command of a merge may run. */
function mergeTimeout(cfg: MergeConfig): number {
  return (cfg.timeout_minutes ?? 30) * 60_000;
}

/** A time span for opsd.log: `45s` under a minute, else `1h30m`. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : formatMinutes(Math.round(s / 60));
}

/** The first lines of an error message, for a task event. */
function firstLines(text: string, n = 3): string {
  return text.trim().split('\n').slice(0, n).join(' ').slice(0, 500);
}

/** The end of a command's output, for a task event; the whole of it goes to a log file. */
function lastLines(text: string, n = 40, max = 3_000): string {
  const tail = text.replace(/\r\n/g, '\n').trimEnd().split('\n').slice(-n).join('\n');
  return tail.length > max ? tail.slice(-max) : tail;
}

/** One folder, compared as the file system does: case-insensitively on Windows. */
function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
}
