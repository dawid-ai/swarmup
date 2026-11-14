import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import { opsdConfig, Supervisor } from '../src/index.js';
import { addedSkip, patternRegExp, testChangesNote } from '../src/test-changes.js';
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
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-testchanges-'));
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

/** Stands in for the reviewer's runtime: records its prompt, and ends. */
const RECORDER = `
import { writeFileSync } from 'node:fs';
let prompt = '';
for await (const c of process.stdin) prompt += c;
writeFileSync(process.env.REVIEW_CALL, JSON.stringify({ prompt }));
`;

const PACKAGE = { name: 'x', scripts: { test: 'vitest run' }, dependencies: { a: '1.0.0' } };

/**
 * A project repo on `main` with code, two tests, a lint config and a `package.json`, a task `1`,
 * and a waking `codex:reviewer`.
 */
function setup(opsd: Record<string, unknown> = {}) {
  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const write = (dir: string, file: string, text: string): void => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  write(repo, 'src/code.ts', 'export const one = 1;\n');
  write(repo, 'test/code.test.ts', "it('is one', () => {\n  expect(one).toBe(1);\n});\n");
  write(repo, 'test/other.test.ts', "it('is other', () => {});\n");
  write(repo, 'eslint.config.js', 'export default [];\n');
  write(repo, 'package.json', JSON.stringify(PACKAGE, null, 2));
  const state = temp();
  const call = join(temp(), 'review-call.json');
  const recorder = join(temp(), 'reviewer.mjs');
  writeFileSync(recorder, RECORDER);
  const env = {
    ...process.env,
    ...ID,
    SWARMUP_CONFIG: join(repo, 'none.yml'),
    SWARMUP_STATE_DIR: state,
    REVIEW_CALL: call,
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
  const h = as('human:dawid');
  h.newTask({ title: 'Change the code', owner: '*:engineer' });
  h.saveRole({ id: 'codex:reviewer', status: 'active' }, { create: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'start');
  const config = opsdConfig({
    opsd: {
      sync: false,
      task_worktrees: false,
      runtimes: { codex: { command: process.execPath, args: [recorder] } },
      agents: { 'codex:reviewer': { wake: true } },
      ...opsd,
    },
  });
  const sup = new Supervisor({ env, cwd: repo, user: {}, config, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  /** A branch `feature` from main's tip, in a worktree of its own, changed by `change`. */
  const branch = (change: (wt: string) => void): string => {
    const wt = join(temp(), 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    change(wt);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Change the code');
    return git(wt, 'rev-parse', 'HEAD');
  };
  /** Sends task 1 to review, starts the review run, and returns its prompt. */
  const reviewPrompt = async (commit: string): Promise<string> => {
    as('claude:engineer').start('1', 'plan');
    as('claude:engineer').review(
      '1',
      `${commit.slice(0, 7)} on branch feature: changes it`,
      'codex:reviewer',
    );
    await until(() => {
      void sup.tick();
      return sup.runs().some((r) => r.task === 'T-0001' && r.review);
    });
    const run = sup.runs().find((r) => r.task === 'T-0001' && r.review)!;
    await until(() => sup.run(run.id).status === 'ended' && sup.run(run.id).wrap_up === 'done');
    return (JSON.parse(readFileSync(call, 'utf8')) as { prompt: string }).prompt;
  };
  return { repo, sup, write, branch, reviewPrompt };
}

describe('changes to tests and check configuration, for the reviewer (AO-0291)', () => {
  it('matches file names in any folder, and folders with `**`', () => {
    const is = (pattern: string, path: string): boolean => patternRegExp(pattern).test(path);
    expect(is('*.test.*', 'packages/core/test/fold.test.ts')).toBe(true);
    expect(is('*.test.*', 'fold.test.ts')).toBe(true);
    expect(is('*.test.*', 'src/fold.ts')).toBe(false);
    expect(is('**/test/**', 'test/a.ts')).toBe(true);
    expect(is('**/test/**', 'packages/core/test/deep/a.ts')).toBe(true);
    expect(is('**/test/**', 'src/latest/a.ts')).toBe(false);
    expect(is('.github/workflows/**', '.github/workflows/ci.yml')).toBe(true);
    expect(is('.github/workflows/**', 'docs/.github/workflows/ci.yml')).toBe(false);
    expect(is('package.json', 'packages/cli/package.json')).toBe(true);
    expect(is('tsconfig*.json', 'tsconfig.test.json')).toBe(true);
    expect(is('scripts/', 'scripts/ci/run.sh')).toBe(true);
  });

  it('finds an added line that skips or narrows tests', () => {
    expect(addedSkip("@@ -1 +1 @@\n-it('a', () => {\n+it.skip('a', () => {\n")).toBe(
      "it.skip('a', () => {",
    );
    expect(addedSkip("+describe.only('a', () => {\n")).toBe("describe.only('a', () => {");
    expect(addedSkip("+  xit('a', () => {\n")).toBe("xit('a', () => {");
    expect(addedSkip('+@pytest.mark.skip(reason="slow")\n')).toContain('@pytest.mark.skip');
    // A removed skip, a plain test and a method named `fit` are no skip.
    expect(addedSkip("-it.skip('a', () => {\n+it('a', () => {\n")).toBeUndefined();
    expect(addedSkip('+  model.fit(data)\n')).toBeUndefined();
  });

  it('writes no lines for work that changes none', () => {
    expect(
      testChangesNote({ base: 'main', from: 'a'.repeat(40), to: 'b'.repeat(40), items: [] }),
    ).toBe('');
  });

  it(
    'flags a branch that deletes a test in the review prompt',
    async () => {
      const s = setup();
      const commit = s.branch((wt) => {
        writeFileSync(join(wt, 'src/code.ts'), 'export const one = 2;\n');
        rmSync(join(wt, 'test/code.test.ts'));
      });
      const prompt = await s.reviewPrompt(commit);
      expect(prompt).toContain('This work changes tests or check configuration');
      expect(prompt).toContain(`..${commit.slice(0, 7)}, compared with\nmain)`);
      expect(prompt).toContain('- deleted test: `test/code.test.ts`');
      expect(prompt).toContain('Check that the task needs each of these changes');
      // The code change itself and the test the branch left alone are not listed.
      expect(prompt).not.toContain('`src/code.ts`');
      expect(prompt).not.toContain('other.test.ts');
    },
    WAIT_MS * 3,
  );

  it(
    'does not flag a branch that touches no test and no check configuration',
    async () => {
      const s = setup();
      const commit = s.branch((wt) => {
        writeFileSync(join(wt, 'src/code.ts'), 'export const one = 2;\n');
        // A new dependency changes `package.json`, but not its scripts.
        const pkg = { ...PACKAGE, dependencies: { a: '1.0.0', b: '2.0.0' } };
        writeFileSync(join(wt, 'package.json'), JSON.stringify(pkg, null, 2));
        // A new test takes nothing away from the checks.
        s.write(wt, 'test/new.test.ts', "it('is new', () => {});\n");
      });
      const prompt = await s.reviewPrompt(commit);
      expect(prompt).toContain('T-0001');
      expect(prompt).not.toContain('changes tests or check configuration');
    },
    WAIT_MS * 3,
  );

  it(
    'flags a skipped test, a changed test, changed scripts and changed lint configuration',
    async () => {
      const s = setup();
      const commit = s.branch((wt) => {
        writeFileSync(
          join(wt, 'test/code.test.ts'),
          "it.skip('is one', () => {\n  expect(one).toBe(1);\n});\n",
        );
        writeFileSync(
          join(wt, 'test/other.test.ts'),
          "it('is other', () => {\n  // changed\n});\n",
        );
        const pkg = { ...PACKAGE, scripts: { test: 'echo ok' } };
        writeFileSync(join(wt, 'package.json'), JSON.stringify(pkg, null, 2));
        writeFileSync(join(wt, 'eslint.config.js'), "export default [{ ignores: ['src'] }];\n");
      });
      const prompt = await s.reviewPrompt(commit);
      expect(prompt).toContain(
        "- changed test: `test/code.test.ts` (+1 -1), adds a line that skips or narrows tests: `it.skip('is one', () => {`",
      );
      expect(prompt).toContain('- changed test: `test/other.test.ts` (+3 -1)');
      expect(prompt).toContain(
        '- changed check configuration: `package.json` (+1 -1), its `scripts` differ',
      );
      expect(prompt).toContain('- changed check configuration: `eslint.config.js` (+1 -1)');
    },
    WAIT_MS * 3,
  );

  it(
    "uses the root's own patterns, and lists nothing with the setting false",
    async () => {
      const own = setup({ test_changes: { test: { tests: ['src/**'], checks: [] } } });
      const commit = own.branch((wt) => {
        writeFileSync(join(wt, 'src/code.ts'), 'export const one = 2;\n');
        rmSync(join(wt, 'test/code.test.ts'));
      });
      const prompt = await own.reviewPrompt(commit);
      expect(prompt).toContain('- changed test: `src/code.ts` (+1 -1)');
      expect(prompt).not.toContain('test/code.test.ts');

      const off = setup({ test_changes: { test: false } });
      const gone = off.branch((wt) => rmSync(join(wt, 'test/code.test.ts')));
      expect(await off.reviewPrompt(gone)).not.toContain('changes tests or check configuration');
    },
    WAIT_MS * 3,
  );

  it('refuses a setting that is no list of patterns', () => {
    expect(() =>
      opsdConfig({ opsd: { test_changes: { test: { tests: 'test/**' } } } } as never),
    ).toThrow('swarmupd.test_changes.test.tests: use a list of path patterns');
  });
});
