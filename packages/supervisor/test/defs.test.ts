// Definitions as code (W5): git definitions merged under the machine config, and the stamp of
// the definitions each run started with.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDefinitions, shortHash } from '@swarmup/core';
import type { SwarmDefs } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import {
  opsdConfig,
  overridesFor,
  roleLimits,
  startApi,
  StateDb,
  withDefinitions,
} from '../src/index.js';
import { ended, FAKE_AGENT, setupAsync, temp } from './supervisor-setup.js';
import { spySyncProcs } from './sync-procs.js';

const machine = (raw: Record<string, unknown>) =>
  opsdConfig({
    swarmupd: {
      seeded: 1,
      runtimes: { claude: { command: 'claude' }, codex: { command: 'codex' } },
      ...raw,
    },
  } as never);

describe('withDefinitions', () => {
  const git: SwarmDefs = {
    swarmup_defs: 1,
    defaults: { model: 'base-model', effort: 'low' },
    runtimes: { claude: { model: 'opus' }, cursor: { model: 'x' } },
    roles: { engineer: { per_project: 2, providers: ['codex', 'claude'] }, qa: { burst: 5 } },
  };

  it('returns the machine config itself without sources', () => {
    const cfg = machine({});
    expect(withDefinitions(cfg, []).config).toBe(cfg);
  });

  it('fills what the machine leaves out from git, and never adds a runtime', () => {
    const { config, applied, overrides } = withDefinitions(machine({}), [
      { root: 'a', swarm: git },
    ]);
    expect(config.runtimes.claude).toEqual({ command: 'claude', model: 'opus', effort: 'low' });
    // `defaults` is the last fallback, for a runtime git names nothing for.
    expect(config.runtimes.codex).toEqual({ command: 'codex', model: 'base-model', effort: 'low' });
    expect(config.runtimes.cursor).toBeUndefined();
    expect(roleLimits(config, 'engineer')).toMatchObject({
      per_project: 2,
      providers: ['codex', 'claude'],
    });
    expect(roleLimits(config, 'qa').burst).toBe(5);
    expect(applied).toContainEqual({ key: 'roles.engineer.per_project', root: 'a' });
    expect(overrides).toEqual([]);
  });

  it('lets machine values win at equal specificity and records each override', () => {
    const cfg = machine({
      runtimes: { claude: { command: 'claude', model: 'sonnet' }, codex: { command: 'codex' } },
      roles: { engineer: { per_project: 1 } },
    });
    const { config, overrides } = withDefinitions(cfg, [{ root: 'a', swarm: git }]);
    expect(config.runtimes.claude!.model).toBe('sonnet');
    expect(roleLimits(config, 'engineer')).toMatchObject({
      per_project: 1,
      providers: ['codex', 'claude'],
    });
    expect(overrides).toEqual([
      { key: 'runtimes.claude.model', machine: 'sonnet', git: 'opus', root: 'a' },
      { key: 'roles.engineer.per_project', machine: 1, git: 2, root: 'a' },
    ]);
    expect(overridesFor(overrides, 'claude:engineer')).toEqual([
      'roles.engineer.per_project',
      'runtimes.claude.model',
    ]);
    expect(overridesFor(overrides, 'codex:qa')).toEqual([]);
    // The machine config is not changed in place.
    expect(cfg.roles.engineer).toEqual({ per_project: 1 });
  });

  it('takes the first root for a key two roots set, and names the conflict', () => {
    const other: SwarmDefs = { swarmup_defs: 1, roles: { qa: { burst: 9, per_project: 4 } } };
    const { config, conflicts } = withDefinitions(machine({}), [
      { root: 'a', swarm: git },
      { root: 'b', swarm: other },
    ]);
    expect(config.roles.qa).toEqual({ burst: 5, per_project: 4 });
    expect(conflicts).toEqual([{ key: 'roles.qa.burst', roots: ['a', 'b'] }]);
  });
});

/** A `claude` runtime that starts the fake agent, so runs pass model and effort flags. */
function claudeRuntime(): Record<string, unknown> {
  const agentFile = join(temp(), 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  return {
    claude: { command: process.execPath, args: [agentFile], sign_in_check: false, effort: 'high' },
  };
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });

describe('definitions in swarmupd', () => {
  it('changes nothing without a swarm.yaml', async () => {
    const { sup, as } = await setupAsync({ opsd: { runtimes: claudeRuntime() } });
    expect(sup.config).toBe(sup.machineConfig);
    as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const run = await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001' });
    const r = await ended(sup, run.id);
    expect(r.defs).toBeUndefined();
    expect(r.model).toBeUndefined();
    expect(r.effort).toBeUndefined();
    const start = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-start')!;
    expect(start.defs).toBeUndefined();
    expect(sup.defsView().roots).toMatchObject([{ root: 'test', present: false }]);
  });

  it('merges swarm.yaml under the machine config and stamps each run with it', async () => {
    const repo = temp();
    const { sup, as, state } = await setupAsync({
      repo,
      opsd: {
        runtimes: claudeRuntime(),
        roles: { reviewer: { per_project: 7 } },
      },
    });
    const store = join(repo, '.swarmup');
    writeFileSync(
      join(store, 'swarm.yaml'),
      [
        'swarmup_defs: 1',
        'runtimes:',
        '  claude: {model: opus, effort: low}',
        'roles:',
        '  engineer: {per_project: 2}',
        '  reviewer: {per_project: 3}',
        '',
      ].join('\n'),
    );
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'definitions');
    // The next tick sees the new file and merges it; machine values still win.
    await sup.tick();
    expect(roleLimits(sup.config, 'engineer').per_project).toBe(2);
    expect(roleLimits(sup.config, 'reviewer').per_project).toBe(7);
    expect(sup.config.runtimes.claude).toMatchObject({ model: 'opus', effort: 'high' });
    expect(sup.machineConfig.runtimes.claude!.model).toBeUndefined();
    await sup.defsSettled();
    const hash = loadDefinitions(store).hash;
    const commit = git(repo, 'rev-parse', 'HEAD').trim();
    expect(sup.defsView()).toMatchObject({
      roots: [{ root: 'test', present: true, hash, commit, ok: true, stale: false }],
      overrides: [
        { key: 'runtimes.claude.effort', machine: 'high', git: 'low' },
        { key: 'roles.reviewer.per_project', machine: 7, git: 3 },
      ],
    });

    as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const run = await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001' });
    const r: RunRecord = await ended(sup, run.id);
    expect(r).toMatchObject({
      model: 'opus',
      effort: 'high',
      defs: { root: 'test', hash, commit, local: ['runtimes.claude.effort'] },
    });
    expect(r.command).toContain('--model opus --effort high');
    const start = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-start')!;
    expect(start.defs).toBe(shortHash(hash));
    const db = new StateDb(state);
    expect(db.runsWithDefs(hash)).toEqual([run.id]);
    const snap = db.definitions(hash)!;
    expect(snap).toMatchObject({ root: 'test', commit });
    expect(snap.files.map((f) => f.path)).toEqual(['agents/.gitkeep', 'swarm.yaml']);
    expect(snap.files[1]!.text).toContain('engineer: {per_project: 2}');
  });

  it('records a dirty set without a commit, and runs no git in launch (AO-0171)', async () => {
    const repo = temp();
    const store = join(repo, '.swarmup');
    const made = await setupAsync({ repo, opsd: { runtimes: claudeRuntime() } });
    writeFileSync(
      join(store, 'swarm.yaml'),
      'swarmup_defs: 1\nruntimes: {claude: {model: opus}}\n',
    );
    const spy = spySyncProcs();
    let sup;
    let run: RunRecord;
    try {
      // A swarmupd that starts with the file reads it at once and looks up its commit off the
      // event loop; a launch in the same turn comes before that lookup ends.
      sup = made.opsd();
      run = sup.launch({ agent: 'claude:pm' });
    } finally {
      spy.restore();
    }
    const hash = loadDefinitions(store).hash;
    expect(run.defs).toEqual({ root: 'test', hash });
    expect(spy.calls.filter((c) => c.command.includes('swarm.yaml'))).toEqual([]);
    await ended(sup, run.id);
    await sup.defsSettled();
    expect(sup.defsView().roots[0]).toMatchObject({ hash, dirty: true });
    expect(sup.defsView().roots[0]!.commit).toBeUndefined();
    const next = sup.launch({ agent: 'claude:pm' });
    expect(next.defs).toEqual({ root: 'test', hash, dirty: true });
    await ended(sup, next.id);
  });

  it('keeps the last good swarm.yaml while the file has an error', async () => {
    const repo = temp();
    const store = join(repo, '.swarmup');
    const { sup } = await setupAsync({ repo, opsd: { runtimes: claudeRuntime() } });
    const warnings: string[] = [];
    sup.on('warn', (m: string) => warnings.push(m));
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\nroles: {qa: {burst: 6}}\n');
    await sup.tick();
    expect(roleLimits(sup.config, 'qa').burst).toBe(6);
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\nroles: {qa: {burst: lots}}\n');
    await sup.tick();
    expect(roleLimits(sup.config, 'qa').burst).toBe(6);
    expect(sup.defsView().roots[0]).toMatchObject({ ok: false, stale: true });
    expect(warnings).toContainEqual(expect.stringContaining('keeps its last good definitions'));
    await sup.defsSettled();
  });
});

describe('definitions API', () => {
  it('lists each root under GET /api/defs and checks text under POST /api/defs/validate', async () => {
    const repo = temp();
    const { sup } = await setupAsync({ repo });
    writeFileSync(
      join(repo, '.swarmup', 'swarm.yaml'),
      'swarmup_defs: 1\nroles: {qa: {burst: 2}}\n',
    );
    await sup.tick();
    const api = await startApi(sup, { port: 0, token: 'defs-token', version: 't', build: '1' });
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
        method,
        headers: { authorization: 'Bearer defs-token', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json()) as Record<string, unknown> };
    };
    try {
      const list = await call('GET', '/api/defs');
      expect(list.status).toBe(200);
      expect(list.data).toMatchObject({
        roots: [{ root: 'test', present: true, ok: true }],
        applied: [{ key: 'roles.qa.burst', root: 'test' }],
      });
      const bad = await call('POST', '/api/defs/validate', {
        file: 'swarm.yaml',
        text: 'swarmup_defs: 1\nroles: {qa: {burst: x}}\n',
      });
      expect(bad.data).toMatchObject({
        ok: false,
        problems: [{ line: 2, col: 21, severity: 'error', path: 'roles.qa.burst' }],
      });
      const agent = await call('POST', '/api/defs/validate', {
        file: 'claude-qa.md',
        text: '---\nstatus: active\nflavor: x\n---\n',
        strict: true,
      });
      expect(agent.data).toMatchObject({ ok: false, problems: [{ line: 3, path: 'flavor' }] });
      expect((await call('POST', '/api/defs/validate', {})).status).toBe(400);
    } finally {
      await api.close();
      await sup.defsSettled();
    }
  });
});
