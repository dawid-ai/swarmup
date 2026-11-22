import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, MERGE_ACTOR, samePath, Workspace } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import {
  invocation,
  RUN_DENIED_STORE_DIRS,
  runDeniedDirs,
  runPrompt,
  startApi,
  Supervisor,
} from '../src/index.js';
import { mergeSetup } from './merge-setup.js';
import { ended, setup as supSetup } from './supervisor-setup.js';

// Non-code projects (W8) in swarmupd: worktrees by `workspace_types`, the run deny list, publish
// tasks at merge, review artifacts in the prompt, and the publish and artifact API routes.

const ID = {
  GIT_AUTHOR_NAME: 'Swarmupd Test',
  GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
  GIT_COMMITTER_NAME: 'Swarmupd Test',
  GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...ID },
  }).trim();

const dirs: string[] = [];
const sups: Supervisor[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  const shut = closers.splice(0);
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const c of shut) await c();
    for (const s of mine) await s.close();
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-w8-'));
  dirs.push(d);
  return d;
}

describe('workspace_types', () => {
  it('gives a run a worktree for the types the root names, and none for the others', async () => {
    const s = supSetup({
      env: ID,
      opsd: { task_worktrees: true, roles: { engineer: { per_project: 2 } } },
    });
    appendFileSync(join(s.repo, '.swarmup', 'config.yml'), 'workspace_types: [task, content]\n');
    const h = s.as('human:dawid');
    h.newTask({ title: 'Draft the thread', type: 'content', owner: 'fake:engineer' });
    h.newTask({ title: 'Fix a typo in the notes', type: 'docs', owner: 'fake:engineer' });
    writeFileSync(join(s.repo, '.gitignore'), 'out/\n');
    git(s.repo, 'add', '-A');
    git(s.repo, 'commit', '-qm', 'start');
    const content = s.sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(samePath(content.cwd, join(s.repo, 'out', 'wt-T-0001'))).toBe(true);
    await ended(s.sup, content.id);
    const docs = s.sup.launch({ agent: 'fake:engineer', task: '2' });
    expect(samePath(docs.cwd, s.repo)).toBe(true);
    await ended(s.sup, docs.id);
  });
});

describe('the run deny list', () => {
  it("covers the store's rubrics, workflows and triggers next to agents and variants", () => {
    expect(RUN_DENIED_STORE_DIRS).toEqual([
      'agents',
      'variants',
      'rubrics',
      'workflows',
      'triggers',
    ]);
    const store = join(tmpdir(), 'store', '.swarmup');
    const args = invocation(
      { command: 'claude' },
      'claude:writer',
      undefined,
      '/w',
      [],
      runDeniedDirs(store),
    ).args;
    const denied = args[args.indexOf('--disallowedTools') + 1]!;
    for (const d of RUN_DENIED_STORE_DIRS) {
      expect(denied, d).toMatch(new RegExp(`Edit\\([^)]*${d}[^)]*\\)`));
      expect(denied, d).toMatch(new RegExp(`Write\\([^)]*${d}[^)]*\\)`));
    }
  });
});

describe('publish tasks at merge', () => {
  it('merge nothing for an approved publish task, and say so', async () => {
    const s = mergeSetup({ userMerge: true });
    const human = s.as('human:dawid');
    human.newTask({ title: 'Post the thread', type: 'publish' });
    const commit = s.branch('two\n');
    human.start('3', 'posting');
    human.review('3', 'T-0003: posted', 'human:ana', undefined, {
      source: { commit, branch: 'feature', repo: 'code' },
    });
    s.as('human:ana').verdict('3', 'approve', 'done');
    await s.merged();
    const last = human.showEvents('3').events.at(-1)!;
    expect(last).toMatchObject({ type: 'comment', actor: MERGE_ACTOR, no_merge: true });
    expect(last.body).toContain('a publish task changes no files');
    // The code of the branch stays out of main.
    expect(git(s.repo, 'show', 'main:code.txt')).toBe('one');
  });
});

describe('the review prompt', () => {
  it('lists the artifacts with the command that shows each file at the commit', () => {
    const commit = 'a'.repeat(40);
    const prompt = runPrompt({
      agent: 'codex:editor',
      task: 'LC-0004',
      review: true,
      artifacts: {
        commit,
        items: [
          { kind: 'file', ref: 'posts/x-thread.md', label: 'the thread' },
          { kind: 'url', ref: 'https://example.com/preview' },
        ],
      },
    });
    expect(prompt).toContain(
      'The work to read at aaaaaaaaaa (`swarmup artifact LC-0004` lists it)',
    );
    expect(prompt).toContain(
      '1. file `posts/x-thread.md` (the thread): `git show aaaaaaaaaa:posts/x-thread.md`',
    );
    expect(prompt).toContain('2. url https://example.com/preview');
  });
});

describe('publish and artifact routes', () => {
  function liveMap(sup: Supervisor): Map<string, { record: RunRecord }> {
    return (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
  }

  async function apiSetup() {
    const repo = temp();
    git(repo, 'init', '-q', '-b', 'main');
    initRoot(repo, { name: 'test', human: 'human:dawid' });
    mkdirSync(join(repo, 'posts'), { recursive: true });
    mkdirSync(join(repo, 'assets'), { recursive: true });
    writeFileSync(join(repo, 'posts', 'x.md'), 'Old words here.\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'base');
    const userConfig = join(temp(), 'config.yml');
    writeFileSync(userConfig, 'me: human:dawid\nopsd:\n  sync: false\n');
    const env = {
      ...process.env,
      ...ID,
      SWARMUP_CONFIG: userConfig,
      SWARMUP_STATE_DIR: temp(),
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    delete env.SWARMUP_RUN_TOKEN;
    const sup = new Supervisor({
      env,
      cwd: repo,
      user: { me: 'human:dawid' },
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(sup);
    const api = await startApi(sup, { port: 0, token: 'full-token', version: 't', build: '1' });
    closers.push(api.close);
    const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json()) as Record<string, unknown> };
    };
    const as = (actor: string) => new Workspace({ cwd: repo, env, actor, user: {} });
    const registerRun = (token: string): void => {
      const record: RunRecord = {
        id: 'RUN-ONE',
        agent: 'fake:engineer',
        project: 'test',
        pid: 1,
        image: 'fake',
        command: 'fake',
        cwd: repo,
        log: sup.store.logPath('RUN-ONE'),
        started_at: new Date().toISOString(),
        status: 'running',
        budget_minutes: 60,
        tokens: 0,
        token_sha256: createHash('sha256').update(token).digest('hex'),
      };
      sup.store.save(record);
      liveMap(sup).set(record.id, { record });
    };
    return { repo, sup, call, as, registerRun };
  }

  it('records a publish for a person, tags the workspace, and refuses a run with 403', async () => {
    const { repo, call, as, registerRun, sup } = await apiSetup();
    as('human:dawid').newTask({ title: 'Post it', type: 'publish' });
    registerRun('run-token');
    const refused = await call('run-token', 'POST', '/api/tasks/T-0001/published', {
      url: 'https://x.com/s/1',
    });
    expect(refused.status).toBe(403);
    expect(String(refused.data.error)).toMatch(/recording a publish is for the human/);
    liveMap(sup).clear();
    const res = await call('full-token', 'POST', '/api/tasks/T-0001/published', {
      as: 'human:dawid',
      url: 'https://x.com/s/1',
      artifact: 'posts/x.md',
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      tag: 'published/T-0001',
      path: 'posts/x.md',
      url: 'https://x.com/s/1',
    });
    expect((res.data.task as { status: string }).status).toBe('done');
    expect(git(repo, 'rev-parse', 'published/T-0001')).toBe(git(repo, 'rev-parse', 'HEAD'));
    const event = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'publish')!;
    expect(event).toMatchObject({
      url: 'https://x.com/s/1',
      path: 'posts/x.md',
      actor: 'human:dawid',
    });
    expect(event.blob).toBe(git(repo, 'rev-parse', 'HEAD:posts/x.md'));
  });

  it('serves a reviewed file at its commit with its base, an image as data, and refuses paths outside', async () => {
    const { repo, call, as } = await apiSetup();
    as('human:dawid').newTask({ title: 'Thread', type: 'content', owner: 'fake:engineer' });
    git(repo, 'checkout', '-qb', 'fake/t-0001');
    writeFileSync(join(repo, 'posts', 'x.md'), 'New words here.\n');
    writeFileSync(join(repo, 'assets', 'card.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'draft');
    const commit = git(repo, 'rev-parse', 'HEAD');
    const eng = as('fake:engineer');
    eng.start('1', 'draft');
    eng.review('1', 'T-0001: drafted', 'human:dawid', undefined, {
      source: {
        commit,
        branch: 'fake/t-0001',
        repo: 'code',
        artifacts: [
          { kind: 'file', ref: 'posts/x.md' },
          { kind: 'image', ref: 'assets/card.png' },
        ],
      },
    });
    const text = await call('full-token', 'GET', '/api/tasks/T-0001/artifact?path=posts/x.md');
    expect(text.status).toBe(200);
    expect(text.data).toMatchObject({ kind: 'text', commit, text: 'New words here.\n' });
    expect((text.data.base as { text: string }).text).toBe('Old words here.\n');
    const image = await call(
      'full-token',
      'GET',
      '/api/tasks/T-0001/artifact?path=assets%2Fcard.png',
    );
    expect(image.data).toMatchObject({ kind: 'image', bytes: 7 });
    expect(String(image.data.data)).toMatch(/^data:image\/png;base64,/);
    const outside = await call(
      'full-token',
      'GET',
      '/api/tasks/T-0001/artifact?path=..%2Fsecret.txt',
    );
    expect(outside.status).toBe(400);
    expect(String(outside.data.error)).toMatch(/outside the workspace/);
    const missing = await call(
      'full-token',
      'GET',
      '/api/tasks/T-0001/artifact?path=posts/none.md',
    );
    expect(missing.status).toBe(404);
  });
});
