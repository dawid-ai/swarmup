import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkTriggerText, clearDefinitionsCache, triggersHash } from '@swarmup/core';
import { dueTriggers, TRIGGERS_STATE, triggersView } from '../src/index.js';
import { ended, setup } from './supervisor-setup.js';

const templates = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'templates');

function trigger(repo: string, name: string, text: string): void {
  const dir = join(repo, '.swarmup', 'triggers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), text);
  clearDefinitionsCache();
}

function roleFile(repo: string, agent: string): void {
  const dir = join(repo, '.swarmup', 'agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${agent.replace(':', '-')}.md`), `---\nid: ${agent}\n---\n`);
  clearDefinitionsCache();
}

/** The hash `swarmup defs trust` keeps for these trigger files. */
function hashOf(files: Record<string, string>): string {
  const defs = Object.entries(files).map(
    ([name, text]) => checkTriggerText(name, text, { file: `${name}.yaml` }).def!,
  );
  return triggersHash(defs)!;
}

const DIGEST = 'every: 24h\naction: run\nagent: fake:writer\nprompt: Write it.\n';

/** A machine that turned the root's triggers on, trusts `files` and lets fake:writer wake. */
const consent = (files: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  triggers: { test: true },
  trusted_defs: { test: { triggers: hashOf(files) } },
  agents: { 'fake:writer': { wake: true } },
  ...extra,
});

describe('git triggers', () => {
  it('fire nothing on a machine that has not turned them on', async () => {
    const { sup, repo } = setup();
    roleFile(repo, 'fake:writer');
    trigger(repo, 'digest', DIGEST);
    await sup.tick();
    expect(sup.runs()).toEqual([]);
  });

  it('fire nothing while the trigger set is not trusted, or changed since', async () => {
    const { sup, repo } = setup({
      opsd: { ...consent({ digest: DIGEST }), trusted_defs: {} },
    });
    roleFile(repo, 'fake:writer');
    trigger(repo, 'digest', DIGEST);
    const warnings: string[] = [];
    sup.on('warn', (m: string) => warnings.push(m));
    await sup.tick();
    await sup.tick();
    expect(sup.runs()).toEqual([]);
    expect(warnings.filter((w) => w.includes('trigger(s) in test'))).toEqual([
      '1 trigger(s) in test are not trusted on this machine; none fires until a person runs `swarmup defs trust --root test`',
    ]);
    const changed = setup({ opsd: consent({ digest: DIGEST }) });
    roleFile(changed.repo, 'fake:writer');
    trigger(changed.repo, 'digest', DIGEST.replace('Write it.', 'Write it and push.'));
    await changed.sup.tick();
    expect(changed.sup.runs()).toEqual([]);
  });

  it('start a run trigger once per fire time, across a restart', async () => {
    const { sup, repo, opsd } = setup({ opsd: consent({ digest: DIGEST }) });
    roleFile(repo, 'fake:writer');
    trigger(repo, 'digest', DIGEST);
    await sup.tick();
    const first = sup.runs();
    expect(first.map((r) => [r.agent, r.schedule])).toEqual([
      ['fake:writer', 'trigger test/digest'],
    ]);
    await ended(sup, first[0]!.id);
    await sup.tick();
    expect(sup.runs()).toHaveLength(1);
    sup.stop();
    const again = opsd();
    await again.tick();
    expect(again.runs()).toHaveLength(1);
    expect(Object.keys(again.store.readJson(TRIGGERS_STATE, {}))).toEqual(['test/digest']);
  });

  it('need the agent to wake on this machine and an active role file in the store', async () => {
    const noWake = setup({ opsd: consent({ digest: DIGEST }, { agents: {} }) });
    roleFile(noWake.repo, 'fake:writer');
    trigger(noWake.repo, 'digest', DIGEST);
    await noWake.sup.tick();
    expect(noWake.sup.runs()).toEqual([]);
    const noRole = setup({ opsd: consent({ digest: DIGEST }) });
    trigger(noRole.repo, 'digest', DIGEST);
    await noRole.sup.tick();
    expect(noRole.sup.runs()).toEqual([]);
  });

  it('start a workflow and create a repeat task as swarmupd, never as a person', async () => {
    const fix =
      'every: 1d\naction: workflow\nworkflow: bugfix\nparams: {bug: login fails}\nruns_on: [desk]\n';
    const week = 'every: 1d\naction: repeat\nrepeat: weekly\nruns_on: [desk]\n';
    const { sup, repo, as } = setup({
      opsd: consent({ fix, week }, { repeats: false }),
      user: { machine: 'desk' },
    });
    const store = join(repo, '.swarmup');
    mkdirSync(join(store, 'workflows'), { recursive: true });
    copyFileSync(
      join(templates, 'workflows', 'bugfix.yaml'),
      join(store, 'workflows', 'bugfix.yaml'),
    );
    as('human:dawid').saveRepeat({
      name: 'weekly',
      title: 'Weekly {date}',
      start: '2030-01-01T09:00',
    });
    trigger(repo, 'fix', fix);
    trigger(repo, 'week', week);
    await sup.tick();
    const human = as('human:dawid');
    const tasks = human.list({ all: true });
    const milestone = tasks.find((t) => t.meta.workflow === 'bugfix');
    expect(milestone?.meta).toMatchObject({
      title: 'Fix: login fails',
      created_by: 'opsd:trigger',
    });
    // A starter workflow started by a trigger still waits for a person: no stage tasks yet.
    expect(tasks).toHaveLength(2);
    const repeat = tasks.find((t) => t.meta.repeat === 'weekly');
    expect(repeat?.meta.title).toMatch(/^Weekly \d{4}-\d{2}-\d{2}$/);
    // Recorded before acting: the next tick does neither again.
    await sup.tick();
    expect(human.list({ all: true })).toHaveLength(tasks.length);
  });

  it('wait for the first fire time after a machine first sees an at or cron trigger', () => {
    const { repo } = setup();
    roleFile(repo, 'fake:writer');
    const morning = 'cron: "0 9 * * *"\naction: run\nagent: fake:writer\n';
    const desk = 'every: 1h\naction: run\nagent: fake:writer\nruns_on: [desk]\n';
    trigger(repo, 'morning', morning);
    trigger(repo, 'desk', desk);
    const roots = [{ name: 'test', dir: join(repo, '.swarmup') }];
    const on = consent({ morning, desk });
    const now = new Date(2026, 10, 23, 10, 0).getTime();
    expect(dueTriggers(roots, on, undefined, {}, now)).toMatchObject({
      due: [],
      baselines: ['test/morning'],
      active: ['test/morning'],
    });
    const due = dueTriggers(roots, on, 'desk', { 'test/morning': now - 86_400_000 }, now);
    expect(due.due.map((d) => d.key).sort()).toEqual(['test/desk', 'test/morning']);
    expect(dueTriggers(roots, { ...on, triggers: {} }, 'desk', {}, now).due).toEqual([]);
    const view = triggersView(roots, on, 'laptop', { 'test/morning': now }, now);
    expect(view.map((v) => [v.name, v.here, v.why ?? v.next_fire])).toEqual([
      ['desk', false, 'runs_on does not name laptop'],
      ['morning', true, new Date(2026, 10, 24, 9, 0).toISOString()],
    ]);
    const untrusted = triggersView(roots, { ...on, trusted_defs: {} }, 'desk', {}, now);
    expect(untrusted[0]?.why).toBe('not trusted here (swarmup defs trust --root test)');
  });

  it('forget the last fire of a trigger that stopped firing, so it starts again from then', async () => {
    const { sup, repo } = setup({ opsd: consent({ digest: DIGEST }) });
    roleFile(repo, 'fake:writer');
    trigger(repo, 'digest', DIGEST);
    sup.store.writeJson(TRIGGERS_STATE, { 'test/digest': Date.now(), 'test/gone': 1 });
    await sup.tick();
    expect(sup.runs()).toEqual([]);
    expect(Object.keys(sup.store.readJson(TRIGGERS_STATE, {}))).toEqual(['test/digest']);
  });
});
