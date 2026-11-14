import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { blocksLabel, run } from '../src/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
// Resolved like any import, so a worktree without its own node_modules finds the tsc of the
// checkout that holds it.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const coreDist = join(repoTop, 'packages', 'core', 'dist', 'index.js');
const dirs: string[] = [];

const states = new Map<string, string>();

afterEach(() => {
  states.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * An empty opsd state folder per working folder, so `swarmup report` and `swarmup wrapped` never read the
 * machine's live run records: an open run there counts minutes up to now and differs between calls.
 */
function stateFor(cwd: string): string {
  let s = states.get(cwd);
  if (!s) {
    s = mkdtempSync(join(tmpdir(), 'ops-cli-state-'));
    dirs.push(s);
    states.set(cwd, s);
  }
  return s;
}

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-cli-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q'], { cwd: d, windowsHide: true });
  // CI runners have no git identity; swarmup sync commits.
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: d, windowsHide: true });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], {
    cwd: d,
    windowsHide: true,
  });
  return d;
}

function swarmup(cwd: string, actor: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const env = {
    SWARMUP_CONFIG: join(cwd, 'none.yml'),
    SWARMUP_AGENT: actor,
    SWARMUP_STATE_DIR: stateFor(cwd),
  } as NodeJS.ProcessEnv;
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/**
 * Waits for the clock to pass the current millisecond. A report window ends before "now", and the
 * in-process CLI is fast enough on Linux to write an event and read the window in one millisecond.
 */
function nextMs(): void {
  const t = Date.now();
  while (Date.now() <= t) {
    // Spin: at most one millisecond.
  }
}

describe('swarmup', () => {
  it('sets the Master Repo and mirrors a project root into it on sync', () => {
    const proj = repo();
    const hub = repo();
    swarmup(proj, 'human:dawid', 'init', '--name', 'site', '--prefix', 'WEB');
    swarmup(hub, 'human:dawid', 'init', '--name', 'hub', '--prefix', 'HUB');
    expect(swarmup(proj, 'human:dawid', 'master').code).toBe(3);
    expect(swarmup(proj, 'human:dawid', 'master', hub).out).toMatch(/^Master Repo: /);
    expect(swarmup(proj, 'human:dawid', 'mirror', 'sideways').code).toBe(2);
    expect(swarmup(proj, 'human:dawid', 'mirror', 'on').out).toMatch(/^site: mirror on/);
    expect(swarmup(proj, 'human:dawid', 'mirror', 'on').out).toMatch(/already on/);
    expect(swarmup(proj, 'human:dawid', 'new', 'pricing page').code).toBe(0);
    const synced = swarmup(proj, 'human:dawid', 'sync');
    expect(synced.out).toMatch(/site: mirrored with the Master Repo/);
    expect(
      existsSync(join(hub, '.swarmup', 'mirrors', 'site', 'tasks', 'WEB-0001', 'task.md')),
    ).toBe(true);
    // The project root is still the one this machine works in: its copy stays hidden here.
    expect(swarmup(proj, 'human:dawid', 'roots').out).not.toMatch(/mirrors/);
    expect(swarmup(proj, 'human:dawid', 'master', '--off').out).toBe('no Master Repo set');
  });

  it('runs a task from creation to done', () => {
    const d = repo();
    expect(swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid').code).toBe(
      0,
    );
    expect(
      swarmup(d, 'human:dawid', 'new', 'Write', 'docs', '--to', 'claude:writer', '-p', 'p1').out,
    ).toBe('T-0001');
    expect(swarmup(d, 'claude:writer', 'next').out).toBe('T-0001\tp1\tWrite docs');
    expect(swarmup(d, 'claude:writer', 'start', '1', 'outline', 'first').out).toBe(
      'T-0001 in-progress (claude:writer)',
    );
    expect(swarmup(d, 'codex:engineer', 'progress', '1', 'x').code).toBe(1);
    expect(swarmup(d, 'claude:writer', 'review', '1', 'draft', 'ready').out).toContain(
      'needs-review',
    );
    expect(swarmup(d, 'human:dawid', 'inbox').out).toContain('review');
    expect(swarmup(d, 'human:dawid', 'verdict', '1', 'approve').out).toContain('done');
    const shown = swarmup(d, 'human:dawid', 'show', '1', '--json');
    const parsed = JSON.parse(shown.out) as { task: { status: string }; events: unknown[] };
    expect(parsed.task.status).toBe('done');
    expect(parsed.events).toHaveLength(4);
    expect(swarmup(d, 'claude:writer', 'next').code).toBe(3);
  });

  it('prints event and channel times as local time with the UTC offset (AO-0174)', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'Asia/Bangkok';
    try {
      const d = repo();
      swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
      swarmup(d, 'human:dawid', 'new', 'Write docs', '--to', 'claude:writer');
      swarmup(d, 'claude:writer', 'start', '1', 'outline');
      swarmup(d, 'claude:writer', 'channel', 'post', 'dev', 'hello');
      const shown = swarmup(d, 'human:dawid', 'show', '1');
      const json = JSON.parse(swarmup(d, 'human:dawid', 'show', '1', '--json').out) as {
        events: Array<{ at: string; type: string }>;
      };
      const claim = json.events.find((e) => e.type === 'claim')!;
      const local = new Date(Date.parse(claim.at) + 7 * 3_600_000).toISOString();
      const stamp = `${local.slice(0, 10)} ${local.slice(11, 16)}+07:00`;
      expect(shown.out).toContain(`${stamp}  claude:writer      claim`);
      expect(shown.out).toMatch(/^lease: {4}\d{4}-\d\d-\d\d \d\d:\d\d\+07:00$/m);
      expect(swarmup(d, 'human:dawid', 'channel', 'read', 'dev').out).toMatch(
        /^\d{4}-\d\d-\d\d \d\d:\d\d\+07:00 {2}claude:writer/,
      );
      expect(swarmup(d, 'human:dawid', 'channel', 'list').out).toMatch(/\d\d:\d\d\+07:00$/);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it('warns, without refusing, when a message to a person names no task or is a fragment', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    swarmup(d, 'human:dawid', 'new', 'Pick a database', '--to', 'claude:engineer');
    swarmup(d, 'human:dawid', 'new', 'Second task', '--to', 'claude:engineer');
    swarmup(d, 'claude:engineer', 'start', '1', 'compare options');

    const vague = swarmup(d, 'claude:engineer', 'comment', '1', 'see above', '--to', 'human:dawid');
    expect(vague.code).toBe(0);
    expect(vague.err).toMatch(/note: the message names no task/);
    expect(vague.err).toMatch(/note: the message is shorter than a sentence/);

    // Messages to agents are not checked.
    expect(swarmup(d, 'claude:engineer', 'comment', '1', 'ok', '--to', 'codex:qa').err).toBe('');

    const clear = swarmup(
      d,
      'claude:engineer',
      'ask',
      '1',
      'T-0001: Postgres or SQLite for the cache? I recommend SQLite: no server to run.',
      '--recommend',
      'SQLite',
    );
    expect(clear.code).toBe(0);
    expect(clear.err).toBe('');

    swarmup(d, 'human:dawid', 'answer', '1', 'SQLite, as you recommend for T-0001.');
    expect(swarmup(d, 'human:dawid', 'assign', '2', 'human:dawid', 'mine').err).toMatch(
      /names no task/,
    );

    const shown = swarmup(d, 'human:dawid', 'show', '1', '--ids').out;
    const [first] = JSON.parse(swarmup(d, 'human:dawid', 'show', '1', '--json').out)
      .events as Array<{
      id: string;
    }>;
    expect(shown).toContain(`${first!.id}  `);
    expect(swarmup(d, 'human:dawid', 'show', '1').out).not.toContain(first!.id);
  });

  it('sets done_when with new --done-when, prints it in show, and notes a review without evidence (AO-0290)', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const made = swarmup(
      d,
      'human:dawid',
      'new',
      'Add the field',
      '--to',
      'claude:engineer',
      '--done-when',
      '`npm test` passes',
      '--done-when',
      'show prints the list, commas kept',
    );
    expect(made.out).toBe('T-0001');
    swarmup(d, 'human:dawid', 'new', 'No checks', '--to', 'claude:engineer');

    const shown = swarmup(d, 'human:dawid', 'show', '1').out;
    expect(shown).toContain(
      'done when:\n  - `npm test` passes\n  - show prints the list, commas kept',
    );
    const json = JSON.parse(swarmup(d, 'human:dawid', 'show', '1', '--json').out) as {
      meta: { done_when?: string[] };
    };
    expect(json.meta.done_when).toEqual(['`npm test` passes', 'show prints the list, commas kept']);
    // A task without the field prints as before.
    expect(swarmup(d, 'human:dawid', 'show', '2').out).not.toContain('done when');

    swarmup(d, 'claude:engineer', 'start', '1', 'core first');
    const vague = swarmup(d, 'claude:engineer', 'review', '1', 'T-0001: all the tests pass now');
    expect(vague.code).toBe(0);
    expect(vague.out).toContain('needs-review');
    expect(vague.err).toMatch(
      /note: the task has 2 done-when lines and the request names no command/,
    );

    swarmup(d, 'human:dawid', 'verdict', '1', 'changes', 'T-0001: name the commands');
    swarmup(d, 'claude:engineer', 'start', '1', 'again');
    const clear = swarmup(d, 'claude:engineer', 'review', '1', 'T-0001: `npm test`: 412 passed');
    expect(clear.err).not.toMatch(/done-when/);

    swarmup(d, 'claude:engineer', 'start', '2', 'go');
    expect(swarmup(d, 'claude:engineer', 'review', '2', 'T-0002: tests pass').err).not.toMatch(
      /done-when/,
    );
  });

  it('attaches an image and lists its file in show', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo');
    swarmup(d, 'human:dawid', 'new', 'Fix the header');
    writeFileSync(join(d, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 7]));
    writeFileSync(join(d, 'notes.txt'), 'not an image');
    const att = swarmup(d, 'human:dawid', 'attach', 'shot.png', '--task', '1', '--alt', 'header');
    expect(att.code).toBe(0);
    const link = att.out;
    expect(link).toMatch(/^!\[header\]\(attachments\/[0-9A-Z]{26}\.png\)$/);
    expect(swarmup(d, 'human:dawid', 'attach', 'notes.txt').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'attach', 'missing.png').code).toBe(2);
    swarmup(d, 'human:dawid', 'comment', '1', `The logo overlaps: ${link}`);
    const ref = /\((attachments\/[^)]+)\)/.exec(link)![1]!;
    const file = join(d, '.swarmup', ...ref.split('/'));
    const shown = swarmup(d, 'human:dawid', 'show', '1');
    expect(shown.out).toContain(`attachments:\n  ${ref}  ${file}`);
    const json = JSON.parse(swarmup(d, 'human:dawid', 'show', '1', '--json').out) as {
      attachments: Array<{ ref: string; file: string; type: string }>;
    };
    expect(json.attachments).toEqual([{ ref, file, type: 'image/png' }]);
  });

  it('files an agent swarmup new without an approved parent as a proposal and says so', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--human', 'human:dawid');
    const top = swarmup(d, 'claude:pm', 'new', 'Rewrite', 'the', 'sync');
    expect(top.code).toBe(0);
    expect(top.out).toBe('T-0001');
    expect(top.err).toMatch(/note: T-0001 is a proposal \(finding\): it has no --parent/);
    expect(swarmup(d, 'claude:pm', 'show', '1').out).toMatch(/type: finding/);
    swarmup(d, 'human:dawid', 'new', 'Approved', 'work');
    const sub = swarmup(d, 'claude:pm', 'new', 'Step', 'one', '--parent', '2');
    expect(sub.out).toBe('T-0003');
    expect(sub.err).toBe('');
    const json = JSON.parse(swarmup(d, 'claude:pm', 'new', 'Another', '--json').out);
    expect(json).toMatchObject({ id: 'T-0004', type: 'finding', proposed: expect.any(String) });
  });

  it('reports bad input with exit 2', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init');
    expect(swarmup(d, 'human:dawid', 'nope').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'new', 'x', '--bogus').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'show', 'T-0042').code).toBe(2);
    expect(swarmup(d, 'Not An Id', 'list').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'list', '--status', 'weird').code).toBe(2);
  });

  it('offers no work to paused or proposed roles and warns when work goes to them', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const agents = join(d, '.swarmup', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, 'claude-writer.md'), '---\nstatus: proposed\n---\n');
    writeFileSync(join(agents, 'codex-qa.md'), '---\nstatus: paused\n---\n');
    // With role files, work goes only to configured agents (AO-0096).
    writeFileSync(join(agents, 'claude-engineer.md'), '---\nstatus: active\n---\n');
    swarmup(d, 'human:dawid', 'new', 'open');
    swarmup(d, 'human:dawid', 'new', 'owned', '--to', 'claude:writer');
    expect(swarmup(d, 'claude:writer', 'next').code).toBe(3);
    expect(swarmup(d, 'codex:qa', 'next').code).toBe(3);
    expect(swarmup(d, 'claude:engineer', 'next').out).toMatch(/^T-0001/);

    swarmup(d, 'claude:engineer', 'start', '1');
    const handed = swarmup(d, 'claude:engineer', 'handoff', '1', 'claude:writer', 'over to you');
    expect(handed.code).toBe(0);
    expect(handed.err).toMatch(/note: claude:writer is proposed in its role file/);
    const assigned = swarmup(d, 'human:dawid', 'assign', '1', 'claude:engineer');
    expect(assigned.code).toBe(0);
    expect(assigned.err).toBe('');

    swarmup(d, 'claude:engineer', 'start', '1');
    const reviewed = swarmup(d, 'claude:engineer', 'review', '1', 'check', '--to', 'codex:qa');
    expect(reviewed.code).toBe(0);
    expect(reviewed.err).toMatch(/note: codex:qa is paused in its role file/);

    // An agent's own top-level task would be a proposal (AO-0107), so the human files it.
    swarmup(d, 'human:dawid', 'new', 'more', '--to', 'claude:engineer');
    swarmup(d, 'claude:engineer', 'start', '3');
    const delegated = swarmup(
      d,
      'claude:engineer',
      'delegate',
      '3',
      '*:writer',
      '--review',
      'codex:qa',
    );
    expect(delegated.code).toBe(0);
    expect(delegated.err).toMatch(/no active role matches \*:writer \(claude:writer proposed\)/);
    expect(delegated.err).toMatch(/codex:qa is paused/);
  });

  it('prints help for every command', () => {
    const d = repo();
    const all = swarmup(d, 'human:dawid', 'help');
    for (const c of ['claim', 'handoff', 'inbox', 'sync', 'leaks']) expect(all.out).toContain(c);
    expect(swarmup(d, 'human:dawid', 'claim', '--help').out).toContain('swarmup claim ID');
  });
});

describe('two agents on one machine', () => {
  beforeAll(() => {
    if (!existsSync(coreDist)) {
      execFileSync(process.execPath, [tsc, '-b', 'packages/core'], {
        cwd: repoTop,
        windowsHide: true,
      });
    }
  });

  it('work a shared queue with no network and never share a task', async () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--human', 'human:dawid');
    const N = 40;
    for (let i = 0; i < N; i++) swarmup(d, 'human:dawid', 'new', `task ${i}`);

    // Each agent is its own process looping next, claim, start, done, like a real run.
    const worker = `
      const { Workspace, OpsError } = await import(${JSON.stringify(pathToFileURL(coreDist).href)});
      const [cwd, actor] = process.argv.slice(1);
      const env = { SWARMUP_CONFIG: cwd + '/none.yml' };
      const done = [];
      let lost = 0;
      for (;;) {
        const ws = new Workspace({ cwd, env, actor });
        const next = ws.next();
        if (!next) break;
        try { ws.claim(next.meta.id); } catch (e) { if (e instanceof OpsError) { lost++; continue; } throw e; }
        ws.start(next.meta.id);
        ws.done(next.meta.id, 'ok');
        done.push(next.meta.id);
      }
      process.stdout.write(JSON.stringify({ done, lost }));
    `;
    const runAgent = (actor: string) =>
      new Promise<{ done: string[]; lost: number }>((resolve, reject) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', worker, d, actor], {
          windowsHide: true,
        });
        let out = '';
        let err = '';
        p.stdout.on('data', (c: Buffer) => (out += c.toString()));
        p.stderr.on('data', (c: Buffer) => (err += c.toString()));
        p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      });

    const [a, b] = await Promise.all([runAgent('claude:engineer'), runAgent('codex:engineer')]);
    const all = [...a.done, ...b.done].sort();
    expect(all).toHaveLength(N);
    expect(new Set(all).size).toBe(N);
    const listed = JSON.parse(swarmup(d, 'human:dawid', 'list', '--all', '--json').out) as Array<{
      status: string;
    }>;
    expect(listed.every((t) => t.status === 'done')).toBe(true);
  }, 60_000);
});

describe('collaboration commands', () => {
  it('delegates, files findings, learns, posts and votes', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    swarmup(d, 'human:dawid', 'new', 'Port', 'the', 'board');
    const del = swarmup(
      d,
      'human:dawid',
      'delegate',
      '1',
      'codex:engineer',
      '--budget',
      '2h',
      '--tokens',
      '400k',
      '--review',
      'claude:qa',
    );
    expect(del.out).toBe('T-0001 todo (owner codex:engineer)');
    expect(swarmup(d, 'human:dawid', 'show', '1').out).toContain(
      'delegated: by human:dawid to codex:engineer (budget 2h, tokens 400000, review claude:qa)',
    );
    expect(
      swarmup(
        d,
        'codex:engineer',
        'finding',
        'Board',
        'flickers',
        '--task',
        '1',
        '-m',
        'web/Board.tsx',
      ).out,
    ).toBe('T-0002');
    expect(swarmup(d, 'codex:engineer', 'show', '1').out).toContain('finding T-0002');
    expect(
      swarmup(
        d,
        'codex:engineer',
        'learn',
        'ui',
        'Virtualize',
        'long',
        'lists',
        '-m',
        'Use windowing above 500 rows.',
      ).out,
    ).toBe('ui/virtualize-long-lists');
    expect(swarmup(d, 'codex:engineer', 'learn', 'ui', 'No', 'body').code).toBe(2);
    expect(swarmup(d, 'claude:qa', 'kb', 'windowing').out).toContain('ui/virtualize-long-lists');
    expect(swarmup(d, 'claude:qa', 'kb', 'nothing').code).toBe(3);
    expect(swarmup(d, 'claude:qa', 'kb', '--read', 'ui/virtualize-long-lists').out).toContain(
      '500 rows',
    );
    expect(
      swarmup(d, 'claude:qa', 'channel', 'post', 'dev', 'ready', 'for', '@codex:engineer').code,
    ).toBe(0);
    expect(swarmup(d, 'codex:engineer', 'inbox').out).toContain('mention  #dev');
    expect(swarmup(d, 'codex:engineer', 'channel', 'read', 'dev').out).toContain(
      'ready for @codex:engineer',
    );
    expect(swarmup(d, 'codex:engineer', 'channel', 'list').out).toMatch(/^#dev\s+1/);
    expect(
      swarmup(
        d,
        'claude:orchestrator',
        'propose',
        'Shell?',
        '--option',
        'Electron',
        '--option',
        'Tauri',
        '--voters',
        'claude:qa,codex:engineer',
      ).out,
    ).toBe('D-0001');
    expect(swarmup(d, 'claude:qa', 'vote', 'D-1', 'Electron', 'reuse web UI').code).toBe(0);
    swarmup(d, 'codex:engineer', 'vote', 'D-1', '2');
    expect(swarmup(d, 'claude:orchestrator', 'tally', 'D-1').out).toContain('state:    tie');
    expect(swarmup(d, 'claude:orchestrator', 'decide', 'D-1', 'Electron').code).toBe(1);
    expect(swarmup(d, 'human:dawid', 'decisions').out).toContain('D-0001   tie');
    expect(swarmup(d, 'human:dawid', 'decide', 'D-1', 'Electron').out).toContain(
      'decided: Electron',
    );
    swarmup(d, 'human:dawid', 'done', '2');
    expect(swarmup(d, 'human:dawid', 'archive', '--days', '0').out).toBe('archived T-0002');
    expect(swarmup(d, 'human:dawid', 'list', '--all', '--json').out).toContain('"archived": true');
  });

  it('records kb --read as a note read only while the reader works a task (AO-0186)', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    swarmup(d, 'human:dawid', 'new', 'Port', 'the', 'board', '--to', 'codex:engineer');
    swarmup(d, 'codex:engineer', 'learn', 'ui', 'Virtualize', '-m', 'Use windowing.');
    const reads = join(d, '.swarmup', 'kb-reads');
    // Search hits and reads outside work leave no record.
    expect(swarmup(d, 'codex:engineer', 'kb', 'windowing').code).toBe(0);
    expect(swarmup(d, 'codex:engineer', 'kb', '--read', 'ui/virtualize').out).toContain(
      'Use windowing.',
    );
    expect(existsSync(reads)).toBe(false);

    expect(swarmup(d, 'codex:engineer', 'start', '1', 'port').code).toBe(0);
    const res = swarmup(d, 'codex:engineer', 'kb', '--read', 'ui/virtualize', '--json');
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out)).toMatchObject({ ref: 'ui/virtualize' });
    expect(res.err).toBe('');
    const months = readdirSync(reads);
    expect(months).toHaveLength(1);
    const files = readdirSync(join(reads, months[0]!));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9A-Z]{26}-codex-engineer\.json$/);
    expect(JSON.parse(readFileSync(join(reads, months[0]!, files[0]!), 'utf8'))).toMatchObject({
      actor: 'codex:engineer',
      ref: 'ui/virtualize',
      task: 'T-0001',
    });
  });

  it('lists read counts with kb --usage and unread notes with kb --stale (AO-0152)', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    swarmup(d, 'human:dawid', 'new', 'Port', 'the', 'board', '--to', 'codex:engineer');
    swarmup(d, 'codex:engineer', 'learn', 'ui', 'Virtualize', '-m', 'Use windowing.');
    swarmup(d, 'codex:engineer', 'learn', 'git', 'Rebase', '-m', 'Rebase onto v2.');
    const before = swarmup(d, 'human:dawid', 'kb', '--usage');
    expect(before.code).toBe(0);
    expect(before.out).toContain('no reads recorded yet');

    swarmup(d, 'codex:engineer', 'start', '1', 'port');
    swarmup(d, 'codex:engineer', 'kb', '--read', 'ui/virtualize');
    swarmup(d, 'codex:engineer', 'kb', '--read', 'ui/virtualize');
    const usage = swarmup(d, 'human:dawid', 'kb', '--usage');
    expect(usage.code).toBe(0);
    const lines = usage.out.split('\n');
    expect(lines[0]).toMatch(/^reads recorded since \d{4}-\d{2}-\d{2}/);
    expect(lines[0]).toContain('no notes shown in run prompts recorded yet');
    expect(lines[1]).toMatch(/^note\s+reads\s+shown\s+30d\s+last used\s+created\s+title$/);
    expect(lines[2]).toMatch(/^ui\/virtualize\s+2\s+0\s+2\s+\d{4}-\d{2}-\d{2}\s+\S+\s+Virtualize$/);
    expect(lines[3]).toMatch(/^git\/rebase\s+0\s+0\s+0\s+-\s+/);

    // Both notes are newer than 30 days, so none is stale yet.
    const none = swarmup(d, 'human:dawid', 'kb', '--stale');
    expect(none.code).toBe(3);
    expect(none.out).toContain('no note unused for 30 days');
    // With a window of 0 days, every note is unread in it; never-read ones come first.
    const stale = swarmup(d, 'human:dawid', 'kb', '--stale', '--days', '0', '--json');
    expect(stale.code).toBe(0);
    const json = JSON.parse(stale.out) as {
      days: number;
      tracked_since: string;
      notes: { ref: string; reads: number }[];
    };
    expect(json.days).toBe(0);
    expect(json.tracked_since).toMatch(/^\d{4}-/);
    expect(json.notes.map((n) => [n.ref, n.reads])).toEqual([
      ['git/rebase', 0],
      ['ui/virtualize', 2],
    ]);
    const ui = swarmup(d, 'human:dawid', 'kb', '--stale', '--topic', 'ui', '--days', '0').out;
    expect(ui).toContain('ui/virtualize');
    expect(ui).not.toContain('git/rebase');
    // Reads started today, before the 0-day window's start: the list is complete, no warning.
    expect(ui).not.toContain('warning');
    // A 30-day window starts before the first read record: the list may be incomplete.
    swarmup(d, 'codex:engineer', 'learn', 'old', 'Old', '-m', 'Old note.');
    const oldFile = join(d, '.swarmup', 'kb', 'old', 'old.md');
    writeFileSync(
      oldFile,
      readFileSync(oldFile, 'utf8').replace(/created_at: .*/, "created_at: '2020-01-01T00:00:00Z'"),
    );
    const early = swarmup(d, 'human:dawid', 'kb', '--stale');
    expect(early.code).toBe(0);
    expect(early.out).toContain('old/old');
    expect(early.out).toContain('warning: reads and shown records cover less than 30 days');

    // A run prompt that listed the old note keeps it off the stale list, with no read at all.
    const shownDir = join(d, '.swarmup', 'kb-shown', '2026-11');
    mkdirSync(shownDir, { recursive: true });
    writeFileSync(
      join(shownDir, '01M74WPF31XTQDXSNT8SH9YQZP-codex-engineer.json'),
      JSON.stringify({
        actor: 'codex:engineer',
        at: new Date().toISOString(),
        refs: ['old/old'],
        task: 'T-0001',
      }),
    );
    const shown = swarmup(d, 'human:dawid', 'kb', '--stale');
    expect(shown.code).toBe(3);
    expect(shown.out).toMatch(/notes shown in run prompts recorded since \d{4}-/);
    const all = JSON.parse(swarmup(d, 'human:dawid', 'kb', '--usage', '--json').out) as {
      shown_since: string;
      notes: { ref: string; shown: number; recent_shown: number; last_used: string | null }[];
    };
    expect(all.shown_since).toMatch(/^\d{4}-/);
    const old = all.notes.find((n) => n.ref === 'old/old')!;
    expect([old.shown, old.recent_shown]).toEqual([1, 1]);
    expect(old.last_used).toMatch(/^\d{4}-/);
    expect(swarmup(d, 'human:dawid', 'kb', '--usage').out).toMatch(/old\/old\s+0\s+1\s+1\s+\d{4}-/);

    expect(swarmup(d, 'human:dawid', 'kb', '--usage', '--stale').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'kb', '--usage', 'words').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'kb', '--stale', '--days', 'x').code).toBe(2);
    expect(swarmup(d, 'human:dawid', 'kb', 'windowing', '--days', '3').code).toBe(2);
  });
});

describe('multi-line event text (AO-0143)', () => {
  const MD = '## Done\n\n- parser in `core/fold.ts`\n- tests\n\n## Next\n\n- docs';

  /** `swarmup` with `stdin` as what the command reads from standard input. */
  function piped(cwd: string, actor: string, stdin: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const env = {
      SWARMUP_CONFIG: join(cwd, 'none.yml'),
      SWARMUP_AGENT: actor,
    } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, cwd };
    const code = run(argv, { ...io, readStdin: () => stdin });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  function bodies(d: string): Record<string, string> {
    const shown = JSON.parse(swarmup(d, 'human:dawid', 'show', '1', '--json').out) as {
      events: Array<{ type: string; body: string }>;
    };
    return Object.fromEntries(shown.events.map((e) => [e.type, e.body.trim()]));
  }

  function started(): string {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    swarmup(d, 'human:dawid', 'new', 'Parse', 'events', '--to', 'claude:writer');
    swarmup(d, 'claude:writer', 'start', '1');
    return d;
  }

  it('keeps newlines from --body-file, with Windows line ends made plain', () => {
    const d = started();
    writeFileSync(join(d, 'f.md'), MD.replace(/\n/g, '\r\n'));
    expect(swarmup(d, 'claude:writer', 'checkpoint', '1', '--body-file', 'f.md').code).toBe(0);
    expect(bodies(d).checkpoint).toBe(MD);
    const shown = JSON.parse(swarmup(d, 'human:dawid', 'show', '1', '--json').out) as {
      task: { checkpoint: { summary: string } };
    };
    expect(shown.task.checkpoint.summary).toBe(MD);
  });

  it('reads stdin for --body-file - and for a lone - argument', () => {
    const d = started();
    expect(piped(d, 'claude:writer', MD, 'progress', '1', '--body-file', '-').code).toBe(0);
    expect(piped(d, 'claude:writer', MD, 'comment', '1', '-', '--to', 'human:dawid').code).toBe(0);
    const b = bodies(d);
    expect(b.progress).toBe(MD);
    expect(b.comment).toBe(MD);
    // A dash among other words is text, not stdin.
    expect(piped(d, 'claude:writer', 'unused', 'progress', '1', 'a', '-', 'b').code).toBe(0);
    expect(bodies(d).progress).toBe('a - b');
  });

  it('keeps newlines from -m and passes the whole text to the inbox as detail', () => {
    const d = started();
    expect(swarmup(d, 'claude:writer', 'ask', '1', '-m', `Which parser?\n\n${MD}`).code).toBe(0);
    expect(bodies(d).ask).toBe(`Which parser?\n\n${MD}`);
    const inbox = JSON.parse(swarmup(d, 'human:dawid', 'inbox', '--json').out) as Array<{
      kind: string;
      summary: string;
      detail?: string;
    }>;
    const ask = inbox.find((i) => i.kind === 'ask');
    expect(ask?.summary).toBe('Which parser?');
    expect(ask?.detail).toBe(`Which parser?\n\n${MD}`);
  });

  it('prints a multi-line body in show as indented lines under the event', () => {
    const d = started();
    swarmup(d, 'claude:writer', 'comment', '1', '-m', 'Summary line\n- one\n- two');
    const out = swarmup(d, 'human:dawid', 'show', '1').out;
    expect(out).toMatch(/comment: Summary line\n {4}- one\n {4}- two/);
  });

  it('keeps newlines in finding and channel post bodies', () => {
    const d = started();
    expect(
      swarmup(d, 'claude:writer', 'finding', 'Slow', 'fold', '--task', '1', '-m', MD).out,
    ).toBe('T-0002');
    const f = JSON.parse(swarmup(d, 'human:dawid', 'show', '2', '--json').out) as { body: string };
    expect(f.body.trim()).toBe(MD);
    const post = piped(d, 'claude:writer', MD, 'channel', 'post', 'dev', '--body-file', '-');
    expect(post.code).toBe(0);
    const msgs = JSON.parse(
      swarmup(d, 'human:dawid', 'channel', 'read', 'dev', '--json').out,
    ) as Array<{
      body: string;
    }>;
    expect(msgs[0]?.body.trim()).toBe(MD);
  });
});

describe('agent ids nothing defines', () => {
  it('refuses them as owner or reviewer, warns on unmatched wildcards, and flags stranded work', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    // One agent from a role file, one from the swarmupd config: either source defines an agent.
    writeFileSync(
      join(d, '.swarmup', 'agents', 'claude-engineer.md'),
      '---\nid: claude:engineer\n---\n',
    );
    writeFileSync(join(d, 'none.yml'), "opsd:\n  agents:\n    'codex:qa': { wake: true }\n");
    // The test's user config is no change of the checkout, which `swarmup review` would refuse.
    writeFileSync(join(d, '.git', 'info', 'exclude'), 'none.yml\n');

    swarmup(d, 'human:dawid', 'new', 'Fix', 'login', '--to', 'claude:engineer');
    swarmup(d, 'claude:engineer', 'start', '1', 'plan');

    const bad = swarmup(d, 'claude:engineer', 'review', '1', 'ready', '--to', 'codex:backend');
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/reviewer codex:backend is not a configured agent/);
    expect(bad.err).toContain('configured agents: claude:engineer, codex:qa');
    expect(swarmup(d, 'claude:engineer', 'handoff', '1', 'claude:release', 'x').code).toBe(1);
    expect(swarmup(d, 'claude:engineer', 'delegate', '1', 'claude:docs').code).toBe(1);
    expect(
      swarmup(d, 'claude:engineer', 'delegate', '1', 'claude:engineer', '--review', 'codex:backend')
        .code,
    ).toBe(1);
    expect(swarmup(d, 'human:dawid', 'new', 'Docs', '--to', 'claude:docs').code).toBe(1);
    expect(swarmup(d, 'human:dawid', 'show', '1').out).toContain('status:   in-progress');

    // A defined agent from the swarmupd config passes.
    expect(swarmup(d, 'claude:engineer', 'review', '1', 'ready', '--to', 'codex:qa').out).toContain(
      'needs-review',
    );

    // A role group needs a waking agent (AO-0140): claude:engineer is defined but does not wake.
    const asleep = swarmup(d, 'human:dawid', 'new', 'Any', 'engineer', '--to', '*:engineer');
    expect(asleep.code).toBe(1);
    expect(asleep.err).toMatch(/owner \*:engineer matches no waking agent, so no run picks it up/);
    expect(asleep.err).toContain(
      'use a role group (*:qa), or a configured agent (claude:engineer, codex:qa), or human:dawid',
    );
    writeFileSync(
      join(d, 'none.yml'),
      "opsd:\n  agents:\n    'codex:qa': { wake: true }\n    'claude:engineer': { wake: true }\n",
    );
    // A role group with a waking agent passes quietly; one with none is refused, as is assign.
    const ok = swarmup(d, 'human:dawid', 'new', 'Any', 'engineer', '--to', '*:engineer');
    expect(ok.code).toBe(0);
    expect(ok.err).toBe('');
    const orphan = swarmup(d, 'human:dawid', 'new', 'Orchestrate', '--to', '*:orchestrator');
    expect(orphan.code).toBe(1);
    expect(orphan.err).toMatch(/owner \*:orchestrator matches no waking agent/);
    expect(orphan.err).toContain('*:engineer, *:qa');
    const reassign = swarmup(d, 'human:dawid', 'assign', ok.out, '*:orchestrator');
    expect(reassign.code).toBe(1);
    expect(reassign.err).toMatch(/owner \*:orchestrator matches no waking agent/);
    expect(swarmup(d, 'human:dawid', 'assign', ok.out, 'claude:release').code).toBe(1);
    expect(swarmup(d, 'human:dawid', 'assign', ok.out, '*:qa').code).toBe(0);
    const forcedGroup = swarmup(
      d,
      'human:dawid',
      'new',
      'Orchestrate',
      '--to',
      '*:orchestrator',
      '--force',
    );
    expect(forcedGroup.code).toBe(0);
    expect(forcedGroup.err).toMatch(/warning: \*:orchestrator matches no configured agent/);
    const post = swarmup(d, 'human:dawid', 'channel', 'post', 'general', 'hi', '@*:orchestrator');
    expect(post.code).toBe(0);
    expect(post.err).toMatch(/warning: \*:orchestrator matches no configured agent/);
    const role = swarmup(d, 'human:dawid', 'channel', 'post', 'general', 'ping', '@*:engineer');
    expect(role.err).toBe('');
    expect(swarmup(d, 'claude:engineer', 'inbox').out).toContain('mention  #general');

    // --force still hands work to an undefined id; the human hears that it is stranded.
    const forced = swarmup(d, 'human:dawid', 'new', 'Release', '--to', 'claude:release', '--force');
    expect(forced.out).toBe('T-0004');
    const inbox = swarmup(d, 'human:dawid', 'inbox').out;
    expect(inbox).toMatch(/stranded\s+T-0004/);
    expect(inbox).toContain('owner claude:release is not a configured agent');
    expect(inbox).toMatch(/stranded\s+T-0003/);
    expect(inbox).not.toMatch(/stranded\s+T-000[12]/);
  });
});

describe('supervisor commands without swarmupd', () => {
  it('reports that swarmupd is not running', async () => {
    const d = repo();
    const state = join(d, 'state');
    const out: string[] = [];
    const err: string[] = [];
    const env = {
      SWARMUP_CONFIG: join(d, 'none.yml'),
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, cwd: d };
    expect(await run(['daemon', 'status'], io)).toBe(3);
    expect(out.pop()).toBe('swarmupd is not running');
    expect(await run(['runs'], io)).toBe(0);
    expect(out.pop()).toBe('no live runs');
    expect(await run(['launch', 'claude:qa'], io)).toBe(2);
    expect(err.pop()).toContain('swarmupd is not running');
    expect(await run(['logs', 'NOPE'], io)).toBe(2);
    expect(await run(['daemon', 'start', '--port', 'x'], io)).toBe(2);
  });

  it('prints the merge under way in swarmup waits and swarmup runs (AO-0161)', async () => {
    const d = repo();
    const state = join(d, 'state');
    mkdirSync(state, { recursive: true });
    const ago = (min: number): string => new Date(Date.now() - min * 60_000 - 1_000).toISOString();
    const answer = {
      providers: {},
      waits: [
        {
          kind: 'task',
          task: 'swarmup/AO-0158',
          title: 'Other work',
          project: 'swarmup',
          review: false,
          agents: ['claude:engineer'],
          reason: 'claude:engineer: swarmupd merges swarmup/AO-0157 into v2 in C:/dev/agent-ops',
          merge: true,
        },
      ],
      merge: {
        task: 'swarmup/AO-0157',
        what: '0b55674 on branch claude/ao-0157-x',
        base: 'v2',
        top: 'C:/dev/agent-ops',
        step: 'checks',
        holds: false,
        started_at: ago(12),
        command: { text: 'npm test', index: 0, count: 2, started_at: ago(4) },
        timeout_minutes: 30,
      },
    };
    // A stub swarmupd that answers `GET /api/waits` only.
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/api/waits' ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/api/waits' ? answer : { error: 'no route' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(state, 'opsd.json'),
        JSON.stringify({ pid: process.pid, port, token: 'x', started_at: ago(60), version: 't' }),
      );
      const out: string[] = [];
      const env = {
        SWARMUP_CONFIG: join(d, 'none.yml'),
        SWARMUP_STATE_DIR: state,
      } as NodeJS.ProcessEnv;
      const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
      const merging = [
        'merging: swarmup/AO-0157 into v2 in C:/dev/agent-ops, 12m so far',
        '  0b55674 on branch claude/ao-0157-x',
        "  running the checks in swarmupd's worktree: 1/2 `npm test`, 4m of 30m",
      ];
      expect(await run(['waits'], io)).toBe(0);
      expect(out.splice(0)).toEqual([
        ...merging,
        '',
        'swarmup/AO-0158 Other work',
        '  claude:engineer: swarmupd merges swarmup/AO-0157 into v2 in C:/dev/agent-ops',
      ]);
      expect(await run(['runs'], io)).toBe(0);
      expect(out.slice(0, 5)).toEqual(['no live runs', '', ...merging]);
      expect(out.slice(5)).toContain('waiting:');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('pauses and resumes swarmupd in the config while it is down', async () => {
    const d = repo();
    const out: string[] = [];
    const cfg = join(d, 'config.yml');
    const env = { SWARMUP_CONFIG: cfg, SWARMUP_STATE_DIR: join(d, 'state') } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
    expect(await run(['daemon', 'pause'], io)).toBe(0);
    expect(out.pop()).toMatch(/swarmupd paused/);
    expect(readFileSync(cfg, 'utf8')).toMatch(/paused: true/);
    expect(await run(['daemon', 'status'], io)).toBe(3);
    expect(out.pop()).toBe('swarmupd is not running (paused: it starts paused)');
    expect(await run(['daemon', 'resume'], io)).toBe(0);
    expect(readFileSync(cfg, 'utf8')).not.toMatch(/paused/);
    expect(await run(['daemon', 'status'], io)).toBe(3);
    expect(out.pop()).toBe('swarmupd is not running');
    expect(await run(['daemon', 'nap'], io)).toBe(2);
  });
});

describe('several roots', () => {
  it('scopes next, next --all and list to --root', () => {
    const alpha = repo();
    const beta = repo();
    const out: string[] = [];
    const env = {
      SWARMUP_CONFIG: join(alpha, 'none.yml'),
      SWARMUP_AGENT: 'claude:engineer',
      SWARMUP_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: alpha };
    run(['init', '--name', 'alpha', '--human', 'human:dawid'], io);
    run(['init', '--name', 'beta', '--prefix', 'B', '--human', 'human:dawid'], {
      ...io,
      cwd: beta,
    });
    run(['new', 'alpha work', '--priority', 'p0'], {
      ...io,
      env: { ...env, SWARMUP_AGENT: 'human:dawid' },
    });
    run(['new', 'beta work', '--root', 'beta'], {
      ...io,
      env: { ...env, SWARMUP_AGENT: 'human:dawid' },
    });

    out.length = 0;
    expect(run(['next', '--root', 'beta'], io)).toBe(0);
    expect(out).toEqual(['B-0001\tp2\tbeta work']);

    for (const args of [
      ['next', '--all', '--root', 'beta'],
      ['list', '--root', 'beta'],
    ]) {
      out.length = 0;
      expect(run(args, io)).toBe(0);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('beta/B-0001');
      expect(out[0]).toContain('beta work');
    }

    const human = { ...io, env: { ...env, SWARMUP_AGENT: 'human:dawid' } };
    expect(run(['block', 'beta/B-0001', 'wait', '--on', 'alpha/T-0001'], human)).toBe(0);
    expect(run(['done', 'alpha/T-0001'], human)).toBe(0);
    out.length = 0;
    expect(run(['next', '--root', 'beta'], io)).toBe(0);
    expect(out).toEqual(['B-0001\tp2\tbeta work']);
  });

  it('lists tasks as root/id so equal ids stay apart', () => {
    const alpha = repo();
    const beta = repo();
    const out: string[] = [];
    const env = {
      SWARMUP_CONFIG: join(alpha, 'none.yml'),
      SWARMUP_AGENT: 'human:dawid',
      SWARMUP_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    const io = (cwd: string) => ({ out: (l: string) => out.push(l), err: () => {}, env, cwd });
    run(['init', '--name', 'alpha', '--human', 'human:dawid'], io(alpha));
    run(['init', '--name', 'beta', '--human', 'human:dawid'], io(beta));
    run(['new', 'in alpha'], io(alpha));
    run(['new', 'in beta', '--root', 'beta'], io(alpha));
    out.length = 0;
    expect(run(['list'], io(alpha))).toBe(0);
    expect(out.map((l) => l.split(/\s+/)[0]).sort()).toEqual(['alpha/T-0001', 'beta/T-0001']);
  });

  it('prints inbox items as root/id, and the printed ref answers the right task', () => {
    const alpha = repo();
    const beta = repo();
    const out: string[] = [];
    const io = (cwd: string, agent: string) => ({
      out: (l: string) => out.push(l),
      err: () => {},
      env: {
        SWARMUP_CONFIG: join(alpha, 'none.yml'),
        SWARMUP_AGENT: agent,
        SWARMUP_ROOTS: beta,
      } as NodeJS.ProcessEnv,
      cwd,
    });
    const human = (args: string[]) => run(args, io(alpha, 'human:dawid'));
    const eng = (args: string[]) => run(args, io(alpha, 'claude:engineer'));
    human(['init', '--name', 'alpha', '--human', 'human:dawid']);
    run(['init', '--name', 'beta', '--human', 'human:dawid'], io(beta, 'human:dawid'));
    human(['new', 'in alpha', '--to', 'claude:engineer']);
    human(['new', 'in beta', '--to', 'claude:engineer', '--root', 'beta']);
    for (const ref of ['alpha/T-0001', 'beta/T-0001']) {
      expect(eng(['start', ref, 'plan'])).toBe(0);
      expect(eng(['ask', ref, `question on ${ref}`])).toBe(0);
    }
    out.length = 0;
    expect(human(['inbox'])).toBe(0);
    const asks = out.filter((l) => l.startsWith('ask'));
    expect(asks.map((l) => l.split(/\s+/)[1]).sort()).toEqual(['alpha/T-0001', 'beta/T-0001']);

    out.length = 0;
    expect(human(['inbox', '--json'])).toBe(0);
    const items = JSON.parse(out.join('\n')) as Array<{ kind: string; task: string; root: string }>;
    const betaAsk = items.find((i) => i.kind === 'ask' && i.root === 'beta')!;
    expect(betaAsk.task).toBe('beta/T-0001');
    expect(human(['answer', betaAsk.task, 'yes'])).toBe(0);
    out.length = 0;
    human(['inbox']);
    expect(out.filter((l) => l.startsWith('ask')).map((l) => l.split(/\s+/)[1])).toEqual([
      'alpha/T-0001',
    ]);
  });
});

describe('setup', () => {
  it('writes the user config from flags, suggesting the root it runs in', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'site');
    const file = join(d, 'user.yml');
    const out: string[] = [];
    const env = { SWARMUP_CONFIG: file } as NodeJS.ProcessEnv;
    const code = run(['setup', '--me', 'human:dawid'], {
      out: (l) => out.push(l),
      err: () => {},
      env,
      cwd: d,
    });
    expect(code).toBe(0);
    expect(out[0]).toMatch(/^wrote .*user\.yml: me human:dawid, roots /);
    // The default providers and agents are seeded into the file; with no CLI on this PATH, the
    // agents of every default provider.
    expect(out[1]).toBe('providers: claude, codex');
    expect(out[2]).toMatch(/^agents: claude:engineer, claude:qa, .*codex:pm$/);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('me: human:dawid');
    expect(text).toContain('seeded: 1');
    expect(text).toMatch(/codex:\s+command: codex/);
    expect(text).toContain('claude:reviewer: {}');
  });
});

describe('init --user', () => {
  it('writes the user config like swarmup setup, and never touches an existing me', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'site');
    const file = join(d, 'user.yml');
    const env = { SWARMUP_CONFIG: file } as NodeJS.ProcessEnv;
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
    expect(run(['init', '--user', '--me', 'human:dawid', '--root', d], io)).toBe(0);
    expect(out[0]).toMatch(/^wrote .*user\.yml: me human:dawid, roots /);
    const first = out.length;
    expect(run(['init', '--user', '--me', 'human:other'], io)).toBe(0);
    // Seeded once: the second run writes no providers or agents.
    expect(out.slice(first)).toEqual([expect.stringMatching(/^kept .*: me human:dawid/)]);
    expect(readFileSync(file, 'utf8')).not.toContain('human:other');
  });
});

describe('a role file that does not parse', () => {
  it('is skipped with a warning; swarmup agents and swarmup next keep working', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const agents = join(d, '.swarmup', 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, 'codex-qa.md'),
      '---\nid: codex:qa\nstatus: active\ncan_claim: [bug]\n---\n',
    );
    // An unquoted `: ` inside a value is a YAML error (BLOCK_AS_IMPLICIT_KEY).
    writeFileSync(
      join(agents, 'claude-writer.md'),
      '---\nid: claude:writer\ndescription: Writes docs: carefully\n---\n',
    );

    const listed = swarmup(d, 'human:dawid', 'agents');
    expect(listed.code).toBe(0);
    expect(listed.out).toMatch(/^codex:qa\s+active\s+bug$/m);
    expect(listed.out).not.toContain('claude:writer');
    expect(listed.err).toMatch(/^warning: skipped .*claude-writer\.md: /m);
    const json = swarmup(d, 'human:dawid', 'agents', '--json');
    expect((JSON.parse(json.out) as { id: string }[]).map((a) => a.id)).toEqual(['codex:qa']);

    swarmup(d, 'human:dawid', 'new', 'Fix login', '--type', 'bug');
    expect(swarmup(d, 'codex:qa', 'next').out).toMatch(/^T-0001\t/);
    expect(swarmup(d, 'claude:writer', 'next').out).toMatch(/^T-0001\t/);
  });
});

describe('a review request for code left uncommitted (AO-0136)', () => {
  function started(type?: string) {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const args = ['new', 'Fix login', '--to', 'claude:engineer'];
    swarmup(d, 'human:dawid', ...args, ...(type ? ['--type', type] : []));
    swarmup(d, 'claude:engineer', 'start', '1', 'plan');
    return d;
  }

  it('is refused while the checkout has changes outside the task store', () => {
    const d = started('bug');
    // Task store files alone are no change of the checkout.
    expect(
      swarmup(d, 'claude:engineer', 'review', '1', 'fixed', '--to', 'codex:qa', '--json').code,
    ).toBe(0);
    swarmup(d, 'human:dawid', 'verdict', '1', 'changes', 'more');
    swarmup(d, 'claude:engineer', 'start', '1', 'again');
    writeFileSync(join(d, 'login.ts'), 'export {};\n');
    const refused = swarmup(d, 'claude:engineer', 'review', '1', 'fixed, in the checkout');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(
      /T-0001 is a bug and .+ has uncommitted changes \(login\.ts\): commit them on a task branch/,
    );
    expect(swarmup(d, 'human:dawid', 'show', '1').out).toMatch(/status:\s+in-progress/);
  });

  it('goes out when it names a commit and branch or a PR, for other types, or forced', () => {
    for (const msg of [
      'a1b2c3d on branch claude/t-0001-login: fixed, tests pass',
      'PR: https://github.com/o/r/pull/12',
    ]) {
      const d = started();
      writeFileSync(join(d, 'login.ts'), 'export {};\n');
      expect(swarmup(d, 'claude:engineer', 'review', '1', msg).code).toBe(0);
    }
    const doc = started('doc');
    writeFileSync(join(doc, 'notes.md'), 'draft\n');
    expect(swarmup(doc, 'claude:engineer', 'review', '1', 'draft is ready').code).toBe(0);
    const forced = started();
    writeFileSync(join(forced, 'login.ts'), 'export {};\n');
    expect(swarmup(forced, 'claude:engineer', 'review', '1', 'look', '--force').code).toBe(0);
  });

  it('goes out from a swarmupd run that commits what it leaves, and not from one that does not', () => {
    const state = mkdtempSync(join(tmpdir(), 'swarmup-state-'));
    dirs.push(state);
    mkdirSync(join(state, 'runs'));
    const record = (id: string, base?: string) =>
      writeFileSync(join(state, 'runs', `${id}.json`), JSON.stringify({ id, base }));
    record('RUNWITHBASE', 'a'.repeat(40));
    record('RUNNOBASE');
    const review = (cwd: string, runId: string) => {
      const env = {
        SWARMUP_CONFIG: join(cwd, 'none.yml'),
        SWARMUP_AGENT: 'claude:engineer',
        SWARMUP_RUN: runId,
        SWARMUP_RUN_STATE_DIR: state,
      } as NodeJS.ProcessEnv;
      const quiet = () => {};
      // The run holds the task under its own claim, not the one `started` made without a run.
      swarmup(cwd, 'claude:engineer', 'release', '1');
      expect(run(['start', '1', 'plan'], { out: quiet, err: quiet, env, cwd })).toBe(0);
      return run(['review', '1', 'files in the checkout'], { out: quiet, err: quiet, env, cwd });
    };
    const without = started();
    writeFileSync(join(without, 'login.ts'), 'export {};\n');
    expect(review(without, 'RUNNOBASE')).toBe(1);
    const withBase = started();
    writeFileSync(join(withBase, 'login.ts'), 'export {};\n');
    expect(review(withBase, 'RUNWITHBASE')).toBe(0);
  });
});

describe('swarmup repeat (AO-0142)', () => {
  it('adds, edits, pauses, runs and deletes a repeating task', () => {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const add = swarmup(
      d,
      'human:dawid',
      'repeat',
      'add',
      'standup',
      '--title',
      'Standup {date}',
      '--start',
      '2020-01-06 09:00',
      '--every',
      'weekdays',
      '--days',
      'mon,thu',
      '--owner',
      'claude:engineer',
      '--force',
      '-m',
      'Post the plan.',
    );
    expect(add.err).toBe('');
    expect(add.out).toMatch(/^standup\s+active\s+on mon, thu at 09:00 from 2020-01-06/);
    expect(swarmup(d, 'claude:engineer', 'repeat', 'pause', 'standup').code).toBe(1);
    expect(swarmup(d, 'human:dawid', 'repeat', 'pause', 'standup').out).toMatch(/paused/);
    expect(swarmup(d, 'human:dawid', 'repeat', 'tick').out).toBe('nothing due');
    expect(swarmup(d, 'human:dawid', 'repeat', 'resume', 'standup').out).toMatch(/active/);
    // Slots passed since 2020: one task for the latest.
    const tick = swarmup(d, 'human:dawid', 'repeat', 'tick');
    expect(tick.out).toMatch(/^standup: created T-0001 for \d{4}-\d{2}-\d{2}T09:00$/);
    expect(swarmup(d, 'human:dawid', 'repeat', 'tick').out).toBe('nothing due');
    const edit = swarmup(d, 'human:dawid', 'repeat', 'edit', 'standup', '--every', 'daily');
    expect(edit.code).toBe(2);
    expect(edit.err).toMatch(/--days goes with the weekdays rule only/);
    const edited = swarmup(
      d,
      'human:dawid',
      'repeat',
      'edit',
      'standup',
      '--when',
      'closed T-0001',
    );
    expect(edited.out).toMatch(/when closed T-0001/);
    const show = swarmup(d, 'human:dawid', 'repeat', 'show', 'standup');
    expect(show.out).toMatch(/fired:\s+1\s+last: T-0001 \(todo\)/);
    expect(show.out).toMatch(/Post the plan\./);
    expect(swarmup(d, 'human:dawid', 'repeat', 'run', 'standup').out).toBe('created T-0002');
    expect(swarmup(d, 'human:dawid', 'repeat', 'delete', 'standup').out).toMatch(/deleted/);
    expect(swarmup(d, 'human:dawid', 'repeat', 'list').out).toBe('no repeats');
    expect(swarmup(d, 'human:dawid', 'show', 'T-0002').code).toBe(0);
  });

  it('lists a name two roots share as root/name, and that ref targets one repeat', () => {
    const alpha = repo();
    const beta = repo();
    const env = {
      SWARMUP_CONFIG: join(alpha, 'none.yml'),
      SWARMUP_AGENT: 'human:dawid',
      SWARMUP_ROOTS: beta,
    } as NodeJS.ProcessEnv;
    const cli = (cwd: string, ...argv: string[]) => {
      const out: string[] = [];
      const code = run(argv, { out: (l) => out.push(l), err: () => {}, env, cwd });
      return { code, out };
    };
    cli(alpha, 'init', '--name', 'alpha', '--human', 'human:dawid');
    cli(beta, 'init', '--name', 'beta', '--human', 'human:dawid');
    const same = ['--title', 'Report', '--start', '2099-01-05 09:00', '--every', 'weekly'];
    expect(cli(alpha, 'repeat', 'add', 'alpha/report', ...same).code).toBe(0);
    expect(cli(alpha, 'repeat', 'add', 'beta/report', ...same).code).toBe(0);
    expect(cli(alpha, 'repeat', 'add', 'standup', ...same).code).toBe(0);
    const list = cli(alpha, 'repeat', 'list');
    expect(list.out.map((l) => l.split(/\s+/)[0])).toEqual([
      'alpha/report',
      'beta/report',
      'standup',
    ]);
    const paused = cli(alpha, 'repeat', 'pause', list.out[1]!.split(/\s+/)[0]!);
    expect(paused.out[0]).toMatch(/^beta\/report\s+paused/);
    const after = cli(alpha, 'repeat', 'list').out;
    expect(after[0]).toMatch(/^alpha\/report\s+active/);
    expect(after[1]).toMatch(/^beta\/report\s+paused/);
  });
});

describe('swarmup adopt and swarmup new-project', () => {
  it('proposes without writing, then creates the root with --apply', () => {
    const d = repo();
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({
        name: 'shop',
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '1' },
      }),
    );
    const dry = swarmup(d, 'human:dawid', 'adopt');
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/stack:\s+node/);
    expect(dry.out).toMatch(/1\. p2 {2}Record the baseline: build and test shop/);
    expect(dry.out).toMatch(/nothing written/);
    expect(existsSync(join(d, '.swarmup'))).toBe(false);
    const json = JSON.parse(swarmup(d, 'human:dawid', 'adopt', '--json').out) as {
      plan: { prefix: string };
    };
    expect(json.plan.prefix).toBe('SHO');
    const applied = swarmup(
      d,
      'human:dawid',
      'adopt',
      '--apply',
      '--prefix',
      'shp',
      '--agents',
      'claude:qa',
    );
    expect(applied.code).toBe(0);
    expect(applied.out).toMatch(/roles: claude:qa/);
    expect(applied.out).toMatch(/SHP-0001\s+Record the baseline/);
    expect(swarmup(d, 'human:dawid', 'list').out).toMatch(/SHP-0002/);
    expect(swarmup(d, 'human:dawid', 'adopt').code).toBe(1);
  });

  it('adopt --store keeps the tasks apart from the repo and names the code checkout', () => {
    const d = repo();
    execFileSync('git', ['checkout', '-q', '-b', 'trunk'], { cwd: d, windowsHide: true });
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'shop' }));
    const store = mkdtempSync(join(tmpdir(), 'swarmup-cli-store-'));
    dirs.push(store);
    // The proposal is the same with or without --store, and writes nothing.
    expect(swarmup(d, 'human:dawid', 'adopt', '--store', store).out).toMatch(/nothing written/);
    expect(existsSync(join(store, '.swarmup'))).toBe(false);
    const res = swarmup(d, 'human:dawid', 'adopt', '--apply', '--store', store);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/git init/);
    expect(res.out).toMatch(/SHO-0001\s+Record the baseline/);
    expect(res.out).toMatch(/as the code checkout of shop \(merge base trunk\)/);
    expect(existsSync(join(d, '.swarmup'))).toBe(false);
    expect(existsSync(join(store, '.swarmup', 'config.yml'))).toBe(true);
    const config = readFileSync(join(d, 'none.yml'), 'utf8');
    expect(config).toMatch(/roots:\n\s+- /);
    expect(config).toMatch(/code:\n\s+shop: /);
    expect(config).toMatch(/merge:\n\s+shop:\n\s+base: trunk\n\s+checkout: /);
  });

  it('lists templates and starts a project from one', () => {
    const d = repo();
    expect(swarmup(d, 'human:dawid', 'new-project', '--list').out).toMatch(/^web-app\s+a web app/);
    expect(swarmup(d, 'human:dawid', 'new-project', 'app').code).toBe(2);
    const res = swarmup(d, 'human:dawid', 'new-project', 'app', '--template', 'web-app');
    expect(res.code).toBe(0);
    expect(res.out).not.toMatch(/git init/);
    expect(res.out).toMatch(/wrote README.md, AGENTS.md, .gitignore/);
    expect(res.out).toMatch(/APP-0001\s+Pick the stack and scaffold app/);
    expect(existsSync(join(d, 'app', '.swarmup', 'agents', 'cursor-frontend.md'))).toBe(true);
  });
});

describe('inbox recommendations and blocked tasks (AO-0065, AO-0066, AO-0068)', () => {
  function demo(): string {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    swarmup(d, 'human:dawid', 'new', 'Pick', 'db', '--to', 'claude:engineer');
    return d;
  }

  it('prints the recommendation on its own line and the blocked tasks on the item line', () => {
    const d = demo();
    swarmup(d, 'human:dawid', 'new', 'Schema', '--to', 'claude:engineer');
    swarmup(d, 'human:dawid', 'new', 'Seed', '--to', 'claude:engineer');
    swarmup(d, 'claude:engineer', 'start', '2');
    swarmup(d, 'claude:engineer', 'block', '2', 'needs the db', '--on', '1');
    swarmup(d, 'claude:engineer', 'start', '3');
    swarmup(d, 'claude:engineer', 'block', '3', 'needs the schema', '--on', '2');
    swarmup(d, 'claude:engineer', 'start', '1');
    const asked = swarmup(d, 'claude:engineer', 'ask', '1', 'Which db?', '--recommend', 'Postgres');
    expect(asked.code).toBe(0);
    expect(asked.err).not.toMatch(/no --recommend/);
    expect(swarmup(d, 'human:dawid', 'inbox').out.split('\n')).toEqual([
      'ask      T-0001   from claude:engineer: Which db? (blocks 1: T-0002 (+1 indirect))',
      '         recommend: Postgres',
    ]);
    const json = JSON.parse(swarmup(d, 'human:dawid', 'inbox', '--json').out) as Array<{
      recommend?: string;
      blocks?: { direct: string[]; indirect: string[] };
    }>;
    expect(json[0]).toMatchObject({
      recommend: 'Postgres',
      blocks: { direct: ['T-0002'], indirect: ['T-0003'] },
    });
    expect(swarmup(d, 'human:dawid', 'show', '1').out).toMatch(
      /ask -> human:dawid: Which db\?\n {4}recommend: Postgres/,
    );
  });

  it('warns on an ask without --recommend and still writes it', () => {
    const d = demo();
    swarmup(d, 'claude:engineer', 'start', '1');
    const asked = swarmup(d, 'claude:engineer', 'ask', '1', 'Which db?');
    expect(asked.code).toBe(0);
    expect(asked.err).toMatch(/warning: no --recommend/);
  });

  it('reports the tasks each answer unblocked, also in the --post text (AO-0068)', () => {
    const d = demo();
    swarmup(d, 'human:dawid', 'new', 'Schema', '--to', 'claude:engineer');
    swarmup(d, 'claude:engineer', 'start', '2');
    swarmup(d, 'claude:engineer', 'block', '2', 'needs the db', '--on', '1');
    swarmup(d, 'claude:engineer', 'start', '1');
    swarmup(d, 'claude:engineer', 'ask', '1', 'Which db?', '--recommend', 'Postgres');
    expect(swarmup(d, 'human:dawid', 'answer', '1', 'Postgres').code).toBe(0);
    nextMs();
    const report = swarmup(d, 'human:dawid', 'report', '--days', '1');
    expect(report.code).toBe(0);
    expect(report.out).toMatch(
      /^Answers: 1 given, 2 tasks unblocked \(median 2 per answer\), median wait 0 min, 1 of 1 recommendations accepted\.$/m,
    );
    expect(report.out).toMatch(/^Top answers by tasks unblocked: T-0001 2 by human:dawid/m);
    expect(swarmup(d, 'human:dawid', 'report', '--days', '1', '--post', 'general').code).toBe(0);
    expect(swarmup(d, 'human:dawid', 'channel', 'read', 'general').out).toContain(
      'Answers: 1 given, 2 tasks unblocked',
    );
  });

  it('prints Wrapped cards whose counts match swarmup report for the project (AO-0084)', () => {
    const d = demo();
    swarmup(d, 'claude:engineer', 'start', '1');
    swarmup(d, 'claude:engineer', 'ask', '1', 'Which db?', '--recommend', 'Postgres');
    swarmup(d, 'human:dawid', 'answer', '1', 'Postgres');
    swarmup(d, 'human:dawid', 'done', '1', 'picked');
    nextMs();
    const text = swarmup(d, 'human:dawid', 'wrapped', '--days', '1', '--project', 'demo');
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^Wrapped demo \d{4}-\d\d-\d\d to \d{4}-\d\d-\d\d$/m);
    expect(text.out).toMatch(/^Tasks closed: 1 \(1 opened\)$/m);
    expect(text.out).toMatch(/^Fastest answer: T-0001 in under a minute \(asked human:dawid\)$/m);
    const w = JSON.parse(swarmup(d, 'human:dawid', 'wrapped', '--days', '1', '--json').out);
    const r = JSON.parse(swarmup(d, 'human:dawid', 'report', '--days', '1', '--json').out);
    expect([w.closed, w.opened, w.agentMinutes]).toEqual([
      r.totals.closed,
      r.totals.opened,
      r.totals.minutes,
    ]);
    const other = JSON.parse(
      swarmup(d, 'human:dawid', 'report', '--days', '1', '--project', 'other', '--json').out,
    );
    expect(other).toMatchObject({ project: 'other', projects: [], totals: { closed: 0 } });
  });

  it('cuts a long blocked list to five ids', () => {
    const many = Array.from({ length: 7 }, (_, i) => `T-000${i + 2}`);
    expect(blocksLabel({ direct: many, indirect: ['T-0010', 'T-0011'] })).toBe(
      'blocks 7: T-0002, T-0003, T-0004, T-0005, T-0006, +2 (+2 indirect)',
    );
  });
});

describe('swarmup plan (AO-0110)', () => {
  const PLAN = [
    'items:',
    '  - key: apple',
    '    title: Apple Developer account',
    '    owner: human:dawid',
    '    estimate: 1h',
    '  - key: ci',
    '    title: Build and sign the .dmg in CI',
    "    owner: '*:engineer'",
    '    after: [apple]',
    '    estimate: 4h',
    '    review: codex:qa',
    '',
  ].join('\n');

  function milestone(): string {
    const d = repo();
    swarmup(d, 'human:dawid', 'init', '--name', 'demo', '--human', 'human:dawid');
    const made = swarmup(
      d,
      'human:dawid',
      ...['new', 'Desktop app ships on macOS', '--type', 'milestone', '--to', 'claude:pm'],
      ...['--done-when', 'A signed .dmg from CI installs on a clean Mac'],
    );
    expect(made.code).toBe(0);
    writeFileSync(join(d, 'plan.yml'), PLAN);
    swarmup(d, 'claude:pm', 'start', '1', 'write the plan');
    return d;
  }

  it('proposes a plan, creates its tasks with one approval, and writes nothing the second time', () => {
    const d = milestone();
    const proposed = swarmup(d, 'claude:pm', 'plan', 'propose', '1', '--file', 'plan.yml');
    expect(proposed).toMatchObject({ code: 0, out: 'T-0001 needs-review (owner claude:pm)' });
    const pending = swarmup(d, 'human:dawid', 'plan', 'show', '1').out;
    expect(pending).toMatch(/waits for approval: \S+ by claude:pm, 2 items, 5 h/);

    const refused = swarmup(d, 'claude:pm', 'plan', 'approve', '1');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/only a person approves a plan/);
    const approved = swarmup(d, 'human:dawid', 'plan', 'approve', '1');
    expect(approved.code).toBe(0);
    expect(approved.out.split('\n')).toEqual([
      'T-0001 blocked (owner *:qa)',
      "created T-0002 for 'apple'",
      "created T-0003 for 'ci'",
    ]);
    const ci = JSON.parse(swarmup(d, 'human:dawid', 'show', '3', '--json').out);
    expect(ci.meta).toMatchObject({
      parent: 'T-0001',
      blocked_by: ['T-0002'],
      plan_item: 'T-0001#ci',
      review: 'codex:qa',
      labels: ['milestone:T-0001'],
    });

    const again = swarmup(d, 'claude:engineer', 'plan', 'apply', '1');
    expect(again).toMatchObject({ code: 0 });
    expect(again.out).toMatch(/nothing to write: the plan is applied/);
    expect(swarmup(d, 'human:dawid', 'list').out.split('\n')).toHaveLength(3);

    const shown = swarmup(d, 'human:dawid', 'plan', 'show', '1').out;
    expect(shown).toMatch(/plan: 2 items, 5 h, 0 min spent; approved in \S+, planner claude:pm/);
    expect(shown).toMatch(/^ci\s+T-0003\s+blocked\s+\*:engineer\s+apple\s+4h/m);
    const yaml = swarmup(d, 'human:dawid', 'plan', 'show', '1', '--yaml').out;
    expect(yaml).toMatch(/^items:\n {2}- key: apple/);
    expect(yaml).not.toMatch(/origin/);
  });

  it('sends a plan back, amends an approved one, and names the plan file it needs', () => {
    const d = milestone();
    expect(swarmup(d, 'claude:pm', 'plan', 'propose', '1')).toMatchObject({ code: 2 });
    swarmup(d, 'claude:pm', 'plan', 'propose', '1', '--file', 'plan.yml');
    const back = swarmup(d, 'human:dawid', 'plan', 'reject', '1', 'T-0001: add a smoke check');
    expect(back).toMatchObject({ code: 0, out: 'T-0001 todo (owner claude:pm)' });
    swarmup(d, 'claude:pm', 'start', '1', 'revise');
    swarmup(d, 'claude:pm', 'plan', 'propose', '1', '--file', 'plan.yml');
    swarmup(d, 'human:dawid', 'plan', 'approve', '1');

    writeFileSync(
      join(d, 'sub.yml'),
      "items:\n  - key: notarize\n    title: Notarize the build\n    owner: '*:engineer'\n    estimate: 1h\n    for: ci\n",
    );
    const amend = ['plan', 'amend', '1', '--file', 'sub.yml'];
    expect(swarmup(d, 'claude:pm', ...amend).code).toBe(2);
    const amended = swarmup(d, 'claude:pm', ...amend, '--kind', 'subtask');
    expect(amended.code).toBe(0);
    expect(amended.out).toMatch(/created T-0004 for 'notarize'/);
    const over = swarmup(d, 'claude:pm', ...amend, '--kind', 'subtask');
    expect(over.code).toBe(1);
    expect(over.err).toMatch(/use --kind change/);
    expect(swarmup(d, 'claude:pm', 'plan', 'drop', '1').code).toBe(2);
  });

  it('files fix tasks from a failed check, and shows the failed checks and parked items', () => {
    const d = milestone();
    swarmup(d, 'claude:pm', 'plan', 'propose', '1', '--file', 'plan.yml');
    swarmup(d, 'human:dawid', 'plan', 'approve', '1');
    swarmup(d, 'human:dawid', 'park', '2', 'dropped');
    swarmup(d, 'human:dawid', 'park', '3', 'dropped');
    const fix = (key: string): string[] => {
      writeFileSync(
        join(d, `${key}.yml`),
        `items:\n  - key: ${key}\n    title: Fix ${key}\n    owner: '*:engineer'\n    estimate: 1h\n`,
      );
      return ['plan', 'amend', '1', '--kind', 'fix', '--file', `${key}.yml`];
    };
    // The check, twice: each failed one files a fix task, which the person then drops.
    for (const [key, task] of [
      ['fix-a', '4'],
      ['fix-b', '5'],
    ] as const) {
      expect(swarmup(d, 'codex:qa', 'start', '1', 'run the check').code).toBe(0);
      const failed = swarmup(d, 'codex:qa', ...fix(key), '-m', `check failed: ${key} is missing`);
      expect(failed.code).toBe(0);
      expect(failed.out.split('\n')).toEqual([
        'T-0001 blocked (owner *:qa)',
        `created T-000${task} for '${key}'`,
      ]);
      swarmup(d, 'human:dawid', 'park', task, 'dropped');
    }
    const shown = swarmup(d, 'human:dawid', 'plan', 'show', '1').out;
    expect(shown).toMatch(
      /^parked: apple \(T-0002\), ci \(T-0003\), fix-a \(T-0004\), fix-b \(T-0005\)$/m,
    );
    expect(shown).toMatch(
      /^failed checks: 2 of the 2 that add fix tasks; the next failed check asks instead \(swarmup ask\)$/m,
    );
    expect(shown).toMatch(/^ {2}\S+ codex:qa: fixes fix-a; check failed: fix-a is missing$/m);

    // The third failed check adds no fix tasks.
    swarmup(d, 'codex:qa', 'start', '1', 'run the check');
    const third = swarmup(d, 'codex:qa', ...fix('fix-c'));
    expect(third.code).toBe(1);
    expect(third.err).toMatch(/has failed 2 times.*ask with swarmup ask T-0001/);
    expect(swarmup(d, 'human:dawid', 'list', '--all').out).not.toMatch(/T-0006/);
  });
});
