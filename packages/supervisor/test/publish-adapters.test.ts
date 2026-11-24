import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GitRun } from '@swarmup/core';
import { checkMcpConfig, initRoot, setSecret, Workspace } from '@swarmup/core';
import type { AdapterOutcome, PublishConfig, PublishRunners } from '../src/index.js';
import {
  checkPublishConfig,
  mcpArguments,
  opsdConfig,
  publishWithAdapter,
  recordableUrl,
  taskAdapter,
  taskApprovedFiles,
  taskPreview,
  urlFromOutput,
} from '../src/index.js';

// Publish adapters (W8 phase 3): `swarmupd.publish.<root>.<name>` checked, the attempt recorded
// before the adapter runs and refused for the same files, and the command and MCP adapters run
// for real against a script and a fake MCP server.

const ID = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-publish-test-'));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...ID },
  }).trim();
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * A root whose workspace is its own repo: a content task T-0001 approved with `posts/x.md`, and a
 * publish task T-0002 that waits on it and names the adapter `blog`.
 */
function setup(labels = ['publish:blog']) {
  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const head = commit(repo, { 'posts/x.md': '# Launch\n\nThe approved words.\n' }, 'draft');
  const env = {
    ...process.env,
    ...ID,
    SWARMUP_CONFIG: join(temp(), 'config.yml'),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_RUN_TOKEN;
  delete env.SWARMUP_RUN;
  const as = (actor: string, run?: string) =>
    new Workspace({ cwd: repo, env, actor, user: {}, ...(run ? { run } : {}) });
  const h = as('human:dawid');
  h.newTask({ title: 'Draft the post', type: 'content', owner: 'claude:writer' });
  const w = as('claude:writer');
  w.start('1', 'draft');
  w.review('1', 'T-0001: drafted', 'human:dawid', undefined, {
    source: {
      commit: head,
      branch: 'main',
      repo: 'code',
      artifacts: [
        { kind: 'file', ref: 'posts/x.md', blob: git(repo, 'rev-parse', `${head}:posts/x.md`) },
      ],
    },
  });
  h.verdict('1', 'approve', 'good');
  h.newTask({ title: 'Publish the post', type: 'publish', blockedBy: ['T-0001'], labels });
  const gitRun: GitRun = async (args) => git(repo, ...args);
  return { repo, env, as, head, gitRun };
}

const PUBLISH: PublishConfig = { test: { blog: { kind: 'command', run: 'never-run' } } };

function fakeCommand(outcome: AdapterOutcome) {
  const calls: Array<{ files: string[]; commit: string; task: string }> = [];
  const runners: PublishRunners = {
    command: async (_a, input) => {
      calls.push({ files: input.files.map((f) => f.path), commit: input.commit, task: input.task });
      return outcome;
    },
  };
  return { calls, runners };
}

describe('swarmupd.publish', () => {
  it('checks adapters per root and name', () => {
    expect(
      checkPublishConfig({
        launch: {
          blog: { kind: 'command', run: 'node post.mjs', env: { T: { secret: 'BLOG' } } },
          x: { kind: 'mcp', server: 'x-poster', tool: 'post', arguments: { text: '{content}' } },
          hand: { kind: 'manual' },
        },
      }),
    ).toEqual({
      launch: {
        blog: { kind: 'command', run: 'node post.mjs', env: { T: { secret: 'BLOG' } } },
        x: { kind: 'mcp', server: 'x-poster', tool: 'post', arguments: { text: '{content}' } },
        hand: { kind: 'manual' },
      },
    });
    expect(() => checkPublishConfig({ l: { a: { kind: 'ftp' } } })).toThrow(/kind: use manual/);
    expect(() => checkPublishConfig({ l: { a: { kind: 'command' } } })).toThrow(/a\.run/);
    expect(() => checkPublishConfig({ l: { a: { kind: 'mcp', server: 'x' } } })).toThrow(/tool/);
    expect(() => checkPublishConfig({ l: { A: { kind: 'manual' } } })).toThrow(/lowercase/);
    expect(() => checkPublishConfig({ l: { a: { kind: 'manual', nope: 1 } } })).toThrow(
      /unknown key nope/,
    );
    expect(() =>
      checkPublishConfig({ l: { a: { kind: 'mcp', server: 'x', tool: 't', env: {} } } }),
    ).toThrow(/only a command adapter takes env/);
    expect(
      opsdConfig({ swarmupd: { publish: { l: { a: { kind: 'manual' } } } } } as never).publish,
    ).toEqual({ l: { a: { kind: 'manual' } } });
  });

  it('reads the adapter label, the url line and the MCP argument placeholders', () => {
    expect(taskAdapter(['x', 'publish:blog'])).toBe('blog');
    expect(taskAdapter(['publish'])).toBeUndefined();
    expect(urlFromOutput('posting\nurl: https://a.b/1\nurl: https://a.b/2\ndone\n')).toBe(
      'https://a.b/2',
    );
    expect(urlFromOutput('url: not-a-url')).toBeNull();
    expect(
      mcpArguments(
        { text: '{content}', meta: { id: '{task} in {root}', list: ['{path}'] }, n: 2 },
        { task: 'T-1', root: 'r', path: 'p.md', content: 'hi' },
      ),
    ).toEqual({ text: 'hi', meta: { id: 'T-1 in r', list: ['p.md'] }, n: 2 });
  });
});

describe('publishWithAdapter', () => {
  it('runs the adapter once on the approved files and records the URL it printed', async () => {
    const s = setup();
    expect(taskApprovedFiles(s.as('human:dawid'), '2').map((f) => f.path)).toEqual(['posts/x.md']);
    const fake = fakeCommand({ ok: true, url: 'https://blog.example/launch', output: 'ok' });
    const run = () =>
      publishWithAdapter({
        ws: s.as('human:dawid'),
        ref: '2',
        publish: PUBLISH,
        mcp: checkMcpConfig(undefined),
        top: s.repo,
        git: s.gitRun,
        env: s.env,
        runners: fake.runners,
      });
    const done = await run();
    expect(done).toMatchObject({
      ok: true,
      adapter: 'blog',
      url: 'https://blog.example/launch',
      files: ['posts/x.md'],
    });
    expect(done.view?.status).toBe('done');
    expect(fake.calls).toEqual([{ files: ['posts/x.md'], commit: done.commit, task: 'T-0002' }]);
    const events = s.as('human:dawid').showEvents('2').events;
    const attempt = events.find((e) => e.type === 'publish-attempt')!;
    expect(attempt).toMatchObject({ adapter: 'blog', commit: done.commit, actor: 'human:dawid' });
    expect(attempt.artifacts).toEqual([
      { kind: 'file', ref: 'posts/x.md', blob: git(s.repo, 'rev-parse', 'HEAD:posts/x.md') },
    ]);
    expect(events.find((e) => e.type === 'publish')).toMatchObject({
      url: 'https://blog.example/launch',
      adapter: 'blog',
      tag: 'published/T-0002',
      path: 'posts/x.md',
    });
    // The same files again: refused, and the adapter does not run.
    await expect(run()).rejects.toThrow(/T-0002 is done; pass --again/);
    expect(fake.calls).toHaveLength(1);
    const again = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ref: '2',
      publish: PUBLISH,
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fake.runners,
      opts: { again: true },
    });
    expect(again.ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps a failed attempt, says what to do, and refuses a second run for the same files', async () => {
    const s = setup();
    const fake = fakeCommand({ ok: false, output: 'boom', why: 'exit 1' });
    const opts = {
      publish: PUBLISH,
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fake.runners,
    };
    const failed = await publishWithAdapter({ ws: s.as('human:dawid'), ref: '2', ...opts });
    expect(failed).toMatchObject({ ok: false, why: 'exit 1' });
    expect(failed.view?.status).not.toBe('done');
    const last = s.as('human:dawid').showEvents('2').events.at(-1)!;
    expect(last.type).toBe('comment');
    expect(last.body).toMatch(/swarmup published T-0002 --url URL/);
    await expect(
      publishWithAdapter({ ws: s.as('human:dawid'), ref: '2', ...opts }),
    ).rejects.toThrow(/adapter blog already ran on these files/);
    // New content is a new attempt.
    commit(s.repo, { 'posts/x.md': '# Launch\n\nEdited words.\n' }, 'edit');
    const second = await publishWithAdapter({ ws: s.as('human:dawid'), ref: '2', ...opts });
    expect(second.ok).toBe(false);
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps the failure note when the error quotes a token, with the token redacted', async () => {
    const s = setup();
    // Built at runtime, so the leak check never sees a token in this file.
    const token = ['ghp', 'x'.repeat(36)].join('_');
    const fake = fakeCommand({ ok: false, output: '', why: `401 for token ${token}` });
    const failed = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ref: '2',
      publish: PUBLISH,
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fake.runners,
    });
    expect(failed.ok).toBe(false);
    const last = s.as('human:dawid').showEvents('2').events.at(-1)!;
    expect(last.type).toBe('comment');
    expect(last.body).toContain('publish adapter blog failed ([line removed: it looks like');
    expect(last.body).not.toContain(token);
  });

  it('refuses agents, runs, manual adapters, unknown adapters and tasks with none', async () => {
    const s = setup([]);
    const base = {
      ref: '2',
      publish: { test: { ...PUBLISH.test, hand: { kind: 'manual' as const } } },
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fakeCommand({ ok: true, url: 'https://a.b', output: '' }).runners,
    };
    await expect(publishWithAdapter({ ws: s.as('claude:writer'), ...base })).rejects.toThrow(
      /only a person publishes/,
    );
    await expect(publishWithAdapter({ ws: s.as('human:dawid', 'R1'), ...base })).rejects.toThrow(
      /only a person publishes/,
    );
    await expect(publishWithAdapter({ ws: s.as('human:dawid'), ...base })).rejects.toThrow(
      /names no publish adapter: give it the label publish:<name>/,
    );
    await expect(
      publishWithAdapter({ ws: s.as('human:dawid'), ...base, opts: { adapter: 'hand' } }),
    ).rejects.toThrow(/manual adapter: publish the work yourself/);
    await expect(
      publishWithAdapter({ ws: s.as('human:dawid'), ...base, opts: { adapter: 'nope' } }),
    ).rejects.toThrow(/define swarmupd.publish.test.nope/);
    await expect(
      publishWithAdapter({ ws: s.as('human:dawid'), ...base, ref: '1', opts: { adapter: 'blog' } }),
    ).rejects.toThrow(/content task: publish adapters run on publish tasks/);
    expect(
      s
        .as('human:dawid')
        .showEvents('2')
        .events.some((e) => e.type === 'publish-attempt'),
    ).toBe(false);
  });

  it('runs a command adapter with the files and the task in its environment', async () => {
    const s = setup();
    commit(
      s.repo,
      {
        'pub.mjs': [
          "import { readFileSync } from 'node:fs';",
          'const e = process.env;',
          "const text = readFileSync(e.SWARMUP_PUBLISH_FILE, 'utf8');",
          "if (!text.includes('approved words')) process.exit(3);",
          'console.log(`posting ${e.SWARMUP_PUBLISH_PATHS} at ${e.SWARMUP_PUBLISH_COMMIT}`);',
          'console.log(`url: https://blog.example/${e.SWARMUP_PUBLISH_ROOT}/${e.SWARMUP_PUBLISH_TASK}/${e.BLOG_KEY}`);',
        ].join('\n'),
      },
      'script',
    );
    setSecret(s.env, 'BLOG_TOKEN', 'k1');
    const done = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ref: '2',
      publish: {
        test: {
          blog: {
            kind: 'command',
            run: 'node pub.mjs',
            env: { BLOG_KEY: { secret: 'BLOG_TOKEN' } },
          },
        },
      },
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
    });
    expect(done.why).toBeUndefined();
    expect(done.url).toBe('https://blog.example/test/T-0002/k1');
    expect(done.output).toContain('posting posts/x.md at');
  }, 30_000);

  it('calls a tool of a publish MCP server and refuses a server that is not one', async () => {
    const s = setup();
    const server = join(temp(), 'server.mjs');
    writeFileSync(
      server,
      [
        "import { createInterface } from 'node:readline';",
        'const rl = createInterface({ input: process.stdin });',
        "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
        "rl.on('line', (line) => {",
        '  const m = JSON.parse(line);',
        "  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });",
        "  if (m.method === 'tools/call') {",
        '    const a = m.params.arguments;',
        "    send({ id: m.id, result: { content: [{ type: 'text', text: `posted ${a.text.length} chars as ${process.env.X_TOKEN}` }], structuredContent: { url: `https://x.example/${a.id}` } } });",
        '  }',
        '});',
      ].join('\n'),
    );
    setSecret(s.env, 'X_SECRET', 'tok');
    const mcp = checkMcpConfig({
      servers: {
        poster: {
          command: 'node',
          args: [server],
          env: { X_TOKEN: { secret: 'X_SECRET' } },
          publish: true,
        },
        plain: { command: 'node', args: [server] },
      },
    });
    const adapter = (srv: string) => ({
      test: {
        blog: {
          kind: 'mcp' as const,
          server: srv,
          tool: 'post',
          arguments: { text: '{content}', id: '{task}' },
        },
      },
    });
    const base = { ref: '2', mcp, top: s.repo, git: s.gitRun, env: s.env };
    await expect(
      publishWithAdapter({ ws: s.as('human:dawid'), ...base, publish: adapter('plain') }),
    ).rejects.toThrow(/plain is not a publish server; set publish: true/);
    const state = temp();
    const done = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ...base,
      publish: adapter('poster'),
      stateDir: state,
    });
    expect(done).toMatchObject({ ok: true, url: 'https://x.example/T-0002' });
    expect(done.output).toBe('posted 30 chars as tok');
    // Each tool call goes in publish-mcp.log: what was called and how it went, never with what.
    const lines = (): Array<Record<string, unknown>> =>
      readFileSync(join(state, 'publish-mcp.log'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines()).toEqual([
      {
        at: expect.any(String),
        server: 'poster',
        tool: 'post',
        args_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        task: 'test/T-0002',
        adapter: 'blog',
        attempt: done.attempt,
        ok: true,
      },
    ]);
    const raw = readFileSync(join(state, 'publish-mcp.log'), 'utf8');
    expect(raw).not.toContain('tok');
    expect(raw).not.toContain('Launch');
    // A failed call logs the first line of its reason.
    const failed = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ...base,
      publish: adapter('poster'),
      stateDir: state,
      opts: { again: true },
      runners: { mcp: () => Promise.reject(new Error('the server exited (1)\nmore')) },
    });
    expect(failed.ok).toBe(false);
    expect(lines()[1]).toMatchObject({
      ok: false,
      attempt: failed.attempt,
      error: 'the server exited (1)',
    });
  }, 30_000);
});

describe('taskPreview', () => {
  it('renders the approved Markdown with workspace images embedded, and writes nothing', async () => {
    const s = setup();
    const base = { ws: s.as('human:dawid'), ref: '2', top: s.repo, git: s.gitRun, env: s.env };
    const approved = await taskPreview(base);
    expect(approved.files.map((f) => [f.path, f.kind])).toEqual([['posts/x.md', 'markdown']]);
    expect(approved.files[0]!.html).toBe('<h1>Launch</h1>\n<p>The approved words.</p>');
    expect(approved.page).toContain("default-src 'none'");
    commit(
      s.repo,
      {
        'posts/y.md': '![card](../assets/card.png) ![gone](none.png) ![remote](https://a.b/c.png)',
        'assets/card.png': 'PNGDATA',
      },
      'card',
    );
    const named = await taskPreview({
      ...base,
      opts: { paths: ['posts/y.md', 'assets/card.png'] },
    });
    const data = `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`;
    expect(named.files.map((f) => f.kind)).toEqual(['markdown', 'image']);
    expect(named.files[0]!.html).toBe(
      `<p><img src="${data}" alt="card"> <span class="image-missing">[image: gone]</span> <span class="image-missing">[image: remote]</span></p>`,
    );
    expect(named.files[1]!.data).toBe(data);
    expect(
      s
        .as('human:dawid')
        .showEvents('2')
        .events.some((e) => e.type.startsWith('publish')),
    ).toBe(false);
  });
});

describe('edits after approval', () => {
  it('records on the publish event how many words changed since the approval', async () => {
    const s = setup();
    commit(s.repo, { 'posts/x.md': '# Launch\n\nThe edited words.\n' }, 'person edits');
    const fake = fakeCommand({ ok: true, url: 'https://blog.example/1', output: '' });
    await publishWithAdapter({
      ws: s.as('human:dawid'),
      ref: '2',
      publish: PUBLISH,
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fake.runners,
    });
    const events = s.as('human:dawid').showEvents('2').events;
    const verdict = s
      .as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'verdict')!;
    expect(events.find((e) => e.type === 'publish')!.edits).toEqual({
      changed: 2,
      total: 10,
      files: [{ path: 'posts/x.md', task: 'T-0001', verdict: verdict.id, changed: 2, total: 10 }],
    });
  });
});

describe('after the adapter published', () => {
  it('keeps the URL when recording fails, and says the work is published', async () => {
    const s = setup();
    const ws = s.as('human:dawid');
    ws.published = () => {
      throw new Error('the task lock is held');
    };
    const done = await publishWithAdapter({
      ws,
      ref: '2',
      publish: PUBLISH,
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fakeCommand({ ok: true, url: 'https://blog.example/1', output: '' }).runners,
    });
    expect(done).toMatchObject({ ok: true, url: 'https://blog.example/1' });
    expect(done.problems).toEqual([
      expect.stringMatching(
        /^recording the publish \(record it with `swarmup published T-0002 --url URL`; do not run the adapter again\) failed: the task lock is held$/,
      ),
    ]);
    // Not recorded, so not tagged either.
    expect(git(s.repo, 'tag', '--list')).toBe('');
  });

  it('records a URL whose query looks like a secret without the query', async () => {
    const token = `gh${'p_'}${'a'.repeat(36)}`;
    expect(recordableUrl(`https://blog.example/p/1?token=${token}#x`)).toBe(
      'https://blog.example/p/1',
    );
    expect(recordableUrl('https://blog.example/p/1?id=2')).toBe('https://blog.example/p/1?id=2');
    const s = setup();
    const done = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ref: '2',
      publish: PUBLISH,
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
      runners: fakeCommand({ ok: true, url: `https://blog.example/p/1?token=${token}`, output: '' })
        .runners,
    });
    expect(done.problems).toBeUndefined();
    const event = s
      .as('human:dawid')
      .showEvents('2')
      .events.find((e) => e.type === 'publish')!;
    expect(event.url).toBe('https://blog.example/p/1');
    expect(git(s.repo, 'rev-parse', 'published/T-0002')).toBe(git(s.repo, 'rev-parse', 'HEAD'));
  });

  it('stops a command adapter that outlives its timeout, with what it started', async () => {
    const s = setup();
    commit(s.repo, { 'slow.mjs': 'setTimeout(() => {}, 60_000);\n' }, 'slow');
    const started = Date.now();
    const done = await publishWithAdapter({
      ws: s.as('human:dawid'),
      ref: '2',
      publish: { test: { blog: { kind: 'command', run: 'node slow.mjs', timeout_minutes: 0.02 } } },
      mcp: checkMcpConfig(undefined),
      top: s.repo,
      git: s.gitRun,
      env: s.env,
    });
    expect(done).toMatchObject({ ok: false, why: 'timed out' });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
