// Renders every desktop view offscreen against a scratch data root and fails when a view logs an
// error, a swarmupd call fails, or the allowlist refuses a call. Run after `npm run build:desktop`.
// The release workflow runs it under xvfb-run; locally: `node scripts/desktop-smoke.mjs`.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(top, 'packages', 'cli', 'dist', 'main.js');
const base = mkdtempSync(join(tmpdir(), 'swarmup-desktop-smoke-'));
const repo = join(base, 'repo');
const state = join(base, 'state');
const shots = join(base, 'shots');
mkdirSync(repo);
mkdirSync(state);

const git = (...args) =>
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', windowsHide: true });
git('init', '-q');
const node = process.execPath.replace(/\\/g, '/');
const config = join(base, 'config.yml');
writeFileSync(
  config,
  [
    'me: human:smoke',
    'opsd:',
    '  port: 0',
    '  sync: false',
    '  max_runs: 0',
    '  runtimes:',
    `    claude: { command: '${node}', args: ['-e', 'setInterval(() => {}, 1000)'] }`,
    `    codex: { command: '${node}', args: ['-e', 'setInterval(() => {}, 1000)'] }`,
    '',
  ].join('\n'),
);
const env = { ...process.env, SWARMUP_CONFIG: config, SWARMUP_STATE_DIR: state, SWARMUP_CWD: repo };
// Both prefixes: the old OPS_* names are still read when the new ones are unset.
for (const k of ['AGENT', 'RUN', 'ROOTS']) {
  delete env['SWARMUP_' + k];
  delete env['OPS_' + k];
}
const swarmup = (actor, ...args) =>
  execFileSync(process.execPath, [cli, ...args], {
    cwd: repo,
    env: actor ? { ...env, SWARMUP_AGENT: actor } : env,
    encoding: 'utf8',
    windowsHide: true,
  });

// Something in every view: tasks in each state, a finding, a note, a post, a vote.
swarmup(null, 'init', '--name', 'smoke', '--prefix', 'SMK', '--human', 'human:smoke');
swarmup('human:smoke', 'new', 'Fix the pricing page', '--to', '*:engineer', '--priority', 'p1');
swarmup('human:smoke', 'new', 'Write the docs', '--to', 'claude:engineer', '--label', 'docs');
swarmup('human:smoke', 'new', 'Idea: dark mode', '--type', 'idea');
swarmup('claude:engineer', 'start', 'SMK-0002', 'plan');
// Work on a branch, named by the review, for the diff view in the task panel (AO-0106).
const commit = (message) => {
  git('add', '-A');
  git('-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.com', 'commit', '-q', '-m', message);
};
writeFileSync(join(repo, 'docs.ts'), 'export const pages = 1;\n');
commit('Start');
git('checkout', '-q', '-b', 'claude/docs');
writeFileSync(join(repo, 'docs.ts'), 'export const pages = 2; // one more\n');
writeFileSync(join(repo, 'guide.md'), '# Guide\n');
commit('Write the docs');
const docsCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  cwd: repo,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
git('checkout', '-q', '-');
swarmup(
  'claude:engineer',
  'review',
  'SMK-0002',
  `${docsCommit} on branch claude/docs: please check`,
  '--to',
  'codex:qa',
);
swarmup('codex:qa', 'finding', 'Images have no size', '--task', 'SMK-0002', '-m', 'Layout shifts.');
swarmup('claude:engineer', 'learn', 'css', 'Grid gaps', '-m', 'Use gap.');
swarmup('claude:engineer', 'channel', 'post', 'general', 'hello @codex:qa');
// An attached image in a post: it must load through the swarmup-att scheme under the page's CSP.
const icon = join(top, 'packages', 'desktop', 'build', 'icon.png');
const link = swarmup('human:smoke', 'attach', icon, '--alt', 'app icon').trim();
swarmup('human:smoke', 'channel', 'post', 'general', `the icon: ${link}`);
swarmup('human:smoke', 'comment', 'SMK-0002', `see ${link}`);
// The chat: one answered turn with links, and a mention that waits, since max_runs is 0.
swarmup('human:smoke', 'channel', 'post', 'general', 'what is open? @*:orchestrator');
const at = new Date().toISOString();
writeFileSync(
  join(state, 'chat.json'),
  JSON.stringify({
    markers: {},
    messages: [
      {
        id: '01SMOKECHAT0000000000000001',
        role: 'user',
        at,
        text: 'Add a task for the docs.',
        from: 'human:smoke',
        status: 'sent',
      },
      {
        id: '01SMOKECHAT0000000000000002',
        role: 'assistant',
        at,
        text: 'Created **SMK-0002** and assigned it to `claude:engineer`.',
        actions: [
          {
            kind: 'task',
            type: 'created',
            root: 'smoke',
            task: 'SMK-0002',
            title: 'Write the docs',
            summary: '',
          },
          {
            kind: 'channel',
            type: 'post',
            root: 'smoke',
            channel: 'general',
            summary: 'Docs task filed',
          },
        ],
      },
    ],
  }),
);
swarmup(
  'human:smoke',
  'propose',
  'Ship it?',
  '--option',
  'yes',
  '--option',
  'no',
  '--deadline',
  '+48h',
);

// A repo without a data root, for Add project's proposal (AO-0274).
const adoptable = join(base, 'shop');
mkdirSync(adoptable);
execFileSync('git', ['init', '-q'], { cwd: adoptable, stdio: 'ignore', windowsHide: true });
writeFileSync(
  join(adoptable, 'package.json'),
  JSON.stringify({
    name: 'shop',
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '4' },
  }),
);

const views = [
  'inbox',
  'board',
  'list',
  'findings',
  'activity',
  'reports',
  'replay',
  'agents',
  'runs',
  'standups',
  'schedules',
  'decisions',
  'chat',
  'channels',
  'knowledge',
  'settings',
  // The Cleanup section is below the first screen: `settings:cleanup` scrolls to it (AO-0298).
  'settings:cleanup',
];

// --packaged: the unpacked installer build (npm run dist), with its bundled swarmupd and swarmup command,
// and a user-data folder of its own so nothing lands in the person's app data.
const packaged = process.argv.includes('--packaged');
const exe = join(top, 'packages', 'desktop', 'release', 'dist', 'win-unpacked', 'SwarmUp.exe');
if (packaged && !existsSync(exe)) {
  console.error(`no packaged build at ${exe}: run npm run dist first`);
  process.exit(1);
}
const electronArgs = packaged
  ? [`--user-data-dir=${join(base, 'userdata')}`]
  : [join(top, 'packages', 'desktop')];
// Linux runners have no setuid sandbox helper.
if (process.platform === 'linux') electronArgs.push('--no-sandbox');
// The electron package exports the path to its binary, so no shell is needed.
const electron = packaged ? exe : createRequire(import.meta.url)('electron');
let code = 1;
const appLogFile = join(base, 'app.log');
const appLog = openSync(appLogFile, 'w');
let stopped = false;
try {
  const res = spawnSync(electron, electronArgs, {
    env: {
      ...env,
      SWARMUP_SCREENSHOTS: shots,
      // Add project comes last: its dialog stays open. Screenshot mode has no folder dialog, so
      // the pick is named here.
      // The diff of SMK-0002 comes first: it covers the window until the next view closes its task.
      SWARMUP_VIEWS: ['diff:SMK-0002', ...views, 'repeating', 'add-project'].join(','),
      SWARMUP_SCREENSHOT_PICKS: adoptable,
      ELECTRON_ENABLE_LOGGING: '1',
    },
    // No pipes: the scratch swarmupd the app starts would hold them open past the app's exit. A log
    // file keeps what the app printed for a failure report.
    stdio: ['ignore', appLog, appLog],
    timeout: 180_000,
    windowsHide: true,
  });
  closeSync(appLog);
  code = res.status ?? 1;
  if (res.error) console.error(`electron: ${res.error.message}`);
} finally {
  // The app starts a scratch swarmupd; stop it, or the job never ends.
  stopped =
    spawnSync(process.execPath, [cli, 'daemon', 'stop'], {
      cwd: repo,
      env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
    }).status === 0;
}

const missing = [...views, 'diff-SMK-0002', 'add-project'].filter((v) => {
  // The app names the file of `view:id` with a dash.
  const png = join(shots, `${v.replace(/[:/]/g, '-')}.png`);
  return !existsSync(png) || statSync(png).size < 1024;
});
const problems = existsSync(join(shots, 'problems.json'))
  ? JSON.parse(readFileSync(join(shots, 'problems.json'), 'utf8'))
  : ['no problems.json: the screenshot run did not finish'];
if (!stopped)
  problems.push('could not stop the scratch opsd: check for a leftover swarmupd process');
const failed = code !== 0 || missing.length > 0 || problems.length > 0;
if (failed) {
  console.error(`desktop smoke failed (electron exit ${code})`);
  for (const v of missing) console.error(`  no screenshot: ${v}`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(`  screenshots in ${shots}`);
  const log = existsSync(appLogFile) ? readFileSync(appLogFile, 'utf8').trim() : '';
  if (log) console.error(`app output (last 60 lines):\n${log.split('\n').slice(-60).join('\n')}`);
  process.exit(1);
}
console.log(`desktop smoke: ${views.length} views rendered with no errors`);
// --keep keeps the screenshots to look at.
if (process.argv.includes('--keep')) console.log(`  screenshots in ${shots}`);
else rmSync(base, { recursive: true, force: true, maxRetries: 5 });
