// Loop figures in `swarmup report` (AO-0292): each number is built from a fixture store and
// checked against the run records (what `swarmup runs --all` lists) and the task events.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, MERGE_ACTOR, Workspace } from '@swarmup/core';
import type { UserConfig } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import { buildReport, reportText, stuckNote, stuckRun } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const MIN = 60_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');

/**
 * A day of work in two projects. T-0001: two review rounds with codex:reviewer, then a merge.
 * T-0002: one round with claude:reviewer, then a merge. T-0003: an ask and a review a person
 * answers, no merge. T-0004: stopped as stuck. T-0005: a quick ask.
 */
function store() {
  const repo = mkdtempSync(join(tmpdir(), 'swarmupd-loops-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  let now = T0 + DAY;
  const as = (actor: string) =>
    new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: join(repo, 'none.yml') },
      actor,
      user: { opsd: { merge: { test: { base: 'main' } } } } as UserConfig,
      now: () => now,
    });
  const h = as('human:dawid');
  const ce = as('claude:engineer');
  const xe = as('codex:engineer');
  const cr = as('claude:reviewer');
  const xr = as('codex:reviewer');
  const merge = as(MERGE_ACTOR);
  const runs: RunRecord[] = [];
  let n = 0;
  /** A run record and, for an ended run on a task, its `run-end` event, as swarmupd writes both. */
  const run = (
    agent: string,
    task: string | undefined,
    project: string,
    start: number,
    minutes: number,
    more: Partial<RunRecord> = {},
  ): RunRecord => {
    const r = {
      id: `run${++n}`,
      agent,
      ...(task ? { task: `T-000${task}` } : {}),
      root: 'test',
      project,
      pid: 1,
      command: 'x',
      cwd: '.',
      log: 'x',
      started_at: new Date(start).toISOString(),
      ended_at: new Date(start + minutes * MIN).toISOString(),
      status: 'ended',
      exit: 0,
      reason: 'exit',
      tokens: minutes * 100,
      ...more,
    } as RunRecord;
    if (r.status === 'running') delete r.ended_at;
    runs.push(r);
    if (task && r.status === 'ended') {
      as(agent).recordRun(task, 'run-end', {
        run: r.id,
        exit: r.exit,
        reason: r.reason,
        minutes,
        tokens: r.tokens,
      });
    }
    return r;
  };
  const at = T0 + DAY;

  h.newTask({ title: 'Login page', project: 'site' });
  h.newTask({ title: 'Rate limits', project: 'api' });
  h.newTask({ title: 'Docs', project: 'site' });
  h.newTask({ title: 'Importer', project: 'site' });
  h.newTask({ title: 'Quotas', project: 'api' });

  // T-0001: the first run started before the window; a merged task still counts it.
  run('claude:engineer', '1', 'site', T0 - 60 * MIN, 60);
  ce.start('1');
  ce.review('1', 'Ready', 'codex:reviewer');
  now += 30 * MIN;
  xr.verdict('1', 'changes', 'fix the tab order');
  run('codex:reviewer', '1', 'site', at, 10, { review: true });
  ce.start('1');
  ce.review('1', 'Fixed', 'codex:reviewer');
  run('claude:engineer', '1', 'site', at + 30 * MIN, 20);
  now += 30 * MIN;
  xr.verdict('1', 'approve', 'ok');
  run('codex:reviewer', '1', 'site', at + 50 * MIN, 10, { review: true });
  merge.recordMerge('1', { commit: 'abc1234', into: 'main', branch: 'one' }, 'ok');

  // T-0002: approved in one round by the other provider.
  xe.start('2');
  xe.review('2', 'Ready', 'claude:reviewer');
  run('codex:engineer', '2', 'api', at, 30);
  now += 10 * MIN;
  cr.verdict('2', 'approve', 'ok');
  run('claude:reviewer', '2', 'api', at + 30 * MIN, 5, { review: true });
  merge.recordMerge('2', { commit: 'def5678', into: 'main', branch: 'two' }, 'ok');

  // T-0003: a person answers after 90 minutes and approves after 20; nothing is merged.
  ce.start('3');
  ce.ask('3', 'Which docs site?');
  now += 90 * MIN;
  h.answer('3', 'The repo');
  ce.start('3');
  ce.review('3', 'Written', 'human:dawid');
  now += 20 * MIN;
  h.verdict('3', 'approve', 'ok');
  run('claude:engineer', '3', 'site', at, 15, { exit: 1 });
  run('claude:engineer', '3', 'site', at + 20 * MIN, 5, { exit: null, reason: 'killed' });

  // T-0004: two runs hit the budget; the second made swarmupd stop the task as stuck.
  run('claude:engineer', '4', 'site', at, 10, { exit: null, reason: 'budget' });
  const last = run('claude:engineer', '4', 'site', at + 10 * MIN, 10, {
    exit: null,
    reason: 'budget',
  });
  ce.start('4');
  ce.block('4', `${stuckNote('test/T-0004', 2, last)}\n\n- Log: \`swarmup logs ${last.id}\``, {
    to: 'human:dawid',
  });

  // T-0005: a person answers in 5 minutes.
  xe.start('5');
  xe.ask('5', 'Per user or per key?');
  now += 5 * MIN;
  h.answer('5', 'Per key');

  // Runs without a task, one per remaining way to end, and one still going.
  run('codex:engineer', undefined, 'api', at, 10, { exit: null, reason: 'tokens' });
  run('codex:engineer', undefined, 'api', at, 10, { exit: null, reason: 'lost' });
  run('codex:engineer', undefined, 'api', at, 10, { exit: null, reason: 'shutdown' });
  run('claude:orchestrator', undefined, 'site', at, 1, { exit: null, reason: 'stopped' });
  run('claude:engineer', undefined, 'site', at, 0, { status: 'running' });
  return { h, runs };
}

describe('loop figures in the report', () => {
  it('counts verdicts per author and reviewer pair, with the rounds an approval took', () => {
    const { h, runs } = store();
    const { pairs } = buildReport(h, runs, T0, T0 + 7 * DAY).loops;
    expect(pairs).toEqual([
      {
        author: 'claude:engineer',
        reviewer: 'codex:reviewer',
        reviews: 2,
        approve: 1,
        changes: 1,
        meanRounds: 2,
      },
      {
        author: 'claude:engineer',
        reviewer: 'human:dawid',
        reviews: 1,
        approve: 1,
        changes: 0,
        meanRounds: 1,
      },
      {
        author: 'codex:engineer',
        reviewer: 'claude:reviewer',
        reviews: 1,
        approve: 1,
        changes: 0,
        meanRounds: 1,
      },
    ]);
    // The same counts from the task events: every verdict in the store is in one pair.
    const verdicts = ['1', '2', '3'].flatMap((id) =>
      h.showEvents(id).events.filter((e) => e.type === 'verdict'),
    );
    expect(pairs.reduce((sum, p) => sum + p.reviews, 0)).toBe(verdicts.length);
    expect(pairs.reduce((sum, p) => sum + p.approve, 0)).toBe(
      verdicts.filter((e) => e.verdict === 'approve').length,
    );
  });

  it('sums tokens and minutes over all runs of a merged task, as its run-end events do', () => {
    const { h, runs } = store();
    const { merged } = buildReport(h, runs, T0, T0 + 7 * DAY).loops;
    expect(merged).toMatchObject({ tasks: 2, medianTokens: 6750, medianMinutes: 67.5 });
    expect(merged.top).toMatchObject([
      { task: 'T-0001', runs: 4, reviewRuns: 2, minutes: 100, tokens: 10000, rejected: 1 },
      { task: 'T-0002', runs: 2, reviewRuns: 1, minutes: 35, tokens: 3500, rejected: 0 },
    ]);
    for (const line of merged.top) {
      const ends = h.showEvents(line.task).events.filter((e) => e.type === 'run-end');
      expect(ends.length, line.task).toBe(line.runs);
      expect(
        ends.reduce((sum, e) => sum + (e.minutes ?? 0), 0),
        line.task,
      ).toBe(line.minutes);
      expect(
        ends.reduce((sum, e) => sum + (e.tokens ?? 0), 0),
        line.task,
      ).toBe(line.tokens);
      const records = runs.filter((r) => r.task === line.task);
      expect(
        records.reduce((sum, r) => sum + r.tokens, 0),
        line.task,
      ).toBe(line.tokens);
    }
    // A run that starts after the merge is not part of what the merge cost.
    const later = {
      ...runs.find((r) => r.task === 'T-0002')!,
      id: 'later',
      started_at: new Date(T0 + 3 * DAY).toISOString(),
      ended_at: new Date(T0 + 3 * DAY + MIN).toISOString(),
    };
    const again = buildReport(h, [...runs, later], T0, T0 + 7 * DAY).loops.merged;
    expect(again.top[1]).toMatchObject({ task: 'T-0002', runs: 2, tokens: 3500 });
  });

  it('counts why the runs of the window stopped, as the run records say', () => {
    const { h, runs } = store();
    const report = buildReport(h, runs, T0, T0 + 7 * DAY);
    const { stops } = report.loops;
    expect(stops).toEqual({
      reasons: [
        { reason: 'exit', runs: 6 },
        { reason: 'budget', runs: 1 },
        { reason: 'tokens', runs: 1 },
        { reason: 'stuck', runs: 1 },
        { reason: 'lost', runs: 1 },
        { reason: 'person', runs: 2 },
        { reason: 'shutdown', runs: 1 },
      ],
      failedExits: 1,
      running: 1,
    });
    // Every run the report counts is in one line: what `swarmup runs --all` shows per run.
    const inWindow = runs.filter((r) => Date.parse(r.started_at) >= T0);
    expect(report.totals.runs).toBe(inWindow.length);
    expect(stops.reasons.reduce((sum, s) => sum + s.runs, 0) + stops.running).toBe(inWindow.length);
    const by = (reason: string): number =>
      inWindow.filter((r) => r.status === 'ended' && r.reason === reason).length;
    expect(by('exit')).toBe(6);
    // The stuck run is one of the two budget runs; the people's stops are `killed` and `stopped`.
    expect(by('budget')).toBe(2);
    expect(by('killed') + by('stopped')).toBe(2);
  });

  it('reads the stuck run back from the block swarmupd writes', () => {
    const note = stuckNote('test/T-0004', 3, {
      id: '01ABC',
      agent: 'codex:engineer',
      reason: 'exit',
      exit: 0,
    });
    expect(stuckRun(`${note}\n\n- Log: \`swarmup logs 01ABC\``)).toBe('01ABC');
    expect(stuckRun('needs AO-0012 first')).toBeNull();
    expect(stuckRun(undefined)).toBeNull();
  });

  it('measures how long asks and reviews waited for the person who answered', () => {
    const { h, runs } = store();
    const { humanWaits } = buildReport(h, runs, T0, T0 + 7 * DAY).loops;
    expect(humanWaits).toEqual({
      asks: { count: 2, medianMinutes: 47.5, longestMinutes: 90, longestTask: 'T-0003' },
      reviews: { count: 1, medianMinutes: 20, longestMinutes: 20, longestTask: 'T-0003' },
    });
    // The same waits from the events: the answer's time minus the ask's.
    const events = h.showEvents('3').events;
    const ask = events.find((e) => e.type === 'ask')!;
    const answer = events.find((e) => e.type === 'answer')!;
    expect((Date.parse(answer.at) - Date.parse(ask.at)) / MIN).toBe(90);
  });

  it('narrows every figure to a project and to the window', () => {
    const { h, runs } = store();
    const api = buildReport(h, runs, T0, T0 + 7 * DAY, { project: 'api' }).loops;
    expect(api.pairs.map((p) => [p.author, p.reviewer, p.reviews])).toEqual([
      ['codex:engineer', 'claude:reviewer', 1],
    ]);
    expect(api.merged.top.map((m) => m.task)).toEqual(['T-0002']);
    expect(api.stops).toEqual({
      reasons: [
        { reason: 'exit', runs: 2 },
        { reason: 'tokens', runs: 1 },
        { reason: 'lost', runs: 1 },
        { reason: 'shutdown', runs: 1 },
      ],
      failedExits: 0,
      running: 0,
    });
    expect(api.humanWaits.asks).toMatchObject({ count: 1, longestTask: 'T-0005' });
    expect(api.humanWaits.reviews.count).toBe(0);

    // A window after the day: nothing happened in it.
    const after = buildReport(h, runs, T0 + 3 * DAY, T0 + 7 * DAY);
    expect(after.loops).toEqual({
      pairs: [],
      merged: { tasks: 0, medianTokens: null, medianMinutes: null, top: [] },
      stops: { reasons: [], failedExits: 0, running: 0 },
      humanWaits: {
        asks: { count: 0, medianMinutes: null, longestMinutes: null, longestTask: null },
        reviews: { count: 0, medianMinutes: null, longestMinutes: null, longestTask: null },
      },
    });
    expect(reportText(after)).not.toMatch(/Reviews by|Merged tasks|Run stops|Human time/);
  });

  it('prints the figures in the report text', () => {
    const { h, runs } = store();
    const text = reportText(buildReport(h, runs, T0, T0 + 7 * DAY));
    expect(text).toContain(
      'Reviews by author > reviewer: claude:engineer > codex:reviewer 2 reviews, 1 approved, ' +
        '1 changes, 2 rounds to approve; claude:engineer > human:dawid 1 review, 1 approved, ' +
        '0 changes, 1 rounds to approve; codex:engineer > claude:reviewer 1 review, 1 approved, ' +
        '0 changes, 1 rounds to approve.',
    );
    expect(text).toContain('Merged tasks: 2, median 6750 tokens and 1 h 8 min in runs per task.');
    expect(text).toContain(
      'Top merged tasks by tokens: T-0001 10000 tokens, 1 h 40 min, 4 runs, 1 rejected round; ' +
        'T-0002 3500 tokens, 35 min, 2 runs.',
    );
    expect(text).toContain(
      'Run stops: exit 6 (1 failed), budget 1, tokens 1, stuck 1, lost 1, stopped by a person 2, ' +
        'shutdown 1, still running 1.',
    );
    expect(text).toContain(
      'Human time to answer: 2 asks, median 48 min, longest 1 h 30 min (T-0003); ' +
        '1 review, median 20 min, longest 20 min (T-0003).',
    );
  });
});
