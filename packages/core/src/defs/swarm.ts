/**
 * `swarm.yaml`: the team's settings kept in the task store, in git. swarmupd reads `defaults`,
 * `runtimes.<rt>.{model, effort}`, `roles` and `policy`; `work_types` give new tasks their
 * default criteria and workflow; `improvement` is the W6 policy; `checks` are merge checks that
 * run only on a machine that trusts them (W5 phase 4); `experiments` give a share of matching
 * task runs a variant, and `scoring` runs the rubric scorers (W5 phase 5). The other top-level
 * keys are accepted and warned about until their phase lands.
 */
import YAML from 'yaml';
import { OpsError } from '../ids.js';
import { any, bool, enumOf, int, list, map, num, obj, oneOf, ref, str } from './schema.js';
import type { Schema } from './schema.js';
import {
  EFFORT_HINT,
  EFFORT_RE,
  MODEL_HINT,
  MODEL_RE,
  ROLE_NAME_RE,
  RUNTIME_NAME_RE,
} from './values.js';

export const SWARM_FILE = 'swarm.yaml';

/** The format version `swarmup_defs` names. */
export const DEFS_FORMAT = 1;

/** Settings of one runtime that live in git. */
export interface SwarmRuntime {
  model?: string;
  effort?: string;
}

/** Limits and providers of one role that live in git (`swarmupd.roles.<role>` on a machine). */
export interface SwarmRole {
  providers?: string[];
  overflow?: boolean;
  writes?: boolean;
  per_project?: number;
  burst?: number;
  max_children?: number;
}

/** The improvement policy (W6): what a proposal may change, and how many may wait at once. */
export interface SwarmImprovement {
  /** The agent that writes proposals, such as `claude:improver`. */
  agent?: string;
  /** Globs of overlay paths a proposal may change. */
  may_change?: string[];
  /** Globs of overlay paths a proposal never changes; they win over `may_change`. */
  frozen?: string[];
  /** Most proposals that wait for a person at once in this store. */
  max_open_proposals?: number;
  /** What a proposal needs before a person promotes it. */
  requires?: SwarmImprovementRequires;
}

/** `improvement.requires`: the benchmark a proposal must pass before promote (W6). */
export interface SwarmImprovementRequires {
  /** A finished benchmark of the variant as proposed, base against variant. */
  benchmark?: boolean;
  /** The least pass-rate gain, variant minus base, from -1 to 1 (0.05 is 5 points). */
  min_delta?: number;
  /** Promote is a person's step; only `true` is accepted. */
  human_approval?: true;
}

/** Which test and check files a review run's prompt lists, as `swarmupd.test_changes.<root>`. */
export interface SwarmTestChanges {
  tests?: string[];
  checks?: string[];
}

/**
 * Team policy (W5 phase 2): the git half of top-level `swarmupd` keys. A machine that sets the
 * key in its user config wins.
 */
export interface SwarmPolicy {
  review_rounds?: number;
  stuck_runs?: number;
  review_backlog?: number;
  review_fallback_hours?: number;
  plan_check_minutes?: number;
  budget_minutes?: number;
  /** For this store's root: the patterns, or false for no list. */
  test_changes?: SwarmTestChanges | false;
}

/** The policy keys of `swarm.yaml` that map one to one onto top-level `swarmupd` keys. */
export const POLICY_KEYS = [
  'review_rounds',
  'stuck_runs',
  'review_backlog',
  'review_fallback_hours',
  'plan_check_minutes',
  'budget_minutes',
] as const;

/**
 * A kind of work (W5 phase 3): tasks whose type is in `types` (any type without it) and that
 * carry one of `labels` (any labels without it). The first match gives a new task without
 * `--done-when` its `done_when`, and names the workflow that fits.
 */
export interface SwarmWorkType {
  types?: string[];
  labels?: string[];
  workflow?: string;
  done_when?: unknown[];
}

/**
 * A merge check kept in git (W5 phase 4): a command swarmupd runs on approved work before the
 * base moves, only when the merge changes one of `paths` when they are set. It never runs on a
 * machine until a person trusts the store's check set there (`swarmup defs trust`).
 */
export interface SwarmCheck {
  run: string;
  paths?: string[];
  description?: string;
}

/** Which task runs an experiment takes: every list that is set must match. */
export interface SwarmExperimentScope {
  /** Agent ids, such as `claude:engineer`. */
  agents?: string[];
  /** Roles, such as `engineer`. */
  roles?: string[];
  /** Task types. */
  types?: string[];
  /** Labels, of which a task carries one. */
  labels?: string[];
}

/**
 * An experiment (W5 phase 5): a `share` of the task runs `scope` takes run with `variant`, until
 * the end of the day `until` (UTC). The experiment id and the task fix which side a task lands
 * on, so every run of a task gets the same definitions.
 */
export interface SwarmExperiment {
  id: string;
  /** A variant of this store, `variants/<name>/`. */
  variant: string;
  /** The share of matching tasks that run the variant, from 0 to 1. */
  share: number;
  scope?: SwarmExperimentScope;
  /** The last day it runs, `YYYY-MM-DD` in UTC; open-ended without it. */
  until?: string;
  description?: string;
}

/** The part of `swarm.yaml` swarmupd applies. */
export interface SwarmDefs {
  swarmup_defs: number;
  defaults?: { budget_min?: number; effort?: string; model?: string };
  runtimes?: Record<string, SwarmRuntime>;
  roles?: Record<string, SwarmRole>;
  policy?: SwarmPolicy;
  work_types?: SwarmWorkType[];
  improvement?: SwarmImprovement;
  /** Merge checks by name; they run only on a machine that trusts this exact set. */
  checks?: Record<string, SwarmCheck>;
  /** Experiments, in order: the first one that takes a task run decides its variant. */
  experiments?: SwarmExperiment[];
  scoring?: SwarmScoring;
}

/** The tokens rubric scorers may spend on a store's work per day when `scoring` sets none. */
export const DEFAULT_DAILY_JUDGE_TOKENS = 200_000;

/** Judge-based scoring of a store's work (W5 phase 5): `scoring` in `swarm.yaml`. */
export interface SwarmScoring {
  /** The rubric scorers that run; every enabled one when unset. */
  scorers?: string[];
  /** The sample of a rubric scorer whose file sets none. */
  sample?: number;
  /** The most tokens rubric scorers spend on the store's work per UTC day. */
  daily_judge_tokens?: number;
  /** The machines that judge the store's work; any that opts in when unset. */
  runs_on?: string[];
}

export const modelSchema = (doc?: string): Schema =>
  str({ pattern: MODEL_RE, hint: MODEL_HINT, ...(doc ? { doc } : {}) });

export const effortSchema = (doc?: string): Schema =>
  str({ pattern: EFFORT_RE, hint: EFFORT_HINT, ...(doc ? { doc } : {}) });

const runtimeName = { keyPattern: RUNTIME_NAME_RE, keyHint: 'name a runtime such as claude' };

const MACHINE_ONLY = (key: string, where: string): string =>
  `${key} is machine-only: set it under ${where} in the user config, where swarmupd trusts the commands it runs`;

const runtimeSchema = ref(
  'runtime',
  () =>
    obj(
      {
        model: modelSchema(
          "Model for this runtime's runs. A machine's `swarmupd.runtimes.<rt>.model` wins.",
        ),
        effort: effortSchema(
          "Reasoning effort for this runtime's runs. A machine's `swarmupd.runtimes.<rt>.effort` wins.",
        ),
      },
      {
        doc: 'The git half of `swarmupd.runtimes.<rt>`: model and effort only.',
        refuse: Object.fromEntries(
          [
            'command',
            'args',
            'env',
            'unset_env',
            'max_live',
            'pause_at',
            'paused',
            'sign_in_check',
            'sandbox_worktrees',
            'model_windows',
          ].map((k) => [k, MACHINE_ONLY(k, 'swarmupd.runtimes.<rt>')]),
        ),
      },
    ),
  { nullable: true },
);

const roleSchema = ref(
  'role',
  () =>
    obj(
      {
        providers: list(str({ pattern: RUNTIME_NAME_RE, hint: 'name a runtime such as claude' }), {
          doc: "Runtimes in order of preference for tasks owned by `*:<role>`; default: the machine's runtime order.",
        }),
        overflow: bool({
          doc: 'Hand a `*:<role>` task to the next provider when the preferred ones have no room. Default true.',
        }),
        writes: bool({
          doc: 'The role changes files. Default true, except for qa, reviewer, pm and orchestrator.',
        }),
        per_project: int({
          min: 0,
          doc: 'Most live runs of the role on one project. Default 1 if it writes, else 3.',
        }),
        burst: int({ min: 0, doc: 'Live runs per project while reviews pile up there.' }),
        max_children: int({
          min: 0,
          doc: 'Most helper runs (`swarmup spawn`) one run of this role may have live at once. Default 2.',
        }),
      },
      {
        doc: 'The git half of `swarmupd.roles.<role>`. A machine value for the same key wins.',
        refuse: { max_live: MACHINE_ONLY('max_live', 'swarmupd.roles.<role>') },
      },
    ),
  { nullable: true },
);

const later = (phase: string): Schema => any({ inactive: phase });

/** An experiment's id: lowercase letters, digits and dashes. */
export const EXPERIMENT_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The schema of `swarm.yaml`. */
export const SWARM_SCHEMA: Schema = obj(
  {
    swarmup_defs: enumOf([DEFS_FORMAT], {
      doc: 'Format version of the definition files. Always 1 for now.',
    }),
    defaults: obj(
      {
        budget_min: int({
          min: 1,
          doc: "Run budget in minutes for agents that set none. It wins over `policy.budget_minutes`; a machine's `swarmupd.budget_minutes` wins over both.",
        }),
        effort: effortSchema('Effort for runtimes that set none, here or on the machine.'),
        model: modelSchema(
          'Model for runtimes that set none, here or on the machine. It applies to every runtime, so set it per runtime when you run several providers.',
        ),
      },
      { doc: 'Fallbacks for every runtime.', nullable: true },
    ),
    runtimes: map(runtimeSchema, {
      ...runtimeName,
      nullable: true,
      doc: 'Model and effort per runtime. Commands, arguments and environment stay in the user config.',
    }),
    roles: map(roleSchema, {
      keyPattern: ROLE_NAME_RE,
      keyHint: 'name a role such as engineer',
      nullable: true,
      doc: 'Providers and limits per role, as `swarmupd.roles` takes them.',
    }),
    policy: obj(
      {
        review_rounds: int({
          min: 0,
          doc: '`changes` verdicts in a row before swarmupd stops waking the author. 0 turns it off.',
        }),
        stuck_runs: int({
          min: 0,
          doc: 'Runs in a row that end without finishing before swarmupd stops starting a task. 0 turns it off.',
        }),
        review_backlog: int({
          min: 1,
          doc: 'Tasks waiting for review in one project at which writing roles hold and reviewers burst.',
        }),
        review_fallback_hours: num({
          min: 0,
          doc: "Hours a review waits for the other provider's reviewer before it falls back. 0 never.",
        }),
        plan_check_minutes: int({
          min: 0,
          doc: 'Minutes between two plan checks. 0 turns them off.',
        }),
        budget_minutes: int({
          min: 1,
          doc: 'Run budget in minutes when neither the task nor the agent sets one; `defaults.budget_min` wins.',
        }),
        test_changes: oneOf(
          [
            enumOf([false]),
            obj(
              {
                tests: list(str(), { doc: 'Patterns of test files.' }),
                checks: list(str(), { doc: 'Patterns of test, lint and CI configuration.' }),
              },
              { doc: 'The patterns; an unset list takes the defaults.' },
            ),
          ],
          {
            doc: "Which test and check files a review run's prompt lists for this store's root, or false for no list.",
          },
        ),
      },
      {
        nullable: true,
        doc: "Team policy: the git half of top-level `swarmupd` keys. A machine's key wins.",
      },
    ),
    work_types: list(
      obj(
        {
          types: list(str(), { doc: 'Task types this kind of work has; any type when unset.' }),
          labels: list(str(), {
            doc: 'Labels of which a task carries one; any labels when unset.',
          }),
          workflow: str({
            pattern: /^[a-z0-9][a-z0-9-]{0,39}$/,
            hint: 'name a workflow such as bugfix',
            doc: 'The workflow (`workflows/<id>.yaml`) that fits this kind of work.',
          }),
          done_when: list(any(), {
            doc: 'Criteria a new task of this kind gets when it names none (`swarmup new` without --done-when).',
          }),
        },
        { doc: 'One kind of work: the first entry that matches a task applies.' },
      ),
      { nullable: true, doc: 'Kinds of work, with default criteria and workflow.' },
    ),
    scoring: obj(
      {
        scorers: list(
          str({ pattern: /^[a-z0-9][a-z0-9-]{0,59}$/, hint: 'name a scorer (scorers/<id>.yaml)' }),
          { doc: 'The rubric scorers that run for this store; every enabled one when unset.' },
        ),
        sample: num({
          min: 0,
          max: 1,
          doc: 'The share of matching closed tasks a rubric scorer judges when its file sets no `sample`, from 0 to 1. Default 1.',
        }),
        daily_judge_tokens: int({
          min: 0,
          doc: "The most tokens rubric scorers spend on this store's work per day (UTC). Default 200000. A machine's `swarmupd.judge.daily_tokens` may only lower it.",
        }),
        runs_on: list(str({ pattern: /\S/, hint: 'name a machine' }), {
          doc: "The machine (`machine` in its user config) that judges this store's work, so one machine spends the cap. Without it, the machine whose `swarmupd.judge.scorers` names the root, or that merges it with `true`.",
        }),
      },
      {
        nullable: true,
        doc: 'Judge-based scoring: which rubric scorers run, their default sample, the daily token cap and the machine that judges. They run only on a machine whose `swarmupd.judge.scorers` takes the root.',
      },
    ),
    checks: map(
      oneOf([
        str({ pattern: /\S/, hint: 'name the command to run' }),
        obj(
          {
            run: str({ pattern: /\S/, hint: 'name the command to run', doc: 'The command.' }),
            paths: list(str({ pattern: /^(?!!?\s*$)/, hint: 'use a path pattern' }), {
              doc: 'Run only when the merge changes one of these paths (the `test_changes` pattern syntax; `!` takes paths out).',
            }),
            description: str({ doc: 'What the check is for.' }),
          },
          { required: ['run'], doc: 'A check with the paths it checks.' },
        ),
      ]),
      {
        keyPattern: /^[a-z0-9][a-z0-9_-]{0,59}$/,
        keyHint: 'name a check with lowercase letters, digits, _ and -',
        nullable: true,
        doc: 'Merge checks: commands swarmupd runs on approved work before the base moves. They run on a machine only after a person there runs `swarmup defs trust`, and any change to them needs a new trust. A machine that sets `swarmupd.merge.<root>.checks` keeps its own.',
      },
    ),
    variants: later('variants come in phase 5'),
    experiments: list(
      obj(
        {
          id: str({
            pattern: EXPERIMENT_ID_RE,
            hint: 'name the experiment with lowercase letters, digits and dashes',
            doc: 'The experiment id. With the task it fixes which side a task lands on: a new id deals the tasks again.',
          }),
          variant: str({
            pattern: /^[a-z0-9][a-z0-9-]{0,39}$/,
            hint: 'name a variant (variants/<name>/) such as engineer-tests-first',
            doc: 'The variant the chosen share of task runs gets: `variants/<name>/` in this store.',
          }),
          share: num({
            min: 0,
            max: 1,
            doc: 'The share of matching tasks that run the variant, from 0 to 1 (0.5 is half). The rest run the base definitions.',
          }),
          scope: obj(
            {
              agents: list(
                str({
                  pattern: /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/,
                  hint: 'use <runtime>:<role>, such as claude:engineer',
                }),
                { doc: 'Agent ids.' },
              ),
              roles: list(str({ pattern: ROLE_NAME_RE, hint: 'name a role such as engineer' }), {
                doc: 'Roles, such as engineer.',
              }),
              types: list(str(), { doc: 'Task types.' }),
              labels: list(str(), { doc: 'Labels, of which a task carries one.' }),
            },
            {
              nullable: true,
              doc: 'Which task runs it takes; every list that is set must match. Every task run when unset.',
            },
          ),
          until: str({
            pattern: /^\d{4}-\d{2}-\d{2}$/,
            hint: 'use a date such as 2026-12-31',
            doc: 'The last day it runs, in UTC. Open-ended when unset.',
          }),
          description: str({ doc: 'What the experiment tests.' }),
        },
        {
          required: ['id', 'variant', 'share'],
          doc: 'One experiment: a share of the task runs it takes run a variant.',
        },
      ),
      {
        nullable: true,
        doc: 'A/B experiments: the first one that takes a task run gives it the variant or the base, the same for every run of the task. A machine with `swarmupd.experiments: false` runs the base, and an explicit `--variant` or `--defs-ref` wins.',
      },
    ),
    improvement: obj(
      {
        agent: str({
          pattern: /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/,
          hint: 'use <runtime>:<role>, such as claude:improver',
          doc: 'The agent that writes proposals. Default `claude:improver`.',
        }),
        may_change: list(str(), {
          doc: "Globs of the paths a proposal's overlay may change. Default `agents/*.md`, `agents/*/*.md` and `workflows/**`.",
        }),
        frozen: list(str(), {
          doc: "Globs of the paths a proposal never changes; they win over `may_change`. Default `scorers/**`, `benchmarks/**`, `rubrics/**`, `triggers/**` and `swarm.yaml`. An agent's `tools`, `writes`, `can_claim` and `id` are always frozen.",
        }),
        max_open_proposals: int({
          min: 0,
          doc: 'Most proposals that wait for a person at once in this store. Default 2.',
        }),
        requires: obj(
          {
            benchmark: bool({
              doc: 'A finished benchmark of the variant as proposed (`swarmupd.improve.benchmark` runs it) before a person promotes it. Default false.',
            }),
            min_delta: num({
              min: -1,
              max: 1,
              doc: 'The least pass-rate gain of the variant over the base, from -1 to 1 (0.05 is 5 points). Default 0: no worse than the base. Applies when `benchmark` is true.',
            }),
            human_approval: enumOf([true], {
              doc: "Promote is always a person's step; only `true` is accepted.",
            }),
          },
          {
            nullable: true,
            doc: 'What a proposal needs before a person promotes it; `swarmup defs promote --force` overrides it and says so on the task.',
          },
        ),
      },
      {
        nullable: true,
        doc: 'The self-improvement policy (W6): what `swarmup defs propose` may change.',
      },
    ),
  },
  {
    required: ['swarmup_defs'],
    doc: 'Team settings kept in the task store. Machine settings in the user config win over these.',
  },
);

const KNOWN_ROLE_KEYS = [
  'providers',
  'overflow',
  'writes',
  'per_project',
  'burst',
  'max_children',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (x: unknown): string[] | undefined =>
  Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : undefined;

/**
 * The part of a parsed `swarm.yaml` that passed {@link SWARM_SCHEMA} and that SwarmUp applies:
 * later-phase keys, unknown keys and `null` values are left out.
 */
export function swarmDefs(value: unknown): SwarmDefs {
  const v = isRecord(value) ? value : {};
  const out: SwarmDefs = { swarmup_defs: Number(v.swarmup_defs ?? DEFS_FORMAT) };
  if (isRecord(v.defaults)) {
    const d: NonNullable<SwarmDefs['defaults']> = {};
    if (typeof v.defaults.model === 'string') d.model = v.defaults.model;
    if (typeof v.defaults.effort === 'string') d.effort = v.defaults.effort;
    if (typeof v.defaults.budget_min === 'number') d.budget_min = v.defaults.budget_min;
    if (Object.keys(d).length > 0) out.defaults = d;
  }
  if (isRecord(v.runtimes)) {
    const rts: Record<string, SwarmRuntime> = {};
    for (const [name, rc] of Object.entries(v.runtimes)) {
      if (!isRecord(rc)) continue;
      const r: SwarmRuntime = {};
      if (typeof rc.model === 'string') r.model = rc.model;
      if (typeof rc.effort === 'string') r.effort = rc.effort;
      rts[name] = r;
    }
    out.runtimes = rts;
  }
  if (isRecord(v.roles)) {
    const roles: Record<string, SwarmRole> = {};
    for (const [name, rc] of Object.entries(v.roles)) {
      if (!isRecord(rc)) continue;
      const r: Record<string, unknown> = {};
      for (const k of KNOWN_ROLE_KEYS) if (rc[k] !== undefined && rc[k] !== null) r[k] = rc[k];
      roles[name] = r as SwarmRole;
    }
    out.roles = roles;
  }
  if (isRecord(v.policy)) {
    const p: SwarmPolicy = {};
    for (const k of POLICY_KEYS) if (typeof v.policy[k] === 'number') p[k] = v.policy[k];
    const tc = v.policy.test_changes;
    if (tc === false) p.test_changes = false;
    else if (isRecord(tc)) {
      const t: SwarmTestChanges = {};
      const tests = strings(tc.tests);
      if (tests) t.tests = tests;
      const checks = strings(tc.checks);
      if (checks) t.checks = checks;
      p.test_changes = t;
    }
    if (Object.keys(p).length > 0) out.policy = p;
  }
  if (Array.isArray(v.work_types)) {
    out.work_types = v.work_types.filter(isRecord).map((w) => {
      const t: SwarmWorkType = {};
      const types = strings(w.types);
      if (types) t.types = types;
      const labels = strings(w.labels);
      if (labels) t.labels = labels;
      if (typeof w.workflow === 'string') t.workflow = w.workflow;
      if (Array.isArray(w.done_when)) t.done_when = w.done_when;
      return t;
    });
  }
  if (isRecord(v.improvement)) {
    const i = v.improvement;
    const imp: SwarmImprovement = {};
    if (typeof i.agent === 'string') imp.agent = i.agent;
    const may = strings(i.may_change);
    if (may) imp.may_change = may;
    const frozen = strings(i.frozen);
    if (frozen) imp.frozen = frozen;
    if (typeof i.max_open_proposals === 'number') imp.max_open_proposals = i.max_open_proposals;
    if (isRecord(i.requires)) {
      const r = i.requires;
      const req: SwarmImprovementRequires = {};
      if (typeof r.benchmark === 'boolean') req.benchmark = r.benchmark;
      if (typeof r.min_delta === 'number') req.min_delta = r.min_delta;
      if (r.human_approval === true) req.human_approval = true;
      imp.requires = req;
    }
    out.improvement = imp;
  }
  if (isRecord(v.scoring)) {
    const sc: SwarmScoring = {};
    const ids = strings(v.scoring.scorers);
    if (ids) sc.scorers = ids;
    if (typeof v.scoring.sample === 'number') sc.sample = v.scoring.sample;
    if (typeof v.scoring.daily_judge_tokens === 'number') {
      sc.daily_judge_tokens = v.scoring.daily_judge_tokens;
    }
    const runsOn = strings(v.scoring.runs_on);
    if (runsOn && runsOn.length > 0) sc.runs_on = runsOn.map((m) => m.trim());
    out.scoring = sc;
  }
  if (Array.isArray(v.experiments)) {
    out.experiments = v.experiments.filter(isRecord).flatMap((e) => {
      if (typeof e.id !== 'string' || typeof e.variant !== 'string') return [];
      if (typeof e.share !== 'number') return [];
      const x: SwarmExperiment = { id: e.id, variant: e.variant, share: e.share };
      if (isRecord(e.scope)) {
        const scope: SwarmExperimentScope = {};
        for (const k of ['agents', 'roles', 'types', 'labels'] as const) {
          const list = strings(e.scope[k]);
          if (list && list.length > 0) scope[k] = list;
        }
        if (Object.keys(scope).length > 0) x.scope = scope;
      }
      if (typeof e.until === 'string') x.until = e.until;
      if (typeof e.description === 'string') x.description = e.description;
      return [x];
    });
  }
  if (isRecord(v.checks)) {
    const checks: Record<string, SwarmCheck> = {};
    for (const [name, c] of Object.entries(v.checks)) {
      if (typeof c === 'string' && c.trim()) checks[name] = { run: c };
      else if (isRecord(c) && typeof c.run === 'string' && c.run.trim()) {
        const paths = strings(c.paths);
        checks[name] = {
          run: c.run,
          ...(paths && paths.length > 0 ? { paths } : {}),
          ...(typeof c.description === 'string' ? { description: c.description } : {}),
        };
      }
    }
    if (Object.keys(checks).length > 0) out.checks = checks;
  }
  return out;
}

/** Values `swarmup defs import-config` writes into `swarm.yaml`. */
export interface SwarmImport {
  runtimes: Record<string, SwarmRuntime>;
  roles: Record<string, SwarmRole>;
}

/**
 * `swarm.yaml` text with `values` set in it, comments and other keys kept; a new file when
 * `before` is empty. Returns the keys it set, such as `runtimes.claude.model`.
 */
export function setSwarmValues(
  before: string,
  values: SwarmImport,
): { text: string; keys: string[] } {
  const doc = before.trim()
    ? YAML.parseDocument(before)
    : new YAML.Document({ swarmup_defs: DEFS_FORMAT });
  if (doc.errors.length > 0) {
    throw new OpsError(
      `${SWARM_FILE}: ${doc.errors[0]!.message.split('\n')[0]}; fix it by hand first`,
      2,
    );
  }
  if (!doc.has('swarmup_defs')) doc.set('swarmup_defs', DEFS_FORMAT);
  const keys: string[] = [];
  for (const [area, entries] of Object.entries(values) as Array<
    [string, Record<string, Record<string, unknown>>]
  >) {
    for (const [name, r] of Object.entries(entries)) {
      for (const [k, v] of Object.entries(r)) {
        if (v === undefined) continue;
        doc.setIn([area, name, k], doc.createNode(v, { flow: Array.isArray(v) }));
        keys.push(`${area}.${name}.${k}`);
      }
    }
  }
  return { text: doc.toString(), keys };
}
