import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  artifactKindOf,
  changedArtifacts,
  checkArtifacts,
  evidenceNotes,
  namedArtifacts,
  publishTarget,
  workspacePath,
} from '../src/index.js';
import type { GitRunSync, ReviewArtifact } from '../src/index.js';
import { git, gitRepo, setup } from './helpers.js';

// Publish tasks are a person's (W8), `swarmup published` records a publish, and review events
// carry artifacts.

function gitRun(dir: string): GitRunSync {
  return (args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

function commitFiles(dir: string, files: Record<string, string>, message = 'work'): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

describe('publish tasks', () => {
  it('belong to the human when filed without an owner, and refuse an agent owner without --force', () => {
    const { as } = setup();
    const t = as('human:dawid').addTask({ title: 'Post the thread', type: 'publish' });
    expect(t.meta.owner).toBe('human:dawid');
    expect(() =>
      as('human:dawid').addTask({ title: 'Post it', type: 'publish', owner: 'claude:writer' }),
    ).toThrow(/claude:writer cannot own a publish task: only a person publishes/);
    const forced = as('human:dawid', { force: true }).addTask({
      title: 'Post it',
      type: 'publish',
      owner: 'claude:writer',
    });
    expect(forced.meta.owner).toBe('claude:writer');
    expect(forced.meta.owner_forced).toBe(true);
  });

  it('refuse an agent as assignee, new owner or claimer unless --force, which the event records', () => {
    const { as } = setup();
    as('human:dawid').addTask({ title: 'Post the thread', type: 'publish' });
    expect(() => as('human:dawid').assign('1', 'claude:writer')).toThrow(
      /claude:writer cannot own T-0001: a publish task is a person's/,
    );
    expect(() => as('human:dawid').handoff('1', 'codex:editor', 'yours')).toThrow(
      /cannot own T-0001/,
    );
    as('human:dawid').assign('1', 'human:ana');
    const forced = as('human:dawid', { force: true }).assign('1', 'claude:writer');
    expect(forced.events.at(-1)).toMatchObject({
      type: 'assign',
      to: 'claude:writer',
      forced: true,
    });
    expect(() => as('claude:writer').claim('1')).toThrow(/claude:writer cannot claim T-0001/);
    const claimed = as('claude:writer', { force: true }).claim('1');
    expect(claimed.events.find((e) => e.type === 'claim')?.forced).toBe(true);
  });

  it('close when a person records the publish, and the event keeps where and what', () => {
    const { as } = setup();
    as('human:dawid').addTask({ title: 'Post the thread', type: 'publish' });
    const res = as('human:dawid').published('1', {
      url: 'https://x.com/swarmup/status/1',
      commit: 'a'.repeat(40),
      path: 'posts/x-thread.md',
      blob: 'b'.repeat(40),
      tag: 'published/T-0001',
    });
    expect(res.view.status).toBe('done');
    expect(res.events.map((e) => e.type)).toEqual(['publish', 'done']);
    expect(res.events[0]).toMatchObject({
      url: 'https://x.com/swarmup/status/1',
      commit: 'a'.repeat(40),
      path: 'posts/x-thread.md',
      blob: 'b'.repeat(40),
      tag: 'published/T-0001',
      actor: 'human:dawid',
    });
  });

  it('refuse a publish record from an agent, from inside a run, or without a web URL', () => {
    const { as } = setup();
    as('human:dawid').addTask({ title: 'Draft', type: 'content', owner: 'claude:writer' });
    expect(() => as('claude:writer').published('1', { url: 'https://x.com/1' })).toThrow(
      /only a person records a publish/,
    );
    expect(() =>
      as('human:dawid', { run: 'R1' }).published('1', { url: 'https://x.com/1' }),
    ).toThrow(/run R1 cannot/);
    expect(() => as('human:dawid').published('1', { url: 'x.com/1' })).toThrow(/no http\(s\) URL/);
    // Any task may carry a publish record; only a publish task closes with it.
    const res = as('human:dawid').published('1', { url: 'https://x.com/1' });
    expect(res.events.map((e) => e.type)).toEqual(['publish']);
    expect(res.view.status).toBe('todo');
  });
});

describe('publishTarget', () => {
  it('tags the commit published/<ID>, keeps the tag for the same commit, and numbers a new one', async () => {
    const repo = gitRepo();
    const first = commitFiles(repo, { 'posts/x.md': 'one' });
    const run = gitRun(repo);
    const t = await publishTarget(async (a) => run(a), 'LC-0010', { path: 'posts/x.md' });
    expect(t).toMatchObject({ commit: first, path: 'posts/x.md', tag: 'published/LC-0010' });
    expect(t.blob).toBe(git(repo, 'rev-parse', 'HEAD:posts/x.md').trim());
    expect((await publishTarget(async (a) => run(a), 'LC-0010')).tag).toBe('published/LC-0010');
    commitFiles(repo, { 'posts/x.md': 'two' });
    expect((await publishTarget(async (a) => run(a), 'LC-0010')).tag).toBe('published/LC-0010-2');
    await expect(
      publishTarget(async (a) => run(a), 'LC-0010', { path: 'posts/none.md' }),
    ).rejects.toThrow(/not in/);
    await expect(
      publishTarget(async (a) => run(a), 'LC-0010', { path: '../x.md' }),
    ).rejects.toThrow(/outside/);
  });
});

describe('review artifacts', () => {
  it('round-trip on the review event, and refuse bad ones', () => {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'Thread', type: 'content', owner: 'claude:writer' });
    const w = as('claude:writer');
    w.start('1', 'draft');
    const artifacts: ReviewArtifact[] = [
      { kind: 'file', ref: 'posts/x-thread.md', blob: 'c'.repeat(40), label: 'the thread' },
      { kind: 'url', ref: 'https://example.com/preview' },
    ];
    const res = w.review('1', 'T-0001: thread drafted', undefined, undefined, {
      source: { commit: 'd'.repeat(40), branch: 'claude/t-0001', repo: 'code', artifacts },
    });
    expect(res.events[0]!.artifacts).toEqual(artifacts);
    expect(as('human:dawid').showEvents('1').events.at(-1)!.artifacts).toEqual(artifacts);
    expect(() => checkArtifacts([{ kind: 'video' as 'file', ref: 'a' }])).toThrow(/kind must be/);
    expect(() => checkArtifacts([{ kind: 'file', ref: ' ' }])).toThrow(/needs a ref/);
    expect(() => checkArtifacts([{ kind: 'file', ref: 'a\nb' }])).toThrow(/one line/);
    expect(() => checkArtifacts([{ kind: 'file', ref: 'a', blob: 'xyz' }])).toThrow(
      /git object id/,
    );
  });

  it('name artifacts instead of commands in the evidence note of a task with no command', () => {
    const lines = ['voice (rubric)'];
    expect(evidenceNotes('drafted', lines, { commands: false, artifacts: 0 })[0]).toMatch(
      /names no artifact: pass --artifact/,
    );
    expect(evidenceNotes('drafted', lines, { commands: false, artifacts: 2 })).toEqual([]);
    expect(evidenceNotes('drafted', lines, { commands: true, artifacts: 2 })[0]).toMatch(
      /no command/,
    );
  });

  it('check named paths against the commit, and record changed files minus the map', async () => {
    const repo = gitRepo();
    commitFiles(repo, { 'README.md': 'x' }, 'base');
    git(repo, 'checkout', '-qb', 'claude/lc-4');
    const head = commitFiles(repo, {
      'posts/x-thread.md': 'thread',
      'assets/og/card.png': 'png',
      '.swarmup/map/posts.md': 'node',
    });
    const run = gitRun(repo);
    const changed = await changedArtifacts(run, head, ['main']);
    expect(changed.map((a) => `${a.kind}:${a.ref}`)).toEqual([
      'image:assets/og/card.png',
      'file:posts/x-thread.md',
    ]);
    expect(changed.every((a) => a.blob && a.blob.length === 40)).toBe(true);
    const named = await namedArtifacts(
      run,
      ['posts/x-thread.md', 'https://docs.google.com/document/d/1'],
      {
        commit: head,
        toTop: (p) => p,
      },
    );
    expect(named.map((a) => a.kind)).toEqual(['file', 'doc']);
    expect(() =>
      namedArtifacts(run, ['posts/missing.md'], { commit: head, toTop: (p) => p }),
    ).toThrow(/posts\/missing\.md is not in/);
    expect(() =>
      namedArtifacts(run, ['posts/new.md'], { toTop: (p) => p, exists: () => false }),
    ).toThrow(/no such file/);
  });

  it('keep paths inside the workspace and tell kinds apart', () => {
    expect(workspacePath('./posts\\x.md')).toBe('posts/x.md');
    expect(workspacePath('posts/../facts/claims.md')).toBe('facts/claims.md');
    expect(() => workspacePath('../secret.txt')).toThrow(/outside the workspace/);
    expect(() => workspacePath('/etc/passwd')).toThrow(/inside the workspace/);
    expect(() => workspacePath('C:/Windows/win.ini')).toThrow(/inside the workspace/);
    expect(artifactKindOf('assets/a.PNG')).toBe('image');
    expect(artifactKindOf('https://news.ycombinator.com/item?id=1')).toBe('url');
    expect(artifactKindOf('https://www.notion.so/page')).toBe('doc');
  });
});
