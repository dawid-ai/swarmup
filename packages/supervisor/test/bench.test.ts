import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BenchCriterion } from '@swarmup/core';
import { parseBenchSet } from '@swarmup/core';
import type { AttemptResult, BenchSummary } from '@swarmup/supervisor';
import {
  benchCommand,
  benchCostModel,
  benchPrices,
  checkBenchPrices,
  codexConfigModel,
  compareMarkdown,
  compareSummaries,
  evaluateAttempt,
  logMetrics,
  overallOf,
  priceMetrics,
  runBench,
  scoreAttempt,
  summarizeEntries,
  summaryMarkdown,
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
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** A repo with one commit holding `README.md`. */
function repo(): { dir: string; sha: string } {
  const dir = scratch('bench-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD').trim() };
}

/** A node command line for a criterion; the script uses single quotes only. */
const nodeCmd = (js: string): string => `"${process.execPath}" -e "${js}"`;

describe('evaluateAttempt', () => {
  it('runs visible checks without the hidden files, then each hidden command with them', async () => {
    const cwd = scratch('bench-wt-');
    const hiddenDir = scratch('bench-hidden-');
    writeFileSync(join(hiddenDir, 'test_secret.py'), 'secret\n');
    mkdirSync(join(hiddenDir, '__pycache__'));
    writeFileSync(join(cwd, 'out.txt'), 'done\n');
    const seen: Array<{ command: string; hidden: boolean; pycache: boolean }> = [];
    const criteria: BenchCriterion[] = [
      { id: 'hidden1', kind: 'command', run: 'hidden-one {{base}}', hidden: true },
      { id: 'tests', kind: 'command', run: 'visible' },
      { id: 'file', kind: 'check', check: 'file-exists', args: { path: 'out.txt' } },
      { id: 'quality', kind: 'rubric', rubric: 'rubrics/q.md' },
      { id: 'ask', kind: 'human', ask: 'Does it read well?' },
      { id: 'c6', kind: 'prose', text: 'Reads well.' },
      { id: 'hidden2', kind: 'command', run: 'hidden-two', hidden: true },
    ];
    const results = await evaluateAttempt(criteria, {
      cwd,
      baseSha: 'abc123',
      hiddenDir,
      hiddenTo: 'hidden',
      runCommand: (command) => {
        seen.push({
          command,
          hidden: existsSync(join(cwd, 'hidden', 'test_secret.py')),
          pycache: existsSync(join(cwd, 'hidden', '__pycache__')),
        });
        return Promise.resolve({ ok: command !== 'hidden-two', output: 'ran' });
      },
    });
    expect(seen).toEqual([
      { command: 'visible', hidden: false, pycache: false },
      { command: 'hidden-one abc123', hidden: true, pycache: false },
      { command: 'hidden-two', hidden: true, pycache: false },
    ]);
    expect(existsSync(join(cwd, 'hidden'))).toBe(false);
    expect(results.map((r) => [r.id, r.result])).toEqual([
      ['hidden1', 'pass'],
      ['tests', 'pass'],
      ['file', 'pass'],
      ['quality', 'pending'],
      ['ask', 'pending'],
      ['c6', 'pending'],
      ['hidden2', 'fail'],
    ]);
    expect(scoreAttempt(results)).toEqual({
      checkable: 4,
      passed: 3,
      passRate: 0.75,
      hidden: { total: 2, passed: 1 },
      pending: 3,
      judged: 0,
    });
  });

  it('fails a hidden check, and keeps the folder, when the worktree already has it', async () => {
    const cwd = scratch('bench-wt-');
    const hiddenDir = scratch('bench-hidden-');
    writeFileSync(join(hiddenDir, 'test_secret.py'), 'secret\n');
    mkdirSync(join(cwd, 'hidden'));
    writeFileSync(join(cwd, 'hidden', 'mine.txt'), 'agent work\n');
    let ran = 0;
    const [r] = await evaluateAttempt([{ id: 'h', kind: 'command', run: 'x', hidden: true }], {
      cwd,
      baseSha: 'abc',
      hiddenDir,
      hiddenTo: 'hidden',
      runCommand: () => {
        ran++;
        return Promise.resolve({ ok: true, output: '' });
      },
    });
    expect(ran).toBe(0);
    expect(r).toMatchObject({ result: 'fail', hidden: true });
    expect(readFileSync(join(cwd, 'hidden', 'mine.txt'), 'utf8')).toBe('agent work\n');
  });
});

describe('benchCommand', () => {
  it('builds the Claude command line of a real run, without swarmup', () => {
    const c = benchCommand('claude:engineer', '/wt', {
      model: 'sonnet',
      effort: 'high',
      resolve: false,
    });
    expect(c.args.slice(0, 6)).toEqual([
      '-p',
      '--permission-mode',
      'acceptEdits',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(c.args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high']));
    const allowed = c.args[c.args.indexOf('--allowedTools') + 1]!.split(',');
    const denied = c.args[c.args.indexOf('--disallowedTools') + 1]!.split(',');
    expect(allowed).toEqual(expect.arrayContaining(['Edit', 'Bash(python *)', 'Bash(git *)']));
    expect(allowed).not.toContain('Bash(swarmup *)');
    expect(allowed.some((t) => t.startsWith('Bash(gh '))).toBe(false);
    expect(denied).toEqual(expect.arrayContaining(['Bash(swarmup *)', 'Bash(kill *)']));
  });

  it('builds the Codex command line of a task worktree run', () => {
    const c = benchCommand('codex:engineer', '/wt', { resolve: false });
    expect(c.args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'danger-full-access',
      '--skip-git-repo-check',
      '-C',
      '/wt',
      '-',
    ]);
  });

  it('refuses other runtimes', () => {
    expect(() => benchCommand('gemini:engineer', '/wt', { resolve: false })).toThrow(
      /claude and codex/,
    );
  });
});

describe('logMetrics', () => {
  it('reads cost, tokens and tool calls from a Claude stream-json log', () => {
    const dir = scratch('bench-log-');
    const log = join(dir, 'agent.log');
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'abc' }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', name: 'Grep' }] } },
      { type: 'assistant', message: { id: 'm3', content: [{ type: 'tool_use', name: 'Edit' }] } },
      {
        type: 'result',
        total_cost_usd: 0.42,
        num_turns: 4,
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 40,
        },
      },
    ];
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(logMetrics(log)).toEqual({
      costUsd: 0.42,
      tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      turns: 4,
      toolCalls: 3,
      toolCallsBeforeEdit: 2,
      edited: true,
    });
  });

  it('reads tokens from a Codex log, with no cost', () => {
    const dir = scratch('bench-log-');
    const log = join(dir, 'agent.log');
    const lines = [
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'x' } },
      { type: 'item.completed', item: { type: 'file_change' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5 },
      },
    ];
    writeFileSync(log, lines.map((l) => JSON.stringify(l)).join('\n'));
    expect(logMetrics(log)).toMatchObject({
      costUsd: null,
      tokens: { input: 40, output: 5, cacheRead: 60, cacheWrite: 0 },
      turns: 1,
      toolCalls: 2,
      toolCallsBeforeEdit: 1,
      edited: true,
    });
  });
});

/** A fake Claude: reads the prompt, logs stream-json, writes `done.txt`, or sleeps on `SLEEP`. */
const FAKE_AGENT = `
const fs = require('fs');
let prompt = '';
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (prompt.includes('SLEEP')) { setInterval(() => {}, 1000); return; }
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'assistant', message: { id: 'a', content: [{ type: 'tool_use', name: 'Read' }] } });
  say({ type: 'assistant', message: { id: 'b', content: [{ type: 'tool_use', name: 'Write' }] } });
  fs.writeFileSync('done.txt', prompt);
  say({ type: 'result', total_cost_usd: 0.25, num_turns: 2, usage: { input_tokens: 7, output_tokens: 3 } });
});
`;

describe('runBench', () => {
  it('runs a fake agent in a worktree, scores it and writes the results', async () => {
    const { dir: repoDir, sha } = repo();
    const work = scratch('bench-work-');
    const agentFile = join(work, 'fake-claude.cjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const hiddenDir = join(work, 'hidden-src');
    mkdirSync(hiddenDir);
    writeFileSync(join(hiddenDir, 'secret.txt'), 'hidden\n');
    const set = parseBenchSet(
      {
        id: 'demo',
        defaults: { agent: 'claude:engineer' },
        entries: [
          {
            id: 'E-1',
            base: { ref: 'main' },
            prompt: 'Write done.txt.',
            done_when: [
              { id: 'done', kind: 'check', check: 'file-exists', args: { path: 'done.txt' } },
              {
                id: 'nohidden',
                kind: 'command',
                run: nodeCmd("process.exit(require('fs').existsSync('hidden') ? 1 : 0)"),
              },
              {
                id: 'secret',
                kind: 'command',
                hidden: true,
                run: nodeCmd("process.exit(require('fs').existsSync('hidden/secret.txt') ? 0 : 1)"),
              },
              {
                id: 'changed',
                kind: 'command',
                run: 'git diff --quiet {{base}} -- README.md',
              },
              'Reads well.',
            ],
          },
        ],
      },
      join(work, 'demo.yaml'),
    );
    const out = join(work, 'out');
    const logs: string[] = [];
    const summary = await runBench({
      set,
      repo: repoDir,
      out,
      hiddenDir,
      repeat: 2,
      runtimes: { claude: { command: process.execPath, args: [agentFile] } },
      log: (l) => logs.push(l),
    });
    expect(summary).not.toBeNull();
    const r = JSON.parse(
      readFileSync(join(out, 'E-1', '2', 'results.json'), 'utf8'),
    ) as AttemptResult;
    expect(r.base).toEqual({ ref: 'main', sha });
    expect(r.run).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.run.command?.slice(1, 3)).toEqual([agentFile, '-p']);
    expect(r.metrics).toMatchObject({ costUsd: 0.25, toolCalls: 2, toolCallsBeforeEdit: 1 });
    expect(r.diff).toEqual({ files: 1, insertions: 1, deletions: 0 });
    expect(r.criteria.map((c) => [c.id, c.result])).toEqual([
      ['done', 'pass'],
      ['nohidden', 'pass'],
      ['secret', 'pass'],
      ['changed', 'pass'],
      ['c5', 'pending'],
    ]);
    expect(readFileSync(join(out, 'E-1', '1', 'diff.patch'), 'utf8')).toContain('+Write done.txt.');
    expect(existsSync(join(out, 'E-1', '1', 'worktree'))).toBe(false);
    expect(git(repoDir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
    expect(summary!.entries).toEqual([
      expect.objectContaining({
        entry: 'E-1',
        attempts: 2,
        passRate: 1,
        hiddenPass: { passed: 2, attempts: 2 },
        costUsd: 0.25,
      }),
    ]);
    expect(summary!.overall).toMatchObject({ attempts: 2, costUsd: 0.5, costPerAttempt: 0.25 });
    expect(readFileSync(join(out, 'summary.md'), 'utf8')).toContain('| E-1 | 2 | 100% | 2/2 |');
    // The app reads how far the run got from status.json.
    expect(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'))).toMatchObject({
      state: 'done',
      done: 2,
      total: 2,
      pid: process.pid,
    });
    expect(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')).current).toBeUndefined();
  });

  it('marks status.json failed when the run fails, and takes an out folder with the app files', async () => {
    const { dir: repoDir } = repo();
    const set = parseBenchSet(
      {
        id: 'broken',
        entries: [
          {
            id: 'E-1',
            base: { ref: 'main' },
            prompt: 'x',
            done_when: [{ kind: 'command', run: 'check' }],
          },
        ],
      },
      join(repoDir, 'set.yaml'),
    );
    const out = scratch('bench-out-');
    // The app writes its request and the runner's log before the runner starts.
    writeFileSync(join(out, 'request.json'), '{}\n');
    writeFileSync(join(out, 'run.log'), '');
    await expect(
      runBench({
        set,
        repo: repoDir,
        out,
        agent: 'none',
        log: () => {},
        runCommand: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'))).toMatchObject({
      state: 'failed',
      done: 0,
      total: 1,
      error: 'boom',
    });
    writeFileSync(join(out, 'other.txt'), 'x');
    await expect(
      runBench({ set, repo: repoDir, out, agent: 'none', log: () => {} }),
    ).rejects.toThrow(/already holds files/);
  });

  it('stops an agent that runs past its budget', async () => {
    const { dir: repoDir } = repo();
    const work = scratch('bench-work-');
    const agentFile = join(work, 'fake-claude.cjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const set = parseBenchSet(
      {
        id: 'demo',
        entries: [
          {
            id: 'slow',
            base: { ref: 'main' },
            prompt: 'SLEEP',
            agent: 'claude:engineer',
            done_when: [{ kind: 'check', check: 'file-exists', args: { path: 'done.txt' } }],
          },
        ],
      },
      join(work, 'demo.yaml'),
    );
    const summary = await runBench({
      set,
      repo: repoDir,
      out: join(work, 'out'),
      budgetMin: 0.03,
      runtimes: { claude: { command: process.execPath, args: [agentFile] } },
      log: () => {},
    });
    expect(summary!.entries[0]).toMatchObject({ timedOut: 1, passRate: 0 });
  });

  it('refuses an out folder inside the repo and a hidden folder inside it', async () => {
    const { dir: repoDir } = repo();
    const set = parseBenchSet(
      {
        id: 'demo',
        entries: [
          {
            id: 'E',
            base: { ref: 'main' },
            prompt: 'x',
            agent: 'none',
            done_when: [{ kind: 'command', run: 'x', hidden: true }],
          },
        ],
      },
      join(repoDir, 'demo.yaml'),
    );
    const base = { set, repo: repoDir, log: () => {} };
    await expect(runBench({ ...base, out: join(repoDir, 'out') })).rejects.toThrow(
      /inside the repo/,
    );
    mkdirSync(join(repoDir, 'h'));
    writeFileSync(join(repoDir, 'h', 't.py'), '');
    await expect(
      runBench({ ...base, out: scratch('bench-out-'), hiddenDir: join(repoDir, 'h') }),
    ).rejects.toThrow(/an agent could read it/);
  });
});

describe('summaries', () => {
  const attempt = (
    entry: string,
    passRate: number | null,
    hidden: [number, number],
    cost: number | null,
    wallMs: number,
    before: number | null,
  ): AttemptResult =>
    ({
      entry,
      run: { exitCode: 0, timedOut: false, wallMs },
      metrics: { costUsd: cost, toolCallsBeforeEdit: before },
      score: {
        checkable: 4,
        passed: 0,
        passRate,
        hidden: { total: hidden[1], passed: hidden[0] },
        pending: 1,
      },
    }) as AttemptResult;

  const summary = (attempts: AttemptResult[], agent: string): BenchSummary => {
    const entries = summarizeEntries(attempts);
    return {
      set: 'demo',
      mode: 'agent',
      agent,
      repo: '/r',
      out: `/out/${agent}`,
      startedAt: '',
      finishedAt: '',
      entries,
      overall: overallOf(entries),
    };
  };

  it('averages attempts per entry and weighs entries the same for the pass rate', () => {
    const s = summary(
      [
        attempt('A', 1, [1, 1], 0.2, 1000, 4),
        attempt('A', 0.5, [0, 1], 0.4, 3000, null),
        attempt('B', 0, [0, 0], null, 2000, 10),
      ],
      'x',
    );
    expect(s.entries[0]).toMatchObject({
      entry: 'A',
      attempts: 2,
      passRate: 0.75,
      hiddenPass: { passed: 1, attempts: 2 },
      wallMs: 2000,
      toolCallsBeforeEdit: 4,
    });
    expect(s.entries[0]!.costUsd).toBeCloseTo(0.3);
    expect(s.entries[1]).toMatchObject({ hiddenPass: null, costUsd: null });
    expect(s.overall.attempts).toBe(3);
    expect(s.overall.passRate).toBeCloseTo(0.375);
    expect(s.overall.hiddenPassRate).toBe(0.5);
    expect(s.overall.costUsd).toBeCloseTo(0.6);
    expect(s.overall.costPerAttempt).toBeCloseTo(0.3);
    expect(s.overall.wallMs).toBe(2000);
    expect(s.overall.toolCallsBeforeEdit).toBe(6);
  });

  it('compares two runs per entry and over the entries both have', () => {
    const a = summary(
      [attempt('A', 0.5, [0, 1], 0.2, 1000, 8), attempt('B', 1, [1, 1], 0.1, 1000, 2)],
      'old',
    );
    const b = summary(
      [attempt('A', 1, [1, 1], 0.3, 4000, 4), attempt('C', 1, [1, 1], 1, 1000, 1)],
      'new',
    );
    const c = compareSummaries(a, b);
    expect(c.rows.map((r) => [r.entry, !!r.a, !!r.b])).toEqual([
      ['A', true, true],
      ['B', true, false],
      ['C', false, true],
    ]);
    expect(c.overall.delta.passRate).toBeCloseTo(0.5);
    expect(c.overall.delta.hiddenPassRate).toBe(1);
    expect(c.overall.delta.costPerAttempt).toBeCloseTo(0.1);
    expect(c.overall.delta.wallMs).toBe(3000);
    expect(c.overall.delta.toolCallsBeforeEdit).toBe(-4);
    const md = compareMarkdown(c);
    expect(md).toContain('| A | 50% → 100% (+50 pts) | 0/1 → 1/1 | $0.20 → $0.30 (+$0.10)');
    expect(md).toContain('| B | 100% → - |');
  });

  it('marks estimated costs with ~ in the summary and in compare', () => {
    const est = (a: AttemptResult): AttemptResult => ({
      ...a,
      metrics: { ...a.metrics, costEstimated: true },
    });
    const a = summary([attempt('A', 1, [0, 0], 0.2, 1000, 1)], 'claude');
    const b = summary([est(attempt('A', 1, [0, 0], 0.1, 1000, 1))], 'codex');
    expect(b.entries[0]!.costEstimated).toBe(true);
    expect(b.overall.costEstimated).toBe(true);
    expect(summaryMarkdown(b)).toContain('~$0.10 total, ~$0.10 each');
    const c = compareSummaries(a, b);
    expect(c.overall.delta).not.toHaveProperty('costEstimated');
    const md = compareMarkdown(c);
    expect(md).toContain('| A | 100% → 100% (±0) | - → - | $0.20 → ~$0.10 (-$0.10) |');
    expect(md).toContain('`~` marks a cost estimated');
  });
});

describe('estimated cost', () => {
  it('checks swarmupd.bench.prices and refuses bad values', () => {
    expect(checkBenchPrices(undefined)).toEqual({});
    expect(checkBenchPrices({ m: { input: 1, cached_input: 0.1, output: 4 } })).toEqual({
      m: { input: 1, cached_input: 0.1, output: 4 },
    });
    expect(() => checkBenchPrices([])).toThrow(/use model names/);
    expect(() => checkBenchPrices({ m: 3 })).toThrow(/prices\.m: use input, cached_input/);
    expect(() => checkBenchPrices({ m: { input: 1, output: 4 } })).toThrow(
      /prices\.m\.cached_input: use a number of 0 or more/,
    );
    expect(() => checkBenchPrices({ m: { input: -1, cached_input: 0, output: 4 } })).toThrow(
      /prices\.m\.input/,
    );
    expect(() =>
      checkBenchPrices({ m: { input: 1, cached_input: 0, output: 4, cache: 1 } }),
    ).toThrow(/unknown key cache/);
    expect(benchPrices({ 'gpt-5.6-sol': { input: 1, cached_input: 0, output: 2 } })).toMatchObject({
      'gpt-5.6-sol': { input: 1, cached_input: 0, output: 2 },
      'gpt-5.6-luna': { input: 0.2, cached_input: 0.02, output: 1.2 },
    });
  });

  it('takes the model from --model, the runtime config, then Codex config.toml', () => {
    const home = scratch('bench-codex-home-');
    const env = { CODEX_HOME: home };
    expect(codexConfigModel(env)).toBeUndefined();
    writeFileSync(
      join(home, 'config.toml'),
      '# top\nmodel = "gpt-5.6-terra"\n\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n',
    );
    expect(codexConfigModel(env)).toBe('gpt-5.6-terra');
    expect(benchCostModel('codex', { env })).toBe('gpt-5.6-terra');
    expect(benchCostModel('codex', { env, runtimes: { codex: { model: 'default' } } })).toBe(
      'gpt-5.6-terra',
    );
    expect(benchCostModel('codex', { env, runtimes: { codex: { model: 'gpt-5.6-sol' } } })).toBe(
      'gpt-5.6-sol',
    );
    expect(
      benchCostModel('codex', { env, model: 'x-1', runtimes: { codex: { model: 'gpt-5.6-sol' } } }),
    ).toBe('x-1');
    expect(benchCostModel('codex', { env, model: '' })).toBe('gpt-5.6-terra');
    expect(benchCostModel('claude', { env })).toBeUndefined();
    writeFileSync(join(home, 'config.toml'), "model = 'default'\n");
    expect(codexConfigModel(env)).toBeUndefined();
  });

  it('prices a Codex log at the model price, with cached input at its own price', () => {
    const dir = scratch('bench-log-');
    const log = join(dir, 'agent.log');
    writeFileSync(
      log,
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 5 },
      }),
    );
    const m = logMetrics(log);
    priceMetrics(m, 'gpt-5.6-sol', benchPrices());
    // 40 input at $5, 60 cached at $0.50 and 5 output at $30 per million tokens.
    expect(m.costUsd).toBeCloseTo((40 * 5 + 60 * 0.5 + 5 * 30) / 1e6, 12);
    expect(m).toMatchObject({ costEstimated: true, priceModel: 'gpt-5.6-sol' });
    const unknown = logMetrics(log);
    priceMetrics(unknown, 'gpt-9', benchPrices());
    expect(unknown).toMatchObject({ costUsd: null, unpriced: true, priceModel: 'gpt-9' });
    const none = logMetrics(log);
    priceMetrics(none, undefined, benchPrices());
    expect(none.unpriced).toBe(true);
    expect(none.priceModel).toBeUndefined();
  });
});

/**
 * A fake Codex: logs `--json` events. Run N (counted in `counter`) uses N * 200,000 input tokens,
 * $1 per run at gpt-5.6-sol's input price, and only the first run writes `done.txt`.
 */
const fakeCodex = (counter: string): string => `
const fs = require('fs');
const counter = ${JSON.stringify(counter)};
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
  fs.writeFileSync(counter, String(n));
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (n === 1) {
    fs.writeFileSync('done.txt', 'x');
    say({ type: 'item.completed', item: { type: 'file_change' } });
  }
  say({ type: 'turn.completed', usage: { input_tokens: n * 200000, cached_input_tokens: 0, output_tokens: 0 } });
});
`;

describe('runBench cost cap and spread', () => {
  const codexSet = (dir: string) =>
    parseBenchSet(
      {
        id: 'cx',
        defaults: { agent: 'codex:engineer' },
        entries: [
          {
            id: 'E-1',
            base: { ref: 'main' },
            prompt: 'Write done.txt.',
            done_when: [{ kind: 'check', check: 'file-exists', args: { path: 'done.txt' } }],
          },
        ],
      },
      join(dir, 'cx.yaml'),
    );

  it('estimates Codex cost, reports the spread over repeats and stops at the cap', async () => {
    const { dir: repoDir } = repo();
    const work = scratch('bench-work-');
    const agentFile = join(work, 'fake-codex.cjs');
    writeFileSync(agentFile, fakeCodex(join(work, 'count')));
    const home = join(work, 'codex-home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-5.6-sol"\n');
    const out = join(work, 'out');
    const logs: string[] = [];
    const opts = {
      set: codexSet(work),
      repo: repoDir,
      out,
      repeat: 3,
      maxUsd: 1.5,
      env: { ...process.env, CODEX_HOME: home },
      runtimes: { codex: { command: process.execPath, args: [agentFile] } },
      log: (l: string) => logs.push(l),
    };
    await runBench({ ...opts, dryRun: true });
    expect(logs.join('\n')).toContain(
      "cost: estimated from tokens at gpt-5.6-sol's price per million tokens: input $5",
    );
    expect(logs.join('\n')).toContain('cost cap: $1.50 of agent and judge cost');
    logs.length = 0;
    const summary = (await runBench(opts))!;
    const r1 = JSON.parse(
      readFileSync(join(out, 'E-1', '1', 'results.json'), 'utf8'),
    ) as AttemptResult;
    expect(r1.metrics).toMatchObject({ costEstimated: true, priceModel: 'gpt-5.6-sol' });
    expect(r1.metrics.costUsd).toBeCloseTo(1);
    // Attempt 1 cost $1, under the cap; attempt 2 cost $2 more, so attempt 3 never starts.
    expect(existsSync(join(out, 'E-1', '3'))).toBe(false);
    expect(summary.cap).toEqual({ maxUsd: 1.5, spentUsd: 3, hit: true, uncounted: 0 });
    expect(summary.skipped).toEqual([
      { entry: 'E-1', attempt: 3, reason: expect.stringContaining('cost cap of $1.50') },
    ]);
    const e = summary.entries[0]!;
    expect(e).toMatchObject({
      attempts: 2,
      passRate: 0.5,
      costEstimated: true,
      passRateMin: 0,
      passRateMax: 1,
    });
    expect(e.costUsd).toBeCloseTo(1.5);
    expect(e.passRateSd).toBeCloseTo(Math.SQRT1_2);
    expect(e.costSdUsd).toBeCloseTo(Math.SQRT1_2);
    expect(summary.overall).toMatchObject({ costEstimated: true, passRateMin: 0, passRateMax: 1 });
    expect(summary.overall.passRateSd).toBeCloseTo(Math.SQRT1_2);
    expect(summary.overall.costSdUsd).toBeCloseTo(Math.SQRT1_2);
    expect(JSON.parse(readFileSync(join(out, 'status.json'), 'utf8'))).toMatchObject({
      state: 'done',
      done: 2,
      total: 3,
      skipped: 1,
    });
    const md = readFileSync(join(out, 'summary.md'), 'utf8');
    expect(md).toContain('- Cost cap: $1.50; spent ~$3.00; reached, 1 attempt not started');
    expect(md).toContain('| E-1 | 2 | 50% | - | 0 | 0 | ~$1.50 |');
    expect(md).toContain('| E-1 | 2 | 0% | 100% | 71 pts | ~$0.71 |');
    expect(md).toContain('| **All, by repeat** | 2 | 0% | 100% | 71 pts | ~$0.71 |');
    expect(md).toContain('- E-1 #3: the cost cap of $1.50 was reached ($3.00 spent)');
    expect(logs.join('\n')).toContain('cost cap reached: $3.00 of $1.50; 1 attempts not started');
  });

  it('leaves the cost of a model with no price unknown, and warns once that the cap cannot count it', async () => {
    const { dir: repoDir } = repo();
    const work = scratch('bench-work-');
    const agentFile = join(work, 'fake-codex.cjs');
    writeFileSync(agentFile, fakeCodex(join(work, 'count')));
    const logs: string[] = [];
    const summary = (await runBench({
      set: codexSet(work),
      repo: repoDir,
      out: join(work, 'out'),
      repeat: 2,
      maxUsd: 1,
      model: 'gpt-9',
      env: { ...process.env, CODEX_HOME: join(work, 'no-home') },
      runtimes: { codex: { command: process.execPath, args: [agentFile] } },
      log: (l) => logs.push(l),
    }))!;
    expect(summary.entries[0]).toMatchObject({ attempts: 2, costUsd: null, unpriced: ['gpt-9'] });
    expect(summary.cap).toEqual({ maxUsd: 1, spentUsd: 0, hit: false, uncounted: 2 });
    expect(summary.skipped).toBeUndefined();
    expect(logs.filter((l) => l.includes('the cost cap cannot count it'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('no price for gpt-9;'))).toHaveLength(1);
    expect(logs).toContain('cost: no price for gpt-9, so codex attempts will have no cost');
    const md = summaryMarkdown(summary);
    expect(md).toContain('| no price (gpt-9) |');
    expect(md).toContain('- No price for gpt-9:');
    expect(md).toContain('not reached; 2 attempts with unknown cost not counted');
  });
});
