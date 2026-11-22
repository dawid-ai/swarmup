// W5 phase 2: team policy in git and agent folders in runs. `policy.*` and `defaults.budget_min`
// fill only the top-level keys the machine leaves unset (a key the user config sets wins even at
// its default value), an agent file's `writes` sets its role's, and a folder agent with a runtime
// addendum runs from the role file put together in its scratch folder.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SwarmDefs } from '@swarmup/core';
import { opsdConfig, roleLimits, withDefinitions } from '../src/index.js';
import { ended, FAKE_AGENT, setupAsync, temp } from './supervisor-setup.js';

const machine = (raw: Record<string, unknown>) =>
  opsdConfig({
    swarmupd: {
      seeded: 1,
      runtimes: { claude: { command: 'claude' }, codex: { command: 'codex' } },
      ...raw,
    },
  } as never);

const POLICY: SwarmDefs = {
  swarmup_defs: 1,
  defaults: { budget_min: 60 },
  policy: {
    review_rounds: 5,
    stuck_runs: 1,
    review_backlog: 9,
    review_fallback_hours: 0.5,
    plan_check_minutes: 0,
    budget_minutes: 90,
    test_changes: false,
  },
};

describe('policy in git', () => {
  it('records which top-level keys the user config sets', () => {
    expect(machine({ review_rounds: 3 }).explicit).toEqual(['review_rounds', 'runtimes', 'seeded']);
    expect(machine({}).review_rounds).toBe(3);
  });

  it('fills the keys the machine leaves unset, defaults.budget_min before policy.budget_minutes', () => {
    const { config, applied, values } = withDefinitions(machine({}), [
      { root: 'a', swarm: POLICY },
    ]);
    expect(config).toMatchObject({
      review_rounds: 5,
      stuck_runs: 1,
      review_backlog: 9,
      review_fallback_hours: 0.5,
      plan_check_minutes: 0,
      budget_minutes: 60,
    });
    expect(config.test_changes.a).toBe(false);
    expect(applied).toEqual(
      expect.arrayContaining([
        { key: 'review_rounds', root: 'a' },
        { key: 'budget_minutes', root: 'a' },
        { key: 'test_changes.a', root: 'a' },
      ]),
    );
    expect(values).toEqual(
      expect.arrayContaining([
        { key: 'budget_minutes', value: 60, source: 'git', git: 60, root: 'a' },
        { key: 'policy.budget_minutes', value: 90, source: 'unused', git: 90, root: 'a' },
      ]),
    );
    const noDefault = withDefinitions(machine({}), [
      { root: 'a', swarm: { swarmup_defs: 1, policy: { budget_minutes: 90 } } },
    ]);
    expect(noDefault.config.budget_minutes).toBe(90);
  });

  it('lets a key the machine sets win, even when it holds the default value', () => {
    const cfg = machine({
      review_rounds: 3,
      budget_minutes: 180,
      test_changes: { a: { tests: ['t/**'] } },
    });
    const { config, overrides, values } = withDefinitions(cfg, [{ root: 'a', swarm: POLICY }]);
    expect(config.review_rounds).toBe(3);
    expect(config.budget_minutes).toBe(180);
    expect(config.stuck_runs).toBe(1);
    expect(config.test_changes.a).toEqual({ tests: ['t/**'] });
    expect(overrides).toEqual(
      expect.arrayContaining([
        { key: 'review_rounds', machine: 3, git: 5, root: 'a' },
        { key: 'budget_minutes', machine: 180, git: 60, root: 'a' },
        { key: 'test_changes.a', machine: { tests: ['t/**'] }, git: false, root: 'a' },
      ]),
    );
    expect(values).toContainEqual({
      key: 'review_rounds',
      value: 3,
      source: 'machine',
      git: 5,
      root: 'a',
    });
  });

  it('changes nothing in a config built without explicit keys', () => {
    const cfg = { ...machine({}), explicit: undefined };
    const { config } = withDefinitions(cfg, [{ root: 'a', swarm: POLICY }]);
    expect(config.review_rounds).toBe(3);
    expect(config.budget_minutes).toBe(180);
  });

  it('takes writes from an agent file over swarm.yaml, and the machine over both', () => {
    const swarm: SwarmDefs = {
      swarmup_defs: 1,
      roles: { writer: { writes: true, per_project: 2 } },
    };
    const git = withDefinitions(machine({}), [{ root: 'a', swarm, roleWrites: { writer: false } }]);
    expect(roleLimits(git.config, 'writer')).toMatchObject({ writes: false, per_project: 2 });
    expect(git.conflicts).toEqual([]);
    const local = withDefinitions(machine({ roles: { writer: { writes: true } } }), [
      { root: 'a', swarm, roleWrites: { writer: false } },
    ]);
    expect(roleLimits(local.config, 'writer').writes).toBe(true);
    expect(local.overrides).toContainEqual({
      key: 'roles.writer.writes',
      machine: true,
      git: false,
      root: 'a',
    });
  });
});

function claudeRuntime(): Record<string, unknown> {
  const agentFile = join(temp(), 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  return { claude: { command: process.execPath, args: [agentFile], sign_in_check: false } };
}

describe('policy and agent folders in swarmupd', () => {
  it('runs with the budget precedence: machine agent, agent file, swarm.yaml defaults, policy', async () => {
    const repo = temp();
    const { sup, as } = await setupAsync({
      repo,
      opsd: { runtimes: claudeRuntime(), agents: { 'claude:qa': { budget: '10m' } } },
    });
    const store = join(repo, '.swarmup');
    writeFileSync(
      join(store, 'swarm.yaml'),
      'swarmup_defs: 1\ndefaults: {budget_min: 25}\npolicy: {budget_minutes: 90, stuck_runs: 1}\n',
    );
    mkdirSync(join(store, 'agents', 'engineer'), { recursive: true });
    writeFileSync(
      join(store, 'agents', 'engineer', 'agent.md'),
      '---\nproviders: [claude]\n---\nBuild.\n',
    );
    writeFileSync(join(store, 'agents', 'claude-docs.md'), '---\nbudget_min: 40\n---\nDocs.\n');
    writeFileSync(join(store, 'agents', 'claude-qa.md'), '---\nbudget_min: 40\n---\nCheck.\n');
    await sup.tick();
    expect(sup.config.budget_minutes).toBe(25);
    expect(sup.config.stuck_runs).toBe(1);
    expect(sup.machineConfig.budget_minutes).toBe(180);
    const h = as('human:dawid');
    const budgets: Record<string, number> = {};
    for (const agent of ['claude:engineer', 'claude:docs', 'claude:qa']) {
      const id = h.newTask({ title: agent, owner: agent }).id;
      const run = await sup.launchFresh({ agent, task: id });
      budgets[agent] = (await ended(sup, run.id)).budget_minutes;
    }
    expect(budgets).toEqual({ 'claude:engineer': 25, 'claude:docs': 40, 'claude:qa': 10 });
  });

  it('points a folder agent with an addendum at the role put together in its scratch folder', async () => {
    const repo = temp();
    const prompt = join(temp(), 'prompt.txt');
    const { sup, as } = await setupAsync({
      repo,
      opsd: { runtimes: claudeRuntime() },
      env: { FAKE_PROMPT: prompt },
    });
    const store = join(repo, '.swarmup');
    mkdirSync(join(store, 'agents', 'engineer'), { recursive: true });
    writeFileSync(
      join(store, 'agents', 'engineer', 'agent.md'),
      '---\nproviders: [claude, codex]\nwrites: false\n---\nBuild the thing.\n',
    );
    writeFileSync(
      join(store, 'agents', 'engineer', 'claude.md'),
      '---\nstyle: Terse.\n---\nClaude only.\n',
    );
    await sup.tick();
    // The agent file's `writes` sets the role's.
    expect(roleLimits(sup.config, 'engineer').writes).toBe(false);
    const id = as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' }).id;
    const run = await sup.launchFresh({ agent: 'claude:engineer', task: id });
    await ended(sup, run.id);
    const text = readFileSync(prompt, 'utf8');
    const file = /Read your role file first: (\S+)/.exec(text)?.[1];
    expect(file).toMatch(/role-claude-engineer\.md$/);
    const role = readFileSync(file!, 'utf8');
    expect(role).toContain('id: claude:engineer');
    expect(role).toContain('style: Terse.');
    expect(role).toContain('Build the thing.\n\nClaude only.');
  });
});
