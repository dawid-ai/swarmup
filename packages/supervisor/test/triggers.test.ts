import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { clearDefinitionsCache } from '@swarmup/core';
import { dueTriggers, TRIGGERS_STATE, triggersView } from '../src/index.js';
import { ended, setup } from './supervisor-setup.js';

const templates = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'templates');

function trigger(repo: string, name: string, text: string): void {
  const dir = join(repo, '.swarmup', 'triggers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), text);
  clearDefinitionsCache();
}

describe('git triggers', () => {
  it('fire nothing on a machine that has not turned them on', async () => {
    const { sup, repo } = setup();
    trigger(repo, 'digest', 'every: 24h\naction: run\nagent: fake:writer\nprompt: Write it.\n');
    await sup.tick();
    expect(sup.runs()).toEqual([]);
  });

  it('start a run trigger once per fire time, across a restart', async () => {
    const { sup, repo, opsd } = setup({ opsd: { triggers: { test: true } } });
    trigger(repo, 'digest', 'every: 24h\naction: run\nagent: fake:writer\nprompt: Write it.\n');
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

  it('start a workflow and create a repeat task as swarmupd, never as a person', async () => {
    const { sup, repo, as } = setup({ opsd: { triggers: { test: true }, repeats: false } });
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
    trigger(
      repo,
      'fix',
      'every: 1d\naction: workflow\nworkflow: bugfix\nparams: {bug: login fails}\n',
    );
    trigger(repo, 'week', 'every: 1d\naction: repeat\nrepeat: weekly\n');
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
    trigger(repo, 'morning', 'cron: "0 9 * * *"\naction: run\nagent: fake:writer\n');
    trigger(repo, 'desk', 'every: 1h\naction: run\nagent: fake:writer\nruns_on: [desk]\n');
    const roots = [{ name: 'test', dir: join(repo, '.swarmup') }];
    const on = { triggers: { test: true } };
    const now = new Date(2026, 10, 23, 10, 0).getTime();
    expect(dueTriggers(roots, on, undefined, {}, now)).toEqual({
      due: [],
      baselines: ['test/morning'],
    });
    const due = dueTriggers(roots, on, 'desk', { 'test/morning': now - 86_400_000 }, now);
    expect(due.due.map((d) => d.key).sort()).toEqual(['test/desk', 'test/morning']);
    expect(dueTriggers(roots, { triggers: {} }, 'desk', {}, now).due).toEqual([]);
    const view = triggersView(roots, on, 'laptop', { 'test/morning': now }, now);
    expect(view.map((v) => [v.name, v.here, v.why ?? v.next_fire])).toEqual([
      ['desk', false, 'runs_on does not name laptop'],
      ['morning', true, new Date(2026, 10, 24, 9, 0).toISOString()],
    ]);
  });
});
