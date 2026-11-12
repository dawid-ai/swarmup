import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  initRoot,
  PATCH_KEY_ARGS,
  patchKey,
  Root,
  samePath,
  syncRoot,
  syncRootAsync,
  Workspace,
} from '../src/index.js';
import type { SyncResult } from '../src/index.js';
import {
  fakeToken,
  git,
  GIT_TEST_TIMEOUT,
  gitRepo,
  tempDir,
  TEST_IDENTITY,
  turn,
} from './helpers.js';

/** The remote and the two clones each test starts from, built once per sync policy. */
const worlds = new Map<string, string>();

afterAll(() => {
  for (const dir of worlds.values()) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function worldDirs(dir: string): [remote: string, a: string, b: string] {
  return [join(dir, 'remote'), join(dir, 'a'), join(dir, 'b')];
}

/** Builds `remote/` (bare), `a/` (holds the root, pushed) and `b/` (a clone) in a new folder. */
function buildWorld(policy?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarmup-test-world-'));
  const [remote, a, b] = worldDirs(dir);
  for (const d of [remote, a, b]) mkdirSync(d);
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  gitRepo(a);
  initRoot(a, { name: 'shared', human: 'human:dawid' });
  if (policy) {
    const file = join(a, '.swarmup', 'config.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('policy: checkpoint', `policy: ${policy}`),
    );
  }
  git(a, 'add', '-A');
  git(a, 'commit', '-q', '-m', 'init');
  git(a, 'remote', 'add', 'origin', remote);
  git(a, 'push', '-q', '-u', 'origin', 'main');
  git(b, 'clone', '-q', remote, '.');
  appendFileSync(join(b, '.git', 'config'), TEST_IDENTITY);
  return dir;
}

/** Points a copied clone's `origin` at the copied remote; the copy still names the original. */
function setOrigin(repo: string, remote: string): void {
  const file = join(repo, '.git', 'config');
  const url = JSON.stringify(remote.split(sep).join('/'));
  const config = readFileSync(file, 'utf8');
  const next = config.replace(/^(\s*url = ).*$/m, (_, key: string) => key + url);
  if (next === config) throw new Error(`no origin url in ${file}`);
  writeFileSync(file, next);
}

/**
 * Two machines sharing a remote. Building them takes 14 git processes (init, commit, push, clone
 * and their children), and process starts are what these tests cost on Windows under full-suite
 * load (AO-0221). So each policy's world is built once, and every test gets a file copy of it.
 */
function machines(opts: { policy?: string } = {}) {
  const key = opts.policy ?? '';
  let world = worlds.get(key);
  if (!world) {
    world = buildWorld(opts.policy);
    worlds.set(key, world);
  }
  const dir = tempDir();
  cpSync(world, dir, { recursive: true });
  const [remote, a, b] = worldDirs(dir);
  setOrigin(a, remote);
  setOrigin(b, remote);
  const env = { SWARMUP_CONFIG: join(a, 'none.yml') } as NodeJS.ProcessEnv;
  const ws = (cwd: string, actor: string, block = 0, now?: () => number) =>
    new Workspace({ cwd, env, actor, now, user: { id_block: block, machine: `m${block}` } });
  const ra = new Root(join(a, '.swarmup'));
  const rb = new Root(join(b, '.swarmup'));
  return { remote, a, b, ws, ra, rb };
}

/**
 * A sync with git off the event loop, the form swarmupd runs. The vitest worker reads its RPC
 * replies between git processes; one synchronous sync under merge-check load ran past 60 s
 * without a loop turn and failed the run with 'Timeout calling onTaskUpdate' (AO-0238).
 */
function sync(...args: Parameters<typeof syncRootAsync>): Promise<SyncResult> {
  return syncRootAsync(...args);
}

/**
 * syncRoot, the form `swarmup sync` runs, after one event-loop turn. Only the tests that check
 * syncRoot itself use it: it shares its steps with syncRootAsync, and each call holds the loop.
 */
async function syncTurn(...args: Parameters<typeof syncRoot>): Promise<SyncResult> {
  await turn();
  return syncRoot(...args);
}

/** The parts of a task's state that every clone must agree on. */
function agreed(v: { status: string; claimedBy: string | null; claimToken: string | null }) {
  const { status, claimedBy, claimToken } = v;
  return { status, claimedBy, claimToken };
}

describe('sync', { timeout: GIT_TEST_TIMEOUT }, () => {
  it('moves tasks between two machines without conflicts', async () => {
    const { a, b, ws } = machines();
    ws(a, 'human:dawid', 0).newTask({ title: 'from a' });
    ws(b, 'human:dawid', 1).newTask({ title: 'from b' });
    const ra = new Root(join(a, '.swarmup'));
    const rb = new Root(join(b, '.swarmup'));
    // On syncRoot, the form `swarmup sync` runs.
    expect(await syncTurn(ra, { machine: 'a' })).toMatchObject({ committed: 1, pushed: true });
    expect(await syncTurn(rb, { machine: 'b' })).toMatchObject({ pulled: true, pushed: true });
    await syncTurn(ra, {});
    const titles = (cwd: string) =>
      ws(cwd, 'human:dawid')
        .list()
        .map((v) => v.meta.title)
        .sort();
    expect(titles(a)).toEqual(['from a', 'from b']);
    expect(titles(b)).toEqual(['from a', 'from b']);
    expect(git(a, 'log', '-2', '--format=%s').split('\n').sort()).toEqual([
      '',
      'ops: 1 change(s) from a',
      'ops: 1 change(s) from b',
    ]);
    expect(git(a, 'log', '-1', '--format=%B')).not.toMatch(/Co-Authored-By/i);
  });

  it('merges events written on both machines for the same task', async () => {
    const { a, b, ws } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    const ra = new Root(join(a, '.swarmup'));
    const rb = new Root(join(b, '.swarmup'));
    await sync(ra, {});
    await sync(rb, {});
    ws(a, 'human:dawid').comment('1', 'from a');
    ws(b, 'human:dawid', 1).comment('1', 'from b');
    await sync(ra, {});
    await sync(rb, {});
    await sync(ra, {});
    expect(
      ws(a, 'human:dawid')
        .showEvents('1')
        .events.map((e) => e.body.trim())
        .sort(),
    ).toEqual(['from a', 'from b']);
  });

  it('lets the claim pushed first win, even when the other clone claimed earlier', async () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    await sync(ra, {});
    await sync(rb, {});
    // Both clones run claude:engineer. b's clock is a minute behind, so its events carry older
    // ids; a pushes first.
    const behind = () => Date.now() - 60_000;
    const bEng = ws(b, 'claude:engineer', 1, behind);
    const bToken = bEng.start('1', 'b plan').events.find((e) => e.type === 'claim')!.token;
    bEng.progress('1', 'b works');
    const aRes = ws(a, 'claude:engineer').start('1', 'a plan');
    const aToken = aRes.events.find((e) => e.type === 'claim')!.token;
    expect(aToken).not.toBe(bToken);
    expect((await sync(ra, {})).pushed).toBe(true);

    const res = await sync(rb, {});
    expect(res.pushed).toBe(true);
    expect(res.reordered).toBe(3);
    expect(res.lost).toEqual([
      expect.objectContaining({
        task: 'T-0001',
        actor: 'claude:engineer',
        winner: 'claude:engineer',
      }),
    ]);
    // The loser has the same agent id, but its clone's claim lost: it cannot start, report on or
    // release the winner's claim.
    expect(() => bEng.release('1', 'lost it')).toThrow(/claim from another clone/);
    expect(() => bEng.progress('1', 'still here')).toThrow(/claim from another clone/);
    ws(a, 'claude:engineer').progress('1', 'a works');
    await sync(ra, {});
    await sync(rb, {});
    // The loser is still the owner, so it may checkpoint; that must not renew the winner's lease.
    const leaseBefore = ws(a, 'human:dawid').view('1').leaseUntil;
    ws(b, 'claude:engineer', 1, () => Date.now() + 3600_000).checkpoint('1', 'notes from b');
    await sync(rb, {});
    await sync(ra, {});
    expect(ws(a, 'human:dawid').view('1').leaseUntil).toBe(leaseBefore);

    const va = ws(a, 'human:dawid').view('1');
    const vb = ws(b, 'human:dawid').view('1');
    expect(agreed(va)).toEqual({
      status: 'in-progress',
      claimedBy: 'claude:engineer',
      claimToken: aToken,
    });
    expect(agreed(vb)).toEqual(agreed(va));
    expect(vb.leaseUntil).toBe(va.leaseUntil);
    expect(vb.lostClaims).toEqual(va.lostClaims);
    expect(va.lostClaims).toHaveLength(2);
    const order = ws(a, 'human:dawid')
      .showEvents('1')
      .events.filter((e) => e.type === 'claim')
      .map((e) => e.token);
    expect(order).toEqual([aToken, bToken]);
  });

  it('keeps a local claim made after the remote claim was released', async () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    await sync(ra, {});
    await sync(rb, {});
    const aEng = ws(a, 'claude:engineer');
    aEng.claim('1');
    aEng.release('1', 'not mine after all');
    await sync(ra, {});
    const bToken = ws(b, 'claude:engineer', 1, () => Date.now() - 60_000)
      .claim('1')
      .events.find((e) => e.type === 'claim')!.token;
    expect((await sync(rb, {})).lost).toEqual([]);
    await sync(ra, {});
    for (const cwd of [a, b]) {
      expect(agreed(ws(cwd, 'human:dawid').view('1'))).toEqual({
        status: 'claimed',
        claimedBy: 'claude:engineer',
        claimToken: bToken,
      });
    }
  });

  it('pulls and orders again when a push is rejected', async () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    await sync(ra, {});
    await sync(rb, {});
    // b writes first, so its event has the older id, but a pushes first.
    ws(b, 'human:dawid', 1).comment('1', 'from b');
    ws(a, 'human:dawid').comment('1', 'from a');
    await sync(ra, {});
    const res = await sync(rb, {}, { pull: false, push: true });
    expect(res).toMatchObject({ pulled: true, pushed: true, reordered: 1 });
    await sync(ra, {});
    expect(
      ws(a, 'human:dawid')
        .showEvents('1')
        .events.map((e) => e.body.trim()),
    ).toEqual(['from a', 'from b']);
  });

  it('reports a claim as lost only when it lost in the final state of the sync', async () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    await sync(ra, {});
    await sync(rb, {});
    const aEng = ws(a, 'claude:engineer');
    aEng.claim('1');
    await sync(ra, {});
    // a releases but does not push yet; b's pre-push hook pushes it, so b's first pull sees only
    // a's claim and b's push is rejected once.
    aEng.release('1', 'done with it');
    await sync(ra, {}, { pull: false, push: false });
    const marker = join(b, 'hook-ran');
    writeFileSync(
      join(b, '.git', 'hooks', 'pre-push'),
      [
        '#!/bin/sh',
        `[ -f "${marker.split('\\').join('/')}" ] && exit 0`,
        `touch "${marker.split('\\').join('/')}"`,
        'unset $(git rev-parse --local-env-vars)',
        `git -C "${a.split('\\').join('/')}" push -q`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const bToken = ws(b, 'claude:engineer', 1)
      .claim('1')
      .events.find((e) => e.type === 'claim')!.token;
    const res = await sync(rb, {});
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(res.pushed).toBe(true);
    expect(res.lost).toEqual([]);
    await sync(ra, {});
    for (const cwd of [a, b]) {
      expect(agreed(ws(cwd, 'human:dawid').view('1'))).toEqual({
        status: 'claimed',
        claimedBy: 'claude:engineer',
        claimToken: bToken,
      });
    }
  });

  it('pushes a claim at once under coordinated sync and tells the loser', async () => {
    const { remote, a, b, ws, ra, rb } = machines({ policy: 'coordinated' });
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    await sync(ra, {});
    await sync(rb, {});
    const before = git(remote, 'rev-parse', 'main');
    const aToken = ws(a, 'claude:engineer')
      .claim('1')
      .events.find((e) => e.type === 'claim')!.token;
    expect(git(remote, 'rev-parse', 'main')).not.toBe(before);
    expect(() => ws(b, 'claude:engineer', 1, () => Date.now() - 60_000).claim('1')).toThrow(
      /lost the claim on T-0001 to claude:engineer/,
    );
    expect(() => ws(b, 'claude:engineer', 1).start('1', 'plan')).toThrow(
      /claim from another clone/,
    );
    await sync(ra, {});
    for (const cwd of [a, b]) {
      expect(ws(cwd, 'human:dawid').view('1').claimToken).toBe(aToken);
    }
  });

  it('keeps a coordinated claim locally when the push fails', async () => {
    const { a, ws, ra } = machines({ policy: 'coordinated' });
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    await sync(ra, {});
    git(a, 'remote', 'set-url', 'origin', join(a, 'no-such-remote'));
    const res = ws(a, 'claude:engineer').claim('1');
    expect(res.view.claimedBy).toBe('claude:engineer');
    expect(res.notes?.[0]).toMatch(/^not synced yet: .*the next sync sends it$/);
  });

  it('hands a coordinated sync to queueConfirm instead of running git (AO-0169)', async () => {
    const { remote, a, ws, ra } = machines({ policy: 'coordinated' });
    ws(a, 'human:dawid').newTask({ title: 't', owner: 'claude:engineer' });
    await sync(ra, {});
    const before = git(remote, 'rev-parse', 'main');
    const queued: string[][] = [];
    const opsd = new Workspace({
      cwd: a,
      env: { SWARMUP_CONFIG: join(a, 'none.yml') } as NodeJS.ProcessEnv,
      actor: 'claude:engineer',
      user: { id_block: 0 },
      queueConfirm: (roots) => queued.push(roots.map((r) => r.name)),
    });
    opsd.comment('1', 'no sync for a comment');
    expect(queued).toEqual([]);
    const res = opsd.claim('1');
    expect(res.view.claimedBy).toBe('claude:engineer');
    expect(res.notes).toBeUndefined();
    expect(queued).toEqual([['shared']]);
    // Nothing was committed or pushed: the queued sync does that.
    expect(git(remote, 'rev-parse', 'main')).toBe(before);
    expect(git(a, 'status', '--porcelain')).toContain('tasks/T-0001/events/');
  });

  it('refuses to commit a leaked secret', async () => {
    const { a, ws } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    writeFileSync(join(a, '.swarmup', 'kb', 'note.md'), `token ${fakeToken()}\n`);
    expect(() => syncRoot(new Root(join(a, '.swarmup')), {})).toThrow(/leak check failed/);
    expect(git(a, 'status', '--porcelain')).toContain('kb/note.md');
  });

  it('commits only the root and holds back pushes that carry code', async () => {
    const { a, ws } = machines();
    writeFileSync(join(a, 'code.ts'), 'export {};\n');
    ws(a, 'human:dawid').newTask({ title: 't' });
    const ra = new Root(join(a, '.swarmup'));
    expect((await sync(ra, {})).pushed).toBe(true);
    expect(git(a, 'status', '--porcelain')).toContain('code.ts');
    git(a, 'add', 'code.ts');
    git(a, 'commit', '-q', '-m', 'code');
    ws(a, 'human:dawid').newTask({ title: 'u' });
    const res = await sync(ra, {});
    expect(res.pushed).toBe(false);
    expect(res.notes.join()).toMatch(/outside \.swarmup/);
    expect((await sync(ra, {}, { allPaths: true })).pushed).toBe(true);
  });

  it('pushes code commits that are approved merges, also after a pull rebased them', async () => {
    // AO-0193: swarmupd merged into the store branch, and the store sync held the push for good.
    const { remote, a, b, ws, ra, rb } = machines();
    const keyOf = (rev: string) => patchKey(git(a, ...PATCH_KEY_ARGS, rev));
    writeFileSync(join(a, 'code.ts'), 'export const a = 1;\n');
    git(a, 'add', 'code.ts');
    git(a, 'commit', '-q', '-m', 'merged code');
    const before = git(a, 'rev-parse', 'HEAD').trim();
    const keys = new Set([keyOf(before)!]);
    const asked: string[] = [];
    // The approvals of another repo or branch never count: the sync asks for its own.
    const approved = (top: string, branch: string) => {
      asked.push(branch);
      return samePath(top, a) && branch === 'main' ? keys : new Set<string>();
    };
    expect((await sync(ra, {})).pushed).toBe(false);
    expect((await sync(ra, {}, { approved: () => new Set<string>() })).pushed).toBe(false);
    // Another clone pushes first: the pull rebases the merged commit, which gets a new id.
    ws(b, 'human:dawid', 1).newTask({ title: 'from b' });
    expect((await sync(rb, {})).pushed).toBe(true);
    ws(a, 'human:dawid').newTask({ title: 'from a' });
    const res = await sync(ra, {}, { approved });
    expect(res).toMatchObject({ pulled: true, pushed: true });
    expect(asked).toEqual(['main']);
    expect(git(a, 'log', '-1', '--format=%H', '--', 'code.ts').trim()).not.toBe(before);
    expect(git(remote, 'show', 'main:code.ts')).toBe('export const a = 1;\n');

    // A code commit no merge approved still holds the push, approved ones beside it or not.
    writeFileSync(join(a, 'code.ts'), 'export const a = 2;\n');
    git(a, 'commit', '-q', '-am', 'hand-made change');
    writeFileSync(join(a, 'more.ts'), 'export {};\n');
    git(a, 'add', 'more.ts');
    git(a, 'commit', '-q', '-m', 'merged too');
    keys.add(keyOf('HEAD')!);
    const held = await sync(ra, {}, { approved });
    expect(held.pushed).toBe(false);
    expect(held.notes.join()).toMatch(/1 file\(s\) outside \.swarmup/);
  });

  it('keys a patch by its content, not its blob ids or line numbers', () => {
    const diff = (index: string, at: string, line: string) =>
      [
        'diff --git a/x.ts b/x.ts',
        `index ${index} 100644`,
        '--- a/x.ts',
        '+++ b/x.ts',
        `@@ ${at} @@ function f`,
        ' ctx',
        line,
        '',
      ].join('\n');
    const k = patchKey(diff('1111111..2222222', '-1,1 +1,2', '+new'));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(patchKey(diff('3333333..4444444', '-9,1 +9,2', '+new'))).toBe(k);
    expect(patchKey(diff('1111111..2222222', '-1,1 +1,2', '+other'))).not.toBe(k);
    expect(patchKey('')).toBeNull();
  });

  it('waits push_minutes after a push held back for code before an auto sync tries again', async () => {
    // AO-0164: swarmupd's tick tried the held push every 15 s, and the branch pushing that comes
    // with each push round blocked swarmupd for seconds each time.
    const { a, ws, ra } = machines();
    const t = Date.now();
    ws(a, 'human:dawid').newTask({ title: 't' });
    expect((await sync(ra, {}, { auto: true, now: t })).pushed).toBe(true);
    writeFileSync(join(a, 'code.ts'), 'export {};\n');
    git(a, 'add', 'code.ts');
    git(a, 'commit', '-q', '-m', 'code');
    ws(a, 'human:dawid').newTask({ title: 'u' });
    const push = 30 * 60_000;
    const held = await sync(ra, {}, { auto: true, now: t + push });
    expect(held.pushed).toBe(false);
    expect(held.notes.join()).toMatch(/outside \.swarmup/);
    // Within push_minutes of the held try: no push is due, so no second try and no note.
    ws(a, 'human:dawid').newTask({ title: 'v' });
    const quiet = await sync(ra, {}, { auto: true, now: t + push + 60_000 });
    expect(quiet).toMatchObject({ committed: 1, pushed: false, notes: [] });
    // push_minutes after the held try, it tries again.
    const again = await sync(ra, {}, { auto: true, now: t + 2 * push });
    expect(again.notes.join()).toMatch(/outside \.swarmup/);
  });

  it('follows the policy on --auto', async () => {
    const { a, ws } = machines();
    const ra = new Root(join(a, '.swarmup'));
    ws(a, 'human:dawid').newTask({ title: 't' });
    const t = Date.now();
    expect(await sync(ra, {}, { auto: true, now: t })).toMatchObject({
      pulled: true,
      pushed: true,
    });
    ws(a, 'human:dawid').newTask({ title: 'u' });
    expect(await sync(ra, {}, { auto: true, now: t + 60_000 })).toMatchObject({
      committed: 1,
      pulled: false,
      pushed: false,
    });
    expect((await sync(ra, {}, { auto: true, sessionEnd: true, now: t + 120_000 })).pushed).toBe(
      true,
    );
  });

  it('commits only on the store branch and keeps held files for the next sync there', async () => {
    const { a, ws, ra } = machines();
    ws(a, 'human:dawid').newTask({ title: 't' });
    expect((await sync(ra, {})).committed).toBe(1);
    expect(JSON.parse(readFileSync(join(ra.opsDir, 'sync.json'), 'utf8')).branch).toBe('main');

    // A code branch checked out in the data root's checkout, as in AO-0133.
    git(a, 'checkout', '-q', '-b', 'code');
    ws(a, 'human:dawid').comment('1', 'written while code is checked out');
    const codeHead = git(a, 'rev-parse', 'code');
    const res = await sync(ra, {});
    expect(res).toMatchObject({ committed: 0, pulled: false, pushed: false });
    expect(res.notes.join()).toMatch(/code is checked out, but the store branch is main/);
    expect(git(a, 'rev-parse', 'code')).toBe(codeHead);

    git(a, 'checkout', '-q', 'main');
    expect(
      ws(a, 'human:dawid')
        .showEvents('1')
        .events.some((e) => e.body.trim() === 'written while code is checked out'),
    ).toBe(true);
    expect(await sync(ra, {})).toMatchObject({ committed: 1, pushed: true });
    expect(git(a, 'status', '--porcelain', '--', '.swarmup')).toBe('');
  });

  it('takes the store branch from sync.branch in config.yml over the learned one', async () => {
    const { a, ws, ra } = machines();
    await sync(ra, {});
    const file = join(a, '.swarmup', 'config.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        'policy: checkpoint',
        'policy: checkpoint\n  branch: store',
      ),
    );
    ws(a, 'human:dawid').newTask({ title: 't' });
    const res = await sync(new Root(join(a, '.swarmup')), {});
    expect(res.committed).toBe(0);
    expect(res.notes.join()).toMatch(/store branch is store \(from sync\.branch in config\.yml\)/);
  });

  it('does not learn a code branch on the first sync after an upgrade', async () => {
    const { a, ws, ra } = machines();
    // A stamp written before store branches existed: no branch in it.
    mkdirSync(ra.opsDir, { recursive: true });
    writeFileSync(join(ra.opsDir, 'sync.json'), JSON.stringify({ lastPull: 1, lastPush: 1 }));
    git(a, 'checkout', '-q', '-b', 'code');
    ws(a, 'human:dawid').newTask({ title: 'written while code is checked out' });
    const codeHead = git(a, 'rev-parse', 'code');
    const res = await sync(ra, {});
    expect(res).toMatchObject({ committed: 0, pulled: false, pushed: false });
    expect(res.notes.join()).toMatch(/no store branch is known yet and main also holds/);
    expect(git(a, 'rev-parse', 'code')).toBe(codeHead);
    expect(JSON.parse(readFileSync(join(ra.opsDir, 'sync.json'), 'utf8')).branch).toBeUndefined();

    // A code commit outside the store does not make the code branch the store branch.
    writeFileSync(join(a, 'code.txt'), 'x');
    git(a, 'add', 'code.txt');
    git(a, 'commit', '-q', '-m', 'code change');
    expect((await sync(ra, {})).committed).toBe(0);

    git(a, 'checkout', '-q', 'main');
    expect(await sync(ra, {})).toMatchObject({ committed: 1, pushed: true });
    expect(JSON.parse(readFileSync(join(ra.opsDir, 'sync.json'), 'utf8')).branch).toBe('main');
    git(a, 'checkout', '-q', 'code');
    ws(a, 'human:dawid').newTask({ title: 'later' });
    expect((await sync(ra, {})).notes.join()).toMatch(
      /store branch is main \(from \.ops\/sync\.json\)/,
    );
  });

  it('holds the first sync on a branch without the newest store commit', async () => {
    const { a, ws, ra } = machines();
    git(a, 'branch', 'code');
    ws(a, 'human:dawid').newTask({ title: 't' });
    git(a, 'add', '-A');
    git(a, 'commit', '-q', '-m', 'ops: 1 change(s)');
    git(a, 'checkout', '-q', 'code');
    ws(a, 'human:dawid').newTask({ title: 'u' });
    const res = await sync(ra, {});
    expect(res.committed).toBe(0);
    expect(res.notes.join()).toMatch(/the newest store commit is on main, not code/);
  });

  it('does not commit on a detached HEAD', async () => {
    const { a, ws, ra } = machines();
    await sync(ra, {});
    git(a, 'checkout', '-q', '--detach');
    ws(a, 'human:dawid').newTask({ title: 't' });
    const res = await sync(ra, {});
    expect(res.committed).toBe(0);
    expect(res.notes.join()).toMatch(/HEAD is detached; check out main/);
  });

  it('syncs off the event loop with syncRootAsync, with the same result as syncRoot', async () => {
    const { a, b, ws, ra, rb } = machines();
    ws(a, 'human:dawid', 0).newTask({ title: 'from a' });
    ws(b, 'human:dawid', 1).newTask({ title: 'from b' });
    // A synchronous sync lets no timer fire until it returns; this one runs a git process at a
    // time and serves timers in between.
    let timers = 0;
    const timer = setInterval(() => timers++, 1);
    try {
      expect(syncRoot(ra, { machine: 'a' })).toMatchObject({ committed: 1, pushed: true });
      expect(timers).toBe(0);
      const res = await syncRootAsync(rb, { machine: 'b' });
      expect(res).toMatchObject({ committed: 1, pulled: true, pushed: true, notes: [] });
      expect(timers).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
    await syncRootAsync(ra, {});
    const titles = (cwd: string) =>
      ws(cwd, 'human:dawid')
        .list()
        .map((v) => v.meta.title)
        .sort();
    expect(titles(a)).toEqual(['from a', 'from b']);
    expect(titles(b)).toEqual(['from a', 'from b']);
    // The git lock is free again for a synchronous sync.
    expect(existsSync(join(rb.opsDir, 'locks', 'git.lock'))).toBe(false);
    expect(await syncTurn(rb, {})).toMatchObject({ pulled: true });
  });

  it('settles a task.md conflict in syncRootAsync as syncRoot does', async () => {
    const conflicted = async (via: (r: Root) => SyncResult | Promise<SyncResult>) => {
      const { a, b, ws, ra, rb } = machines();
      ws(a, 'human:dawid').newTask({ title: 't' });
      await sync(ra, {});
      await sync(rb, {});
      const md = (cwd: string) => join(cwd, '.swarmup', 'tasks', 'T-0001', 'task.md');
      writeFileSync(md(a), `${readFileSync(md(a), 'utf8')}\nedited on a\n`);
      writeFileSync(md(b), `${readFileSync(md(b), 'utf8')}\nedited on b\n`);
      await sync(ra, {});
      const res = await via(rb);
      expect(res.notes.join('\n')).toMatch(/task\.md: your edit conflicted with one pushed first/);
      expect(readFileSync(md(b), 'utf8')).toContain('edited on a');
      expect(readFileSync(md(b), 'utf8')).not.toContain('edited on b');
      const { committed, pulled, pushed, reordered } = res;
      return { committed, pulled, pushed, reordered, head: git(b, 'log', '-1', '--format=%s') };
    };
    const viaAsync = await conflicted((r) => syncRootAsync(r, {}));
    expect(viaAsync).toEqual(await conflicted((r) => syncTurn(r, {})));
    expect(viaAsync.pulled).toBe(true);
  });

  it('notes a missing upstream instead of failing', async () => {
    const repo = gitRepo();
    initRoot(repo, { name: 'solo' });
    const res = await sync(new Root(join(repo, '.swarmup')), {});
    expect(res.committed).toBeGreaterThan(0);
    expect(res.notes).toEqual(['no upstream branch; skipped pull and push']);
  });
});
