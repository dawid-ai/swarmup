// Wrapped cards (AO-0084): the figures `swarmup report` also shows match the report of the same window
// and project; the rally, fastest answer and most blocked task come from the timeline.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import { buildReport, buildWrapped, reportText, wrappedText } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

function run(agent: string, project: string, start: number, minutes: number): RunRecord {
  return {
    id: `r${start}${agent}`,
    agent,
    project,
    pid: 1,
    command: 'x',
    cwd: '.',
    log: 'x',
    started_at: new Date(start).toISOString(),
    ended_at: new Date(start + minutes * MIN).toISOString(),
    status: 'ended',
    tokens: minutes * 100,
  } as RunRecord;
}

/** Two projects over one day: a two-round review, two asks, a close by hand. */
function store() {
  const repo = mkdtempSync(join(tmpdir(), 'swarmupd-wrapped-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  let now = T0 + DAY;
  const as = (actor: string) =>
    new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
      actor,
      user: {},
      now: () => now,
    });
  const h = as('human:dawid');
  const e = as('claude:engineer');
  const r = as('codex:reviewer');
  h.newTask({ title: 'Login page', project: 'site' });
  h.newTask({ title: 'Rate limits', project: 'api' });
  h.newTask({ title: 'Docs', project: 'site' });
  e.start('1');
  e.review('1', 'Ready', 'codex:reviewer');
  now += 30 * MIN;
  r.verdict('1', 'changes', 'fix the tab order');
  e.start('1');
  e.review('1', 'Fixed', 'codex:reviewer');
  now += 30 * MIN;
  r.verdict('1', 'approve', 'ok');
  e.start('2');
  e.ask('2', 'Per user or per key?');
  now += 5 * MIN;
  h.answer('2', 'Per key');
  e.start('3');
  e.ask('3', 'Which docs site?');
  now += 90 * MIN;
  h.answer('3', 'The repo');
  h.done('3', 'written by hand');
  const runs = [
    run('claude:engineer', 'site', T0 + DAY, 60),
    run('codex:engineer', 'api', T0 + DAY + 60 * MIN, 30),
    run('codex:reviewer', 'site', T0 + DAY + 30 * MIN, 20),
    // Before the window: counted by neither.
    run('claude:engineer', 'site', T0 - DAY, 500),
  ];
  return { h, runs };
}

describe('wrapped cards', () => {
  it('match swarmup report for a 7-day range and for a project', () => {
    const { h, runs } = store();
    const from = T0;
    const to = T0 + 7 * DAY;
    for (const project of [undefined, 'site', 'api']) {
      const report = buildReport(h, runs, from, to, { project });
      const w = buildWrapped(report, h.timeline({ project, from, to }));
      expect(w.project, project).toBe(project ?? null);
      expect(w.closed, project).toBe(report.totals.closed);
      expect(w.opened, project).toBe(report.totals.opened);
      expect(w.agentMinutes, project).toBe(report.totals.minutes);
      expect(w.busiest?.agent, project).toBe(report.agents[0]?.key);
      expect(w.busiest?.minutes, project).toBe(report.agents[0]?.minutes);
    }

    const all = buildWrapped(buildReport(h, runs, from, to), h.timeline({ from, to }));
    expect(all).toMatchObject({
      closed: 2,
      opened: 3,
      agentMinutes: 110,
      agentHours: 1.8,
      busiest: { agent: 'claude:engineer', runs: 1, minutes: 60, tokens: 6000 },
      rally: {
        task: 'T-0001',
        rounds: 2,
        verdict: 'approve',
        players: ['claude:engineer', 'codex:reviewer'],
      },
      fastest: { task: 'T-0002', minutes: 5, asked: 'human:dawid' },
      blocked: { task: 'T-0003', minutes: 90, waits: 1 },
    });
    expect(all.humanMinutes).toBeGreaterThan(0);

    const site = buildWrapped(
      buildReport(h, runs, from, to, { project: 'site' }),
      h.timeline({ project: 'site', from, to }),
    );
    expect(site).toMatchObject({
      closed: 2,
      agentMinutes: 80,
      busiest: { agent: 'claude:engineer' },
      rally: { task: 'T-0001' },
      fastest: { task: 'T-0003', minutes: 90 },
    });

    const api = buildWrapped(
      buildReport(h, runs, from, to, { project: 'api' }),
      h.timeline({ project: 'api', from, to }),
    );
    expect(api).toMatchObject({
      closed: 0,
      agentMinutes: 30,
      busiest: { agent: 'codex:engineer' },
      rally: null,
      fastest: { task: 'T-0002' },
      blocked: { task: 'T-0002', minutes: 5 },
    });
  });

  it('read as one line per card', () => {
    const { h, runs } = store();
    const w = buildWrapped(
      buildReport(h, runs, T0, T0 + 7 * DAY, { project: 'site' }),
      h.timeline({ project: 'site', from: T0, to: T0 + 7 * DAY }),
    );
    expect(wrappedText(w).split('\n')).toEqual([
      'Wrapped site 2026-11-01 to 2026-11-08',
      'Tasks closed: 2 (2 opened)',
      `Agent hours: 1.3 h in runs against ${w.humanMinutes} human minutes`,
      'Busiest agent: claude:engineer, 1 runs, 1 h',
      'Longest review rally: T-0001 Login page, 2 rounds, approved',
      'Fastest answer: T-0003 in 1 h 30 min (asked human:dawid)',
      'Most blocked: T-0003 Docs, 1 h 30 min in 1 wait',
    ]);
  });

  it('show empty cards for a quiet window', () => {
    const { h, runs } = store();
    const from = T0 + 3 * DAY;
    const w = buildWrapped(
      buildReport(h, runs, from, from + DAY),
      h.timeline({ from, to: from + DAY }),
    );
    expect(w).toMatchObject({
      closed: 0,
      agentMinutes: 0,
      busiest: null,
      rally: null,
      fastest: null,
      blocked: null,
    });
    expect(wrappedText(w)).toContain('Busiest agent: no runs');
  });
});

describe('report for one project', () => {
  it('counts only that project tasks, runs and decisions', () => {
    const { h, runs } = store();
    h.propose({
      question: 'Ship the site?',
      options: ['yes', 'no'],
      voters: ['human:dawid'],
      task: 'T-0001',
    });
    h.decide('D-0001', 'yes');
    h.propose({ question: 'Office plants?', options: ['yes', 'no'], voters: ['human:dawid'] });
    h.decide('D-0002', 'no');
    const r = buildReport(h, runs, T0, T0 + 7 * DAY, { project: 'site' });
    expect(r.project).toBe('site');
    expect(r.projects.map((p) => p.project)).toEqual(['site']);
    expect(r.agents.map((a) => a.key)).toEqual(['claude:engineer', 'codex:reviewer']);
    expect(r.answers.given).toBe(2); // the approval of T-0001 and the answer on T-0003
    expect(r.decisions.map((d) => d.id)).toEqual(['D-0001']);
    expect(reportText(r)).toMatch(/^Report site 2026-11-01 to 2026-11-08: 2 closed/);
    const all = buildReport(h, runs, T0, T0 + 7 * DAY);
    expect(all.project).toBeNull();
    expect(all.decisions).toHaveLength(2);
  });

  it('counts a run recorded with a root and no project against that root', () => {
    const { h } = store();
    const legacy = (agent: string, root: string, minutes: number): RunRecord => {
      const r: RunRecord = { ...run(agent, root, T0 + 3 * 3600_000, minutes), root };
      delete r.project;
      return { ...r, id: `legacy-${agent}` };
    };
    const runs = [legacy('claude:engineer', 'site', 30), legacy('codex:engineer', 'api', 45)];
    const site = buildReport(h, runs, T0, T0 + 7 * DAY, { project: 'site' });
    expect(site.agents.map((a) => [a.key, a.minutes])).toEqual([['claude:engineer', 30]]);
    expect(site.totals.minutes).toBe(30);
    const api = buildReport(h, runs, T0, T0 + 7 * DAY, { project: 'api' });
    expect(api.agents.map((a) => [a.key, a.minutes])).toEqual([['codex:engineer', 45]]);
  });
});
