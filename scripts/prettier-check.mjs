// Checks formatting of the files git tracks or would track, so folders a nested .gitignore keeps
// out of the repo (Prettier reads only the root one) are never checked.
//   node scripts/prettier-check.mjs [--write]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const write = process.argv.includes('--write');
const listed = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
);
const files = listed.split('\0').filter((f) => f && existsSync(f));
const prettier = createRequire(import.meta.url).resolve('prettier/bin/prettier.cjs');

// Windows caps a command line at about 32k characters, so the files go in batches.
let failed = false;
for (let i = 0; i < files.length; i += 200) {
  const batch = files.slice(i, i + 200);
  const r = spawnSync(
    process.execPath,
    [prettier, write ? '--write' : '--check', '--ignore-unknown', '--log-level', 'warn', ...batch],
    { stdio: 'inherit', windowsHide: true },
  );
  if (r.status !== 0) failed = true;
}
if (failed) process.exit(1);
console.log(`prettier-check: ${files.length} files ${write ? 'written' : 'checked'}`);
