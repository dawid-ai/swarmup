// Scores (W4): each built-in scorer, the settings, the summaries, the keeper and state.db, the
// orientation parser, the report section and the API.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initRoot, MERGE_ACTOR, Workspace } from '@swarmup/core';
import type { OpsEvent } from '@swarmup/core';
import type { RunRecord, ScoreDb, ScoreResult, ScoreTask, StoredScore } from '../src/index.js';
import {
  buildReport,
  computeScores,
  logOrientation,
  reportText,
  ScoreKeeper,
  scoreHistory,
  scorerCatalog,
  scorerSettings,
  scoresText,
  StateDb,
  startApi,
  stuckNote,
  subjectScoresText,
  summarizeScores,
  Supervisor,
} from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];
const guard = mkdtempSync(join(tmpdir(), 'swarmupd-scores-guard-'));
const processConfig = join(guard, 'process-config.yml');
const savedConfig = process.env.SWARMUP_CONFIG;
beforeAll(() => {
  process.env.SWARMUP_CONFIG = processConfig;
});
afterAll(() => {
  if (savedConfig === undefined) delete process.env.SWARMUP_CONFIG;
  else process.env.SWARMUP_CONFIG = savedConfig;
  rmSync(guard, { recursive: true, force: true });
});
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-scores-'));
  dirs.push(d);
  return d;
}

const T0 = Date.parse('2026-11-01T00:00:00Z');
const MIN = 60_000;
let seq = 0;

/** An event `minute` minutes after T0. */
function ev(minute: number, type: string, actor: string, extra: Partial<OpsEvent> = {}): OpsEvent {
  seq++;
  return {
    id: `E${String(seq).padStart(4, '0')}`,
    type,
    actor,
    at: new Date(T0 + minute * MIN).toISOString(),
    body: '',
    ...extra,
  };
}

function task(
  id: string,
  events: OpsEvent[],
  opts: { status?: string; labels?: string[]; type?: string; root?: string } = {},
): ScoreTask {
  return {
    root: opts.root ?? 'r',
    id,
    title: id,
    meta: { type: opts.type ?? 'task', ...(opts.labels ? { labels: opts.labels } : {}) },
    status: opts.status ?? 'done',
    events,
  };
}

function run(id: string, agent: string, minute: number, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    agent,
    task: 'T-1',
    root: 'r',
    pid: 1,
    image: 'node',
    command: 'x',
    cwd: '.',
    log: 'x',
    started_at: new Date(T0 + minute * MIN).toISOString(),
    ended_at: new Date(T0 + (minute + 10) * MIN).toISOString(),
    status: 'ended',
    exit: 0,
    reason: 'exit',
    budget_minutes: 60,
    tokens: 100,
    ...extra,
  };
}

const ENG = 'claude:engineer';
const REV = 'codex:reviewer';
const HUMAN = 'human:dawid';

function only(results: ScoreResult[], scorer: string): ScoreResult[] {
  return results.filter((r) => r.scorer === scorer);
}

describe('task scorers', () => {
  it('counts review rounds before the approval, against the threshold', () => {
    const t = task('T-1', [
      ev(0, 'claim', ENG),
      ev(1, 'review', ENG),
      ev(2, 'verdict', REV, { verdict: 'changes' }),
      ev(3, 'review', ENG),
      ev(4, 'verdict', REV, { verdict: 'changes' }),
      ev(5, 'review', ENG),
      ev(6, 'verdict', REV, { verdict: 'approve' }),
    ]);
    const [r] = only(computeScores({ tasks: [t], runs: [] }), 'review-rounds');
    expect(r).toMatchObject({
      subject: 'r/T-1',
      agent: ENG,
      value: 2,
      pass: false,
      unit: 'rounds',
    });
    expect(r!.evidence).toHaveLength(3);
    const lax = computeScores(
      { tasks: [t], runs: [] },
      { settings: { 'review-rounds': { pass: 2 } } },
    );
    expect(only(lax, 'review-rounds')[0]!.pass).toBe(true);
    // A task without an approval has no review-rounds score.
    const open = task('T-2', [ev(0, 'review', ENG)], { status: 'needs-review' });
    expect(only(computeScores({ tasks: [open], runs: [] }), 'review-rounds')).toEqual([]);
  });

  it("counts swarmupd's changes verdicts as merge failures, not as review rounds", () => {
    const t = task('T-1', [
      ev(1, 'review', ENG),
      ev(2, 'verdict', REV, { verdict: 'approve' }),
      ev(3, 'verdict', MERGE_ACTOR, { verdict: 'changes' }),
      ev(4, 'review', ENG),
      ev(5, 'verdict', REV, { verdict: 'approve' }),
      ev(6, 'merge', MERGE_ACTOR),
    ]);
    const res = computeScores({ tasks: [t], runs: [] });
    expect(only(res, 'merge-failures')[0]).toMatchObject({ value: 1, pass: false, agent: ENG });
    expect(only(res, 'review-rounds')[0]).toMatchObject({ value: 0, pass: true });
  });

  it('sums the tokens and minutes of the runs of a merged task up to its merge', () => {
    const t = task('T-1', [ev(1, 'review', ENG), ev(30, 'merge', MERGE_ACTOR)]);
    const runs = [
      run('R1', ENG, 0, { tokens: 1000 }),
      run('R2', REV, 15, { tokens: 300, review: true }),
      run('R3', ENG, 40, { tokens: 5000 }),
      run('R4', ENG, 0, { tokens: 7000, root: 'other' }),
    ];
    const [r] = only(computeScores({ tasks: [t], runs }), 'cost-per-merged-task');
    expect(r).toMatchObject({ value: 1300, n: 2, evidence: ['R1', 'R2'] });
    expect(r!.extra).toEqual({ minutes: 20, runs: 2, reviewRuns: 1 });
    expect(r!.pass).toBeUndefined();
  });

  it('counts asks to a person and what a person wrote on a done task', () => {
    const t = task('T-1', [
      ev(1, 'ask', ENG, { to: HUMAN }),
      ev(2, 'answer', HUMAN),
      ev(3, 'ask', ENG, { to: 'claude:pm' }),
      ev(4, 'comment', HUMAN),
      ev(5, 'review', ENG),
      ev(6, 'verdict', HUMAN, { verdict: 'approve' }),
    ]);
    const [r] = only(computeScores({ tasks: [t], runs: [] }), 'human-touches');
    expect(r).toMatchObject({ value: 4, pass: false, agent: ENG });
    const open = task('T-2', t.events, { status: 'in-progress' });
    expect(only(computeScores({ tasks: [open], runs: [] }), 'human-touches')).toEqual([]);
  });

  it('counts an ask to a person off the escalation list as a miss', () => {
    const asks = () => [ev(1, 'ask', ENG, { to: HUMAN }), ev(2, 'ask', 'codex:pm', { to: HUMAN })];
    const release = task('T-1', asks(), { labels: ['Release'] });
    const plain = task('T-2', [...asks(), ev(3, 'ask', ENG, { to: 'claude:pm' })]);
    const res = only(
      computeScores({ tasks: [release, plain], runs: [] }),
      'escalation-correctness',
    );
    expect(res.map((r) => [r.subject, r.agent, r.value, r.pass])).toEqual([
      ['r/T-1', ENG, 1, true],
      ['r/T-1', 'codex:pm', 1, true],
      ['r/T-2', ENG, 0, false],
      ['r/T-2', 'codex:pm', 0, false],
    ]);
    expect(res[2]!.note).toMatch(/off the escalation list/);
    // The type counts like a label.
    const billing = task('T-3', [ev(1, 'ask', ENG, { to: HUMAN })], { type: 'billing' });
    expect(
      only(computeScores({ tasks: [billing], runs: [] }), 'escalation-correctness')[0]!.value,
    ).toBe(1);
  });

  it('counts an ask with a reason only a person can answer as right, off the list too', () => {
    const t = task('T-4', [
      ev(1, 'ask', ENG, { to: HUMAN, reason: 'access' }),
      ev(2, 'ask', ENG, { to: HUMAN, reason: 'curious' }),
      ev(3, 'ask', ENG, { to: HUMAN }),
      ev(4, 'ask', ENG, { to: HUMAN, reason: 'direction' }),
    ]);
    const [r] = only(computeScores({ tasks: [t], runs: [] }), 'escalation-correctness');
    expect(r).toMatchObject({ value: 0.5, pass: false, n: 4 });
    expect(r!.note).toMatch(/^2 ask\(s\) to a person off the escalation list, with no --reason/);
  });

  it('reads the criteria of the approving verdict, and gives no score without them', () => {
    const approve = ev(2, 'verdict', REV, { verdict: 'approve' }) as OpsEvent & {
      criteria: Record<string, { result: string }>;
    };
    approve.criteria = {
      tests: { result: 'pass' },
      docs: { result: 'fail' },
      perf: { result: 'na' },
    };
    const t = task('T-1', [ev(1, 'review', ENG), approve]);
    const [r] = only(computeScores({ tasks: [t], runs: [] }), 'criteria-pass-rate');
    expect(r).toMatchObject({ value: 0.5, n: 2, pass: false, note: 'failed: docs' });
    const none = task('T-2', [ev(1, 'review', ENG), ev(2, 'verdict', REV, { verdict: 'approve' })]);
    expect(only(computeScores({ tasks: [none], runs: [] }), 'criteria-pass-rate')).toEqual([]);
  });

  it('scores the reviewer on the prose criteria its approval leaves unmarked', () => {
    const approve = ev(2, 'verdict', REV, { verdict: 'approve' }) as OpsEvent & {
      criteria: Record<string, { result: string }>;
    };
    approve.criteria = { tests: { result: 'pass' }, c3: { result: 'na' } };
    const t = task('T-1', [ev(1, 'review', ENG), approve]);
    t.meta.done_when = [
      { id: 'tests', kind: 'command', run: 'npm test' },
      'The README explains the flag.',
      'Old behavior is unchanged.',
      'The changelog names it.',
    ];
    const [r] = only(computeScores({ tasks: [t], runs: [] }), 'verdict-completeness');
    // c2 and c4 are prose and unmarked; the command criterion isn't the reviewer's to mark.
    expect(r).toMatchObject({
      agent: REV,
      value: 0.333,
      n: 3,
      pass: false,
      note: 'unmarked: c2, c4',
    });
    // A person's approval, or a task with no prose criteria, gets no score.
    const byPerson = task('T-2', [
      ev(1, 'review', ENG),
      ev(2, 'verdict', HUMAN, { verdict: 'approve' }),
    ]);
    byPerson.meta.done_when = ['Looks right.'];
    const noProse = task('T-3', [
      ev(1, 'review', ENG),
      ev(2, 'verdict', REV, { verdict: 'approve' }),
    ]);
    noProse.meta.done_when = [{ id: 'tests', kind: 'command', run: 'npm test' }];
    expect(
      only(computeScores({ tasks: [byPerson, noProse], runs: [] }), 'verdict-completeness'),
    ).toEqual([]);
  });
});

describe('agent and run scorers', () => {
  it('credits recommendations to the agent that made them', () => {
    const t = task('T-1', [
      ev(1, 'ask', ENG, { to: HUMAN, recommend: 'A' }),
      ev(2, 'answer', HUMAN, { accepted: true }),
      ev(3, 'review', ENG, { recommend: 'merge' }),
      ev(4, 'verdict', REV, { verdict: 'changes', accepted: false }),
      ev(5, 'ask', 'codex:pm', { to: HUMAN, recommend: 'B' }),
      ev(6, 'answer', HUMAN, { accepted: true }),
    ]);
    const res = only(computeScores({ tasks: [t], runs: [] }), 'recommendation-acceptance');
    const eng = res.find((r) => r.agent === ENG)!;
    expect(eng).toMatchObject({ level: 'agent', value: 0.5, n: 2, pass: false });
    expect(eng.evidence).toEqual([`T-1#${t.events[3]!.id}`]);
    expect(res.find((r) => r.agent === 'codex:pm')).toMatchObject({ value: 1, pass: true });
  });

  it('counts failed and no-progress runs, not runs a person stopped', () => {
    const t = task('T-1', [
      ev(0, 'run-start', ENG, { run: 'R5' }),
      ev(5, 'release', ENG, { body: 'run R5 ended (exit, exit 0) without finishing' }),
      ev(10, 'run-start', ENG, { run: 'R6' }),
      ev(12, 'progress', ENG),
      ev(15, 'release', ENG, { body: 'run R6 ended (exit, exit 0) without finishing' }),
      ev(20, 'block', ENG, {
        body: stuckNote('r/T-1', 3, { id: 'R7', agent: ENG, reason: 'exit', exit: 0 }),
      }),
    ]);
    const runs = [
      run('R1', ENG, 0),
      run('R2', ENG, 0, { exit: 1 }),
      run('R3', ENG, 0, { reason: 'budget', exit: null }),
      run('R4', ENG, 0, { reason: 'killed', exit: null }),
      run('R5', ENG, 0),
      run('R6', ENG, 10),
      run('R7', ENG, 18),
      run('R8', ENG, 0, { status: 'running', ended_at: undefined }),
      run('R9', ENG, 0, { chat: true, exit: 1 }),
    ];
    const [r] = only(computeScores({ tasks: [t], runs }), 'stuck-runs');
    expect(r).toMatchObject({ value: round(4 / 6), n: 6, pass: false });
    expect([...r!.evidence].sort()).toEqual(['R2', 'R3', 'R5', 'R7']);
  });

  it("scores a writing run's orientation from the provider", () => {
    const runs = [
      run('R1', ENG, 0),
      run('R2', REV, 0, { review: true }),
      run('R3', ENG, 0),
      run('R4', ENG, 0),
    ];
    const stats = {
      R1: { toolCalls: 12, resultBytesBefore: 300, resultBytes: 1000, edited: true },
      R2: { toolCalls: 4, resultBytesBefore: 10, resultBytes: 10, edited: true },
      R3: { toolCalls: 50, resultBytesBefore: 900, resultBytes: 900, edited: false },
    } as Record<string, NonNullable<ReturnType<typeof logOrientation>>>;
    const res = only(
      computeScores({ tasks: [], runs, orientation: (r) => stats[r.id] }),
      'orientation',
    );
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ level: 'run', subject: 'R1', value: 12, pass: true });
    expect(res[0]!.extra).toEqual({ share: 0.3, bytesBefore: 300, bytes: 1000 });
    expect(only(computeScores({ tasks: [], runs }), 'orientation')).toEqual([]);
  });

  it('keeps task scores and agent counts inside the window', () => {
    const early = task('T-1', [
      ev(1, 'review', ENG),
      ev(2, 'verdict', REV, { verdict: 'approve', accepted: true }),
    ]);
    const late = task('T-2', [
      ev(2000, 'review', ENG),
      ev(2001, 'verdict', REV, { verdict: 'changes', accepted: false }),
      ev(2002, 'review', ENG),
      ev(2003, 'verdict', REV, { verdict: 'approve', accepted: true }),
    ]);
    const res = computeScores({ tasks: [early, late], runs: [] }, { from: T0 + 1000 * MIN });
    expect(only(res, 'review-rounds').map((r) => r.subject)).toEqual(['r/T-2']);
    expect(only(res, 'recommendation-acceptance')[0]).toMatchObject({ n: 2, value: 0.5 });
  });
});

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

describe('settings and summaries', () => {
  it('reads swarmupd.scorers and refuses what it cannot use', () => {
    const user = (scorers: unknown) => ({ swarmupd: { scorers } }) as never;
    expect(scorerSettings({} as never)).toEqual({});
    expect(scorerSettings(user({ 'review-rounds': { pass: 2, enabled: true } }))).toEqual({
      'review-rounds': { pass: 2, enabled: true },
    });
    expect(() => scorerSettings(user({ nope: {} }))).toThrow(/no such scorer/);
    expect(() => scorerSettings(user({ 'review-rounds': { pass: 'two' } }))).toThrow(
      /use a number/,
    );
    expect(() => scorerSettings(user({ 'review-rounds': { enabled: 1 } }))).toThrow(
      /true or false/,
    );
    expect(() => scorerSettings(user({ 'review-rounds': { max: 1 } }))).toThrow(/unknown key max/);
    const t = task('T-1', [ev(1, 'review', ENG), ev(2, 'verdict', REV, { verdict: 'approve' })]);
    const off = computeScores(
      { tasks: [t], runs: [] },
      { settings: { 'review-rounds': { enabled: false } } },
    );
    expect(only(off, 'review-rounds')).toEqual([]);
  });

  it('summarizes per agent with the mean, the pass rate and the worst tasks', () => {
    const rounds = (id: string, n: number, at: number) =>
      task(id, [
        ev(at, 'review', ENG),
        ...Array.from({ length: n }, (_, i) =>
          ev(at + 1 + i, 'verdict', REV, { verdict: 'changes' as const }),
        ),
        ev(at + 50, 'verdict', REV, { verdict: 'approve' }),
      ]);
    const tasks = [rounds('T-1', 0, 0), rounds('T-2', 3, 100), rounds('T-3', 1, 200)];
    const runs = [run('R1', ENG, 0), run('R2', ENG, 0, { exit: 1 })];
    const results = computeScores({ tasks, runs });
    const [eng] = summarizeScores(results);
    expect(eng!.agent).toBe(ENG);
    const rr = eng!.scorers.find((l) => l.scorer === 'review-rounds')!;
    expect(rr).toMatchObject({ n: 3, mean: 1.33, passed: 2, judged: 3, pass: 1 });
    // Each line says what it measures and what to change, for the desktop's hints.
    expect(rr.description).toMatch(/changes verdicts/);
    expect(rr.lever).toMatch(/role file/);
    expect(rr.worst.map((w) => w.subject)).toEqual(['r/T-2']);
    const stuck = eng!.scorers.find((l) => l.scorer === 'stuck-runs')!;
    expect(stuck).toMatchObject({ level: 'agent', n: 2, mean: 0.5, judged: 1, passed: 0 });
    const text = scoresText([eng!]);
    expect(text).toMatch(/^claude:engineer$/m);
    expect(text).toMatch(
      /review-rounds: mean 1\.33 rounds over 3 tasks, 67% pass \(<= 1 rounds\); worst T-2 3 rounds/,
    );
    expect(text).toMatch(/stuck-runs: 50% of 2, fail \(<= 10%\); e\.g\. R2/);
    expect(scoresText([])).toMatch(/no scores/);
    const mine = results.filter((r) => r.subject === 'r/T-2');
    expect(subjectScoresText('r/T-2', mine)).toMatch(
      /review-rounds: 3 rounds FAIL \[claude:engineer\]\n {4}evidence: E/,
    );
  });
});

describe('orientation from run logs', () => {
  it('counts Claude tool calls and result bytes before the first edit', () => {
    const d = temp();
    const log = join(d, 'claude.log');
    const use = (name: string) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } });
    const result = (text: string, parent: string | null = null) =>
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: parent,
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] },
      });
    writeFileSync(
      log,
      [
        '{"type":"system","subtype":"init"}',
        use('Read'),
        result('x'.repeat(100)),
        use('Grep'),
        result('y'.repeat(50)),
        result('z'.repeat(999), 'toolu_sub'),
        use('Edit'),
        result('ok'),
        use('Bash'),
        result('w'.repeat(48)),
      ].join('\n'),
    );
    expect(logOrientation(log)).toEqual({
      toolCalls: 2,
      resultBytesBefore: 150,
      resultBytes: 200,
      edited: true,
    });
    expect(logOrientation(join(d, 'missing.log'))).toBeNull();
  });

  it('counts Codex items before the first file change, and every call of a run with none', () => {
    const d = temp();
    const item = (type: string, out = '') =>
      JSON.stringify({ type: 'item.completed', item: { type, aggregated_output: out } });
    const log = join(d, 'codex.log');
    writeFileSync(
      log,
      [
        item('command_execution', 'abc'),
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }),
        item('agent_message'),
        item('command_execution', 'de'),
        item('file_change'),
        item('command_execution', 'fghij'),
      ].join('\n'),
    );
    expect(logOrientation(log)).toEqual({
      toolCalls: 2,
      resultBytesBefore: 5,
      resultBytes: 10,
      edited: true,
    });
    const reading = join(d, 'read.log');
    writeFileSync(reading, [item('command_execution', 'ab'), item('command_execution')].join('\n'));
    expect(logOrientation(reading)).toMatchObject({ toolCalls: 2, edited: false });
  });
});

/** A root with one reviewed and approved task, and a workspace per actor. */
function store(): { repo: string; as: (actor: string) => Workspace } {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: HUMAN });
  const as = (actor: string) =>
    new Workspace({ cwd: repo, env: { SWARMUP_CONFIG: join(repo, 'none.yml') }, actor, user: {} });
  as(HUMAN).newTask({ title: 'Parser', owner: ENG });
  as(ENG).start('1', 'plan');
  as(ENG).review('1', 'ready', REV);
  as(REV).verdict('1', 'changes', 'add a test');
  as(ENG).start('1', 'add the test');
  as(ENG).review('1', 'ready again', REV);
  return { repo, as };
}

/** A ScoreDb in memory that records each write. */
function memoryDb(): ScoreDb & { writes: number[] } {
  const rows = new Map<string, StoredScore>();
  const writes: number[] = [];
  return {
    writes,
    saveScores(list) {
      writes.push(list.length);
      for (const r of list) {
        const key = `${r.key.scorer}\n${r.key.subject}\n${r.key.agent}`;
        if (r.result) rows.set(key, { result: r.result, computed_at: r.computed_at });
        else rows.delete(key);
      }
    },
    latestScores: () => [...rows.values()],
  };
}

describe('keeping scores', () => {
  it('writes only scores that changed, and reads them back after a restart', async () => {
    const { as } = store();
    const db = memoryDb();
    const keeper = new ScoreKeeper(db);
    const runs = [run('R1', ENG, 0, { task: 'T-0001', root: 'test', exit: 1 })];
    expect(await keeper.refresh(as(HUMAN), runs)).toEqual([
      expect.objectContaining({ scorer: 'stuck-runs', value: 1 }),
    ]);
    expect(db.writes).toEqual([1]);
    // Nothing changed: no work and no write.
    await keeper.refresh(as(HUMAN), runs);
    await keeper.refresh(as(HUMAN), runs, {}, true);
    expect(db.writes).toEqual([1]);
    as(REV).verdict('1', 'approve', 'good');
    const after = await keeper.refresh(as(HUMAN), runs);
    expect(after.find((r) => r.scorer === 'review-rounds')).toMatchObject({
      subject: 'test/T-0001',
      value: 1,
    });
    expect(db.writes).toEqual([1, 2]);
    const restarted = new ScoreKeeper(db);
    expect(restarted.results()).toHaveLength(3);
    // Turned off: its scores go.
    await restarted.refresh(as(HUMAN), runs, { 'stuck-runs': { enabled: false } });
    expect(
      restarted
        .results()
        .map((r) => r.scorer)
        .sort(),
    ).toEqual(['human-touches', 'review-rounds']);
    expect(db.writes).toEqual([1, 2, 1]);
  });

  it('keeps the history of each score in state.db and returns the latest', () => {
    const db = new StateDb(temp());
    const key = { scorer: 'review-rounds', level: 'task', subject: 'test/T-0001', agent: ENG };
    const result = (value: number) => ({
      ...key,
      value,
      unit: 'rounds',
      n: 1,
      evidence: [],
      at: '',
    });
    db.saveScores([{ key, result: result(2), computed_at: '2026-11-01T00:00:00.000Z' }]);
    db.saveScores([{ key, result: result(1), computed_at: '2026-11-02T00:00:00.000Z' }]);
    expect(db.latestScores()).toEqual([
      { result: result(1), computed_at: '2026-11-02T00:00:00.000Z' },
    ]);
    db.saveScores([{ key, result: null, computed_at: '2026-11-03T00:00:00.000Z' }]);
    expect(db.latestScores()).toEqual([]);
  });

  it("keeps a stored orientation without reading the run's log again", async () => {
    const { as } = store();
    const db = memoryDb();
    let reads = 0;
    const orientation = () => {
      reads++;
      return { toolCalls: 7, resultBytesBefore: 1, resultBytes: 2, edited: true };
    };
    const runs = [run('R1', ENG, 0, { task: 'T-0001', root: 'test' })];
    await new ScoreKeeper(db, { orientation }).refresh(as(HUMAN), runs);
    expect(reads).toBe(1);
    const again = new ScoreKeeper(db, { orientation });
    const res = await again.refresh(as(HUMAN), runs, {}, true);
    expect(reads).toBe(1);
    expect(res.find((r) => r.scorer === 'orientation')).toMatchObject({ value: 7 });
  });
});

describe('score trends', () => {
  const H = 3_600_000;
  const at = (ms: number) => new Date(T0 + ms).toISOString();
  const result = (scorer: string, agent: string, value: number, ms: number, level = 'task') =>
    ({
      scorer,
      level,
      subject: `r/${scorer}-${ms}`,
      agent,
      value,
      unit: 'rounds',
      n: 1,
      evidence: [],
      at: at(ms),
    }) as ScoreResult;

  it('buckets task scores by local day and keeps the last agent score of each day', () => {
    const results = [
      result('review-rounds', ENG, 2, 1 * H),
      result('review-rounds', ENG, 0, 5 * H),
      // 23:30 UTC is the next day an hour east of UTC.
      result('review-rounds', ENG, 3, 23.5 * H),
      result('review-rounds', REV, 1, 2 * H),
      // Outside the window.
      result('review-rounds', ENG, 9, -2 * H),
    ];
    const rows = [
      // Before the window: opens the trend at its start.
      { agent: ENG, scorer: 'stuck-runs', computed_at: at(-30 * H), value: 0.5, n: 4 },
      { agent: ENG, scorer: 'stuck-runs', computed_at: at(3 * H), value: 0.2, n: 5 },
      { agent: ENG, scorer: 'stuck-runs', computed_at: at(4 * H), value: 0.25, n: 4 },
      { agent: ENG, scorer: 'stuck-runs', computed_at: at(30 * H), value: 0.1, n: 10 },
    ];
    const series = scoreHistory(results, rows, scorerCatalog(), {
      from: T0,
      to: T0 + 4 * 24 * H,
      tz: -60,
    });
    expect(series.map((s) => `${s.agent} ${s.scorer}`)).toEqual([
      `${ENG} review-rounds`,
      `${ENG} stuck-runs`,
      `${REV} review-rounds`,
    ]);
    const day0 = new Date(T0 - H).toISOString();
    const day1 = new Date(T0 + 23 * H).toISOString();
    expect(series[0]!.points).toEqual([
      { at: day0, value: 1, n: 2 },
      { at: day1, value: 3, n: 1 },
    ]);
    expect(series[0]).toMatchObject({ unit: 'rounds', better: 'lower', pass: 1 });
    expect(series[1]!.points).toEqual([
      { at: day0, value: 0.25, n: 4 },
      { at: day1, value: 0.1, n: 10 },
    ]);
    // One agent and one scorer, by the hour for a short window.
    const one = scoreHistory(results, rows, scorerCatalog(), {
      from: T0,
      to: T0 + 24 * H,
      agent: ENG,
      scorer: 'review-rounds',
    });
    expect(one).toHaveLength(1);
    expect(one[0]!.points.map((p) => p.at)).toEqual([at(1 * H), at(5 * H), at(23 * H)]);
  });

  it('reads agent-score rows of a window from state.db, with the last one before it', () => {
    const db = new StateDb(temp());
    const save = (agent: string, value: number | null, day: number) => {
      const key = { scorer: 'stuck-runs', level: 'agent', subject: agent, agent };
      const res =
        value === null ? null : { ...key, value, unit: 'ratio', n: 3, evidence: [], at: '' };
      db.saveScores([{ key, result: res, computed_at: `2026-11-0${day}T00:00:00.000Z` }]);
    };
    save(ENG, 0.5, 1);
    save(ENG, 0.3, 3);
    save(ENG, 0.2, 5);
    save(REV, 0.1, 2);
    save(REV, null, 3);
    const rows = db.agentScoreHistory({
      since: '2026-11-02T00:00:00.000Z',
      until: '2026-11-04T00:00:00.000Z',
    });
    expect(rows.map((r) => [r.agent, r.computed_at.slice(0, 10), r.value, r.n])).toEqual([
      [ENG, '2026-11-01', 0.5, 3],
      [REV, '2026-11-02', 0.1, 3],
      [ENG, '2026-11-03', 0.3, 3],
    ]);
    expect(
      db.agentScoreHistory({
        since: '2026-11-04T00:00:00.000Z',
        until: '2026-11-09T00:00:00.000Z',
        agent: REV,
      }),
    ).toEqual([]);
  });
});

describe('scores in the report and the API', () => {
  it('adds per-agent scores to the report and its text', () => {
    const { as } = store();
    as(REV).verdict('1', 'approve', 'good');
    const now = Date.now();
    const r = buildReport(as(HUMAN), [], now - 86_400_000, now + 1);
    const eng = r.scores.find((a) => a.agent === ENG)!;
    expect(eng.scorers.find((l) => l.scorer === 'review-rounds')).toMatchObject({ n: 1, mean: 1 });
    expect(reportText(r)).toMatch(
      /^Scores of claude:engineer: .*review-rounds: mean 1 rounds over 1 tasks/m,
    );
  });

  it('serves the kept scores and computes them again on request', async () => {
    const { repo, as } = store();
    as(REV).verdict('1', 'approve', 'good');
    const config = join(temp(), 'config.yml');
    writeFileSync(config, 'me: human:dawid\nswarmupd:\n  sync: false\n');
    const state = temp();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SWARMUP_CONFIG: config,
      SWARMUP_STATE_DIR: state,
    };
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
    sups.push(sup);
    const api = await startApi(sup, { port: 0, token: 'scores-token', version: 't', build: '1' });
    const call = async (method: 'GET' | 'POST', path: string) => {
      const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
        method,
        headers: { authorization: 'Bearer scores-token', 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const got = await call('GET', `/api/scores?agent=${ENG}&task=test/T-0001`);
    expect(got.status).toBe(200);
    expect(got.body.agents).toEqual([expect.objectContaining({ agent: ENG })]);
    expect((got.body.results as ScoreResult[]).map((r) => r.scorer).sort()).toEqual([
      'human-touches',
      'review-rounds',
    ]);
    // The catalog names each scorer's threshold and what to change.
    expect(got.body.scorers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'review-rounds', pass: 1, lever: expect.any(String) }),
      ]),
    );
    const history = await call('GET', `/api/scores/history?agent=${ENG}&tz=-60`);
    expect(history.status).toBe(200);
    expect(history.body.bucket).toBe('day');
    const series = history.body.series as Array<{
      agent: string;
      scorer: string;
      points: unknown[];
    }>;
    expect(series.map((s) => s.scorer).sort()).toEqual(['human-touches', 'review-rounds']);
    expect(series.every((s) => s.agent === ENG && s.points.length === 1)).toBe(true);
    expect((await call('GET', '/api/scores/history?since=soon')).status).toBe(400);
    expect((await call('GET', '/api/scores/history?tz=x')).status).toBe(400);
    const backwards = 'since=2026-11-09T00:00:00Z&until=2026-11-08T00:00:00Z';
    expect((await call('GET', `/api/scores/history?${backwards}`)).status).toBe(400);
    const refreshed = await call('POST', '/api/scores/refresh');
    expect((refreshed.body.scores as ScoreResult[]).length).toBe(2);
    expect((await call('GET', '/api/scores?since=soon')).status).toBe(400);
    expect(existsSync(join(state, 'state.db'))).toBe(true);
  });

  it("serves a task's scores with the orientation of its runs, for the task panel", async () => {
    const { repo, as } = store();
    as(REV).verdict('1', 'approve', 'good');
    const config = join(temp(), 'config.yml');
    writeFileSync(config, 'me: human:dawid\nswarmupd:\n  sync: false\n');
    const state = temp();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SWARMUP_CONFIG: config,
      SWARMUP_STATE_DIR: state,
    };
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
    sups.push(sup);
    // A writing run on the task: two reads, then its first edit.
    const log = join(temp(), 'run.log');
    const line = (content: unknown[], type = 'assistant') =>
      JSON.stringify({ type, message: { content } });
    writeFileSync(
      log,
      [
        line([{ type: 'tool_use', name: 'Read' }]),
        line([{ type: 'tool_result', content: 'abc' }], 'user'),
        line([{ type: 'tool_use', name: 'Grep' }]),
        line([{ type: 'tool_result', content: 'd' }], 'user'),
        line([{ type: 'tool_use', name: 'Edit' }]),
      ].join('\n'),
    );
    const now = Date.now();
    sup.store.save(
      run('01JTASKRUN00000000000000AA', ENG, 0, {
        task: 'T-0001',
        root: 'test',
        log,
        started_at: new Date(now - 20 * MIN).toISOString(),
        ended_at: new Date(now - 10 * MIN).toISOString(),
      }),
    );
    const api = await startApi(sup, { port: 0, token: 'scores-token', version: 't', build: '1' });
    const res = await fetch(`http://127.0.0.1:${api.port}/api/scores?task=test/T-0001`, {
      headers: { authorization: 'Bearer scores-token' },
    });
    const body = (await res.json()) as { results: ScoreResult[]; scorers: unknown[] };
    expect(body.results.map((r) => r.scorer).sort()).toEqual([
      'human-touches',
      'orientation',
      'review-rounds',
    ]);
    expect(body.results.find((r) => r.scorer === 'orientation')).toMatchObject({
      subject: '01JTASKRUN00000000000000AA',
      value: 2,
      pass: true,
      extra: { share: 1 },
    });
    expect(body.scorers.length).toBeGreaterThan(0);
  });
});
