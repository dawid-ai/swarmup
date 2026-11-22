import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { ParseArgsConfig } from 'node:util';
import type { DefinitionSet, DefProblem, Root, UserConfig, Workspace } from '@swarmup/core';
import {
  assertNoSecret,
  checkDefinitionText,
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
  applyMigration,
  OpsError,
  ROOT_DIR_NAME,
  schemaFiles,
  setSwarmValues,
  shortHash,
  sortProblems,
  SWARM_FILE,
} from '@swarmup/core';
import type { OpsdConfig } from '@swarmup/supervisor';
import { importableConfig, lineDiff, opsdConfig, withDefinitions } from '@swarmup/supervisor';

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
  for (const dir of stores) {
    const set = loadDefinitions(dir, opts);
    sets.push(set);
    problems.push(...set.problems);
    checked.push(...set.files.map((f) => join(dir, f.path)));
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
    'defs show [--root NAME] | defs hash [--root NAME] | defs diff [REF] [--root NAME] | defs import-config [--root NAME] [--remove] | defs migrate [--root NAME] [--apply] [--prune] | defs propose ID --dir DIR --name NAME -m WHY [--scorer S]... [--agent ID]... | defs promote NAME [--root NAME] [-m NOTE] | defs reject NAME [--root NAME] -m WHY | defs variants [--root NAME]',
  summary:
    "definitions as code: show each root's swarm.yaml and what it sets under this machine's config, print the definition hash, diff the definitions against a git ref (default HEAD), write swarmupd.runtimes model and effort and swarmupd.roles from the user config into swarm.yaml; move legacy agent files into agent folders (migrate prints the change; --apply writes it, --prune also removes the legacy files); propose a change as a variant overlay (checked against the improvement policy), promote it onto the definitions or reject it (a person), and list the variants",
  options: {
    remove: { type: 'boolean' },
    apply: { type: 'boolean' },
    prune: { type: 'boolean' },
    dir: { type: 'string' },
    name: { type: 'string' },
    scorer: { type: 'string', multiple: true },
    agent: { type: 'string', multiple: true },
    message: { type: 'string', short: 'm' },
    'body-file': { type: 'string' },
  } satisfies NonNullable<ParseArgsConfig['options']>,
  run: (ctx: DefsCtx): number => {
    const [sub, ...rest] = ctx.args;
    switch (sub) {
      case 'show':
        return defsShow(ctx);
      case 'hash':
        return defsHash(ctx);
      case 'diff':
        return defsDiff(ctx, rest[0] ?? 'HEAD');
      case 'import-config':
        return importConfig(ctx);
      case 'migrate':
        return migrate(ctx);
      case 'propose':
        return propose(ctx, rest);
      case 'promote':
        return promote(ctx, rest);
      case 'reject':
        return reject(ctx, rest);
      case 'variants':
        return variants(ctx);
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

function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** The definition files of the store in `dir` at git `ref`, as path to text. */
function filesAt(dir: string, ref: string): Map<string, string> {
  let names: string[];
  try {
    names = gitIn(dir, ['ls-tree', '-r', '--name-only', ref, '--', SWARM_FILE, 'agents'])
      .split('\n')
      .filter(Boolean);
  } catch (err) {
    const why = ((err as { stderr?: string }).stderr ?? (err as Error).message).split('\n')[0];
    throw new OpsError(`git cannot read ${ref} in ${dir}: ${why}`, 2);
  }
  const out = new Map<string, string>();
  for (const name of names) out.set(name, normalText(gitIn(dir, ['show', `${ref}:./${name}`])));
  return out;
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
  if (!name || rest.length > 1) throw new OpsError('usage: swarmup defs promote NAME [-m NOTE]', 2);
  const res = ctx.ws().defsPromote(name, {
    root: str(ctx.opts.root),
    message: messageOf(ctx) || undefined,
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
