import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import type { DefinitionSet, DefProblem, Root, UserConfig, Workspace } from '@swarmup/core';
import {
  assertNoSecret,
  checkDefinitionText,
  checksHash,
  checksTrust,
  checksTrustProblem,
  effectiveSample,
  gitMergeChecks,
  daemonKeyIn,
  definitionHash,
  editUserConfig,
  formatProblem,
  loadDefinitions,
  logMigration,
  migrationDiff,
  migrationLogDir,
  normalText,
  planMigration,
  readDefsAtRef,
  applyMigration,
  OpsError,
  ROOT_DIR_NAME,
  scheduleTriggerText,
  schemaFiles,
  setSwarmValues,
  shortHash,
  sortProblems,
  SWARM_FILE,
  TRIGGER_NAME_RE,
  TRIGGERS_DIR,
  triggersHash,
  triggersTrust,
  triggersTrustProblem,
} from '@swarmup/core';
import type { OpsdConfig } from '@swarmup/supervisor';
import {
  importableConfig,
  scorerSettings,
  lineDiff,
  opsdConfig,
  withDefinitions,
} from '@swarmup/supervisor';
import type { TrustChange } from './trust.js';
import { recordTrust, requirePerson, triggerLines } from './trust.js';

/** What `swarmup validate` and `swarmup defs` need of the CLI's context. */
interface DefsCtx {
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    cwd: string;
    env: NodeJS.ProcessEnv;
  };
  args: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
  ws: () => Workspace;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The machine config, or undefined when the user config's swarmupd section does not check. */
function machineOf(user: UserConfig): OpsdConfig | undefined {
  try {
    return opsdConfig(user);
  } catch {
    return undefined;
  }
}

function loadOpts(ctx: DefsCtx, strict = false) {
  const cfg = machineOf(ctx.ws().user);
  return {
    strict,
    machineRuntimes: cfg ? Object.keys(cfg.runtimes) : undefined,
    machineAgents: cfg ? Object.keys(cfg.agents) : undefined,
    machineMcp: cfg ? Object.keys(cfg.mcp.servers) : undefined,
  };
}

/** The roots a command acts on: the one `--root` names, else every root that is no mirror. */
function rootsOf(ctx: DefsCtx): Root[] {
  const ws = ctx.ws();
  const name = str(ctx.opts.root);
  if (name) {
    const r = ws.roots.find((x) => x.name === name);
    if (!r) throw new OpsError(`no root named '${name}'`, 2);
    return [r];
  }
  if (ws.roots.length === 0) {
    throw new OpsError('no data root found: run `swarmup init` or set SWARMUP_ROOTS', 2);
  }
  return ws.roots.filter((r) => !r.isMirror);
}

/** The store folder a path names: a store itself, or a folder that holds `.swarmup/`. */
function storeAt(dir: string): string | null {
  const isStore = (d: string): boolean =>
    existsSync(join(d, SWARM_FILE)) ||
    existsSync(join(d, 'config.yml')) ||
    existsSync(join(d, 'agents'));
  if (basename(dir) === ROOT_DIR_NAME || isStore(dir)) return dir;
  const inner = join(dir, ROOT_DIR_NAME);
  return existsSync(inner) ? inner : null;
}

function show(ctx: DefsCtx, p: DefProblem): string {
  const rel = relative(ctx.io.cwd, p.file);
  return formatProblem({ ...p, file: rel && !rel.startsWith('..') ? rel : p.file });
}

/**
 * The problems of each root that has a swarm.yaml, as `swarmup validate` prints them, for
 * `swarmup agents`. Roots without one print nothing new.
 */
export function definitionProblemLines(ws: Workspace, cwd: string): string[] {
  const out: string[] = [];
  for (const r of ws.roots) {
    if (r.isMirror) continue;
    const set = loadDefinitions(r.dir);
    if (!set.present) continue;
    for (const p of set.problems) {
      const rel = relative(cwd, p.file);
      out.push(formatProblem({ ...p, file: rel && !rel.startsWith('..') ? rel : p.file }));
    }
  }
  return out;
}

// ---- swarmup validate ----------------------------------------------------------------------------

export const validateCommand = {
  usage: 'validate [PATH...] [--root NAME] [--variant NAME] [--strict] [--json] [--write-schemas]',
  summary:
    'check swarm.yaml and the agent files of each root (or the files and stores PATH names); prints file:line:col: severity: path: message; exit 1 on errors, or on warnings with --strict',
  options: {
    strict: { type: 'boolean' },
    'write-schemas': { type: 'boolean' },
    variant: { type: 'string' },
  } satisfies NonNullable<ParseArgsConfig['options']>,
  run: (ctx: DefsCtx): number => validate(ctx),
};

function validate(ctx: DefsCtx): number {
  const strict = Boolean(ctx.opts.strict);
  const problems: DefProblem[] = [];
  const checked: string[] = [];
  const stores: string[] = [];
  if (ctx.args.length > 0) {
    for (const arg of ctx.args) {
      const path = resolve(ctx.io.cwd, arg);
      if (!existsSync(path)) throw new OpsError(`${arg}: no such file or folder`, 2);
      if (statSync(path).isDirectory()) {
        const store = storeAt(path);
        if (!store) throw new OpsError(`${arg}: no task store (.swarmup/) here`, 2);
        stores.push(store);
      } else {
        problems.push(...checkDefinitionText(path, readFileSync(path, 'utf8'), { strict }));
        checked.push(path);
      }
    }
  } else stores.push(...rootsOf(ctx).map((r) => r.dir));
  const variant = str(ctx.opts.variant);
  const opts = { ...loadOpts(ctx, strict), ...(variant ? { variant } : {}) };
  const sets: DefinitionSet[] = [];
  const machine = machineOf(ctx.ws().user);
  for (const dir of stores) {
    const set = loadDefinitions(dir, opts);
    sets.push(set);
    problems.push(...set.problems);
    checked.push(...set.files.map((f) => join(dir, f.path)));
    // Merge checks in git run only where a person trusted them (W5 phase 4).
    const root = ctx.ws().roots.find((r) => resolve(r.dir) === resolve(dir));
    const trust =
      root && set.swarm
        ? checksTrustProblem(
            join(dir, SWARM_FILE),
            root.name,
            set.swarm.checks,
            machine?.trusted_defs[root.name]?.checks,
          )
        : null;
    if (trust) problems.push(trust);
    // Triggers this machine turned on fire only while it trusts their exact set.
    const tTrust =
      root && machine?.triggers[root.name] === true
        ? triggersTrustProblem(
            join(dir, TRIGGERS_DIR),
            root.name,
            set.triggers.flatMap((t) => (t.def ? [t.def] : [])),
            machine.trusted_defs[root.name]?.triggers,
          )
        : null;
    if (tTrust) problems.push(tTrust);
  }
  if (ctx.opts['write-schemas']) {
    for (const dir of stores) {
      const out = join(dir, '.schemas');
      mkdirSync(out, { recursive: true });
      for (const [name, text] of Object.entries(schemaFiles())) {
        writeFileSync(join(out, name), text);
        ctx.io.err(`wrote ${relative(ctx.io.cwd, join(out, name)) || join(out, name)}`);
      }
    }
  }
  const sorted = sortProblems(problems);
  const errors = sorted.filter((p) => p.severity === 'error').length;
  const warnings = sorted.length - errors;
  const failed = errors > 0 || (strict && warnings > 0);
  if (ctx.opts.json) {
    ctx.io.out(
      JSON.stringify(
        {
          ok: !failed,
          errors,
          warnings,
          stores: sets.map((s) => ({ dir: s.root, present: s.present, hash: s.hash })),
          problems: sorted,
        },
        null,
        2,
      ),
    );
    return failed ? 1 : 0;
  }
  for (const p of sorted) ctx.io.out(show(ctx, p));
  const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
  ctx.io.err(
    `${count(errors, 'error')}, ${count(warnings, 'warning')} in ${count(checked.length, 'file')}`,
  );
  return failed ? 1 : 0;
}

// ---- swarmup defs --------------------------------------------------------------------------------

export const defsCommand = {
  usage:
    'defs show [--root NAME] | defs hash [--root NAME] | defs trust [--root NAME] [--revoke] | defs diff [REF] [--root NAME] | defs import-config [--root NAME] [--remove] | defs import-schedules [--root NAME] [--apply] [--remove] | defs migrate [--root NAME] [--apply] [--prune] | defs propose ID --dir DIR --name NAME -m WHY [--scorer S]... [--agent ID]... | defs promote NAME [--root NAME] [-m NOTE] [--force] | defs reject NAME [--root NAME] -m WHY | defs rollback NAME [--root NAME] -m WHY [--force] | defs variants [--root NAME] | defs scorers [--root NAME]',
  summary:
    "definitions as code: show each root's swarm.yaml and what it sets under this machine's config, print the definition hash, trust the merge checks of a root's swarm.yaml on this machine (a person, outside runs; --revoke takes the trust back), diff the definitions against a git ref (default HEAD), write swarmupd.runtimes model and effort and swarmupd.roles from the user config into swarm.yaml; move swarmupd.schedules into triggers/ (import-schedules prints the files; --apply writes them, --remove also takes the schedules out of the user config and turns the root's triggers on here); move legacy agent files into agent folders (migrate prints the change; --apply writes it, --prune also removes the legacy files); list the scorers in git (scorers/*.yaml) with what this machine uses of them; propose a change as a variant overlay (checked against the improvement policy), promote it onto the definitions, reject it or roll a promote back (a person), and list the variants",
  options: {
    remove: { type: 'boolean' },
    revoke: { type: 'boolean' },
    apply: { type: 'boolean' },
    prune: { type: 'boolean' },
    dir: { type: 'string' },
    name: { type: 'string' },
    scorer: { type: 'string', multiple: true },
    agent: { type: 'string', multiple: true },
    message: { type: 'string', short: 'm' },
    'body-file': { type: 'string' },
  } satisfies NonNullable<ParseArgsConfig['options']>,
  run: (ctx: DefsCtx): number | Promise<number> => {
    const [sub, ...rest] = ctx.args;
    switch (sub) {
      case 'trust':
        return trust(ctx);
      case 'show':
        return defsShow(ctx);
      case 'hash':
        return defsHash(ctx);
      case 'diff':
        return defsDiff(ctx, rest[0] ?? 'HEAD');
      case 'import-config':
        return importConfig(ctx);
      case 'import-schedules':
        return importSchedules(ctx);
      case 'migrate':
        return migrate(ctx);
      case 'propose':
        return propose(ctx, rest);
      case 'promote':
        return promote(ctx, rest);
      case 'reject':
        return reject(ctx, rest);
      case 'rollback':
        return rollback(ctx, rest);
      case 'variants':
        return variants(ctx);
      case 'scorers':
        return scorers(ctx);
      default:
        throw new OpsError(`usage: swarmup ${defsCommand.usage}`, 2);
    }
  },
};

function defsShow(ctx: DefsCtx): number {
  const roots = rootsOf(ctx);
  const opts = loadOpts(ctx);
  const sets = roots.map((r) => ({ root: r, set: loadDefinitions(r.dir, opts) }));
  const machine = machineOf(ctx.ws().user);
  const sources = sets
    .filter((s) => s.set.swarm)
    .map((s) => ({ root: s.root.name, swarm: s.set.swarm! }));
  const merged = machine ? withDefinitions(machine, sources) : undefined;
  if (ctx.opts.json) {
    ctx.io.out(
      JSON.stringify(
        {
          roots: sets.map(({ root, set }) => ({
            root: root.name,
            dir: root.dir,
            present: set.present,
            hash: set.hash,
            files: set.files.map((f) => f.path),
            agents: set.agents.map((a) => a.id),
            swarm: set.swarm,
            problems: set.problems,
          })),
          applied: merged?.applied ?? [],
          overrides: merged?.overrides ?? [],
          conflicts: merged?.conflicts ?? [],
          checks: merged?.checks ?? [],
        },
        null,
        2,
      ),
    );
    return 0;
  }
  for (const { root, set } of sets) {
    const errors = set.problems.filter((p) => p.severity === 'error').length;
    const state = !set.present
      ? 'no swarm.yaml'
      : errors > 0
        ? `${errors} error(s): swarmup validate --root ${root.name}`
        : set.problems.length > 0
          ? `${set.problems.length} warning(s)`
          : 'ok';
    ctx.io.out(
      `${root.name}  ${shortHash(set.hash)}  ${set.agents.length} agent file(s)  ${state}`,
    );
  }
  if (!merged) {
    ctx.io.out('the swarmupd section of the user config does not check; run `swarmup doctor`');
    return 0;
  }
  for (const a of merged.applied) {
    ctx.io.out(`  ${a.key} = ${JSON.stringify(valueAt(merged.config, a.key))} (from ${a.root})`);
  }
  for (const o of merged.overrides) {
    ctx.io.out(
      `  ${o.key} = ${JSON.stringify(o.machine)} (this machine, over ${JSON.stringify(o.git)} from ${o.root})`,
    );
  }
  for (const c of merged.conflicts) {
    ctx.io.out(`  ${c.key}: ${c.roots.join(' and ')} differ; ${c.roots[0]} wins`);
  }
  for (const c of merged.checks) {
    const use = {
      git: 'the merge runs them',
      machine: `swarmupd.merge.${c.root}.checks wins`,
      skipped: `skipped until a person runs swarmup defs trust --root ${c.root}`,
      'no-merge': 'this machine does not merge the root',
    }[c.use];
    ctx.io.out(`  ${c.root}: ${c.count} merge check(s), ${c.trust}; ${use}`);
  }
  return 0;
}

/**
 * `swarmup defs trust`: a person, outside runs, trusts the merge checks of each root's
 * `swarm.yaml` and the root's triggers on this machine (Decision 7). The user config keeps the
 * hash of each exact set (`swarmupd.trusted_defs.<root>.{checks, triggers}`); any change to
 * either needs a new trust. `--revoke` takes both back.
 */
async function trust(ctx: DefsCtx): Promise<number> {
  const ws = ctx.ws();
  requirePerson(ws, 'trusts git definitions');
  const revoke = Boolean(ctx.opts.revoke);
  const changes: TrustChange[] = [];
  for (const root of rootsOf(ctx)) {
    if (revoke) {
      changes.push({ root: root.name, checks: null, triggers: null });
      ctx.io.out(`${root.name}: merge checks and triggers no longer trusted on this machine`);
      continue;
    }
    const set = loadDefinitions(root.dir);
    if (set.present && !set.swarm) {
      throw new OpsError(
        `${root.name}: swarm.yaml has errors; fix them first (swarmup validate --root ${root.name})`,
        1,
      );
    }
    const before = machineOf(ws.user)?.trusted_defs[root.name] ?? {};
    const change: TrustChange = { root: root.name };
    const checks = set.swarm?.checks;
    if (checks) {
      const hash = checksHash(checks);
      const state = checksTrust(checks, before.checks);
      ctx.io.out(
        `${root.name}: ${state === 'trusted' ? 'already trusts' : 'trusts'} these merge checks (${hash.slice(0, 14)}):`,
      );
      for (const c of gitMergeChecks(checks)) {
        ctx.io.out(
          typeof c === 'string' ? `  ${c}` : `  ${c.run}  (when it changes ${c.paths.join(', ')})`,
        );
      }
      if (state !== 'trusted') change.checks = hash;
    }
    const defs = set.triggers.flatMap((t) => (t.def ? [t.def] : []));
    const broken = set.triggers.length - defs.length;
    const tHash = triggersHash(defs);
    if (tHash) {
      const state = triggersTrust(defs, before.triggers);
      ctx.io.out(
        `${root.name}: ${state === 'trusted' ? 'already trusts' : 'trusts'} these triggers (${tHash.slice(0, 14)}):`,
      );
      for (const l of triggerLines(defs)) ctx.io.out(l);
      if (state !== 'trusted') change.triggers = tHash;
    }
    if (broken > 0) {
      ctx.io.err(
        `${root.name}: ${broken} trigger file(s) have errors; they are not trusted and never fire (swarmup validate --root ${root.name})`,
      );
    }
    if (!checks && !tHash) {
      ctx.io.out(
        `${root.name}: swarm.yaml names no merge checks and the store has no triggers; nothing to trust`,
      );
    }
    if (change.checks !== undefined || change.triggers !== undefined) changes.push(change);
  }
  await recordTrust(ctx.io.env, changes);
  return 0;
}

/**
 * `swarmup defs scorers`: each root's `scorers/*.yaml`: a built-in's threshold and filters, with
 * the machine's `pass` when it wins, and a rubric scorer's rubric, judge and sample (lowered to
 * the machine's `sample`), which swarmupd does not run yet.
 */
function scorers(ctx: DefsCtx): number {
  let settings: ReturnType<typeof scorerSettings> = {};
  try {
    settings = scorerSettings(ctx.ws().user);
  } catch (err) {
    ctx.io.err(`${(err as Error).message}; showing the git values alone`);
  }
  const rows = rootsOf(ctx).flatMap((root) =>
    loadDefinitions(root.dir).scorers.map((sc) => {
      const d = sc.def;
      const machine = d ? settings[d.kind === 'builtin' ? d.scorer! : d.id] : undefined;
      return {
        root: root.name,
        id: sc.id,
        file: sc.file,
        ok: d !== null,
        ...(d ? { def: d } : {}),
        ...(machine?.pass !== undefined && d?.kind === 'builtin'
          ? { machine_pass: machine.pass }
          : {}),
        ...(d?.kind === 'rubric' ? { sample: effectiveSample(d.sample, machine?.sample) } : {}),
        active: !!d && d.enabled && d.kind === 'builtin' && machine?.enabled !== false,
      };
    }),
  );
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) ctx.io.out('no scorers in git (scorers/*.yaml)');
  for (const r of rows) {
    const d = r.def;
    if (!d) {
      ctx.io.out(`${r.root}/${r.id}  has errors (swarmup validate --root ${r.root})`);
      continue;
    }
    const to = d.applies_to
      ? `  applies to ${Object.entries(d.applies_to)
          .map(([k, v]) => `${k} ${v.join(', ')}`)
          .join('; ')}`
      : '';
    const pass =
      r.machine_pass !== undefined
        ? `  pass ${r.machine_pass} (this machine, over ${d.pass ?? 'the default'})`
        : d.pass !== undefined
          ? `  pass ${d.pass}`
          : '';
    if (d.kind === 'builtin') {
      const state = !d.enabled ? 'off' : r.active ? 'on' : 'off on this machine';
      ctx.io.out(`${r.root}/${r.id}  builtin ${d.scorer}  ${state}${pass}${to}`);
    } else {
      const judge = d.judge
        ? `  judge ${[d.judge.runtime, d.judge.model, d.judge.effort].filter(Boolean).join(' ')}`
        : '';
      ctx.io.out(
        `${r.root}/${r.id}  rubric ${d.rubric}  not run yet${pass}  sample ${r.sample}${d.blind ? '  blind' : ''}${judge}${to}`,
      );
    }
  }
  return 0;
}

function valueAt(cfg: OpsdConfig, key: string): unknown {
  let v: unknown = cfg;
  for (const k of key.split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
  return v;
}

function defsHash(ctx: DefsCtx): number {
  const sets = rootsOf(ctx).map((r) => ({ root: r, set: loadDefinitions(r.dir) }));
  if (ctx.opts.json) {
    ctx.io.out(
      JSON.stringify(
        sets.map(({ root, set }) => ({ root: root.name, hash: set.hash, present: set.present })),
        null,
        2,
      ),
    );
    return 0;
  }
  for (const { root, set } of sets) ctx.io.out(`${root.name}  ${set.hash}`);
  return 0;
}

/** The definition files of the store in `dir` at git `ref`, as path to text. */
function filesAt(dir: string, ref: string): Map<string, string> {
  return readDefsAtRef(dir, ref).texts;
}

const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function defsDiff(ctx: DefsCtx, ref: string): number {
  for (const root of rootsOf(ctx)) {
    const now = loadDefinitions(root.dir);
    const then = filesAt(root.dir, ref);
    const thenHash = definitionHash([...then].map(([path, text]) => ({ path, sha256: sha(text) })));
    const nowFiles = new Map(now.files.map((f) => [f.path, f.sha256]));
    const paths = [...new Set([...then.keys(), ...nowFiles.keys()])].sort();
    const changes = paths.flatMap((p) => {
      const was = then.get(p);
      const is = nowFiles.get(p);
      if (was === undefined) return [`  added    ${p}`];
      if (is === undefined) return [`  removed  ${p}`];
      return sha(was) === is ? [] : [`  changed  ${p}`];
    });
    if (ctx.opts.json) {
      ctx.io.out(
        JSON.stringify({ root: root.name, ref, from: thenHash, to: now.hash, changes }, null, 2),
      );
      continue;
    }
    ctx.io.out(
      `${root.name}: ${ref} ${shortHash(thenHash)} -> working files ${shortHash(now.hash)}`,
    );
    if (changes.length === 0) ctx.io.out('  no change');
    for (const c of changes) ctx.io.out(c);
  }
  return 0;
}

function importConfig(ctx: DefsCtx): number {
  const ws = ctx.ws();
  const root = ws.defaultRoot();
  const { runtimes, roles } = importableConfig(ws.user);
  const file = join(root.dir, SWARM_FILE);
  const before = existsSync(file) ? normalText(readFileSync(file, 'utf8')) : '';
  if (Object.keys(runtimes).length === 0 && Object.keys(roles).length === 0) {
    ctx.io.out('nothing to import: the user config sets no runtime model or effort, and no roles');
    return 0;
  }
  const { text: after, keys: imported } = setSwarmValues(before, { runtimes, roles });
  // The result must check before it is written, and hold no secret.
  const problems = checkDefinitionText(file, after).filter((p) => p.severity === 'error');
  if (problems.length > 0) {
    for (const p of problems) ctx.io.err(show(ctx, p));
    throw new OpsError(`${SWARM_FILE} would not check; nothing was written`, 1);
  }
  assertNoSecret(after);
  const diff = lineDiff(before, after);
  if (before === after) ctx.io.out(`${relative(ctx.io.cwd, file) || file}: already up to date`);
  else {
    writeFileSync(file, after);
    ctx.io.out(`${before ? 'updated' : 'wrote'} ${relative(ctx.io.cwd, file) || file}:`);
    for (const l of diff) ctx.io.out(l);
  }
  if (!ctx.opts.remove) {
    ctx.io.out(
      'the user config keeps these keys, so this machine still overrides them; --remove takes them out',
    );
    return 0;
  }
  editUserConfig(ctx.io.env, (d) => {
    const key = daemonKeyIn(d);
    for (const k of imported) {
      const path = [key, ...k.split('.')];
      if (d.hasIn(path)) d.deleteIn(path);
    }
    // A role left with no settings goes; a runtime keeps its command.
    const empty = (path: string[]): boolean =>
      (d.getIn(path) as { items?: unknown[] } | undefined)?.items?.length === 0;
    for (const name of Object.keys(roles)) {
      if (empty([key, 'roles', name])) d.deleteIn([key, 'roles', name]);
    }
    if (empty([key, 'roles'])) d.deleteIn([key, 'roles']);
  });
  ctx.io.out(`removed ${imported.length} key(s) from the user config: ${imported.join(', ')}`);
  return 0;
}

/**
 * `swarmup defs import-schedules`: each `swarmupd.schedules` entry as `triggers/<name>.yaml` in the
 * root (`--root`, else the default root), with `runs_on` this machine when it has a name. Prints
 * the files; `--apply` writes them (never over a different file), and `--remove` then takes the
 * schedules out of the user config and turns the root's triggers on, so nothing fires twice.
 */
function importSchedules(ctx: DefsCtx): number {
  const ws = ctx.ws();
  const name = str(ctx.opts.root);
  const root = name ? ws.roots.find((r) => r.name === name) : ws.defaultRoot();
  if (!root) throw new OpsError(`no root named '${name}'`, 2);
  const machine = machineOf(ws.user);
  if (!machine) throw new OpsError('the swarmupd section of the user config does not check', 2);
  if (machine.schedules.length === 0) {
    ctx.io.out('nothing to import: the user config has no swarmupd.schedules');
    return 0;
  }
  const apply = Boolean(ctx.opts.apply);
  if (ctx.opts.remove && !apply) throw new OpsError('--remove needs --apply', 2);
  // Writing triggers and turning them on is the machine's decision: a person's, outside runs.
  if (apply) requirePerson(ws, 'moves schedules into triggers');
  const files: Array<{ name: string; file: string; text: string; same: boolean }> = [];
  for (const s of machine.schedules) {
    if (!TRIGGER_NAME_RE.test(s.name)) {
      throw new OpsError(
        `schedule '${s.name}' is no trigger name (lowercase letters, digits and -); rename it first`,
        2,
      );
    }
    const file = join(root.dir, TRIGGERS_DIR, `${s.name}.yaml`);
    // A trigger works on its own store's tasks only.
    let task = s.task;
    const slash = task?.lastIndexOf('/') ?? -1;
    if (task && slash >= 0) {
      if (task.slice(0, slash) !== root.name) {
        throw new OpsError(
          `schedule '${s.name}' works on ${task}, a task of another store; a trigger of ${root.name} cannot`,
          2,
        );
      }
      task = task.slice(slash + 1);
    }
    const text = scheduleTriggerText({ ...s, task, machine: ws.user.machine });
    const problems = checkDefinitionText(file, text).filter((p) => p.severity === 'error');
    if (problems.length > 0) {
      for (const p of problems) ctx.io.err(show(ctx, p));
      throw new OpsError(
        `schedule '${s.name}' does not make a valid trigger; nothing was written`,
        1,
      );
    }
    assertNoSecret(text);
    const before = existsSync(file) ? normalText(readFileSync(file, 'utf8')) : null;
    if (before !== null && before !== text) {
      throw new OpsError(
        `${relative(ctx.io.cwd, file) || file} exists with other content; nothing was written`,
        2,
      );
    }
    files.push({ name: s.name, file, text, same: before === text });
  }
  for (const f of files) {
    const rel = relative(ctx.io.cwd, f.file) || f.file;
    if (!apply) {
      ctx.io.out(`# ${rel}${f.same ? ' (already there)' : ''}`);
      for (const l of f.text.trimEnd().split('\n')) ctx.io.out(l);
      continue;
    }
    if (!f.same) {
      mkdirSync(join(root.dir, TRIGGERS_DIR), { recursive: true });
      writeFileSync(f.file, f.text);
    }
    ctx.io.out(`${f.same ? 'kept' : 'wrote'} ${rel}`);
  }
  if (!apply) {
    ctx.io.out(
      `nothing written; --apply writes the files, --remove also moves the schedules out of the user config`,
    );
    return 0;
  }
  if (!ctx.opts.remove) {
    ctx.io.out(
      `the user config keeps swarmupd.schedules; with swarmupd.triggers.${root.name} on, both would fire, so --remove takes them out`,
    );
    return 0;
  }
  const names = new Set(files.map((f) => f.name));
  editUserConfig(ctx.io.env, (d) => {
    const key = daemonKeyIn(d);
    const list =
      (d.getIn([key, 'schedules']) as { items?: unknown[]; toJSON?: () => unknown }) ?? {};
    const items = (list.toJSON?.() ?? []) as Array<{ name?: string }>;
    for (let i = items.length - 1; i >= 0; i--) {
      if (names.has(String(items[i]?.name))) d.deleteIn([key, 'schedules', i]);
    }
    if ((d.getIn([key, 'schedules']) as { items?: unknown[] } | undefined)?.items?.length === 0) {
      d.deleteIn([key, 'schedules']);
    }
    d.setIn([key, 'triggers', root.name], true);
  });
  ctx.io.out(
    `removed ${names.size} schedule(s) from the user config and turned on swarmupd.triggers.${root.name}; they fire once you trust them: swarmup defs trust --root ${root.name}`,
  );
  return 0;
}

// ---- swarmup defs propose | promote | reject | variants (W6) --------------------------------------

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .flatMap((x) => String(x).split(','))
    .map((x) => x.trim())
    .filter(Boolean);

function messageOf(ctx: DefsCtx): string {
  const m = ctx.opts.message;
  const file = str(ctx.opts['body-file']);
  if (file) return readFileSync(file === '-' ? 0 : resolve(ctx.io.cwd, file), 'utf8');
  return Array.isArray(m) ? m.join('\n\n') : (str(m) ?? '');
}

function propose(ctx: DefsCtx, rest: string[]): number {
  const id = rest[0];
  const dir = str(ctx.opts.dir);
  const name = str(ctx.opts.name);
  if (!id || rest.length > 1 || !dir || !name) {
    throw new OpsError('usage: swarmup defs propose ID --dir DIR --name NAME -m "why"', 2);
  }
  const res = ctx.ws().defsPropose(id, {
    dir: resolve(ctx.io.cwd, dir),
    name,
    message: messageOf(ctx),
    scorers: list(ctx.opts.scorer),
    agents: list(ctx.opts.agent),
  });
  if (ctx.opts.json) {
    ctx.io.out(
      JSON.stringify(
        { ...res.proposal, variant: res.variant, root: res.root, dir: res.dir },
        null,
        2,
      ),
    );
    return 0;
  }
  ctx.io.out(
    `${res.root}/${res.variant}  ${shortHash(res.proposal.hash)}  proposed on ${res.proposal.task} (${res.events[0]?.id ?? ''})`,
  );
  const rel = relative(ctx.io.cwd, res.dir);
  ctx.io.out(`  wrote ${rel && !rel.startsWith('..') ? rel : res.dir}`);
  ctx.io.out(
    `  a person promotes it with \`swarmup defs promote ${res.variant}\` or rejects it with \`swarmup defs reject ${res.variant} -m "why"\``,
  );
  return 0;
}

function promote(ctx: DefsCtx, rest: string[]): number {
  const name = rest[0];
  if (!name || rest.length > 1) {
    throw new OpsError('usage: swarmup defs promote NAME [-m NOTE] [--force]', 2);
  }
  const res = ctx.ws().defsPromote(name, {
    root: str(ctx.opts.root),
    message: messageOf(ctx) || undefined,
    force: Boolean(ctx.opts.force),
  });
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(res, null, 2));
    return 0;
  }
  ctx.io.out(
    `${res.root}/${res.variant}: promoted ${shortHash(res.from ?? '')} -> ${shortHash(res.to ?? '')}`,
  );
  for (const p of res.written ?? []) ctx.io.out(`  wrote   ${p}`);
  for (const p of res.removed ?? []) ctx.io.out(`  removed ${p}`);
  if (res.proposal) ctx.io.out(`  recorded on ${res.proposal.task}`);
  // The proposal folded learn notes into the role (W6): they now say what the role file says.
  if (res.notes?.length) {
    ctx.io.out(
      `  it folds in learn notes ${res.notes.join(', ')}; archive them with ` +
        `\`swarmup kb archive ${res.notes.join(' ')} -m "folded into ${res.variant}"\``,
    );
  }
  return 0;
}

function reject(ctx: DefsCtx, rest: string[]): number {
  const name = rest[0];
  if (!name || rest.length > 1) throw new OpsError('usage: swarmup defs reject NAME -m "why"', 2);
  const res = ctx.ws().defsReject(name, messageOf(ctx), { root: str(ctx.opts.root) });
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(res, null, 2));
    return 0;
  }
  ctx.io.out(
    `${res.root}/${res.variant}: rejected${res.proposal ? `, recorded on ${res.proposal.task}` : ''}`,
  );
  return 0;
}

function rollback(ctx: DefsCtx, rest: string[]): number {
  const name = rest[0];
  if (!name || rest.length > 1) {
    throw new OpsError('usage: swarmup defs rollback NAME -m "why" [--force]', 2);
  }
  const res = ctx.ws().defsRollback(name, messageOf(ctx), {
    root: str(ctx.opts.root),
    force: Boolean(ctx.opts.force),
  });
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(res, null, 2));
    return 0;
  }
  ctx.io.out(
    `${res.root}/${res.variant}: rolled back ${shortHash(res.from ?? '')} -> ${shortHash(res.to ?? '')}`,
  );
  for (const p of res.written ?? []) ctx.io.out(`  restored ${p}`);
  for (const p of res.removed ?? []) ctx.io.out(`  removed  ${p}`);
  if (res.events.length > 0) ctx.io.out("  recorded on the proposal's task");
  return 0;
}

/**
 * `swarmup defs migrate`: prints, for each root, the agent folders that would replace its legacy
 * agent files, as a diff. `--apply` writes them; `--prune` writes them and removes the legacy
 * files. Each root refuses unless its folders give every agent the same fields; an applied
 * migration is logged to migrations.log.
 */
function migrate(ctx: DefsCtx): number {
  const prune = Boolean(ctx.opts.prune);
  const apply = Boolean(ctx.opts.apply) || prune;
  let code = 0;
  const report: Array<Record<string, unknown>> = [];
  for (const root of rootsOf(ctx)) {
    const plan = planMigration(root.dir);
    const texts = loadDefinitions(root.dir).texts;
    const entry: Record<string, unknown> = { ...plan, root: root.name, dir: root.dir };
    report.push(entry);
    const say = (line: string): void => {
      if (!ctx.opts.json) ctx.io.out(line);
    };
    if (plan.agents.length === 0 && plan.refused.length === 0) {
      say(`${root.name}: no legacy agent files to migrate`);
      for (const s of plan.skipped) say(`  skipped ${s}`);
      continue;
    }
    if (plan.refused.length > 0) {
      code = 1;
      say(`${root.name}: the migration refuses; nothing changes:`);
      for (const r of plan.refused) say(`  ${r}`);
      continue;
    }
    say(
      `${root.name}: ${plan.agents.length} agent(s) into ${Object.keys(plan.writes).length} file(s): ${plan.agents.join(', ')}`,
    );
    for (const s of plan.skipped) say(`  skipped ${s}`);
    if (!apply) {
      say(migrationDiff(plan, texts, prune));
      say(
        `dry run: \`swarmup defs migrate --root ${root.name} --apply\` writes the folders, --prune also removes the legacy files`,
      );
      continue;
    }
    const done = applyMigration(plan, { prune });
    entry.wrote = done.wrote;
    entry.removed = done.removed;
    logMigration(
      migrationLogDir(ctx.io.env),
      `defs migrate: ${root.name} (${root.dir}): ${plan.agents.join(', ')} into agent folders; ` +
        `wrote ${done.wrote.join(', ') || 'nothing'}` +
        (done.removed.length > 0 ? `; removed ${done.removed.join(', ')}` : '; legacy files kept'),
    );
    if (done.wrote.length > 0) say(`wrote ${done.wrote.join(', ')}`);
    if (done.removed.length > 0) say(`removed ${done.removed.join(', ')}`);
    else say('the legacy files stay and win until `swarmup defs migrate --prune` removes them');
  }
  if (ctx.opts.json) ctx.io.out(JSON.stringify(report, null, 2));
  return code;
}

function variants(ctx: DefsCtx): number {
  const name = str(ctx.opts.root);
  const all = ctx
    .ws()
    .variants()
    .filter((v) => !name || v.root === name);
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(all, null, 2));
    return 0;
  }
  if (all.length === 0) {
    ctx.io.out('no variants');
    return 0;
  }
  for (const v of all) {
    const state = [
      v.status,
      v.stale ? 'stale: the base changed since' : '',
      v.ok ? '' : `${v.problems.length} problem(s)`,
    ]
      .filter(Boolean)
      .join(', ');
    ctx.io.out(
      `${v.root}/${v.name}  ${shortHash(v.hash)}  ${state}  ${v.proposal?.task ?? '-'}  ${v.agents.join(',') || '-'}`,
    );
    for (const f of v.files) ctx.io.out(`  ${f.kind.padEnd(8)} ${f.path}`);
    for (const p of v.problems) ctx.io.out(`  problem: ${p}`);
  }
  return 0;
}
