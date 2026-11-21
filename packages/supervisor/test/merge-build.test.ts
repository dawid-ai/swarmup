import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PATCH_KEY_ARGS, patchKey } from '@swarmup/core';
import {
  CommandRunner,
  DEFAULT_INSTALL,
  DEFAULT_PNPM_INSTALL,
  insideDir,
  installCommands,
  installSteps,
  isEngineRepo,
  lockfileChanges,
  lockfileDirs,
  MERGE_ACTOR,
  missingOptionalPackages,
  notLiveNotice,
  npmRegistry,
  withoutScriptEnv,
  opsdCodeChanges,
  opsdConfig,
  repairInstallCommand,
} from '../src/index.js';
import { git, mergeSetup, temp, text } from './merge-setup.js';

describe('merging approved work', () => {
  it('rebases onto the base, runs the checks, fast-forwards the base, builds and records it', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    // main moves on after the branch was cut, so the merge is a real rebase.
    const before = s.onMain('other.txt', 'other\n');
    s.approve(commit);
    // The task store has events no commit holds; a merge leaves them alone.
    const pending = git(s.repo, 'status', '--porcelain', '--', '.swarmup');
    expect(pending).not.toBe('');
    await s.merged();

    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'rev-parse', `${tip}^`)).toBe(before);
    expect(git(s.repo, 'log', '-1', '--format=%s', tip)).toBe('Change the code');
    // The checkout follows main, and the build ran there.
    expect(text(join(s.repo, 'code.txt'))).toBe('two\n');
    expect(text(join(s.repo, 'other.txt'))).toBe('other\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(git(s.repo, 'status', '--porcelain', '--', '.swarmup')).toBe(pending);

    expect(s.as('human:dawid').view('1').status).toBe('done');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'merge',
      actor: MERGE_ACTOR,
      commit: tip,
      into: 'main',
      branch: 'feature',
    });
    expect(e.body).toContain(`as ${tip.slice(0, 7)}, rebased onto ${before.slice(0, 7)}`);
    expect(e.body).toContain('Checks passed: `node check.mjs`.');
    expect(e.body).toContain('Built with `node build.mjs`.');

    // Done once: a second tick merges nothing again.
    await s.merged();
    expect(git(s.repo, 'rev-parse', 'main')).toBe(tip);
    expect(
      s
        .as('human:dawid')
        .showEvents('1')
        .events.filter((x) => x.type === 'merge'),
    ).toHaveLength(1);
  });

  it('runs no check whose paths a Markdown-only change misses, and says so (AO-0382)', async () => {
    const s = mergeSetup({
      checks: [{ run: 'node check.mjs', paths: ['**', '!**/*.md'] }],
    });
    // `code.txt` stays as it is: the work changes a Markdown file only.
    const commit = s.branch('one\n', { 'docs/guide.md': '# Guide\n' });
    s.approve(commit);
    await s.merged();

    const tip = git(s.repo, 'rev-parse', 'main');
    expect(git(s.repo, 'log', '-1', '--format=%s', tip)).toBe('Change the code');
    expect(existsSync(join(s.state, 'checks.txt'))).toBe(false);
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge', commit: tip });
    expect(e.body).not.toContain('Checks passed');
    expect(e.body).toContain('Not run, the work changes none of their paths: `node check.mjs`.');
  });

  it('runs a check when the work renames code into a path the check skips (AO-0382)', async () => {
    const s = mergeSetup({
      checks: [{ run: 'node check.mjs', paths: ['**', '!**/*.md'] }],
    });
    const wt = join(temp(), 'wt');
    git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', wt, 'main');
    mkdirSync(join(wt, 'docs'));
    // A pure rename: git's rename detection names only `docs/held.md`, which the check skips.
    git(wt, 'mv', 'held.mjs', 'docs/held.md');
    git(wt, 'commit', '-qm', 'Move the code');
    s.approve(git(wt, 'rev-parse', 'HEAD'));
    await s.merged();

    expect(text(join(s.state, 'checks.txt'))).toBe('x');
    const e = s.last();
    expect(e).toMatchObject({ type: 'merge' });
    expect(e.body).toContain('Checks passed: `node check.mjs`.');
  });

  it('runs a check whose paths the change reaches (AO-0382)', async () => {
    const s = mergeSetup({
      checks: [
        { run: 'node check.mjs', paths: ['**', '!**/*.md'] },
        { run: 'node check.mjs --docs', paths: ['**/*.md'] },
      ],
    });
    const commit = s.branch('two\n');
    s.approve(commit);
    await s.merged();

    expect(text(join(s.state, 'checks.txt'))).toBe('x');
    const e = s.last();
    expect(e.body).toContain('Checks passed: `node check.mjs`.');
    expect(e.body).toContain(
      'Not run, the work changes none of their paths: `node check.mjs --docs`.',
    );
  });

  it("runs the checks without the installed app's swarmupd entry and Electron host flags (AO-0235)", async () => {
    const out = join(temp(), 'env.json');
    // What swarmupd has in its environment when the installed desktop app hosts it.
    const s = mergeSetup({
      env: {
        SWARMUP_DAEMON_ENTRY: 'C:/app/swarmupd.mjs',
        OPS_DAEMON_ENTRY: 'C:/app/opsd.mjs',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_NO_ASAR: '1',
        MERGE_KEEP: 'yes',
        MERGE_ENV_OUT: out,
        // And when `pnpm swarmup` started it (AO-0307).
        npm_config_registry: 'https://registry.npmjs.org/',
        npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22.0.0 win32 x64',
        npm_execpath: 'C:/pnpm/bin/pnpm.cjs',
        INIT_CWD: 'C:/engine',
      },
    });
    s.approve(s.branch('two\n'));
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    // A check that starts swarmupd, as this repo's tests do, starts its own checkout's build.
    expect(JSON.parse(text(out))).toEqual(['MERGE_KEEP']);
  });

  it('approves the merged patch for its own repo and base only, for 30 days (AO-0193)', async () => {
    let now = Date.now();
    const s = mergeSetup({ now: () => now });
    const commit = s.branch('two\n');
    s.onMain('other.txt', 'other\n');
    s.approve(commit);
    await s.merged();
    const tip = git(s.repo, 'rev-parse', 'main');
    const key = patchKey(git(s.repo, ...PATCH_KEY_ARGS, tip));
    expect(key).toBeTruthy();
    type Approving = { approved(): (top: string, branch: string) => ReadonlySet<string> };
    const approved = (top: string, branch: string, sup = s.sup) => [
      ...(sup as unknown as Approving).approved()(top, branch),
    ];
    expect(approved(s.repo, 'main')).toEqual([key]);
    // Another branch of the repo, or another repo with an equal patch on main, is not approved.
    expect(approved(s.repo, 'feature')).toEqual([]);
    const other = temp();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: other, windowsHide: true });
    expect(approved(other, 'main')).toEqual([]);
    // A swarmupd started later reads the same file.
    expect(approved(s.repo, 'main', s.opsd())).toEqual([key]);
    // Expired keys stop counting when read, before any later merge prunes them.
    now += 30 * 86_400_000 + 1;
    expect(approved(s.repo, 'main')).toEqual([]);
    // The first, unscoped form of the file approves nothing.
    now = Date.now();
    const unscoped = { [key!]: new Date(now).toISOString() };
    writeFileSync(join(s.state, 'approved.json'), JSON.stringify(unscoped));
    expect(approved(s.repo, 'main')).toEqual([]);
  });

  it('installs dependencies in the checkout before the build when the merge changed a lockfile (AO-0185)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    const installed = join(s.state, 'installed.txt');
    const commit = s.branch('two\n', { 'package-lock.json': '{"lockfileVersion":3}\n' });
    s.approve(commit);
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    // It ran once, in the checkout, after the base moved there.
    expect(text(installed)).toBe('two\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(s.last().body).toContain('Built with `node install.mjs`, `node build.mjs`.');
  });

  it('installs in each directory whose lockfile the merge changed, without a root lockfile (AO-0185)', async () => {
    const s = mergeSetup({
      install: (repo) => [`node "${join(repo, 'install-where.mjs').replace(/\\/g, '/')}"`],
    });
    const commit = s.branch('two\n', {
      'site/package-lock.json': '{"lockfileVersion":3}\n',
      'app/web/npm-shrinkwrap.json': '{"lockfileVersion":3}\n',
      'docs/note.md': 'a note\n',
    });
    s.approve(commit);
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    // Once in each changed directory, in order, and not in the checkout itself.
    expect(text(join(s.state, 'installed.txt'))).toBe('web\nsite\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    const body = s.last().body;
    expect(body).toContain('install-where.mjs" (in app/web)`');
    expect(body).toContain('install-where.mjs" (in site)`, `node build.mjs`.');
  });

  it('skips the install when the merge left the lockfiles alone (AO-0185)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    const commit = s.branch('two\n', { 'docs/note.md': 'a note\n' });
    s.approve(commit);
    await s.merged();
    expect(existsSync(join(s.state, 'installed.txt'))).toBe(false);
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('two\n');
    expect(s.last().body).toContain('Built with `node build.mjs`.');
  });

  it('installs in the checkout and builds once more when the build fails there (AO-0232)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    // No lockfile change, so no install before the build; the build misses its dependencies.
    const commit = s.branch('deps\n');
    s.approve(commit);
    await s.merged();
    expect(s.as('human:dawid').view('1').status).toBe('done');
    expect(text(join(s.state, 'installed.txt'))).toBe('deps\n');
    expect(text(join(s.repo, 'dist', 'built.txt'))).toBe('deps\n');
    expect(s.last().type).toBe('merge');
    expect(s.last().body).toContain(
      'Built with `node install.mjs`, `node build.mjs`, after `node build.mjs` failed (exit 1) before the install.',
    );
  });

  it('tells the human, not the author, when the install in the checkout fails (AO-0232)', async () => {
    const s = mergeSetup({ install: ['node fail.mjs'] });
    const fail = "console.error('EBUSY: resource busy or locked'); process.exit(3);\n";
    const commit = s.branch('deps\n', { 'fail.mjs': fail });
    s.approve(commit);
    await s.merged();
    // The merge landed and its code passed the checks: the task stays closed.
    expect(s.as('human:dawid').view('1').status).toBe('done');
    const events = s.as('human:dawid').showEvents('1').events;
    expect(events.filter((e) => e.type === 'verdict')).toHaveLength(1);
    expect(events.at(-2)!.body).toContain('Build: `node fail.mjs` failed (exit 3).');
    const e = s.last();
    expect(e.type).toBe('comment');
    expect(e.to).toBe('human:dawid');
    expect(e.body).toMatch(
      /^\S*T-0001: swarmupd merged .* into `main` as [0-9a-f]{7}, but could not install the dependencies in /,
    );
    expect(e.body).toContain('`node fail.mjs` failed (exit 3)');
    expect(e.body).toContain('EBUSY: resource busy or locked');
    expect(e.body).toContain('Action: once no other install runs in');
  });

  it('sends the task back when the build still fails after the install (AO-0232)', async () => {
    const s = mergeSetup({ install: ['node install.mjs'] });
    const commit = s.branch('broken\n');
    s.approve(commit);
    await s.merged();
    expect(text(join(s.state, 'installed.txt'))).toBe('broken\n');
    const e = s.last();
    expect(e.type).toBe('verdict');
    expect(e.verdict).toBe('changes');
    expect(e.body).toContain(
      ', also after swarmupd installed the dependencies there; fix it in a new commit',
    );
    expect(e.body).toContain('code says broken');
  });

  it('builds once when the checkout has nothing to install (AO-0232)', async () => {
    const s = mergeSetup();
    const commit = s.branch('broken\n');
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e.verdict).toBe('changes');
    expect(e.body).toContain('`node build.mjs` failed (exit 1) in ');
    expect(e.body).not.toContain('also after swarmupd installed');
  });

  it('sends the task back when the build fails after a default install with nothing left out (AO-0229)', async () => {
    const s = mergeSetup();
    // The default install runs npm; with no packages it is quick and needs no network. Its
    // second step has nothing to install and leaves no result, so the failed build is the
    // second result of three entries: still a build step, not an install.
    const commit = s.branch('broken\n', {
      'package.json': '{"name":"t","version":"1.0.0","private":true}\n',
      'package-lock.json':
        '{"name":"t","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"t","version":"1.0.0"}}}\n',
    });
    s.approve(commit);
    await s.merged();
    const e = s.last();
    expect(e.type).toBe('verdict');
    expect(e.verdict).toBe('changes');
    expect(e.body).toContain('`node build.mjs` failed (exit 1) in ');
    expect(e.body).not.toContain('also after swarmupd installed');
  });

  it('finds lockfile changes and picks the install commands (AO-0185)', () => {
    expect(
      lockfileChanges([
        'package-lock.json',
        'packages/desktop/package.json',
        'site/npm-shrinkwrap.json',
        'docs/package-lock.json.md',
        'src/main.ts',
      ]),
    ).toEqual(['package-lock.json', 'site/npm-shrinkwrap.json']);
    expect(
      lockfileDirs([
        'site/package-lock.json',
        'package-lock.json',
        'site/npm-shrinkwrap.json',
        'app/web/package-lock.json',
        'src/main.ts',
      ]),
    ).toEqual(['.', 'app/web', 'site']);
    expect(lockfileDirs(['src/main.ts'])).toEqual([]);
    // A pnpm lockfile counts like npm's (AO-0299).
    expect(lockfileChanges(['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'a/pnpm-lock.yaml'])).toEqual([
      'pnpm-lock.yaml',
      'a/pnpm-lock.yaml',
    ]);
    expect(lockfileDirs(['pnpm-lock.yaml', 'package-lock.json'])).toEqual(['.']);
    const top = temp();
    // No lockfile in the checkout: nothing to install unless the config says so.
    expect(installCommands(undefined, top)).toEqual([]);
    expect(installCommands(['pnpm install --frozen-lockfile'], top)).toEqual([
      'pnpm install --frozen-lockfile',
    ]);
    writeFileSync(join(top, 'package-lock.json'), '{}');
    expect(installCommands(undefined, top)).toEqual([DEFAULT_INSTALL]);
    // `[]` turns it off.
    expect(installCommands([], top)).toEqual([]);
    // The default runs in each changed directory that still has a lockfile; the root has none
    // here, and `gone` lost its lockfile in the merge.
    const nested = temp();
    mkdirSync(join(nested, 'site'));
    writeFileSync(join(nested, 'site', 'package-lock.json'), '{}');
    const site = join(nested, 'site');
    // After the default install comes the step that installs what it left out (AO-0229).
    expect(installSteps(undefined, nested, ['.', 'gone', 'site'])).toEqual([
      { command: DEFAULT_INSTALL, cwd: site, label: `${DEFAULT_INSTALL} (in site)` },
      expect.any(Function),
    ]);
    // A configured install runs in each of them; in the checkout itself as a bare command.
    expect(installSteps(['node i.mjs'], nested, ['.', 'site'])).toEqual([
      'node i.mjs',
      { command: 'node i.mjs', cwd: site, label: 'node i.mjs (in site)' },
    ]);
    expect(installSteps([], nested, ['.', 'site'])).toEqual([]);
    // A directory with a pnpm lockfile gets pnpm's install, also beside an old npm lockfile,
    // and no step that installs optional packages by name (AO-0299).
    writeFileSync(join(site, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    expect(installCommands(undefined, site)).toEqual([DEFAULT_PNPM_INSTALL]);
    expect(installSteps(undefined, nested, ['site'])).toEqual([
      { command: DEFAULT_PNPM_INSTALL, cwd: site, label: `${DEFAULT_PNPM_INSTALL} (in site)` },
    ]);
    expect(installCommands(['node i.mjs'], site)).toEqual(['node i.mjs']);
    // It installs the lockfile as written and never rewrites it in the checkout.
    expect(DEFAULT_PNPM_INSTALL).toContain('--frozen-lockfile');
    // Never `npm ci`, which deletes node_modules under a running swarmupd or app first.
    expect(DEFAULT_INSTALL).not.toMatch(/\bnpm ci\b/);
    expect(DEFAULT_INSTALL).toContain('--no-save');
    // The user config reads `install` like `build`.
    const merge = (install: unknown) =>
      opsdConfig({ opsd: { merge: { x: { base: 'main', install: install as string[] } } } }).merge
        .x!.install;
    expect(merge(['npm ci'])).toEqual(['npm ci']);
    expect(merge([])).toEqual([]);
    expect(merge(undefined)).toBeUndefined();
    expect(() => merge('npm ci')).toThrow('swarmupd.merge.x.install: use a list of commands');
  });

  it('installs by name the optional packages that npm install left out (AO-0229)', async () => {
    const top = temp();
    const win = { os: 'win32', cpu: 'x64' };
    const optional = (more: object = {}) => ({ version: '1.32.0', optional: true, ...more });
    const lock = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/css': { version: '1.32.0' },
        // The package for this platform, which `npm install` left out.
        'node_modules/css-win32-x64-msvc': optional({ os: ['win32'], cpu: ['x64'], peer: true }),
        'node_modules/css-win32-arm64-msvc': optional({ os: ['win32'], cpu: ['arm64'] }),
        'node_modules/css-linux-x64-gnu': optional({
          os: ['linux'],
          cpu: ['x64'],
          libc: ['glibc'],
        }),
        'node_modules/css-linux-x64-musl': optional({
          os: ['linux'],
          cpu: ['x64'],
          libc: ['musl'],
        }),
        'node_modules/@scope/here': optional({ os: ['win32'] }),
        'node_modules/@scope/gone': optional({ version: '2.0.0-beta.1', os: ['win32', 'linux'] }),
        'node_modules/alias': optional({ name: 'real-name', cpu: ['x64'] }),
        // No platform list, or exclusions only: npm may leave these out on purpose (a failed or
        // omitted optional install), so the step must not turn them into a required install.
        'node_modules/anywhere': optional(),
        'node_modules/empty-lists': optional({ os: [], cpu: [] }),
        'node_modules/not-aix': optional({ os: ['!aix'] }),
        'node_modules/not-arm': optional({ os: ['!aix'], cpu: ['!arm'] }),
        // Names this cpu, and excludes this os.
        'node_modules/x64-not-win': optional({ os: ['!win32'], cpu: ['x64'] }),
        // Not optional, nested, linked, bundled, or not a plain version: left alone.
        'node_modules/required': { version: '1.0.0' },
        'node_modules/css/node_modules/nested': optional(),
        'packages/web/node_modules/nested': optional(),
        'node_modules/linked': { link: true, optional: true, resolved: 'packages/linked' },
        'node_modules/bundled': optional({ inBundle: true }),
        'node_modules/from-git': { optional: true, resolved: 'git+ssh://git@example.com/x.git' },
        'node_modules/odd': optional({ version: '1.0.0 && echo no' }),
        // A plain version, and a source that is not the registry: `name@version` would fetch
        // another package.
        'node_modules/git-semver': optional({
          os: ['win32'],
          resolved: 'git+ssh://git@example.com/x/git-semver.git#0123456789abcdef',
        }),
        'node_modules/file-semver': optional({
          os: ['win32'],
          resolved: 'file:vendor/f-1.32.0.tgz',
        }),
        'node_modules/url-semver': optional({
          os: ['win32'],
          resolved: 'https://example.com/downloads/url-semver-1.32.0.tgz',
        }),
        'node_modules/other-name': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/evil/-/evil-1.32.0.tgz',
        }),
        'node_modules/other-version': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/other-version/-/other-version-1.31.0.tgz',
        }),
        'node_modules/odd-resolved': optional({ os: ['win32'], resolved: 7 }),
        // A tarball with the path of a registry tarball, not in the registry npm installs this
        // name from: another host, scheme, port or folder, or the registry of another scope.
        'node_modules/shaped': optional({
          os: ['win32'],
          resolved: 'https://example.com/shaped/-/shaped-1.32.0.tgz',
        }),
        'node_modules/shaped-http': optional({
          os: ['win32'],
          resolved: 'http://registry.npmjs.org/shaped-http/-/shaped-http-1.32.0.tgz',
        }),
        'node_modules/shaped-port': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org:8443/shaped-port/-/shaped-port-1.32.0.tgz',
        }),
        'node_modules/shaped-folder': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/files/shaped-folder/-/shaped-folder-1.32.0.tgz',
        }),
        'node_modules/shaped-user': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org@example.com/shaped-user/-/shaped-user-1.32.0.tgz',
        }),
        'node_modules/@scope/shaped': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/@scope/shaped/-/shaped-1.32.0.tgz',
        }),
        'node_modules/shaped-scope-host': optional({
          os: ['win32'],
          resolved: 'https://npm.example.com/repo/shaped-scope-host/-/shaped-scope-host-1.32.0.tgz',
        }),
        'node_modules/@down/shaped': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/@down/shaped/-/shaped-1.32.0.tgz',
        }),
        // From the configured registry: the tarball of this name and version there, also scoped
        // (in the registry of its scope), encoded or aliased.
        'node_modules/reg': optional({
          os: ['win32'],
          resolved: 'https://registry.npmjs.org/reg/-/reg-1.32.0.tgz',
        }),
        'node_modules/@scope/reg': optional({
          os: ['win32'],
          resolved: 'https://npm.example.com/repo/@scope%2freg/-/reg-1.32.0.tgz',
        }),
        'node_modules/reg-alias': optional({
          name: '@scope/real',
          os: ['win32'],
          resolved: 'https://npm.example.com/repo/@scope/real/-/real-1.32.0.tgz',
        }),
      },
    };
    writeFileSync(join(top, 'package-lock.json'), JSON.stringify(lock));
    mkdirSync(join(top, 'node_modules', '@scope', 'here'), { recursive: true });
    writeFileSync(join(top, 'node_modules', '@scope', 'here', 'package.json'), '{}');
    // The hidden lockfile lists nothing, as after an install from a lockfile without them.
    writeFileSync(join(top, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    const registry = ['@scope/reg@1.32.0', 'reg-alias@npm:@scope/real@1.32.0', 'reg@1.32.0'];
    // npm's configuration: `@scope` has its own registry, and that of `@down` is not known.
    const asked: (string | undefined)[] = [];
    const reg = (scope: string | undefined): string | undefined => {
      asked.push(scope);
      if (scope === '@down') return undefined;
      return scope === '@scope' ? 'https://npm.example.com/repo/' : 'https://registry.npmjs.org';
    };
    expect(missingOptionalPackages(top, win, reg)).toEqual([
      '@scope/gone@2.0.0-beta.1',
      registry[0],
      'alias@npm:real-name@1.32.0',
      'css-win32-x64-msvc@1.32.0',
      registry[1],
      registry[2],
    ]);
    // One lookup a scope, however many packages have it.
    expect(asked).toHaveLength(3);
    expect(new Set(asked)).toEqual(new Set(['@down', '@scope', undefined]));
    // With npm's public registry for every scope, the tarballs on the other host are left alone.
    expect(missingOptionalPackages(top, win, () => 'https://registry.npmjs.org/')).toEqual([
      '@down/shaped@1.32.0',
      '@scope/gone@2.0.0-beta.1',
      '@scope/shaped@1.32.0',
      'alias@npm:real-name@1.32.0',
      'css-win32-x64-msvc@1.32.0',
      'reg@1.32.0',
    ]);
    // No registry known, or a lookup that throws: only packages without `resolved`.
    const noResolved = [
      '@scope/gone@2.0.0-beta.1',
      'alias@npm:real-name@1.32.0',
      'css-win32-x64-msvc@1.32.0',
    ];
    expect(missingOptionalPackages(top, win, () => undefined)).toEqual(noResolved);
    expect(
      missingOptionalPackages(top, win, () => {
        throw new Error('no npm');
      }),
    ).toEqual(noResolved);
    for (const spec of registry) {
      const name = spec.slice(0, spec.indexOf('@', 1));
      mkdirSync(join(top, 'node_modules', ...name.split('/')), { recursive: true });
      writeFileSync(join(top, 'node_modules', ...name.split('/'), 'package.json'), '{}');
    }
    expect(missingOptionalPackages(top, { os: 'linux', cpu: 'x64', libc: 'musl' }, reg)).toContain(
      'css-linux-x64-musl@1.32.0',
    );
    expect(missingOptionalPackages(top, { os: 'linux', cpu: 'x64', libc: 'musl' }, reg)).toEqual([
      '@scope/gone@2.0.0-beta.1',
      'alias@npm:real-name@1.32.0',
      'css-linux-x64-musl@1.32.0',
      'x64-not-win@1.32.0',
    ]);
    expect(repairInstallCommand(top, win, reg)).toBe(
      `${DEFAULT_INSTALL} @scope/gone@2.0.0-beta.1 alias@npm:real-name@1.32.0 css-win32-x64-msvc@1.32.0`,
    );
    // The step reads `node_modules` when its turn comes, after the default install ran.
    const [first, repair] = installSteps(undefined, top, ['.'], win, reg);
    expect(first).toBe(DEFAULT_INSTALL);
    for (const name of ['@scope/gone', 'alias']) {
      mkdirSync(join(top, 'node_modules', ...name.split('/')), { recursive: true });
      writeFileSync(join(top, 'node_modules', ...name.split('/'), 'package.json'), '{}');
    }
    expect((repair as () => unknown)()).toBe(`${DEFAULT_INSTALL} css-win32-x64-msvc@1.32.0`);
    mkdirSync(join(top, 'node_modules', 'css-win32-x64-msvc'));
    writeFileSync(join(top, 'node_modules', 'css-win32-x64-msvc', 'package.json'), '{}');
    expect((repair as () => unknown)()).toBeNull();
    expect(repairInstallCommand(top, win, reg)).toBeNull();
    // In another directory the step names it; a configured install gets no such step.
    mkdirSync(join(top, 'site'));
    writeFileSync(
      join(top, 'site', 'package-lock.json'),
      JSON.stringify({
        packages: {
          'node_modules/css-win32-x64-msvc': lock.packages['node_modules/css-win32-x64-msvc'],
        },
      }),
    );
    const inSite = installSteps(undefined, top, ['site'], win)[1] as () => unknown;
    const command = `${DEFAULT_INSTALL} css-win32-x64-msvc@1.32.0`;
    expect(inSite()).toEqual({ command, cwd: join(top, 'site'), label: `${command} (in site)` });
    expect(installSteps(['node i.mjs'], top, ['.'], win)).toEqual(['node i.mjs']);
    // No lockfile, an old one without `packages`, or one that does not parse: nothing to do.
    const bare = temp();
    expect(missingOptionalPackages(bare, win)).toEqual([]);
    writeFileSync(join(bare, 'package-lock.json'), '{"lockfileVersion":1,"dependencies":{}}');
    expect(missingOptionalPackages(bare, win)).toEqual([]);
    writeFileSync(join(bare, 'package-lock.json'), 'not json');
    expect(missingOptionalPackages(bare, win)).toEqual([]);
    // npm reads `npm-shrinkwrap.json` first.
    writeFileSync(
      join(bare, 'npm-shrinkwrap.json'),
      JSON.stringify({
        packages: {
          'node_modules/not-aix': optional({ os: ['!aix'] }),
          'node_modules/win': optional({ os: ['win32'] }),
        },
      }),
    );
    expect(missingOptionalPackages(bare, win)).toEqual(['win@1.32.0']);
  });

  it("reads the registry of a scope from npm's configuration (AO-0229)", () => {
    const dir = temp();
    writeFileSync(join(dir, 'package.json'), '{"name":"app"}');
    writeFileSync(
      join(dir, '.npmrc'),
      'registry=https://npm.example.com/all/\n@scope:registry=https://npm.example.com/scope/\n',
    );
    expect(npmRegistry(dir, undefined)).toBe('https://npm.example.com/all/');
    expect(npmRegistry(dir, '@scope')).toBe('https://npm.example.com/scope/');
    expect(npmRegistry(dir, '@other')).toBe('https://npm.example.com/all/');
    // A swarmupd started with `pnpm swarmup` has pnpm's registry in its environment, and npm
    // takes that variable over an `.npmrc` file; the project's own registry still answers (AO-0307).
    const script = {
      ...process.env,
      npm_config_registry: 'https://registry.example.org/',
      npm_config_user_agent: 'pnpm/9.15.4 npm/? node/v22.0.0 win32 x64',
    };
    expect(npmRegistry(dir, undefined, script)).toBe('https://npm.example.com/all/');
    expect(npmRegistry(dir, '@scope', script)).toBe('https://npm.example.com/scope/');
    // A variable a person set for their shell, with no script around it, still wins, as in npm.
    const shell = withoutScriptEnv(process.env);
    shell.npm_config_registry = 'https://registry.example.org/';
    expect(npmRegistry(dir, undefined, shell)).toBe('https://registry.example.org/');
    // The default lookup of `missingOptionalPackages` is this one, in the directory it reads.
    const here = { os: 'win32', cpu: 'x64' };
    const write = (host: string) =>
      writeFileSync(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          packages: {
            'node_modules/pkg': {
              version: '1.0.0',
              optional: true,
              os: ['win32'],
              resolved: `https://${host}/all/pkg/-/pkg-1.0.0.tgz`,
            },
          },
        }),
      );
    write('npm.example.com');
    expect(missingOptionalPackages(dir, here)).toEqual(['pkg@1.0.0']);
    write('example.com');
    expect(missingOptionalPackages(dir, here)).toEqual([]);
    vi.unstubAllEnvs();
  }, 60_000);

  it('runs commands with the environment given for them, with and without the job launcher (AO-0306)', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'env.mjs'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync('env.txt', (process.env.ELECTRON_OVERRIDE_DIST_PATH ?? 'none') + '\\n');\n",
    );
    const base = { ...process.env };
    delete base.ELECTRON_OVERRIDE_DIST_PATH;
    for (const job of process.platform === 'win32' ? [false, true] : [false]) {
      const runner = new CommandRunner(base, { killTree: () => {}, job });
      const own = { ...base, ELECTRON_OVERRIDE_DIST_PATH: 'shared-electron' };
      const first = await runner.runAll(['node env.mjs'], dir, 60_000, undefined, own);
      // The next commands get the runner's own environment again.
      const second = await runner.runAll(['node env.mjs'], dir, 60_000);
      expect([...first, ...second].map((r) => r.ok)).toEqual([true, true]);
    }
    expect(text(join(dir, 'env.txt'))).toBe(
      process.platform === 'win32'
        ? 'shared-electron\nnone\nshared-electron\nnone\n'
        : 'shared-electron\nnone\n',
    );
  }, 60_000);

  it('runs the install entries without NODE_ENV, and the rest with it (AO-0391)', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'env.mjs'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync('env.txt', process.argv[2] + '=' + (process.env.NODE_ENV ?? 'none') + '\\n');\n",
    );
    const base = { ...process.env, NODE_ENV: 'production' };
    const runner = new CommandRunner(base, { killTree: () => {}, job: false });
    const results = await runner.runAll(
      ['node env.mjs install', () => 'node env.mjs repair', 'node env.mjs build'],
      dir,
      60_000,
      undefined,
      undefined,
      2,
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(text(join(dir, 'env.txt'))).toBe('install=none\nrepair=none\nbuild=production\n');
  }, 60_000);

  it('asks a function entry for its command when its turn comes, and skips a null (AO-0229)', async () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'mark.mjs'),
      "import { appendFileSync } from 'node:fs';\nappendFileSync('ran.txt', process.argv[2] + '\\n');\n",
    );
    const steps: string[] = [];
    const runner = new CommandRunner(process.env, { killTree: () => {}, job: false });
    const results = await runner.runAll(
      [
        'node mark.mjs one',
        () => null,
        // Sees what the first command wrote.
        () => (existsSync(join(dir, 'ran.txt')) ? 'node mark.mjs two' : 'node mark.mjs early'),
        'node mark.mjs three',
      ],
      dir,
      60_000,
      (s) => steps.push(`${s.index + 1}/${s.count} ${s.command}${s.result ? ' done' : ''}`),
    );
    expect(text(join(dir, 'ran.txt'))).toBe('one\ntwo\nthree\n');
    // `entry` is the place in the list given, so a skipped entry does not shift the later ones.
    expect(results.map((r) => [r.command, r.ok, r.entry])).toEqual([
      ['node mark.mjs one', true, 0],
      ['node mark.mjs two', true, 2],
      ['node mark.mjs three', true, 3],
    ]);
    expect(steps).toEqual([
      '1/4 node mark.mjs one',
      '1/4 node mark.mjs one done',
      '2/3 node mark.mjs two',
      '2/3 node mark.mjs two done',
      '3/3 node mark.mjs three',
      '3/3 node mark.mjs three done',
    ]);
  });

  it("finds changes to swarmupd's own code and says what makes them live (AO-0156)", () => {
    expect(
      opsdCodeChanges([
        'packages/supervisor/src/supervisor.ts',
        'packages/core/src/workspace.ts',
        'packages/supervisor/test/merge.test.ts',
        'packages/core/README.md',
        'packages/desktop/src/main.ts',
        'docs/supervisor.md',
      ]),
    ).toEqual(['packages/supervisor/src/supervisor.ts', 'packages/core/src/workspace.ts']);
    expect(insideDir('C:/dev/agent-ops', 'C:/dev/agent-ops/packages/supervisor/dist')).toBe(true);
    expect(insideDir('C:/dev/agent-ops', 'C:/Program Files/SwarmUp/resources/app')).toBe(false);
    expect(insideDir('C:/dev/agent-ops', 'C:/dev/agent-ops-2/packages')).toBe(false);
    const o = {
      task: 'AO-0150',
      what: 'ea4cfd5b on branch claude/ao-0150-auth-backoff',
      base: 'v2',
      commit: 'f61d5299aaaa',
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      top: 'C:/dev/agent-ops',
      pid: 1992,
      version: '0.2.0-beta.2',
    };
    const installed = notLiveNotice({ ...o, runs: 'installed', built: true });
    expect(installed).toMatch(
      /^AO-0150: swarmupd merged ea4cfd5b on branch claude\/ao-0150-auth-backoff into `v2` as f61d529, which changes swarmupd's own code \(`a\.ts`, `b\.ts`, `c\.ts` and 1 more\)\. The running swarmupd \(pid 1992, 0\.2\.0-beta\.2\) does not have it yet\./,
    );
    expect(installed).toContain('swarmupd runs the installed app, not `C:/dev/agent-ops`');
    expect(installed).toContain('install a new build of the app');
    expect(notLiveNotice({ ...o, runs: 'checkout', built: true })).toContain(
      'The build in `C:/dev/agent-ops` has it: restart swarmupd with **Restart swarmupd** in the tray',
    );
    expect(notLiveNotice({ ...o, runs: 'checkout', built: false })).toContain(
      'Build `C:/dev/agent-ops` (`npm run build`), then restart swarmupd',
    );
  });

  it("tells the human once when a merge changes swarmupd's own code (AO-0156)", async () => {
    // swarmupd runs from somewhere else, as the installed app does.
    const s = mergeSetup({ self: () => ({ dir: temp(), stamp: () => 'new' }), build: 'old' });
    const pkg = JSON.stringify({ name: '@swarmup/supervisor' });
    mkdirSync(join(s.repo, 'packages', 'supervisor'), { recursive: true });
    s.onMain('packages/supervisor/package.json', pkg);
    expect(isEngineRepo(s.repo)).toBe(true);
    const commit = s.branch('two\n', {
      'packages/supervisor/src/x.ts': 'export const x = 1;\n',
      'packages/supervisor/test/x.test.ts': '// test\n',
    });
    s.approve(commit);
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    const notices = () =>
      s
        .as('human:dawid')
        .channel('general')
        .filter((m) => m.body.includes("changes swarmupd's own code"));
    expect(notices()).toHaveLength(1);
    const n = notices()[0]!;
    expect(n.actor).toBe(MERGE_ACTOR);
    expect(n.mentions).toContain('human:dawid');
    expect(n.task).toBe('T-0001');
    expect(n.body).toMatch(/^T-0001: swarmupd merged [0-9a-f]{7} on branch feature into `main`/);
    expect(n.body).toContain('(`packages/supervisor/src/x.ts`)');
    expect(n.body).not.toContain('x.test.ts');
    expect(n.body).toContain('(pid ');
    expect(n.body).toContain('0.2.0-test');
    expect(n.body).toContain('swarmupd runs the installed app');
    // Once: the next tick says nothing new.
    await s.merged();
    expect(notices()).toHaveLength(1);
  });

  it('says to restart when swarmupd runs from the checkout it just built (AO-0156)', async () => {
    // swarmupd's code is inside the repo it merges into, and the build there wrote a new stamp.
    const s = mergeSetup({
      self: (repo) => ({ dir: join(repo, 'packages', 'supervisor', 'dist'), stamp: () => 'new' }),
      build: 'old',
    });
    mkdirSync(join(s.repo, 'packages', 'supervisor'), { recursive: true });
    s.onMain('packages/supervisor/package.json', JSON.stringify({ name: '@swarmup/supervisor' }));
    s.approve(s.branch('two\n', { 'packages/core/src/y.ts': 'export const y = 1;\n' }));
    await s.merged();
    const body = s
      .as('human:dawid')
      .channel('general')
      .find((m) => m.body.includes("changes swarmupd's own code"))!.body;
    expect(body).toContain(`The build in \`${s.repo}\` has it: restart swarmupd`);
  });

  it('sends no notice for a repo that is not the engine, even with the same folders', async () => {
    const s = mergeSetup({ self: () => ({ dir: temp(), stamp: () => 'new' }), build: 'old' });
    s.approve(s.branch('two\n', { 'packages/supervisor/src/x.ts': 'x\n' }));
    await s.merged();
    expect(s.last()).toMatchObject({ type: 'merge' });
    expect(
      s
        .as('human:dawid')
        .channel('general')
        .some((m) => m.body.includes("changes swarmupd's own code")),
    ).toBe(false);
  });

  it('sends the task back on a conflict and leaves the base alone', async () => {
    const s = mergeSetup();
    const commit = s.branch('two\n');
    const before = s.onMain('code.txt', 'three\n');
    s.approve(commit);
    await s.merged();

    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(text(join(s.repo, 'code.txt'))).toBe('three\n');
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    const v = s.as('human:dawid').view('1');
    expect(v.status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({
      type: 'verdict',
      verdict: 'changes',
      actor: MERGE_ACTOR,
      to: 'fake:engineer',
    });
    expect(e.body).toContain(`swarmupd did not merge ${commit.slice(0, 7)} on branch feature`);
    expect(e.body).toContain(`it conflicts with main (${before.slice(0, 7)}) in \`code.txt\``);
    // The author merges main into the branch instead of rebasing it.
    expect(e.body).toContain('`git merge main`');
    expect(e.body).toContain('The review covers only how you resolved the conflicts');
    // The engineer has it in the inbox.
    expect(
      s
        .as('fake:engineer')
        .inbox()
        .some((i) => i.task.endsWith('1')),
    ).toBe(true);
  });

  it('sends the task back with the output when a check fails', async () => {
    const s = mergeSetup();
    const before = git(s.repo, 'rev-parse', 'main');
    const commit = s.branch('bad\n');
    s.approve(commit);
    await s.merged();

    expect(git(s.repo, 'rev-parse', 'main')).toBe(before);
    expect(existsSync(join(s.repo, 'dist'))).toBe(false);
    expect(s.as('human:dawid').view('1').status).toBe('todo');
    const e = s.last();
    expect(e).toMatchObject({ type: 'verdict', verdict: 'changes', actor: MERGE_ACTOR });
    expect(e.body).toContain('`node check.mjs` failed (exit 1)');
    expect(e.body).toContain('checking bad');
    expect(e.body).toContain('code says bad');
    const log = /Full output: (\S+)/.exec(e.body)?.[1];
    expect(log && text(log)).toContain('code says bad');
  });
});
