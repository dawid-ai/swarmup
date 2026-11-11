import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adoptPlan,
  applyPlan,
  newProject,
  prefixFor,
  PROJECT_TEMPLATES,
  surveyRepo,
  templateAgentIds,
  Workspace,
} from '../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-adopt-'));
  dirs.push(d);
  return d;
}

function env(dir: string): NodeJS.ProcessEnv {
  return { SWARMUP_CONFIG: join(dir, 'none.yml') };
}

function write(dir: string, files: Record<string, string>): void {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

/** A small React and Express repo with vitest tests, a README and a CI workflow. */
function webRepo(): string {
  const d = tmp();
  write(d, {
    'package.json': JSON.stringify({
      name: '@acme/shop-front',
      scripts: { build: 'vite build', test: 'vitest run', lint: 'eslint .' },
      dependencies: { react: '^19', express: '^5' },
      devDependencies: { vite: '^7', vitest: '^4', typescript: '^5' },
    }),
    'tsconfig.json': '{}',
    'README.md': '# shop\n',
    'docs/guide.md': '# guide\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'src/cart.ts': 'export {};\n',
    'src/cart.test.ts': 'test\n',
    'node_modules/dep/x.test.js': 'not counted\n',
  });
  return d;
}

describe('surveyRepo', () => {
  it('finds the stack, tests, docs and CI of a node repo', () => {
    const s = surveyRepo(webRepo());
    expect(s.name).toBe('shop-front');
    expect(s.stacks).toEqual(['node', 'typescript']);
    expect(s.frameworks).toEqual(expect.arrayContaining(['react', 'express', 'vite']));
    expect(s.tests).toEqual({ runner: 'vitest', command: 'npm test', files: 1 });
    expect(s.build).toBe('npm run build');
    expect(s.lint).toBe('npm run lint');
    expect(s.docs).toEqual(['README.md', 'docs/']);
    expect(s.ci).toEqual(['.github/workflows/ci.yml']);
    expect(s.hasRoot).toBe(false);
  });

  it('finds a python repo with pytest and tests in a tests folder', () => {
    const d = tmp();
    write(d, {
      'pyproject.toml': '[project]\nname = "ledger"\ndependencies = ["fastapi"]\n[tool.pytest]\n',
      'tests/test_api.py': '',
      'tests/helpers.py': '',
    });
    const s = surveyRepo(d);
    expect(s.stacks).toEqual(['python']);
    expect(s.frameworks).toEqual(['fastapi']);
    expect(s.tests).toEqual({ runner: 'pytest', command: 'pytest', files: 2 });
  });

  it('ignores the npm placeholder test script', () => {
    const d = tmp();
    write(d, {
      'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified"' } }),
    });
    expect(surveyRepo(d).tests.command).toBeNull();
  });
});

describe('adoptPlan', () => {
  it('proposes roles that fit the stack and skips tasks the repo needs no longer', () => {
    const plan = adoptPlan(surveyRepo(webRepo()));
    expect(plan.prefix).toBe('SF');
    expect(plan.agents.map((a) => a.id)).toEqual([
      'cursor:frontend',
      'codex:backend',
      'claude:qa',
      'claude:docs',
      'claude:release',
    ]);
    expect(plan.tasks.map((t) => t.title)).toEqual([
      'Record the baseline: build and test shop-front',
      'Write AGENTS.md for shop-front',
    ]);
    expect(plan.tasks[0]!.body).toContain('`npm test`');
  });

  it('proposes tests, a README, CI and a linter for a bare repo', () => {
    const d = tmp();
    write(d, { 'go.mod': 'module x\n', 'main.go': 'package main\n' });
    const plan = adoptPlan(surveyRepo(d), { name: 'billing' });
    expect(plan.prefix).toBe('BIL');
    expect(plan.agents.map((a) => a.id)).toEqual(['codex:backend', 'claude:qa']);
    expect(plan.tasks.map((t) => t.title)).toEqual([
      'Record the baseline: build and test billing',
      'Write AGENTS.md for billing',
      'Write the first tests with go test',
      'Write a README for billing',
      'Run the build and tests in CI',
    ]);
  });

  it('only names role templates that exist', () => {
    const known = new Set(templateAgentIds());
    const ids = [
      ...adoptPlan(surveyRepo(webRepo())).agents,
      ...PROJECT_TEMPLATES.flatMap((t) => t.agents),
    ].map((a) => a.id);
    expect(ids.filter((id) => !known.has(id))).toEqual([]);
  });
});

describe('prefixFor', () => {
  it('uses initials or the first three letters', () => {
    expect(prefixFor('my-web-app')).toBe('MWA');
    expect(prefixFor('billing')).toBe('BIL');
    expect(prefixFor('42')).toBe('T');
  });
});

describe('applyPlan', () => {
  it('creates the root with only the planned roles and blocked tasks', () => {
    const d = webRepo();
    const plan = adoptPlan(surveyRepo(d));
    const res = applyPlan(d, plan, { actor: 'human:dawid', human: 'human:dawid', env: env(d) });
    expect(res.dir).toBe(join(d, '.swarmup'));
    expect(
      readdirSync(join(res.dir, 'agents'))
        .filter((f) => f.endsWith('.md'))
        .sort(),
    ).toEqual([
      'claude-docs.md',
      'claude-qa.md',
      'claude-release.md',
      'codex-backend.md',
      'cursor-frontend.md',
    ]);
    expect(res.tasks.map((t) => t.id)).toEqual(['SF-0001', 'SF-0002']);
    const ws = new Workspace({ cwd: d, env: env(d), actor: 'human:dawid' });
    const second = ws.view('SF-0002');
    expect(second.meta.blocked_by).toEqual(['SF-0001']);
    expect(second.meta.project).toBe('shop-front');
    expect(surveyRepo(d).hasRoot).toBe(true);
  });

  it("turns an agent's tasks into findings that wait for the human", () => {
    const d = webRepo();
    const res = applyPlan(d, adoptPlan(surveyRepo(d)), { actor: 'claude:engineer', env: env(d) });
    expect(res.tasks.every((t) => t.proposed)).toBe(true);
  });

  it('writes nothing without an acting id', () => {
    const d = webRepo();
    expect(() => applyPlan(d, adoptPlan(surveyRepo(d)), { env: env(d) })).toThrow(/acting id/);
    expect(existsSync(join(d, '.swarmup'))).toBe(false);
  });
});

describe('newProject', () => {
  it('starts a library in a new folder with git, files, roles and tasks', () => {
    const parent = tmp();
    const target = join(parent, 'tiny-lib');
    const res = newProject(target, 'library', { actor: 'human:dawid', env: env(parent) });
    expect(res.gitInit).toBe(true);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(readFileSync(join(target, 'README.md'), 'utf8')).toMatch(/^# tiny-lib/);
    expect(res.files).toEqual(['README.md', 'AGENTS.md', '.gitignore']);
    expect(res.agents).toContain('claude:release');
    expect(res.tasks.map((t) => t.id)).toEqual(['TL-0001', 'TL-0002', 'TL-0003', 'TL-0004']);
    expect(res.tasks[0]!.title).toBe('Pick the language and scaffold tiny-lib');
  });

  it('skips git init inside a repo and refuses a folder that is not empty', () => {
    const parent = tmp();
    execFileSync('git', ['init', '-q'], { cwd: parent, windowsHide: true });
    const res = newProject(join(parent, 'site'), 'docs-site', {
      actor: 'human:dawid',
      env: env(parent),
    });
    expect(res.gitInit).toBe(false);
    write(parent, { 'full/a.txt': 'x' });
    expect(() =>
      newProject(join(parent, 'full'), 'web-app', { actor: 'human:dawid', env: env(parent) }),
    ).toThrow(/not empty/);
    expect(() => newProject(join(parent, 'x'), 'game', { actor: 'human:dawid' })).toThrow(
      /no project template 'game'/,
    );
  });

  it('makes no folder when the prefix or human id is bad', () => {
    const parent = tmp();
    const target = join(parent, 'app');
    const opts = { actor: 'human:dawid', env: env(parent) };
    expect(() => newProject(target, 'web-app', { ...opts, prefix: '9x' })).toThrow(/bad id prefix/);
    expect(() => newProject(target, 'web-app', { ...opts, human: 'dawid' })).toThrow(
      /bad human id/,
    );
    expect(existsSync(target)).toBe(false);
  });
});
