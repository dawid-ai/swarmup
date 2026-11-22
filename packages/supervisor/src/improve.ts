// The self-improvement loop (W6): scorer failures become tasks for the improver, whose proposals
// (variant overlays recorded with `swarmup defs propose`) swarmupd benchmarks, base against
// variant, before a person promotes or rejects them. Nothing here changes a definition file: only
// a person's `swarmup defs promote` does.
import type { TaskMeta, VariantInfo, Workspace } from '@swarmup/core';
import { isHuman, OPEN_STATUSES, shortHash } from '@swarmup/core';
import type { BenchRunRequest, BenchRunView } from './bench-runs.js';
import type { Comparison, SummaryOverall } from './bench.js';
import { compareMarkdown } from './bench.js';
import type { ImproveConfig } from './config.js';
import { lineDiff } from './defs-import.js';
import type { RunRecord } from './runs.js';
import type { ScoreResult } from './scores.js';
import { scorerCatalog } from './scores.js';

/** The actor swarmupd files improvement tasks and benchmark results as. */
export const IMPROVE_ACTOR = 'opsd:improve';

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
    '   definitions are (`agents/<runtime>-<role>.md`), and check it with `swarmup validate`.',
    '4. Record it: `swarmup defs propose ID --dir DIR --name NAME -m "why"`, then send this task to',
    '   the person for review.',
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

  /**
   * The trigger: at most every `check_hours`, files one improvement task for each agent with at
   * least `threshold` distinct failing task and run scores in the last `max_age_days` days, when
   * it has no open improvement task and no open proposal. Off unless `enabled`. Returns the tasks
   * it filed.
   */
  triggerTick(force = false): TaskMeta[] {
    const cfg = this.host.config();
    if (!cfg.enabled) return [];
    const state = this.state();
    const now = this.host.now();
    if (!force && state.checkedAt && now - state.checkedAt < cfg.check_hours * 3_600_000) return [];
    state.checkedAt = now;
    const filed: TaskMeta[] = [];
    try {
      const ws = this.host.ws(IMPROVE_ACTOR);
      const proposed = ws.variants().filter((v) => v.status === 'proposed');
      for (const f of failingByAgent(this.host.scores(), { now, maxAgeDays: cfg.max_age_days })) {
        if (f.subjects.length < cfg.threshold || f.agent === cfg.agent) continue;
        if (proposed.some((v) => v.agents.includes(f.agent))) continue;
        if (this.openTask(ws, f.agent)) continue;
        try {
          filed.push(this.file(ws, f, cfg.max_age_days));
        } catch (err) {
          this.warnOnce(
            `file\0${f.agent}`,
            `improve: cannot file a task for ${f.agent}: ${(err as Error).message}`,
          );
        }
      }
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
        const agent = v.agents[0];
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
    return this.host
      .ws()
      .variants()
      .map((v) => ({
        ...v,
        diffs: v.files.map((f) => ({
          path: f.path,
          kind: f.kind,
          lines: lineDiff(f.before, f.after),
        })),
        ...(state.gates[`${v.root}/${v.name}@${v.hash}`]
          ? { benchmark: state.gates[`${v.root}/${v.name}@${v.hash}`] }
          : {}),
      }));
  }
}
