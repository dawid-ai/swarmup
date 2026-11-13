import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutElectronDist,
  ELECTRON_DIST_ENV,
  electronDistFor,
  electronDistReady,
  electronVersionOf,
  shareElectronDist,
  sharedElectronDist,
  withElectronDist,
} from '../src/index.js';

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-electron-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
});

/** A checkout whose npm lockfile installs `electron` `version`. */
function checkout(version = '45.2.1'): string {
  const dir = temp();
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ packages: { 'node_modules/electron': { version } } }),
  );
  return dir;
}

/** What the `electron` package unpacks into `dir/node_modules/electron/dist`, in small. */
function unpack(dir: string, version = '45.2.1', platform: NodeJS.Platform = 'win32'): string {
  const dist = checkoutElectronDist(dir);
  const exe =
    platform === 'win32'
      ? join(dist, 'electron.exe')
      : platform === 'darwin'
        ? join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : join(dist, 'electron');
  mkdirSync(dirname(exe), { recursive: true });
  mkdirSync(join(dist, 'resources'), { recursive: true });
  writeFileSync(exe, 'binary');
  writeFileSync(join(dist, 'resources', 'default_app.asar'), 'asar');
  writeFileSync(join(dist, 'version'), version);
  return dist;
}

const WIN = { platform: 'win32' as const, arch: 'x64' };

describe('the Electron version a checkout installs (AO-0306)', () => {
  it('reads an npm lockfile, the top-level package before a nested one', () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        packages: {
          'packages/old/node_modules/electron': { version: '30.0.0' },
          'node_modules/electron': { version: '45.2.1' },
          'node_modules/electron-updater': { version: '6.8.11' },
        },
      }),
    );
    expect(electronVersionOf(dir)).toBe('45.2.1');
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        packages: { 'packages/desktop/node_modules/electron': { version: '44.0.1' } },
      }),
    );
    expect(electronVersionOf(dir)).toBe('44.0.1');
  });

  it('reads a pnpm lockfile in each of its key forms', () => {
    const dir = temp();
    const lock = (key: string): void =>
      writeFileSync(
        join(dir, 'pnpm-lock.yaml'),
        `lockfileVersion: '9.0'\n\npackages:\n\n  electron-updater@6.8.11:\n    resolution: {}\n\n  ${key}:\n    resolution: {}\n`,
      );
    lock('electron@45.2.1');
    expect(electronVersionOf(dir)).toBe('45.2.1');
    lock('/electron@46.0.0-beta.2');
    expect(electronVersionOf(dir)).toBe('46.0.0-beta.2');
    lock("'/electron/31.1.0'");
    expect(electronVersionOf(dir)).toBe('31.1.0');
  });

  it('reads a yarn lockfile, classic and berry', () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'yarn.lock'),
      'electron@^45.2.1:\n  version "45.2.1"\n  resolved "x"\n',
    );
    expect(electronVersionOf(dir)).toBe('45.2.1');
    writeFileSync(join(dir, 'yarn.lock'), '"electron@npm:^45.0.0":\n  version: 45.3.0\n');
    expect(electronVersionOf(dir)).toBe('45.3.0');
  });

  it('takes the lockfile over what node_modules still holds, and the package without a lockfile', () => {
    const dir = checkout('45.2.1');
    mkdirSync(join(dir, 'node_modules', 'electron'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules', 'electron', 'package.json'),
      JSON.stringify({ version: '44.0.0' }),
    );
    expect(electronVersionOf(dir)).toBe('45.2.1');
    rmSync(join(dir, 'package-lock.json'));
    expect(electronVersionOf(dir)).toBe('44.0.0');
  });

  it('names no version for a checkout without Electron, or one that is no version', () => {
    const dir = temp();
    expect(electronVersionOf(dir)).toBeNull();
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {} }));
    expect(electronVersionOf(dir)).toBeNull();
    writeFileSync(join(dir, 'package-lock.json'), 'not json');
    expect(electronVersionOf(dir)).toBeNull();
    // A version becomes a folder name: nothing that leaves the folder.
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/electron': { version: '../../x' } } }),
    );
    expect(electronVersionOf(dir)).toBeNull();
  });
});

describe('the shared Electron (AO-0306)', () => {
  it('copies the version from another checkout once and leaves that checkout as it was', () => {
    const state = temp();
    const main = checkout();
    const mainDist = unpack(main);
    const worktree = checkout();
    const shared = sharedElectronDist(state, '45.2.1', 'win32', 'x64');
    expect(electronDistFor(state, worktree, [main], WIN)).toBe(shared);
    expect(shared).toBe(join(state, 'electron', '45.2.1-win32-x64'));
    expect(electronDistReady(shared, '45.2.1', 'win32')).toBe(true);
    expect(readFileSync(join(shared, 'resources', 'default_app.asar'), 'utf8')).toBe('asar');
    expect(electronDistReady(mainDist, '45.2.1', 'win32')).toBe(true);
    // The worktree holds no Electron, and no part of a copy is left next to the shared one.
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false);
    expect(readdirNames(join(state, 'electron'))).toEqual(['45.2.1-win32-x64']);
    // The next checkout needs no source.
    expect(electronDistFor(state, checkout(), [], WIN)).toBe(shared);
  });

  it('has none when no checkout holds the version unpacked', () => {
    const state = temp();
    const main = checkout('44.0.0');
    unpack(main, '44.0.0');
    const worktree = checkout('45.2.1');
    expect(electronDistFor(state, worktree, [main], WIN)).toBeNull();
    expect(existsSync(join(state, 'electron'))).toBe(false);
    // Another platform's executable is no copy for this one.
    const mac = checkout();
    unpack(mac, '45.2.1', 'darwin');
    expect(electronDistFor(state, worktree, [mac], WIN)).toBeNull();
    expect(electronDistFor(state, temp(), [main], WIN)).toBeNull();
  });

  it('replaces a shared copy that is not complete', () => {
    const state = temp();
    const main = checkout();
    unpack(main);
    const shared = sharedElectronDist(state, '45.2.1', 'win32', 'x64');
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'electron.exe'), 'half');
    expect(electronDistFor(state, main, [], WIN)).toBe(shared);
    expect(readFileSync(join(shared, 'electron.exe'), 'utf8')).toBe('binary');
  });

  it('moves the Electron a command unpacked in a worktree, unless the shared copy is there', () => {
    const state = temp();
    const worktree = checkout();
    const dist = unpack(worktree);
    const shared = sharedElectronDist(state, '45.2.1', 'win32', 'x64');
    expect(shareElectronDist(state, worktree, WIN)).toBe(shared);
    expect(existsSync(dist)).toBe(false);
    expect(electronDistReady(shared, '45.2.1', 'win32')).toBe(true);
    // A second worktree that unpacked one keeps it: nothing of a checkout is deleted.
    const other = checkout();
    const otherDist = unpack(other);
    expect(shareElectronDist(state, other, WIN)).toBeNull();
    expect(electronDistReady(otherDist, '45.2.1', 'win32')).toBe(true);
    expect(shareElectronDist(state, temp(), WIN)).toBeNull();
  });

  it('names the shared folder in the environment and keeps a value already set', () => {
    const state = temp();
    const main = checkout();
    unpack(main);
    const shared = sharedElectronDist(state, '45.2.1', 'win32', 'x64');
    const env = { KEEP: 'yes' };
    expect(withElectronDist(env, state, checkout(), [main], WIN)).toEqual({
      KEEP: 'yes',
      [ELECTRON_DIST_ENV]: shared,
    });
    expect(env).toEqual({ KEEP: 'yes' });
    // An empty value counts as unset.
    expect(withElectronDist({ [ELECTRON_DIST_ENV]: '' }, state, main, [], WIN)).toEqual({
      [ELECTRON_DIST_ENV]: shared,
    });
    const own = { electron_override_dist_path: 'D:/mine' };
    expect(withElectronDist(own, state, main, [], WIN)).toBe(own);
    // A checkout without Electron gets the environment as it was.
    const plain = { KEEP: 'yes' };
    expect(withElectronDist(plain, state, temp(), [main], WIN)).toBe(plain);
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}
