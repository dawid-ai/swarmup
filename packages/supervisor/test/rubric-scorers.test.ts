// Rubric scorers in git (W5 phase 5): the judge scores a sample of closed tasks against a store's
// rubric under a daily token cap, blind by default, on a machine that turns them on.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { JudgeConfig, RubricScorerHost, RunRecord, ScoreResult } from '../src/index.js';
import {
  checkJudge,
  DEFAULT_JUDGE,
  estimateJudgeTokens,
  judgeTexts,
  runRubricScorers,
  sampled,
  ScoreKeeper,
  StateDb,
  summarizeScores,
} from '../src/index.js';
import { claudeResult, fakeRunner, RUBRIC_TEXT } from './judge-fake.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-rubric-'));
  dirs.push(d);
  return d;
};

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const NOW = Date.parse('2026-11-23T12:00:00.000Z');

/** Claude's output with a usage line, so the judgment reports its tokens. */
function answerWithUsage(): string {
  const events = JSON.parse(
    claudeResult({ scores: { readability: 4, tests: 2 }, total: 3, reasons: 'Clear; few tests.' }),
  ) as Array<Record<string, unknown>>;
  const result = events.find((e) => e.type === 'result')!;
  result.usage = { input_tokens: 900, output_tokens: 100 };
  return JSON.stringify(events);
}

/**
 * A store with a rubric scorer, and task T-0001 that claude:engineer did: its run started at the
 * base commit and its review names the work's commit. The task's text names the agent.
 */
function project(
  scorer = 'kind: rubric\nrubric: quality\npass: 0.5\napplies_to: {roles: [engineer]}\n',
  swarm = 'swarmup_defs: 1\n',
) {
  const repo = temp();
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: repo,
      windowsHide: true,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'main');
  const store = initRoot(repo, { name: 'test', human: 'human:dawid' });
  put(store, 'swarm.yaml', swarm);
  put(store, 'rubrics/quality.md', RUBRIC_TEXT);
  put(store, 'scorers/quality.yaml', scorer);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  put(repo, 'src/greet.txt', 'hello from the work\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'work');
  const work = git('rev-parse', 'HEAD').trim();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SWARMUP_CONFIG: join(repo, 'no-user-config.yml'),
  };
  delete env.SWARMUP_ROOTS;
  const as = (actor: string): Workspace => new Workspace({ cwd: repo, env, actor });
  as('human:dawid').newTask({
    title: 'Greet',
    body: 'claude:engineer adds a greeting.',
    owner: 'claude:engineer',
  });
  as('claude:engineer').start('T-0001', 'plan');
  as('claude:engineer').review('T-0001', 'Done.', 'human:dawid', undefined, {
    source: { commit: work },
  });
  as('human:dawid').verdict('T-0001', 'approve', 'Good.');
  const runs = [
    {
      id: 'R1',
      agent: 'claude:engineer',
      task: 'T-0001',
      root: 'test',
      base,
      status: 'ended',
      started_at: '2026-11-23T09:00:00.000Z',
    } as RunRecord,
  ];
  const db = new StateDb(temp());
  const answer = { text: answerWithUsage() };
  const fake = fakeRunner(() => answer.text);
  const host = (
    judge: Partial<JudgeConfig> = {},
    more: Partial<RubricScorerHost> = {},
  ): RubricScorerHost => ({
    now: () => NOW,
    ws: () => as('human:dawid'),
    runs: () => runs,
    judge: () => ({ ...DEFAULT_JUDGE, scorers: true, ...judge }),
    runtimes: () => ({ claude: { command: 'claude' }, codex: { command: 'codex' } }),
    merging: () => ['test'],
    machine: () => 'pc-1',
    settings: () => ({}),
    db,
    repos: () => [repo],
    env: () => env,
    held: () => null,
    runner: fake.runner,
    warn: () => {},
    ...more,
  });
  return { repo, store, db, fake, answer, host, as };
}

describe('rubric scorers', () => {
  it('judges a closed task blind, once, and keeps the score row with its tokens', async () => {
    const p = project();
    expect(p.as('human:dawid').view('T-0001').status).toBe('done');
    expect(await runRubricScorers(p.host())).toBe(1);
    const prompt = p.fake.calls[0]!.input;
    expect(prompt).toContain('hello from the work');
    expect(prompt).not.toContain('claude:engineer');
    expect(prompt).toContain('an agent adds a greeting.');
    const [row] = p.db.rubricResults<ScoreResult>();
    expect(row).toMatchObject({
      scorer: 'quality',
      level: 'task',
      subject: 'test/T-0001',
      agent: 'claude:engineer',
      value: 0.75,
      unit: 'ratio',
      pass: true,
      rubric: { id: 'quality', pass: 0.5 },
      extra: { readability: 4, tests: 2 },
    });
    expect(p.db.judgeTokensSince('2026-11-23T00:00:00.000Z', 'test')).toBe(1000);
    // Judged once: a second pass has nothing left.
    expect(await runRubricScorers(p.host())).toBe(0);
    expect(p.fake.calls).toHaveLength(1);
    const summary = summarizeScores([row!]);
    expect(summary[0]!.scorers.map((l) => [l.scorer, l.mean, l.pass, l.passed])).toEqual([
      ['quality', 0.75, 0.5, 1],
    ]);
    // The score keeper keeps the rubric rows with the built-in scorers' rows.
    const keeper = new ScoreKeeper(null, { extra: () => p.db.rubricResults<ScoreResult>() });
    const kept = await keeper.refresh(p.as('human:dawid'), []);
    expect(kept.filter((r) => r.scorer === 'quality')).toEqual([row]);
  });

  it('names the agent when the scorer is not blind', async () => {
    const p = project('kind: rubric\nrubric: quality\nblind: false\n');
    expect(await runRubricScorers(p.host())).toBe(1);
    expect(p.fake.calls[0]!.input).toContain('Done by: claude:engineer');
  });

  it('runs only where the machine turns it on, within the cap, the sample and the scope', async () => {
    const off = project();
    expect(await runRubricScorers(off.host({ scorers: false }))).toBe(0);
    // The machine may lower the store's cap; a cap below one judgment judges nothing.
    expect(await runRubricScorers(off.host({ daily_tokens: 10 }))).toBe(0);
    expect(off.fake.calls).toHaveLength(0);

    const capped = project(undefined, 'swarmup_defs: 1\nscoring: {daily_judge_tokens: 10}\n');
    expect(await runRubricScorers(capped.host())).toBe(0);

    const unsampled = project('kind: rubric\nrubric: quality\nsample: 0\n');
    expect(await runRubricScorers(unsampled.host())).toBe(0);

    const other = project('kind: rubric\nrubric: quality\napplies_to: {roles: [qa]}\n');
    expect(await runRubricScorers(other.host())).toBe(0);

    const unlisted = project(undefined, 'swarmup_defs: 1\nscoring: {scorers: [other]}\n');
    expect(await runRubricScorers(unlisted.host())).toBe(0);
    expect([capped, unsampled, other, unlisted].reduce((n, x) => n + x.fake.calls.length, 0)).toBe(
      0,
    );
  });
});

describe('one machine per store, retries and aborts', () => {
  it('judges only the roots this machine merges or names, and the scoring.runs_on machine', async () => {
    const p = project();
    expect(await runRubricScorers(p.host({ scorers: ['other'] }))).toBe(0);
    expect(await runRubricScorers(p.host({ scorers: true }, { merging: () => [] }))).toBe(0);
    const elsewhere = project(undefined, 'swarmup_defs: 1\nscoring: {runs_on: [pc-2]}\n');
    expect(await runRubricScorers(elsewhere.host())).toBe(0);
    expect(p.fake.calls.length + elsewhere.fake.calls.length).toBe(0);
    const here = project(undefined, 'swarmup_defs: 1\nscoring: {runs_on: [PC-1]}\n');
    expect(await runRubricScorers(here.host({ scorers: ['test'] }, { merging: () => [] }))).toBe(1);
  });

  it('tries a failed judgment again after 6 hours, counting the tokens of each try', async () => {
    const p = project();
    p.answer.text = 'no json here';
    expect(await runRubricScorers(p.host())).toBe(1);
    expect(p.db.rubricResults()).toEqual([]);
    const failedTokens = p.db.judgeTokensSince('2026-11-23T00:00:00.000Z');
    expect(failedTokens).toBeGreaterThan(2000);
    // Not before the backoff ends.
    expect(await runRubricScorers(p.host({}, { now: () => NOW + 3_600_000 }))).toBe(0);
    p.answer.text = answerWithUsage();
    expect(await runRubricScorers(p.host({}, { now: () => NOW + 7 * 3_600_000 }))).toBe(1);
    expect(p.db.rubricResults()).toHaveLength(1);
    expect(p.db.judgeTokensSince('2026-11-23T00:00:00.000Z')).toBe(failedTokens + 1000);
  });

  it('keeps nothing of a judgment swarmupd stopped', async () => {
    const p = project();
    const stop = new AbortController();
    stop.abort();
    p.answer.text = 'no json here';
    expect(await runRubricScorers(p.host({}, { signal: stop.signal }))).toBe(0);
    expect(p.db.judgedPairs().size).toBe(0);
    expect(p.db.judgeTokensSince('2026-11-23T00:00:00.000Z')).toBe(0);
  });
});

describe('rubric scorer helpers', () => {
  it('samples by sha256(id + ref), and estimates tokens from the prompt', () => {
    expect(sampled('quality', 'test/T-0001', 1)).toBe(true);
    expect(sampled('quality', 'test/T-0001', 0)).toBe(false);
    // On the high side: 3 characters a token, and room for the answer.
    expect(estimateJudgeTokens('x'.repeat(3000))).toBe(3000);
  });

  it('hides every agent id of the runtimes when blind', () => {
    const t = judgeTexts(
      {
        title: 'Fix',
        body: 'codex:reviewer asked claude:engineer for tests; Claude wrote them in claude-engineer/.',
      },
      '+// by claude:engineer, see CODEX notes\n',
      'claude:engineer',
      { blind: true, runtimes: ['claude', 'codex'] },
    );
    expect(t.task).toBe(
      '# Fix\n\nan agent asked an agent for tests; a runtime wrote them in an agent/.',
    );
    expect(t.diff).toBe('+// by an agent, see a runtime notes\n');
  });

  it('takes scorers and daily_tokens in swarmupd.judge', () => {
    expect(checkJudge({ scorers: true, daily_tokens: 5000 })).toMatchObject({
      scorers: true,
      daily_tokens: 5000,
    });
    expect(checkJudge(undefined).scorers).toBe(false);
    expect(checkJudge({ scorers: ['site'] }).scorers).toEqual(['site']);
    expect(() => checkJudge({ scorers: 'yes' })).toThrow(/swarmupd.judge.scorers/);
    expect(() => checkJudge({ daily_tokens: -1 })).toThrow(/swarmupd.judge.daily_tokens/);
  });
});
