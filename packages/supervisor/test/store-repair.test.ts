import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, type Root, ulid, Workspace } from '@swarmup/core';
import { opsdConfig, Supervisor } from '../src/index.js';
import {
  finishRebuild,
  listSandboxOwned,
  parseSandboxOwned,
  remakeDir,
  remakeFile,
  repairRoot,
  type SandboxOwned,
  STALE_TEMP_MS,
  staleTempFiles,
} from '../src/store-repair.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-repair-'));
  dirs.push(d);
  return d;
}

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
});

/** A task store with one task, and the environment its swarmupd and workspaces use. */
function store(): { repo: string; env: NodeJS.ProcessEnv; ws: Workspace; root: Root; id: string } {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const env = {
    ...process.env,
    SWARMUP_CONFIG: join(repo, 'none.yml'),
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const ws = new Workspace({ cwd: repo, env, actor: 'human:dawid', user: {} });
  const root = ws.roots[0]!;
  const id = ws.newTask({ title: 'Made by a sandbox session' }).id;
  return { repo, env, ws, root, id };
}

/** A swarmupd on the store whose listing of sandbox-owned entries is `owned`. */
function supervisor(
  s: { repo: string; env: NodeJS.ProcessEnv },
  owned: () => SandboxOwned[],
  opsd: Record<string, unknown> = {},
  now?: () => number,
): { sup: Supervisor; log: string[]; listed: string[][] } {
  const listed: string[][] = [];
  const sup = new Supervisor({
    env: s.env,
    cwd: s.repo,
    user: {},
    config: opsdConfig({ opsd: { sync: false, runtimes: {}, ...opsd } }),
    now,
    sandboxOwned: (given) => {
      listed.push(given);
      return Promise.resolve(owned());
    },
  });
  sups.push(sup);
  const log: string[] = [];
  sup.on('repair', (m: string) => log.push(`repair ${m}`));
  sup.on('warn', (m: string) => log.push(`warn ${m}`));
  return { sup, log, listed };
}

/** The `.repair` folders and temp files a repair must not leave behind. */
function leftBehind(root: Root, dir: string): string[] {
  const tmp = join(root.opsDir, 'tmp');
  return [
    ...readdirSync(dir).filter((n) => n.endsWith('.repair')),
    ...(existsSync(tmp) ? readdirSync(tmp) : []),
  ];
}

describe('store repair after Codex sandbox sessions (AO-0287)', () => {
  it('reads the kinds and paths of a listing', () => {
    const out =
      'F\tC:\\store\\tasks\\T-0001\\task.md\r\nD\tC:\\store\\tasks\\T-0001\nR\t/s/.a.x.repair\n\nnoise\n';
    expect(parseSandboxOwned(out)).toEqual([
      { kind: 'file', path: 'C:\\store\\tasks\\T-0001\\task.md' },
      { kind: 'dir', path: 'C:\\store\\tasks\\T-0001' },
      { kind: 'leftover', path: '/s/.a.x.repair' },
    ]);
  });

  it('makes a file again with the same content and times, and leaves no temp file', () => {
    const { root, id } = store();
    const file = join(root.liveDir(id), 'task.md');
    const content = readFileSync(file, 'utf8');
    const then = new Date('2026-11-12T10:00:00Z');
    utimesSync(file, then, then);

    expect(remakeFile(root, file)).toBe(true);

    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(statSync(file).mtimeMs).toBe(then.getTime());
    expect(leftBehind(root, root.liveDir(id))).toEqual([]);
    expect(remakeFile(root, join(root.liveDir(id), 'missing.md'))).toBe(false);
    expect(remakeFile(root, root.liveDir(id))).toBe(false);
  });

  it('makes a folder again under its name with everything it held', () => {
    const { root, ws, id } = store();
    ws.comment(id, 'a note');
    const dir = root.liveDir(id);
    const before = readdirSync(join(dir, 'events'));
    const task = readFileSync(join(dir, 'task.md'), 'utf8');
    expect(before.length).toBeGreaterThan(0);

    expect(remakeDir(dir)).toBe(true);
    expect(remakeDir(join(dir, 'events'))).toBe(true);

    expect(readdirSync(dir).sort()).toEqual(['events', 'task.md']);
    expect(readdirSync(join(dir, 'events'))).toEqual(before);
    expect(readFileSync(join(dir, 'task.md'), 'utf8')).toBe(task);
    expect(leftBehind(root, dirname(dir))).toEqual([]);
    expect(remakeDir(join(dir, 'gone'))).toBe(false);
    // The task reads and takes events as before.
    ws.comment(id, 'after the repair');
    expect(ws.showEvents(id).events.at(-1)?.body).toContain('after the repair');
  });

  it('ends a rebuild that was cut off after some files moved', () => {
    const { root, ws, id } = store();
    ws.comment(id, 'first');
    ws.comment(id, 'second');
    const events = join(root.liveDir(id), 'events');
    const names = readdirSync(events);
    // What a swarmupd that died mid-move leaves: the new folder with the first file in it.
    const fresh = join(root.liveDir(id), `.events.${ulid()}.repair`);
    mkdirSync(fresh);
    const moved = readFileSync(join(events, names[0]!));
    writeFileSync(join(fresh, names[0]!), moved);
    rmSync(join(events, names[0]!));

    expect(finishRebuild(fresh)).toBe(true);

    expect(readdirSync(events)).toEqual(names);
    expect(readdirSync(root.liveDir(id)).sort()).toEqual(['events', 'task.md']);
    expect(finishRebuild(fresh)).toBe(false);
  });

  it('ends a rebuild that was cut off after the old folder was removed', () => {
    const { root, id } = store();
    const events = join(root.liveDir(id), 'events');
    const names = readdirSync(events);
    const fresh = join(root.liveDir(id), `.events.${ulid()}.repair`);
    mkdirSync(fresh);
    for (const n of names) writeFileSync(join(fresh, n), readFileSync(join(events, n)));
    rmSync(events, { recursive: true });

    expect(finishRebuild(fresh)).toBe(true);
    expect(readdirSync(events)).toEqual(names);
  });

  it('repairs a root: folders before their files, stale locks, and nothing in .ops/tmp', async () => {
    const { root, ws, id } = store();
    ws.comment(id, 'a note');
    const dir = root.liveDir(id);
    const event = join(dir, 'events', readdirSync(join(dir, 'events'))[0]!);
    const marker = join(root.opsDir, 'read', 'codex-pm.json');
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '{"last":"01"}');
    const locks = join(root.opsDir, 'locks');
    mkdirSync(locks, { recursive: true });
    // A lock of a process that is gone, and one this process holds.
    const dead = join(locks, 'task-T-0009.lock');
    writeFileSync(dead, `999999999 ${new Date().toISOString()}\n`);
    const held = join(locks, 'task-T-0008.lock');
    writeFileSync(held, `${process.pid} ${new Date().toISOString()}\n`);
    const tmp = join(root.opsDir, 'tmp', `${ulid()}.tmp`);
    mkdirSync(dirname(tmp), { recursive: true });
    writeFileSync(tmp, 'left by a failed rename');

    const res = await repairRoot(root, [
      { kind: 'file', path: event },
      { kind: 'file', path: join(dir, 'task.md') },
      { kind: 'dir', path: join(dir, 'events') },
      { kind: 'dir', path: dir },
      { kind: 'file', path: marker },
      { kind: 'file', path: dead },
      { kind: 'file', path: held },
      { kind: 'file', path: tmp },
      { kind: 'dir', path: locks },
      { kind: 'file', path: join(dirname(root.dir), 'outside.txt') },
    ]);

    expect(res).toEqual({
      files: 3,
      dirs: 2,
      locks: 1,
      failed: [{ path: locks, why: 'the sandbox user owns the lock folder' }],
    });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(held)).toBe(true);
    expect(readFileSync(tmp, 'utf8')).toBe('left by a failed rename');
    expect(readdirSync(dirname(tmp))).toEqual([basename(tmp)]);
    expect(readFileSync(marker, 'utf8')).toBe('{"last":"01"}');
    expect(ws.showEvents(id).events.at(-1)?.body).toContain('a note');
    // The task's lock is free again.
    expect(readdirSync(locks)).toEqual([basename(held)]);
  });

  it('leaves a task whose lock is held for the next repair', async () => {
    const { root, id } = store();
    const file = join(root.liveDir(id), 'task.md');
    const lock = join(root.opsDir, 'locks', `task-${id}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, `${process.pid} ${new Date().toISOString()}\n`);

    const started = Date.now();
    const res = await repairRoot(root, [
      { kind: 'file', path: file },
      { kind: 'dir', path: join(root.liveDir(id), 'events') },
      { kind: 'dir', path: root.liveDir(id) },
    ]);

    expect(res.files + res.dirs).toBe(0);
    expect(res.failed.map((f) => f.why)).toEqual([
      expect.stringContaining('timed out waiting for lock'),
      `the lock of ${id} is held`,
      `the lock of ${id} is held`,
    ]);
    // One wait for the task, not one per entry.
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('names temp files older than an hour as stale', () => {
    const { root } = store();
    const dir = join(root.opsDir, 'tmp');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const old = join(dir, 'old.tmp');
    writeFileSync(old, 'x');
    const then = new Date(now - STALE_TEMP_MS - 60_000);
    utimesSync(old, then, then);
    writeFileSync(join(dir, 'fresh.tmp'), 'x');
    writeFileSync(join(dir, 'other.txt'), 'x');
    utimesSync(join(dir, 'other.txt'), then, then);

    expect(staleTempFiles(root, now)).toEqual([old]);
  });

  it('swarmupd repairs each root from the listing, and logs what it did', async () => {
    const s = store();
    const file = join(s.root.liveDir(s.id), 'task.md');
    const content = readFileSync(file, 'utf8');
    const { sup, log, listed } = supervisor(s, () => [{ kind: 'file', path: file }]);

    await sup.repairStores();

    expect(listed).toEqual([[s.root.dir]]);
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(log).toEqual([
      'repair test: made 1 file(s) and 0 folder(s) of the Codex sandbox user again, removed 0 stale lock(s)',
    ]);
  });

  it('swarmupd names stale temp files and deletes them only when the setting is on', async () => {
    const s = store();
    const dir = join(s.root.opsDir, 'tmp');
    mkdirSync(dir, { recursive: true });
    const old = join(dir, `${ulid()}.tmp`);
    writeFileSync(old, 'x');
    const then = new Date(Date.now() - STALE_TEMP_MS - 60_000);
    utimesSync(old, then, then);

    const off = supervisor(s, () => []);
    await off.sup.repairStores();
    await off.sup.repairStores();
    expect(existsSync(old)).toBe(true);
    // Once, not once per repair.
    expect(off.log).toEqual([
      `warn 1 temp file(s) older than an hour in ${dir}; nothing reads them. ` +
        'Set swarmupd.remove_stale_temp: true to have swarmupd delete such files',
    ]);

    const on = supervisor(s, () => [], { remove_stale_temp: true });
    await on.sup.repairStores();
    expect(existsSync(old)).toBe(false);
    expect(on.log).toEqual(['repair test: removed 1 stale temp file(s)']);
  });

  it('swarmupd repairs nothing without a lister or with repair_stores off', async () => {
    const s = store();
    const off = supervisor(s, () => [], { repair_stores: false });
    await off.sup.repairStores();
    expect(off.listed).toEqual([]);
  });

  it('a call during a repair gets one more repair after it', async () => {
    const s = store();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const sup = new Supervisor({
      env: s.env,
      cwd: s.repo,
      user: {},
      config: opsdConfig({ opsd: { sync: false, runtimes: {} } }),
      sandboxOwned: async () => {
        calls += 1;
        if (calls === 1) await gate;
        return [];
      },
    });
    sups.push(sup);

    const first = sup.repairStores();
    const second = sup.repairStores();
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(2);
  });

  it.skipIf(process.platform !== 'win32')(
    'the Windows listing reads a store and finds nothing of a sandbox user in a new one',
    async () => {
      const { root } = store();
      // Leftovers are found by name, whoever owns them; `.git` and links are never entered.
      const fresh = join(root.dir, 'tasks', `.T-0001.${ulid()}.repair`);
      mkdirSync(fresh);
      mkdirSync(join(root.dir, '.git', `.x.${ulid()}.repair`), { recursive: true });

      expect(await listSandboxOwned([root.dir], process.env)).toEqual([
        { kind: 'leftover', path: fresh },
      ]);
    },
    60_000,
  );
});
