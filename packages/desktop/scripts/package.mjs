// Stages the desktop app for electron-builder: one bundled file each for the Electron main
// process, swarmupd and the `swarmup` CLI, plus the preload script, the UI and the command shims.
// The staged folder has no node_modules: everything the app runs is in the bundles.
//
// Usage: node packages/desktop/scripts/package.mjs   (after `pnpm run build:desktop`)

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const desktop = join(dirname(fileURLToPath(import.meta.url)), '..');
const top = join(desktop, '..', '..');
const stage = join(desktop, 'release', 'app');
const version = JSON.parse(readFileSync(join(top, 'package.json'), 'utf8')).version;

rmSync(join(desktop, 'release'), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// ESM bundles still need `require` for the CommonJS packages they include (yaml, the updater),
// and every bundle names swarmupd.mjs, which sits beside it, as the program `startDaemon` runs.
const banner = [
  "import { createRequire as __swarmupRequire } from 'node:module';",
  "import { fileURLToPath as __swarmupPath } from 'node:url';",
  'const require = __swarmupRequire(import.meta.url);',
  "process.env.SWARMUP_DAEMON_ENTRY ??= __swarmupPath(new URL('./swarmupd.mjs', import.meta.url));",
].join('\n');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: banner },
  logLevel: 'warning',
};

await build({
  ...common,
  entryPoints: [join(desktop, 'dist', 'main.js')],
  outfile: join(stage, 'main.mjs'),
  external: ['electron'],
});
await build({
  ...common,
  entryPoints: [join(top, 'packages', 'supervisor', 'dist', 'main.js')],
  outfile: join(stage, 'swarmupd.mjs'),
});
await build({
  ...common,
  entryPoints: [join(top, 'packages', 'cli', 'dist', 'main.js')],
  outfile: join(stage, 'swarmup.mjs'),
});

cpSync(join(desktop, 'dist', 'preload.cjs'), join(stage, 'preload.cjs'));
cpSync(join(desktop, 'dist', 'ui'), join(stage, 'ui'), { recursive: true });
// The swarmup skill beside the bundles: `swarmup doctor` compares user-level copies with it.
cpSync(join(top, 'skills', 'swarmup'), join(stage, 'skills', 'swarmup'), { recursive: true });

writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      // Names electron-updater's download cache (`%LOCALAPPDATA%\\swarmup-updater`). The install
      // folder comes from productName, and an update keeps the folder it finds (AO-0200).
      name: 'swarmup',
      productName: 'SwarmUp',
      version,
      description:
        'A team of AI agents and one human working one queue, with tasks as files in git',
      author: 'swarmup contributors',
      license: 'MIT',
      type: 'module',
      main: 'main.mjs',
    },
    null,
    2,
  )}\n`,
);

// The bundles drop the licence comments of what they include, so the notices ship in one file:
// every production dependency of the packages, plus the libraries the UI bundles.
const UI_LIBS = [
  'react',
  'react-dom',
  'scheduler',
  'marked',
  'dompurify',
  'lucide-react',
  'mp4-muxer',
  '@fontsource-variable/jetbrains-mono',
  '@fontsource/chakra-petch',
  '@fontsource/ibm-plex-sans',
];
// Read from the installed packages, as Node finds them: in `node_modules` of the folder that
// needs the package or of a folder further up. That holds for any lockfile and linker.
const installed = (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const at = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(at, 'package.json'))) return realpathSync(at);
    if (dir === top || dirname(dir) === dir) return undefined;
  }
};
const found = new Map();
const walk = (name, from) => {
  const dir = installed(name, from);
  if (!dir) throw new Error(`${name} (needed in ${from}) is not installed: run pnpm install`);
  if (found.has(dir)) return;
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  found.set(dir, manifest);
  for (const dep of Object.keys(manifest.dependencies ?? {})) walk(dep, dir);
};
for (const ws of ['core', 'supervisor', 'cli', 'desktop']) {
  const dir = join(top, 'packages', ws);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!dep.startsWith('@swarmup/')) walk(dep, dir);
  }
}
for (const lib of UI_LIBS) walk(lib, desktop);
const notices = [
  'SwarmUp includes the following third-party software. Electron and Chromium licences are in',
  'LICENSE.electron.txt and LICENSES.chromium.html next to the application.',
  '',
];
const byName = (a, b) =>
  a[1].name.localeCompare(b[1].name) || a[1].version.localeCompare(b[1].version);
for (const [dir, manifest] of [...found].sort(byName)) {
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  const licence = typeof manifest.license === 'string' ? manifest.license : 'see below';
  notices.push(`${'-'.repeat(78)}\n${manifest.name} ${manifest.version} (${licence})\n`);
  notices.push(file ? readFileSync(join(dir, file), 'utf8').trim() : '(no licence file shipped)');
  notices.push('');
}
writeFileSync(join(stage, 'THIRD_PARTY_LICENSES.txt'), `${notices.join('\n')}\n`);

// The `swarmup` command, for the installer's PATH entry and for agent runs: `swarmup.cmd` for cmd
// and PowerShell, an extensionless script for Git Bash. Both run the app's own executable as Node.
// Kept in one folder: PowerShell and cmd pick `swarmup.cmd`, Git Bash picks `swarmup`. `ops` is
// the old name, kept as an alias until 0.4: it prints a notice on stderr, then runs `swarmup`.
const bin = join(desktop, 'release', 'bin');
mkdirSync(bin, { recursive: true });
const OPS_NOTICE = '`ops` is now `swarmup`; the `ops` alias goes away in 0.4.';
const cmdShim = (notice) =>
  [
    '@echo off',
    'setlocal',
    ...(notice ? [`echo ${notice} 1>&2`] : []),
    'set "ELECTRON_RUN_AS_NODE=1"',
    'set "SWARMUP_BIN_DIR=%~dp0"',
    '"%~dp0..\\..\\SwarmUp.exe" "%~dp0..\\app\\swarmup.mjs" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
const shShim = (notice) =>
  [
    '#!/bin/sh',
    `# The installed SwarmUp \`${notice ? 'ops' : 'swarmup'}\` command for Git Bash.`,
    ...(notice ? [`echo '${notice}' >&2`] : []),
    'here="$(cd "$(dirname "$0")" && pwd)"',
    'SWARMUP_BIN_DIR="$here" ELECTRON_RUN_AS_NODE=1 exec "$here/../../SwarmUp.exe" "$here/../app/swarmup.mjs" "$@"',
    '',
  ].join('\n');
writeFileSync(join(bin, 'swarmup.cmd'), cmdShim());
writeFileSync(join(bin, 'swarmup'), shShim());
writeFileSync(join(bin, 'ops.cmd'), cmdShim(OPS_NOTICE));
writeFileSync(join(bin, 'ops'), shShim(OPS_NOTICE));

console.log(`staged SwarmUp ${version} in ${stage}`);
