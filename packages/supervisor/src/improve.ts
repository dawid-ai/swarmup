// The self-improvement loop (W6): scorer failures, and learn notes that keep mattering, become
// tasks for the improver, whose proposals (variant overlays recorded with `swarmup defs propose`)
// swarmupd benchmarks, base against variant, before a person promotes or rejects them. Nothing
// here changes a definition file: only a person's `swarmup defs promote` does.
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type {
  DefsProposeResult,
  ImprovementPolicy,
  PromoteCandidate,
  TaskMeta,
  VariantInfo,
  Workspace,
} from '@swarmup/core';
import {
  IMPROVE_BENCH_ACTOR,
  improvementPolicy,
  isHuman,
  listVariantNames,
  loadDefinitions,
  normalText,
  OPEN_STATUSES,
  OpsError,
  requiresProblems,
  shortHash,
  VARIANT_NAME_RE,
} from '@swarmup/core';
import type { BenchRunRequest, BenchRunView } from './bench-runs.js';
import type { Comparison, SummaryOverall } from './bench.js';
import { compareMarkdown } from './bench.js';
import type { ImproveConfig } from './config.js';
import { lineDiff } from './defs-import.js';
import type { RunRecord } from './runs.js';
import type { ScoreResult } from './scores.js';
import { scorerCatalog } from './scores.js';

/** The actor swarmupd files improvement tasks and benchmark results as. */
export const IMPROVE_ACTOR = IMPROVE_BENCH_ACTOR;

/** The label of an improvement task. */
export const IMPROVE_LABEL = 'improve';

/** One agent's failing scores. */
export interface AgentFailures {
  agent: string;
  /** Distinct failing subjects: tasks (`root/ID`) and runs. */
  subjects: string[];
  /** The failing scores, by scorer, worst first. */
  byScorer: Array<{ scorer: string; results: ScoreResult[] }>;
}

/**
 * Each agent's failing task and run scores whose `at` falls in the last `maxAgeDays` days (all of
 * them without a window), by agent. People and swarmupd itself are left out.
 */
export function failingByAgent(
  results: readonly ScoreResult[],
  opts: { now: number; maxAgeDays?: number },
): AgentFailures[] {
  const since = opts.maxAgeDays ? opts.now - opts.maxAgeDays * 86_400_000 : -Infinity;
  const by = new Map<string, Map<string, ScoreResult[]>>();
  for (const r of results) {
    if (r.pass !== false || (r.level !== 'task' && r.level !== 'run')) continue;
    if (!r.agent || isHuman(r.agent) || r.agent.startsWith('opsd:')) continue;
    const at = Date.parse(r.at);
    if (Number.isFinite(at) && at < since) continue;
    const m = by.get(r.agent) ?? new Map<string, ScoreResult[]>();
    m.set(r.scorer, [...(m.get(r.scorer) ?? []), r]);
    by.set(r.agent, m);
  }
  return [...by]
    .map(([agent, m]) => ({
      agent,
      subjects: [...new Set([...m.values()].flat().map((r) => r.subject))].sort(),
      byScorer: [...m]
        .map(([scorer, list]) => ({
          scorer,
          results: [...list].sort((a, b) => b.at.localeCompare(a.at)),
        }))
        .sort((a, b) => b.results.length - a.results.length || a.scorer.localeCompare(b.scorer)),
    }))
    .sort((a, b) => a.agent.localeCompare(b.agent));
}

const value = (r: ScoreResult): string =>
  r.unit === 'ratio' ? `${Math.round(r.value * 100)}%` : `${r.value} ${r.unit}`;

/**
 * The body of an improvement task: the failing scorers with their values, levers and evidence,
 * the `Agent:`, `Scorers:` and `Evidence:` lines `swarmup defs propose` reads, and the steps.
 */
export function improveTaskBody(f: AgentFailures, opts: { maxAgeDays?: number } = {}): string {
  const levers = new Map(scorerCatalog().map((s) => [s.id, s.lever]));
  const evidence = [...new Set(f.byScorer.flatMap((s) => s.results.map((r) => r.subject)))].slice(
    0,
    20,
  );
  const lines = [
    `swarmupd found ${f.subjects.length} task(s) and run(s) where ${f.agent}'s scores fail` +
      (opts.maxAgeDays ? ` in the last ${opts.maxAgeDays} days.` : '.'),
    '',
    `Agent: ${f.agent}`,
    `Scorers: ${f.byScorer.map((s) => s.scorer).join(', ')}`,
    `Evidence: ${evidence.join(', ')}`,
    '',
    '| Scorer | Failing | Values | Lever |',
    '| --- | --- | --- | --- |',
    ...f.byScorer.map(
      (s) =>
        `| ${s.scorer} | ${s.results.length} | ${s.results
          .slice(0, 5)
          .map((r) => `${r.subject.slice(r.subject.indexOf('/') + 1)} ${value(r)}`)
          .join(', ')} | ${levers.get(s.scorer) ?? '-'} |`,
    ),
    '',
    'Steps:',
    `1. Read \`swarmup scores --agent ${f.agent}\` and the threads of the evidence tasks (\`swarmup show ID\`).`,
    `2. Read ${f.agent}'s role file and find the pattern behind the failures.`,
    '3. Write the smallest overlay that addresses it in your scratch folder, laid out as the',
    '   definitions are (`agents/<runtime>-<role>.md`, or `agents/<role>/agent.md` with addenda',
    '   `agents/<role>/<runtime>.md`), and check it with `swarmup validate`.',
    '4. Record it: `swarmup defs propose ID --dir DIR --name NAME -m "why"`, then send this task to',
    '   the person for review.',
  ];
  return lines.join('\n');
}

/** A promotion candidate as `Workspace.kbPromote` lists it, with the ref `kb --read` takes. */
export type NoteCandidate = PromoteCandidate & { ref: string };

/**
 * The body of a learn-note improvement task (W6): the notes that keep mattering to `agent`, with
 * why, the `Agent:` and `Notes:` lines `swarmup defs propose` and `defs promote` read, and the
 * steps: fold the notes into the role file as short rules, then name them in the proposal.
 */
export function improveNotesBody(
  agent: string,
  notes: readonly NoteCandidate[],
  opts: { days?: number } = {},
): string {
  const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const lines = [
    `swarmupd found ${notes.length} learn note(s) that keep mattering to ${agent}` +
      (opts.days ? ` in the last ${opts.days} days.` : '.') +
      ' A rule in the role file reaches every run of the role; a note reaches only the runs whose' +
      ' prompt lists it.',
    '',
    `Agent: ${agent}`,
    `Notes: ${notes.map((n) => n.ref).join(', ')}`,
    '',
    '| Note | Title | Why |',
    '| --- | --- | --- |',
    ...notes.map((n) => `| \`${n.ref}\` | ${cell(n.note.title)} | ${cell(n.why.join('; '))} |`),
    '',
    'Steps:',
    '1. Read each note: `swarmup kb --read REF`.',
    `2. Read ${agent}'s role file and check which lessons it already states.`,
    '3. Fold each lesson that still holds into the role file as one short rule the agent acts on,',
    '   in an overlay in your scratch folder (`agents/<runtime>-<role>.md`, or',
    '   `agents/<role>/agent.md` with addenda `agents/<role>/<runtime>.md`), and check it with',
    '   `swarmup validate`. Leave out a note that no longer holds or that a tool or check should',
    '   enforce, and say why.',
    '4. Record it: `swarmup defs propose ID --dir DIR --name NAME -m "why"`, with a line',
    '   `Notes: REF, REF` in the message naming the notes the change folds in, then send this task',
    '   to the person for review. After the promote, the person archives those notes with',
    '   `swarmup kb archive REF... -m "folded into NAME"`.',
  ];
  return lines.join('\n');
}

/** One proposal's benchmark: base against variant on the configured set. */
export interface GateState {
  root: string;
  variant: string;
  hash: string;
  task: string;
  agent?: string;
  state: 'running' | 'done' | 'failed' | 'skipped';
  /** The bench run ids of the base and the variant. */
  base?: string;
  run?: string;
  verdict?: 'better' | 'worse' | 'same';
  /** Variant minus base, overall over the shared entries. */
  delta?: Partial<Record<keyof SummaryOverall, number | null>>;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  /** The result comment is on the task. */
  commented?: boolean;
}

/** What swarmupd keeps of the loop in its state folder (`improve.json`). */
export interface ImproveState {
  /** When the trigger last looked at the scores (ms). */
  checkedAt?: number;
  /** Benchmarks by `root/variant@hash`. */
  gates: Record<string, GateState>;
}

/** Better, worse or the same: the pass rate first, then the hidden pass rate. */
export function benchVerdict(c: Comparison): Pick<GateState, 'verdict' | 'delta'> {
  const d = c.overall.delta;
  const eps = 1e-9;
  const pass = d.passRate ?? 0;
  const hidden = d.hiddenPassRate ?? 0;
  const verdict =
    pass > eps
      ? 'better'
      : pass < -eps
        ? 'worse'
        : hidden > eps
          ? 'better'
          : hidden < -eps
            ? 'worse'
            : 'same';
  return {
    verdict,
    delta: {
      passRate: d.passRate,
      hiddenPassRate: d.hiddenPassRate,
      costPerAttempt: d.costPerAttempt,
      wallMs: d.wallMs,
    },
  };
}

/** What the loop needs of swarmupd. */
export interface ImproveHost {
  now(): number;
  config(): ImproveConfig;
  /** A workspace acting as `actor`. */
  ws(actor?: string): Workspace;
  /** The kept scores. */
  scores(): ScoreResult[];
  runs(): RunRecord[];
  bench: {
    start(req: BenchRunRequest): { id?: string };
    run(id: string): BenchRunView | undefined;
    compare(a: string, b: string): Comparison;
  };
  readState(): ImproveState;
  writeState(state: ImproveState): void;
  warn(message: string): void;
}

/** A proposal as the app lists it: the variant, its diff, and its benchmark. */
export interface ProposalView extends VariantInfo {
  root: string;
  /** Per changed file, the `+` and `-` lines against the base. */
  diffs: Array<{ path: string; kind: string; lines: string[] }>;
  benchmark?: GateState;
  /**
   * The store's `improvement.requires` and why it refuses a promote now (empty when it would
   * pass). Absent for a variant from a git ref, which is never promoted.
   */
  requires?: ImprovementPolicy['requires'] & { problems: string[] };
}

/** The improver as the app shows it: this machine's loop and each store's policy. */
export interface ImproveStatus {
  /** `swarmupd.improve.enabled`: files improvement tasks from failing scores on its own. */
  enabled: boolean;
  /** `swarmupd.improve.notes`: files one for learn notes that keep mattering. */
  notes: boolean;
  agent: string;
  threshold: number;
  max_age_days: number;
  check_hours: number;
  /** `swarmupd.improve.benchmark`: the set each proposal is replayed on; null when off. */
  benchmark: { set: string; repo: string; repeat: number; entries?: string[] } | null;
  /** Per store, `improvement` in `swarm.yaml` with defaults, and the proposals that wait. */
  roots: Array<{ root: string; policy: ImprovementPolicy; open: number }>;
}

/** What a person sends to propose a change to an agent's role file by hand. */
export interface HandProposal {
  agent: string;
  /** The role file's new text, whole. */
  text: string;
  /** Why: the proposal's message. */
  message: string;
  /** The linked task; without one, an improvement task is filed for the person. */
  task?: string;
  /** The variant name; by default `<role>-by-hand`, numbered when taken. */
  name?: string;
}

export class Improver {
  private readonly told = new Set<string>();

  constructor(private readonly host: ImproveHost) {}

  private state(): ImproveState {
    try {
      const s = this.host.readState();
      return { ...s, gates: s.gates ?? {} };
    } catch {
      return { gates: {} };
    }
  }

  private warnOnce(key: string, message: string): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.host.warn(message);
  }

  /** The open improvement task for `agent`, as `root/ID`, if one exists. */
  private openTask(ws: Workspace, agent: string): string | undefined {
    const v = ws
      .views()
      .find(
        (t) =>
          (t.meta.labels ?? []).includes(IMPROVE_LABEL) &&
          OPEN_STATUSES.has(t.status) &&
          t.meta.title.startsWith(`Improve ${agent}:`),
      );
    return v ? `${v.root}/${v.meta.id}` : undefined;
  }

  /** The root most of an agent's failing subjects belong to. */
  private rootOf(ws: Workspace, f: AgentFailures): string | undefined {
    const runs = new Map(this.host.runs().map((r) => [r.id, r.root]));
    const counts = new Map<string, number>();
    for (const s of f.subjects) {
      const root = s.includes('/') ? s.slice(0, s.indexOf('/')) : runs.get(s);
      if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
    }
    const own = ws.roots.filter((r) => !r.isMirror).map((r) => r.name);
    const best = [...counts]
      .filter(([r]) => own.includes(r))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return best?.[0] ?? own[0];
  }

  /** Files the improvement task for `f` as `actor`. */
  private file(ws: Workspace, f: AgentFailures, maxAgeDays?: number): TaskMeta {
    const cfg = this.host.config();
    const rootName = this.rootOf(ws, f);
    const root = ws.roots.find((r) => r.name === rootName);
    return ws.newTask(
      {
        title: `Improve ${f.agent}: ${f.subjects.length} failing score(s)`,
        type: 'task',
        owner: cfg.agent,
        labels: [IMPROVE_LABEL],
        body: improveTaskBody(f, maxAgeDays ? { maxAgeDays } : {}),
      },
      root,
    );
  }

  /** Files the learn-note improvement task for `agent` (W6) as the acting id of `ws`. */
  private fileNotes(ws: Workspace, agent: string, notes: NoteCandidate[], days?: number): TaskMeta {
    const cfg = this.host.config();
    const counts = new Map<string, number>();
    for (const n of notes) counts.set(n.note.root, (counts.get(n.note.root) ?? 0) + 1);
    const own = ws.roots.filter((r) => !r.isMirror);
    const best = [...counts]
      .filter(([r]) => own.some((o) => o.name === r))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    return ws.newTask(
      {
        title: `Improve ${agent}: fold ${notes.length} learn note(s) into the role`,
        type: 'task',
        owner: cfg.agent,
        labels: [IMPROVE_LABEL],
        body: improveNotesBody(agent, notes, days ? { days } : {}),
      },
      own.find((r) => r.name === best) ?? own[0],
    );
  }

  /** The note refs on `Notes:` lines of improvement tasks of `agent`, open or closed. */
  private notedRefs(ws: Workspace, agent: string): Set<string> {
    const out = new Set<string>();
    for (const v of ws.views()) {
      if (!(v.meta.labels ?? []).includes(IMPROVE_LABEL)) continue;
      if (!v.meta.title.startsWith(`Improve ${agent}:`)) continue;
      let body = '';
      try {
        body = ws.roots.find((r) => r.name === v.root)?.readTask(v.meta.id).body ?? '';
      } catch {
        continue;
      }
      for (const m of body.matchAll(/^Notes: (.+)$/gm)) {
        for (const ref of m[1]!.split(/[,\s]+/)) if (ref) out.add(ref);
      }
    }
    return out;
  }

  /** Learn-note candidates by the agents they are for; people and the improver are left out. */
  private notesByAgent(ws: Workspace): { days: number; by: Map<string, NoteCandidate[]> } {
    const cfg = this.host.config();
    const by = new Map<string, NoteCandidate[]>();
    const res = ws.kbPromote();
    for (const c of res.candidates) {
      for (const agent of c.for) {
        if (agent === cfg.agent || isHuman(agent) || agent.startsWith('opsd:')) continue;
        by.set(agent, [...(by.get(agent) ?? []), c]);
      }
    }
    return { days: res.days, by };
  }

  /**
   * The trigger: at most every `check_hours`, files one improvement task for each agent with at
   * least `threshold` distinct failing task and run scores in the last `max_age_days` days, when
   * it has no open improvement task and no open proposal (off unless `enabled`); and with
   * `notes`, one for each agent with learn-note promotion candidates that no improvement task of
   * the agent named yet, on the same conditions. Returns the tasks it filed.
   */
  triggerTick(force = false): TaskMeta[] {
    const cfg = this.host.config();
    if (!cfg.enabled && !cfg.notes) return [];
    const state = this.state();
    const now = this.host.now();
    if (!force && state.checkedAt && now - state.checkedAt < cfg.check_hours * 3_600_000) return [];
    state.checkedAt = now;
    const filed: TaskMeta[] = [];
    try {
      const ws = this.host.ws(IMPROVE_ACTOR);
      const proposed = ws.variants().filter((v) => v.status === 'proposed');
      // `*:<role>` is a change to an agent folder's agent.md, which every runtime reads (W5).
      const busy = (agent: string): boolean => {
        const role = `*:${agent.slice(agent.indexOf(':') + 1)}`;
        return (
          proposed.some((v) => v.agents.includes(agent) || v.agents.includes(role)) ||
          this.openTask(ws, agent) !== undefined
        );
      };
      const failing = cfg.enabled
        ? failingByAgent(this.host.scores(), { now, maxAgeDays: cfg.max_age_days })
        : [];
      for (const f of failing) {
        if (f.subjects.length < cfg.threshold || f.agent === cfg.agent) continue;
        if (busy(f.agent)) continue;
        try {
          filed.push(this.file(ws, f, cfg.max_age_days));
        } catch (err) {
          this.warnOnce(
            `file\0${f.agent}`,
            `improve: cannot file a task for ${f.agent}: ${(err as Error).message}`,
          );
        }
      }
      if (cfg.notes) filed.push(...this.notesTrigger(ws, busy));
    } finally {
      this.host.writeState(state);
    }
    return filed;
  }

  /**
   * Files the improvement task for `agent` now, as `actor` (a person in the app), with every kept
   * failing score of the agent whatever its age. Refuses an agent with no failing score or with
   * an open improvement task.
   */
  request(agent: string, actor: string): TaskMeta {
    const ws = this.host.ws(actor);
    const open = this.openTask(ws, agent);
    if (open) throw new Error(`${agent} already has an open improvement task: ${open}`);
    const f = failingByAgent(this.host.scores(), { now: this.host.now() }).find(
      (x) => x.agent === agent,
    );
    if (!f) throw new Error(`${agent} has no failing task or run score to improve on`);
    return this.file(ws, f);
  }

  /** The learn-note half of the trigger: one task per agent with candidates no task named yet. */
  private notesTrigger(ws: Workspace, busy: (agent: string) => boolean): TaskMeta[] {
    let found: { days: number; by: Map<string, NoteCandidate[]> };
    try {
      found = this.notesByAgent(ws);
    } catch (err) {
      this.warnOnce(
        'notes',
        `improve: cannot list learn-note candidates: ${(err as Error).message}`,
      );
      return [];
    }
    const filed: TaskMeta[] = [];
    for (const [agent, all] of [...found.by].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (busy(agent)) continue;
      // A note an earlier task named was folded in already, or a person turned the change down.
      const named = this.notedRefs(ws, agent);
      const notes = all.filter((c) => !named.has(c.ref));
      if (notes.length === 0) continue;
      try {
        filed.push(this.fileNotes(ws, agent, notes, found.days));
      } catch (err) {
        this.warnOnce(
          `notes\0${agent}`,
          `improve: cannot file a learn-note task for ${agent}: ${(err as Error).message}`,
        );
      }
    }
    return filed;
  }

  /**
   * Files the learn-note improvement task for `agent` now (W6), as `actor` (a person), with every
   * promotion candidate for the agent, named before or not, whatever `notes` says. Refuses an
   * agent with no candidate or with an open improvement task.
   */
  requestNotes(agent: string, actor: string): TaskMeta {
    const ws = this.host.ws(actor);
    const open = this.openTask(ws, agent);
    if (open) throw new Error(`${agent} already has an open improvement task: ${open}`);
    const res = ws.kbPromote({ agent });
    if (res.candidates.length === 0) {
      throw new Error(`${agent} has no learn note to fold in; see \`swarmup kb --promote\``);
    }
    return this.fileNotes(ws, agent, res.candidates, res.days);
  }

  /** This machine's improvement loop and each own store's policy and open proposals. */
  status(): ImproveStatus {
    const cfg = this.host.config();
    const ws = this.host.ws();
    const roots = ws.roots
      .filter((r) => !r.isMirror)
      .map((r) => {
        let policy: ImprovementPolicy;
        try {
          policy = improvementPolicy(loadDefinitions(r.dir).swarm);
        } catch {
          policy = improvementPolicy(null);
        }
        return { root: r.name, policy, open: listVariantNames(r.dir).length };
      });
    const b = cfg.benchmark;
    return {
      enabled: cfg.enabled,
      notes: cfg.notes,
      agent: cfg.agent,
      threshold: cfg.threshold,
      max_age_days: cfg.max_age_days,
      check_hours: cfg.check_hours,
      benchmark: b
        ? {
            set: b.set,
            repo: b.repo,
            repeat: b.repeat,
            ...(b.entries ? { entries: b.entries } : {}),
          }
        : null,
      roots,
    };
  }

  /**
   * A person's own proposal (W6): the new text of an agent's role file as a variant of the store
   * that holds it, linked to `task` or to an improvement task filed for the person, then
   * benchmarked and promoted or rejected like the improver's. `actor` must be a person.
   */
  proposeByHand(actor: string, input: HandProposal): DefsProposeResult {
    if (!isHuman(actor)) throw new OpsError(`only a person proposes from the app; ${actor} cannot`);
    const ws = this.host.ws(actor);
    const def = ws.agent(input.agent);
    if (!def) throw new OpsError(`no role file for ${input.agent}`, 2);
    const root = ws.roots.find((r) => def.file.startsWith(r.dir + sep));
    if (!root || root.isMirror) {
      throw new OpsError(
        `${input.agent}'s role file is in no own store; propose in its project`,
        2,
      );
    }
    const path = relative(root.dir, def.file).split(sep).join('/');
    const before = normalText(readFileSync(def.file));
    if (normalText(input.text) === before) {
      throw new OpsError(`the text is ${path} as it is; change it first`, 2);
    }
    const message = input.message.trim();
    if (!message) throw new OpsError('say why you propose the change', 2);
    const taken = new Set(listVariantNames(root.dir));
    let name = input.name?.trim() || `${input.agent.slice(input.agent.indexOf(':') + 1)}-by-hand`;
    if (!input.name?.trim()) {
      const base = name.slice(0, 32);
      name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    }
    if (!VARIANT_NAME_RE.test(name)) {
      throw new OpsError(
        `bad variant name '${name}': use lowercase letters, digits and dashes, such as engineer-tests-first`,
        2,
      );
    }
    const task =
      input.task?.trim() ||
      (() => {
        const t = ws.newTask(
          {
            title: `Improve ${input.agent}: a change proposed by ${actor}`,
            type: 'task',
            owner: actor,
            labels: [IMPROVE_LABEL],
            body: `${message}\n\nAgent: ${input.agent}`,
          },
          root,
        );
        return `${root.name}/${t.id}`;
      })();
    return ws.defsPropose(task, {
      files: { [path]: input.text },
      name,
      message,
      agents: [input.agent],
    });
  }

  /**
   * The benchmark gate: starts a base run and a variant run of the configured set for each new
   * proposal, and when both end, posts the comparison on the proposal's task. Off without
   * `benchmark` in the config.
   */
  gateTick(): void {
    const bcfg = this.host.config().benchmark;
    const state = this.state();
    let changed = false;
    const ws = this.host.ws(IMPROVE_ACTOR);
    if (bcfg) {
      for (const v of ws.variants()) {
        if (v.status !== 'proposed' || !v.proposal || !v.hash) continue;
        const key = `${v.root}/${v.name}@${v.hash}`;
        if (state.gates[key]) continue;
        changed = true;
        const startedAt = new Date(this.host.now()).toISOString();
        const gate: GateState = {
          root: v.root,
          variant: v.name,
          hash: v.hash,
          task: v.proposal.task,
          state: 'running',
          startedAt,
        };
        state.gates[key] = gate;
        // A change to a folder's agent.md (`*:<role>`) is measured on the role's Claude agent.
        const agent =
          v.agents.find((a) => /^(claude|codex):/.test(a)) ??
          v.agents.find((a) => a.startsWith('*:'))?.replace('*', 'claude');
        if (!agent || !/^(claude|codex):/.test(agent)) {
          Object.assign(gate, { state: 'skipped', error: 'it names no Claude or Codex agent' });
          continue;
        }
        gate.agent = agent;
        const rootDir = ws.roots.find((r) => r.name === v.root)?.dir ?? v.root;
        const req: BenchRunRequest = {
          set: bcfg.set,
          repo: bcfg.repo,
          mode: 'agent',
          agent,
          repeat: bcfg.repeat,
          role_file: true,
          root: rootDir,
          ...(bcfg.entries?.length ? { entries: bcfg.entries } : {}),
          ...(bcfg.budget_min ? { budget_min: bcfg.budget_min } : {}),
          ...(bcfg.hidden_dir ? { hidden_dir: bcfg.hidden_dir } : {}),
        };
        try {
          gate.base = this.host.bench.start(req).id;
          gate.run = this.host.bench.start({ ...req, variant: v.name }).id;
        } catch (err) {
          Object.assign(gate, {
            state: 'failed',
            error: (err as Error).message,
            finishedAt: startedAt,
          });
          this.comment(
            ws,
            gate,
            `The benchmark of variant \`${v.name}\` did not start: ${gate.error}`,
          );
        }
      }
    }
    for (const gate of Object.values(state.gates)) {
      if (gate.state !== 'running' || !gate.base || !gate.run) continue;
      const a = this.host.bench.run(gate.base);
      const b = this.host.bench.run(gate.run);
      if (!a || !b || a.state === 'running' || b.state === 'running') continue;
      changed = true;
      gate.finishedAt = new Date(this.host.now()).toISOString();
      if (a.state === 'failed' || b.state === 'failed') {
        gate.state = 'failed';
        gate.error = [a, b]
          .filter((r) => r.state === 'failed')
          .map((r) => `${r.id}: ${r.error ?? 'failed'}`)
          .join('; ');
        this.record(ws, gate);
        this.comment(
          ws,
          gate,
          `The benchmark of variant \`${gate.variant}\` failed: ${gate.error}`,
        );
        continue;
      }
      try {
        const c = this.host.bench.compare(gate.base, gate.run);
        Object.assign(gate, { state: 'done' }, benchVerdict(c));
        this.record(ws, gate);
        const pts = (x: number | null | undefined): string =>
          x === null || x === undefined ? '-' : `${x > 0 ? '+' : ''}${Math.round(x * 100)} pts`;
        this.comment(
          ws,
          gate,
          [
            `Benchmark of variant \`${gate.variant}\` (${shortHash(gate.hash)}): **${gate.verdict}** ` +
              `than the base (pass rate ${pts(gate.delta?.passRate)}, hidden ${pts(gate.delta?.hiddenPassRate)}).`,
            `Base run \`${gate.base}\`, variant run \`${gate.run}\`.`,
            compareMarkdown(c),
          ].join('\n\n'),
        );
      } catch (err) {
        Object.assign(gate, { state: 'failed', error: (err as Error).message });
      }
    }
    if (changed) this.host.writeState(state);
  }

  /** Writes a finished benchmark into the proposal, where `defs promote` checks `requires`. */
  private record(ws: Workspace, gate: GateState): void {
    try {
      ws.defsRecordBenchmark(gate.variant, gate.root, {
        hash: gate.hash,
        state: gate.state === 'done' ? 'done' : 'failed',
        ...(gate.verdict ? { verdict: gate.verdict } : {}),
        ...(gate.delta ? { pass_delta: gate.delta.passRate ?? null } : {}),
        ...(gate.delta ? { hidden_delta: gate.delta.hiddenPassRate ?? null } : {}),
        ...(gate.base ? { base_run: gate.base } : {}),
        ...(gate.run ? { run: gate.run } : {}),
        ...(gate.error ? { error: gate.error } : {}),
        at: gate.finishedAt ?? new Date(this.host.now()).toISOString(),
      });
    } catch {
      // The proposal may be gone (promoted or rejected meanwhile); the task comment still lands.
    }
  }

  private comment(ws: Workspace, gate: GateState, text: string): void {
    try {
      ws.comment(gate.task, text);
      gate.commented = true;
    } catch (err) {
      this.host.warn(`improve: cannot comment on ${gate.task}: ${(err as Error).message}`);
    }
  }

  /** The variants of every root, with their diffs against the base and their benchmark. */
  proposals(): ProposalView[] {
    const state = this.state();
    const ws = this.host.ws();
    const policies = new Map<string, ImprovementPolicy>();
    const policyOf = (rootName: string): ImprovementPolicy => {
      let p = policies.get(rootName);
      if (!p) {
        const r = ws.roots.find((x) => x.name === rootName);
        try {
          p = improvementPolicy(r ? loadDefinitions(r.dir).swarm : null);
        } catch {
          p = improvementPolicy(null);
        }
        policies.set(rootName, p);
      }
      return p;
    };
    return ws.variants().map((v) => ({
      ...v,
      diffs: v.files.map((f) => ({
        path: f.path,
        kind: f.kind,
        lines: lineDiff(f.before, f.after),
      })),
      ...(state.gates[`${v.root}/${v.name}@${v.hash}`]
        ? { benchmark: state.gates[`${v.root}/${v.name}@${v.hash}`] }
        : {}),
      ...(v.from_ref
        ? {}
        : {
            requires: {
              ...policyOf(v.root).requires,
              problems: requiresProblems(policyOf(v.root), v.proposal, v.hash),
            },
          }),
    }));
  }
}
