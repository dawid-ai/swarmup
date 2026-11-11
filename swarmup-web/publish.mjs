#!/usr/bin/env node
// Publishes the website (swarmup.tech) to its own public repository, dawid-ai/swarmup-web, which
// GitHub Pages serves. The website ships on its own schedule: it never waits for an app release.
//
// 1. Copies the committed tree of this repository without anything marked `export-ignore` in
//    .gitattributes (`git archive` applies the same rules as scripts/export-public.mjs), so the
//    task store, docs/proposals/ and docs/launch/ never reach the website.
// 2. Builds the site from that copy and checks its links, with swarmup-web/build.mjs and the
//    scripts/ it runs, as committed at HEAD of the repository this script lives in. Nothing
//    uncommitted, in the sources or in the build scripts, reaches the output: a checkout with
//    work in progress publishes exactly what its last commit holds.
// 3. Replaces the files of a checkout of the website repository with the build, and commits only
//    when something changed. With --push, pushes the commit.
//
// Usage: node swarmup-web/publish.mjs [--repo DIR] [--remote URL] [--push] [--offline] [--root DIR]
//   --repo    the website checkout; default <this repo>/out/swarmup-web, cloned from --remote when
//             missing. Its own uncommitted changes stop the run.
//   --remote  default https://github.com/dawid-ai/swarmup-web.git
//   --offline passes --offline to the build: the download page then links the releases page.
//   --root    the repository to publish from; default: this one.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This script lives in swarmup-web/, next to build.mjs; the link check is in the repo's scripts/.
const here = dirname(fileURLToPath(import.meta.url));
const self = resolve(here, '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
// The repository whose committed files make the site; default: this one.
const top = resolve(opt('--root', self));
const repo = resolve(opt('--repo', join(top, 'out', 'swarmup-web')));
const remote = opt('--remote', 'https://github.com/dawid-ai/swarmup-web.git');
const push = args.includes('--push');
const offline = args.includes('--offline');

const run = (cmd, a, cwd, input) =>
  execFileSync(cmd, a, {
    cwd,
    encoding: 'utf8',
    input,
    windowsHide: true,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  }).trim();
const git = (cwd, ...a) => run('git', a, cwd);
const fail = (msg, code = 1) => {
  console.error(`web: ${msg}`);
  process.exit(code);
};

if (resolve(repo) === resolve(top)) fail('--repo is this repository', 2);
if (!existsSync(join(repo, '.git'))) {
  mkdirSync(dirname(repo), { recursive: true });
  git(dirname(repo), 'clone', '--quiet', remote, repo);
}
if (git(repo, 'status', '--porcelain'))
  fail(`${repo} has changes of its own; commit or discard them`);
// An empty repository's first commit goes on main, the branch GitHub Pages serves.
if (!git(repo, 'rev-list', '--all', '--max-count=1'))
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
// Pull first, so a commit made elsewhere is never pushed over.
if (push && git(repo, 'branch', '-r')) git(repo, 'pull', '--quiet', '--ff-only');

const head = git(top, 'rev-parse', '--short', 'HEAD');
const work = mkdtempSync(join(tmpdir(), 'swarmup-web-'));
let modules = ''; // the node_modules link inside work
try {
  // The exported tree: git archive leaves out every export-ignore path.
  const src = join(work, 'src');
  mkdirSync(src);
  const tar = join(work, 'tree.tar');
  git(top, 'archive', '--format=tar', '-o', tar, 'HEAD');
  // Relative paths: GNU tar (Git Bash) reads C:\... as a remote host.
  run('tar', ['-xf', 'tree.tar', '-C', 'src'], work);
  // The build scripts, as committed in the repository this script lives in (the same one as
  // --root unless a test points --root elsewhere). They find their packages (marked) through a
  // link to its installed node_modules: dependencies are installed, not edited, source.
  const tools = join(work, 'tools');
  mkdirSync(tools);
  git(
    self,
    'archive',
    '--format=tar',
    '-o',
    join(work, 'tools.tar'),
    'HEAD',
    'scripts',
    'swarmup-web',
  );
  run('tar', ['-xf', 'tools.tar', '-C', 'tools'], work);
  if (existsSync(join(self, 'node_modules'))) {
    modules = join(tools, 'node_modules');
    symlinkSync(join(self, 'node_modules'), modules, 'junction');
  }
  const out = join(work, 'site');
  const build = ['--root', src, '--out', out, ...(offline ? ['--offline'] : [])];
  execFileSync(process.execPath, [join(tools, 'swarmup-web', 'build.mjs'), ...build], {
    cwd: work,
    stdio: 'inherit',
    windowsHide: true,
  });
  execFileSync(process.execPath, [join(tools, 'scripts', 'check-docs-links.mjs'), out], {
    cwd: work,
    stdio: 'inherit',
    windowsHide: true,
  });
  // GitHub Pages serves the files as they are: no Jekyll.
  writeFileSync(join(out, '.nojekyll'), '');
  writeFileSync(
    join(out, 'README.md'),
    '# swarmup.tech\n\nThe built website of [SwarmUp](https://swarmup.tech). Do not edit it here: ' +
      'every file is generated from the SwarmUp repository and replaced on each publish.\n',
  );

  for (const name of readdirSync(repo)) {
    if (name !== '.git') rmSync(join(repo, name), { recursive: true, force: true });
  }
  cpSync(out, repo, { recursive: true });
  git(repo, 'add', '-A');
  if (!git(repo, 'status', '--porcelain')) {
    // A commit an earlier run made without --push still goes out.
    let unpushed = false;
    try {
      unpushed = git(repo, 'rev-list', '--count', '@{upstream}..HEAD') !== '0';
    } catch {
      unpushed = !!git(repo, 'rev-list', '--all', '--max-count=1'); // never pushed at all
    }
    if (push && unpushed) {
      git(repo, 'push', '--quiet', '-u', 'origin', 'HEAD');
      console.log(`web: pushed the build already committed in ${repo}`);
    } else {
      console.log(`web: ${repo} already matches ${head}; nothing to publish`);
    }
  } else {
    git(repo, 'commit', '--quiet', '-m', `Site from ${head}`);
    if (push) {
      git(repo, 'push', '--quiet', '-u', 'origin', 'HEAD');
      console.log(`web: published ${head} to ${remote}`);
    } else {
      console.log(`web: committed ${head} in ${repo}; run again with --push to publish`);
    }
  }
} finally {
  // Unlink first, so removing work can never reach into the linked node_modules.
  if (modules) unlinkSync(modules);
  rmSync(work, { recursive: true, force: true });
}
