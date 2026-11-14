import type {
  EffectivePlanItem,
  OpsEvent,
  PlanChild,
  PlanLookup,
  PlanState,
  Status,
  TaskMeta,
  TaskState,
  TaskView,
} from './model.js';
import { MERGE_ACTOR, OPEN_STATUSES, PLAN_CHECKER } from './model.js';
import { planChangedKeys, readPlanBody } from './plan.js';
import { reviewSources } from './review-source.js';
import { ownerMatches } from './ids.js';
import { ulidTime } from './ulid.js';

const DEFAULT_CLAIM_MS = 60 * 60_000;
const DEFAULT_WORK_MS = 240 * 60_000;
const SUMMARY_LEN = 160;
/** A review request keeps its full text up to this length, for the reviewer's inbox. */
const REVIEW_LEN = 4000;

/** The first line of an event body, cut to fit one inbox or list line. */
export function summaryLine(body: string): string {
  const line = body.trim().split('\n')[0] ?? '';
  return line.length > SUMMARY_LEN ? `${line.slice(0, SUMMARY_LEN - 1)}…` : line;
}

/**
 * The whole event body, trimmed and cut to `REVIEW_LEN`, when it says more than its summary
 * line: the inbox renders it as Markdown (AO-0143). Undefined for a one-line body.
 */
export function detailText(body: string): string | undefined {
  const text = body.trim();
  return summaryLine(text) === text ? undefined : text.slice(0, REVIEW_LEN);
}

function eventTime(e: OpsEvent): number {
  return Date.parse(e.at) || ulidTime(e.id);
}

function leaseFrom(e: OpsEvent, fallbackMs: number): string {
  return e.lease_until ?? new Date(eventTime(e) + fallbackMs).toISOString();
}

function leaseLive(state: TaskState, atMs: number): boolean {
  return state.leaseUntil !== null && Date.parse(state.leaseUntil) > atMs;
}

/**
 * Folds a task's events into its current state. Events apply in id (ULID) order, which every
 * machine computes the same way, so all machines agree on the result after a sync.
 *
 * The fold records what happened; permission checks live in the write path. The one rule it
 * enforces is the claim race: a claim stands only when the task is free at that point, and a
 * start or release applies only while the holder it was written under still holds the claim.
 * Sync renames unpushed events after the ones that came from the remote, so this order is the
 * push order across machines.
 */
export function fold(meta: TaskMeta, events: OpsEvent[]): TaskState {
  const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const s: TaskState = {
    meta,
    status: 'todo',
    owner: meta.owner || null,
    claimedBy: null,
    claimToken: null,
    leaseUntil: null,
    reviewer: null,
    waitingOn: null,
    waitEvent: null,
    blockedOn: [],
    askedBy: null,
    checkpoint: null,
    lastEvent: null,
    updatedAt: meta.created_at,
    eventCount: sorted.length,
    addressed: [],
    lastReview: null,
    lostClaims: [],
    delegation: null,
    todoSince: meta.created_at,
    awaitsMerge: false,
    plan: null,
    waitsOnPlan: false,
    planApplied: [],
  };
  // The `plan` events so far, by id: who proposed each.
  const proposals = new Map<string, { actor: string; base?: string }>();
  // The `plan` events a `plan-approve` or `plan-reject` cites.
  const cited = new Set<string>();
  const planState = (): PlanState =>
    (s.plan ??= {
      items: [],
      approval: null,
      head: null,
      planner: null,
      pending: null,
      usedKeys: [],
      diff: [],
      skipped: [],
    });
  const useKeys = (plan: PlanState, items: EffectivePlanItem[]): void => {
    for (const i of items) if (!plan.usedKeys.includes(i.key)) plan.usedKeys.push(i.key);
  };
  // A plan-approve or plan-amend blocks the milestone on its plan in the same write.
  const waitOnPlan = (): void => {
    if (!OPEN_STATUSES.has(s.status)) return;
    s.waitsOnPlan = true;
    s.status = 'blocked';
    clearClaim();
    clearWait();
  };
  // handoff, delegate, reopen with `on`: the task waits on those tasks under its new owner.
  const blockOn = (e: OpsEvent): void => {
    if (!e.on || e.on.length === 0 || !OPEN_STATUSES.has(s.status)) return;
    s.status = 'blocked';
    s.blockedOn = [...e.on];
    s.waitEvent = e.id;
    s.askedBy = e.actor;
  };
  // Whether a review request so far names a branch: what swarmupd looks for to merge.
  let namesBranch = false;
  if (meta.blocked_by && meta.blocked_by.length > 0) {
    s.status = 'blocked';
    s.blockedOn = [...meta.blocked_by];
    s.todoSince = null;
  }

  const clearClaim = (): void => {
    s.claimedBy = null;
    s.claimToken = null;
    s.leaseUntil = null;
  };
  // Whether an event written under a claim still belongs to the standing claim.
  const underStandingClaim = (e: OpsEvent): boolean =>
    e.holder === undefined || e.holder === s.claimToken;
  const clearWait = (): void => {
    s.waitingOn = null;
    s.waitEvent = null;
    s.blockedOn = [];
    s.askedBy = null;
  };

  for (const e of sorted) {
    const at = eventTime(e);
    const before = { status: s.status, owner: s.owner };
    s.lastEvent = e.id;
    s.updatedAt = e.at;
    if (e.to) {
      s.addressed.push({
        event: e.id,
        type: e.type,
        actor: e.actor,
        to: e.to,
        summary: summaryLine(e.body),
        ...(detailText(e.body) !== undefined ? { detail: detailText(e.body) } : {}),
        ...(e.recommend ? { recommend: e.recommend } : {}),
      });
    }
    // Only the merge itself, or swarmupd's word that it has nothing to merge, settles an approval's
    // merge. A note on a merge that failed leaves the work out of the base, so it settles nothing;
    // a send-back is a verdict, handled below.
    if (e.actor === MERGE_ACTOR && (e.type === 'merge' || e.no_merge)) s.awaitsMerge = false;
    if (e.plan_apply) {
      if (e.type === 'comment' && e.plan_skip) {
        // On the milestone: the key's task closed before this approval's change reached it.
        const [approval, key] = splitMarker(e.plan_apply);
        if (s.plan && approval === s.plan.approval && key && !s.plan.skipped.includes(key)) {
          s.plan.skipped.push(key);
        }
      } else if (!s.planApplied.includes(e.plan_apply)) {
        s.planApplied.push(e.plan_apply);
      }
    }
    switch (e.type) {
      case 'plan': {
        // A full proposed plan. It folds no state: the first proposal's `review` event does.
        if (!readPlanBody(e.body)) break;
        planState();
        proposals.set(e.id, { actor: e.actor, ...(e.base ? { base: e.base } : {}) });
        break;
      }
      case 'plan-approve': {
        const doc = readPlanBody(e.body);
        if (!doc) break;
        const plan = planState();
        const first = plan.approval === null;
        const items = doc.items.map((i): EffectivePlanItem => ({ ...i, origin: 'approve' }));
        // Existing items this approval removes, hands to another owner or reorders. An estimate
        // lives in the plan only, so it changes no task.
        plan.diff = planChangedKeys(plan.items, items);
        plan.skipped = [];
        plan.items = items;
        plan.approval = e.id;
        plan.head = e.id;
        useKeys(plan, items);
        if (e.plan) {
          cited.add(e.plan);
          plan.planner = proposals.get(e.plan)?.actor ?? plan.planner;
        }
        if (first && OPEN_STATUSES.has(s.status)) {
          // The milestone now belongs to whoever checks `done_when` when its tasks close.
          s.owner = PLAN_CHECKER;
          s.reviewer = null;
        }
        waitOnPlan();
        break;
      }
      case 'plan-amend': {
        const doc = readPlanBody(e.body);
        // New items only, after an approval; anything else is not an amendment.
        if (!doc || !s.plan?.approval) break;
        const plan = s.plan;
        const origin = e.plan_kind === 'fix' ? 'fix' : 'subtask';
        const items = doc.items
          .filter((i) => !plan.usedKeys.includes(i.key))
          .map((i): EffectivePlanItem => ({ ...i, origin }));
        plan.items = [...plan.items, ...items];
        plan.head = e.id;
        useKeys(plan, items);
        waitOnPlan();
        break;
      }
      case 'plan-reject': {
        if (!e.plan || !proposals.has(e.plan)) break;
        cited.add(e.plan);
        // Sending back the first proposal folds like `verdict changes`. A rejected change
        // proposal leaves the milestone blocked on the plan it has.
        if (s.plan?.approval === null && s.status === 'needs-review') {
          s.status = 'todo';
          s.reviewer = null;
          clearClaim();
        }
        break;
      }
      case 'claim': {
        const free =
          s.status === 'todo' || (s.status === 'claimed' && !leaseLive(s, at) && s.claimedBy);
        const expiredWork = s.status === 'in-progress' && !leaseLive(s, at);
        if (free || expiredWork) {
          s.status = 'claimed';
          s.claimedBy = e.actor;
          s.claimToken = e.token ?? null;
          s.leaseUntil = leaseFrom(e, DEFAULT_CLAIM_MS);
        } else {
          s.lostClaims.push(e.id);
        }
        break;
      }
      case 'start':
        if (!underStandingClaim(e) && !e.forced) {
          s.lostClaims.push(e.id);
          break;
        }
        s.status = 'in-progress';
        s.claimedBy = s.claimedBy ?? e.actor;
        s.leaseUntil = leaseFrom(e, DEFAULT_WORK_MS);
        break;
      case 'progress':
      case 'renew':
        if (s.claimedBy === e.actor && underStandingClaim(e)) {
          s.leaseUntil = leaseFrom(e, DEFAULT_WORK_MS);
        }
        break;
      case 'checkpoint':
        s.checkpoint = { summary: e.body.trim(), next: e.next, at: e.at };
        if (s.claimedBy === e.actor && underStandingClaim(e)) {
          s.leaseUntil = leaseFrom(e, DEFAULT_WORK_MS);
        }
        break;
      case 'release':
        if (!underStandingClaim(e) && !e.forced) {
          s.lostClaims.push(e.id);
          break;
        }
        s.status = 'todo';
        clearClaim();
        break;
      case 'handoff':
      case 'assign':
        if (e.to) s.owner = e.to;
        if (e.type === 'assign' && e.keep_wait && s.status === 'blocked') {
          // The task changes hands but still waits: the question stays open for its addressee.
          clearClaim();
          s.reviewer = null;
          break;
        }
        if (OPEN_STATUSES.has(s.status)) s.status = 'todo';
        clearClaim();
        clearWait();
        s.reviewer = null;
        // A handoff, or an assign of a plan task, carries the waits the task keeps (AO-0110).
        blockOn(e);
        break;
      case 'delegate':
        if (e.to) s.owner = e.to;
        if (OPEN_STATUSES.has(s.status)) s.status = 'todo';
        clearClaim();
        clearWait();
        blockOn(e);
        s.reviewer = null;
        s.delegation = {
          by: e.actor,
          to: e.to ?? '',
          at: e.at,
          budget_minutes: e.budget_minutes,
          tokens: e.tokens,
          due: e.due,
          review: e.review,
        };
        break;
      case 'review':
        s.status = 'needs-review';
        s.reviewer = e.to ?? null;
        s.lastReview = {
          event: e.id,
          actor: e.actor,
          at: e.at,
          body: e.body.trim().slice(0, REVIEW_LEN),
          ...(e.recommend ? { recommend: e.recommend } : {}),
        };
        clearClaim();
        if (!namesBranch) {
          const src = reviewSources(e.body);
          namesBranch = !!src.named || src.loose.length > 0;
        }
        break;
      case 'verdict':
        s.status = e.verdict === 'approve' ? 'done' : 'todo';
        s.awaitsMerge = e.verdict === 'approve' && e.actor !== MERGE_ACTOR && namesBranch;
        s.reviewer = null;
        clearClaim();
        break;
      case 'done':
        s.status = 'done';
        clearClaim();
        clearWait();
        break;
      case 'park':
        s.status = 'parked';
        clearClaim();
        clearWait();
        break;
      case 'reopen':
        s.status = 'todo';
        clearClaim();
        clearWait();
        // A plan task comes back under its plan owner and dependencies (AO-0110); a milestone
        // with an effective plan waits on it again.
        if (e.to) s.owner = e.to;
        blockOn(e);
        if (s.plan?.approval) waitOnPlan();
        break;
      case 'ask':
        // The addressee of an open ask forwards it (the PM to the person, AO-0173): the answer
        // still goes to whoever asked first.
        if (!(s.status === 'blocked' && s.askedBy && ownerMatches(s.waitingOn, e.actor))) {
          s.askedBy = e.actor;
        }
        s.status = 'blocked';
        s.waitingOn = e.to ?? null;
        s.waitEvent = e.id;
        s.blockedOn = [];
        clearClaim();
        break;
      case 'block':
        s.status = 'blocked';
        s.askedBy = e.actor;
        s.waitEvent = e.id;
        if (e.on && e.on.length > 0) {
          s.blockedOn = [...e.on];
          s.waitingOn = null;
        } else {
          s.waitingOn = e.to ?? null;
          s.blockedOn = [];
        }
        clearClaim();
        break;
      case 'answer':
      case 'unblock':
        if (s.status === 'blocked') s.status = 'todo';
        clearWait();
        break;
      case 'priority':
        if (e.priority) s.meta = { ...s.meta, priority: e.priority };
        break;
      case 'retype':
        if (e.task_type) s.meta = { ...s.meta, type: e.task_type };
        break;
      default:
        break;
    }
    if (s.status !== 'todo') s.todoSince = null;
    else if (before.status !== 'todo' || before.owner !== s.owner) s.todoSince = e.at;
    // done, park and an approving verdict close the milestone: it waits on nothing any more.
    if (!OPEN_STATUSES.has(s.status)) s.waitsOnPlan = false;
  }
  if (s.plan) {
    const plan = s.plan;
    // The pending proposal: the latest `plan` event that no approval or rejection cites.
    const open = [...proposals.keys()].filter((id) => !cited.has(id)).pop();
    const p = open ? proposals.get(open)! : null;
    plan.pending =
      open && p
        ? {
            event: open,
            actor: p.actor,
            ...(p.base ? { base: p.base } : {}),
            stale: p.base !== undefined && p.base !== plan.head,
          }
        : null;
  }
  return s;
}

/** `<plan-approve event id>#<key>` as its two parts. */
function splitMarker(marker: string): [string, string] {
  const at = marker.indexOf('#');
  return at < 0 ? [marker, ''] : [marker.slice(0, at), marker.slice(at + 1)];
}

/**
 * The plan lookups of `derive` over the folded tasks of one root. `states` is the root's live
 * tasks; `archived` reads its archived ones, and runs only for a task that has a plan or a
 * `plan_item`, at most once.
 */
export function planLookup(
  states: readonly TaskState[],
  archived: () => readonly TaskState[] = () => [],
): PlanLookup {
  const index = (list: readonly TaskState[]): Map<string, PlanChild[]> => {
    const out = new Map<string, PlanChild[]>();
    for (const s of list) {
      if (!s.meta.parent) continue;
      const kids = out.get(s.meta.parent);
      if (kids) kids.push(planChild(s));
      else out.set(s.meta.parent, [planChild(s)]);
    }
    return out;
  };
  let old: readonly TaskState[] | undefined;
  const archive = (): readonly TaskState[] => {
    if (old) return old;
    const live = new Set(states.map((s) => s.meta.id));
    // A task in both folders is live.
    old = archived().filter((s) => !live.has(s.meta.id));
    return old;
  };
  let liveKids: Map<string, PlanChild[]> | undefined;
  let oldKids: Map<string, PlanChild[]> | undefined;
  let byId: Map<string, TaskState> | undefined;
  return {
    children: (id) => (liveKids ??= index(states)).get(id) ?? [],
    archivedChildren: (id) => (oldKids ??= index(archive())).get(id) ?? [],
    planOf(id) {
      byId ??= new Map(states.map((s) => [s.meta.id, s] as const));
      const s = byId.get(id) ?? archive().find((a) => a.meta.id === id);
      return s?.plan ?? null;
    },
  };
}

/** A folded task as the plan rules of `derive` read a child. */
export function planChild(s: TaskState): PlanChild {
  return {
    id: s.meta.id,
    status: s.status,
    ...(s.meta.plan_item ? { plan_item: s.meta.plan_item } : {}),
    planApplied: s.planApplied,
  };
}

/**
 * Applies the rules that need the clock or other tasks: expired leases and finished dependencies.
 * `mergePending` says whether a dependency is approved work that swarmupd on this machine still
 * has to merge; such a dependency is closed but does not free the task yet (AO-0228).
 *
 * `plans` gives the plan rules (AO-0110) their lookups. A milestone that waits on its plan shows
 * `blocked` while a key of the effective plan has no task, a change of the latest approval has
 * not reached its task, a child is open, or a done child still waits for its merge; after that
 * it is unblocked, for the check. A plan task gets `planHold` while the latest approval's change
 * to its key is not applied. Without `plans`, neither rule runs.
 */
export function derive(
  state: TaskState,
  root: string,
  nowMs: number,
  statusOf: (id: string) => Status | undefined,
  mergePending: (id: string) => boolean = () => false,
  plans?: PlanLookup,
): TaskView {
  const view: TaskView = { ...state, root, stale: false, unblocked: false };
  if (
    (state.status === 'claimed' || state.status === 'in-progress') &&
    state.leaseUntil &&
    Date.parse(state.leaseUntil) <= nowMs
  ) {
    view.stale = true;
  }
  if (state.status === 'blocked' && state.blockedOn.length > 0) {
    const allClosed = state.blockedOn.every((id) => {
      const st = statusOf(id);
      return st === 'done' || st === 'parked';
    });
    // A parked dependency is closed for good, whatever its last verdict said.
    const unmerged = allClosed
      ? state.blockedOn.filter((id) => statusOf(id) === 'done' && mergePending(id))
      : [];
    if (unmerged.length > 0) view.mergeWait = unmerged;
    else if (allClosed) view.unblocked = true;
  }
  if (plans && state.waitsOnPlan && state.plan)
    waitOnChildren(view, state.plan, plans, mergePending);
  // Only an open task can be claimed, so only an open one is held.
  if (plans && state.meta.plan_item && OPEN_STATUSES.has(state.status)) {
    const [milestone, key] = splitMarker(state.meta.plan_item);
    const plan = plans.planOf(milestone);
    if (
      plan?.approval &&
      plan.diff.includes(key) &&
      !plan.skipped.includes(key) &&
      !state.planApplied.includes(`${plan.approval}#${key}`)
    ) {
      view.planHold = plan.approval;
    }
  }
  return view;
}

/** The milestone rule of `derive`: what of its plan a milestone still waits for. */
function waitOnChildren(
  view: TaskView,
  plan: PlanState,
  plans: PlanLookup,
  mergePending: (id: string) => boolean,
): void {
  let kids = plans.children(view.meta.id);
  const byItem = new Map<string, PlanChild>();
  for (const k of kids) if (k.plan_item) byItem.set(k.plan_item, k);
  const item = (key: string): string => `${view.meta.id}#${key}`;
  // A key without a live task: its task may be archived, which is closed, not missing. That
  // holds for a changed or removed key of the latest approval too: an archived task still needs
  // its marker or the milestone's `plan_skip`.
  const noLive = (key: string): boolean => !byItem.has(item(key));
  if (
    plans.archivedChildren &&
    (plan.items.some((i) => noLive(i.key)) ||
      plan.diff.some((key) => !plan.skipped.includes(key) && noLive(key)))
  ) {
    kids = [...kids, ...plans.archivedChildren(view.meta.id)];
    for (const k of kids) if (k.plan_item && !byItem.has(k.plan_item)) byItem.set(k.plan_item, k);
  }
  const missing = plan.items.filter((i) => !byItem.has(item(i.key))).map((i) => i.key);
  // A diff key without a task has nothing to change: a removed item whose task was never made.
  const unapplied = plan.diff.filter((key) => {
    const kid = byItem.get(item(key));
    return (
      !!kid && !plan.skipped.includes(key) && !kid.planApplied.includes(`${plan.approval}#${key}`)
    );
  });
  const open = kids.filter((k) => OPEN_STATUSES.has(k.status)).map((k) => k.id);
  // A parked child is closed for good; a done one counts as open until its merge wait settles.
  const merging = kids.filter((k) => k.status === 'done' && mergePending(k.id)).map((k) => k.id);
  if (missing.length > 0) view.planMissing = missing;
  if (unapplied.length > 0) view.planUnapplied = unapplied;
  if (open.length > 0) view.planOpen = open;
  const settled = missing.length + unapplied.length + open.length + merging.length === 0;
  // Blocked by the plan itself, not by a question or a `block` written on top of it.
  const byPlan =
    view.status === 'blocked' &&
    view.waitingOn === null &&
    view.waitEvent === null &&
    view.blockedOn.length === 0;
  if (!byPlan && view.status !== 'todo') {
    // A question or a `block` on top keeps its own wait, but a closed dependency of that
    // `block` never frees the milestone while its plan is unsettled.
    if (!settled) view.unblocked = false;
    return;
  }
  if (merging.length > 0) view.mergeWait = merging;
  if (!settled) {
    // A reopened child or a new amendment blocks a milestone that was free for its check.
    view.status = 'blocked';
    view.unblocked = false;
    view.todoSince = null;
  } else if (byPlan) view.unblocked = true;
}

/** True when anyone allowed to own the task may claim it now. */
export function isClaimable(v: TaskView): boolean {
  if (v.planHold) return false;
  return v.status === 'todo' || v.stale || v.unblocked;
}
