import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { samePath } from '@swarmup/core';
import type { MergeGitTimeout } from '../src/index.js';
import { MERGE_ACTOR, MergeRepo, showsFailedTest } from '../src/index.js';
import { until } from './until.js';
import {
  ID,
  STAGE_MS,
  WIN,
  ended,
  git,
  hangOnly,
  mergeSetup,
  removed,
  stopsTrees,
  temp,
  text,
} from './merge-setup.js';

describe('showsFailedTest (AO-0385)', () => {
  it('finds the failed-test lines of vitest and node:test', () => {
    for (const out of [
      ' FAIL  packages/core/test/fold.test.ts > folds events',
      '   × folds events 12ms',
      ' ❯ packages/core/test/fold.test.ts (12 tests | 1 failed) 340ms',
      '      Tests  1 failed | 411 passed (412)',
      ' Test Files  2 failed | 40 passed (42)',
      'not ok 3 - folds events',
      '✖ folds events (2.1ms)',
      '   \x1b[31m×\x1b[39m folds events \x1b[2m12ms\x1b[22m',
    ])
      expect(showsFailedTest(`RUN  v3\n ✓ a.test.ts (3 tests) 20ms\n${out}\n`), out).toBe(true);
  });

  it('finds none in a run that passed so far', () => {
    const out = [
      ' RUN  v3.2.4 C:/dev/swarmup',
      ' ✓ packages/core/test/fold.test.ts (12 tests) 340ms',
      '   ✓ reports 1 failed check to the human 1203ms',
      ' ✓ packages/supervisor/test/push.test.ts (40 tests | 2 skipped) 97000ms',
      'ok 1 - folds events',
      '# fail 0',
    ].join('\n');
    expect(showsFailedTest(out)).toBe(false);
  });
});

describe('merging approved work', () => {
  /**
   * Task 1 approved on `feature` with `code.txt` as `two`, then task 2 on `feature2` with
   * `two.txt` as `second`; the merge lines swarmupd logs go to `lines`.
   */
  const twoApproved = (s: ReturnType<typeof mergeSetup>, second: string) => {
    const first = s.branch('two\n');
    s.approve(first);
    const wt = join(temp(), 'wt2');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature2', wt, 'main');
    writeFileSync(join(wt, 'two.txt'), second);
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Other work');
    const commit = git(wt, 'rev-parse', 'HEAD');
    s.as('fake:engineer').start('2', 'plan');
    s.as('fake:engineer').review(
      '2',
      `${commit.slice(0, 7)} on branch feature2: adds two.txt`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('2', 'approve', 'looks right');
    const lines: string[] = [];
    s.sup.on('merge', (l: string) => lines.push(l));
    const events = (id: string) => s.as('human:dawid').showEvents(id).events;
    const checks = () =>
      existsSync(join(s.state, 'checks.txt')) ? text(join(s.state, 'checks.txt')) : '';
    return { lines, events, checks };
  };

  it('merges two approved tasks that wait together after one run of the checks (AO-0381)', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const t = twoApproved(s, 'second\n');
    await s.merged();

    expect(t.checks()).toBe('x');
    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}~2`)).toBe(before);
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(text(join(s.repo, 'two.txt'))).toBe('second\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    // Each task keeps its own merge event, with the commit that holds it.
    const one = t.events('1').at(-1)!;
    const two = t.events('2').at(-1)!;
    expect(one).toMatchObject({
      type: 'merge',
      commit: git(s.repo, 'rev-parse', `${tip}^`),
      branch: 'feature',
    });
    expect(two).toMatchObject({ type: 'merge', commit: tip, branch: 'feature2' });
    expect(one.body).toContain('in one batch with T-0002');
    expect(two.body).toContain('in one batch with T-0001');
    expect(one.body).toContain('Checks passed once for the batch: `node check.mjs`.');
    expect(two.body).toContain('Built with `node build.mjs`.');
    expect(t.lines.some((l) => l.includes('checks the batch of 2 (T-0001, T-0002) once'))).toBe(
      true,
    );
    expect(
      t.lines.some((l) => l.includes('moved main to') && l.includes('after one run of the checks')),
    ).toBe(true);

    // Done once: a second tick merges nothing again.
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(t.checks()).toBe('x');
  });

  it('runs only the checks whose paths a task of the batch changes (AO-0382)', async () => {
    const s = mergeSetup({
      checks: [
        { run: 'node check.mjs', paths: ['**', '!**/*.md'] },
        { run: 'node check.mjs --docs', paths: ['**/*.md'] },
      ],
    });
    const t = twoApproved(s, 'second\n');
    await s.merged();

    expect(t.checks()).toBe('x');
    const one = t.events('1').at(-1)!;
    expect(one.body).toContain('Checks passed once for the batch: `node check.mjs`.');
    expect(one.body).toContain(
      'Not run, the batch changes none of their paths: `node check.mjs --docs`.',
    );
    expect(
      t.lines.some((l) => l.includes('skips checks for paths the batch does not change')),
    ).toBe(true);
  });

  it('runs a check when a task of the batch renames code into a path the check skips (AO-0382)', async () => {
    const s = mergeSetup({
      checks: [{ run: 'node check.mjs', paths: ['**', '!**/*.md'] }],
    });
    // Task 1 changes Markdown only; task 2 moves code into a Markdown path.
    s.approve(s.branch('one\n', { 'docs/guide.md': '# Guide\n' }));
    const wt = join(temp(), 'wt2');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature2', wt, 'main');
    mkdirSync(join(wt, 'docs'), { recursive: true });
    git(wt, 'mv', 'held.mjs', 'docs/held.md');
    git(wt, 'commit', '-qm', 'Move the code');
    const commit = git(wt, 'rev-parse', 'HEAD');
    s.as('fake:engineer').start('2', 'plan');
    s.as('fake:engineer').review(
      '2',
      `${commit.slice(0, 7)} on branch feature2: moves held.mjs`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('2', 'approve', 'looks right');
    await s.merged();

    expect(text(join(s.state, 'checks.txt'))).toBe('x');
    const one = s.as('human:dawid').showEvents('1').events.at(-1)!;
    expect(one).toMatchObject({ type: 'merge' });
    expect(one.body).toContain('Checks passed once for the batch: `node check.mjs`.');
  });

  it('splits a batch whose checks fail and sends back only the task that breaks them (AO-0381)', async () => {
    const s = mergeSetup();
    const t = twoApproved(s, 'bad\n');
    await s.merged();

    // The batch, then each half alone.
    expect(t.checks()).toBe('xxx');
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(existsSync(join(s.repo, 'two.txt'))).toBe(false);
    expect(t.events('1').at(-1)).toMatchObject({ type: 'merge', branch: 'feature' });
    expect(s.as('human:dawid').view('1').status).toBe('done');
    const back = t.events('2').at(-1)!;
    expect(back).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(back.body).toContain('two says bad');
    expect(s.as('human:dawid').view('2').status).toBe('todo');
    expect(t.lines.some((l) => l.includes('splits the batch: checks T-0001, then T-0002'))).toBe(
      true,
    );
  });

  it('records each terminal batch note once and does nothing on the next tick (AO-0381)', async () => {
    const s = mergeSetup();
    const t = twoApproved(s, 'second\n');
    git(s.repo, 'checkout', '-q', '--detach');
    git(s.repo, 'branch', '-D', 'main');
    await s.merged();

    const notes = ['1', '2'].map((id) => t.events(id).at(-1)!);
    for (const note of notes) {
      expect(note).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
      expect(note.body).toContain('no branch main');
    }

    await s.merged();
    expect(t.events('1').at(-1)).toEqual(notes[0]);
    expect(t.events('2').at(-1)).toEqual(notes[1]);
  });

  /**
   * A git timeout that stops at once the commands `hung` picks, once `arm` names a commit, and
   * gives every other command a minute.
   *
   * Off Windows, `env` puts a `git` first on swarmupd's PATH that runs those commands as a `sleep`
   * that does not end, and every other command as the real git, so the timeout always wins: with
   * the real git, a fast Linux machine finished the command inside the 1 ms and both tasks merged
   * (AO-0395). `hungSh` is `hung` as a shell function of git's arguments and `$commit`. On
   * Windows, libuv finds only `.exe` and `.com` files for `git`, so no script can stand in for it;
   * there, starting a process alone takes longer than 1 ms.
   */
  const hangOn = (hung: (args: readonly string[], commit: string) => boolean, hungSh: string) => {
    let commit = '';
    const timeout: MergeGitTimeout = (args) => (commit && hung(args, commit) ? 1 : 60_000);
    const env: Record<string, string> = {};
    const file = join(temp(), 'hang-commit.txt');
    if (!WIN) {
      const bin = temp();
      const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
      writeFileSync(
        join(bin, 'git'),
        [
          '#!/bin/sh',
          `commit=$(cat '${file}' 2>/dev/null)`,
          `hung() { ${hungSh}; }`,
          'if [ -n "$commit" ] && hung "$@"; then exec sleep 600; fi',
          `exec '${real}' "$@"`,
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'git'), 0o755);
      env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    }
    const arm = (c: string): void => {
      commit = c;
      writeFileSync(file, c);
    };
    return { arm, timeout, env };
  };

  /** Checks that a git timeout on task 2 of a batch is task 2's, and task 1 still merges. */
  const secondTimesOut = async (
    s: ReturnType<typeof mergeSetup>,
    arm: (commit: string) => void,
    stage: RegExp,
  ) => {
    const t = twoApproved(s, 'second\n');
    arm(git(s.repo, 'rev-parse', 'feature2'));
    await s.merged();

    // Task 1 merges alone after task 2 leaves the batch; it gets no note about task 2.
    expect(t.events('1').at(-1)).toMatchObject({ type: 'merge', branch: 'feature' });
    expect(t.events('1').some((e) => e.type === 'comment' && e.actor === MERGE_ACTOR)).toBe(false);
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(existsSync(join(s.repo, 'two.txt'))).toBe(false);
    // Task 2 gets the note of a merge of it alone that hung.
    const note = t.events('2').at(-1)!;
    expect(note).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(note.body).toMatch(/swarmupd could not merge .*feature2.*timed out after/);
    expect(note.body).toMatch(stage);
    expect(
      t.lines.some((l) => l.includes('T-0002') && l.includes('merges alone after the batch')),
    ).toBe(true);
    // Seen: the next tick tries neither again.
    const tip = git(s.repo, 'rev-parse', 'main');
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(t.events('2').at(-1)).toEqual(note);
  };

  it('records each merge attempt and how it ended in state.db', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    s.onMain('code.txt', 'three\n');
    s.approve(commit);
    await s.merged();
    expect(s.last().body).toContain('it conflicts with main');
    let attempts = s.sup.mergeAttempts('test/T-0001');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'conflict',
      reason: 'code.txt',
      branch: 'feature',
      root: 'test',
    });
    expect(attempts[0]!.commit).toBe(commit.slice(0, 7));
    expect(attempts[0]!.ended_at).not.toBeNull();

    // The other task merges; both attempts are in state.db, the newest first.
    s.onMain('code.txt', 'one\n');
    s.approve(commit);
    await s.merged();
    attempts = s.sup.mergeAttempts('test/T-0001');
    expect(attempts.map((a) => a.outcome)).toEqual(['merged', 'conflict']);
    expect(s.sup.mergeCounts()).toEqual(
      expect.arrayContaining([
        { outcome: 'merged', count: 1 },
        { outcome: 'conflict', count: 1 },
      ]),
    );
    // Runs are mirrored too: a run's record is in state.db once saved.
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    expect(s.sup.state!.run(run.id)).toMatchObject({ id: run.id, agent: 'fake:engineer' });
    const end = ended(s.sup, run.id);
    writeFileSync(join(s.state, 'run-go.txt'), 'go\n');
    await end;
  });

  it('keeps the one retry of a timed-out check across a restart, from state.db (AO-0385)', async () => {
    // 0.05 min is 3 s; the `slow` check waits for go.txt, which never comes.
    const s = mergeSetup({ timeoutMinutes: 0.05 });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    s.approve(s.branch('slow\n'));
    await s.merged();
    expect(warns.filter((w) => w.includes('merges once more'))).toHaveLength(1);

    // A new swarmupd on the same state takes the retry as the second try: with the machine to
    // itself, and a second timeout goes to the human.
    s.sup.stop();
    const next = s.opsd();
    const later: string[] = [];
    next.on('warn', (m: string) => later.push(m));
    await next.tick();
    await next.mergeSettled();
    expect(later.filter((w) => w.includes('merges once more'))).toHaveLength(0);
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('timed out twice');
  });

  it('does not hold a worktree for a merge it found nothing to do for', async () => {
    const s = mergeSetup();
    // The review names no commit or branch: there is nothing for swarmupd to merge.
    s.as('fake:engineer').start('1', 'plan');
    s.as('fake:engineer').review('1', 'done, the notes are in the task', 'human:dawid');
    s.as('human:dawid').verdict('1', 'approve', 'looks right');
    await s.merged();
    const ws = s.as('human:dawid');
    const v = ws.view('1');
    expect(s.sup.merger.nothingToMerge('test/T-0001', v.lastEvent)).toBe(true);
    // Worktree cleanup no longer waits for a merge that never comes.
    const notDue = (
      s.sup as unknown as { notDue: (w: typeof ws, ref: string) => string | null }
    ).notDue.bind(s.sup);
    expect(notDue(ws, 'test/T-0001')).not.toBe('merge');
    // A change to the task makes the planner look again before cleanup counts on it.
    ws.comment('1', 'one more note');
    expect(s.sup.merger.nothingToMerge('test/T-0001', ws.view('1').lastEvent)).toBe(false);
  });

  it('starts no merge while swarmupd is paused, and merges once it resumes', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    s.sup.config.paused = true;
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    s.sup.config.paused = false;
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', branch: 'feature' });
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
  });

  it('merges past an index.lock that a stopped git left in its worktree', async () => {
    const s = mergeSetup();
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    // A git that swarmupd stopped for its timeout mid-write keeps the lock in swarmupd's worktree.
    const own = git(s.repo, 'worktree', 'list', '--porcelain')
      .split('\n\n')
      .map((b) => b.split('\n')[0]!.slice('worktree '.length))
      .find((p) => !samePath(p, s.repo) && !p.includes('wt'))!;
    const lock = join(git(own, 'rev-parse', '--absolute-git-dir'), 'index.lock');
    writeFileSync(lock, '');
    s.onMain('code.txt', 'three\n');
    const wt = join(temp(), 'wt-next');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature3', wt, 'main');
    writeFileSync(join(wt, 'next.txt'), 'next\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'Next work');
    const next = git(wt, 'rev-parse', 'HEAD');
    s.as('fake:engineer').start('2', 'plan');
    s.as('fake:engineer').review(
      '2',
      `${next.slice(0, 7)} on branch feature3: next`,
      'human:dawid',
    );
    s.as('human:dawid').verdict('2', 'approve', 'looks right');
    await s.merged();
    expect(s.as('human:dawid').showEvents('2').events.at(-1)).toMatchObject({
      type: 'merge',
      branch: 'feature3',
    });
    expect(existsSync(lock)).toBe(false);
  });

  it('blames a git timeout reading a later batch task on that task, and merges the first (AO-0381)', async () => {
    // `git rev-parse --verify -q <commit>^{commit}`, for the commit task 2's review names.
    const h = hangOn((args, commit) => {
      const rev = (args[3] ?? '').replace('^{commit}', '');
      return args[0] === 'rev-parse' && rev.length >= 7 && commit.startsWith(rev);
    }, '[ "$1" = rev-parse ] || return 1; rev=${4%%^*}; [ ${#rev} -ge 7 ] || return 1; ' + 'case $commit in "$rev"*) return 0;; esac; return 1');
    const s = mergeSetup({ gitTimeoutMs: h.timeout, env: h.env });
    await secondTimesOut(s, h.arm, /rev-parse/);
  });

  it('blames a git timeout rebasing a later batch task on that task, and merges the first (AO-0381)', async () => {
    const h = hangOn(
      (args, commit) => args[0] === 'checkout' && args.includes(commit),
      '[ "$1" = checkout ] || return 1; for a; do [ "$a" = "$commit" ] && return 0; done; return 1',
    );
    const s = mergeSetup({ gitTimeoutMs: h.timeout, env: h.env });
    await secondTimesOut(s, h.arm, /checkout/);
  });

  it('merges each task alone with batch 1 (AO-0381)', async () => {
    const s = mergeSetup({ batch: 1 });
    const t = twoApproved(s, 'second\n');
    await s.merged();
    await s.merged();

    expect(t.checks()).toBe('xx');
    expect(t.events('1').at(-1)).toMatchObject({ type: 'merge' });
    expect(t.events('2').at(-1)).toMatchObject({ type: 'merge' });
    expect(t.events('1').at(-1)!.body).not.toContain('batch');
  });

  it('merges again instead of sending the task back when the PC slept during the checks (AO-0151)', async () => {
    let slept = 0;
    const s = mergeSetup({ now: () => Date.now() + slept });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('nap\n'));
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'napped.txt')), STAGE_MS);
    // The PC sleeps for an hour; the check fails on wake.
    slept = 60 * 60_000;
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.sup.mergeSettled();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.as('human:dawid').view('1').status).toBe('done');
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /`node check\.mjs` failed \(exit 1\) after the PC slept or swarmupd stopped responding; merging again/,
    );
    // The next tick merges it from the start, and the check passes.
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(text(join(s.state, 'checks.txt'))).toBe('xx');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('nap\n');
  });

  it('builds again instead of sending the task back when the PC slept during the build (AO-0151)', async () => {
    let slept = 0;
    const s = mergeSetup({ now: () => Date.now() + slept });
    s.approve(s.branch('doze\n'));
    await s.sup.tick();
    await until(() => existsSync(join(s.state, 'dozed.txt')), STAGE_MS);
    slept = 60 * 60_000;
    writeFileSync(join(s.state, 'build-go.txt'), 'go\n');
    await s.sup.mergeSettled();
    const merged = s.last();
    expect(merged).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(merged.body).toContain(
      'Build: `node build.mjs` failed (exit 1) after the PC slept or swarmupd stopped responding; swarmupd runs the build again.',
    );
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    // The next tick runs the pending build.
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'comment', actor: MERGE_ACTOR });
    expect(s.last().body).toContain(
      'Built main with `node build.mjs` after the earlier build did not finish',
    );
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('doze\n');
    expect(s.as('human:dawid').view('1').status).toBe('done');
  });

  it('merges again, keeping the timeout retry, when a check times out as the PC wakes (AO-0170)', async () => {
    // As the AO-0165 merge: the PC sleeps during a check that hangs, and its timeout ends it on
    // wake. 0.05 min is 3 s. The clock jumps an hour from 500 ms into the check step, after the
    // command read its start time and before its timeout: under the full suite Node can take
    // longer than the 3 s to start the check, so waiting for the check's own output raced the
    // timeout (AO-0170 flake).
    let checksAt: number | null = null;
    const held: { sup?: { mergeStatus(): { step?: string } | null } } = {};
    const now = (): number => {
      const t = Date.now();
      if (checksAt === null && held.sup?.mergeStatus()?.step === 'checks') checksAt = t;
      return checksAt !== null && t - checksAt >= 500 ? t + 60 * 60_000 : t;
    };
    const s = mergeSetup({ timeoutMinutes: 0.05, now });
    held.sup = s.sup;
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('slow\n'));
    await s.sup.tick();
    await s.sup.mergeSettled();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /`node check\.mjs` failed \(timed out after \d+ min\) after the PC slept or swarmupd stopped responding; merging again/,
    );
    expect(warns.join('\n')).not.toContain('merges once more');

    // A timeout with no sleep still gets its one retry (AO-0172).
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /timed out after \d+ min; swarmupd stopped it and merges once more/,
    );
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge', actor: MERGE_ACTOR });
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('slow\n');
  });

  it('stops a check past its timeout, merges once more with the machine to itself, then tells the human and frees the checkout (AO-0172, AO-0385)', async () => {
    // 0.05 min is 3 s; the `slow` check waits for go.txt, which never comes.
    const s = mergeSetup({ timeoutMinutes: 0.05 });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('slow\n'));
    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(s.last()).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(warns.join('\n')).toMatch(
      /merge of test\/T-0001: `node check\.mjs` timed out after \d+ min; swarmupd stopped it and merges once more/,
    );

    // The retry runs with no new run beside it, and twice the time.
    const retry = s.merged();
    await until(() => s.sup.mergeStatus()?.step === 'checks', STAGE_MS);
    expect(s.sup.blocker('fake:engineer', 'test', { live: [] })).toMatch(
      /runs the merge checks of test\/T-0001 again, with no new runs beside them/,
    );
    await retry;
    expect(s.sup.merge).toBeNull();
    expect(s.sup.blocker('fake:engineer', 'test', { live: [] })).toBeNull();
    // One retry and no more. checks.txt counts only the checks that got as far as writing it
    // before their stop, and under the full suite Node can take longer than the 3 s to start:
    // an exact count of 2 failed the AO-0247 merge. So bound it instead.
    expect(warns.filter((w) => w.includes('merges once more'))).toHaveLength(1);
    const checks = join(s.state, 'checks.txt');
    expect(existsSync(checks) ? text(checks) : '').toMatch(/^x{0,2}$/);
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    // Not sent back to the author: the human hears of it, and the work stays approved.
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toContain('`node check.mjs` timed out twice');
    expect(e.body).toContain('was not sent back');
    expect(e.body).toContain('swarmupd.merge.test.timeout_minutes');
    expect(s.as('human:dawid').view('1').status).not.toBe('todo');
    expect(
      s
        .as('human:dawid')
        .showEvents('1')
        .events.some((x) => x.type === 'verdict' && x.verdict === 'changes'),
    ).toBe(false);

    // Nothing holds the checkout: a writing run starts there.
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    const end = ended(s.sup, run.id);
    writeFileSync(join(s.state, 'run-go.txt'), 'go\n');
    await end;
  });

  it('merges a branch that merged main to resolve its conflict, which a rebase would hit again', async () => {
    const s = mergeSetup();
    const first = s.branch('two\n');
    const before = s.onMain('code.txt', 'three\n');
    s.approve(first);
    await s.merged();
    expect(s.last().body).toContain(`it conflicts with main (${before.slice(0, 7)})`);

    // The author merges main into the branch, as the send-back says, and resolves the conflict.
    const wt = git(s.repo, 'worktree', 'list', '--porcelain')
      .split('\n\n')
      .find((b) => b.includes('branch refs/heads/feature'))!
      .split('\n')[0]!
      .slice('worktree '.length);
    try {
      git(wt, 'merge', '-q', 'main');
    } catch {
      // The conflict this test is about.
    }
    writeFileSync(join(wt, 'code.txt'), 'two and three\n');
    git(wt, 'add', 'code.txt');
    git(wt, 'commit', '-q', '--no-edit');
    const resolved = git(wt, 'rev-parse', 'HEAD');
    // A rebase replays `first` onto main and conflicts again; the merge takes the resolution.
    s.approve(resolved);
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(resolved);
    expect(text(join(s.repo, 'code.txt'))).toBe('two and three\n');
    expect(s.last().body).not.toContain('it conflicts with');
  });

  it('starts the fix of a merge conflict past the per-project limit and the review backlog', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    s.onMain('code.txt', 'three\n');
    s.approve(commit);
    await s.merged();
    expect(s.last().body).toContain('it conflicts with main');
    // No engineer may start in the project, yet the conflict fix of approved work is not held.
    s.sup.config.roles.engineer = { ...s.sup.config.roles.engineer, per_project: 0 };
    s.sup.config.agents['fake:engineer'] = { ...s.sup.config.agents['fake:engineer'], wake: true };
    // The test acted as fake:engineer itself; that counts as no session that may still work.
    s.sup.config.outside_session_minutes = 0;
    s.as('human:dawid').newTask({ title: 'New work', owner: 'fake:engineer' });
    const waits = s.sup.waits();
    const reasonsOf = (task: string): string =>
      waits
        .filter((w) => w.task === task)
        .map((w) => w.reason)
        .join('\n');
    // New work in the project waits for the limit; the conflict fix does not.
    expect(reasonsOf('test/T-0002')).toMatch(/per_project is 0/);
    expect(reasonsOf('test/T-0001')).toBe('starts at the next tick');
    expect(s.sup.blocker('fake:engineer', 'test', { live: [] })).toMatch(/per_project is 0/);
    expect(s.sup.blocker('fake:engineer', 'test', { live: [], finish: true })).toBeNull();
  });

  it('sends the task back on a check that timed out after a failed test, without merging once more (AO-0385)', async () => {
    // 0.25 min is 15 s; the `stuck` check prints a failed test, then waits for go.txt. Under load,
    // Node can take more than 3 s to start and print, which would read as a timeout with no output.
    const s = mergeSetup({ timeoutMinutes: 0.25 });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('stuck\n'));
    await s.merged();
    expect(s.sup.merge).toBeNull();
    expect(warns.join('\n')).not.toContain('merges once more');
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toMatch(
      /`node check\.mjs` failed \(timed out after \d+ min, after a failed test\)/,
    );
    expect(e.body).toContain('FAIL  test/a.test.ts > breaks');
  });

  it('gives a later review its own merge once more after a check timeout, when the earlier merge ended another way (AO-0172)', async () => {
    const s = mergeSetup({ timeoutMinutes: 0.01 });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const once = () => warns.filter((w) => w.includes('swarmupd stopped it and merges once more'));
    const commit = s.branch('slow\n');
    s.approve(commit);
    await s.merged();
    expect(once()).toHaveLength(1);

    // The merge once more ends on a conflict, before any check.
    s.onMain('code.txt', 'three\n');
    await s.merged();
    let e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('it conflicts with main');

    // A later review of the same work: its first check timeout gets its own merge once more.
    s.onMain('code.txt', 'one\n');
    s.approve(commit);
    await s.merged();
    expect(once()).toHaveLength(2);
    e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'approve' });
    expect(s.as('human:dawid').view('1').status).toBe('done');
  });

  it('stops a git command of the merge that never exits, with what it started, and tells the human (AO-0172)', async () => {
    // Probed before the merge starts, so the size check follows the merge's end at once.
    const treeStops = await stopsTrees();
    const s = mergeSetup({ gitTimeoutMs: hangOnly('rebase', '-q') });
    const beat = join(s.state, 'beat.txt').split(sep).join('/');
    // A pre-rebase hook that says why it waits, never ends by itself, and leaves a mark every
    // 100 ms.
    writeFileSync(
      join(s.repo, '.git', 'hooks', 'pre-rebase'),
      `#!/bin/sh\necho 'hook waits for the lock' >&2\nwhile [ ! -f "$MERGE_GO" ]; do printf x >> '${beat}'; sleep 0.1; done\nexit 1\n`,
      { mode: 0o755 },
    );
    const commit = s.branch('two\n');
    // main moves on, so the merge has to rebase and git runs the hook.
    const before = s.onMain('other.txt', 'other\n');
    s.approve(commit);
    await s.merged();

    expect(s.sup.merge).toBeNull();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    // Where the stop is refused, the note says the hook may still run instead (AO-0251).
    expect(e.body).toMatch(
      treeStops
        ? /swarmupd could not merge .+: `git rebase -q [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped it \(stage: rebase\)/
        : /swarmupd could not merge .+: `git rebase -q [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped (it|git, but what git started, such as a hook, may still run: .+) \(stage: rebase\)/,
    );
    // What it printed before the stop is in the note, and whole in the log.
    expect(e.body).toMatch(/Last output:\n\n```\n[^`]*hook waits for the lock/);
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log && text(log)).toContain('hook waits for the lock');
    expect(existsSync(beat)).toBe(true);
    if (treeStops) {
      // The hook was stopped with git: its marks stop.
      const size = statSync(beat).size;
      await new Promise((r) => setTimeout(r, 800));
      expect(statSync(beat).size).toBe(size);
    }
    // Where the stop could not reach the hook, this ends it.
    writeFileSync(join(s.state, 'go.txt'), 'go\n');

    // Nothing holds the checkout: a writing run starts there.
    const run = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    const end = ended(s.sup, run.id);
    writeFileSync(join(s.state, 'run-go.txt'), 'go\n');
    await end;
  });

  it('ends the merge on a fast-forward whose git never exits, without trying it again (AO-0172)', async () => {
    // A refused tree stop leaves the hook alive until the test releases it. A successful tree
    // stop kills the hook, so only the refused case can wait for its normal-exit marker.
    const treeStops = await stopsTrees();
    // Every ref update starts `sh` for the hook below, so `git worktree add` and `git checkout`
    // in the rebase stage take seconds under the full suite on Windows: only the fast-forward
    // gets the short timeout.
    const s = mergeSetup({ gitTimeoutMs: hangOnly('merge', '-q', '--ff-only') });
    const warns: string[] = [];
    s.sup.on('warn', (m: string) => warns.push(m));
    const beat = join(s.state, 'beat.txt').split(sep).join('/');
    const left = join(s.state, 'left.txt').split(sep).join('/');
    // Hangs while git updates main: the fast-forward in the checkout, not the rebase.
    writeFileSync(
      join(s.repo, '.git', 'hooks', 'reference-transaction'),
      [
        '#!/bin/sh',
        '[ "$1" = prepared ] || exit 0',
        "grep -q 'refs/heads/main' || exit 0",
        `while [ ! -f "$MERGE_GO" ]; do printf x >> '${beat}'; sleep 0.1; done`,
        `: > '${left}'`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const before = git(s.repo, 'rev-parse', 'main');
    s.approve(s.branch('two\n'));
    await s.merged();

    expect(s.sup.merge).toBeNull();
    expect(readFileSync(join(s.repo, '.git', 'refs', 'heads', 'main'), 'utf8').trim()).toBe(before);
    // The merge ends on the timeout. Tried again, it ends on a refusal instead: the killed git
    // leaves main.lock, so later attempts fail fast. A wall-clock bound flaked under the full suite.
    const e = s.last();
    expect(e).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, to: 'human:dawid' });
    expect(e.body).toMatch(
      /`git merge -q --ff-only [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped (it|git, but what git started, such as a hook, may still run: .+) \(stage: fast-forward\)/,
    );
    expect(warns.join('\n')).not.toMatch(/kept moving|did not move/);
    writeFileSync(join(s.state, 'go.txt'), 'go\n');
    if (!treeStops) await until(() => existsSync(left), 30_000);
  });

  it('says what git started may still run when the stop of a timed-out git is refused (AO-0251)', async () => {
    const repo = temp();
    const state = temp();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'code.txt'), 'one\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'one');
    const from = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'work');
    writeFileSync(join(repo, 'code.txt'), 'two\n');
    git(repo, 'commit', '-q', '-am', 'two');
    const to = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    const beat = join(state, 'beat.txt').split(sep).join('/');
    const go = join(state, 'go.txt').split(sep).join('/');
    const left = join(state, 'left.txt').split(sep).join('/');
    // Hangs while git updates main, leaves a mark every 100 ms until `go.txt` exists, and writes
    // `left.txt` as it leaves the loop.
    writeFileSync(
      join(repo, '.git', 'hooks', 'reference-transaction'),
      [
        '#!/bin/sh',
        '[ "$1" = prepared ] || exit 0',
        "grep -q 'refs/heads/main' || exit 0",
        `while [ ! -f '${go}' ]; do printf x >> '${beat}'; sleep 0.1; done`,
        `: > '${left}'`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const refused = '`taskkill /T` exited 1: Access is denied.';
    const merge = new MergeRepo(
      repo,
      join(state, 'wt'),
      [],
      { ...process.env, ...ID },
      hangOnly('merge', '-q', '--ff-only'),
      // As where a sandbox refuses `taskkill /T`: nothing under git is stopped.
      () => Promise.resolve(refused),
    );

    const err = await merge.fastForward('main', from, to).catch((e: unknown) => e as Error);

    try {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      // No claim that the tree stopped; the reason is in the message.
      expect(message).toMatch(
        /`git merge -q --ff-only [0-9a-f]+` in .+ timed out after 4 s; swarmupd stopped git, but what git started, such as a hook, may still run: /,
      );
      expect(message).toContain(refused);
      expect(message).not.toContain('swarmupd stopped it');
      // The hook did outlive the merge's git: its marks go on. Under full-suite load Git Bash
      // can take well over 15 s to fork the next `printf` (AO-0251 failed there).
      await until(() => existsSync(beat), 45_000);
      const size = statSync(beat).size;
      await until(() => statSync(beat).size > size, 45_000);
    } finally {
      // Ends the hook, so nothing has to kill it. Under full-suite load Git Bash forks slowly, so
      // a pause in the marks does not mean the hook ended, and its `sh` still held the repo when
      // the cleanup removed it (EPERM, AO-0351). Waits for the hook to leave its loop and to let go
      // of both folders.
      writeFileSync(go, 'go\n');
      await until(() => existsSync(left), 30_000);
      await until(() => removed(repo) && removed(state), 30_000);
    }
  }, 180_000);
});
