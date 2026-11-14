import YAML from 'yaml';
import { assertActor, assertOwner, isHuman, OpsError, runtimeOf } from './ids.js';
import type { PlanItem, PlanState, Priority } from './model.js';
import { PLAN_ITEM_TYPES, PLAN_MAX_ITEMS, MILESTONE_TYPE, PRIORITIES } from './model.js';

/** A plan file: the items, and notes for whoever approves it. */
export interface PlanDoc {
  notes?: string;
  items: PlanItem[];
}

/**
 * What a plan file is for (AO-0110). `proposal` and `change` hold a full plan: the first one, or a
 * revision of the effective plan. `subtask` and `fix` hold new items only.
 */
export type PlanKind = 'proposal' | 'change' | 'subtask' | 'fix';

const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ESTIMATE_RE = /^([0-9]+)(m|h|d)$/;
/** A day of an estimate is a working day. */
const DAY_MINUTES = 8 * 60;

/** An estimate (`30m`, `2h`, `1d` = 8 h) in minutes. Refuses anything else with exit 2. */
export function estimateMinutes(text: string): number {
  const m = ESTIMATE_RE.exec(text.trim());
  const n = m ? Number(m[1]) : 0;
  if (!m || n <= 0) {
    throw new OpsError(
      `bad estimate '${text}': use minutes, hours or days, such as 30m, 2h, 1d`,
      2,
    );
  }
  return n * (m[2] === 'm' ? 1 : m[2] === 'h' ? 60 : DAY_MINUTES);
}

/** The estimates of `items`, summed, in minutes. */
export function planMinutes(items: readonly PlanItem[]): number {
  return items.reduce((sum, i) => sum + estimateMinutes(i.estimate), 0);
}

function bad(message: string): never {
  throw new OpsError(message, 2);
}

/** A required one-line text field of an item. */
function text(raw: Record<string, unknown>, field: string, where: string): string {
  const v = raw[field];
  if (v === undefined || v === null || v === '') bad(`${where} has no ${field}`);
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${where}: ${field} must be text`);
  const s = String(v).trim();
  if (!s) bad(`${where} has no ${field}`);
  return s;
}

function optional(raw: Record<string, unknown>, field: string, where: string): string | undefined {
  const v = raw[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' && typeof v !== 'number') bad(`${where}: ${field} must be text`);
  return String(v).trim() || undefined;
}

/** One item of a plan file, with each field checked on its own. */
function readItem(raw: unknown, n: number): PlanItem {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad(`item ${n} is not a mapping`);
  const data = raw as Record<string, unknown>;
  const key = text(data, 'key', `item ${n}`);
  if (!KEY_RE.test(key)) {
    bad(`bad key '${key}': use lowercase letters, digits, '-' and '_', 40 characters at most`);
  }
  const where = `item '${key}'`;
  const item: PlanItem = {
    key,
    title: text(data, 'title', where),
    owner: assertOwner(text(data, 'owner', where)),
    estimate: text(data, 'estimate', where),
  };
  estimateMinutes(item.estimate);
  if (data.after !== undefined && data.after !== null) {
    const after = Array.isArray(data.after) ? data.after : [data.after];
    if (after.some((a) => typeof a !== 'string' || !a.trim())) {
      bad(`${where}: after must be a list of keys`);
    }
    const keys = [...new Set(after.map((a) => (a as string).trim()))];
    if (keys.length > 0) item.after = keys;
  }
  const doneWhen = optional(data, 'done_when', where);
  if (doneWhen) {
    if (doneWhen.includes('\n')) bad(`${where}: done_when must be one line`);
    item.done_when = doneWhen;
  }
  const type = optional(data, 'type', where);
  if (type) {
    if (type === MILESTONE_TYPE)
      bad(`${where}: a plan item cannot be a milestone; plans do not nest`);
    if (!PLAN_ITEM_TYPES.includes(type)) {
      bad(`${where}: bad type '${type}': use ${PLAN_ITEM_TYPES.join(', ')}`);
    }
    item.type = type;
  }
  const priority = optional(data, 'priority', where);
  if (priority) {
    if (!PRIORITIES.includes(priority as Priority)) {
      bad(`${where}: bad priority '${priority}': use p0, p1, p2 or p3`);
    }
    item.priority = priority as Priority;
  }
  const review = optional(data, 'review', where);
  if (review) {
    // A wildcard names no provider, so nobody can tell whether it differs from the author's.
    item.review = assertActor(review, `reviewer (${where})`);
  }
  const body = optional(data, 'body', where);
  if (body) item.body = body;
  const serves = optional(data, 'for', where);
  if (serves) item.for = serves;
  return item;
}

function readDoc(data: unknown): PlanDoc {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    bad('a plan is a mapping with `items`');
  }
  const { notes, items } = data as { notes?: unknown; items?: unknown };
  if (!Array.isArray(items) || items.length === 0) bad('a plan needs at least one item in `items`');
  const doc: PlanDoc = { items: items.map((raw, i) => readItem(raw, i + 1)) };
  if (typeof notes === 'string' && notes.trim()) doc.notes = notes.trim();
  return doc;
}

/**
 * Reads a plan file (YAML) and checks each item on its own: the required fields (`key`, `title`,
 * `owner`, `estimate`), the estimate, the type, the priority, and a `review` that is a concrete
 * actor. Refuses with exit 2. `validatePlan` checks the items against each other and the plan.
 */
export function parsePlan(source: string): PlanDoc {
  let data: unknown;
  try {
    data = YAML.parse(source);
  } catch (err) {
    bad(`the plan is not valid YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  return readDoc(data);
}

/**
 * Checks a parsed plan file against itself and the milestone's plan so far (AO-0110, "The plan"
 * and "Used keys"). Refuses with exit 2; an amendment that only a human approval may make
 * (a used key, a `subtask` item without `for`) with exit 1 and `use --kind change`.
 *
 * - No duplicate `key`, no `after` that names no key, no cycle, 25 items at most.
 * - A non-human `review` comes from another provider than a concrete `owner`.
 * - `proposal`, `change`: a used key must still be in the effective plan; `for` only as the
 *   effective plan has it.
 * - `subtask`, `fix`: unused keys only. `after` may name keys of the effective plan. `for`
 *   (required for `subtask`) names an item of the effective plan that a human approved and that
 *   serves no other item, so the chain is one level deep.
 */
export function validatePlan(doc: PlanDoc, kind: PlanKind, plan: PlanState | null): void {
  const amend = kind === 'subtask' || kind === 'fix';
  const effective = new Map((plan?.items ?? []).map((i) => [i.key, i] as const));
  const used = new Set(plan?.usedKeys ?? []);
  if (amend && !plan?.approval) bad('an amendment needs an approved plan; propose one first');
  if (doc.items.length > PLAN_MAX_ITEMS) {
    bad(`${doc.items.length} items: a plan holds ${PLAN_MAX_ITEMS} at most; split the milestone`);
  }
  const own = new Map<string, PlanItem>();
  for (const item of doc.items) {
    if (own.has(item.key)) bad(`duplicate key '${item.key}'`);
    own.set(item.key, item);
  }
  for (const item of doc.items) {
    const where = `item '${item.key}'`;
    if (used.has(item.key)) {
      if (amend) {
        throw new OpsError(
          `key '${item.key}' is already used in this milestone's plan; an amendment adds new ` +
            'keys only: use --kind change',
        );
      }
      if (!effective.has(item.key)) {
        bad(`key '${item.key}' was used by an item that is no longer in the plan; pick a new key`);
      }
    }
    for (const a of item.after ?? []) {
      if (a === item.key) bad(`${where} waits for itself`);
      if (!own.has(a) && !(amend && effective.has(a))) bad(`${where}: after names no key '${a}'`);
    }
    if (
      item.review &&
      !isHuman(item.review) &&
      !item.owner.startsWith('*:') &&
      runtimeOf(item.review) === runtimeOf(item.owner)
    ) {
      bad(
        `${where}: the reviewer ${item.review} must come from another provider than the owner ` +
          `${item.owner}`,
      );
    }
    if (!amend) {
      if (item.for !== undefined && effective.get(item.key)?.for !== item.for) {
        bad(`${where}: \`for\` belongs to amendments (swarmup plan amend --kind subtask or fix)`);
      }
      continue;
    }
    if (item.for === undefined) {
      if (kind === 'subtask') {
        throw new OpsError(
          `${where} names no \`for\`: a subtask serves an approved item; use --kind change`,
        );
      }
      continue;
    }
    const target = effective.get(item.for);
    if (!target) bad(`${where}: for names no key '${item.for}' of the approved plan`);
    if (target.origin !== 'approve' || target.for !== undefined) {
      bad(
        `${where}: for names '${item.for}', which an amendment added; name an item a person ` +
          'approved',
      );
    }
  }
  const cycle = findCycle(own);
  if (cycle) bad(`the plan has a cycle: ${cycle.join(' -> ')}`);
}

/** The keys of one dependency cycle among `items`, first key repeated at the end, or null. */
function findCycle(items: Map<string, PlanItem>): string[] | null {
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    if (done.has(key)) return null;
    const at = path.indexOf(key);
    if (at >= 0) return [...path.slice(at), key];
    path.push(key);
    for (const a of items.get(key)?.after ?? []) {
      if (!items.has(a)) continue;
      const found = visit(a);
      if (found) return found;
    }
    path.pop();
    done.add(key);
    return null;
  };
  for (const key of items.keys()) {
    const found = visit(key);
    if (found) return found;
  }
  return null;
}

/** `parsePlan`, then `validatePlan`. */
export function checkPlan(source: string, kind: PlanKind, plan: PlanState | null): PlanDoc {
  const doc = parsePlan(source);
  validatePlan(doc, kind, plan);
  return doc;
}

const FENCE_RE = /^(`{3,})ya?ml[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/m;

/**
 * The body of a plan event: `text`, if any, then the plan as YAML in a fenced block. The fence is
 * longer than any run of backticks in the plan, so an item's body may hold code blocks.
 */
export function planBody(doc: PlanDoc, text = ''): string {
  const yaml = YAML.stringify({ ...(doc.notes ? { notes: doc.notes } : {}), items: doc.items });
  const longest = Math.max(2, ...(yaml.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const head = text.trim() ? `${text.trim()}\n\n` : '';
  return `${head}${fence}yaml\n${yaml.trimEnd()}\n${fence}\n`;
}

/**
 * The plan in a plan event's body, or null when the body holds no fenced YAML block or the block
 * is not a plan. The fold reads plans with it and skips an event it cannot read.
 */
export function readPlanBody(body: string): PlanDoc | null {
  const m = FENCE_RE.exec(body);
  if (!m) return null;
  try {
    return readDoc(YAML.parse(m[2]!));
  } catch {
    return null;
  }
}
