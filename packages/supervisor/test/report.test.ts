import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, MERGE_ACTOR, Workspace } from '@swarmup/core';
import type { UserConfig } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import {
  buildReport,
  buildReportAsync,
  ReportEvents,
  reportText,
  reportWindow,
} from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

function run(agent: string, startDay: number, minutes: number, tokens: number): RunRecord {
  const start = T0 + startDay * DAY;
  return {
    id: `r${startDay}${agent}`,
    agent,
    pid: 1,
    command: 'x',
    cwd: '.',
    log: 'x',
    started_at: new Date(start).toISOString(),
    ended_at: new Date(start + minutes * 60_000).toISOString(),
    status: 'ended',
    tokens,
  } as RunRecord;
}

describe('report windows', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  it('takes whole days from 1 to 366, or a from and to', () => {
    expect(reportWindow({}, now)).toEqual({ from: now - 7 * DAY, to: now });
    expect(reportWindow({ days: '1' }, now)).toEqual({ from: now - DAY, to: now });
    expect(reportWindow({ days: '366' }, now).from).toBe(now - 366 * DAY);
    for (const days of ['1.5', '0', '367', '-1', 'week', '']) {
      expect(() => reportWindow({ days }, now), days).toThrow(/whole number/);
    }
    expect(reportWindow({ from: '2026-11-01', to: '2026-11-02' }, now)).toEqual({
      from: Date.parse('2026-11-01'),
      to: Date.parse('2026-11-02'),
    });
    expect(reportWindow({ from: '2026-11-01' }, now)).toEqual({
      from: Date.parse('2026-11-01'),
      to: now,
    });
    expect(() => reportWindow({ to: '2026-11-02' }, now)).toThrow(/give from/);
    expect(() => reportWindow({ from: '2026-11-03', to: '2026-11-02' }, now)).toThrow(/end after/);
    expect(() => reportWindow({ from: '2024-01-01', to: '2026-01-01' }, now)).toThrow(/366 days/);
    expect(() => reportWindow({ from: 'soon' }, now)).toThrow(/dates/);
  });
});

describe('reports', () => {
  it('counts tasks per project, usage per agent and provider, and decisions in the window', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmupd-report-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    let now = T0 - 2 * DAY;
    const clock = () => now;
    const as = (actor: string) =>
      new Workspace({
        cwd: repo,
        env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
        actor,
        user: {},
        now: clock,
      });
    // Before the window: one task made, one closed.
    as('human:dawid').newTask({ title: 'old', project: 'site' });
    as('human:dawid').newTask({ title: 'old done', project: 'site' });
    as('human:dawid').done('2');
    now = T0 + DAY;
    as('human:dawid').newTask({ title: 'new', project: 'site' });
    as('human:dawid').newTask({ title: 'api work', project: 'api' });
    as('human:dawid').done('3');
    as('human:dawid').park('1', 'not now');
    as('human:dawid').block('4', 'waiting', { to: 'human:dawid' });
    as('human:dawid').post('general', 'hello');
    as('human:dawid').propose({
      question: 'Ship it?',
      options: ['yes', 'no'],
      voters: ['human:dawid'],
    });
    as('human:dawid').decide('D-0001', 'yes');
    now = T0 + 3 * DAY;

    const runs = [
      run('claude:engineer', 1, 30, 1000),
      run('codex:qa', 2, 10, 500),
      run('claude:engineer', -3, 99, 9999),
    ];
    const r = buildReport(as('human:dawid'), runs, T0, T0 + 7 * DAY);
    expect(r.projects).toEqual([
      { project: 'api', opened: 1, closed: 0, parked: 0, open: 1, blocked: 1 },
      { project: 'site', opened: 1, closed: 1, parked: 1, open: 0, blocked: 0 },
    ]);
    expect(r.agents).toEqual([
      { key: 'claude:engineer', runs: 1, minutes: 30, tokens: 1000 },
      { key: 'codex:qa', runs: 1, minutes: 10, tokens: 500 },
    ]);
    expect(r.providers.map((p) => p.key)).toEqual(['claude', 'codex']);
    expect(r.decisions).toMatchObject([{ id: 'D-0001', choice: 'yes' }]);
    expect(r.channels).toEqual([{ channel: 'general', posts: 1 }]);
    expect(r.totals).toEqual({ opened: 2, closed: 1, runs: 2, minutes: 40, tokens: 1500 });
    expect(reportText(r)).toMatch(/^Report 2026-11-01 to 2026-11-08: 1 closed, 2 opened, 2 runs/);
    expect(() => buildReport(as('human:dawid'), runs, T0, T0)).toThrow(/window/);
    expect(r.answers).toMatchObject({ given: 0, measured: 0, unblocked: 0, top: [] });
    expect(reportText(r)).not.toContain('Answers:');
  });

  it('counts answers, unblocks and approvals, the tasks they unblocked and the wait (AO-0068)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmupd-report-'));
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
    for (const title of ['asks', 'waits on 1', 'waits on 2', 'blocks', 'review']) {
      h.newTask({ title });
    }
    e.start('2');
    e.block('2', 'needs 1', { on: ['1'] });
    e.start('3');
    e.block('3', 'needs 2', { on: ['2'] });
    e.start('1');
    e.ask('1', 'Which way?', undefined, 'left');
    e.start('4');
    e.block('4', 'waiting for the key');
    e.start('5');
    e.review('5', 'Ready', 'human:dawid', 'approve');
    now += 60 * 60_000;
    h.answer('1', 'left'); // frees 1, 2 and 3 after 60 min, takes the recommendation
    now += 60 * 60_000;
    h.unblock('4', 'key is in place'); // frees 4 after 120 min
    h.verdict('5', 'changes', 'not yet'); // not an answer, but rejects the recommendation
    e.start('5');
    e.review('5', 'Fixed', 'human:dawid', 'approve');
    now += 180 * 60_000;
    h.verdict('5', 'approve', 'ok'); // frees nothing after 180 min, takes the recommendation

    const r = buildReport(h, [], T0, T0 + 7 * DAY);
    expect(r.answers).toMatchObject({
      given: 3,
      measured: 3,
      unblocked: 4,
      medianUnblocked: 1,
      medianWaitMinutes: 120,
      recommended: 3,
      accepted: 2,
    });
    expect(r.answers.top.map((a) => [a.task, a.unblocked, a.type])).toEqual([
      ['T-0001', 3, 'answer'],
      ['T-0004', 1, 'unblock'],
    ]);
    const text = reportText(r);
    expect(text).toContain(
      'Answers: 3 given, 4 tasks unblocked (median 1 per answer), median wait 2 h, ' +
        '2 of 3 recommendations accepted.',
    );
    expect(text).toContain(
      'Top answers by tasks unblocked: T-0001 3 by human:dawid after 1 h; ' +
        'T-0004 1 by human:dawid after 2 h.',
    );
    // An answer outside the window is left out.
    expect(buildReport(h, [], T0 + 3 * DAY, T0 + 7 * DAY).answers.given).toBe(0);
  });

  it('counts a task that waits for a merge as unblocked only after the merge (AO-0228)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmupd-report-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const as = (actor: string) =>
      new Workspace({
        cwd: repo,
        env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
        actor,
        user: { opsd: { merge: { test: { base: 'main' } } } } as UserConfig,
        now: () => T0 + DAY,
      });
    const h = as('human:dawid');
    const e = as('claude:engineer');
    h.newTask({ title: 'the fix' });
    h.newTask({ title: 'needs the fix' });
    h.newTask({ title: 'needs task 2' });
    e.start('2');
    e.block('2', 'needs 1', { on: ['1'] });
    e.start('3');
    e.block('3', 'needs 2', { on: ['2'] });
    e.start('1');
    e.review('1', 'abc1234 on branch feature: the fix', 'human:dawid');
    h.verdict('1', 'approve', 'ok');
    const unblocked = () => buildReport(h, [], T0, T0 + 7 * DAY).answers;

    // Approved, not merged: tasks 2 and 3 are still blocked, so the approval unblocked nothing.
    expect(h.view('2').unblocked).toBe(false);
    expect(unblocked()).toMatchObject({ given: 1, measured: 1, unblocked: 0, top: [] });
    expect(reportText(buildReport(h, [], T0, T0 + 7 * DAY))).toContain('0 tasks unblocked');

    // A failed merge changes nothing.
    as(MERGE_ACTOR).comment('1', 'swarmupd could not merge abc1234', 'human:dawid');
    expect(unblocked()).toMatchObject({ given: 1, measured: 1, unblocked: 0 });

    // The merge releases them, and they count for the approval that waited for it.
    as(MERGE_ACTOR).recordMerge('1', { commit: 'abc1234', into: 'main', branch: 'feature' }, 'ok');
    expect(h.view('2').unblocked).toBe(true);
    const after = unblocked();
    expect(after).toMatchObject({ given: 1, measured: 1, unblocked: 2 });
    expect(after.top.map((a) => [a.task, a.unblocked, a.type, a.actor])).toEqual([
      ['T-0001', 2, 'verdict', 'human:dawid'],
    ]);
  });

  it('adds a merge to its approval only when both are in the window (AO-0228)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmupd-report-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const as = (actor: string, day: number) =>
      new Workspace({
        cwd: repo,
        env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
        actor,
        user: { opsd: { merge: { test: { base: 'main' } } } } as UserConfig,
        now: () => T0 + day * DAY,
      });
    const h = as('human:dawid', 1);
    const e = as('claude:engineer', 1);
    h.newTask({ title: 'the fix' });
    h.newTask({ title: 'needs the fix' });
    e.start('2');
    e.block('2', 'needs 1', { on: ['1'] });
    e.start('1');
    e.review('1', 'abc1234 on branch feature: the fix', 'human:dawid');
    h.verdict('1', 'approve', 'ok');
    // Approved on day 1, merged on day 3.
    as(MERGE_ACTOR, 3).recordMerge(
      '1',
      { commit: 'abc1234', into: 'main', branch: 'feature' },
      'ok',
    );
    const unblocked = (from: number, to: number) =>
      buildReport(h, [], T0 + from * DAY, T0 + to * DAY).answers;

    // The window ends before the merge: the approval had unblocked nothing by then.
    expect(unblocked(0, 2)).toMatchObject({ given: 1, measured: 1, unblocked: 0, top: [] });
    // The window holds both.
    expect(unblocked(0, 7)).toMatchObject({ given: 1, measured: 1, unblocked: 1 });
    // The window starts after the approval: the merge alone is no answer.
    expect(unblocked(2, 7)).toMatchObject({ given: 0, measured: 0, unblocked: 0, top: [] });
  });
});

describe('report events kept between reports', () => {
  it('builds the same report, reads only changed tasks again, and shows a new event', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmupd-report-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    let now = T0 - 2 * DAY;
    const h = new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
      actor: 'human:dawid',
      user: {},
      now: () => now,
    });
    // Before the window: one task closed, one left open; neither is read for the window.
    h.newTask({ title: 'old done', project: 'site' });
    h.done('1');
    h.newTask({ title: 'old open', project: 'site' });
    now = T0 + DAY;
    h.newTask({ title: 'asks', project: 'site' });
    h.newTask({ title: 'closes', project: 'api' });
    h.block('3', 'waiting', { to: 'human:dawid' });
    h.unblock('3', 'go on');
    h.done('4');
    const runs = [run('claude:engineer', 1, 30, 1000), run('codex:qa', -3, 10, 500)];
    const from = T0;
    const to = T0 + 7 * DAY;

    const events = new ReportEvents();
    const first = await buildReportAsync(h, runs, from, to, { events });
    // The same report as one built without kept events.
    expect(first).toEqual(buildReport(h, runs, from, to));
    expect(first.totals).toMatchObject({ opened: 2, closed: 1, runs: 1 });
    expect(first.answers.given).toBe(1);
    // Only the tasks with an event in the window were read.
    expect(events.reads).toBe(2);

    // The same request again reads no task.
    expect(await buildReportAsync(h, runs, from, to, { events })).toEqual(first);
    expect(events.reads).toBe(2);

    // A new event in the window shows at once, and only its task is read again.
    h.done('3');
    const after = await buildReportAsync(h, runs, from, to, { events });
    expect(after.totals.closed).toBe(2);
    expect(after).toEqual(buildReport(h, runs, from, to));
    expect(events.reads).toBe(3);

    // The events read off the event loop are the ones read in one piece.
    const root = h.roots[0]!;
    expect(await root.readEventsAsync('T-0003')).toEqual(root.readEvents('T-0003'));
  });

  it('drops the tasks read least recently past its limit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmupd-report-'));
    dirs.push(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    const h = new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
      actor: 'human:dawid',
      user: {},
      now: () => T0 + DAY,
    });
    for (const title of ['one', 'two', 'three']) {
      h.newTask({ title });
      h.comment(String(h.list({ all: true }).length), 'a note');
    }
    const events = new ReportEvents(2);
    const [a, b, c] = h.list({ all: true }).sort((x, y) => x.meta.id.localeCompare(y.meta.id));
    for (const t of [a!, b!, c!]) events.get(h, t);
    expect(events.reads).toBe(3);
    // Room for two events: the third task pushed out the first.
    events.get(h, c!);
    events.get(h, b!);
    expect(events.reads).toBe(3);
    events.get(h, a!);
    expect(events.reads).toBe(4);
  });
});
