import type { CriteriaResults, Criterion, CriterionLast, DoneWhenEntry } from './criteria.js';

export const STATUSES = [
  'todo',
  'claimed',
  'in-progress',
  'blocked',
  'needs-review',
  'done',
  'parked',
] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES: ReadonlySet<Status> = new Set([
  'todo',
  'claimed',
  'in-progress',
  'blocked',
  'needs-review',
]);

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Event types. The fold acts on the ones that change state; the rest (comment, finding, learn,
 * run-start, run-end, merge, brief) are history. The four plan events carry a milestone's plan
 * (AO-0110). `criteria` replaces a task's `done_when` list and `criteria-check` records check
 * results. `defs-propose`, `defs-promote`, `defs-reject` and `defs-rollback` record a change to the
 * definitions proposed as a variant, and what a person did with it (W6). `publish` records that a person
 * published the work (W8), and `publish-attempt` that a person started a publish adapter, written
 * before it runs so it runs once per content. Unknown types from newer versions are kept and
 * ignored.
 */
export const EVENT_TYPES = [
  'claim',
  'start',
  'progress',
  'checkpoint',
  'comment',
  'handoff',
  'assign',
  'review',
  'review-fallback',
  'verdict',
  'done',
  'ask',
  'answer',
  'block',
  'unblock',
  'release',
  'priority',
  'park',
  'reopen',
  'finding',
  'learn',
  'run-start',
  'run-end',
  'delegate',
  'renew',
  'retype',
  'merge',
  'plan',
  'plan-approve',
  'plan-amend',
  'plan-reject',
  'criteria',
  'criteria-check',
  'brief',
  'defs-propose',
  'defs-promote',
  'defs-reject',
  'defs-rollback',
  'publish',
  'publish-attempt',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Frontmatter of `tasks/<id>/task.md`. */
export interface TaskMeta {
  id: string;
  title: string;
  type: string;
  priority: Priority;
  /** Initial owner: an actor id, a runtime wildcard (`codex:*`), or empty for anyone. */
  owner?: string;
  project?: string;
  parent?: string;
  labels?: string[];
  /** Tasks that must be done before this one can start. */
  blocked_by?: string[];
  /**
   * What must hold before the task is done (AO-0290): a short list of criteria. A plain string is
   * a `prose` criterion; an object is a typed one (`command`, `check`, `rubric`, `human`, `map`).
   * Tasks filed before the field have none. A `criteria` event replaces the list later.
   */
  done_when?: DoneWhenEntry[];
  /** The repeat (`repeats/<name>.md`) that created this task. */
  repeat?: string;
  /** The slot the repeat fired for: local time `YYYY-MM-DDTHH:MM`, or a condition key. */
  repeat_slot?: string;
  /**
   * The task's identity in a milestone's plan (AO-0110): `<milestone>#<key>`, such as
   * `AO-0120#ci`. Keys are never reused, so it names one task for the milestone's life.
   */
  plan_item?: string;
  /**
   * The reviewer the plan item names: a concrete actor. `swarmup review` and swarmupd read it
   * after a delegation's reviewer; the human routes come before both.
   */
  review?: string;
  /** Set when the creator used --force to give a `publish` task an owner that is no person. */
  owner_forced?: boolean;
  /** A `gate` task (W5): what the person decides, and what a rejection does. */
  gate?: GateSpec;
  /** A milestone started from a workflow (W5): the workflow's id, `workflows/<id>.yaml`. */
  workflow?: string;
  /** The definition hash of the store when the workflow started (W5). */
  defs_hash?: string;
  created_by: string;
  created_at: string;
}

/** The type of a task that holds a goal, one `done_when` line and a plan of child tasks. */
export const MILESTONE_TYPE = 'milestone';

/** The owner a milestone gets on its first approved plan: the role that checks `done_when`. */
export const PLAN_CHECKER = '*:qa';

/**
 * The failed checks of a milestone that each add fix tasks (AO-0110, "Closing"). The check after
 * them adds none: two rounds of fixes that do not pass mean the plan or the check is wrong, so
 * the checker asks instead.
 */
export const PLAN_FIX_ROUNDS = 2;

/** The most items one plan file holds; a bigger goal is several milestones. */
export const PLAN_MAX_ITEMS = 25;

/**
 * The type of a task whose work is copy or other content (W8): drafted on a branch, reviewed and
 * merged like code, in a workspace kept in git.
 */
export const CONTENT_TYPE = 'content';

/**
 * The type of a task that publishes approved work (W8). Only a person owns, claims or is
 * assigned one: publishing is never an agent's step and never a criterion. `swarmup published`
 * records it, and the merge has nothing to merge for it.
 */
export const PUBLISH_TYPE = 'publish';

/**
 * The type of a human gate in a plan (W5): a person approves with `swarmup done` or rejects with
 * `swarmup park`, and the items after it wait for the approval through `after`. Only a person
 * owns, claims or closes one.
 */
export const GATE_TYPE = 'gate';

/** What a gate asks, of whom, and what a rejection does (W5). */
export interface GateSpec {
  /** The question, such as "Is the brief right?". */
  ask: string;
  /** Answers the person may pick from, shown with the question. */
  options?: string[];
  /**
   * `park` (the default): a rejection parks the gate and every item after it. `revise`: the items
   * the gate waits for reopen, and the gate asks again when they are done.
   */
  on_reject?: 'park' | 'revise';
}

/** The types only a person owns, claims or closes: publishing (W8) and gates (W5). */
export const PERSON_TYPES: readonly string[] = [PUBLISH_TYPE, GATE_TYPE];

/** The types a plan item's task may have. Not `milestone`: plans do not nest. */
export const PLAN_ITEM_TYPES: readonly string[] = [
  'task',
  'bug',
  'docs',
  CONTENT_TYPE,
  PUBLISH_TYPE,
  GATE_TYPE,
];

/** One piece of reviewed work a review event names (W8): a file, a URL, an image or a document. */
export interface ReviewArtifact {
  kind: 'file' | 'url' | 'image' | 'doc';
  /** A path from the top of the checkout (file, image), or a URL (url, doc). */
  ref: string;
  /** file, image: the git blob of the path at the reviewed commit. */
  blob?: string;
  /** doc: the document's revision, when its service names one. */
  rev?: string;
  label?: string;
}

/** What `publish` events record of the edits between approval and publishing (W8 phase 3). */
export interface PublishEdits {
  /** Words taken out plus words put in, over every file. */
  changed: number;
  /** Words of the approved text plus words of the published text, over every file. */
  total: number;
  /** Per file: the task whose approval it comes from, and its approving verdict. */
  files: Array<{ path: string; task: string; verdict: string; changed: number; total: number }>;
}

/** The kinds a review artifact may have. */
export const ARTIFACT_KINDS: readonly ReviewArtifact['kind'][] = ['file', 'url', 'image', 'doc'];

/** One item of a milestone's plan: the task an approval creates for it (AO-0110). */
export interface PlanItem {
  /** Short id inside the milestone; `after` and `for` refer to it. Lowercase, never reused. */
  key: string;
  title: string;
  /** An agent id, a role or runtime wildcard, or `human:<name>`. */
  owner: string;
  /** Keys this item waits for; they become the task's `blocked_by`. */
  after?: string[];
  /** `30m`, `2h` or `1d` (8 h). A planning number, never a budget. */
  estimate: string;
  /**
   * The item's own check: the one entry of the task's `done_when`, one line of text or one typed
   * criterion. Defaults to the title.
   */
  done_when?: DoneWhenEntry;
  type?: string;
  priority?: Priority;
  /** Expected reviewer: a concrete actor id. */
  review?: string;
  body?: string;
  /** Amendments: the approved item this one serves. */
  for?: string;
  /** A `gate` item (W5): the question its person answers. */
  gate?: GateSpec;
}

/** Where an item of the effective plan came from: a human approval, or an amendment after it. */
export type PlanOrigin = 'approve' | 'subtask' | 'fix';

export interface EffectivePlanItem extends PlanItem {
  origin: PlanOrigin;
}

/** A milestone's plan, folded from its `plan`, `plan-approve`, `plan-amend` and `plan-reject` events. */
export interface PlanState {
  /** The effective plan: the items of the latest `plan-approve`, then of every `plan-amend` after it. */
  items: EffectivePlanItem[];
  /** The latest `plan-approve` event, or null before the first approval. */
  approval: string | null;
  /** The latest `plan-approve` or `plan-amend` event: what a change proposal names as `base`. */
  head: string | null;
  /** The actor of the `plan` event that the latest `plan-approve` approved. */
  planner: string | null;
  /**
   * The latest `plan` event that no `plan-approve` or `plan-reject` cites. `stale`: it revises a
   * `base` the effective plan has moved past, so approving it would drop what came between.
   */
  pending: { event: string; actor: string; base?: string; stale: boolean } | null;
  /** Every key a `plan-approve` or `plan-amend` has held, whether its task still exists or not. */
  usedKeys: string[];
  /**
   * The keys of existing items that the latest approval changes: removed, or with another owner
   * or `after`. Each needs one event with `plan_apply: <approval>#<key>` on its task, or a
   * `plan_skip` comment on the milestone.
   */
  diff: string[];
  /** The keys of `diff` that a `plan_skip` comment on the milestone settles. */
  skipped: string[];
  /**
   * The failed checks so far: the `plan-amend` events of kind `fix` since the latest
   * `plan-approve` or `reopen`, oldest first. A person's approval or a reopen starts a new count,
   * because the plan the check ran against has changed or the person wants the check again.
   */
  failedChecks: string[];
}

/** Frontmatter of `tasks/<id>/events/<ulid>-<actor>.md`, plus the id from the file name. */
export interface OpsEvent {
  id: string;
  type: EventType | string;
  actor: string;
  at: string;
  to?: string;
  /**
   * block: the tasks this one waits on. handoff, delegate, reopen: with a non-empty list, the task
   * is blocked on them in the same event, so an owner change never frees it early (AO-0110).
   */
  on?: string[];
  /** verdict: approve or changes. */
  verdict?: 'approve' | 'changes';
  /** priority: the new priority. */
  priority?: Priority;
  /** retype: the new task type, such as `task`, `bug` or `idea`. */
  task_type?: string;
  /**
   * assign: keep a blocked task's wait (its open question or the tasks it waits on) under the new
   * owner. `swarmup assign` and triage without an answer write it whenever the task is blocked. Without
   * it (older events), assign clears the wait.
   */
  keep_wait?: boolean;
  /** claim, start, progress, checkpoint: when the claim expires unless renewed. */
  lease_until?: string;
  /** checkpoint: the next step for whoever resumes. */
  next?: string;
  /** Set when the actor used --force to skip the ownership check. */
  forced?: boolean;
  /** claim: a random id for this claim, so two runs with the same agent id stay apart. */
  token?: string;
  /**
   * start, progress, renew, checkpoint, release: the token of the claim the writer held. The event
   * applies only while that claim stands, so a run that lost a claim race (even one with the same
   * agent id on another machine) cannot start, renew or release the winner's claim. Events
   * without it follow the older rules.
   */
  holder?: string;
  /** delegate: time budget in minutes. */
  budget_minutes?: number;
  /** delegate: token budget. */
  tokens?: number;
  /** delegate: when the work is due (ISO). */
  due?: string;
  /** delegate: the reviewer the delegator expects. */
  review?: string;
  /** finding: the task the finding was filed as. learn: the note, as `<topic>/<slug>`. */
  ref?: string;
  /** run-start, run-end, renew: the supervisor's run id. review: the run that asked, if any. */
  run?: string;
  /** run-end: the exit code, or null when the process was killed or lost. */
  exit?: number | null;
  /**
   * run-end: why the run ended, such as `exit`, `budget`, `tokens`, `killed` or `lost`. ask: why
   * only a person can answer, one of {@link ASK_REASONS}; the escalation scorer reads it.
   */
  reason?: string;
  /** run-end: minutes the run took. */
  minutes?: number;
  /**
   * run-end: the runtime's session id (Claude's `session_id`, Codex's thread id), so a later run
   * can resume the session. run-start: the session the run resumed.
   */
  session?: string;
  /**
   * run-start: the short hash (`d:` and 12 hex digits) of the definitions the run started
   * with, when its task store has a `swarm.yaml` (W5).
   */
  defs?: string;
  /**
   * run-start: the variant of the definitions the run started with (W5). defs-propose,
   * defs-promote, defs-reject, defs-rollback: the variant proposed, promoted, rejected or rolled
   * back (W6).
   */
  variant?: string;
  /** defs-promote, defs-rollback: the short hashes of the store's definitions before and after. */
  defs_from?: string;
  defs_to?: string;
  /**
   * merge: the commit the base branch moved to. review: the HEAD commit of the checkout
   * `swarmup review` ran in, or the one `--commit` names (AO-0384).
   */
  commit?: string;
  /** merge: the branch the work came from. review: the checkout's branch, or `--branch`. */
  branch?: string;
  /**
   * review: whether the checkout it was sent from is the code repo or the task store's own repo
   * (AO-0384). Store work has nothing to merge. Older events and reviews sent from outside a
   * checkout have none; the merge reads their prose.
   */
  repo?: 'code' | 'store';
  /** merge: the base branch it went into. */
  into?: string;
  /**
   * review: the work the reviewer reads (W8): files at the reviewed commit, URLs, images and
   * documents. Older events have none.
   */
  artifacts?: ReviewArtifact[];
  /** publish: where the work went live. */
  url?: string;
  /** publish: the file published, from the top of the workspace, and its git blob at `commit`. */
  path?: string;
  blob?: string;
  /** publish: the tag swarmupd put on `commit` in the workspace, `published/<ID>`. */
  tag?: string;
  /**
   * publish-attempt: the publish adapter (`swarmupd.publish.<root>.<name>`) a person started, with
   * the workspace `commit` and the files (`artifacts`, with blobs) it was given. publish: the
   * adapter that published, when one did.
   */
  adapter?: string;
  /**
   * publish: how much the person changed the approved work before publishing it (W8 phase 3):
   * words, from the approved blob of each published file to its blob at `commit`. The
   * `post-approval-edits` scorer reads it.
   */
  edits?: PublishEdits;
  /**
   * comment by swarmupd (`opsd:merge`): it has nothing to merge for the approved task, so tasks
   * blocked on it stop waiting for a merge (AO-0228). A note on a merge that failed has none.
   */
  no_merge?: boolean;
  /**
   * ask, review: the decision the writer recommends, so the person can accept it as-is (AO-0065).
   * Older events have none.
   */
  recommend?: string;
  /**
   * review-fallback (by swarmupd): why it moved the open review to a reviewer of the author's
   * provider, such as `claude paused until 2026-11-18 17:00 UTC` (AO-0341). The request it moves
   * stays the task's last review. verdict: the same text, when the verdict closes such a review.
   */
  fallback?: string;
  /**
   * answer, unblock, approving verdict: the open tasks that waited on this decision when it was
   * written (AO-0068). For an answer or unblock the task itself comes first, then the tasks that
   * wait on it directly; for a verdict only those. Older events have none.
   *
   * Tasks that stay blocked until swarmupd merges the approved work are not on the verdict: the
   * `merge` event or `no_merge` comment of swarmupd (`opsd:merge`) that ends the wait lists them
   * (AO-0228).
   */
  freed?: string[];
  /** answer, unblock, approving verdict: the tasks that waited on `freed` at any depth. */
  freed_indirect?: string[];
  /** answer, unblock, verdict: minutes since the ask, block or review request it closes. */
  waited_minutes?: number;
  /**
   * answer, verdict on a request that carried a recommendation: whether the decision took it. An
   * answer takes it when its text is the recommendation; a verdict when it approves.
   */
  accepted?: boolean;
  /**
   * answer, verdict, comment, retype, park written with `--decision`: the id of the recorded
   * decision (`D-0042`) the event marks. The record names this event as its `source`.
   */
  decision?: string;
  /**
   * One approval's change to one key (AO-0110): `<plan-approve event id>#<key>`. On the event
   * that applies the change to the key's task, or with `plan_skip` on a comment of the milestone.
   */
  plan_apply?: string;
  /** comment on a milestone, with `plan_apply`: the key's task closed before the change applied. */
  plan_skip?: 'closed';
  /** plan-approve, plan-reject: the `plan` event it approves or rejects. */
  plan?: string;
  /** plan of a change: the latest `plan-approve` or `plan-amend` when it was written. */
  base?: string;
  /** plan-amend: what the new items are. */
  plan_kind?: 'subtask' | 'fix';
  /** criteria: the task's whole new `done_when` list. */
  done_when?: DoneWhenEntry[];
  /**
   * verdict, criteria-check, merge: results by criterion id. On a merge and on swarmupd's
   * send-back, the results of the `command` and `check` criteria it ran.
   */
  criteria?: CriteriaResults;
  /** criteria-check: `judge` when an LLM judge scored the `rubric` criteria it records (W7). */
  by?: string;
  body: string;
}

/** An event addressed to someone, kept in the index so inboxes need no event reads. */
export interface Addressed {
  event: string;
  type: string;
  actor: string;
  to: string;
  summary: string;
  /** The whole body (cut to 4000 characters) when it is longer than `summary`. */
  detail?: string;
  /** ask, review: the recommended decision (AO-0065). */
  recommend?: string;
}

export interface ReviewRequest {
  event: string;
  actor: string;
  at: string;
  body: string;
  /** The recommended decision (AO-0065). */
  recommend?: string;
  /** The source fields `swarmup review` recorded (AO-0384); older requests have none. */
  commit?: string;
  branch?: string;
  repo?: 'code' | 'store';
  /** Set when swarmupd moved the request to a reviewer of the author's provider (AO-0341). */
  fallback?: string;
}

/** Limits recorded by `swarmup delegate`; they stay with the task until the next delegation. */
export interface Delegation {
  by: string;
  to: string;
  at: string;
  budget_minutes?: number;
  tokens?: number;
  due?: string;
  review?: string;
}

/** Task state folded from task.md and its events. */
export interface TaskState {
  meta: TaskMeta;
  status: Status;
  owner: string | null;
  claimedBy: string | null;
  /** The token of the standing claim, when the claim carried one. */
  claimToken: string | null;
  leaseUntil: string | null;
  reviewer: string | null;
  /** blocked: the actor whose answer the task waits for. */
  waitingOn: string | null;
  /** blocked: the ask or block event that started the current wait. */
  waitEvent: string | null;
  /** blocked: the tasks this one waits on. */
  blockedOn: string[];
  /** blocked: who asked or blocked, so the answer goes back to them. */
  askedBy: string | null;
  checkpoint: { summary: string; next?: string; at: string } | null;
  lastEvent: string | null;
  updatedAt: string;
  eventCount: number;
  addressed: Addressed[];
  /** The latest review request: who asked, when, and its full text. */
  lastReview: ReviewRequest | null;
  /**
   * Claims that lost a race, and starts or releases written under a claim that had lost, by event
   * id. None of them changed the state.
   */
  lostClaims: string[];
  delegation: Delegation | null;
  /**
   * todo: when the task last became `todo` for its current owner (created, sent back, handed,
   * released or answered); null in any other status.
   */
  todoSince: string | null;
  /**
   * The newest verdict approves work that a review request names a branch for, and no `merge`
   * event or `no_merge` comment of swarmupd (`opsd:merge`) follows it: where swarmupd merges
   * approved work, the work is not in the base yet (AO-0228).
   */
  awaitsMerge: boolean;
  /** A milestone's plan; null for a task without plan events. */
  plan: PlanState | null;
  /**
   * A milestone with an approved plan waits for its plan tasks (AO-0110). Set by `plan-approve`,
   * `plan-amend` and a `reopen` with an effective plan; cleared when the milestone closes.
   */
  waitsOnPlan: boolean;
  /** The `plan_apply` markers on this task's events: the plan changes that reached it. */
  planApplied: string[];
  /**
   * The current criteria, ids settled: `done_when` of `task.md`, or of the latest `criteria`
   * event. Absent for a task without criteria or results.
   */
  criteria?: Criterion[];
  /** The latest result of each criterion, by id, with the event that recorded it. */
  criteriaResults?: Record<string, CriterionLast>;
}

/** What `derive` reads of a task's child for the plan rules. */
export interface PlanChild {
  id: string;
  status: Status;
  plan_item?: string;
  planApplied: string[];
}

/** The lookups `derive` needs for the plan rules: a task's children, and a plan task's milestone. */
export interface PlanLookup {
  /** The live tasks whose `parent` is `id`. */
  children(id: string): PlanChild[];
  /**
   * The archived tasks whose `parent` is `id`. Read only when a key of the plan has no live
   * task, so a milestone whose children are all live never reads the archive.
   */
  archivedChildren?(id: string): PlanChild[];
  /** The plan of milestone `id`, or null when there is none. */
  planOf(id: string): PlanState | null;
}

/** The actor swarmupd writes merge events, notes and send-backs as. */
export const MERGE_ACTOR = 'opsd:merge';

/**
 * Why an agent asks a person rather than the PM (`swarmup ask --reason`): the decisions only the
 * person can make. An ask to a person with one of these counts as a right escalation, whatever the
 * task's labels say.
 */
export const ASK_REASONS = [
  'direction', // a change of goal, scope or priority
  'access', // an account, credential, permission or payment only the person has
  'irreversible', // deleting data, publishing, releasing or another step that can't be undone
  'external', // an answer from someone outside, which only the person can get
] as const;
export type AskReason = (typeof ASK_REASONS)[number];

/** Task state after rules that need the clock or other tasks: leases and dependencies. */
export interface TaskView extends TaskState {
  root: string;
  /** The claim's lease ran out; the task is claimable again. */
  stale: boolean;
  /**
   * Every task this one waited on is closed, and merged where swarmupd merges its approved work;
   * the task is claimable again.
   */
  unblocked: boolean;
  /**
   * blocked: the tasks it waits on that are approved but not merged yet (AO-0228). For a
   * milestone that waits on its plan, its done children in that state.
   */
  mergeWait?: string[];
  /**
   * Milestone that waits on its plan: effective keys that have no task yet. The application
   * that creates them is incomplete, and each counts as open.
   */
  planMissing?: string[];
  /** Milestone that waits on its plan: keys of the plan's `diff` whose task has no marker yet. */
  planUnapplied?: string[];
  /** Milestone that waits on its plan: its open children. */
  planOpen?: string[];
  /**
   * Plan task: the `plan-approve` event whose change to this task's key is not applied yet. The
   * task is not claimable until `swarmup plan apply` finishes it.
   */
  planHold?: string;
  /** The task folder is under `archive/tasks/`. */
  archived?: boolean;
}
