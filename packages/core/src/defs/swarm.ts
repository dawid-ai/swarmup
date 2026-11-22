/**
 * `swarm.yaml`: the team's settings kept in the task store, in git. Phase 1 reads `defaults`,
 * `runtimes.<rt>.{model, effort}` and `roles`; the other top-level keys are accepted and warned
 * about until their phase lands.
 */
import YAML from 'yaml';
import { OpsError } from '../ids.js';
import { any, bool, enumOf, int, list, map, obj, ref, str } from './schema.js';
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
}

/** The part of `swarm.yaml` swarmupd applies. */
export interface SwarmDefs {
  swarmup_defs: number;
  defaults?: { budget_min?: number; effort?: string; model?: string };
  runtimes?: Record<string, SwarmRuntime>;
  roles?: Record<string, SwarmRole>;
  improvement?: SwarmImprovement;
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
          inactive: 'budget defaults come with the policy keys (phase 2)',
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
    policy: later('team policy moves into git in phase 2'),
    work_types: later('work types come with workflows (phase 3)'),
    scoring: later('scorers in git come in phase 4'),
    checks: later('checks in git come in phase 4, after `swarmup defs trust`'),
    variants: later('variants come in phase 5'),
    experiments: later('experiments come in phase 5'),
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
          doc: "Globs of the paths a proposal never changes; they win over `may_change`. Default `scorers/**`, `benchmarks/**`, `rubrics/**` and `swarm.yaml`. An agent's `tools`, `writes`, `can_claim` and `id` are always frozen.",
        }),
        max_open_proposals: int({
          min: 0,
          doc: 'Most proposals that wait for a person at once in this store. Default 2.',
        }),
        requires: any({
          inactive: 'benchmark requirements come later; swarmupd.improve.benchmark runs the gate',
        }),
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

/**
 * The phase 1 part of a parsed `swarm.yaml` that passed {@link SWARM_SCHEMA}: later-phase keys,
 * unknown keys and `null` values are left out.
 */
export function swarmDefs(value: unknown): SwarmDefs {
  const v = isRecord(value) ? value : {};
  const out: SwarmDefs = { swarmup_defs: Number(v.swarmup_defs ?? DEFS_FORMAT) };
  if (isRecord(v.defaults)) {
    const d: NonNullable<SwarmDefs['defaults']> = {};
    if (typeof v.defaults.model === 'string') d.model = v.defaults.model;
    if (typeof v.defaults.effort === 'string') d.effort = v.defaults.effort;
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
  if (isRecord(v.improvement)) {
    const i = v.improvement;
    const imp: SwarmImprovement = {};
    if (typeof i.agent === 'string') imp.agent = i.agent;
    const strings = (x: unknown): string[] | undefined =>
      Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string') : undefined;
    const may = strings(i.may_change);
    if (may) imp.may_change = may;
    const frozen = strings(i.frozen);
    if (frozen) imp.frozen = frozen;
    if (typeof i.max_open_proposals === 'number') imp.max_open_proposals = i.max_open_proposals;
    out.improvement = imp;
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
