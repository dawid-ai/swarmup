/**
 * swarmupd's effective config: the machine's `swarmupd` section with the git definitions
 * (`swarm.yaml`) of each root merged under it. At equal specificity the machine wins, and each
 * machine key that overrode a git value is recorded.
 */
import type { SwarmDefs } from '@swarmup/core';
import type { OpsdConfig, RoleConfig, RuntimeConfig } from './config.js';

/** The `swarm.yaml` of one root, for {@link withDefinitions}. */
export interface DefsSource {
  /** The root's name. */
  root: string;
  swarm: SwarmDefs;
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

export interface DefsMerge {
  config: OpsdConfig;
  /** Git keys the config took, each with the root it came from. */
  applied: Array<{ key: string; root: string }>;
  overrides: DefsOverride[];
  conflicts: DefsConflict[];
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
 * Merges git `roles` and `runtimes.<rt>.{model, effort}` (then `defaults.{model, effort}`) under
 * the machine values of `cfg`. `sources` come in root order: for a key two roots set, the first
 * one wins and the pair is named in `conflicts`. Git never adds a runtime: commands are
 * machine-only, so a runtime this machine lacks is skipped. Without sources, `cfg` comes back
 * as it is.
 */
export function withDefinitions(cfg: OpsdConfig, sources: readonly DefsSource[]): DefsMerge {
  const applied: DefsMerge['applied'] = [];
  const overrides: DefsOverride[] = [];
  const conflicts: DefsConflict[] = [];
  if (sources.length === 0) return { config: cfg, applied, overrides, conflicts };

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
  for (const { root, swarm } of sources) {
    for (const [rt, r] of Object.entries(swarm.runtimes ?? {})) {
      put(`runtimes.${rt}.model`, r.model, root);
      put(`runtimes.${rt}.effort`, r.effort, root);
    }
    put('defaults.model', swarm.defaults?.model, root);
    put('defaults.effort', swarm.defaults?.effort, root);
    for (const [role, r] of Object.entries(swarm.roles ?? {})) {
      for (const k of ROLE_KEYS) put(`roles.${role}.${k}`, r[k], root);
    }
  }

  const runtimes: Record<string, RuntimeConfig> = {};
  for (const [rt, rc] of Object.entries(cfg.runtimes)) {
    const next: RuntimeConfig = { ...rc };
    for (const k of ['model', 'effort'] as const) {
      const g = git.get(`runtimes.${rt}.${k}`) ?? git.get(`defaults.${k}`);
      if (!g) continue;
      if (rc[k] !== undefined) {
        if (!same(rc[k], g.value)) {
          overrides.push({
            key: `runtimes.${rt}.${k}`,
            machine: rc[k],
            git: g.value,
            root: g.root,
          });
        }
        continue;
      }
      next[k] = g.value as string;
      applied.push({ key: `runtimes.${rt}.${k}`, root: g.root });
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
      if (machine[k] !== undefined) {
        if (!same(machine[k], g.value)) {
          overrides.push({
            key: `roles.${role}.${k}`,
            machine: machine[k],
            git: g.value,
            root: g.root,
          });
        }
        continue;
      }
      (next as Record<string, unknown>)[k] = g.value;
      applied.push({ key: `roles.${role}.${k}`, root: g.root });
    }
    roles[role] = next;
  }
  return { config: { ...cfg, runtimes, roles }, applied, overrides, conflicts };
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
