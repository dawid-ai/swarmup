// Shapes the swarmupd API returns. They mirror @swarmup/core and @swarmup/supervisor, which the
// page cannot import because they use Node.

export type Status =
  'todo' | 'claimed' | 'in-progress' | 'blocked' | 'needs-review' | 'done' | 'parked';

export interface Delegation {
  by: string;
  to: string;
  at: string;
  budget_minutes?: number;
  tokens?: number;
  due?: string;
  review?: string;
}

export interface Task {
  id: string;
  root: string;
  title: string;
  type: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  project?: string;
  labels?: string[];
  createdBy?: string;
  createdAt?: string;
  status: Status;
  stale?: boolean;
  unblocked?: boolean;
  archived?: boolean;
  owner: string | null;
  claimedBy: string | null;
  leaseUntil: string | null;
  reviewer: string | null;
  waitingOn: string | null;
  blockedOn?: string[];
  /** blocked: the open ask or block the task waits on, and who it is for. */
  question?: Question & { to: string };
  checkpoint: { summary: string; next?: string; at: string } | null;
  delegation?: Delegation;
  updatedAt: string;
  /** A gate (W5): what its person decides. */
  gate?: GateSpec;
  /** A milestone started from a workflow (W5): the workflow's id. */
  workflow?: string;
}

export interface OpsEvent {
  id: string;
  type: string;
  actor: string;
  at: string;
  to?: string;
  on?: string[];
  verdict?: string;
  priority?: string;
  /** retype: the new task type. */
  task_type?: string;
  ref?: string;
  run?: string;
  exit?: number | null;
  reason?: string;
  minutes?: number;
  tokens?: number;
  forced?: boolean;
  /** plan-approve, plan-reject: the `plan` event it approves or rejects. */
  plan?: string;
  /** plan-amend: what the new items are. */
  plan_kind?: 'subtask' | 'fix';
  /** The recorded decision this event marks, as `D-0042` (AO-0109). */
  decision?: string;
  /** run-start: the session the run resumed; run-end: the runtime's session id. */
  session?: string;
  /** criteria: the whole new `done_when` list. */
  done_when?: Array<string | CriterionSpec>;
  /** verdict, criteria-check, merge: results by criterion id. */
  criteria?: Record<string, CriterionVerdict>;
  /** review, merge, publish: the commit. */
  commit?: string;
  /** review: the work the reviewer reads (W8). */
  artifacts?: ReviewArtifact[];
  /** publish: where the work went live, the file and its blob, and the workspace tag. */
  url?: string;
  path?: string;
  blob?: string;
  tag?: string;
  body: string;
  /** Shown while its write is out; opsd has not stored it yet (AO-0171). */
  pending?: boolean;
}

/** One piece of reviewed work a review event names (mirrors `ReviewArtifact` in core). */
export interface ReviewArtifact {
  kind: 'file' | 'url' | 'image' | 'doc';
  /** A path from the top of the workspace (file, image), or a URL (url, doc). */
  ref: string;
  blob?: string;
  rev?: string;
  label?: string;
}

/** `GET /api/tasks/:id/artifact` (mirrors `TaskArtifact` in the supervisor's artifact-api.ts). */
export interface TaskArtifact {
  path: string;
  commit: string | null;
  kind: 'text' | 'image';
  text?: string;
  /** image: a data URL. */
  data?: string;
  bytes: number;
  /** text at a commit: the file at the merge base, or null text when it is new. */
  base?: { commit: string; text: string | null } | null;
}

export interface TaskDetail {
  task: Task;
  body: string;
  events: OpsEvent[];
  /** The task's current criteria, ids settled (mirrors `Criterion` in core). */
  criteria?: Criterion[];
  /** The latest result of each criterion, by id. */
  criteriaResults?: Record<string, CriterionLast>;
  /** The goal brief: the newest `brief` event (mirrors `Brief` in core). */
  brief?: Brief;
  /** A parent's children, or none; set on a milestone, a parent and a task with a brief. */
  children?: BriefChild[];
  /** Children closed since the brief, as the PM's inbox run lists them. */
  closedSinceBrief?: string[];
}

export interface Brief {
  event: string;
  actor: string;
  at: string;
  body: string;
}

export interface BriefChild {
  id: string;
  title: string;
  status: Status;
  updatedAt: string;
}

/** One criterion's result as an event records it (mirrors `CriterionVerdict` in core). */
export interface CriterionVerdict {
  result: 'pass' | 'fail' | 'na';
  score?: number;
  evidence?: string;
  note?: string;
}

/** `GET /api/tasks/ID/criteria-check`: the task's running or last **Run checks**. */
export interface CriteriaCheckJob {
  task: string;
  by: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  ids: string[];
  current?: string;
  results: Record<string, CriterionVerdict>;
  error?: string;
  event?: string;
  /** A judge run (`criteria-judge`): what the judgments cost, when the runtime reports it. */
  costUsd?: number | null;
}

/** A typed `done_when` entry (mirrors `CriterionSpec` in `packages/core/src/criteria.ts`). */
export interface CriterionSpec {
  id?: string;
  kind: 'prose' | 'command' | 'check' | 'rubric' | 'human' | 'map';
  text?: string;
  run?: string;
  check?: string;
  args?: Record<string, unknown>;
  rubric?: string;
  pass?: number;
  ask?: string;
  /** `publish`: checked after `swarmup published`, not at merge (W8). */
  when?: 'publish';
}

export interface Criterion extends CriterionSpec {
  id: string;
}

export interface CriterionLast {
  result: 'pass' | 'fail' | 'na';
  score?: number;
  evidence?: string;
  note?: string;
  event: string;
  actor: string;
  at: string;
  type: string;
  /** `judge` when an LLM judge recorded it. */
  by?: string;
}

export interface Question {
  event: string;
  from: string;
  summary: string;
  /** The whole question when it is longer than `summary`, its first line. */
  detail?: string;
}

/** What a gate asks, and what a rejection does (W5; mirrors `GateSpec` in core). */
export interface GateSpec {
  ask: string;
  options?: string[];
  on_reject?: 'park' | 'revise';
}

export interface InboxItem {
  kind:
    | 'message'
    | 'ask'
    | 'review'
    | 'owned'
    | 'mention'
    | 'vote'
    | 'decide'
    | 'stranded'
    | 'triage'
    | 'gate';
  task: string;
  root: string;
  title: string;
  event?: string;
  from?: string;
  type?: string;
  summary: string;
  at?: string;
  /**
   * The full text when it says more than `summary`, its first line: a review request, message,
   * question or channel mention. Rendered as Markdown.
   */
  detail?: string;
  pr?: string;
  commit?: string;
  branch?: string;
  /** triage: the finding's owner and priority. */
  owner?: string;
  priority?: Task['priority'];
  /** triage: an open question to you, answered together with Accept. */
  question?: Question;
  /** ask, review: the decision the asker recommends, to accept as-is or edit (AO-0065). */
  recommend?: string;
  /** ask, review, triage: the open tasks that wait on this one (AO-0066). */
  blocks?: { direct: string[]; indirect: string[] };
  /**
   * review of a milestone whose plan waits for approval (AO-0110): the `plan` event, its item
   * count and estimate sum in minutes, and whether it revises an approved plan.
   */
  plan?: { event: string; items: number; minutes: number; change: boolean };
  /** gate (W5): a plan's gate waiting for your decision; Approve is done, Reject is park. */
  gate?: GateSpec;
  /** gate: the milestone it belongs to. */
  milestone?: string;
}

/** One item of a milestone's plan (mirrors `PlanRow` in `packages/core/src/workspace.ts`). */
export interface PlanRow {
  key: string;
  title: string;
  owner: string;
  after: string[];
  estimate: string;
  origin?: 'approve' | 'subtask' | 'fix';
  for?: string;
  review?: string;
  /** One line of text, or one typed criterion. */
  done_when?: string | CriterionSpec;
  type?: string;
  priority?: Task['priority'];
  body?: string;
  /** A gate item (W5): what its person decides. */
  gate?: GateSpec;
  /** The item's task, once created, with its current status and owner and its runs' minutes. */
  task?: string;
  status?: Status;
  taskOwner?: string | null;
  spent?: number;
}

/** `GET /api/tasks/<id>/plan`: a milestone's plan, as `swarmup plan show` reports it. */
export interface PlanReport {
  id: string;
  root: string;
  title: string;
  doneWhen?: string;
  status: Status;
  approval: string | null;
  planner: string | null;
  /** The effective plan, its estimate sum and the minutes its tasks' runs took. */
  items: PlanRow[];
  minutes: number;
  spent: number;
  /** The plan that waits for approval; `changes` is its diff against the effective plan. */
  pending: {
    event: string;
    actor: string;
    stale: boolean;
    base?: string;
    notes?: string;
    items: PlanRow[];
    minutes: number;
    changes: string[];
  } | null;
  incomplete: { missing: string[]; unapplied: string[] } | null;
  yaml: string;
}

/** One milestone from `GET /api/milestones`: its progress, for the board's card. */
export interface PlanProgress {
  root: string;
  id: string;
  title: string;
  total: number;
  done: number;
  parked: number;
  minutes: number;
  spent: number;
  pending: { items: number; minutes: number } | null;
}

export interface RunRecord {
  id: string;
  agent: string;
  task?: string;
  root?: string;
  schedule?: string;
  pid: number;
  cwd: string;
  started_at: string;
  ended_at?: string;
  status: 'running' | 'ended';
  exit?: number | null;
  reason?: string;
  budget_minutes: number;
  token_budget?: number;
  tokens: number;
  procs_left?: number;
  project?: string;
  review?: boolean;
  parent?: string;
  chat?: boolean;
  /** The session this run resumed after a `changes` verdict, and the run it came from (W3). */
  resumed?: string;
  resumed_from?: string;
  /** The definitions, model and effort the run started with (W5 run stamps). */
  defs?: RunDefs;
  model?: string;
  effort?: string;
}

/** Which definitions a run started with: `RunRecord.defs`. */
export interface RunDefs {
  root: string;
  /** `d:` and a SHA-256. */
  hash: string;
  /** The last store commit that changed a definition file, when they are all committed. */
  commit?: string;
  dirty?: boolean;
  /** Machine settings that overrode git for the run, such as `runtimes.claude.model`. */
  local?: string[];
}

/** A run's orientation from the score keeper: tool calls before its first edit. */
export interface RunOrientation {
  calls: number;
  /** Share of its tool-result bytes read before the first edit, 0 to 1. */
  share: number;
  edited: boolean;
  pass?: boolean;
}

export type RunFilter = 'all' | 'live' | 'ended' | 'errors';

/** `GET /api/runs?limit=`: one page of runs and the counts the Runs view shows. */
export interface RunPage {
  runs: RunRecord[];
  more: boolean;
  /** Runs in each filter, in the range (`start`, `end`). */
  counts: Record<RunFilter, number>;
  /** Runs in the range, their tokens and failures; started since `since` without a range. */
  today: { runs: number; tokens: number; errors: number };
  /** Every run and every live run, in the range or not; absent from an older swarmupd. */
  total?: number;
  live?: number;
  pick: RunRecord | null;
  /** Models of the runs in the range; absent from an older swarmupd. */
  models?: string[];
  /** Orientation of ended runs on the page, by run id; absent from an older swarmupd. */
  orientation?: Record<string, RunOrientation>;
}

/** Something a chat turn changed in SwarmUp. */
export interface ChatAction {
  kind: 'task' | 'channel';
  type: string;
  root: string;
  task?: string;
  title?: string;
  channel?: string;
  summary: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  at: string;
  text: string;
  from?: string;
  channel?: string;
  root?: string;
  /** `sending`: shown in the app while opsd has not answered the send yet (AO-0171). */
  status?: 'sending' | 'queued' | 'sent' | 'cancelled';
  run?: string;
  actions?: ChatAction[];
  error?: string;
}

/** `GET /api/chat`. */
export interface ChatView {
  agent: string;
  mentions: boolean;
  messages: ChatMessage[];
  live: RunRecord | null;
  streaming: string | null;
  busy: RunRecord | null;
  waiting: string | null;
}

export interface UsageWindow {
  utilization: number;
  resets_at: number;
  status?: string;
}

/** One provider from `GET /api/waits`. */
export interface ProviderUsage {
  windows: Record<string, UsageWindow>;
  limited_until?: number;
  plan?: string;
  paused: string | null;
  /** The model of each window that applies to one model only; older swarmupd builds leave it out. */
  window_models?: Record<string, string>;
  /** The windows of the provider's main quota, the only ones `pause_at` applies to; older swarmupd builds leave it out. */
  main_windows?: string[];
  /** Per model, why its runs wait while runs of other models go on. */
  model_paused?: Record<string, string>;
  live: number;
  /** Set while the provider is signed out: no run of it starts until it is signed in. */
  signed_out?: SignedOut;
}

/** A signed-out provider, from `GET /api/usage` (AO-0154). */
export interface SignedOut {
  since: string;
  run?: string;
  task?: string;
  /** How to sign in again, such as "run `codex login`". */
  steps: string;
  /** swarmupd checks the sign-in by itself; false: it tries one run an hour. */
  check: boolean;
  next: string;
}

/** Work waking agents could start, and why no run has started on it. */
export interface WaitItem {
  kind: 'review' | 'inbox' | 'task';
  task?: string;
  title: string;
  project: string;
  review: boolean;
  agents: string[];
  reason: string;
  /** Set when the merge under way holds the checkout this work would start in. */
  merge?: true;
  /** The provider that cannot run and is all this work waits for; see `WaitStall`. */
  stall?: string;
}

/** A provider that cannot run and the work it leaves waiting, as one line (AO-0341). */
export interface WaitStall {
  provider: string;
  reviews: string[];
  tasks: string[];
  text: string;
}

/** One file of a task's diff; see `DiffFile` in the supervisor. */
export interface DiffFile {
  path: string;
  /** The path before a rename or copy. */
  old?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type';
  added: number;
  deleted: number;
  binary?: boolean;
  /** The file's hunks in unified format; unset for a binary file or a patch left out. */
  patch?: string;
  /** The patch is left out: this file's is too large, or the whole diff is. */
  omitted?: 'file' | 'total';
}

/** The diff of the work a task's review names, from `GET /api/tasks/<id>/diff` (AO-0106). */
export interface TaskDiff {
  source: { commit?: string; branch?: string };
  base: string;
  from: string;
  to: string;
  /** swarmupd merged the work: the diff is what the base got. */
  merged: boolean;
  note?: string;
  commits: { sha: string; subject: string; author: string; at: string }[];
  files: DiffFile[];
}

/** The merge swarmupd runs now, from `GET /api/waits` (AO-0161); see `MergeStatus` in the supervisor. */
export interface MergeStatus {
  task: string;
  what: string;
  base: string;
  top: string;
  step: 'rebase' | 'checks' | 'waiting' | 'build';
  holds: boolean;
  started_at: string;
  command?: { text: string; index: number; count: number; started_at: string };
  timeout_minutes: number;
}

/** What `GET /api/waits` answers. `merge` is missing from a swarmupd older than AO-0161. */
export interface WaitsAnswer {
  providers: Record<string, ProviderUsage>;
  waits: WaitItem[];
  /** Missing from a swarmupd older than AO-0341. */
  stalls?: WaitStall[];
  merge?: MergeStatus | null;
}

/** One process a run started, from `GET /api/runs/:id/procs`. */
export interface ProcView {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  first_seen: string;
  last_seen: string;
  gone_at?: string;
  killed_at?: string;
  unsure?: boolean;
  alive: boolean;
}

export interface Agent {
  id: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'proposed';
  can_claim?: string[];
  budget_min?: number;
  /** The role file's model, when it sets one. */
  model?: string;
  /** The role file's reasoning effort, when it sets one. */
  effort?: string;
  /** Path of its role file; agents only the swarmupd config names have none. */
  file?: string;
  /** An agent of an agent folder `agents/<role>/` (W5), and its runtime addendum if any. */
  folder?: { role: string; addendum?: string };
  /** swarmupd starts runs for it when it has work. */
  wake?: boolean;
  live: string | null;
  /** Listed in the swarmupd config; older swarmupd builds leave it out. */
  configured?: boolean;
  /** Its provider is in Settings > Providers; older swarmupd builds leave it out. */
  provider?: boolean;
}

/** A provider runtime as Settings shows it. */
export interface RuntimeView {
  command: string;
  args?: string[];
  unset_env?: string[];
  model?: string;
  /** Reasoning effort for its runs, such as `medium`; unset: the provider's default. */
  effort?: string;
  max_live?: number;
  pause_at?: number;
  paused: boolean;
  /** The seeded entry "Reset to default" restores; null for a provider you added. */
  default?: { command: string; args?: string[] } | null;
  /** Where swarmupd found the command on PATH, or null; older swarmupd builds leave it out. */
  found?: string | null;
  /** Agents that run on it. */
  agents?: string[];
}

/** Someone the pickers offer, and why: role file, swarmupd config, runnable runtime, or seen lately. */
export interface DirectoryItem {
  id: string;
  source: 'role' | 'config' | 'runtime' | 'seen';
  /** A write that hands it work accepts it; older swarmupd builds leave it out (see `isConfigured`). */
  configured?: boolean;
  name?: string;
  description?: string;
  status?: string;
  paused?: boolean;
}

/** One file of an agent folder (W5): its frontmatter fields and its body. */
export interface RoleLayer {
  file: string;
  data: Record<string, unknown>;
  instructions: string;
}

/** A run setting of a role and where it comes from, for the role editor (W5). */
export interface RoleSetting {
  key: string;
  value: unknown;
  from: 'machine' | 'swarm.yaml' | 'role';
  /** The git value a machine value overrides. */
  over?: unknown;
}

/** A role file as the role editor reads and writes it. */
export interface RoleFile {
  id: string;
  name?: string;
  description?: string;
  status: 'active' | 'paused' | 'proposed';
  instructions: string;
  kb?: string[];
  files?: string[];
  style?: string;
  budget_min?: number;
  can_claim?: string[];
  tools?: string[];
  root?: string | null;
  /** An agent of an agent folder (W5): how it was put together. */
  folder?: {
    role: string;
    providersFrom: 'agent' | 'swarm-role' | 'swarm-runtimes' | 'default';
    addendum?: string;
    bodyMode?: 'append' | 'replace';
  };
  providers?: string[];
  /** A folder agent's two files: the role's agent.md and its runtime addendum. */
  layers?: { role: RoleLayer; runtime: RoleLayer | null };
  /** Its run settings and where each comes from. */
  settings?: RoleSetting[];
}

/** One workflow of a root (`GET /api/workflows`, W5). */
export interface WorkflowInfo {
  root: string;
  id: string;
  title?: string;
  description?: string;
  approval?: 'proposal' | 'starter';
  params: Record<
    string,
    { description?: string; required?: boolean; default?: string; options?: string[] } | null
  >;
  stages: number;
  ok: boolean;
  problems: string[];
  /** The file and its text, problems with lines, and the checked definition; absent from an older swarmupd. */
  file?: string;
  text?: string;
  issues?: DefProblem[];
  def?: WorkflowDefView | null;
}

/** A workflow stage as the file sets it (`packages/core/src/defs/workflow.ts`). */
export interface WorkflowStageView {
  key: string;
  title?: string;
  owner?: string;
  estimate?: string;
  after?: string[];
  review?: string;
  type?: string;
  priority?: string;
  labels?: string[];
  body?: string;
  done_when?: unknown;
  gate?: { ask: string; to?: string; options?: string[]; on_reject?: 'park' | 'revise' };
  when?: { param: string; equals: string | string[] };
}

/** A checked workflow file. */
export interface WorkflowDefView {
  id: string;
  title?: string;
  description?: string;
  params?: WorkflowInfo['params'] | null;
  milestone: { title: string; done_when: unknown };
  approval?: 'proposal' | 'starter';
  stages: WorkflowStageView[];
}

/** A starter template for a new workflow: `GET /api/workflows/templates`. */
export interface WorkflowTemplate {
  id: string;
  title: string;
  description?: string;
  text: string;
}

/** One item of a compiled workflow plan. */
export interface WorkflowPlanItem {
  key: string;
  title: string;
  owner: string;
  estimate: string;
  after?: string[];
  type?: string;
  priority?: string;
  labels?: string[];
  done_when?: unknown;
  gate?: { ask: string; options?: string[]; on_reject?: 'park' | 'revise' };
}

/** `POST /api/workflows/check`: problems with lines and the plan a preview compiles to. */
export interface WorkflowCheck {
  ok: boolean;
  problems: DefProblem[];
  def: WorkflowDefView | null;
  params?: Record<string, string>;
  plan?: {
    milestone: { title: string; done_when: unknown };
    approval: 'proposal' | 'starter';
    dropped: string[];
    items: WorkflowPlanItem[];
  };
  preview_error?: string;
}

export interface Decision {
  root: string;
  meta: {
    id: string;
    question: string;
    options: string[];
    voters?: string[];
    quorum: number;
    deadline?: string;
    task?: string;
    created_by: string;
  };
  body: string;
  ballots: { actor: string; at: string; choice: string; body: string }[];
  outcome: { choice: string; decided_by: string; at: string; body: string } | null;
  tally: {
    counts: Record<string, number>;
    votes: number;
    leaders: string[];
    state: 'open' | 'ready' | 'tie' | 'no-quorum' | 'decided';
    missing: string[];
  };
}

/** One line of the decision log (`GET /api/decisions?log`): a recorded decision or a decided vote. */
export interface LogEntry {
  root: string;
  id: string;
  kind: 'record' | 'vote';
  /** The one line: a record's text, or `question → choice` for a vote. */
  text: string;
  scope: 'project' | 'tree';
  /** Absent with a `project` scope: the whole root. */
  project?: string;
  task?: string;
  /** `ID#<event id>`, a file, or `chat:<message id>`. */
  source?: string;
  /** Who decided. */
  by: string;
  recorded_by?: string;
  at: string;
  supersedes: string[];
  narrows: string[];
  state: 'recorded' | 'superseded';
  /** The records that replace it, and where. */
  replaced: Array<{ by: string; how: 'superseded' | 'narrowed'; where: string }>;
  /** A `tree` decision replaced in part: the tasks still under it. */
  in_force_for?: string[];
  /** A vote decided more than once: the earlier outcomes, newest first. */
  revised?: Array<{ choice: string; at: string; by: string }>;
}

export interface ChannelInfo {
  name: string;
  messages: number;
  last: string | null;
  description?: string;
}

export interface ChannelMessage {
  id: string;
  channel: string;
  actor: string;
  at: string;
  mentions?: string[];
  task?: string;
  body: string;
  /** The data root the message file lives in. */
  root?: string;
}

/** The installed app's updates, from the main process. */
export interface UpdateState {
  status:
    | 'off'
    | 'idle'
    | 'checking'
    | 'none'
    | 'downloading'
    | 'ready'
    | 'waiting'
    | 'installing'
    | 'error';
  mode: 'manual' | 'auto';
  current: string;
  version?: string;
  percent?: number;
  live?: number;
  error?: string;
  checkedAt?: string;
  notes?: string;
}

/** One result of `GET /api/search`. */
export interface SearchHit {
  kind: 'task' | 'note' | 'post' | 'vote';
  ref: string;
  title: string;
  field: string;
  snippet: string;
  actor?: string;
  event?: string;
  at: string;
  score: number;
  status?: string;
  owner?: string | null;
  project?: string;
  priority?: string;
  root?: string;
}

/**
 * The answer of `GET /api/search`: `partial` is true when the request reached swarmupd's work budget
 * before it searched every item.
 */
export interface SearchResult {
  hits: SearchHit[];
  partial: boolean;
}

/** swarmupd as the tray and the Background service card show it. */
export interface ServiceState {
  running: boolean;
  paused: boolean;
  live: number;
  waiting: number;
  /** Whether live runs keep going after swarmupd stops (swarmupd's `runs_outlive`); true on every system today. */
  runsOutlive: boolean;
  /** Which swarmupd runs, while one does. */
  opsd?: OpsdIdentity;
  /** After a restart: the new pid and start time, from the main process. */
  note?: string;
}

/** Which swarmupd process runs and which build it loaded; see the desktop's `service.ts`. */
export interface OpsdIdentity {
  pid: number;
  startedAt: string;
  version: string;
  /** Build stamp: the newest code file's time in ms when swarmupd started. */
  build?: string;
  /** The installed app's build stamp now. */
  installed?: string;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'pause' | 'resume';

/** The desktop's own settings, from the main process. */
/** Voice input settings and readiness, from the main process. */
export interface VoiceView {
  engine: 'off' | 'local' | 'cloud';
  program: string | null;
  model: string | null;
  language: string;
  cloudModel: string;
  /** `OPENAI_API_KEY` is set for the app (its value never reaches the page). */
  cloudKey: boolean;
  /** What is missing before the microphone button can transcribe, or null when it is ready. */
  problem: string | null;
}

export interface DesktopView {
  notify: boolean;
  /** Windows starts the app at sign-in, tray only. */
  login: boolean;
  /** The sign-in entry's command when it starts another copy or folder than this app's. */
  loginOther: string | null;
  /** The sign-in entry exists but is turned off in Task Manager > Startup apps. */
  loginOff: boolean;
  loginSupported: boolean;
  state: ServiceState;
}

export interface Info {
  pid: number;
  port: number;
  version: string;
  /** When swarmupd started, ISO. */
  startedAt?: string;
  /** swarmupd's build stamp. */
  build?: string;
  me: string | null;
  /** swarmupd runs an older build than the one installed and needs a restart. */
  stale?: boolean;
  /** Live runs when the app looked. */
  live?: number;
}

/** One schedule from `GET /api/schedules`. */
export interface Schedule {
  name: string;
  agent: string;
  every?: string;
  at?: string;
  prompt?: string;
  task?: string;
  paused?: boolean;
  last_run: string | null;
  next_run: string | null;
}

/** One repeating task from `GET /api/repeats` (AO-0142). */
export interface Repeat {
  root: string;
  meta: {
    name: string;
    title: string;
    type?: string;
    priority?: string;
    owner?: string;
    project?: string;
    parent?: string;
    labels?: string[];
    /** Local wall time `YYYY-MM-DDTHH:MM`. */
    start?: string;
    repeat?: 'once' | 'daily' | 'weekly' | 'weekdays' | 'monthly' | 'yearly';
    days?: string[];
    until?: string;
    count?: number;
    /** `closed AO-0012` or `children-closed AO-0012`. */
    when?: string;
    paused?: boolean;
    created_by: string;
    created_at: string;
  };
  body: string;
  rule: string;
  state: 'active' | 'waiting' | 'paused' | 'finished' | 'broken';
  fired: number;
  last?: { id: string; slot: string; created_at: string; status?: Status };
  next?: string;
  due?: string;
  note?: string;
}

export interface RoleLimits {
  writes: boolean;
  per_project: number;
  max_live?: number;
  burst: number;
  providers: string[];
  overflow: boolean;
  max_children: number;
}

/** What `swarmup adopt` finds in a repo, for Add project. */
export interface RepoSurvey {
  dir: string;
  name: string;
  stacks: string[];
  frameworks: string[];
  tests: { runner: string | null; command: string | null; files: number };
  build: string | null;
  lint: string | null;
  docs: string[];
  ci: string[];
  agentDocs: string[];
}

/** The root Add project proposes: name, id prefix, roles and first tasks. */
export interface ProjectPlan {
  name: string;
  prefix: string;
  agents: Array<{ id: string; why: string }>;
  tasks: Array<{ title: string; body: string; priority: string }>;
}

export interface ProjectProposal {
  kind: 'proposal';
  dir: string;
  survey: RepoSurvey;
  plan: ProjectPlan;
  /** The branch checked out in the repo. */
  branch: string | null;
}

/** The picked folder had a data root: it joined `roots` and nothing else changed. */
export interface ProjectAdded {
  kind: 'added';
  dir: string;
  name: string | null;
  added: boolean;
  /** False when swarmupd could not be told to read the config again. */
  reloaded: boolean;
}

export interface ProjectCreated {
  name: string;
  dir: string;
  store: string | null;
  base: string | null;
  tasks: Array<{ id: string; title: string }>;
  reloaded: boolean;
}

/** `GET /api/settings`: effective values, and which keys the file sets. */
export interface RootInfo {
  name: string;
  /** The name the person chose for the sidebar; absent before AO-0353. */
  label?: string;
  dir: string;
  mirror: boolean;
  isMirror: boolean;
  isMaster: boolean;
}

/** A project in the user config, including projects swarmupd has archived (AO-0353). */
export interface ListedProject {
  /** The folder as the user config lists it; project actions identify the entry by this value. */
  root: string;
  /** The data root folder swarmupd loads for this entry, such as `<repo>/.swarmup`. */
  dir?: string;
  /** The root's own name, used by task project filters. */
  name: string | null;
  /** The editable display name, or the root's own name when no label is set. */
  label: string | null;
  archived: boolean;
  /** False when the configured folder no longer exists. */
  found: boolean;
}

export interface Settings {
  path: string;
  me: string | null;
  roots: string[];
  master: string | null;
  rootList: RootInfo[];
  notify: { webhook: boolean; kinds: string[] | null };
  opsd: {
    max_runs: number;
    /** No new runs or schedules start until resumed. */
    paused?: boolean;
    min_free_gb: number;
    usage_pause_at: number;
    review_backlog: number;
    /** Hours before a review whose reviewer cannot run moves to the author's provider; 0: never. */
    review_fallback_hours: number;
    budget_minutes: number;
    wake_cooldown_minutes: number;
    usage_cooldown_minutes: number;
    sync: boolean;
    port: number;
    tick_seconds: number;
    /** Remove a closed task's clean worktree; on by default. */
    reclaim_worktrees: boolean;
    reclaim_after_minutes: number;
    scratch_days: number;
    runtimes: Record<string, RuntimeView>;
    roles: Record<string, RoleLimits>;
    agents: Record<string, { wake?: boolean; budget?: string; model?: string; effort?: string }>;
    seeded?: boolean;
  };
  /** Default providers the config does not list, with whether their program is on PATH. */
  missingDefaults?: Array<{ name: string; command: string; found: string | null }>;
  set: string[];
  /** Closed tasks' worktrees the last cleanup sweep left in place, each with the reason. */
  kept?: Array<{ task: string; path: string; reason: string }>;
}

export interface StandupItem {
  task: string;
  title: string;
  at: string;
  note?: string;
}

export interface StandupEntry {
  agent: string;
  done: StandupItem[];
  review: StandupItem[];
  working: StandupItem[];
  blocked: StandupItem[];
  runs: number;
  tokens: number;
  minutes: number;
}

/** `GET /api/standup?hours=N`. */
export interface Standup {
  since: string;
  until: string;
  agents: StandupEntry[];
  posts: ChannelMessage[];
}

export interface UsageLine {
  key: string;
  runs: number;
  minutes: number;
  tokens: number;
}

/** `GET /api/report`: a window of progress and usage. */
export interface Report {
  from: string;
  to: string;
  project?: string | null;
  projects: Array<{
    project: string;
    opened: number;
    closed: number;
    parked: number;
    open: number;
    blocked: number;
  }>;
  agents: UsageLine[];
  providers: UsageLine[];
  decisions: Array<{ id: string; question: string; choice: string; at: string }>;
  channels: Array<{ channel: string; posts: number }>;
  /** Per agent, each scorer's figures over the window; older swarmupd versions send none. */
  scores?: AgentScores[];
  totals: { opened: number; closed: number; runs: number; minutes: number; tokens: number };
}

/** One scorer's figures for one agent, as `swarmup scores` reports them. */
export interface ScorerLine {
  scorer: string;
  level: 'run' | 'task' | 'agent';
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  /** What it measures and what to change when it fails; absent from an older swarmupd. */
  description?: string;
  lever?: string;
  n: number;
  mean: number;
  passed: number;
  judged: number;
  worst: Array<{ subject: string; value: number; evidence: string[] }>;
}

export interface AgentScores {
  agent: string;
  scorers: ScorerLine[];
}

/** A scorer as `GET /api/scores` describes it in `scorers`. */
export interface ScorerInfo {
  id: string;
  description: string;
  level: 'run' | 'task' | 'agent';
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  lever: string;
}

/** One score of one task, run or agent, with its evidence. */
export interface ScoreResult {
  scorer: string;
  level: 'run' | 'task' | 'agent';
  subject: string;
  agent: string;
  value: number;
  unit: string;
  pass?: boolean;
  n: number;
  evidence: string[];
  at: string;
  extra?: Record<string, number>;
  note?: string;
}

/** `GET /api/scores`: per agent, the scorers, and with `task=` that task's scores. */
export interface ScoresAnswer {
  agents: AgentScores[];
  /** Absent from an older swarmupd. */
  scorers?: ScorerInfo[];
  results?: ScoreResult[];
}

/** One scorer's trend for one agent: `GET /api/scores/history`. */
export interface ScoreSeries {
  agent: string;
  scorer: string;
  level: 'run' | 'task' | 'agent';
  unit: string;
  better: 'higher' | 'lower';
  pass?: number;
  points: Array<{ at: string; value: number; n: number }>;
}

export interface ScoreHistory {
  since: string;
  until: string;
  bucket: 'hour' | 'day';
  series: ScoreSeries[];
}

/** `GET /api/machines`: each machine's last presence record. */
export interface Machine {
  machine: string;
  last_seen: string;
  live_runs: number;
  version?: string;
  build?: string;
  agents?: string[];
  alive: boolean;
}

/** One line of the activity feed, as `GET /api/activity` returns it. */
export interface ActivityItem {
  id: string;
  at: string;
  kind: 'task' | 'channel';
  type: string;
  actor: string;
  to?: string;
  root: string;
  task?: string;
  title?: string;
  project?: string;
  channel?: string;
  verdict?: string;
  run?: string;
  body: string;
  /** The task is in the archive. */
  archived?: boolean;
}

/** One page of `GET /api/activity`. */
export interface ActivityPage {
  items: ActivityItem[];
  /** The `before` for the next older page; null on the last page. */
  next: string | null;
  /** Items matching the query, on every page. */
  total: number;
  /** Everyone who acted and every project, across the whole feed. */
  actors: string[];
  projects: string[];
}

/** One `swarmup doctor` check, as `GET /api/doctor` returns it. */
export interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
  action?: 'install-skills';
}

/** A learn note from `kb/<topic>/<slug>.md`, as `GET /api/kb` returns it. */
export interface KbNote {
  root: string;
  topic: string;
  slug: string;
  ref: string;
  title: string;
  author: string;
  created_at: string;
  task?: string;
  tags?: string[];
  body: string;
  score: number;
}

/** A learn note that keeps mattering (W6), as `/api/kb/promote` lists it. */
export interface KbCandidate {
  /** The ref `swarmup kb --read` takes: `<root>/<topic>/<slug>` when another root has it. */
  ref: string;
  note: Omit<KbNote, 'body' | 'score'>;
  shown: number;
  reads: number;
  relearned: string[];
  why: string[];
  agents: Array<{ agent: string; shown: number; reads: number }>;
  /** The agents whose role file it belongs in. */
  for: string[];
}

// The project map (W2), as `/api/map` returns it. Mirrors `packages/supervisor/src/map-api.ts`.

export type MapType = 'code' | 'website' | 'campaign';

/** A map node in a list: no body, links resolved to node ids. */
export interface MapNodeBrief {
  id: string;
  /** From the project top, such as `.swarmup/map/core/fold.md`. */
  file: string;
  kind: string;
  summary: string;
  covers: string[];
  links: string[];
  /** Links that name no node. */
  broken: string[];
  verified?: string;
  review_after?: string;
  /** Body lines. */
  size: number;
  problems: string[];
  /** Search hits only. */
  score?: number;
}

export interface MapView {
  root: string;
  top: string;
  dir: string | null;
  exists: boolean;
  type: string | null;
  detected?: MapType;
  summary: string;
  kinds: string[];
  nodes: MapNodeBrief[];
}

export interface MapNodeView extends MapNodeBrief {
  body: string;
  linksTo: MapNodeBrief[];
  linkedFrom: MapNodeBrief[];
}

export interface MapProblem {
  code: string;
  message: string;
  node?: string;
  path?: string;
}

export interface MapCheck {
  ok: boolean;
  hasMap: boolean;
  errors: MapProblem[];
  warnings: MapProblem[];
  base?: { ref: string; commit: string };
  changed: number;
  nodes: number;
}

// The replay timeline, as `GET /api/timeline` returns it. Mirrors `packages/core/src/timeline.ts`.

/** One stretch of time an agent held a task: claim (or start) to the event that let it go. */
export interface WorkSpan {
  root: string;
  task: string;
  title: string;
  agent: string;
  start: string;
  /** Null while the agent still holds the task at the end of the window. */
  end: string | null;
  /** The event type that ended the hold, `expired` when the lease ran out, or `open`. */
  endedBy: string;
}

/** A review request and its verdict. */
export interface ReviewRound {
  root: string;
  task: string;
  title: string;
  round: number;
  author: string;
  reviewer: string | null;
  start: string;
  end: string | null;
  decidedBy?: string;
  verdict?: 'approve' | 'changes';
  endedBy: string;
}

/** A task waiting: an ask for an answer, or a block on someone or on other tasks. */
export interface Wait {
  root: string;
  task: string;
  title: string;
  kind: 'ask' | 'block';
  actor: string;
  waitingOn: string | null;
  on: string[];
  human: boolean;
  start: string;
  end: string | null;
  answered: boolean;
  endedBy: string;
}

/** A supervised run, from run-start to run-end. */
export interface RunSpan {
  root: string;
  task: string;
  agent: string;
  run: string;
  start: string;
  end: string | null;
  tokens?: number;
  exit?: number | null;
  reason?: string;
}

export interface TimelineDecision {
  root: string;
  id: string;
  question: string;
  task?: string;
  proposedBy: string;
  start: string;
  end: string | null;
  choice?: string;
  decidedBy?: string;
  ballots: Array<{ actor: string; at: string; choice: string }>;
}

/** A learn note written from a task. */
export interface TimelineNote {
  root: string;
  task: string;
  agent: string;
  at: string;
  ref?: string;
  title: string;
}

/** A learn note read with `ops kb --read` while the reader worked a task (AO-0186). */
export interface TimelineNoteRead {
  root: string;
  ref: string;
  agent: string;
  at: string;
  task?: string;
  taskRoot?: string;
}

export interface TimelineCreate {
  root: string;
  task: string;
  title: string;
  at: string;
  by: string;
  /** The task type at the end of the window, such as `task` or `idea`; older swarmupd leaves it out. */
  type?: string;
}

export interface TimelineClose {
  root: string;
  task: string;
  title: string;
  at: string;
  by: string;
  via: string;
}

/** One row of the replay: an agent, a human, or a system actor such as `opsd:merge`. */
export interface TimelineLane {
  agent: string;
  kind: 'agent' | 'human' | 'system';
  first: string;
  workMs: number;
  runMs: number;
  tokens: number;
  tasks: number;
  reviews: number;
}

export interface TimelineTotals {
  agentHours: number;
  workHours: number;
  humanMinutes: number;
  humanWaitMinutes: number;
  asksAnswered: number;
  reviewRounds: number;
  tasksClosed: number;
  runs: number;
  tokens: number;
}

/** A piece of the real-to-playback map: real times in ms since the epoch, playback ones from 0. */
export interface TimeSegment {
  start: number;
  end: number;
  playStart: number;
  playEnd: number;
  idle: boolean;
}

export interface TimeMap {
  segments: TimeSegment[];
  playbackMs: number;
  maxGapMs: number;
}

export interface Timeline {
  from: string | null;
  to: string;
  lanes: TimelineLane[];
  spans: WorkSpan[];
  reviews: ReviewRound[];
  waits: Wait[];
  runs: RunSpan[];
  decisions: TimelineDecision[];
  notes: TimelineNote[];
  /** Learn notes being read; older swarmupd leaves it out. */
  noteReads?: TimelineNoteRead[];
  created: TimelineCreate[];
  closes: TimelineClose[];
  totals: TimelineTotals;
  time: TimeMap;
  /** With `wrapped=1`: the Wrapped cards of the same project and window (AO-0084). */
  wrapped?: Wrapped;
  /** With `graph=1`: the links between tasks, and the files events name (AO-0080). */
  graph?: TimelineGraph;
}

/** One task's links to other tasks (mirrors `GraphTask` in `packages/core/src/timeline.ts`). */
export interface GraphTask {
  root: string;
  task: string;
  title: string;
  created: string;
  parent?: string;
  blockedBy: string[];
}

/** A file path an event's text names. */
export interface FileMention {
  root: string;
  task: string;
  actor: string;
  at: string;
  path: string;
}

/** One task event inside the window (mirrors `GraphTouch` in `packages/core/src/timeline.ts`). */
export interface GraphTouch {
  root: string;
  task: string;
  actor: string;
  at: string;
  type: string;
}

export interface TimelineGraph {
  tasks: GraphTask[];
  files: FileMention[];
  /** Every task event inside the window, in time order. */
  touches: GraphTouch[];
}

/** The Wrapped figures (mirrors `Wrapped` in `packages/supervisor/src/wrapped.ts`). */
export interface Wrapped {
  from: string;
  to: string;
  project: string | null;
  closed: number;
  opened: number;
  agentMinutes: number;
  agentHours: number;
  humanMinutes: number;
  busiest: { agent: string; runs: number; minutes: number; tokens: number } | null;
  rally: {
    task: string;
    title: string;
    rounds: number;
    verdict: 'approve' | 'changes' | null;
    players: string[];
  } | null;
  fastest: {
    task: string;
    title: string;
    minutes: number;
    asked: string | null;
    at: string;
  } | null;
  blocked: { task: string; title: string; minutes: number; waits: number } | null;
}

// ---- Definitions and benchmarks (W5, W7) --------------------------------------------------------

/** A definitions problem (mirrors `DefProblem` in `packages/core/src/defs/schema.ts`). */
export interface DefProblem {
  file: string;
  path: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
  message: string;
}

/** One root's definitions (mirrors `DefsRootView` in `packages/supervisor/src/defs-state.ts`). */
export interface DefsRoot {
  root: string;
  dir: string;
  present: boolean;
  hash: string;
  short: string;
  commit?: string;
  dirty?: boolean;
  ok: boolean;
  stale: boolean;
  agents: number;
  problems: DefProblem[];
  text?: string;
}

/** A key a swarm.yaml sets, with its effective value and source (`DefsValue`). */
export interface DefsValue {
  key: string;
  value: unknown;
  source: 'git' | 'machine' | 'unused';
  git: unknown;
  root: string;
}

/** `GET /api/defs`. */
export interface DefsView {
  roots: DefsRoot[];
  applied: Array<{ key: string; root: string }>;
  overrides: Array<{ key: string; machine: unknown; git: unknown; root: string }>;
  conflicts: Array<{ key: string; roots: string[] }>;
  values: DefsValue[];
}

/** `POST /api/defs/import` (mirrors `DefsImportPlan` in `defs-import.ts`). */
export interface DefsImportPlan {
  file: string;
  exists: boolean;
  before: string;
  after: string;
  diff: string[];
  keys: string[];
  empty: boolean;
  problems: DefProblem[];
  written?: boolean;
}

export type BenchMode = 'agent' | 'none' | 'reference';

/** A benchmark set (mirrors `BenchSetView` in `packages/supervisor/src/bench-runs.ts`). */
export interface BenchSetView {
  id: string;
  file: string;
  source: string;
  description?: string;
  hiddenDir?: string;
  defaults?: { agent?: string; budget?: number; repeat: number };
  entries: Array<{
    id: string;
    title: string;
    base: string;
    agent?: string;
    budget?: number;
    repeat: number;
    criteria: { visible: number; hidden: number; pending: number };
  }>;
  error?: string;
}

/** `summary.json` figures of a run or the entries of a comparison (`SummaryOverall`). */
export interface BenchOverall {
  attempts: number;
  passRate: number | null;
  hiddenPassRate: number | null;
  costUsd: number | null;
  costPerAttempt: number | null;
  wallMs: number | null;
  toolCallsBeforeEdit: number | null;
  /** Some cost is estimated from tokens (Codex): shown with `~`. */
  costEstimated?: boolean;
  /** With `--repeat`: the spread over repeats. */
  passRateSd?: number | null;
  costSdUsd?: number | null;
}

/** The figures every run's overall has, which `bench compare` subtracts. */
export type BenchFigure = Exclude<keyof BenchOverall, 'costEstimated' | 'passRateSd' | 'costSdUsd'>;

/** One entry of `summary.json` (`EntrySummary`). */
export interface BenchEntrySummary {
  entry: string;
  attempts: number;
  passRate: number | null;
  hiddenPass: { passed: number; attempts: number } | null;
  pending: number;
  costUsd: number | null;
  wallMs: number | null;
  toolCallsBeforeEdit: number | null;
  timedOut: number;
  errors: number;
  costEstimated?: boolean;
  /** Models with no price, so their attempts have no cost. */
  unpriced?: string[];
  /** With more than one attempt: the pass-rate spread and the cost's standard deviation. */
  passRateMin?: number | null;
  passRateMax?: number | null;
  passRateSd?: number | null;
  costSdUsd?: number | null;
}

/** `--max-usd`: the cap, what the attempts cost, and whether it stopped the run. */
export interface BenchCap {
  maxUsd: number;
  /** Agent cost, estimates included, plus judge cost, over the attempts that ran. */
  spentUsd: number;
  /** `spentUsd` reached `maxUsd`, so later attempts were skipped. */
  hit: boolean;
  /** Attempts whose cost is unknown, which the cap could not count. */
  uncounted: number;
}

/** A run in the runs list (`BenchRunView`). */
export interface BenchRunView {
  id: string;
  dir: string;
  state: 'running' | 'done' | 'failed';
  set?: string;
  mode?: BenchMode;
  agent?: string;
  model?: string;
  effort?: string;
  startedAt?: string;
  finishedAt?: string;
  done?: number;
  total?: number;
  current?: string;
  error?: string;
  overall?: BenchOverall;
  fromApp: boolean;
}

/** One attempt's `results.json` (`AttemptResult`). */
export interface BenchAttempt {
  set: string;
  entry: string;
  attempt: number;
  mode: BenchMode;
  agent: string;
  model?: string;
  effort?: string;
  base: { ref: string; sha: string };
  budgetMin?: number;
  startedAt: string;
  run: { exitCode: number | null; timedOut: boolean; wallMs: number; error?: string };
  metrics: {
    costUsd: number | null;
    costEstimated?: boolean;
    turns: number | null;
    toolCalls: number | null;
    toolCallsBeforeEdit: number | null;
    edited: boolean | null;
  };
  diff: { files: number; insertions: number; deletions: number };
  criteria: Array<{
    id: string;
    kind: string;
    hidden?: boolean;
    what: string;
    result: 'pass' | 'fail' | 'na' | 'pending';
    /** A judged rubric criterion: its score as 0 to 1. */
    score?: number;
    evidence?: string;
    note?: string;
  }>;
  score: {
    checkable: number;
    passed: number;
    passRate: number | null;
    hidden: { total: number; passed: number };
    pending: number;
  };
}

/** `GET /api/bench/runs/:id`. */
export interface BenchRunDetail {
  run: BenchRunView;
  summary?: {
    entries: BenchEntrySummary[];
    overall: BenchOverall;
    repo: string;
    cap?: BenchCap;
    skipped?: unknown[];
  };
  request?: { repo: string; hidden_dir?: string; reference_dir?: string; entries?: string[] };
  attempts: BenchAttempt[];
  log?: string;
}

/** A dry run's plan (`BenchPlanView`). */
export interface BenchPlan {
  set: string;
  file: string;
  mode: BenchMode;
  agent: string;
  model?: string;
  effort?: string;
  repo: string;
  hiddenDir?: string;
  referenceDir?: string;
  entries: string[];
  repeat: number;
  attempts: Array<{ entry: string; attempt: number; base: string; budgetMin: number }>;
  skipped: string[];
  maxMinutes: number;
  /** The `--max-usd` cap, when set. */
  maxUsd?: number;
  spends: boolean;
  lines: string[];
}

/** `POST /api/bench/compare` (`Comparison`). */
export interface BenchComparison {
  a: { set: string; agent: string; model?: string; effort?: string; out: string };
  b: { set: string; agent: string; model?: string; effort?: string; out: string };
  rows: Array<{ entry: string; a: BenchEntrySummary | null; b: BenchEntrySummary | null }>;
  overall: {
    a: BenchOverall;
    b: BenchOverall;
    /** Variant minus base per figure; the spread figures only with `--repeat`. */
    delta: Record<BenchFigure, number | null> &
      Partial<Record<'passRateSd' | 'costSdUsd', number | null>>;
  };
}

/** A proposal's benchmark: the configured set, base against variant (W6). */
export interface ProposalBenchmark {
  state: 'running' | 'done' | 'failed' | 'skipped';
  base?: string;
  run?: string;
  verdict?: 'better' | 'worse' | 'same';
  delta?: {
    passRate?: number | null;
    hiddenPassRate?: number | null;
    costPerAttempt?: number | null;
    wallMs?: number | null;
  };
  error?: string;
}

/** A variant of the definitions, as `GET /api/defs/variants` lists it (W6). */
export interface ProposalView {
  root: string;
  name: string;
  hash: string;
  base: string;
  status: 'proposed' | 'draft';
  stale: boolean;
  agents: string[];
  ok: boolean;
  problems: string[];
  /** `variants.<name>.description` in `swarm.yaml`. */
  description?: string;
  /** A variant of the definitions at a git ref (`variants.<name>.from_ref`), and its commit. */
  from_ref?: string;
  commit?: string;
  proposal?: {
    task: string;
    agents: string[];
    scorers: string[];
    message: string;
    by: string;
    at: string;
  };
  diffs: Array<{ path: string; kind: 'added' | 'changed' | 'removed'; lines: string[] }>;
  benchmark?: ProposalBenchmark;
}

/** One MCP server in **Settings > MCP servers** (W8); a secret shows only whether it is set. */
export interface McpServerView {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string | { secret: string; set: boolean }>;
  roots: string[];
  agents: string[];
  tools: { allow?: string[]; deny?: string[] };
  publish: boolean;
}

/** What an agent's role file asks for, and what its runs get in each root. */
export interface McpAgentView {
  id: string;
  asked: string[];
  missing: string[];
  granted: Record<string, string[]>;
}

/** `GET /api/mcp`. Never a secret value. */
export interface McpView {
  path: string;
  secrets_path: string;
  strict: boolean;
  servers: McpServerView[];
  secrets: string[];
  agents: McpAgentView[];
  error?: string;
}

/** Where a root's trigger set or merge checks stand against what this machine trusts. */
export type TrustState = 'none' | 'trusted' | 'untrusted' | 'changed';

/** One git trigger in `GET /api/automation`. Never a secret value. */
export interface AutomationTrigger {
  root: string;
  name: string;
  file: string;
  when: string;
  target: string;
  enabled: boolean;
  runs_on?: string[];
  consent: boolean;
  trust: TrustState;
  here: boolean;
  hook?: 'finding' | 'direct';
  why?: string;
  last_fire: string | null;
  next_fire: string | null;
  /** The fields the trigger set's hash covers, as `[key, value]`. */
  fields: Array<[string, string]>;
  errors: string[];
  webhook?: {
    verify: string;
    secret: string;
    secret_ok: boolean;
    secret_why?: string;
    direct: boolean;
  };
}

/** One root in `GET /api/automation`. */
export interface AutomationRoot {
  root: string;
  on: boolean;
  status: 'off' | TrustState;
  trust: TrustState;
  hash: string | null;
  broken: number;
  swarm_error?: string;
  triggers: AutomationTrigger[];
  checks: {
    trust: TrustState;
    hash: string;
    checks: Array<{ name: string; run: string; paths: string[] }>;
  } | null;
}

/** One line of `hooks.log`. */
export interface HookLogLine {
  at: string;
  via: 'listener' | 'fire';
  root?: string;
  trigger?: string;
  status: 'accepted' | 'refused';
  code: number;
  reason?: string;
  delivery?: string;
  effect?: string;
  ref?: string;
}

/** `GET /api/automation`: git triggers, merge-check trust and the inbound listener here. */
export interface AutomationView {
  machine: string | null;
  roots: AutomationRoot[];
  hooks: {
    enabled: boolean;
    host: string;
    port: number;
    listener: 'off' | 'listening' | 'failed';
    at?: { host: string; port: number };
    error?: string;
    restart: boolean;
    log: HookLogLine[];
  };
}
