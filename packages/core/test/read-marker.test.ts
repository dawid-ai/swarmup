// The inbox read marker moves forward even when its file cannot be replaced (AO-0280). On Windows
// a marker made by one sandboxed session (the Codex sandbox user) can be read by a later session,
// but not deleted or overwritten, so the rename over it fails with EPERM however long it waits.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Root } from '../src/index.js';
import { setup } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Makes every rename onto `target` fail the way Windows refuses to replace a file. */
function refuseReplacing(target: string): void {
  const rename = Root.prototype.renameRetry;
  vi.spyOn(Root.prototype, 'renameRetry').mockImplementation(function (
    this: Root,
    from: string,
    to: string,
    retries?: number,
  ) {
    if (to === target) {
      throw Object.assign(
        new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`),
        {
          code: 'EPERM',
        },
      );
    }
    rename.call(this, from, to, retries);
  });
}

describe('inbox read marker that cannot be replaced (AO-0280)', () => {
  it('moves forward in a spare file, and back into the marker when that works again', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'first', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    const reader = as('human:dawid');
    const unread = (markRead = false): number =>
      reader.inbox('human:dawid', { markRead }).filter((i) => i.kind === 'message').length;
    const root = new Root(rootDir);
    const readDir = join(root.opsDir, 'read');
    const marker = join(readDir, 'human-dawid.json');
    const last = (file: string): string =>
      (JSON.parse(readFileSync(file, 'utf8')) as { last: string }).last;
    const spares = (): string[] => readdirSync(readDir).filter((n) => n !== 'human-dawid.json');

    eng.comment('1', 'one', 'human:dawid');
    expect(unread(true)).toBe(1);
    expect(unread()).toBe(0);
    const first = last(marker);

    refuseReplacing(marker);
    eng.comment('1', 'two', 'human:dawid');
    expect(unread(true)).toBe(1);
    expect(unread()).toBe(0);
    // The marker itself is untouched; one spare file holds the newer position.
    expect(last(marker)).toBe(first);
    expect(spares()).toHaveLength(1);
    const spare = join(readDir, spares()[0]!);
    expect(spares()[0]).toMatch(/^human-dawid\.[0-9A-Z]{26}\.json$/);
    expect(last(spare) > first).toBe(true);
    expect(root.readMarker('human:dawid')).toBe(last(spare));
    // The failed rename leaves no temp file behind.
    expect(readdirSync(join(root.opsDir, 'tmp'))).toEqual([]);

    // The next read reuses the spare instead of adding one per read.
    const second = last(spare);
    eng.comment('1', 'three', 'human:dawid');
    expect(unread(true)).toBe(1);
    expect(unread()).toBe(0);
    expect(spares()).toEqual([spare.slice(readDir.length + 1)]);
    expect(last(spare) > second).toBe(true);

    // The marker can be replaced again: it takes the position, and the spare goes.
    vi.restoreAllMocks();
    eng.comment('1', 'four', 'human:dawid');
    expect(unread(true)).toBe(1);
    expect(unread()).toBe(0);
    expect(spares()).toEqual([]);
    expect(existsSync(spare)).toBe(false);
    expect(root.readMarker('human:dawid')).toBe(last(marker));
  });

  it('adds another spare when the spare cannot be replaced either', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'first', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    const reader = as('human:dawid');
    const unread = (markRead = false): number =>
      reader.inbox('human:dawid', { markRead }).filter((i) => i.kind === 'message').length;
    const root = new Root(rootDir);
    const readDir = join(root.opsDir, 'read');

    eng.comment('1', 'one', 'human:dawid');
    expect(unread(true)).toBe(1);
    const rename = Root.prototype.renameRetry;
    // Nothing that exists in the folder can be replaced; new files can be added.
    vi.spyOn(Root.prototype, 'renameRetry').mockImplementation(function (
      this: Root,
      from: string,
      to: string,
      retries?: number,
    ) {
      if (to.startsWith(readDir) && existsSync(to)) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      rename.call(this, from, to, retries);
    });
    eng.comment('1', 'two', 'human:dawid');
    expect(unread(true)).toBe(1);
    const firstSpare = readdirSync(readDir).filter((n) => n !== 'human-dawid.json');
    eng.comment('1', 'three', 'human:dawid');
    expect(unread(true)).toBe(1);
    expect(unread()).toBe(0);
    // A second spare took the position. The first one could still be deleted, so it is gone.
    const secondSpare = readdirSync(readDir).filter((n) => n !== 'human-dawid.json');
    expect(secondSpare).toHaveLength(1);
    expect(secondSpare).not.toEqual(firstSpare);
  });

  it('still reports an error that is not a refused replacement', () => {
    const { as, rootDir } = setup();
    as('human:dawid').newTask({ title: 'first', owner: 'claude:engineer' });
    as('claude:engineer').comment('1', 'one', 'human:dawid');
    vi.spyOn(Root.prototype, 'renameRetry').mockImplementation(() => {
      throw Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
    });
    expect(() => as('human:dawid').inbox('human:dawid', { markRead: true })).toThrow(/ENOSPC/);
    expect(readdirSync(join(new Root(rootDir).opsDir, 'read'))).toEqual([]);
  });

  it('keeps another actor whose id starts the same apart', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    root.writeMarker('claude:engineer', '01M79W2NJFR9N8DHGQFD99XMAE');
    root.writeMarker('claude:engineer.b', '01M79W2NJFR9N8DHGQFD99XMAF');
    expect(root.readMarker('claude:engineer')).toBe('01M79W2NJFR9N8DHGQFD99XMAE');
    expect(root.readMarker('claude:engineer.b')).toBe('01M79W2NJFR9N8DHGQFD99XMAF');
  });
});
