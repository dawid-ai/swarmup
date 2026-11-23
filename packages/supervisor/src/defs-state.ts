/**
 * What swarmupd knows of each root's definitions (W5): the sets it read, the last good
 * `swarm.yaml` of each root, the effective config, and the store commit of each definition hash.
 * The commit is read with git off the event loop, never in `launch` (AO-0171).
 */
import type { DefinitionSet, DefProblem, SwarmDefs } from '@swarmup/core';
import {
  DEF_FOLDERS,
  definitionsFingerprint,
  loadDefinitions,
  shortHash,
  SWARM_FILE,
  untrustedChecksText,
} from '@swarmup/core';
import type { OpsdConfig } from './config.js';
import type { DefsChecks, DefsMerge, DefsSource } from './defs-config.js';
import { overridesFor, withDefinitions } from './defs-config.js';
import { gitAsync } from './git.js';
import type { RunDefs } from './runs.js';
import type { StateDb } from './state-db.js';

/** A root swarmupd reads definitions from. */
export interface DefsRoot {
  name: string;
  dir: string;
}

/** The store commit of a definition hash: the last commit that changed a definition file. */
export interface DefsCommit {
  commit?: string;
  /** A definition file has changes git has not committed. */
  dirty?: boolean;
}

/** One root's definitions, for `GET /api/defs`. */
export interface DefsRootView {
  root: string;
  dir: string;
  present: boolean;
  hash: string;
  short: string;
  commit?: string;
  dirty?: boolean;
  ok: boolean;
  /** swarmupd uses the last good `swarm.yaml` of this root, because the current one has errors. */
  stale: boolean;
  agents: number;
  problems: DefProblem[];
  /** The text of `swarm.yaml` as hashed (no BOM, LF line ends), when the root has one. */
  text?: string;
}

export interface DefsView {
  roots: DefsRootView[];
  applied: DefsMerge['applied'];
  overrides: DefsMerge['overrides'];
  conflicts: DefsMerge['conflicts'];
  /** Each key the git definitions set: the value in effect and its source (git or machine). */
  values: DefsMerge['values'];
  /** Each root's `swarm.yaml` merge checks: trusted here or not, and what the merge runs. */
  checks: DefsChecks[];
}

interface RootDefs extends DefsRoot {
  set: DefinitionSet;
  stale: boolean;
}

export interface DefsStateOptions {
  state: StateDb | null;
  now: () => number;
  warn: (message: string) => void;
  env?: () => NodeJS.ProcessEnv;
  /** How long one git call of the commit lookup may take. */
  gitTimeoutMs?: number;
}

const keyOf = (dir: string, hash: string): string => `${dir}\0${hash}`;

export class DefsState {
  private fingerprint: string | null = null;
  private roots: RootDefs[] = [];
  private readonly lastGood = new Map<string, SwarmDefs>();
  private merge: DefsMerge | null = null;
  /** Per root folder and hash: the commit, or null while the lookup runs. */
  private readonly commits = new Map<string, DefsCommit | null>();
  private readonly lookups = new Set<Promise<void>>();
  private readonly warned = new Set<string>();

  constructor(private readonly opts: DefsStateOptions) {}

  /** Paths, sizes and change times of every root's definition files; no content is read. */
  private fingerprintOf(roots: readonly DefsRoot[]): string {
    return roots.map((r) => `${r.name}\n${r.dir}\n${definitionsFingerprint(r.dir)}`).join('\n\n');
  }

  /** True when a definition file of the roots changed since the last {@link apply}. */
  changed(roots: readonly DefsRoot[]): boolean {
    return this.fingerprintOf(roots) !== this.fingerprint;
  }

  /**
   * Reads each root's definitions and returns `machine` with the git values merged under it. A
   * root whose `swarm.yaml` has errors keeps its last good one, with one warning per hash.
   * Without a `swarm.yaml` in any root, `machine` comes back unchanged.
   */
  apply(machine: OpsdConfig, roots: readonly DefsRoot[]): OpsdConfig {
    this.fingerprint = this.fingerprintOf(roots);
    const sources: DefsSource[] = [];
    this.roots = roots.map((r) => {
      const set = loadDefinitions(r.dir);
      let stale = false;
      // An agent file's `writes` sets its role's (W5): the first agent of the role that sets it.
      const roleWrites: Record<string, boolean> = {};
      for (const a of set.agents) {
        const role = a.id.slice(a.id.indexOf(':') + 1);
        if (typeof a.writes === 'boolean' && roleWrites[role] === undefined)
          roleWrites[role] = a.writes;
      }
      const writes = Object.keys(roleWrites).length > 0 ? { roleWrites } : {};
      if (!set.present && writes.roleWrites) {
        sources.push({ root: r.name, swarm: { swarmup_defs: 1 }, ...writes });
      }
      if (set.present) {
        if (set.swarm) this.lastGood.set(r.dir, set.swarm);
        else {
          stale = this.lastGood.has(r.dir);
          const told = keyOf(r.dir, set.hash);
          if (!this.warned.has(told)) {
            this.warned.add(told);
            this.opts.warn(
              `${r.name}: ${SWARM_FILE} has errors (\`swarmup validate\` lists them); swarmupd ` +
                (stale ? 'keeps its last good definitions' : 'uses no git definitions for it'),
            );
          }
        }
        const swarm = set.swarm ?? this.lastGood.get(r.dir);
        if (swarm) sources.push({ root: r.name, swarm, ...writes });
        this.lookUp(r, set);
      }
      return { ...r, set, stale };
    });
    this.merge = withDefinitions(machine, sources);
    for (const c of this.merge.checks) {
      if (c.trust === 'trusted') continue;
      const told = `checks\0${c.root}\0${c.hash}`;
      if (this.warned.has(told)) continue;
      this.warned.add(told);
      this.opts.warn(untrustedChecksText(c.root, c.trust, c.count));
    }
    for (const c of this.merge.conflicts) {
      const told = `conflict\0${c.key}\0${c.roots.join(',')}`;
      if (this.warned.has(told)) continue;
      this.warned.add(told);
      this.opts.warn(
        `${c.key} differs in the ${SWARM_FILE} of ${c.roots.join(' and ')}; swarmupd uses ${c.roots[0]}'s`,
      );
    }
    return this.merge.config;
  }

  /**
   * Starts the commit lookup of a definition hash once, off the event loop, and keeps the
   * hash's files in `state.db` when it ends.
   */
  private lookUp(r: DefsRoot, set: DefinitionSet): void {
    const key = keyOf(r.dir, set.hash);
    if (this.commits.has(key)) return;
    this.commits.set(key, null);
    const git = (args: string[]): Promise<string> =>
      gitAsync(r.dir, args, {
        env: this.opts.env?.(),
        ...(this.opts.gitTimeoutMs ? { timeoutMs: this.opts.gitTimeoutMs } : {}),
      });
    const paths = ['--', SWARM_FILE, ...DEF_FOLDERS];
    const job = (async () => {
      let found: DefsCommit = {};
      try {
        const status = await git(['status', '--porcelain', '--untracked-files=all', ...paths]);
        if (status.trim()) found = { dirty: true };
        else {
          const commit = (await git(['log', '-1', '--format=%H', ...paths])).trim();
          if (commit) found = { commit };
        }
      } catch {
        // Not a git repo, or git failed: the runs record the hash alone.
      }
      this.commits.set(key, found);
      try {
        this.opts.state?.saveDefinitions({
          hash: set.hash,
          root: r.name,
          commit: found.commit ?? null,
          created_at: new Date(this.opts.now()).toISOString(),
          files: set.files.map((f) => ({
            path: f.path,
            sha256: f.sha256,
            text: set.texts[f.path] ?? '',
          })),
        });
      } catch (err) {
        this.opts.warn(
          `could not keep definitions ${shortHash(set.hash)}: ${(err as Error).message}`,
        );
      }
    })();
    this.lookups.add(job);
    void job.finally(() => this.lookups.delete(job));
  }

  /** Resolves when the commit lookups started so far have ended; for tests and `close`. */
  async settled(): Promise<void> {
    while (this.lookups.size > 0) await Promise.all([...this.lookups]);
  }

  /**
   * The definitions stamp of a run of `agent` on a task of root `rootName` (none for a run
   * without a task): that root's set when it has a `swarm.yaml`, else the first root's that has
   * one. Undefined when no root has one, so such runs record nothing new. The commit is there
   * only once its lookup has ended. `local` adds machine keys that overrode git for this run.
   */
  stamp(rootName: string | undefined, agent: string, local: string[] = []): RunDefs | undefined {
    const present = this.roots.filter((r) => r.set.present);
    const r = (rootName ? present.find((x) => x.name === rootName) : undefined) ?? present[0];
    if (!r) return undefined;
    const c = this.commits.get(keyOf(r.dir, r.set.hash));
    const keys = [
      ...new Set([...overridesFor(this.merge?.overrides ?? [], agent), ...local]),
    ].sort();
    return {
      root: r.name,
      hash: r.set.hash,
      ...(c?.commit ? { commit: c.commit } : {}),
      ...(c?.dirty ? { dirty: true } : {}),
      ...(keys.length > 0 ? { local: keys } : {}),
    };
  }

  /** Where root `root`'s `swarm.yaml` merge checks stand here; undefined when it names none. */
  checks(root: string): DefsChecks | undefined {
    return this.merge?.checks.find((c) => c.root === root);
  }

  /** Every root's definitions and what they changed in the config, for the API. */
  view(): DefsView {
    return {
      roots: this.roots.map((r) => {
        const c = this.commits.get(keyOf(r.dir, r.set.hash));
        return {
          root: r.name,
          dir: r.dir,
          present: r.set.present,
          hash: r.set.hash,
          short: shortHash(r.set.hash),
          ...(c?.commit ? { commit: c.commit } : {}),
          ...(c?.dirty ? { dirty: true } : {}),
          ok: r.set.ok,
          stale: r.stale,
          agents: r.set.agents.length,
          problems: r.set.problems,
          ...(r.set.present ? { text: r.set.texts[SWARM_FILE] ?? '' } : {}),
        };
      }),
      applied: this.merge?.applied ?? [],
      overrides: this.merge?.overrides ?? [],
      conflicts: this.merge?.conflicts ?? [],
      values: this.merge?.values ?? [],
      checks: this.merge?.checks ?? [],
    };
  }
}
