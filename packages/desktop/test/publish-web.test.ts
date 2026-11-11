// swarmup-web/publish.mjs on a scratch repository, with a local bare repository standing in for
// dawid-ai/swarmup-web on GitHub (AO-0225).
//
// Every git and node call here is async: a publish runs for 10-30 s under full-suite load, and a
// synchronous child process blocks the worker for that long, so vitest's worker RPC times out
// ("Timeout calling onTaskUpdate") and the opsd merge check fails with every test green.
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const dirs: string[] = [];
const links: string[] = [];
afterEach(() => {
  // Links first, so removing a scratch folder never reaches into what they point at.
  for (const l of links.splice(0)) unlinkSync(l);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const env = { ...process.env, ...ID, GITHUB_ACTIONS: '' };

/** Runs a command without blocking the worker; resolves with its exit code and output. */
function run(file: string, args: string[], cwd?: string) {
  return new Promise<{ code: number; stdout: string; out: string }>((resolve) => {
    execFile(
      file,
      args,
      { cwd, env, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, out: stdout + stderr + (err && !stderr ? String(err) : '') });
      },
    );
  });
}

async function git(cwd: string, ...a: string[]) {
  const r = await run('git', a, cwd);
  if (r.code !== 0) throw new Error(`git ${a.join(' ')} failed (${r.code}): ${r.out}`);
  return r.stdout.trim();
}

const FILES: Record<string, string> = {
  'package.json': '{"repository":"github:me/proj"}',
  'README.md': '# Proj\n\nSee [the protocol](docs/protocol.md).\n',
  'docs/protocol.md': '# Protocol\n',
  'docs/proposals/secret.md': '# Internal plan\n',
  '.gitattributes': 'docs/proposals/** export-ignore\n',
  'UPDATES.md': '# Updates\n',
  'swarmup-web/pages/home.html': '<h1>Proj</h1>\n<a href="download.html">Get it</a>\n',
  'swarmup-web/pages/install.md': '# Install\n\n## macOS and Linux\n',
};

async function setup() {
  const d = mkdtempSync(join(tmpdir(), 'ops-web-'));
  dirs.push(d);
  const engine = join(d, 'engine');
  for (const [name, body] of Object.entries(FILES)) {
    mkdirSync(dirname(join(engine, name)), { recursive: true });
    writeFileSync(join(engine, name), body);
  }
  await git(engine, 'init', '-q');
  await git(engine, 'add', '-A');
  await git(engine, 'commit', '-qm', 'start');
  const remote = join(d, 'web.git');
  await git(d, 'init', '-q', '--bare', remote);
  const publish = (...extra: string[]) =>
    run(process.execPath, [
      join(scripts, '..', 'swarmup-web', 'publish.mjs'),
      '--root',
      engine,
      '--repo',
      join(d, 'web'),
      '--remote',
      remote,
      '--offline',
      ...extra,
    ]);
  const published = () => git(d, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main');
  return { d, engine, remote, publish, published };
}

describe('publishing the website', () => {
  it('pushes the built site to main without export-ignored files, and only when it changed', async () => {
    const { engine, remote, publish, published, d } = await setup();
    const first = await publish('--push');
    expect(first.code, first.out).toBe(0);
    const files = (await published()).split('\n');
    expect(files).toContain('index.html');
    expect(files).toContain('docs/protocol.html');
    expect(files).toContain('.nojekyll');
    expect(files).toContain('CNAME');
    expect(files.some((f) => f.includes('proposals'))).toBe(false);

    const again = await publish('--push');
    expect(again.code, again.out).toBe(0);
    expect(again.out).toMatch(/nothing to publish/);
    expect(await git(d, '--git-dir', remote, 'rev-list', '--count', 'main')).toBe('1');

    writeFileSync(join(engine, 'swarmup-web', 'pages', 'home.html'), '<h1>Proj, now better</h1>\n');
    await git(engine, 'commit', '-qam', 'better home');
    const changed = await publish('--push');
    expect(changed.code, changed.out).toBe(0);
    expect(await git(d, '--git-dir', remote, 'rev-list', '--count', 'main')).toBe('2');
    expect(await git(d, '--git-dir', remote, 'show', 'main:index.html')).toContain(
      'Proj, now better',
    );
  });

  it('commits without --push, then pushes that commit on the next run with --push', async () => {
    const { remote, publish, d } = await setup();
    const local = await publish();
    expect(local.code, local.out).toBe(0);
    expect(local.out).toMatch(/run again with --push/);
    expect(await git(d, '--git-dir', remote, 'branch', '--list')).toBe('');
    const pushed = await publish('--push');
    expect(pushed.code, pushed.out).toBe(0);
    expect(pushed.out).toMatch(/pushed the build already committed/);
    expect(await git(d, '--git-dir', remote, 'rev-list', '--count', 'main')).toBe('1');
  });

  it('publishes what HEAD holds, with uncommitted sources and build scripts left out', async () => {
    const { d, engine, remote, published } = await setup();
    // The engine carries its own committed copy of the scripts, as the real repository does, and
    // finds marked through a link to the installed packages.
    const tools = [
      'scripts/build-docs.mjs',
      'scripts/check-docs-links.mjs',
      'swarmup-web/build.mjs',
      'swarmup-web/publish.mjs',
      'swarmup-web/assets/favicon.svg',
      'swarmup-web/assets/logo.svg',
      'swarmup-web/assets/site.css',
      'swarmup-web/assets/site.js',
    ];
    for (const name of tools) {
      mkdirSync(dirname(join(engine, name)), { recursive: true });
      copyFileSync(join(scripts, '..', name), join(engine, name));
    }
    symlinkSync(join(scripts, '..', 'node_modules'), join(engine, 'node_modules'), 'junction');
    links.push(join(engine, 'node_modules'));
    writeFileSync(join(engine, '.gitignore'), 'node_modules\n');
    await git(engine, 'add', '-A');
    await git(engine, 'commit', '-qm', 'scripts');

    // Work in progress: an edited build script, an edited page and a new page.
    const site = join(engine, 'swarmup-web', 'build.mjs');
    writeFileSync(
      site,
      readFileSync(site, 'utf8').replace("const PRODUCT = 'SwarmUp'", "const PRODUCT = 'Leaked'"),
    );
    writeFileSync(join(engine, 'swarmup-web', 'pages', 'home.html'), '<h1>Draft home</h1>\n');
    const css = join(engine, 'swarmup-web', 'assets', 'site.css');
    writeFileSync(css, readFileSync(css, 'utf8') + '\n.leaked-style { color: red; }\n');
    writeFileSync(join(engine, 'docs', 'draft.md'), '# Draft\n');

    const r = await run(process.execPath, [
      join(engine, 'swarmup-web', 'publish.mjs'),
      '--repo',
      join(d, 'web'),
      '--remote',
      remote,
      '--offline',
      '--push',
    ]);
    expect(r.code, r.out).toBe(0);
    const index = await git(d, '--git-dir', remote, 'show', 'main:index.html');
    expect(index).toContain('<h1>Proj</h1>');
    expect(index).not.toContain('Draft home');
    expect(index).not.toContain('Leaked');
    expect(index).toContain('SwarmUp');
    expect(await published()).not.toMatch(/draft/);
    expect(await git(d, '--git-dir', remote, 'show', 'main:site.css')).not.toContain(
      'leaked-style',
    );
    // The link went first, so the installed packages are still there.
    expect(existsSync(join(scripts, '..', 'node_modules', 'marked'))).toBe(true);
  });

  it('stops when the website checkout has changes of its own', async () => {
    const { publish, d } = await setup();
    expect((await publish()).code).toBe(0);
    writeFileSync(join(d, 'web', 'index.html'), 'edited by hand');
    const r = await publish('--push');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/has changes of its own/);
  });
});
