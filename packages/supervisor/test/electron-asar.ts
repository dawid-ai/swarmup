import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DeleteHost } from '../src/worktree.js';

/**
 * Electron's `default_app.asar` for the path `require('electron')` returns, or null. That path
 * is the executable of a checkout's own unpack, or the fallback name in the shared folder
 * `ELECTRON_OVERRIDE_DIST_PATH` names (AO-0306). On macOS the fallback is a launcher beside
 * `Electron.app`, not the executable inside it, so the bundle's resources are looked up from
 * both places.
 */
export function defaultAppAsar(exe: string): string | null {
  const dir = dirname(exe);
  return (
    [
      // Windows and Linux: the executable is in the dist folder.
      join(dir, 'resources', 'default_app.asar'),
      // macOS, `Electron.app/Contents/MacOS/Electron`.
      join(dir, '..', 'Resources', 'default_app.asar'),
      // macOS, the launcher `<dist>/electron` swarmupd writes.
      join(dir, 'Electron.app', 'Contents', 'Resources', 'default_app.asar'),
    ].find((p) => existsSync(p)) ?? null
  );
}

/** The host and the asar the AO-0244 deletion test needs, or null when `exe` has no asar. */
export function electronHost(exe: unknown): { host: DeleteHost; asar: string } | null {
  if (typeof exe !== 'string') return null;
  const asar = defaultAppAsar(exe);
  return asar ? { host: { execPath: exe, electron: true }, asar } : null;
}
