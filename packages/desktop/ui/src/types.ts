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
  body: string;
  /** Shown while its write is out; opsd has not stored it yet (AO-0171). */
  pending?: boolean;
}

export interface TaskDetail {
  task: Task;
  body: string;
  events: OpsEvent[];
}

export interface Question {
  event: string;
  from: string;
  summary: string;
  /** The whole question when it is longer than `summary`, its first line. */
  detail?: string;
}

export interface InboxItem {
  kind:
    'message' | 'ask' | 'review' | 'owned' | 'mention' | 'vote' | 'decide' | 'stranded' | 'triage';
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
}

export type RunFilter = 'all' | 'live' | 'ended' | 'errors';

/** `GET /api/runs?limit=`: one page of runs and the counts the Runs view shows. */
export interface RunPage {
  runs: RunRecord[];
  more: boolean;
  counts: Record<RunFilter, number>;
  today: { runs: number; tokens: number; errors: number };
  pick: RunRecord | null;
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
  /** Path of its role file; agents only the swarmupd config names have none. */
  file?: string;
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
  status: 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  percent?: number;
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
  dir: string;
  mirror: boolean;
  isMirror: boolean;
  isMaster: boolean;
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
    agents: Record<string, { wake?: boolean; budget?: string; model?: string }>;
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
  totals: { opened: number; closed: number; runs: number; minutes: number; tokens: number };
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
