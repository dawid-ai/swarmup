// Sets the release version everywhere it is written down: the root and workspace package.json
// files, the CLI's VERSION and swarmupd's OPSD_VERSION. `pnpm-lock.yaml` holds no version of the
// workspace packages: they depend on each other as `workspace:*`, which stays as it is.
//
// Usage: node scripts/set-version.mjs 0.2.0-beta.1

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: node scripts/set-version.mjs <semver>, such as 0.2.0-beta.1');
  process.exit(2);
}

const packages = ['core', 'cli', 'supervisor', 'desktop'];
const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

const root = json(join(top, 'package.json'));
root.version = version;
save(join(top, 'package.json'), root);

for (const p of packages) {
  const file = join(top, 'packages', p, 'package.json');
  const data = json(file);
  data.version = version;
  save(file, data);
}

const replaceIn = (file, re) => {
  const path = join(top, file);
  const text = readFileSync(path, 'utf8');
  if (!re.test(text)) throw new Error(`${file}: version line not found`);
  writeFileSync(
    path,
    text.replace(re, (_m, head) => `${head}'${version}';`),
  );
};
replaceIn('packages/cli/src/version.ts', /(export const VERSION = )'[^']*';/);
replaceIn('packages/supervisor/src/daemon.ts', /(export const OPSD_VERSION = )'[^']*';/);

console.log(`version ${version}`);
