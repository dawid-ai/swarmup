import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopSmokeElectronArgs } from '../../../scripts/desktop-smoke-args.mjs';

describe('desktop smoke Electron arguments', () => {
  it('isolates both dev and packaged runs in the smoke scratch profile', () => {
    const base = join('scratch', 'smoke');
    const top = join('repo', 'swarmup');
    const userData = `--user-data-dir=${join(base, 'userdata')}`;

    expect(desktopSmokeElectronArgs(false, base, top, 'win32')).toEqual([
      userData,
      join(top, 'packages', 'desktop'),
    ]);
    expect(desktopSmokeElectronArgs(true, base, top, 'win32')).toEqual([userData]);
  });

  it('disables the Electron sandbox on Linux after selecting the scratch profile', () => {
    const args = desktopSmokeElectronArgs(false, '/tmp/smoke', '/repo/swarmup', 'linux');

    expect(args).toEqual([
      `--user-data-dir=${join('/tmp/smoke', 'userdata')}`,
      join('/repo/swarmup', 'packages', 'desktop'),
      '--no-sandbox',
    ]);
  });
});
