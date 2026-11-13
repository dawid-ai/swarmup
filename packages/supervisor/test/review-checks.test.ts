import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import { opsdConfig, Supervisor } from '../src/index.js';
import { needsReviewChecks, reviewChecksLog, reviewChecksNote } from '../src/review-checks.js';
import { until, WAIT_MS } from './until.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// As in merge.test.ts: this test's supervisors and folders are taken before anything is awaited.
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    for (const d of gone) {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-review-'));
  dirs.push(d);
  return d;
}

const ID = {
  GIT_AUTHOR_NAME: 'Swarmupd Test',
  GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
  GIT_COMMITTER_NAME: 'Swarmupd Test',
  GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ID },
  }).trim();
const text = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Counts its runs in `CHECK_COUNT`, writes build output, and fails when `code.txt` says `bad`. */
const CHECK = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const code = readFileSync('code.txt', 'utf8').trim();
appendFileSync(process.env.CHECK_COUNT, code + '\\n');
writeFileSync('built.txt', code);
console.log('checking ' + code);
if (code.includes('bad')) { console.error('code says bad'); process.exit(1); }
`;
/** Stands in for Codex: records its arguments and its prompt, and ends. */
const RECORDER = `
import { writeFileSync } from 'node:fs';
let prompt = '';
for await (const c of process.stdin) prompt += c;
writeFileSync(process.env.CODEX_CALL, JSON.stringify({ args: process.argv.slice(2), prompt }));
`;

/**
 * A project repo on `main` whose merge setting names two checks, a task `1`, and a waking
 * `codex:reviewer` (a role that does not write) next to a waking `claude:reviewer`.
 */
function reviewSetup(opsd: Record<string, unknown> = {}) {
  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  writeFileSync(join(repo, 'code.txt'), 'one\n');
  writeFileSync(join(repo, 'check.mjs'), CHECK);
  writeFileSync(join(repo, '.gitignore'), 'built.txt\n');
  const state = temp();
  const call = join(temp(), 'codex-call.json');
  const recorder = join(temp(), 'codex.mjs');
  writeFileSync(recorder, RECORDER);
  const env = {
    ...process.env,
    ...ID,
    SWARMUP_CONFIG: join(repo, 'none.yml'),
    SWARMUP_STATE_DIR: state,
    CHECK_COUNT: join(state, 'checks.txt'),
    CODEX_CALL: call,
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  const h = as('human:dawid');
  h.newTask({ title: 'Change the code', owner: '*:engineer' });
  h.saveRole({ id: 'codex:reviewer', status: 'active' }, { create: true });
  h.saveRole({ id: 'claude:reviewer', status: 'active' }, { create: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  const config = opsdConfig({
    opsd: {
      sync: false,
      task_worktrees: false,
      runtimes: {
        codex: { command: process.execPath, args: [recorder] },
        claude: { command: process.execPath, args: [recorder] },
      },
      agents: { 'codex:reviewer': { wake: true }, 'claude:reviewer': { wake: true } },
      merge: { test: { base: 'main', checks: ['node check.mjs', 'node check.mjs again'] } },
      ...opsd,
    },
  });
  const sup = new Supervisor({ env, cwd: repo, user: {}, config, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  /** A branch `feature` from main's tip, in a worktree of its own, with `code.txt` as `code`. */
  const branch = (code: string): string => {
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    writeFileSync(join(wt, 'code.txt'), code);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Change the code');
    return git(wt, 'rev-parse', 'HEAD');
  };
  /** Task 1 sent by `author` to `reviewer`, with the review naming `commit` on `feature`. */
  const review = (commit: string, reviewer: string, author = 'claude:engineer'): void => {
    as(author).start('1', 'plan');
    as(author).review('1', `${commit.slice(0, 7)} on branch feature: changes it`, reviewer);
  };
  /** Ticks until the review run of task 1 has started, and waits for it to end. */
  const reviewed = async (): Promise<{ run: RunRecord; args: string[]; prompt: string }> => {
    await until(() => {
      void sup.tick();
      return sup.runs().some((r) => r.task === 'T-0001' && r.review);
    });
    const run = sup.runs().find((r) => r.task === 'T-0001' && r.review)!;
    await until(() => sup.run(run.id).status === 'ended' && sup.run(run.id).wrap_up === 'done');
    return { run, ...(JSON.parse(text(call)) as { args: string[]; prompt: string }) };
  };
  return { repo, sup, state, as, branch, review, reviewed };
}

describe('checks for a reviewer that cannot run them (AO-0296)', () => {
  it('runs them only for a Codex run of a role that does not write, where checks are set', () => {
    const cfg = { base: 'main', checks: ['npm test'] };
    expect(needsReviewChecks('codex:reviewer', false, true, cfg)).toBe(true);
    expect(needsReviewChecks('claude:reviewer', false, true, cfg)).toBe(false);
    expect(needsReviewChecks('codex:engineer', true, true, cfg)).toBe(false);
    expect(needsReviewChecks('codex:reviewer', false, false, cfg)).toBe(false);
    expect(needsReviewChecks('codex:reviewer', false, true, { base: 'main', checks: [] })).toBe(
      false,
    );
    expect(needsReviewChecks('codex:reviewer', false, true, undefined)).toBe(false);
  });

  it('writes the results, the failed output and the checks not run into the prompt', () => {
    const token = ['gh', 'p_'].join('') + 'A'.repeat(36);
    const checks = {
      commit: 'abc1234def5678',
      what: 'abc1234 on branch feature',
      at: 0,
      commands: ['npm ci', 'npm test', 'npm run lint'],
      results: [
        { ok: true, command: 'npm ci', output: 'added 5 packages' },
        {
          ok: false,
          command: 'npm test',
          output: `first line\nGH_TOKEN=${token}\n1 failed`,
          why: 'exit 1',
        },
      ],
    };
    const note = reviewChecksNote(checks, 'C:\\state\\scratch\\r1\\review-checks.log');
    expect(note).toContain('on abc1234 on branch feature (commit abc1234def56');
    expect(note).toContain('- `npm ci`: passed');
    expect(note).toContain('- `npm test`: failed (exit 1)');
    expect(note).toContain('- `npm run lint`: not run, an earlier check failed');
    expect(note).toContain('    1 failed');
    expect(note).toContain('C:/state/scratch/r1/review-checks.log');
    expect(note).not.toContain(token);
    expect(reviewChecksLog(checks)).toContain('$ npm ci: passed\nadded 5 packages');
    expect(reviewChecksLog(checks)).not.toContain(token);
    // Checks swarmupd could not run are named as not run, with the reason.
    const none = reviewChecksNote({ at: 0, commands: ['npm test'], results: [], note: 'no git' });
    expect(none).toContain('swarmupd did not run the checks of this review: no git.');
  });

  it(
    'runs the checks on the reviewed commit before the Codex review run and names them in its prompt',
    async () => {
      const s = reviewSetup();
      const commit = s.branch('two\n');
      s.review(commit, 'codex:reviewer');
      await s.sup.tick();
      // The run waits for the checks, and `swarmup waits` says so.
      expect(s.sup.runs()).toEqual([]);
      expect(s.sup.waits().map((w) => w.reason)).toEqual([
        'starts once swarmupd has run the checks of the reviewed commit',
      ]);
      await s.sup.reviewChecksSettled();
      const { run, args, prompt } = await s.reviewed();
      expect(prompt).toContain(`Checks swarmupd ran for this review, on ${commit.slice(0, 7)} on`);
      expect(prompt).toContain('- `node check.mjs`: passed');
      expect(prompt).toContain('- `node check.mjs again`: passed');
      // Each check ran once, on the branch's code, in swarmupd's own worktree.
      expect(text(join(s.state, 'checks.txt'))).toBe('two\ntwo\n');
      expect(text(join(s.state, 'review', 'test', 'built.txt'))).toBe('two');
      expect(existsSync(join(s.repo, 'built.txt'))).toBe(false);
      expect(git(s.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(git(s.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
      // The whole output is in the run's scratch folder, which the sandbox may write.
      const log = join(run.scratch!, 'review-checks.log');
      expect(text(log)).toContain('checking two');
      const added = args.filter((_, i) => args[i - 1] === '--add-dir');
      expect(added).toEqual([run.scratch]);
      expect(prompt).toContain('You can also write your scratch folder');
    },
    WAIT_MS * 3,
  );

  it(
    'starts the review with the failed check and its output',
    async () => {
      const s = reviewSetup();
      s.review(s.branch('bad\n'), 'codex:reviewer');
      await s.sup.tick();
      await s.sup.reviewChecksSettled();
      const { prompt } = await s.reviewed();
      expect(prompt).toContain('- `node check.mjs`: failed (exit 1)');
      expect(prompt).toContain('- `node check.mjs again`: not run, an earlier check failed');
      expect(prompt).toContain('    code says bad');
      expect(text(join(s.state, 'checks.txt'))).toBe('bad\n');
    },
    WAIT_MS * 3,
  );

  it(
    'starts the review at once for a reviewer that runs its own checks, or with the setting off',
    async () => {
      const s = reviewSetup();
      s.review(s.branch('two\n'), 'claude:reviewer', 'codex:engineer');
      await s.sup.tick();
      expect(s.sup.runs().map((r) => r.agent)).toEqual(['claude:reviewer']);
      const { prompt } = await s.reviewed();
      expect(prompt).not.toContain('Checks swarmupd ran');
      expect(existsSync(join(s.state, 'checks.txt'))).toBe(false);

      const off = reviewSetup({ review_checks: false });
      off.review(off.branch('two\n'), 'codex:reviewer');
      await off.sup.tick();
      expect(off.sup.runs().map((r) => r.agent)).toEqual(['codex:reviewer']);
      expect((await off.reviewed()).prompt).not.toContain('Checks swarmupd ran');
    },
    WAIT_MS * 3,
  );

  it(
    'tells the reviewer when the review names no commit swarmupd can check',
    async () => {
      const s = reviewSetup();
      s.as('claude:engineer').start('1', 'plan');
      s.as('claude:engineer').review('1', 'the files are in the checkout', 'codex:reviewer');
      await s.sup.tick();
      await s.sup.reviewChecksSettled();
      const { prompt } = await s.reviewed();
      expect(prompt).toContain(
        'swarmupd did not run the checks of this review: no review request names a commit or a branch.',
      );
      expect(existsSync(join(s.state, 'checks.txt'))).toBe(false);
    },
    WAIT_MS * 3,
  );
});
