// The diff of the commits a task's review names, read from the local repo (AO-0106).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, MERGE_ACTOR } from '@swarmup/core';
import type { TaskDiff } from '../src/index.js';
import { mergedWork, parseFiles, splitPatch, startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// As in the other API tests: the hook takes this test's supervisors and folders before it awaits.
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
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-diff-'));
  dirs.push(d);
  return d;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, windowsHide: true, encoding: 'utf8' },
  ).trim();

async function setup() {
  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(repo, 'old name.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  writeFileSync(join(repo, 'gone.md'), '# Gone\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Start');
  const config = join(temp(), 'config.yml');
  writeFileSync(config, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = {
    ...process.env,
    SWARMUP_CONFIG: config,
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'diff-token', version: 't', build: '1' });
  const get = async (ref: string) => {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/tasks/${ref}/diff`, {
      headers: { authorization: 'Bearer diff-token' },
    });
    return { status: res.status, data: (await res.json()) as TaskDiff & { error?: string } };
  };
  /** A task of claude:engineer in review, with `text` as its review request. */
  const inReview = (text: string): string => {
    const t = sup.ws('human:dawid').newTask({ title: 'Work', owner: 'claude:engineer' });
    const ws = sup.ws('claude:engineer');
    ws.start(t.id, 'plan');
    ws.review(t.id, text, 'human:dawid');
    return t.id;
  };
  return { sup, repo, get, inReview };
}

/** A branch with two commits: a change, an added file, a rename, a deletion and a binary file. */
function work(repo: string): string {
  git(repo, 'checkout', '-q', '-b', 'claude/work');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\nexport const b = 3;\n');
  writeFileSync(join(repo, 'new.ts'), 'export const n = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Change b');
  renameSync(join(repo, 'old name.txt'), join(repo, 'new name.txt'));
  rmSync(join(repo, 'gone.md'));
  writeFileSync(join(repo, 'pic.bin'), Buffer.from([0, 1, 2, 0, 255, 254, 0, 3]));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'Rename, delete, add a binary');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  return head;
}

describe('GET /api/tasks/<id>/diff', () => {
  it('shows the commits and files of the branch a review names, against the base', async () => {
    const { repo, get, inReview } = await setup();
    const head = work(repo);
    // The base moves on after the branch left it: its change is not part of the work.
    writeFileSync(join(repo, 'base.txt'), 'later\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'Base moves');
    const id = inReview(`${head.slice(0, 7)} on branch \`claude/work\`: changes b.`);

    const { status, data } = await get(id);
    expect(status).toBe(200);
    expect(data.merged).toBe(false);
    expect(data.base).toBe('main');
    expect(data.to).toBe(head);
    expect(data.source).toEqual({ commit: head.slice(0, 7), branch: 'claude/work' });
    expect(data.commits.map((c) => c.subject)).toEqual([
      'Change b',
      'Rename, delete, add a binary',
    ]);
    const byPath = Object.fromEntries(data.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual([
      'a.ts',
      'gone.md',
      'new name.txt',
      'new.ts',
      'pic.bin',
    ]);
    expect(byPath['a.ts']).toMatchObject({ status: 'modified', added: 1, deleted: 1 });
    expect(byPath['a.ts']!.patch).toMatch(/^@@ -1,2 \+1,2 @@/);
    expect(byPath['a.ts']!.patch).toContain('-export const b = 2;\n+export const b = 3;\n');
    expect(byPath['new.ts']).toMatchObject({ status: 'added', added: 1, deleted: 0 });
    expect(byPath['gone.md']).toMatchObject({ status: 'deleted', deleted: 1 });
    expect(byPath['gone.md']!.patch).toContain('-# Gone');
    expect(byPath['new name.txt']).toMatchObject({ status: 'renamed', old: 'old name.txt' });
    expect(byPath['new name.txt']!.patch).toBeUndefined();
    expect(byPath['pic.bin']).toMatchObject({ status: 'added', binary: true, added: 0 });
    expect(byPath['pic.bin']!.patch).toBeUndefined();
  });

  it('shows what the base got once swarmupd merged the work', async () => {
    const { sup, repo, get, inReview } = await setup();
    const onto = git(repo, 'rev-parse', 'HEAD');
    const head = work(repo);
    const id = inReview(`${head.slice(0, 7)} on branch claude/work: changes b.`);
    // The source branch is gone after the merge; the merge event still names the commits.
    git(repo, 'merge', '-q', '--ff-only', 'claude/work');
    git(repo, 'branch', '-q', '-D', 'claude/work');
    sup.ws('human:dawid').verdict(id, 'approve', 'ok');
    sup
      .ws(MERGE_ACTOR)
      .recordMerge(
        id,
        { commit: head, into: 'main', branch: 'claude/work' },
        `Merged ${head.slice(0, 7)} on branch claude/work into main as ${head.slice(0, 7)}, rebased onto ${onto.slice(0, 7)} (5 file(s)).`,
      );

    const { status, data } = await get(id);
    expect(status).toBe(200);
    expect(data).toMatchObject({ merged: true, base: 'main', from: onto, to: head });
    expect(data.files).toHaveLength(5);
    expect(data.commits).toHaveLength(2);
  });

  it('shows a named commit alone when the base already has it', async () => {
    const { repo, get, inReview } = await setup();
    const head = work(repo);
    git(repo, 'merge', '-q', '--ff-only', 'claude/work');
    const id = inReview(`${head.slice(0, 7)} on branch claude/work: changes b.`);

    const { status, data } = await get(id);
    expect(status).toBe(200);
    expect(data.note).toMatch(/main already has/);
    expect(data.files.map((f) => f.path).sort()).toEqual(['gone.md', 'new name.txt', 'pic.bin']);
  });

  it('answers 404 with the reason when no review names work in the repo', async () => {
    const { sup, get, inReview } = await setup();
    const none = sup.ws('human:dawid').newTask({ title: 'No review' });
    const a = await get(none.id);
    expect(a.status).toBe(404);
    expect(a.data.error).toMatch(/No review request yet/);

    const b = await get(inReview('The notes are in docs/notes.md.'));
    expect(b.status).toBe(404);
    expect(b.data.error).toMatch(/names a commit or a branch/);

    const c = await get(inReview('0123abc on branch claude/nowhere: done.'));
    expect(c.status).toBe(404);
    expect(c.data.error).toMatch(/Commit 0123abc is not in the repo/);
  });
});

describe('diff parsing', () => {
  it('reads renames and binary files from numstat and name-status', () => {
    const files = parseFiles(
      '1\t1\ta.ts\x000\t0\t\0old name.txt\0new name.txt\0-\t-\tpic.bin\0',
      'M\0a.ts\0R100\0old name.txt\0new name.txt\0A\0pic.bin\0',
    );
    expect(files).toEqual([
      { path: 'a.ts', status: 'modified', added: 1, deleted: 1 },
      { path: 'new name.txt', old: 'old name.txt', status: 'renamed', added: 0, deleted: 0 },
      { path: 'pic.bin', status: 'added', added: 0, deleted: 0, binary: true },
    ]);
  });

  it('splits a patch by file, and keeps a hunk line that looks like a header', () => {
    const text = [
      'diff --git a/x y.txt b/x y.txt',
      'index 1..2 100644',
      '--- a/x y.txt\t',
      '+++ b/x y.txt\t',
      '@@ -1 +1 @@',
      '-old',
      '+--- a/not a header',
      'diff --git a/b.bin b/b.bin',
      'Binary files a/b.bin and b/b.bin differ',
      'diff --git a/gone b/gone',
      'deleted file mode 100644',
      '--- a/gone',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n');
    const got = splitPatch(text);
    expect([...got.keys()]).toEqual(['x y.txt', 'gone']);
    expect(got.get('x y.txt')).toBe('@@ -1 +1 @@\n-old\n+--- a/not a header\n');
    expect(got.get('gone')).toBe('@@ -1 +0,0 @@\n-bye\n');
  });

  it('reads the merge after the newest review only', () => {
    const merge = {
      type: 'merge',
      actor: MERGE_ACTOR,
      commit: 'abc1234',
      into: 'main',
      body: 'Merged x into main as abc1234, rebased onto 0def567 (1 file(s)).',
    };
    const review = { type: 'review', actor: 'claude:engineer', body: 'again' };
    expect(mergedWork([review, merge])).toMatchObject({ commit: 'abc1234', onto: '0def567' });
    expect(mergedWork([merge, review])).toBeNull();
  });
});
