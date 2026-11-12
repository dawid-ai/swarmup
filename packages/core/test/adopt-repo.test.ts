// `adoptRepo`, the one code path of `swarmup adopt --apply` and the app's Add project (AO-0274).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  addRootToUserConfig,
  adoptPlan,
  adoptRepo,
  initRoot,
  keepTasks,
  surveyRepo,
  Workspace,
} from '../src/index.js';
import { git, gitRepo } from './helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-adopt-repo-'));
  dirs.push(d);
  return d;
}

/** A go repo on branch `main` with no tests, README or CI, so the plan has five tasks. */
function goRepo(parent: string, name = 'billing'): string {
  const d = join(parent, name);
  mkdirSync(d);
  gitRepo(d);
  writeFileSync(join(d, 'go.mod'), 'module x\n');
  return d;
}

/** A user config with a comment and a swarmupd setting, and the env that points at it. */
function userConfig(dir: string): { file: string; env: NodeJS.ProcessEnv } {
  const file = join(dir, 'config.yml');
  writeFileSync(
    file,
    ['# my machine', 'me: human:dawid', 'swarmupd:', '  max_runs: 3 # keep it low', ''].join('\n'),
  );
  return { file, env: { SWARMUP_CONFIG: file } };
}

const who = { actor: 'human:dawid', human: 'human:dawid' };

describe('keepTasks', () => {
  it('keeps the chosen tasks and renumbers what they wait for', () => {
    const base = tmp();
    const plan = adoptPlan(surveyRepo(goRepo(base)));
    const kept = keepTasks(plan, [3, 0, 3, 99]);
    expect(kept.tasks.map((t) => t.title)).toEqual([
      'Record the baseline: build and test billing',
      'Write a README for billing',
    ]);
    expect(kept.tasks[1]!.after).toEqual([0]);
    // Without the baseline task, nothing is left to wait for.
    expect(keepTasks(plan, [1, 2]).tasks.map((t) => t.after)).toEqual([undefined, undefined]);
  });
});

describe('adoptRepo', () => {
  it('creates the store in the repo and leaves the user config alone', () => {
    const base = tmp();
    const repo = goRepo(base);
    const { file, env } = userConfig(base);
    const before = readFileSync(file, 'utf8');
    const res = adoptRepo(repo, { ...who, env, prefix: 'bil', tasks: [0, 1] });
    expect(res.dir).toBe(join(repo, '.swarmup'));
    expect(res.store).toBeNull();
    expect(res.config).toBeNull();
    expect(res.tasks.map((t) => t.id)).toEqual(['BIL-0001', 'BIL-0002']);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(() => adoptRepo(repo, { ...who, env })).toThrow(/has a data root already/);
  });

  it('with register, adds the repo to roots and keeps comments and other keys', () => {
    const base = tmp();
    const repo = goRepo(base);
    const { file, env } = userConfig(base);
    const res = adoptRepo(repo, { ...who, env, register: true });
    expect(res.config).toBe(file);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my machine');
    expect(text).toContain('max_runs: 3 # keep it low');
    expect(YAML.parse(text)).toEqual({
      me: 'human:dawid',
      swarmupd: { max_runs: 3 },
      roots: [repo],
    });
  });

  it('with a store, writes the tasks apart from the repo and names the code checkout', () => {
    const base = tmp();
    const repo = goRepo(base);
    git(repo, 'checkout', '-q', '-b', 'trunk');
    const store = join(base, 'billing-tasks');
    const { file, env } = userConfig(base);
    const res = adoptRepo(repo, { ...who, env, store });
    expect(res).toMatchObject({ repo, store, base: 'trunk', gitInit: true, config: file });
    expect(res.dir).toBe(join(store, '.swarmup'));
    expect(existsSync(join(repo, '.swarmup'))).toBe(false);
    expect(existsSync(join(store, '.git'))).toBe(true);
    const ws = new Workspace({ cwd: store, env, actor: 'human:dawid' });
    expect(ws.view('BIL-0002').meta.project).toBe('billing');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my machine');
    expect(YAML.parse(text)).toEqual({
      me: 'human:dawid',
      swarmupd: {
        max_runs: 3,
        code: { billing: repo },
        merge: { billing: { base: 'trunk', checkout: repo } },
      },
      roots: [store],
    });
  });

  it('keeps the settings under the old opsd key', () => {
    const base = tmp();
    const repo = goRepo(base);
    const file = join(base, 'config.yml');
    writeFileSync(file, 'me: human:dawid\nopsd:\n  max_runs: 2\n');
    adoptRepo(repo, { ...who, env: { SWARMUP_CONFIG: file }, store: join(base, 'tasks') });
    const cfg = YAML.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(cfg.swarmupd).toBeUndefined();
    expect(cfg.opsd).toMatchObject({ max_runs: 2, code: { billing: repo } });
  });

  it('refuses before writing: no git, a store in the repo, a taken name, a refused config', () => {
    const base = tmp();
    const { file, env } = userConfig(base);
    const before = readFileSync(file, 'utf8');
    const plain = join(base, 'plain');
    mkdirSync(plain);
    writeFileSync(join(plain, 'go.mod'), 'module x\n');
    const outside = join(base, 'tasks');
    expect(() => adoptRepo(plain, { ...who, env, requireGit: true })).toThrow(/not a git repo/);
    expect(() => adoptRepo(plain, { ...who, env, store: outside })).toThrow(/not a git repo/);
    const repo = goRepo(base);
    expect(() => adoptRepo(repo, { ...who, env, store: join(repo, 'tasks') })).toThrow(
      /outside the repo/,
    );
    initRoot(join(base, 'other'), { name: 'billing' });
    writeFileSync(file, `${before}roots:\n  - ${JSON.stringify(join(base, 'other'))}\n`);
    expect(() => adoptRepo(repo, { ...who, env, register: true })).toThrow(
      /named 'billing' is loaded already/,
    );
    for (const d of [join(plain, '.swarmup'), join(repo, '.swarmup'), outside]) {
      expect(existsSync(d)).toBe(false);
    }
    // A config the caller refuses is not written; the message says the root exists.
    const refuse = (): void => {
      throw new Error('bad setting');
    };
    expect(() =>
      adoptRepo(repo, { ...who, env, name: 'ledger', register: true, checkConfig: refuse }),
    ).toThrow(/created .*\.swarmup, but the user config was not changed: bad setting/);
    expect(readFileSync(file, 'utf8')).toContain('other');
    expect(readFileSync(file, 'utf8')).not.toContain('billing"\n  - ');
  });
});

describe('addRootToUserConfig', () => {
  it('adds a root once, by either spelling', () => {
    const base = tmp();
    const { file, env } = userConfig(base);
    const repo = join(base, 'shop');
    initRoot(repo, { name: 'shop' });
    expect(addRootToUserConfig(env, repo)).toMatchObject({ root: repo, name: 'shop', added: true });
    const once = readFileSync(file, 'utf8');
    expect(addRootToUserConfig(env, join(repo, '.swarmup')).added).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(once);
    expect((YAML.parse(once) as { roots: string[] }).roots).toEqual([repo]);
    expect(() => addRootToUserConfig(env, base)).toThrow(/is not a data root/);
  });
});
