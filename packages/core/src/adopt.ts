import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isSeq } from 'yaml';
import type { UserConfig } from './config.js';
import {
  checkRoot,
  daemonKeyIn,
  editUserConfig,
  OLD_ROOT_DIR_NAME,
  readUserConfig,
  ROOT_DIR_NAME,
  rootNameOf,
  sameRoot,
  storeDirIn,
  userConfigPath,
} from './config.js';
import { deleteEnvVars, envVar } from './env.js';
import { assertActor, OpsError } from './ids.js';
import { initRoot, templateAgentIds } from './init.js';
import type { Priority } from './model.js';
import { Workspace } from './workspace.js';

/** What `swarmup adopt` finds in an existing repo. */
export interface RepoSurvey {
  dir: string;
  name: string;
  /** Languages and package ecosystems: `node`, `typescript`, `python`, `rust`, `go` and so on. */
  stacks: string[];
  /** Frameworks and tools named in the manifests: `react`, `vite`, `django`, `mkdocs`. */
  frameworks: string[];
  tests: { runner: string | null; command: string | null; files: number };
  build: string | null;
  lint: string | null;
  /** Docs files and folders at the top of the repo, such as `README.md` and `docs/`. */
  docs: string[];
  /** CI config files, such as `.github/workflows/ci.yml`. */
  ci: string[];
  /** `AGENTS.md` or `CLAUDE.md`, when the repo already has agent instructions. */
  agentDocs: string[];
  /** True when the repo has a data root (`.swarmup/` or the old `.agent-ops/`) already. */
  hasRoot: boolean;
}

export interface PlannedTask {
  title: string;
  body: string;
  priority: Priority;
  /** Indexes of earlier tasks in the same plan that must close first. */
  after?: number[];
}

export interface PlannedAgent {
  id: string;
  why: string;
}

/** A project root to create: its name, id prefix, agent roles and first tasks. */
export interface ProjectPlan {
  name: string;
  prefix: string;
  agents: PlannedAgent[];
  tasks: PlannedTask[];
}

export interface ApplyOptions {
  human?: string;
  /** Acting id that creates the tasks; default `SWARMUP_AGENT`, then the user config's `me`. */
  actor?: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
  /**
   * A folder outside the repo for the store, so a public repo's tasks stay private. Default: the
   * store is `.swarmup/` inside the repo.
   */
  store?: string;
}

export interface AppliedPlan {
  dir: string;
  agents: string[];
  /** Created tasks; `proposed` says why a task became a finding instead (AO-0107). */
  tasks: { id: string; title: string; proposed?: string }[];
}

/** Folders a survey never walks into. */
const SKIP_DIRS = new Set([
  '.git',
  ROOT_DIR_NAME,
  OLD_ROOT_DIR_NAME,
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
]);

/** How deep and how wide the test file count looks, so a huge repo surveys in well under a second. */
const WALK_DEPTH = 5;
const WALK_LIMIT = 20_000;

const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^test_.*\.py$)|(_test\.(py|go)$)|(Tests?\.(cs|java|kt)$)|(_spec\.rb$)/;

/** Manifest dependencies that name a framework worth a role or a task. */
const NODE_FRAMEWORKS: Record<string, string> = {
  react: 'react',
  next: 'next',
  vue: 'vue',
  nuxt: 'nuxt',
  svelte: 'svelte',
  '@sveltejs/kit': 'sveltekit',
  'solid-js': 'solid',
  '@angular/core': 'angular',
  vite: 'vite',
  electron: 'electron',
  express: 'express',
  fastify: 'fastify',
  koa: 'koa',
  hono: 'hono',
  '@nestjs/core': 'nest',
  astro: 'astro',
  '@docusaurus/core': 'docusaurus',
  vitepress: 'vitepress',
  '@11ty/eleventy': 'eleventy',
};

const NODE_TEST_RUNNERS = ['vitest', 'jest', 'mocha', 'ava', '@playwright/test', 'cypress'];

const PY_FRAMEWORKS = ['django', 'flask', 'fastapi', 'mkdocs', 'sphinx', 'streamlit'];

const UI_FRAMEWORKS = new Set([
  'react',
  'next',
  'vue',
  'nuxt',
  'svelte',
  'sveltekit',
  'solid',
  'angular',
  'electron',
]);
const SERVER_FRAMEWORKS = new Set([
  'express',
  'fastify',
  'koa',
  'hono',
  'nest',
  'django',
  'flask',
  'fastapi',
]);
const DOCS_FRAMEWORKS = new Set([
  'astro',
  'docusaurus',
  'vitepress',
  'eleventy',
  'mkdocs',
  'sphinx',
  'hugo',
  'jekyll',
]);

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function record(v: unknown): Record<string, string> {
  return v && typeof v === 'object' ? (v as Record<string, string>) : {};
}

/** Counts test files under `dir`, bounded by depth and entry count. */
function countTests(dir: string): number {
  let files = 0;
  let seen = 0;
  const walk = (d: string, depth: number, inTests: boolean): void => {
    if (depth > WALK_DEPTH || seen > WALK_LIMIT) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        walk(join(d, e.name), depth + 1, inTests || /^(tests?|__tests__|spec)$/.test(e.name));
      } else if (e.isFile()) {
        if (TEST_FILE.test(e.name)) files++;
        else if (inTests && /\.(py|[cm]?[jt]sx?|rb|go|rs)$/.test(e.name)) files++;
      }
    }
  };
  walk(dir, 0, false);
  return files;
}

/** A repo name as a project name: the folder name, or the package name without its scope. */
function repoName(dir: string, pkg: Record<string, unknown> | null): string {
  const fromPkg = typeof pkg?.name === 'string' ? pkg.name.replace(/^@[^/]+\//, '') : '';
  return fromPkg || basename(dir);
}

/**
 * Surveys a repo without changing it: languages, frameworks, tests, docs and CI, from the
 * manifests at its top and a bounded walk for test files.
 */
export function surveyRepo(target: string): RepoSurvey {
  const dir = resolve(target);
  if (!isDir(dir)) throw new OpsError(`${dir} is not a folder`, 2);
  const has = (f: string): boolean => existsSync(join(dir, f));
  const stacks = new Set<string>();
  const frameworks = new Set<string>();
  let runner: string | null = null;
  let testCmd: string | null = null;
  let build: string | null = null;
  let lint: string | null = null;

  const pkg = readJson(join(dir, 'package.json'));
  if (pkg) {
    stacks.add('node');
    const deps = { ...record(pkg.dependencies), ...record(pkg.devDependencies) };
    if (has('tsconfig.json') || 'typescript' in deps) stacks.add('typescript');
    for (const [dep, fw] of Object.entries(NODE_FRAMEWORKS)) if (dep in deps) frameworks.add(fw);
    runner =
      NODE_TEST_RUNNERS.find((r) => r in deps)?.replace(/^@playwright\/test$/, 'playwright') ??
      null;
    const scripts = record(pkg.scripts);
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const script = (name: string): string | null => {
      if (!scripts[name]) return null;
      return name === 'test' && pm !== 'yarn' ? `${pm} test` : `${pm} run ${name}`;
    };
    const placeholder = /no test specified/.test(scripts.test ?? '');
    testCmd = placeholder ? null : script('test');
    build = script('build');
    lint = script('lint');
  }

  const pyproject = readText(join(dir, 'pyproject.toml'));
  const requirements = readText(join(dir, 'requirements.txt'));
  if (pyproject || requirements || has('setup.py')) {
    stacks.add('python');
    const text = `${pyproject}\n${requirements}`.toLowerCase();
    for (const fw of PY_FRAMEWORKS) if (new RegExp(`\\b${fw}\\b`).test(text)) frameworks.add(fw);
    if (/\bpytest\b/.test(text) || has('pytest.ini') || has('conftest.py')) {
      runner ??= 'pytest';
      testCmd ??= 'pytest';
    }
    if (/\bruff\b/.test(text)) lint ??= 'ruff check .';
  }
  if (has('mkdocs.yml')) frameworks.add('mkdocs');
  if (has('Cargo.toml')) {
    stacks.add('rust');
    runner ??= 'cargo test';
    testCmd ??= 'cargo test';
    build ??= 'cargo build';
    lint ??= 'cargo clippy';
  }
  if (has('go.mod')) {
    stacks.add('go');
    runner ??= 'go test';
    testCmd ??= 'go test ./...';
    build ??= 'go build ./...';
    lint ??= 'go vet ./...';
  }
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) stacks.add('java');
  if (readdirSafe(dir).some((f) => /\.(sln|csproj)$/.test(f))) stacks.add('dotnet');
  if (has('Gemfile')) stacks.add('ruby');
  if (has('composer.json')) stacks.add('php');
  if (has('hugo.toml') || (has('config.toml') && has('content'))) frameworks.add('hugo');
  if (has('_config.yml') && has('_posts')) frameworks.add('jekyll');

  const docs = ['README.md', 'README', 'README.rst', 'CONTRIBUTING.md', 'CHANGELOG.md']
    .filter(has)
    .concat(['docs', 'doc'].filter((d) => isDir(join(dir, d))).map((d) => `${d}/`));
  const ci: string[] = [];
  const workflows = join(dir, '.github', 'workflows');
  for (const f of readdirSafe(workflows)) {
    if (/\.ya?ml$/.test(f)) ci.push(`.github/workflows/${f}`);
  }
  for (const f of ['.gitlab-ci.yml', 'azure-pipelines.yml', '.circleci/config.yml']) {
    if (has(f)) ci.push(f);
  }
  return {
    dir,
    name: repoName(dir, pkg),
    stacks: [...stacks],
    frameworks: [...frameworks],
    tests: { runner, command: testCmd, files: countTests(dir) },
    build,
    lint,
    docs,
    ci,
    agentDocs: ['AGENTS.md', 'CLAUDE.md'].filter(has),
    hasRoot: has(join(ROOT_DIR_NAME, 'config.yml')) || has(join(OLD_ROOT_DIR_NAME, 'config.yml')),
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * An id prefix from a project name: the initials of a name with several words (`my-web-app` is
 * `MWA`), or the first three letters of one word (`billing` is `BIL`).
 */
export function prefixFor(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const first = words[0] ?? '';
  let p =
    words.length > 1
      ? words
          .map((w) => w[0])
          .join('')
          .slice(0, 4)
      : first.slice(0, 3);
  p = p.replace(/^[0-9]+/, '');
  return /^[A-Z][A-Z0-9]*$/.test(p) ? p : 'T';
}

/** The one-line stack summary of a survey, such as `node, typescript; react, vite`. */
export function stackLine(s: RepoSurvey): string {
  const parts = [s.stacks.join(', '), s.frameworks.join(', ')].filter(Boolean);
  return parts.join('; ') || 'unknown';
}

/** Proposes a project root for a surveyed repo: roles that fit its stack and first tasks. */
export function adoptPlan(
  s: RepoSurvey,
  opts: { name?: string; prefix?: string } = {},
): ProjectPlan {
  const name = opts.name ?? s.name;
  const fw = new Set(s.frameworks);
  const ui = [...fw].filter((f) => UI_FRAMEWORKS.has(f));
  const server = [...fw].filter((f) => SERVER_FRAMEWORKS.has(f));
  const docsTools = [...fw].filter((f) => DOCS_FRAMEWORKS.has(f));
  const agents: PlannedAgent[] = [];
  if (ui.length) agents.push({ id: 'cursor:frontend', why: `UI code (${ui.join(', ')})` });
  if (
    server.length ||
    (!ui.length && s.stacks.some((x) => ['python', 'go', 'rust', 'java', 'dotnet'].includes(x)))
  ) {
    const why = server.length
      ? `server code (${server.join(', ')})`
      : `${s.stacks.join(', ')} code`;
    agents.push({ id: 'codex:backend', why });
  }
  agents.push({
    id: 'claude:qa',
    why: s.tests.files ? `${s.tests.files} test files to keep green` : 'no tests yet',
  });
  if (docsTools.length || s.docs.some((d) => d.endsWith('/'))) {
    const why = docsTools.length ? `docs site (${docsTools.join(', ')})` : 'a docs folder';
    agents.push({ id: 'claude:docs', why });
  }
  if (s.ci.length) agents.push({ id: 'claude:release', why: `CI to keep working (${s.ci[0]})` });

  const commands = [
    s.stacks.includes('node') ? 'install the dependencies' : null,
    s.build ? `\`${s.build}\`` : null,
    s.tests.command ? `\`${s.tests.command}\`` : null,
    s.lint ? `\`${s.lint}\`` : null,
  ].filter(Boolean);
  const tasks: PlannedTask[] = [
    {
      title: `Record the baseline: build and test ${name}`,
      priority: 'p2',
      body: [
        `Find out what works in ${name} today, before anyone changes it.`,
        '',
        `- Run ${commands.length ? commands.join(', ') : 'the build and the tests (none found by `swarmup adopt`)'}.`,
        '- Write what passes, what fails and how long each step takes in a checkpoint.',
        '- File each failure as a finding with `swarmup finding`; fix none of them here.',
      ].join('\n'),
    },
  ];
  if (!s.agentDocs.length) {
    tasks.push({
      title: `Write AGENTS.md for ${name}`,
      priority: 'p2',
      after: [0],
      body: [
        'Agents need the rules and commands of this repo in one place.',
        '',
        '- How to install, build, test and lint, from the baseline task.',
        '- Code conventions, branch and commit rules, and what never to touch.',
        '- Keep it under a page; link to existing docs instead of copying them.',
      ].join('\n'),
    });
  }
  if (!s.tests.files) {
    tasks.push({
      title: s.tests.runner
        ? `Write the first tests with ${s.tests.runner}`
        : 'Add a test runner and the first tests',
      priority: 'p2',
      after: [0],
      body: [
        `\`swarmup adopt\` found no test files in ${name}.`,
        '',
        s.tests.runner
          ? `- Use ${s.tests.runner}, which the repo already lists.`
          : `- Pick the usual runner for ${s.stacks.join(', ') || 'the stack'} and say why.`,
        '- Cover the main entry point or the most used module first.',
        '- Make the test command one line and name it in `AGENTS.md`.',
      ].join('\n'),
    });
  }
  if (!s.docs.some((d) => d.startsWith('README'))) {
    tasks.push({
      title: `Write a README for ${name}`,
      priority: 'p3',
      after: [0],
      body: 'What the project is, how to run it, and how to test it, in that order.',
    });
  }
  if (!s.ci.length) {
    tasks.push({
      title: 'Run the build and tests in CI',
      priority: 'p3',
      after: [0],
      body: [
        `\`swarmup adopt\` found no CI config in ${name}.`,
        '',
        '- Add a workflow that runs the build, the tests and the linter on each push and pull request.',
        '- Use the commands from the baseline task.',
      ].join('\n'),
    });
  }
  if (!s.lint && s.stacks.length) {
    tasks.push({
      title: 'Add a linter and a formatter',
      priority: 'p3',
      after: [0],
      body: `Pick the usual tools for ${s.stacks.join(', ')}, add one command for each, and fix or silence what they flag in the first run.`,
    });
  }
  return { name, prefix: (opts.prefix ?? prefixFor(name)).toUpperCase(), agents, tasks };
}

/** A starter for `swarmup new-project`: files for the repo, roles and first tasks. */
export interface ProjectTemplate {
  id: string;
  description: string;
  agents: PlannedAgent[];
  /** Repo files by path; `{{name}}` becomes the project name. */
  files: Record<string, string>;
  tasks: PlannedTask[];
}

const AGENTS_MD = `# Instructions for agents working on {{name}}

SwarmUp tracks the work on this repo in \`.swarmup/\`. Use the \`swarmup\` command; never edit task
files by hand.

## Rules

- Work on a branch per task and name the task id in commits and pull requests.
- Add a test for each behavior change.
- No secrets in code, commits, tasks or logs.

## Commands

The first task picks the stack and fills in how to install, build, test and lint here.
`;

const GITIGNORE = `node_modules/
dist/
build/
coverage/
.env
.env.*
.DS_Store
`;

function readme(title: string, what: string): string {
  return `# {{name}}\n\n${what}\n\n## ${title}\n\nThe first tasks in \`.swarmup/\` set this up. Run \`swarmup list\` to see them.\n`;
}

/** The templates `swarmup new-project` starts from. */
export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'web-app',
    description: 'a web app with a UI, a server side and tests',
    agents: [
      { id: 'cursor:frontend', why: 'pages and components' },
      { id: 'codex:backend', why: 'APIs and data' },
      { id: 'claude:designer', why: 'layouts and visual design' },
      { id: 'claude:qa', why: 'tests and checks' },
    ],
    files: {
      'README.md': readme('Run it', 'A web app.'),
      'AGENTS.md': AGENTS_MD,
      '.gitignore': GITIGNORE,
    },
    tasks: [
      {
        title: 'Pick the stack and scaffold {{name}}',
        priority: 'p1',
        body: [
          'Choose the framework, language and package manager, scaffold the app, and get a page and one test running.',
          '',
          '- Recommend one stack and say why in the review; ask the human only when the choice costs money or needs an account.',
          '- Fill in the commands in `AGENTS.md` and the run steps in `README.md`.',
        ].join('\n'),
      },
      {
        title: 'Run the build and tests in CI',
        priority: 'p2',
        after: [0],
        body: 'Add a workflow that runs the build, the tests and the linter on each push and pull request.',
      },
      {
        title: 'Build the first page of {{name}}',
        priority: 'p2',
        after: [0],
        body: 'The page the app opens on, with its layout, empty state and a test. Agree the layout with the designer first.',
      },
      {
        title: 'Plan where {{name}} runs',
        priority: 'p3',
        after: [0],
        body: 'Compare two or three hosts, with cost and setup steps, and ask the human to pick one. Create no accounts.',
      },
    ],
  },
  {
    id: 'library',
    description: 'a package other code imports, with tests, docs and releases',
    agents: [
      { id: 'codex:backend', why: 'the library code' },
      { id: 'claude:qa', why: 'tests and checks' },
      { id: 'claude:docs', why: 'API docs and examples' },
      { id: 'claude:release', why: 'versions and changelogs' },
    ],
    files: {
      'README.md': readme('Use it', 'A library.'),
      'AGENTS.md': AGENTS_MD,
      '.gitignore': GITIGNORE,
    },
    tasks: [
      {
        title: 'Pick the language and scaffold {{name}}',
        priority: 'p1',
        body: [
          'Choose the language, build tool and test runner, scaffold the package, and get one exported function with a test.',
          '',
          '- Recommend one setup and say why in the review.',
          '- Fill in the commands in `AGENTS.md`.',
        ].join('\n'),
      },
      {
        title: 'Sketch the public API of {{name}}',
        priority: 'p2',
        after: [0],
        body: 'The exported names, their types and one example each, as a doc for the human to approve before the code grows.',
      },
      {
        title: 'Run the build and tests in CI',
        priority: 'p2',
        after: [0],
        body: 'Add a workflow that runs the build, the tests and the linter on each push and pull request.',
      },
      {
        title: 'Set up versions and the changelog',
        priority: 'p3',
        after: [0],
        body: 'Pick the versioning scheme and the changelog format, and write the release steps. Publish nothing; publishing needs the human.',
      },
    ],
  },
  {
    id: 'docs-site',
    description: 'a documentation or content site',
    agents: [
      { id: 'claude:docs', why: 'pages and structure' },
      { id: 'claude:writer', why: 'long-form content' },
      { id: 'claude:designer', why: 'theme and layout' },
    ],
    files: {
      'README.md': readme('Write and preview', 'A docs site.'),
      'AGENTS.md': AGENTS_MD,
      '.gitignore': GITIGNORE,
    },
    tasks: [
      {
        title: 'Pick the site generator and scaffold {{name}}',
        priority: 'p1',
        body: [
          'Choose the generator, scaffold the site, and get a home page building and previewing locally.',
          '',
          '- Recommend one generator and say why in the review.',
          '- Fill in the commands in `AGENTS.md` and the preview steps in `README.md`.',
        ].join('\n'),
      },
      {
        title: 'Outline the pages of {{name}}',
        priority: 'p2',
        body: 'The sections and pages, with one line each on who reads it and why, for the human to approve.',
      },
      {
        title: 'Check the build and links in CI',
        priority: 'p2',
        after: [0],
        body: 'Add a workflow that builds the site and fails on broken links on each push and pull request.',
      },
      {
        title: 'Plan where {{name}} is published',
        priority: 'p3',
        after: [0],
        body: 'Compare two or three hosts, with cost and setup steps, and ask the human to pick one. Publish nothing.',
      },
    ],
  },
];

export function projectTemplate(id: string): ProjectTemplate {
  const t = PROJECT_TEMPLATES.find((x) => x.id === id);
  if (!t) {
    const ids = PROJECT_TEMPLATES.map((x) => x.id).join(', ');
    throw new OpsError(`no project template '${id}': use ${ids}`, 2);
  }
  return t;
}

function fill(text: string, name: string): string {
  return text.replaceAll('{{name}}', name);
}

/** The plan `swarmup new-project` applies: the template's roles and tasks, named for the project. */
export function templatePlan(t: ProjectTemplate, name: string, prefix?: string): ProjectPlan {
  return {
    name,
    prefix: (prefix ?? prefixFor(name)).toUpperCase(),
    agents: t.agents,
    tasks: t.tasks.map((x) => ({ ...x, title: fill(x.title, name), body: fill(x.body, name) })),
  };
}

/**
 * Throws when `applyPlan` would stop partway: no acting id, a bad prefix or human id, or a role
 * with no template. Runs before anything is written.
 */
function checkPlan(dir: string, plan: ProjectPlan, opts: ApplyOptions): void {
  new Workspace({ cwd: dir, env: opts.env, actor: opts.actor }).requireActor();
  if (!/^[A-Z][A-Z0-9]*$/.test(plan.prefix))
    throw new OpsError(`bad id prefix '${plan.prefix}'`, 2);
  if (opts.human) assertActor(opts.human, 'human');
  const known = new Set(templateAgentIds());
  const missing = plan.agents.filter((a) => !known.has(a.id)).map((a) => a.id);
  if (missing.length) throw new OpsError(`no role template for ${missing.join(', ')}`, 2);
}

/**
 * Creates the project root a plan describes: `.swarmup/` in `repo`, or in `opts.store` when the
 * store lives apart from the repo, with the plan's agent roles, then its tasks in order, each
 * blocked by the earlier tasks it names. Tasks go through `Workspace.addTask`, so an agent's
 * tasks become findings that wait for the human (AO-0107).
 */
export function applyPlan(repo: string, plan: ProjectPlan, opts: ApplyOptions = {}): AppliedPlan {
  const dir = opts.store ? resolve(opts.store) : repo;
  const env = { ...(opts.env ?? process.env) };
  // The new root is the one found from `dir`; a root picked by SWARMUP_ROOT would take the tasks.
  deleteEnvVars(env, ['ROOT']);
  const actor = opts.actor ?? envVar(env, 'AGENT');
  checkPlan(dir, plan, { ...opts, env, actor });
  const root = initRoot(dir, {
    name: plan.name,
    prefix: plan.prefix,
    human: opts.human,
    agents: plan.agents.map((a) => a.id),
  });
  const ws = new Workspace({ cwd: dir, env, actor, root: plan.name, force: opts.force });
  if (resolve(ws.defaultRoot().dir) !== resolve(root)) {
    throw new OpsError(
      `created ${root}, but ${ws.defaultRoot().dir} is the root found from ${dir}`,
    );
  }
  const ids: string[] = [];
  const tasks: AppliedPlan['tasks'] = [];
  for (const t of plan.tasks) {
    const blockedBy = (t.after ?? []).map((i) => ids[i]).filter((x): x is string => Boolean(x));
    const res = ws.addTask({
      title: t.title,
      body: t.body,
      priority: t.priority,
      project: plan.name,
      blockedBy: blockedBy.length ? blockedBy : undefined,
    });
    ids.push(res.meta.id);
    tasks.push({ id: res.meta.id, title: res.meta.title, proposed: res.proposed });
  }
  return { dir: root, agents: plan.agents.map((a) => a.id), tasks };
}

/** True inside a git work tree. */
export function inGitRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** The branch checked out in `dir`; null outside a git work tree or on a detached HEAD. */
export function currentBranch(dir: string): string | null {
  try {
    const out = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: dir,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** True when `inner` is `outer` or a folder inside it. */
function within(outer: string, inner: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A plan with only the tasks at `keep` (indexes into `plan.tasks`), their `after` renumbered. */
export function keepTasks(plan: ProjectPlan, keep: number[]): ProjectPlan {
  const kept = [...new Set(keep)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < plan.tasks.length)
    .sort((a, b) => a - b);
  const at = new Map(kept.map((old, now) => [old, now]));
  const tasks = kept.map((i) => {
    const t = plan.tasks[i]!;
    const after = (t.after ?? []).flatMap((a) => at.get(a) ?? []);
    return { ...t, after: after.length ? after : undefined };
  });
  return { ...plan, tasks };
}

/** The code checkout of a root whose store is a folder of its own, for the user config. */
export interface CodeCheckout {
  /** The root's name, the key under `swarmupd.code` and `swarmupd.merge`. */
  name: string;
  /** The code repo. */
  checkout: string;
  /** The branch approved work merges into. */
  base: string;
}

export interface AddedRoot {
  /** The user config file. */
  path: string;
  /** The root as `roots` lists it: the folder that holds `.swarmup/`. */
  root: string;
  /** The name in the root's config. */
  name: string | null;
  /** False when `roots` listed it already. */
  added: boolean;
}

/**
 * Adds a data root to `roots` in the user config, keeping comments and every other key. With
 * `code`, also names the root's code checkout: `swarmupd.code.<name>`, and `swarmupd.merge.<name>`
 * with `base` and `checkout`. `check` sees the result before it is written and throws to refuse it.
 */
export function addRootToUserConfig(
  env: NodeJS.ProcessEnv,
  root: string,
  code?: CodeCheckout,
  check?: (next: UserConfig) => void,
): AddedRoot {
  const r = checkRoot(root);
  const path = userConfigPath(env);
  const name = rootNameOf(storeDirIn(r) ?? r);
  const listed = (readUserConfig(env).roots ?? []).map(String).some((x) => sameRoot(x, r));
  if (listed && !code) return { path, root: r, name, added: false };
  editUserConfig(
    env,
    (doc) => {
      if (!listed) {
        if (isSeq(doc.get('roots', true))) doc.addIn(['roots'], r);
        else doc.set('roots', [r]);
      }
      if (code) {
        const key = daemonKeyIn(doc);
        doc.setIn([key, 'code', code.name], code.checkout);
        doc.setIn([key, 'merge', code.name, 'base'], code.base);
        doc.setIn([key, 'merge', code.name, 'checkout'], code.checkout);
      }
    },
    check,
  );
  return { path, root: r, name, added: !listed };
}

/**
 * Checks a folder for the store of `repo`, apart from it: the repo has a branch checked out (the
 * one approved work merges into, returned), and the folder is outside the repo and holds no data
 * root. Throws otherwise; writes nothing.
 */
export function checkStoreFolder(repo: string, store: string): string {
  if (!inGitRepo(repo)) {
    throw new OpsError(`${repo} is not a git repo: run \`git init\` there first`, 2);
  }
  const base = currentBranch(repo);
  if (!base) {
    throw new OpsError(
      `${repo} has no branch checked out: check out the branch approved work merges into`,
      2,
    );
  }
  if (within(repo, store) || within(store, repo)) {
    throw new OpsError(`${store}: pick a folder outside the repo for the tasks`, 2);
  }
  if (existsSync(store) && !isDir(store)) throw new OpsError(`${store} is a file`, 2);
  if (storeDirIn(store)) throw new OpsError(`${store} has a data root already`, 2);
  return base;
}

export interface AdoptOptions extends ApplyOptions {
  name?: string;
  prefix?: string;
  /** Role templates to use instead of the proposed ones. */
  agents?: string[];
  /** Indexes of the proposed tasks to create; default all of them. */
  tasks?: number[];
  /**
   * Add the new root to `roots` in the user config. Always on with `store`, whose code checkout
   * the user config has to name.
   */
  register?: boolean;
  /** Refuse a folder outside a git repo, as the app does: runs work in git worktrees. */
  requireGit?: boolean;
  /** Sees the user config before it is written and throws to refuse it. */
  checkConfig?: (next: UserConfig) => void;
}

export interface AdoptedProject extends AppliedPlan {
  /** The adopted repo. */
  repo: string;
  name: string;
  /** The folder that holds `.swarmup/` when the store lives apart from the repo. */
  store: string | null;
  /** With `store`: the branch approved work merges into. */
  base: string | null;
  /** True when the store folder was outside any git repo and got `git init`. */
  gitInit: boolean;
  /** The user config file, when the root was added to it. */
  config: string | null;
}

/** The plan `adoptRepo` applies for a survey: the proposal, with the options' changes. */
export function adoptProposal(s: RepoSurvey, opts: AdoptOptions = {}): ProjectPlan {
  const plan = adoptPlan(s, { name: opts.name, prefix: opts.prefix });
  if (opts.agents?.length) {
    plan.agents = opts.agents.map((id) => ({ id, why: 'chosen with --agents' }));
  }
  return opts.tasks ? keepTasks(plan, opts.tasks) : plan;
}

/**
 * Adopts an existing repo, the one code path of `swarmup adopt --apply` and the app's
 * **Add project**: surveys it, creates the project root with its roles and first tasks, and
 * with `register` or `store` adds the root to the user config. Everything that can be checked
 * is checked before the first write.
 */
export function adoptRepo(target: string, opts: AdoptOptions = {}): AdoptedProject {
  const env = opts.env ?? process.env;
  const survey = surveyRepo(target);
  const repo = survey.dir;
  if (survey.hasRoot) {
    throw new OpsError(`${repo} has a data root already; swarmup adopt starts new ones`, 1);
  }
  const plan = adoptProposal(survey, opts);
  const store = opts.store ? resolve(opts.store) : null;
  const register = Boolean(opts.register || store);
  let base: string | null = null;
  if (opts.requireGit && !inGitRepo(repo)) {
    throw new OpsError(`${repo} is not a git repo: run \`git init\` there first`, 2);
  }
  if (store) base = checkStoreFolder(repo, store);
  if (register) {
    // Reading it now refuses a config that does not parse before anything is written.
    const user = readUserConfig(env);
    for (const r of [...(user.roots ?? []), ...(user.master ? [user.master] : [])]) {
      const dir = resolve(String(r));
      if (rootNameOf(storeDirIn(dir) ?? dir) === plan.name) {
        throw new OpsError(
          `a data root named '${plan.name}' is loaded already (${r}): pick another name`,
          2,
        );
      }
    }
  }
  let gitInit = false;
  let applied: AppliedPlan;
  try {
    if (store) {
      mkdirSync(store, { recursive: true });
      gitInit = !inGitRepo(store);
      if (gitInit) {
        execFileSync('git', ['init', '-q'], { cwd: store, windowsHide: true, stdio: 'ignore' });
      }
    }
    applied = applyPlan(repo, plan, { ...opts, store: store ?? undefined });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new OpsError(`no write access to ${store ?? repo}: ${(err as Error).message}`, 1);
    }
    throw err;
  }
  let config: string | null = null;
  if (register) {
    try {
      config = addRootToUserConfig(
        env,
        applied.dir,
        store && base ? { name: plan.name, checkout: repo, base } : undefined,
        opts.checkConfig,
      ).path;
    } catch (err) {
      throw new OpsError(
        `created ${applied.dir}, but the user config was not changed: ${(err as Error).message}`,
        1,
      );
    }
  }
  return { ...applied, repo, name: plan.name, store, base, gitInit, config };
}

export interface NewProjectOptions extends ApplyOptions {
  name?: string;
  prefix?: string;
}

export interface NewProject extends AppliedPlan {
  /** The project folder. */
  project: string;
  /** Repo files the template wrote, relative to the project folder. */
  files: string[];
  /** True when the folder was outside any git repo and got `git init`. */
  gitInit: boolean;
}

/**
 * Starts a project from a template in `target`, which must be missing or empty: the template's
 * files, `git init` when the folder is outside a repo, and a project root with its roles and
 * first tasks.
 */
export function newProject(
  target: string,
  templateId: string,
  opts: NewProjectOptions = {},
): NewProject {
  const t = projectTemplate(templateId);
  const project = resolve(target);
  if (existsSync(project)) {
    if (!isDir(project)) throw new OpsError(`${project} is a file`, 2);
    if (readdirSafe(project).length > 0) {
      throw new OpsError(`${project} is not empty: use \`swarmup adopt\` for an existing repo`, 2);
    }
  }
  const name = opts.name ?? basename(project);
  const plan = templatePlan(t, name, opts.prefix);
  // Refuse a bad actor, prefix or human before the folder is made.
  checkPlan(dirname(project), plan, opts);
  mkdirSync(project, { recursive: true });
  const gitInit = !inGitRepo(project);
  if (gitInit) {
    execFileSync('git', ['init', '-q'], { cwd: project, windowsHide: true, stdio: 'ignore' });
  }
  const files = Object.keys(t.files);
  for (const f of files) {
    mkdirSync(dirname(join(project, f)), { recursive: true });
    writeFileSync(join(project, f), fill(t.files[f]!, name));
  }
  const applied = applyPlan(project, plan, opts);
  return { ...applied, project, files, gitInit };
}
