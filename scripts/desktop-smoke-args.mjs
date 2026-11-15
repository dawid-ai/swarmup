import { join } from 'node:path';

export function desktopSmokeElectronArgs(packaged, base, top, platform = process.platform) {
  const args = [`--user-data-dir=${join(base, 'userdata')}`];
  if (!packaged) args.push(join(top, 'packages', 'desktop'));
  if (platform === 'linux') args.push('--no-sandbox');
  return args;
}
