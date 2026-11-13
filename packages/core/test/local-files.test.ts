// This clone's state files under `.ops` stay writable when one of them cannot be replaced
// (AO-0283). On Windows a file made by one sandboxed session (the Codex sandbox user) can be read
// by a later session, but not deleted or overwritten, so the rename over it fails with EPERM for
// good. `read-marker.test.ts` covers the inbox read marker, which takes the same path.
import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Root } from '../src/index.js';
import { readRepeatCache, writeRepeatCache } from '../src/repeats.js';
import { readMirrored, writeMirrored } from '../src/sync.js';
import { setup } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const eperm = (to: string): Error =>
  Object.assign(new Error(`EPERM: operation not permitted, rename -> '${to}'`), { code: 'EPERM' });

/** Makes every rename onto a file that `refused` accepts fail the way Windows refuses it. */
function refuse(refused: (to: string) => boolean): { tries: string[] } {
  const rename = Root.prototype.renameRetry;
  const tries: string[] = [];
  vi.spyOn(Root.prototype, 'renameRetry').mockImplementation(function (
    this: Root,
    from: string,
    to: string,
    retries?: number,
  ) {
    tries.push(`${to}:${retries}`);
    if (refused(to)) throw eperm(to);
    rename.call(this, from, to, retries);
  });
  return { tries };
}

const SPARE = /^state\.[0-9A-HJKMNP-TV-Z]{26}\.json$/;

describe('local state files that cannot be replaced (AO-0283)', () => {
  it('writes to a spare file, reuses it, and goes back to the file when that works again', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const file = join(root.opsDir, 'state.json');
    const others = (): string[] => readdirSync(root.opsDir).filter((n) => SPARE.test(n));

    expect(() => root.readLocal(file)).toThrow(/ENOENT/);
    expect(root.writeLocal(file, 'one')).toBe(file);
    expect(root.readLocal(file)).toBe('one');
    expect(root.localFile(file)).toBe(file);

    const { tries } = refuse((to) => to === file);
    const spare = root.writeLocal(file, 'two');
    expect(others()).toEqual([spare.slice(root.opsDir.length + 1)]);
    expect(readFileSync(file, 'utf8')).toBe('one');
    expect(root.readLocal(file)).toBe('two');
    expect(root.localFile(file)).toBe(spare);
    // The failed rename leaves no temp file behind.
    expect(readdirSync(join(root.opsDir, 'tmp'))).toEqual([]);

    // The next write reuses the spare, and does not wait for the refused file again.
    tries.length = 0;
    expect(root.writeLocal(file, 'three')).toBe(spare);
    expect(tries).toEqual([`${file}:0`, `${spare}:0`]);
    expect(others()).toHaveLength(1);
    expect(root.readLocal(file)).toBe('three');

    vi.restoreAllMocks();
    expect(root.writeLocal(file, 'four')).toBe(file);
    expect(others()).toEqual([]);
    expect(root.readLocal(file)).toBe('four');
  });

  it('adds another spare when the spare cannot be replaced either', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const file = join(root.opsDir, 'state.json');
    root.writeLocal(file, 'one');
    // Nothing that exists can be replaced; new files can be added.
    refuse((to) => existsSync(to));
    const first = root.writeLocal(file, 'two');
    const second = root.writeLocal(file, 'three');
    expect(second).not.toBe(first);
    expect(root.readLocal(file)).toBe('three');
    // The first spare could still be deleted, so it is gone.
    expect(existsSync(first)).toBe(false);
  });

  it('reads the file again when it was written after a spare that stayed', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const file = join(root.opsDir, 'state.json');
    root.writeLocal(file, 'one');
    refuse((to) => to === file);
    const spare = root.writeLocal(file, 'two');
    vi.restoreAllMocks();
    // A session that can replace the file, but cannot delete the other session's spare.
    root.writeAtomic(file, 'three');
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    expect(existsSync(spare)).toBe(true);
    expect(root.readLocal(file)).toBe('three');
  });

  it('still reports an error that is not a refused replacement', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const file = join(root.opsDir, 'state.json');
    vi.spyOn(Root.prototype, 'renameRetry').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
    });
    expect(() => root.writeLocal(file, 'one')).toThrow(/ENOSPC/);
    expect(readdirSync(root.opsDir).filter((n) => n.startsWith('state'))).toEqual([]);
  });

  it('keeps a file whose name starts the same apart', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const dir = join(root.opsDir, 'claims');
    root.writeLocal(join(dir, 'T-0001.json'), 'one');
    root.writeLocal(join(dir, 'T-0001.b.json'), 'other');
    // A name with a middle part that is no ULID is no spare of T-0001.json.
    root.writeLocal(join(dir, 'T-0001.01M79W2NJFR9N8DHGQFD99XMA.json'), 'short');
    expect(root.localFile(join(dir, 'T-0001.json'))).toBe(join(dir, 'T-0001.json'));
    expect(root.readLocal(join(dir, 'T-0001.json'))).toBe('one');
  });

  it('lets a task be claimed again when its claim record cannot be replaced', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    const runA = as('codex:engineer', { run: 'RUN-A' });
    runA.claim('1');
    runA.release('1', 'out of time');
    const record = join(rootDir, '.ops', 'claims', 'T-0001.json');
    const before = readFileSync(record, 'utf8');

    refuse((to) => to === record);
    const runB = as('codex:engineer', { run: 'RUN-B' });
    runB.claim('1');
    expect(readFileSync(record, 'utf8')).toBe(before);
    expect(runB.holdsClaim('1')).toBe(true);
    expect(runA.holdsClaim('1')).toBe(false);
    runB.start('1', 'plan');
    expect(() => runA.progress('1', 'mine')).toThrow(/under another claim/);
    const root = new Root(rootDir);
    expect(root.claimRecord('T-0001')).toEqual({ token: runB.view('1').claimToken, run: 'RUN-B' });

    // A session that can replace the record takes the claim over in the file itself.
    vi.restoreAllMocks();
    runB.release('1', 'done for now');
    const runC = as('claude:engineer', { run: 'RUN-C' });
    runC.claim('1');
    expect(readdirSync(join(rootDir, '.ops', 'claims'))).toEqual(['T-0001.json']);
    expect(runC.holdsClaim('1')).toBe(true);
    expect(root.claimRecord('T-0001').run).toBe('RUN-C');
  });

  it('keeps the task index in a spare file', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'first' });
    const root = new Root(rootDir);
    expect(root.states().map((s) => s.meta.title)).toEqual(['first']);
    const index = join(root.opsDir, 'index.json');
    const before = readFileSync(index, 'utf8');

    refuse((to) => to === index);
    as('human:dawid').newTask({ title: 'second' });
    expect(new Root(rootDir).states().map((s) => s.meta.title)).toEqual(['first', 'second']);
    const spares = readdirSync(root.opsDir).filter((n) => /^index\..{26}\.json$/.test(n));
    expect(spares).toHaveLength(1);
    expect(readFileSync(index, 'utf8')).toBe(before);
    const kept = JSON.parse(readFileSync(join(root.opsDir, spares[0]!), 'utf8')) as {
      tasks: Record<string, unknown>;
    };
    expect(Object.keys(kept.tasks)).toEqual(['T-0001', 'T-0002']);
    // Later reads use the spare instead of adding one per read.
    expect(new Root(rootDir).states()).toHaveLength(2);
    expect(readdirSync(root.opsDir).filter((n) => /^index\..{26}\.json$/.test(n))).toHaveLength(1);
    expect(readdirSync(join(root.opsDir, 'tmp'))).toEqual([]);
  });

  it('keeps the list of copied-in files and the repeat cache', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    writeMirrored(root, new Set(['a']));
    writeRepeatCache(root, { daily: [] });
    refuse((to) => existsSync(to));
    writeMirrored(root, new Set(['a', 'b']));
    writeRepeatCache(root, { daily: [], weekly: [] });
    expect([...readMirrored(root)]).toEqual(['a', 'b']);
    expect(Object.keys(readRepeatCache(root))).toEqual(['daily', 'weekly']);
  });
});
