import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkoutElectronDist,
  checkoutElectronReady,
  ELECTRON_DIST_COMPLETE,
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
  // The install script writes this last, after the whole archive.
  writeFileSync(
    join(dirname(dist), 'path.txt'),
    platform === 'win32'
      ? 'electron.exe'
      : platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron',
  );
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
    expect(checkoutElectronReady(main, '45.2.1', 'win32')).toBe(true);
    expect(readdirNames(mainDist)).toEqual(['electron.exe', 'resources', 'version']);
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
    expect(checkoutElectronReady(other, '45.2.1', 'win32')).toBe(true);
    expect(readdirNames(otherDist)).toEqual(['electron.exe', 'resources', 'version']);
    expect(shareElectronDist(state, temp(), WIN)).toBeNull();
  });

  it('takes no Electron from a checkout whose download stopped halfway', () => {
    const state = temp();
    const shared = sharedElectronDist(state, '45.2.1', 'win32', 'x64');
    // The archive holds `version` and the executable before later files: both are there.
    const main = checkout();
    const mainDist = unpack(main);
    rmSync(join(main, 'node_modules', 'electron', 'path.txt'));
    expect(checkoutElectronReady(main, '45.2.1', 'win32')).toBe(false);
    expect(electronDistFor(state, checkout(), [main], WIN)).toBeNull();
    expect(shareElectronDist(state, main, WIN)).toBeNull();
    expect(existsSync(join(state, 'electron'))).toBe(false);
    expect(readdirNames(mainDist)).toEqual(['electron.exe', 'resources', 'version']);
    // A `path.txt` for another platform's executable is no proof either.
    writeFileSync(join(main, 'node_modules', 'electron', 'path.txt'), 'electron');
    expect(electronDistFor(state, main, [], WIN)).toBeNull();
    // After the install finishes, the same checkout is a source.
    writeFileSync(join(main, 'node_modules', 'electron', 'path.txt'), 'electron.exe');
    expect(electronDistFor(state, checkout(), [main], WIN)).toBe(shared);
  });

  it('trusts a shared folder only with its completion mark', () => {
    const state = temp();
    const shared = sharedElectronDist(state, '45.2.1', 'win32', 'x64');
    // Version file and executable, as half an unpack or a copy from before the mark leaves them.
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, 'electron.exe'), 'half');
    writeFileSync(join(shared, 'version'), '45.2.1');
    expect(electronDistReady(shared, '45.2.1', 'win32')).toBe(false);
    expect(electronDistFor(state, checkout(), [], WIN)).toBeNull();
    const env = { KEEP: 'yes' };
    expect(withElectronDist(env, state, checkout(), [], WIN)).toBe(env);
    // A complete source replaces it, and the copy carries the mark.
    const main = checkout();
    unpack(main);
    expect(electronDistFor(state, checkout(), [main], WIN)).toBe(shared);
    expect(readFileSync(join(shared, 'electron.exe'), 'utf8')).toBe('binary');
    expect(existsSync(join(shared, ELECTRON_DIST_COMPLETE))).toBe(true);
    expect(electronDistReady(shared, '45.2.1', 'win32')).toBe(true);
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

describe('the shared Electron for a worktree without path.txt (AO-0306)', () => {
  const MAC = { platform: 'darwin' as const, arch: 'arm64' };
  const require = createRequire(import.meta.url);
  const entry = join(dirname(require.resolve('electron/package.json')), 'index.js');

  /** What `require('electron')` returns in the checkout `dir`, from the package's own entry point. */
  function requireElectron(dir: string, env: NodeJS.ProcessEnv): string {
    const pkg = join(dir, 'node_modules', 'electron');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'index.js'), readFileSync(entry));
    return execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(require(process.argv[1]))', join(pkg, 'index.js')],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    );
  }

  it('gives a new macOS worktree a path that starts the executable in the app bundle', () => {
    const state = temp();
    const main = checkout();
    unpack(main, '45.2.1', 'darwin');
    // A new worktree: the lockfile, and a package that never ran its download, so no path.txt.
    const worktree = checkout();
    const env = withElectronDist({}, state, worktree, [main], MAC);
    const shared = sharedElectronDist(state, '45.2.1', 'darwin', 'arm64');
    expect(env[ELECTRON_DIST_ENV]).toBe(shared);

    const resolved = requireElectron(worktree, env);
    expect(existsSync(join(worktree, 'node_modules', 'electron', 'path.txt'))).toBe(false);
    expect(resolved).toBe(join(shared, 'electron'));
    const launcher = readFileSync(resolved, 'utf8');
    expect(launcher.startsWith('#!/bin/sh\n')).toBe(true);
    expect(launcher).toContain('exec "$(dirname "$0")/Electron.app/Contents/MacOS/Electron" "$@"');
    // The checkout it came from holds no launcher: the copy got it, not the source.
    expect(existsSync(join(checkoutElectronDist(main), 'electron'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('starts the executable with its arguments', () => {
    const state = temp();
    const main = checkout();
    const dist = unpack(main, '45.2.1', 'darwin');
    const exe = join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
    writeFileSync(exe, '#!/bin/sh\necho "started $0 $*"\n');
    chmodSync(exe, 0o755);
    const worktree = checkout();
    const env = withElectronDist({}, state, worktree, [main], MAC);
    const shared = sharedElectronDist(state, '45.2.1', 'darwin', 'arm64');
    const out = execFileSync(requireElectron(worktree, env), ['--version', 'a b'], {
      encoding: 'utf8',
    });
    expect(out.trim()).toBe(
      `started ${join(shared, 'Electron.app', 'Contents', 'MacOS', 'Electron')} --version a b`,
    );
  });

  it('adds the launcher to a shared folder made without one, and to one a worktree moved', () => {
    const state = temp();
    const main = checkout();
    unpack(main, '45.2.1', 'darwin');
    const shared = electronDistFor(state, main, [], MAC);
    expect(shared).not.toBeNull();
    rmSync(join(shared!, 'electron'));
    expect(electronDistFor(state, checkout(), [], MAC)).toBe(shared);
    expect(existsSync(join(shared!, 'electron'))).toBe(true);

    const other = temp();
    const worktree = checkout();
    unpack(worktree, '45.2.1', 'darwin');
    const moved = shareElectronDist(other, worktree, MAC);
    expect(moved).toBe(sharedElectronDist(other, '45.2.1', 'darwin', 'arm64'));
    expect(existsSync(join(moved!, 'electron'))).toBe(true);
  });

  it('leaves a Windows folder as the archive made it', () => {
    const state = temp();
    const main = checkout();
    unpack(main);
    const shared = electronDistFor(state, main, [], WIN);
    expect(existsSync(join(shared!, 'electron'))).toBe(false);
    // With no path.txt the package asks for `electron`; Windows adds `.exe` when it starts it.
    const resolved = requireElectron(checkout(), { [ELECTRON_DIST_ENV]: shared! });
    expect(resolved).toBe(join(shared!, 'electron'));
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}
