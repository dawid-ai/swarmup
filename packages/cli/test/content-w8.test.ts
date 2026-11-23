import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { run } from '../src/cli.js';

// A content project end to end through the CLI (W8): `new-project --template campaign --store`,
// `review --artifact`, `swarmup artifact`, `swarmup published` and `swarmup publish` (phase 3).

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-w8-cli-'));
  dirs.push(d);
  return d;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

async function swarmup(
  config: string,
  cwd: string,
  actor: string,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const env = { SWARMUP_CONFIG: config, SWARMUP_AGENT: actor, ...GIT_ENV } as NodeJS.ProcessEnv;
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** A campaign made with `new-project --store`, with the user config it registered in. */
async function campaign() {
  const top = temp();
  const config = join(top, 'config.yml');
  writeFileSync(config, '# kept\nme: human:dawid\nroots: []\n');
  const ws = join(top, 'launch');
  const store = join(top, 'store');
  const res = await swarmup(config, top, 'human:dawid', [
    'new-project',
    ws,
    '--template',
    'campaign',
    '--store',
    store,
    '--name',
    'launch',
    '--prefix',
    'LC',
    '--human',
    'human:dawid',
  ]);
  return { top, config, ws, store, res };
}

describe('new-project --store', () => {
  it('starts the workspace on main, registers the root and files the first tasks', async () => {
    const { config, ws, store, res } = await campaign();
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/committed [0-9a-f]{10} on main/);
    expect(res.out).toContain('LC-0001');
    expect(res.out).toMatch(
      /added .* to roots and .*launch as the code checkout of launch \(merge base main\)/,
    );
    expect(existsSync(join(store, '.swarmup', 'config.yml'))).toBe(true);
    expect(git(ws, 'status', '--porcelain')).toBe('');
    const cfg = YAML.parse(readFileSync(config, 'utf8'));
    expect(cfg.swarmupd.merge.launch.checks).toEqual(['swarmup map check --base main']);
    const list = await swarmup(config, ws, 'human:dawid', ['list', '--json']);
    const tasks = JSON.parse(list.out) as Array<{ type: string }>;
    expect(tasks.map((t) => t.type).sort()).toEqual([
      'content',
      'content',
      'docs',
      'docs',
      'publish',
    ]);
  });
});

describe('review artifacts and publish through the CLI', () => {
  it('records named and changed files at the reviewed commit, prints them, and records a publish', async () => {
    const { config, ws } = await campaign();
    const as = (actor: string, argv: string[]) => swarmup(config, ws, actor, argv);
    const made = await as('human:dawid', [
      'new',
      'Write the X thread',
      '--type',
      'content',
      '--to',
      'claude:writer',
      '--done-when',
      '{id: len, kind: check, check: char-count, args: {path: "posts/x-*.md", per: block, separator: "---", max: 280}}',
      '--review',
      'codex:editor',
    ]);
    expect(made.code).toBe(0);
    const id = made.out.trim();
    expect(id).toBe('LC-0006');
    await as('claude:writer', ['start', id, 'draft the thread']);
    git(ws, 'checkout', '-qb', 'claude/lc-0006');
    mkdirSync(join(ws, 'posts'), { recursive: true });
    writeFileSync(
      join(ws, 'posts', 'x-thread.md'),
      '---\nchannel: x\n---\n1/ First.\n\n---\n\n2/ Second.\n',
    );
    writeFileSync(
      join(ws, '.swarmup', 'map', 'posts.md'),
      readFileSync(join(ws, '.swarmup', 'map', 'posts.md'), 'utf8') + '\nThreads too.\n',
    );
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'LC-0006: draft the thread');
    const head = git(ws, 'rev-parse', 'HEAD');

    // A path the commit lacks is refused, and nothing is sent.
    const missing = await as('claude:writer', [
      'review',
      id,
      'drafted',
      '--artifact',
      'posts/x-none.md',
    ]);
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(/posts\/x-none\.md is not in/);

    // Without --artifact, the files the commit changed from main, minus the map.
    const sent = await as('claude:writer', [
      'review',
      id,
      'LC-0006: thread drafted',
      '--to',
      'human:dawid',
    ]);
    expect(sent.code).toBe(0);
    const shown = JSON.parse((await as('human:dawid', ['show', id, '--json'])).out) as {
      events: Array<{
        type: string;
        artifacts?: Array<{ kind: string; ref: string; blob?: string }>;
      }>;
    };
    const review = shown.events.filter((e) => e.type === 'review').at(-1)!;
    expect((shown as unknown as { meta: { review?: string } }).meta.review).toBe('codex:editor');
    expect(review.artifacts).toEqual([
      {
        kind: 'file',
        ref: 'posts/x-thread.md',
        blob: git(ws, 'rev-parse', `${head}:posts/x-thread.md`),
      },
    ]);

    // `swarmup artifact` prints the file at the reviewed commit, even after the branch moves on.
    writeFileSync(join(ws, 'posts', 'x-thread.md'), 'changed later\n');
    const printed = await as('codex:editor', ['artifact', id]);
    expect(printed.code).toBe(0);
    expect(printed.out).toContain('1/ First.');
    expect(printed.out).not.toContain('changed later');
    git(ws, 'checkout', '-q', '--', 'posts/x-thread.md');

    // A person records the publish; an agent cannot.
    const pub = (
      await as('human:dawid', [
        'new',
        'Post the X thread',
        '--type',
        'publish',
        '--done-when',
        '{id: kept, kind: check, check: file-exists, args: {path: posts/x-thread.md}, when: publish}',
      ])
    ).out.trim();
    const agent = await as('claude:writer', ['published', pub, '--url', 'https://x.com/s/1']);
    expect(agent.code).toBe(1);
    expect(agent.err).toMatch(/only a person records a publish/);
    const done = await as('human:dawid', [
      'published',
      pub,
      '--url',
      'https://x.com/s/1',
      '--artifact',
      'posts/x-thread.md',
      '--commit',
      head,
    ]);
    expect(done.err).toBe('');
    expect(done.code).toBe(0);
    expect(done.out).toMatch(
      new RegExp(
        `${pub} published at https://x.com/s/1: ${head.slice(0, 10)} posts/x-thread.md, tagged published/${pub}`,
      ),
    );
    expect(done.out).toMatch(/kept\s+pass/);
    expect(git(ws, 'rev-parse', `published/${pub}`)).toBe(head);
    const after = JSON.parse((await as('human:dawid', ['show', pub, '--json'])).out) as {
      task: { status: string };
    };
    expect(after.task.status).toBe('done');
  });
});

describe('swarmup publish', () => {
  it('runs the adapter the label names once, for a person only, and records its URL', async () => {
    const { config, ws } = await campaign();
    const as = (actor: string, argv: string[]) => swarmup(config, ws, actor, argv);
    mkdirSync(join(ws, 'posts'), { recursive: true });
    writeFileSync(join(ws, 'posts', 'hello.md'), '# Hello\n');
    writeFileSync(
      join(ws, 'pub.mjs'),
      'console.log(`url: https://blog.example/${process.env.SWARMUP_PUBLISH_TASK}`);\n',
    );
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'approved post');
    const cfg = YAML.parse(readFileSync(config, 'utf8')) as Record<string, unknown>;
    cfg.swarmupd = { publish: { launch: { blog: { kind: 'command', run: 'node pub.mjs' } } } };
    writeFileSync(config, YAML.stringify(cfg));
    const pub = (
      await as('human:dawid', ['new', 'Post hello', '--type', 'publish', '--label', 'publish:blog'])
    ).out.trim();
    const page = join(ws, '..', 'preview.html');
    const preview = await as('claude:writer', [
      'preview',
      pub,
      '--artifact',
      'posts/hello.md',
      '--out',
      page,
    ]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain(`wrote ${page}`);
    expect(readFileSync(page, 'utf8')).toContain('<h1>Hello</h1>');
    const agent = await as('claude:writer', ['publish', pub, '--artifact', 'posts/hello.md']);
    expect(agent.code).toBe(1);
    expect(agent.err).toMatch(/only a person publishes/);
    const done = await as('human:dawid', ['publish', pub, '--artifact', 'posts/hello.md']);
    expect(done.err).toBe('');
    expect(done.code).toBe(0);
    expect(done.out).toMatch(
      new RegExp(`${pub} published at https://blog.example/${pub} by adapter blog: posts/hello.md`),
    );
    const again = await as('human:dawid', ['publish', pub, '--artifact', 'posts/hello.md']);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/pass --again/);
  }, 60_000);
});
