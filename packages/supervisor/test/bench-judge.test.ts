// Benchmarks with the rubric judge (W7): `--judge` fills rubric criteria during a run, and
// `judgeBenchRun` (`swarmup bench judge`) fills them afterwards; the summary counts them.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBenchSet } from '@swarmup/core';
import type { AttemptResult, BenchSummary, JudgeProcess } from '@swarmup/supervisor';
import {
  DEFAULT_JUDGE,
  judgeBenchRun,
  overallOf,
  runBench,
  scoreAttempt,
  summarizeEntries,
  summaryMarkdown,
} from '@swarmup/supervisor';
import { claudeResult, fakeRunner, RUBRIC_TEXT } from './judge-fake.js';

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
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** A repo on main with `app.js`, a set beside a rubric, and a reference patch for E-1. */
function world() {
  const repo = scratch('bench-judge-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'app.js'), 'console.log(1);\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const work = scratch('bench-judge-work-');
  writeFileSync(join(work, 'quality.md'), RUBRIC_TEXT);
  const refs = join(work, 'refs');
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(refs)})`]);
  writeFileSync(
    join(refs, 'E-1.patch'),
    [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1 +1 @@',
      '-console.log(1);',
      "+console.log('hello');",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(work, 'demo.yaml'),
    [
      'id: demo',
      'entries:',
      '  - id: E-1',
      '    base: { ref: main }',
      '    task: { type: feature, title: Greet, body: Print hello. }',
      '    done_when:',
      '      - { id: file, kind: check, check: file-exists, args: { path: app.js } }',
      '      - { id: q, kind: rubric, rubric: quality.md, pass: 0.6 }',
      "      - { id: ask, kind: human, ask: 'Is it friendly?' }",
      '',
    ].join('\n'),
  );
  const set = readBenchSet(join(work, 'demo.yaml'));
  return { repo, work, refs, set };
}

/** Scores 4 and 4 when the prompt shows the hello change, else 0 and 1. */
function judgeOfChange() {
  return fakeRunner((p: JudgeProcess) =>
    claudeResult(
      p.input.includes("+console.log('hello');")
        ? { scores: { readability: 4, tests: 4 }, reasons: 'Says hello.' }
        : { scores: { readability: 0, tests: 1 }, reasons: 'No change.' },
      0.01,
    ),
  );
}

const judgeCfg = { ...DEFAULT_JUDGE };

describe('bench run --judge', () => {
  it('judges rubric criteria after the checks and counts them in the pass rate', async () => {
    const { repo, work, refs, set } = world();
    const { runner, calls } = judgeOfChange();
    const out = join(work, 'out');
    const logs: string[] = [];
    const summary = (await runBench({
      set,
      repo,
      out,
      referenceDir: refs,
      judge: { config: judgeCfg, runner },
      log: (l) => logs.push(l),
    }))!;
    expect(calls).toHaveLength(1);
    // The judge saw the task, the diff and the changed file after the change.
    expect(calls[0]!.input).toContain('Print hello.');
    expect(calls[0]!.input).toContain('## `app.js`');
    const r = JSON.parse(
      readFileSync(join(out, 'E-1', '1', 'results.json'), 'utf8'),
    ) as AttemptResult;
    expect(r.criteria.find((c) => c.id === 'q')).toMatchObject({
      result: 'pass',
      score: 1,
      rubric: 'quality.md',
      pass: 0.6,
      note: 'Says hello.',
    });
    // A human criterion stays pending.
    expect(r.criteria.find((c) => c.id === 'ask')?.result).toBe('pending');
    expect(r.score).toMatchObject({ checkable: 2, passed: 2, passRate: 1, pending: 1, judged: 1 });
    expect(r.judge).toMatchObject({ runtime: 'claude', model: 'claude-sonnet-4-6', costUsd: 0.01 });
    expect(summary.setFile).toBe(set.file);
    expect(summary.judge).toMatchObject({ runtime: 'claude', model: 'claude-sonnet-4-6' });
    expect(summary.entries[0]).toMatchObject({ judged: 1, judgeCostUsd: 0.01, pending: 1 });
    expect(summary.overall).toMatchObject({ judged: 1, judgeCostUsd: 0.01, passRate: 1 });
    const md = readFileSync(join(out, 'summary.md'), 'utf8');
    expect(md).toContain('| Judged |');
    expect(md).toContain('| E-1 | 1 | 100% | - | 1 | 1 | - | $0.01 |');
    expect(logs.some((l) => l.includes('judge: claude, sonnet, low, 5 min'))).toBe(true);
    expect(logs.some((l) => l.includes('1 judged'))).toBe(true);
  });

  it('leaves a criterion pending when the judge gives no score', async () => {
    const { repo, work, set } = world();
    const { runner } = fakeRunner(() => claudeResult('no idea'));
    const out = join(work, 'out');
    await runBench({
      set,
      repo,
      out,
      agent: 'none',
      judge: { config: judgeCfg, runner },
      log: () => {},
    });
    const r = JSON.parse(
      readFileSync(join(out, 'E-1', '1', 'results.json'), 'utf8'),
    ) as AttemptResult;
    expect(r.criteria.find((c) => c.id === 'q')).toMatchObject({
      result: 'pending',
      note: expect.stringMatching(/^the judge failed: the judge gave no JSON/),
    });
    expect(r.score).toMatchObject({ checkable: 1, pending: 2, judged: 0 });
  });
});

describe('judgeBenchRun', () => {
  it('fills the pending rubric criteria of a finished run and writes the summary again', async () => {
    const { repo, work, refs, set } = world();
    const out = join(work, 'out');
    const before = (await runBench({ set, repo, out, referenceDir: refs, log: () => {} }))!;
    expect(before.entries[0]).toMatchObject({ pending: 2, judged: 0 });
    // The worktree is gone: the judge gets a temporary one with the diff applied.
    expect(existsSync(join(out, 'E-1', '1', 'worktree'))).toBe(false);
    const { runner, calls } = judgeOfChange();
    const logs: string[] = [];
    const after = await judgeBenchRun({
      out,
      judge: { config: judgeCfg, runner },
      log: (l) => logs.push(l),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toContain("## `app.js`\n\n```\nconsole.log('hello');");
    expect(after.entries[0]).toMatchObject({
      pending: 1,
      judged: 1,
      judgeCostUsd: 0.01,
      passRate: 1,
    });
    expect(after.overall.judgeCostUsd).toBe(0.01);
    const saved = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as BenchSummary;
    expect(saved.entries[0]?.judged).toBe(1);
    expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('- Judge: claude');
    // The temporary worktree is gone again.
    expect(git(repo, 'worktree', 'list')).not.toContain('swarmup-judge-wt-');
    expect(logs.some((l) => l.includes('E-1 #1: q pass 1'))).toBe(true);

    // Nothing pending: a second judge spends nothing, unless asked again.
    const again = judgeOfChange();
    await judgeBenchRun({ out, judge: { config: judgeCfg, runner: again.runner }, log: () => {} });
    expect(again.calls).toHaveLength(0);
    await judgeBenchRun({
      out,
      judge: { config: judgeCfg, runner: again.runner },
      again: true,
      log: () => {},
    });
    expect(again.calls).toHaveLength(1);
    const r = JSON.parse(
      readFileSync(join(out, 'E-1', '1', 'results.json'), 'utf8'),
    ) as AttemptResult;
    expect(r.judge?.costUsd).toBeCloseTo(0.02);
  });

  it('scores the unchanged base low', async () => {
    const { repo, work, set } = world();
    const out = join(work, 'out');
    await runBench({ set, repo, out, agent: 'none', log: () => {} });
    const { runner, calls } = judgeOfChange();
    const s = await judgeBenchRun({ out, set, judge: { config: judgeCfg, runner }, log: () => {} });
    expect(calls[0]!.input).toContain('(no change: the diff is empty)');
    expect(s.entries[0]?.passRate).toBe(0.5);
    const r = JSON.parse(
      readFileSync(join(out, 'E-1', '1', 'results.json'), 'utf8'),
    ) as AttemptResult;
    expect(r.criteria.find((c) => c.id === 'q')).toMatchObject({ result: 'fail', score: 0.125 });
  });

  it('refuses a run whose summary names no set file without --set', async () => {
    const out = scratch('bench-judge-old-');
    writeFileSync(
      join(out, 'summary.json'),
      JSON.stringify({ set: 'demo', repo: out, entries: [], overall: {} }),
    );
    await expect(
      judgeBenchRun({ out, judge: { config: judgeCfg }, log: () => {} }),
    ).rejects.toThrow(/names no set file; pass --set/);
  });
});

describe('summary math with judged rubric criteria', () => {
  it('counts judged rubric results in the pass rate and sums judge cost over attempts', () => {
    const attempt = (
      n: number,
      q: 'pass' | 'fail' | 'pending',
      cost: number | null,
    ): AttemptResult => {
      const criteria = [
        { id: 'c', kind: 'command', what: 'x', result: 'pass' as const },
        { id: 'q', kind: 'rubric', what: 'r', result: q },
      ];
      return {
        set: 's',
        entry: 'E',
        attempt: n,
        mode: 'agent',
        agent: 'claude:engineer',
        base: { ref: 'main', sha: 'abc' },
        startedAt: '',
        run: { exitCode: 0, timedOut: false, wallMs: 1000 },
        metrics: {
          costUsd: 1,
          tokens: null,
          turns: null,
          toolCalls: null,
          toolCallsBeforeEdit: null,
          edited: null,
        },
        diff: { files: 0, insertions: 0, deletions: 0 },
        criteria,
        score: scoreAttempt(criteria),
        ...(cost !== null
          ? { judge: { runtime: 'claude', model: 'm', costUsd: cost, at: '' } }
          : {}),
        dir: '',
      };
    };
    const list = [attempt(1, 'pass', 0.01), attempt(2, 'fail', 0.02), attempt(3, 'pending', null)];
    expect(list.map((a) => a.score.passRate)).toEqual([1, 0.5, 1]);
    const [e] = summarizeEntries(list);
    expect(e).toMatchObject({ attempts: 3, judged: 2 });
    expect(e!.judgeCostUsd).toBeCloseTo(0.03);
    expect(e!.passRate).toBeCloseTo(2.5 / 3);
    const o = overallOf([e!]);
    expect(o).toMatchObject({ judged: 2, costUsd: 3 });
    expect(o.judgeCostUsd).toBeCloseTo(0.03);
    // An old summary without judge fields still renders.
    const md = summaryMarkdown({
      set: 's',
      mode: 'agent',
      agent: 'a',
      repo: 'r',
      out: 'o',
      startedAt: '',
      finishedAt: '',
      entries: [{ ...e!, judged: undefined, judgeCostUsd: undefined }],
      overall: { ...o, judged: undefined, judgeCostUsd: undefined },
    });
    expect(md).toMatch(/\| E \| 3 \| 83% \| - \| 0 \| 0 \| \$1\.00 \| - \|/);
  });
});
