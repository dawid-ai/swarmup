import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * One unpacked Electron per version for every checkout swarmupd runs commands in (AO-0306).
 *
 * The `electron` package holds no binary: its `index.js` downloads and unpacks one (about 350 MB)
 * into `node_modules/electron/dist` on the first `require('electron')`, which a test or a smoke
 * script does. Each task worktree would hold its own copy. `index.js` uses the folder in
 * `ELECTRON_OVERRIDE_DIST_PATH` instead when that is set, and downloads nothing then, so swarmupd
 * keeps one copy per version in its state folder and names it in the environment of agent runs
 * and of merge and review checks.
 */
export const ELECTRON_DIST_ENV = 'ELECTRON_OVERRIDE_DIST_PATH';

/** A version as it may appear in a folder name: `45.2.1`, `46.0.0-beta.2`. */
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function valid(version: unknown): string | null {
  return typeof version === 'string' && VERSION.test(version) ? version : null;
}

/** The `electron` version an npm lockfile installs: the top-level one, else the first nested. */
function fromNpmLock(text: string): string | null {
  let lock: { packages?: Record<string, { version?: unknown }> };
  try {
    lock = JSON.parse(text) as typeof lock;
  } catch {
    return null;
  }
  const packages = lock.packages;
  if (!packages || typeof packages !== 'object') return null;
  const top = valid(packages['node_modules/electron']?.version);
  if (top) return top;
  for (const [key, entry] of Object.entries(packages)) {
    if (key.endsWith('/node_modules/electron')) {
      const nested = valid(entry?.version);
      if (nested) return nested;
    }
  }
  return null;
}

/** The `electron` version a pnpm lockfile installs: `electron@1.2.3:`, `/electron@1.2.3:` or `/electron/1.2.3:`. */
function fromPnpmLock(text: string): string | null {
  const m = /^ {2}['"]?\/?electron[@/]([^:'"(\s]+)/m.exec(text);
  return valid(m?.[1]);
}

/** The `electron` version a yarn lockfile installs, classic or berry. */
function fromYarnLock(text: string): string | null {
  const m = /^"?electron@[^\n]*:\r?\n\s+version:? "?([^"\s]+)"?/m.exec(text);
  return valid(m?.[1]);
}

/**
 * The version of the `electron` package the checkout `dir` installs, or null when it installs
 * none. The lockfile comes first: it is right before the install too, in a new worktree or after
 * a checkout that changed it, when `node_modules` is missing or still holds the earlier version.
 */
export function electronVersionOf(dir: string): string | null {
  const locks: [string, (text: string) => string | null][] = [
    ['pnpm-lock.yaml', fromPnpmLock],
    ['package-lock.json', fromNpmLock],
    ['npm-shrinkwrap.json', fromNpmLock],
    ['yarn.lock', fromYarnLock],
  ];
  for (const [name, parse] of locks) {
    const text = read(join(dir, name));
    if (text === null) continue;
    const version = parse(text);
    if (version) return version;
  }
  const pkg = read(join(dir, 'node_modules', 'electron', 'package.json'));
  if (pkg === null) return null;
  try {
    return valid((JSON.parse(pkg) as { version?: unknown }).version);
  } catch {
    return null;
  }
}

/** The executable inside a dist folder, as the `electron` package writes it to its `path.txt`. */
function platformPath(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return 'Electron.app/Contents/MacOS/Electron';
  return 'electron';
}

/** Whether `dist` names `version` and holds the executable. True for half an unpack too. */
function looksUnpacked(dist: string, version: string, platform: NodeJS.Platform): boolean {
  const has = read(join(dist, 'version'));
  if (has === null || has.trim().replace(/^v/, '') !== version) return false;
  return existsSync(join(dist, platformPath(platform)));
}

/**
 * The file swarmupd writes into a shared folder as the last step of a copy or a move. The
 * archive holds `version` and the executable before other files it needs, so those two prove no
 * complete unpack.
 */
export const ELECTRON_DIST_COMPLETE = '.swarmup-complete';

/** Whether the shared folder `dist` holds a complete Electron `version`: swarmupd marked it. */
export function electronDistReady(
  dist: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return looksUnpacked(dist, version, platform) && existsSync(join(dist, ELECTRON_DIST_COMPLETE));
}

/**
 * The name `electron/index.js` joins to the override folder when the package has no `path.txt`,
 * which is the case in a worktree that never downloaded Electron itself.
 */
const FALLBACK_NAME = 'electron';

/** The launcher swarmupd puts at the fallback name where the platform's executable is elsewhere. */
const FALLBACK_LAUNCHER = `#!/bin/sh
# Written by swarmupd (AO-0306): electron/index.js looks for this name when it has no path.txt.
exec "$(dirname "$0")/${platformPath('darwin')}" "$@"
`;

/**
 * Makes `<dist>/electron` start Electron on macOS, where the executable is
 * `Electron.app/Contents/MacOS/Electron`. A script that replaces itself with the executable,
 * not a symlink: the app finds its bundle from the path it was started under. Linux has the
 * executable under that name already, and Windows finds `electron.exe` for a name without an
 * extension. Throws when it cannot write the file.
 */
function addFallback(dist: string, platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return;
  const file = join(dist, FALLBACK_NAME);
  if (read(file) === FALLBACK_LAUNCHER) return;
  writeFileSync(file, FALLBACK_LAUNCHER, { mode: 0o755 });
  chmodSync(file, 0o755);
}

/** `shared` when `electron/index.js` finds an executable in it with and without `path.txt`. */
function usable(shared: string, platform: NodeJS.Platform): string | null {
  try {
    addFallback(shared, platform);
    return shared;
  } catch {
    return null;
  }
}

/**
 * Whether the `electron` package in the checkout `dir` finished unpacking `version`: its
 * install script writes `path.txt` next to `dist` after the last file of the archive, and
 * removes nothing when it fails, so a download that stopped halfway leaves `dist` without it.
 */
export function checkoutElectronReady(
  dir: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!looksUnpacked(checkoutElectronDist(dir), version, platform)) return false;
  return read(join(dir, 'node_modules', 'electron', 'path.txt')) === platformPath(platform);
}

/** `<state>/electron/<version>-<platform>-<arch>`: the one copy of that version on this machine. */
export function sharedElectronDist(
  stateDir: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return join(stateDir, 'electron', `${version}-${platform}-${arch}`);
}

/** The `dist` folder the `electron` package unpacks into in the checkout `dir`. */
export function checkoutElectronDist(dir: string): string {
  return join(dir, 'node_modules', 'electron', 'dist');
}

export interface ElectronDistOptions {
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * The shared Electron folder for the checkout `dir`, or null when the checkout installs no
 * Electron or no copy of its version is at hand. Makes the shared copy when it is missing, from
 * the first of `dir` and `sources` (other checkouts of the repo) that holds that version
 * unpacked to the end. A copy, never a link: an install that unpacks a new version over a checkout's `dist`
 * writes through a hard link.
 *
 * Synchronous, and the copy is some 350 MB: it happens once per version and machine.
 */
export function electronDistFor(
  stateDir: string,
  dir: string,
  sources: readonly string[] = [],
  opts: ElectronDistOptions = {},
): string | null {
  const version = electronVersionOf(dir);
  if (!version) return null;
  const platform = opts.platform ?? process.platform;
  const shared = sharedElectronDist(stateDir, version, platform, opts.arch);
  if (electronDistReady(shared, version, platform)) return usable(shared, platform);
  for (const from of [dir, ...sources]) {
    if (!checkoutElectronReady(from, version, platform)) continue;
    const dist = checkoutElectronDist(from);
    // Complete under another name first, so a reader never finds half a copy.
    const part = `${shared}.part-${randomBytes(4).toString('hex')}`;
    try {
      mkdirSync(dirname(shared), { recursive: true });
      cpSync(dist, part, { recursive: true });
      addFallback(part, platform);
      writeFileSync(join(part, ELECTRON_DIST_COMPLETE), `${version}\n`);
      place(part, shared, version, platform);
    } catch {
      // Unreadable source, full disk: the next source, or the package's own download.
    } finally {
      rmSync(part, { recursive: true, force: true });
    }
    if (electronDistReady(shared, version, platform)) return usable(shared, platform);
  }
  return null;
}

/** Renames the complete folder `from` to `shared`, over an incomplete one; a complete one stays. */
function place(from: string, shared: string, version: string, platform: NodeJS.Platform): void {
  if (electronDistReady(shared, version, platform)) return;
  rmSync(shared, { recursive: true, force: true });
  renameSync(from, shared);
}

/**
 * Moves the Electron that a command unpacked into the checkout `dir` to the shared folder, when
 * the shared folder has no copy of that version yet: the first run on a machine downloads it
 * where the package wants it, and later runs use it from the shared place. One rename, so it
 * takes no time and fails as a whole while a process still runs from the folder or when the
 * state folder is on another volume; the checkout keeps its copy then. Only for a worktree
 * swarmupd runs commands in, never a person's checkout. Returns the shared folder when it moved.
 */
export function shareElectronDist(
  stateDir: string,
  dir: string,
  opts: ElectronDistOptions = {},
): string | null {
  const platform = opts.platform ?? process.platform;
  const dist = checkoutElectronDist(dir);
  const has = read(join(dist, 'version'));
  const version = valid(has?.trim().replace(/^v/, ''));
  if (!version || !checkoutElectronReady(dir, version, platform)) return null;
  const shared = sharedElectronDist(stateDir, version, platform, opts.arch);
  if (electronDistReady(shared, version, platform)) return null;
  // Marked before the rename: another swarmupd removes a shared folder that has no mark.
  const mark = join(dist, ELECTRON_DIST_COMPLETE);
  try {
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(mark, `${version}\n`);
    place(dist, shared, version, platform);
  } catch {
    // The checkout keeps its copy, as the package left it.
  }
  rmSync(mark, { force: true });
  return electronDistReady(shared, version, platform) ? usable(shared, platform) : null;
}

/**
 * `env` with `ELECTRON_OVERRIDE_DIST_PATH` naming the shared Electron of the checkout `dir`, when
 * there is one. A value already set stays: a person's own override, or the one of the run that
 * started this swarmupd.
 */
export function withElectronDist(
  env: NodeJS.ProcessEnv,
  stateDir: string,
  dir: string,
  sources: readonly string[] = [],
  opts: ElectronDistOptions = {},
): NodeJS.ProcessEnv {
  // Windows names ignore case, and a copied env is a plain object: match the name ourselves.
  const names = Object.keys(env).filter((k) => k.toUpperCase() === ELECTRON_DIST_ENV);
  if (names.some((k) => env[k])) return env;
  const dist = electronDistFor(stateDir, dir, sources, opts);
  if (!dist) return env;
  const out = { ...env };
  for (const k of names) delete out[k];
  out[ELECTRON_DIST_ENV] = dist;
  return out;
}
