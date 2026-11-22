// W5 phases 2 and 3 from the command line: `swarmup defs migrate` (dry run, --apply, --prune,
// refusal, migrations.log), `swarmup workflow list|show|start`, `swarmup plan propose --workflow`,
// and `work_types` defaults on `swarmup new`. Each command stays synchronous.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, TEMPLATES_DIR } from '@swarmup/core';
import { run } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): { dir: string; store: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmup-w5-cli-'));
  dirs.push(dir);
  const store = initRoot(dir, { name: 'demo', human: 'human:dawid' });
  return { dir, store, config: join(dir, 'user.yml') };
}

function cli(
  dir: string,
  config: string,
  ...argv: string[]
): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, SWARMUP_CONFIG: config };
  delete env.SWARMUP_ROOTS;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_RUN;
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: dir });
  if (typeof code !== 'number' && code !== undefined)
    throw new Error(`${argv[0]} must stay synchronous`);
  return { code: code ?? 0, out, err };
}

const LEGACY = {
  'claude-writer.md': '---\nname: Writer\nmodel: opus\n---\n\nWrite.\n',
  'codex-writer.md': '---\nname: Writer\neffort: high\n---\n\nWrite.\n',
};

describe('swarmup defs migrate', () => {
  it('prints a diff by default and writes nothing', () => {
    const { dir, store, config } = project();
    for (const [f, t] of Object.entries(LEGACY)) writeFileSync(join(store, 'agents', f), t);
    const res = cli(dir, config, 'defs', 'migrate');
    expect(res.code).toBe(0);
    expect(res.out[0]).toBe('demo: 2 agent(s) into 3 file(s): claude:writer, codex:writer');
    const text = res.out.join('\n');
    expect(text).toContain('+++ agents/writer/agent.md');
    expect(text).toContain('+name: Writer');
    expect(res.out.at(-1)).toContain('dry run');
    expect(existsSync(join(store, 'agents', 'writer'))).toBe(false);
    const pruned = cli(dir, config, 'defs', 'migrate', '--prune', '--json');
    expect(pruned.code).toBe(1);
    expect(pruned.err.join('\n')).toContain('swarmup_defs: 1');
  });

  it('applies, prunes and logs once swarm.yaml names swarmup_defs: 1', () => {
    const { dir, store, config } = project();
    for (const [f, t] of Object.entries(LEGACY)) writeFileSync(join(store, 'agents', f), t);
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\n');
    const before = cli(dir, config, 'agents', '--json');
    const applied = cli(dir, config, 'defs', 'migrate', '--apply');
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(
      'wrote agents/writer/agent.md, agents/writer/claude.md, agents/writer/codex.md',
    );
    expect(existsSync(join(store, 'agents', 'claude-writer.md'))).toBe(true);
    const pruned = cli(dir, config, 'defs', 'migrate', '--prune');
    // The folders exist now, so the role is skipped; prune the files of a fresh plan instead.
    expect(pruned.out.join('\n')).toContain('skipped writer: agents/writer/ exists');
    rmSync(join(store, 'agents', 'writer'), { recursive: true });
    const again = cli(dir, config, 'defs', 'migrate', '--prune');
    expect(again.code).toBe(0);
    expect(again.out).toContain('removed agents/claude-writer.md, agents/codex-writer.md');
    const after = cli(dir, config, 'agents', '--json');
    const strip = (text: string) =>
      (JSON.parse(text) as Array<Record<string, unknown>>).map(
        ({ id, name, model, effort, status }) => ({
          id,
          name,
          model,
          effort,
          status,
        }),
      );
    expect(strip(after.out.join('\n'))).toEqual(strip(before.out.join('\n')));
    const log = readFileSync(join(dir, 'migrations.log'), 'utf8');
    expect(log).toContain('defs migrate: demo');
    expect(log).toContain('removed agents/claude-writer.md, agents/codex-writer.md');
  });

  it('refuses when a legacy file does not read', () => {
    const { dir, store, config } = project();
    writeFileSync(join(store, 'agents', 'claude-pm.md'), '---\ncan_claim: nope\n---\n');
    const res = cli(dir, config, 'defs', 'migrate', '--apply');
    expect(res.code).toBe(1);
    expect(res.out[0]).toBe('demo: the migration refuses; nothing changes:');
  });
});

/** A store with the starter workflows and the agents they name. */
function withWorkflows(): { dir: string; store: string; config: string } {
  const p = project();
  mkdirSync(join(p.store, 'workflows'), { recursive: true });
  for (const id of ['bugfix', 'feature', 'content-piece']) {
    copyFileSync(
      join(TEMPLATES_DIR, 'workflows', `${id}.yaml`),
      join(p.store, 'workflows', `${id}.yaml`),
    );
  }
  return p;
}

describe('swarmup workflow', () => {
  it('lists the workflows and shows one compiled', () => {
    const { dir, config } = withWorkflows();
    const list = cli(dir, config, 'workflow', 'list');
    expect(list.code).toBe(0);
    expect(list.out[0]).toMatch(
      /^bugfix\s+starter\s+3 stage\(s\)\s+params: bug, severity\s+Bug fix$/,
    );
    expect(list.out).toHaveLength(3);
    const show = cli(
      dir,
      config,
      'workflow',
      'show',
      'feature',
      '--param',
      'feature=CSV export',
      '--param',
      'docs=no',
    );
    expect(show.code).toBe(0);
    expect(show.out).toContain('milestone: Feature: CSV export');
    expect(
      show.out.some((l) =>
        /^spec-ok\s+human:dawid\s+15m\s+spec\s+Is the spec for CSV export what you want built\?\s+\[gate, revise\]$/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(show.out).toContain('left out by when: docs');
    const yaml = cli(dir, config, 'workflow', 'show', 'bugfix', '--yaml');
    expect(yaml.out.join('\n')).toContain('title: "Reproduce: <bug>"');
  });

  it('starts a starter workflow approved for a person, and refuses a missing parameter', () => {
    const { dir, config } = withWorkflows();
    const bad = cli(dir, config, 'workflow', 'start', 'bugfix', '--as', 'human:dawid');
    expect(bad.code).toBe(2);
    expect(bad.err.join('\n')).toContain('workflow bugfix needs --param bug=...');
    const res = cli(
      dir,
      config,
      'workflow',
      'start',
      'bugfix',
      '--param',
      'bug=crash on save',
      '--as',
      'human:dawid',
    );
    expect(res.code).toBe(0);
    expect(res.out).toEqual(['T-0001']);
    expect(res.err[0]).toBe(
      'note: T-0001 started from workflow bugfix: the plan is approved, 3 task(s) created',
    );
    const show = cli(dir, config, 'show', 'T-0001', '--json');
    expect(JSON.parse(show.out.join('\n')).meta).toMatchObject({
      workflow: 'bugfix',
      title: 'Fix: crash on save',
    });
  });

  it('proposes a workflow on a held milestone with plan propose --workflow', () => {
    const { dir, config } = withWorkflows();
    cli(
      dir,
      config,
      'new',
      'Ship CSV',
      '--type',
      'milestone',
      '--to',
      'claude:pm',
      '--done-when',
      'CSV export works',
      '--as',
      'human:dawid',
    );
    cli(dir, config, 'claim', 'T-0001', '--as', 'claude:pm');
    cli(dir, config, 'start', 'T-0001', 'planning', '--as', 'claude:pm');
    const res = cli(
      dir,
      config,
      'plan',
      'propose',
      'T-0001',
      '--workflow',
      'feature',
      '--param',
      'feature=CSV export',
      '--as',
      'claude:pm',
    );
    expect(res.code).toBe(0);
    const plan = cli(dir, config, 'plan', 'show', 'T-0001', '--json');
    expect(
      JSON.parse(plan.out.join('\n')).pending.items.map((i: { key: string }) => i.key),
    ).toEqual(['spec', 'spec-ok', 'build', 'docs']);
    const both = cli(
      dir,
      config,
      'plan',
      'approve',
      'T-0001',
      '--workflow',
      'feature',
      '--as',
      'claude:pm',
    );
    expect(both.code).toBe(2);
  });

  it('gives swarmup new the work type criteria when --done-when is absent', () => {
    const { dir, store, config } = withWorkflows();
    writeFileSync(
      join(store, 'swarm.yaml'),
      "swarmup_defs: 1\nwork_types:\n  - types: [bug]\n    workflow: bugfix\n    done_when: ['A test reproduces it']\n",
    );
    const res = cli(dir, config, 'new', 'Crash', '--type', 'bug', '--json', '--as', 'human:dawid');
    expect(JSON.parse(res.out.join('\n')).done_when).toEqual(['A test reproduces it']);
    const plain = cli(dir, config, 'new', 'Crash 2', '--type', 'bug', '--as', 'human:dawid');
    expect(plain.err).toContain(
      'note: T-0002: this kind of work has a workflow: swarmup workflow start bugfix',
    );
  });
});
