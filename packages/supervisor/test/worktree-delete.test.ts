import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type DeleteHost, deleteWorktree, removeTree } from '../src/worktree.js';
import { electronHost } from './electron-asar.js';

/**
 * The Electron executable the desktop package installs, and its default app's asar, if any. In a
 * run swarmupd started, both are in the shared folder `ELECTRON_OVERRIDE_DIST_PATH` names
 * (AO-0306); the test still copies the asar into a worktree of its own.
 */
function electron(): { host: DeleteHost; asar: string } | null {
  try {
    return electronHost(createRequire(import.meta.url)('electron'));
  } catch {
    return null;
  }
}

const ELECTRON = electron();

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-wtdel-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

/** A repo with one commit and a linked worktree at `out/wt-T-0001`, as swarmupd makes them. */
function repoWithWorktree(): { top: string; path: string } {
  const top = temp();
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 'test@example.com');
  git(top, 'config', 'user.name', 'test');
  writeFileSync(join(top, '.gitignore'), 'node_modules/\n');
  git(top, 'add', '.');
  git(top, 'commit', '-q', '-m', 'init');
  const path = join(top, 'out', 'wt-T-0001');
  git(top, 'worktree', 'add', '-q', '-b', 'test/t-0001', path);
  return { top, path };
}

/** Puts Electron's `default_app.asar` where `npm ci` puts it in a checkout. */
function addElectronModule(dir: string, asar: string): string {
  const resources = join(dir, 'node_modules', 'electron', 'dist', 'resources');
  mkdirSync(resources, { recursive: true });
  const copy = join(resources, 'default_app.asar');
  copyFileSync(asar, copy);
  return copy;
}

describe('worktree deletion (AO-0244)', () => {
  it.skipIf(!ELECTRON)(
    'deletes a worktree that holds node_modules/electron when swarmupd runs under Electron',
    async () => {
      const { top, path } = repoWithWorktree();
      addElectronModule(path, ELECTRON!.asar);
      // With `.asar` support on, the deletion never ends; the limit fails the test, not vitest's.
      await deleteWorktree(top, path, { host: ELECTRON!.host, timeoutMs: 60_000 });
      expect(existsSync(path)).toBe(false);
      expect(git(top, 'worktree', 'list')).not.toContain('wt-T-0001');
    },
  );

  // A run swarmupd started has Electron in the shared folder, so a skip there is a lookup that
  // broke, as on macOS where the path is a launcher beside the app bundle (AO-0306).
  it.skipIf(!process.env.ELECTRON_OVERRIDE_DIST_PATH)(
    'finds Electron and its asar under ELECTRON_OVERRIDE_DIST_PATH, so the test above runs',
    () => {
      expect(ELECTRON).not.toBeNull();
    },
  );

  it('deletes a worktree with Node as the host', async () => {
    const { top, path } = repoWithWorktree();
    mkdirSync(join(path, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'pkg', 'index.js'), '\n');
    await deleteWorktree(top, path);
    expect(existsSync(path)).toBe(false);
    expect(git(top, 'worktree', 'list')).not.toContain('wt-T-0001');
  });

  it('touches nothing once swarmupd is stopping', async () => {
    const { top, path } = repoWithWorktree();
    const stop = new AbortController();
    stop.abort();
    await expect(deleteWorktree(top, path, { signal: stop.signal })).rejects.toThrow(
      /swarmupd is stopping/,
    );
    expect(existsSync(join(path, '.gitignore'))).toBe(true);
    expect(git(top, 'worktree', 'list')).toContain('wt-T-0001');
  });

  it('kills a deletion that takes longer than its time limit', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    // Node takes far longer than 1 ms to start, so the limit always ends it first.
    await expect(removeTree(dir, { timeoutMs: 1 })).rejects.toThrow(/took longer than/);
  });

  it('kills a deletion when swarmupd stops while it runs', async () => {
    const dir = temp();
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    const stop = new AbortController();
    const deletion = removeTree(dir, { signal: stop.signal });
    stop.abort();
    await expect(deletion).rejects.toThrow(/swarmupd is stopping/);
  });
});
