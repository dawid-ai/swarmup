// The LLM judge of rubric criteria (W7) with a fake runner: the command line, one judgment and its
// failures, a task's judgment against its branch diff, and the `criteria-check` event by the judge.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Rubric } from '@swarmup/core';
import { initRoot, parseRubric, Workspace } from '@swarmup/core';
import type { JudgeConfig, JudgeRunner } from '@swarmup/supervisor';
import { claudeResult, fakeRunner, RUBRIC_TEXT } from './judge-fake.js';
import {
  checkJudge,
  CriteriaJudges,
  DEFAULT_JUDGE,
  defaultJudgeRunner,
  judgeCommand,
  judgeFailed,
  judgeTask,
  judgeVerdict,
  readJudgeOutput,
  runJudge,
} from '@swarmup/supervisor';

const dirs: string[] = [];
function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

const rubric = (): Rubric => parseRubric(RUBRIC_TEXT, 'quality.md');
const config = (over: Partial<JudgeConfig> = {}): JudgeConfig => ({ ...DEFAULT_JUDGE, ...over });

describe('judgeCommand', () => {
  it('runs Claude with no tools, the model, effort and its own system prompt', () => {
    const cmd = judgeCommand(config(), '/tmp/x', { resolve: false });
    expect(cmd.file).toBe('claude');
    expect(cmd.model).toBe('sonnet');
    const a = cmd.args;
    expect(a.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(a[a.indexOf('--model') + 1]).toBe('sonnet');
    expect(a[a.indexOf('--effort') + 1]).toBe('low');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).toContain('--strict-mcp-config');
    expect(a).toContain('--no-session-persistence');
    expect(a).not.toContain('--allowedTools');
    expect(a).not.toContain('acceptEdits');
    const system = a[a.indexOf('--system-prompt') + 1]!;
    expect(system).not.toMatch(/["%!]/);
  });

  it('runs Codex read-only in the empty folder, and only takes command and unset_env from the machine', () => {
    const cmd = judgeCommand(config({ runtime: 'codex', model: 'gpt-5' }), '/tmp/x', {
      resolve: false,
      runtimes: {
        codex: { command: 'my-codex', args: ['--dangerous'], unset_env: ['OPENAI_ORG'] },
      },
    });
    expect(cmd.file).toBe('my-codex');
    expect(cmd.unsetEnv).toEqual(['OPENAI_ORG']);
    expect(cmd.args).not.toContain('--dangerous');
    expect(cmd.args.join(' ')).toBe(
      'exec -m gpt-5 -c model_reasoning_effort=low --json --sandbox read-only --skip-git-repo-check -C /tmp/x -',
    );
  });

  it('refuses another runtime', () => {
    expect(() => judgeCommand(config({ runtime: 'gemini' }), '/x', { resolve: false })).toThrow(
      /claude or codex/,
    );
  });
});

describe('defaultJudgeRunner', () => {
  it('writes the prompt to stdin and keeps what the judge prints', async () => {
    const cwd = scratch('judge-run-');
    const out = await defaultJudgeRunner({
      file: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd,
      env: process.env,
      input: 'the prompt',
      timeoutMs: 30_000,
    });
    expect(out).toMatchObject({ exitCode: 0, timedOut: false, stdout: 'the prompt' });
  });

  it('stops a judge that runs past its budget', async () => {
    const cwd = scratch('judge-run-');
    const out = await defaultJudgeRunner({
      file: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 60000)'],
      cwd,
      env: process.env,
      input: '',
      timeoutMs: 500,
    });
    expect(out.timedOut).toBe(true);
  });
});

describe('checkJudge', () => {
  it('fills in defaults and refuses bad values', () => {
    expect(checkJudge(undefined)).toEqual(DEFAULT_JUDGE);
    expect(checkJudge({ model: 'opus', budget_min: 2, at_merge: true })).toMatchObject({
      runtime: 'claude',
      model: 'opus',
      effort: 'low',
      budget_min: 2,
      at_merge: true,
    });
    expect(() => checkJudge({ runtime: 'gemini' })).toThrow(/claude or codex/);
    expect(() => checkJudge({ budget_min: 0 })).toThrow(/budget_min/);
    expect(() => checkJudge({ at_merge: 'yes' })).toThrow(/at_merge/);
    expect(() => checkJudge({ judge_model: 'x' })).toThrow(/unknown key judge_model/);
    expect(() => checkJudge({ model: '--evil' })).toThrow(/swarmupd.judge.model/);
  });
});

describe('readJudgeOutput', () => {
  it('reads Claude results and Codex agent messages', () => {
    expect(readJudgeOutput('claude', claudeResult('{"scores":{}}', 0.5))).toEqual({
      text: '{"scores":{}}',
      costUsd: 0.5,
      model: 'claude-sonnet-4-6',
    });
    // An older build's single result object: the model that cost the most answered.
    const single = JSON.stringify({
      type: 'result',
      result: 'ok',
      total_cost_usd: 0.2,
      modelUsage: { 'claude-haiku-4-5': { costUSD: 0.01 }, 'claude-opus-4-6': { costUSD: 0.19 } },
    });
    expect(
      readJudgeOutput(
        'claude',
        `noise
${single}
`,
      ),
    ).toEqual({
      text: 'ok',
      costUsd: 0.2,
      model: 'claude-opus-4-6',
    });
    const codex = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"scores\\":{}}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":5}}',
    ].join('\n');
    expect(readJudgeOutput('codex', codex)).toEqual({
      text: '{"scores":{}}',
      costUsd: null,
      model: null,
    });
  });
});

describe('runJudge', () => {
  const inputs = { task: '# Do it', diff: 'diff --git a/a b/a\n+x\n' };

  it('passes at or above the pass mark, with the prompt on stdin and the budget as the timeout', async () => {
    const env = { ...process.env, SWARMUP_AGENT: 'claude:engineer', CLAUDECODE: '1' };
    const { runner, calls } = fakeRunner(() =>
      claudeResult({ scores: { readability: 3, tests: 2 }, total: 9, reasons: 'Clear; one test.' }),
    );
    const r = await runJudge(rubric(), inputs, 0.6, {
      config: config({ budget_min: 2 }),
      runner,
      env,
    });
    expect(judgeFailed(r)).toBe(false);
    if (judgeFailed(r)) return;
    expect(r).toMatchObject({
      result: 'pass',
      pass: 0.6,
      scores: { readability: 3, tests: 2 },
      total: 2.5,
      modelTotal: 9,
      reasons: 'Clear; one test.',
      costUsd: 0.0123,
      model: 'claude-sonnet-4-6',
      runtime: 'claude',
      rubric: 'quality',
    });
    expect(r.score).toBeCloseTo(0.625);
    const call = calls[0]!;
    expect(call.input).toContain('# Rubric: quality');
    expect(call.input).toContain('+x');
    expect(call.timeoutMs).toBe(120_000);
    expect(call.env.SWARMUP_AGENT).toBeUndefined();
    expect(call.env.CLAUDECODE).toBeUndefined();
    // It ran in an empty folder of its own, removed after.
    expect(existsSync(call.cwd)).toBe(false);
  });

  it('fails below the pass mark', async () => {
    const { runner } = fakeRunner(() => claudeResult({ scores: { readability: 1, tests: 0 } }));
    const r = await runJudge(rubric(), inputs, 0.6, { config: config(), runner });
    expect(!judgeFailed(r) && r.result).toBe('fail');
  });

  it('reports a timeout, a bad answer and a failed exit, keeping the cost', async () => {
    const timeout: JudgeRunner = async () => ({
      exitCode: null,
      timedOut: true,
      stdout: '',
      stderr: '',
    });
    const t = await runJudge(rubric(), inputs, 0.5, { config: config(), runner: timeout });
    expect(judgeFailed(t) && t.error).toBe('timed out after 5 min');

    const { runner: chatty } = fakeRunner(() => claudeResult('It looks fine to me.', 0.02));
    const b = await runJudge(rubric(), inputs, 0.5, { config: config(), runner: chatty });
    expect(judgeFailed(b) && b.error).toMatch(/no JSON object/);
    expect(b.costUsd).toBe(0.02);

    const { runner: wild } = fakeRunner(() =>
      claudeResult({ scores: { readability: 9, tests: 1 } }),
    );
    const w = await runJudge(rubric(), inputs, 0.5, { config: config(), runner: wild });
    expect(judgeFailed(w) && w.error).toMatch(/outside the scale/);

    const exit: JudgeRunner = async () => ({
      exitCode: 1,
      timedOut: false,
      stdout: '',
      stderr: 'Not logged in\n',
    });
    const e = await runJudge(rubric(), inputs, 0.5, { config: config(), runner: exit });
    expect(judgeFailed(e) && e.error).toBe('the judge exited with 1: Not logged in');
  });

  it('reads a Claude error result as a failure', async () => {
    const { runner } = fakeRunner(
      () =>
        `${JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Credit balance too low' })}\n`,
    );
    const r = await runJudge(rubric(), inputs, 0.5, { config: config(), runner });
    expect(judgeFailed(r) && r.error).toBe('Credit balance too low');
  });
});

describe('judgeVerdict', () => {
  it('gives the score, the reasons as the note and the scores as evidence', () => {
    const v = judgeVerdict({
      result: 'fail',
      score: 0.4375,
      pass: 0.7,
      scores: { readability: 3, tests: 0.5 },
      total: 1.75,
      scale: { min: 0, max: 4 },
      reasons: 'No tests.',
      rubric: 'quality',
      runtime: 'claude',
      model: 'claude-sonnet-4-6',
      costUsd: 0.0123,
      wallMs: 10,
    });
    expect(v).toMatchObject({ result: 'fail', score: 0.438, note: 'No tests.' });
    expect(v.evidence).toContain('quality: readability 3, tests 0.5 (scale 0 to 4)');
    expect(v.evidence).toContain('total 1.75 of 4 = 0.438; passes at 0.7');
    expect(v.evidence).toContain('judge: claude, claude-sonnet-4-6, $0.0123');
    const failed = judgeVerdict({
      error: 'timed out after 5 min',
      rubric: 'quality',
      runtime: 'claude',
      model: 'sonnet',
      costUsd: null,
      wallMs: 1,
    });
    expect(failed).toMatchObject({ result: 'na', note: 'the judge failed: timed out after 5 min' });
  });
});

/** A repo with a task store, the rubric on main, and task 1 with a rubric criterion. */
function taskRepo() {
  const repo = scratch('judge-task-');
  git(repo, 'init', '-q', '-b', 'main');
  appendFileSync(
    join(repo, '.git', 'config'),
    '[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n',
  );
  const rootDir = initRoot(repo, { name: 'test', human: 'human:dawid' });
  const env = { SWARMUP_CONFIG: join(repo, 'none.yml') } as NodeJS.ProcessEnv;
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor });
  as('human:dawid').newTask({
    title: 'Add a greeting',
    body: 'Print hello.',
    doneWhen: [
      { id: 'q', kind: 'rubric', rubric: 'rubrics/quality.md', pass: 0.6 },
      { id: 'tests', kind: 'command', run: 'node -e 0' },
    ],
  });
  mkdirSync(join(repo, 'rubrics'));
  writeFileSync(join(repo, 'rubrics', 'quality.md'), RUBRIC_TEXT);
  writeFileSync(join(repo, 'app.js'), 'console.log(1);\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'app.js'), "console.log('hello');\n");
  // The work also tries to soften its own rubric: the judge reads the one at the merge base.
  writeFileSync(
    join(repo, 'rubrics', 'quality.md'),
    RUBRIC_TEXT.replace('Has tests.', 'Anything goes.'),
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'greet');
  return { repo, rootDir, as };
}

describe('judgeTask', () => {
  it('judges the rubric criteria against the branch diff, with the rubric at the merge base', async () => {
    const { repo, rootDir, as } = taskRepo();
    const v = as('human:dawid').view('1');
    const { runner, calls } = fakeRunner(() =>
      claudeResult({ scores: { readability: 4, tests: 1 }, reasons: 'Readable, no test.' }),
    );
    const j = await judgeTask({
      criteria: v.criteria ?? [],
      cwd: repo,
      base: 'main',
      storeDir: rootDir,
      task: '# Add a greeting\n\nPrint hello.',
      config: config(),
      runner,
    });
    // Only the rubric criterion is judged.
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.input;
    // The rubric part of the prompt; the diff after it shows the change to the file as data.
    const rubricPart = prompt.slice(0, prompt.indexOf('# The task'));
    expect(rubricPart).toContain('Has tests.');
    expect(rubricPart).not.toContain('Anything goes.');
    expect(prompt).toContain("+console.log('hello');");
    expect(prompt).toContain('## `app.js`');
    expect(prompt).toContain('Print hello.');
    expect(j.results).toEqual({
      q: expect.objectContaining({ result: 'pass', score: 0.625, note: 'Readable, no test.' }),
    });
    expect(j.failed).toEqual([]);
    expect(j.costUsd).toBeCloseTo(0.0123);
    expect(j.mergeBase).toBe(git(repo, 'rev-parse', 'main').trim());
  });

  it('records the results as a criteria-check event by the judge', async () => {
    const { repo, rootDir, as } = taskRepo();
    const h = as('human:dawid');
    const { runner } = fakeRunner(() => claudeResult({ scores: { readability: 1, tests: 0 } }));
    const j = await judgeTask({
      criteria: h.view('1').criteria ?? [],
      cwd: repo,
      base: 'main',
      storeDir: rootDir,
      task: 't',
      config: config(),
      runner,
    });
    expect(j.failed).toEqual(['q']);
    h.recordCriteriaCheck('1', j.results, 'Judged.', 'judge');
    const e = h.showEvents('1').events.at(-1)!;
    expect(e).toMatchObject({
      type: 'criteria-check',
      by: 'judge',
      criteria: { q: { result: 'fail' } },
    });
    expect(h.view('1').criteriaResults?.q).toMatchObject({
      result: 'fail',
      score: 0.125,
      type: 'criteria-check',
      by: 'judge',
    });
  });

  it('fails a criterion whose rubric is nowhere, without running the judge', async () => {
    const { repo, as } = taskRepo();
    const h = as('human:dawid');
    h.setCriteria('1', [{ id: 'q', kind: 'rubric', rubric: 'rubrics/missing.md' }]);
    const { runner, calls } = fakeRunner(() => '');
    const j = await judgeTask({
      criteria: h.view('1').criteria ?? [],
      cwd: repo,
      base: 'main',
      task: 't',
      config: config(),
      runner,
    });
    expect(calls).toHaveLength(0);
    expect(j.errors.q).toMatch(/no rubric rubrics\/missing.md/);
    expect(j.results).toEqual({});
  });
});

describe('CriteriaJudges', () => {
  it('keeps each result as it lands and records those that gave a score', async () => {
    const recorded: Array<{ task: string; by: string; message: string }> = [];
    const judges = new CriteriaJudges({
      judge: async (_job, criteria, on) => {
        on.start(criteria[0]!.id);
        const o = {
          result: 'pass' as const,
          score: 0.9,
          pass: 0.7,
          scores: { a: 4 },
          total: 3.6,
          scale: { min: 0, max: 4 },
          reasons: 'Good.',
          rubric: 'r',
          runtime: 'claude',
          model: 'm',
          costUsd: 0.01,
          wallMs: 1,
        };
        on.result(criteria[0]!.id, o);
        return {
          outcomes: { q: o },
          results: { q: judgeVerdict(o) },
          failed: [],
          errors: {},
          costUsd: 0.01,
          mergeBase: 'abc',
          message: 'Judged 1.',
        };
      },
      record: (task, by, _results, message) => {
        recorded.push({ task, by, message });
        return 'E1';
      },
    });
    expect(() =>
      judges.start('test/1', 'human:dawid', '/x', [{ id: 'c', kind: 'command', run: 'x' }]),
    ).toThrow(/no rubric criteria/);
    const { job, done } = judges.start('test/1', 'human:dawid', '/x', [
      { id: 'q', kind: 'rubric', rubric: 'r.md' },
    ]);
    expect(job.ids).toEqual(['q']);
    await done;
    expect(judges.get('test/1')).toMatchObject({
      event: 'E1',
      costUsd: 0.01,
      results: { q: { result: 'pass', score: 0.9 } },
    });
    expect(recorded).toEqual([{ task: 'test/1', by: 'human:dawid', message: 'Judged 1.' }]);
  });
});
