/**
 * swarmupd's effective config: the machine's `swarmupd` section with the git definitions
 * (`swarm.yaml`) of each root merged under it. At equal specificity the machine wins, and each
 * machine key that overrode a git value is recorded.
 */
import type { SwarmDefs } from '@swarmup/core';
import { POLICY_KEYS } from '@swarmup/core';

import type { OpsdConfig, RoleConfig, RuntimeConfig } from './config.js';

/** The `swarm.yaml` of one root, for {@link withDefinitions}. */
export interface DefsSource {
  /** The root's name. */
  root: string;
  swarm: SwarmDefs;
  /**
   * `writes` per role from the root's agent files (W5): it wins over the role's `writes` in
   * `swarm.yaml`, and a machine value wins over both.
   */
  roleWrites?: Record<string, boolean>;
}

/** A machine value that won over a git value for the same key. */
export interface DefsOverride {
  /** Key under `swarmupd`, such as `runtimes.claude.model` or `roles.qa.per_project`. */
  key: string;
  machine: unknown;
  git: unknown;
  /** The root whose `swarm.yaml` gave the git value. */
  root: string;
}

/** Two roots that give different git values for one key; the first root wins. */
export interface DefsConflict {
  key: string;
  roots: string[];
}

/**
 * Where an effective value came from: `git` (a `swarm.yaml` gave it), `machine` (the user config
 * set the key too, with the same or another value), or `unused` (no runtime of this machine
 * takes it).
 */
export type DefsSourceKind = 'git' | 'machine' | 'unused';

/** One key a `swarm.yaml` sets, with the value swarmupd runs with and where that came from. */
export interface DefsValue {
  /** Key under `swarmupd`, such as `runtimes.claude.model`. */
  key: string;
  /** The value in effect; for `unused`, the git value. */
  value: unknown;
  source: DefsSourceKind;
  /** The git value, and the root whose `swarm.yaml` gave it. */
  git: unknown;
  root: string;
}

export interface DefsMerge {
  config: OpsdConfig;
  /** Git keys the config took, each with the root it came from. */
  applied: Array<{ key: string; root: string }>;
  overrides: DefsOverride[];
  conflicts: DefsConflict[];
  /** Every key the git definitions set, with its effective value and source, sorted by key. */
  values: DefsValue[];
}

const ROLE_KEYS = [
  'providers',
  'overflow',
  'writes',
  'per_project',
  'burst',
  'max_children',
] as const satisfies ReadonlyArray<keyof RoleConfig>;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * True when the machine sets top-level key `k` itself. A config built without `explicit` (by
 * hand, in tests) counts every key as set, so git policy never changes it.
 */
const machineSets = (cfg: OpsdConfig, k: string): boolean =>
  cfg.explicit === undefined || cfg.explicit.includes(k);

/**
 * Merges git `roles` and `runtimes.<rt>.{model, effort}` (then `defaults.{model, effort}`) under
 * the machine values of `cfg`, and the team policy (W5 phase 2): `policy.*` under the top-level
 * keys the machine does not set itself (`cfg.explicit`), with `defaults.budget_min` before
 * `policy.budget_minutes`, and `policy.test_changes` of each root under
 * `test_changes.<root>`. An agent file's `writes` wins over its role's in `swarm.yaml`.
 * `sources` come in root order: for a key two roots set, the first one wins and the pair is
 * named in `conflicts`. Git never adds a runtime: commands are machine-only, so a runtime this
 * machine lacks is skipped. Without sources, `cfg` comes back as it is.
 */
export function withDefinitions(cfg: OpsdConfig, sources: readonly DefsSource[]): DefsMerge {
  const applied: DefsMerge['applied'] = [];
  const overrides: DefsOverride[] = [];
  const conflicts: DefsConflict[] = [];
  const values: DefsValue[] = [];
  if (sources.length === 0) return { config: cfg, applied, overrides, conflicts, values };

  // The git value of each key: from the first root that sets it.
  const git = new Map<string, { value: unknown; root: string }>();
  const put = (key: string, value: unknown, root: string): void => {
    if (value === undefined) return;
    const had = git.get(key);
    if (!had) {
      git.set(key, { value, root });
      return;
    }
    if (same(had.value, value)) return;
    const c = conflicts.find((x) => x.key === key);
    if (c) {
      if (!c.roots.includes(root)) c.roots.push(root);
    } else conflicts.push({ key, roots: [had.root, root] });
  };
  for (const source of sources) {
    const { root, swarm } = source;
    for (const [rt, r] of Object.entries(swarm.runtimes ?? {})) {
      put(`runtimes.${rt}.model`, r.model, root);
      put(`runtimes.${rt}.effort`, r.effort, root);
    }
    put('defaults.model', swarm.defaults?.model, root);
    put('defaults.effort', swarm.defaults?.effort, root);
    for (const [role, w] of Object.entries(source.roleWrites ?? {})) {
      put(`roles.${role}.writes`, w, root);
    }
    for (const [role, r] of Object.entries(swarm.roles ?? {})) {
      for (const k of ROLE_KEYS) {
        if (k === 'writes' && source.roleWrites?.[role] !== undefined) continue;
        put(`roles.${role}.${k}`, r[k], root);
      }
    }
    put('defaults.budget_min', swarm.defaults?.budget_min, root);
    for (const k of POLICY_KEYS) put(`policy.${k}`, swarm.policy?.[k], root);
  }

  const runtimes: Record<string, RuntimeConfig> = {};
  for (const [rt, rc] of Object.entries(cfg.runtimes)) {
    const next: RuntimeConfig = { ...rc };
    for (const k of ['model', 'effort'] as const) {
      const g = git.get(`runtimes.${rt}.${k}`) ?? git.get(`defaults.${k}`);
      if (!g) continue;
      const key = `runtimes.${rt}.${k}`;
      if (rc[k] !== undefined) {
        if (!same(rc[k], g.value)) {
          overrides.push({ key, machine: rc[k], git: g.value, root: g.root });
        }
        values.push({ key, value: rc[k], source: 'machine', git: g.value, root: g.root });
        continue;
      }
      next[k] = g.value as string;
      applied.push({ key, root: g.root });
      values.push({ key, value: g.value, source: 'git', git: g.value, root: g.root });
    }
    runtimes[rt] = next;
  }

  const roles: Record<string, RoleConfig> = { ...cfg.roles };
  const roleNames = new Set(
    [...git.keys()].filter((k) => k.startsWith('roles.')).map((k) => k.split('.')[1]!),
  );
  for (const role of roleNames) {
    const machine = cfg.roles[role] ?? {};
    const next: RoleConfig = { ...machine };
    for (const k of ROLE_KEYS) {
      const g = git.get(`roles.${role}.${k}`);
      if (!g) continue;
      const key = `roles.${role}.${k}`;
      if (machine[k] !== undefined) {
        if (!same(machine[k], g.value)) {
          overrides.push({ key, machine: machine[k], git: g.value, root: g.root });
        }
        values.push({ key, value: machine[k], source: 'machine', git: g.value, root: g.root });
        continue;
      }
      (next as Record<string, unknown>)[k] = g.value;
      applied.push({ key, root: g.root });
      values.push({ key, value: g.value, source: 'git', git: g.value, root: g.root });
    }
    roles[role] = next;
  }
  // Team policy: a top-level key the machine leaves unset takes the git value.
  const policy: Partial<Record<(typeof POLICY_KEYS)[number], number>> = {};
  // The first root that sets a key wins; in one root, `defaults.budget_min` beats
  // `policy.budget_minutes`.
  const rootOrder = new Map(sources.map((s, i) => [s.root, i]));
  const earlier = (a: { root: string }, b: { root: string }): boolean =>
    (rootOrder.get(a.root) ?? Infinity) <= (rootOrder.get(b.root) ?? Infinity);
  for (const k of POLICY_KEYS) {
    const pol = git.get(`policy.${k}`);
    const def = k === 'budget_minutes' ? git.get('defaults.budget_min') : undefined;
    const g = def && (!pol || earlier(def, pol)) ? def : pol;
    if (!g) continue;
    if (machineSets(cfg, k)) {
      if (!same(cfg[k], g.value))
        overrides.push({ key: k, machine: cfg[k], git: g.value, root: g.root });
      values.push({ key: k, value: cfg[k], source: 'machine', git: g.value, root: g.root });
      continue;
    }
    policy[k] = g.value as number;
    applied.push({ key: k, root: g.root });
    values.push({ key: k, value: g.value, source: 'git', git: g.value, root: g.root });
  }
  // `policy.test_changes` is the root's own: it goes under `test_changes.<root>`.
  const testChanges = { ...cfg.test_changes };
  for (const { root, swarm } of sources) {
    const g = swarm.policy?.test_changes;
    if (g === undefined) continue;
    const key = `test_changes.${root}`;
    const machine = cfg.test_changes[root];
    if (machine !== undefined) {
      if (!same(machine, g)) overrides.push({ key, machine, git: g, root });
      values.push({ key, value: machine, source: 'machine', git: g, root });
      continue;
    }
    testChanges[root] = g;
    applied.push({ key, root });
    values.push({ key, value: g, source: 'git', git: g, root });
  }

  // Git keys of runtimes this machine lacks, and defaults no runtime took: set, but in no effect.
  const seen = new Set(values.map((v) => v.key));
  for (const [key, g] of git) {
    if (key.startsWith('roles.') || key.startsWith('policy.') || seen.has(key)) continue;
    // `defaults.budget_min` is the budget's git value, listed as `budget_minutes`.
    if (key === 'defaults.budget_min') continue;
    const [area, name, k] = key.split('.');
    const used =
      area === 'defaults'
        ? values.some((v) => v.key.endsWith(`.${name}`) && same(v.git, g.value))
        : Object.hasOwn(cfg.runtimes, name!) && k !== undefined;
    if (!used) values.push({ key, value: g.value, source: 'unused', git: g.value, root: g.root });
  }
  // Of `defaults.budget_min` and `policy.budget_minutes`, the one that lost: set, but in no effect.
  const polBudget = git.get('policy.budget_minutes');
  const defBudget = git.get('defaults.budget_min');
  if (polBudget && defBudget) {
    const lostDefault = !earlier(defBudget, polBudget);
    const unusedBudget = lostDefault ? defBudget : polBudget;
    values.push({
      key: lostDefault ? 'defaults.budget_min' : 'policy.budget_minutes',
      value: unusedBudget.value,
      source: 'unused',
      git: unusedBudget.value,
      root: unusedBudget.root,
    });
  }
  values.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    config: { ...cfg, ...policy, runtimes, roles, test_changes: testChanges },
    applied,
    overrides,
    conflicts,
    values,
  };
}

/**
 * The overrides that bear on one run of `agent` (`<runtime>:<role>`): its runtime's and its
 * role's keys, as `runtimes.claude.model`.
 */
export function overridesFor(overrides: readonly DefsOverride[], agent: string): string[] {
  const at = agent.indexOf(':');
  const runtime = agent.slice(0, at);
  const role = agent.slice(at + 1);
  return overrides
    .filter((o) => o.key.startsWith(`runtimes.${runtime}.`) || o.key.startsWith(`roles.${role}.`))
    .map((o) => o.key)
    .sort();
}
