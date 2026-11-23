// Experiments and refs (W5 phase 5): swarmupd gives a share of matching task runs a variant, the
// same side for every run of a task, and records the experiment; the scores split by variant; a
// run can read its definitions at a git ref of the store.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OpsEvent } from '@swarmup/core';
import { readDefsAtRef, loadDefinitionsAtRef, shortHash } from '@swarmup/core';
import type { RunRecord, ScoreTask } from '../src/index.js';
import { computeScores, opsdConfig, scoresText, summarizeScores } from '../src/index.js';
import { ended, FAKE_AGENT, setupAsync, temp } from './supervisor-setup.js';

const ENGINEER =
  '---\nid: claude:engineer\nstatus: active\ntools: [Read, Edit]\n---\n\nWrite the code.\n';

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function claudeRuntime(): Record<string, unknown> {
  const agentFile = join(temp(), 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
  return { claude: { command: process.execPath, args: [agentFile], sign_in_check: false } };
}

const swarm = (share: number, extra = ''): string =>
  [
    'swarmup_defs: 1',
    'experiments:',
    '  - id: tests-first-trial',
    '    variant: tests-first',
    `    share: ${share}`,
    '    scope: {roles: [engineer]}',
    extra,
    '',
  ].join('\n');

async function project(opsd: Record<string, unknown> = {}) {
  const s = await setupAsync({ opsd: { runtimes: claudeRuntime(), ...opsd } });
  const store = join(s.repo, '.swarmup');
  put(store, 'agents/claude-engineer.md', ENGINEER);
  put(store, 'variants/tests-first/agents/claude-engineer.md', '---\n---\n\nTests first.\n');
  return { ...s, store };
}

const runStart = (sup: Awaited<ReturnType<typeof project>>['as'], ref: string): OpsEvent[] =>
  sup('human:dawid')
    .showEvents(ref)
    .events.filter((e) => e.type === 'run-start');

describe('experiments', () => {
  it('gives the chosen share the variant, records the experiment, and keeps a task on its side', async () => {
    const { sup, as, store } = await project();
    put(store, 'swarm.yaml', swarm(1));
    await sup.tick();
    as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const first = await ended(
      sup,
      (await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001' })).id,
    );
    expect(first).toMatchObject({ variant: 'tests-first', experiment: 'tests-first-trial' });
    expect(first.defs?.variant).toBe('tests-first');
    expect(runStart(as, '1')[0]).toMatchObject({
      variant: 'tests-first',
      experiment: 'tests-first-trial',
    });
    expect(runStart(as, '1')[0]!.body).toContain('experiment tests-first-trial');

    // A share of 0 puts new tasks on the base side; the task that ran the variant keeps it.
    put(store, 'swarm.yaml', swarm(0));
    as('human:dawid').reopen('T-0001', 'again');
    const again = await ended(
      sup,
      (await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001' })).id,
    );
    expect(again).toMatchObject({ variant: 'tests-first', experiment: 'tests-first-trial' });
    as('human:dawid').newTask({ title: 'b', owner: 'claude:engineer' });
    const base = await ended(
      sup,
      (await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0002' })).id,
    );
    expect(base.variant).toBeUndefined();
    expect(base.experiment).toBe('tests-first-trial');
    expect(runStart(as, '2')[0]!.body).toContain('experiment tests-first-trial (base)');

    // An explicit variant wins and is no experiment run.
    as('human:dawid').newTask({ title: 'c', owner: 'claude:engineer' });
    const named = await ended(
      sup,
      (await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0003', variant: 'tests-first' }))
        .id,
    );
    expect(named.variant).toBe('tests-first');
    expect(named.experiment).toBeUndefined();
    await sup.defsSettled();
  });

  it('leaves out runs its scope, its until day or the machine rule out', async () => {
    const off = await project({ experiments: false });
    put(off.store, 'swarm.yaml', swarm(1));
    await off.sup.tick();
    off.as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const r = await ended(
      off.sup,
      (await off.sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001' })).id,
    );
    expect(r.variant).toBeUndefined();
    expect(r.experiment).toBeUndefined();
    await off.sup.defsSettled();

    const { sup, as, store } = await project();
    put(store, 'swarm.yaml', swarm(1, '    until: 2020-01-01'));
    await sup.tick();
    as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const past = await ended(
      sup,
      (await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001' })).id,
    );
    expect(past.experiment).toBeUndefined();
    await sup.defsSettled();
  });

  it('runs the base outside the experiment when its variant has no role file for the agent', async () => {
    const { sup, as, store } = await project();
    put(store, 'swarm.yaml', swarm(1).replace('{roles: [engineer]}', '{agents: [claude:qa]}'));
    put(store, 'agents/claude-qa.md', '---\nid: claude:qa\nstatus: active\n---\n\nTest it.\n');
    put(store, 'variants/tests-first/agents/claude-qa.md.delete', '');
    await sup.tick();
    const warnings: string[] = [];
    sup.on('warn', (m: string) => warnings.push(m));
    as('human:dawid').newTask({ title: 'a', owner: 'claude:qa' });
    const r = await ended(sup, (await sup.launchFresh({ agent: 'claude:qa', task: 'T-0001' })).id);
    expect(r.variant).toBeUndefined();
    expect(r.experiment).toBeUndefined();
    expect(warnings.join('\n')).toContain('variant tests-first has no role file for claude:qa');
    await sup.defsSettled();
  });

  it('turns off with swarmupd.experiments: false only', () => {
    expect(opsdConfig({ swarmupd: {} } as never).experiments).toBe(true);
    expect(opsdConfig({ swarmupd: { experiments: false } } as never).experiments).toBe(false);
    expect(() => opsdConfig({ swarmupd: { experiments: 'no' } } as never)).toThrow(
      /swarmupd.experiments: use true or false/,
    );
  });
});

describe('scores by variant', () => {
  const at = '2026-11-20T10:00:00.000Z';
  const task = (id: string, variant?: string): ScoreTask => ({
    root: 'test',
    id,
    title: id,
    meta: { type: 'task', labels: [], owner: 'claude:engineer' },
    status: 'done',
    events: [
      { id: `${id}-1`, at, actor: 'claude:engineer', type: 'claim' } as OpsEvent,
      {
        id: `${id}-2`,
        at,
        actor: 'claude:engineer',
        type: 'run-start',
        run: `R-${id}`,
        defs: 'd:0123456789ab',
        ...(variant ? { variant, experiment: 'trial' } : { experiment: 'trial' }),
      } as OpsEvent,
      { id: `${id}-3`, at, actor: 'claude:engineer', type: 'review' } as OpsEvent,
      {
        id: `${id}-4`,
        at,
        actor: 'codex:reviewer',
        type: 'verdict',
        verdict: 'changes',
      } as OpsEvent,
      {
        id: `${id}-5`,
        at,
        actor: 'codex:reviewer',
        type: 'verdict',
        verdict: 'approve',
      } as OpsEvent,
    ],
  });

  it('marks task scores with the variant of their run and splits the summary by it', () => {
    const tasks = [task('T-0001', 'tests-first'), task('T-0002')];
    const runs: RunRecord[] = [];
    const results = computeScores({ tasks, runs });
    const rounds = results.filter((r) => r.scorer === 'review-rounds');
    expect(rounds.find((r) => r.subject === 'test/T-0001')).toMatchObject({
      variant: 'tests-first',
      experiment: 'trial',
      defs_hash: 'd:0123456789ab',
    });
    expect(rounds.find((r) => r.subject === 'test/T-0002')?.variant).toBeUndefined();
    const split = summarizeScores(results, { byVariant: true });
    expect(split.map((a) => [a.agent, a.variant])).toEqual([
      ['claude:engineer', null],
      ['claude:engineer', 'tests-first'],
    ]);
    expect(split.every((a) => a.scorers.every((l) => l.level !== 'agent'))).toBe(true);
    const text = scoresText(split);
    expect(text).toContain('claude:engineer [base]');
    expect(text).toContain('claude:engineer [variant tests-first]');
    expect(summarizeScores(results)[0]!.variant).toBeUndefined();
  });
});

describe('definitions at a git ref', () => {
  it('runs with the role file as the ref had it and stamps the ref, commit and hash', async () => {
    const { sup, as, store, repo } = await project();
    put(store, 'swarm.yaml', 'swarmup_defs: 1\n');
    const git = (...args: string[]): string =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: repo,
        windowsHide: true,
        encoding: 'utf8',
      });
    git('add', '-A');
    git('commit', '-q', '-m', 'defs');
    const commit = git('rev-parse', 'HEAD').trim();
    put(store, 'agents/claude-engineer.md', ENGINEER.replace('Write the code.', 'Changed since.'));
    await sup.tick();
    as('human:dawid').newTask({ title: 'a', owner: 'claude:engineer' });
    const r = await ended(
      sup,
      (await sup.launchFresh({ agent: 'claude:engineer', task: 'T-0001', defsRef: 'HEAD' })).id,
    );
    const hash = loadDefinitionsAtRef(store, readDefsAtRef(store, 'HEAD')).hash;
    expect(r.defs).toMatchObject({ root: 'test', hash, ref: 'HEAD', commit });
    expect(r.variant).toBeUndefined();
    const role = readFileSync(join(r.scratch!, 'role-claude-engineer.md'), 'utf8');
    expect(role).toContain('Write the code.');
    expect(role).not.toContain('Changed since.');
    const start = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'run-start')!;
    expect(start).toMatchObject({ defs_ref: 'HEAD', defs: shortHash(hash) });
    expect(start.body).toContain(`definitions at HEAD (${commit.slice(0, 12)})`);
    expect(sup.state?.definitions(hash)?.commit).toBe(commit);
    await expect(
      sup.launchFresh({ agent: 'claude:engineer', defsRef: 'no-such-ref' }),
    ).rejects.toThrow(/git cannot read no-such-ref/);
    await expect(
      sup.launchFresh({ agent: 'claude:engineer', defsRef: 'HEAD', variant: 'tests-first' }),
    ).rejects.toThrow(/--variant or --defs-ref, not both/);
    await sup.defsSettled();
  });
});
