// One-time moves of the desktop app's own state after the rename to SwarmUp (AO-0200).
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The user data folder of Agent Ops builds, in `%APPDATA%`. */
export const OLD_USER_DATA = 'Agent Ops';
/** The user data folder of SwarmUp builds, in `%APPDATA%`. */
export const USER_DATA = 'SwarmUp';
/**
 * Written by Chromium on the first start of a profile, so its presence means the folder is in use.
 * It is copied last, so it also marks a finished copy.
 */
const PROFILE_MARKER = 'Local State';
/** Caches Chromium rebuilds by itself: not worth copying. */
const CACHES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GrShaderCache',
  'ShaderCache',
  'Crashpad',
]);

/**
 * Copies the Agent Ops user data folder (saved views and board ideas in Local Storage, window and
 * zoom state in Preferences, the relaunch marker of an update) into the SwarmUp one, once, and
 * returns the folder to use. On Windows the SwarmUp folder may already exist, because it is also
 * the user config folder (`%APPDATA%\swarmup`, case does not matter there); so the copy runs
 * while the folder holds no Chromium profile yet, and never replaces a file there. The old folder
 * stays as it was. When the copy fails, the old folder is returned and used as before.
 */
export function migrateUserData(appData: string, log: (line: string) => void = () => {}): string {
  const to = join(appData, USER_DATA);
  const from = join(appData, OLD_USER_DATA);
  if (existsSync(join(to, PROFILE_MARKER)) || !existsSync(join(from, PROFILE_MARKER))) return to;
  try {
    const names = readdirSync(from).filter((n) => !CACHES.has(n) && n !== PROFILE_MARKER);
    for (const n of [...names, PROFILE_MARKER]) {
      cpSync(join(from, n), join(to, n), { recursive: true, force: false, errorOnExist: false });
    }
    log(`desktop: copied the user data in ${from} to ${to}; the old folder stays`);
    return to;
  } catch (err) {
    log(`desktop: could not copy ${from} to ${to} (${(err as Error).message}); using ${from}`);
    return from;
  }
}
