import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  checkMap,
  DEFAULT_WORKSPACE_TYPES,
  newProject,
  parseRubric,
  PROJECT_TEMPLATES,
  readRootConfig,
  templatePlan,
  Workspace,
  workspaceTypes,
} from '../src/index.js';
import { git, tempDir } from './helpers.js';

// The campaign and content templates (W8), `new-project --store`, and `workspace_types`.

/** An env whose git commits without the person's identity or signing. */
function env(dir: string): NodeJS.ProcessEnv {
  return {
    SWARMUP_CONFIG: join(dir, 'config.yml'),
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'commit.gpgsign',
    GIT_CONFIG_VALUE_0: 'false',
  };
}

describe('the campaign and content templates', () => {
  it('carry typed criteria, types, owners and the editor as reviewer of drafts', () => {
    for (const id of ['campaign', 'content']) {
      const t = PROJECT_TEMPLATES.find((x) => x.id === id)!;
      expect(t.agents.map((a) => a.id)).toContain('codex:editor');
      expect(t.workspaceTypes).toEqual(['task', 'docs', 'content']);
      const plan = templatePlan(t, 'launch', 'LC');
      expect(plan.tasks.every((x) => (x.done_when ?? []).length > 0)).toBe(true);
      const draft = plan.tasks.find((x) => x.title.startsWith('Draft'))!;
      expect(draft).toMatchObject({
        type: 'content',
        owner: 'claude:writer',
        review: 'codex:editor',
      });
      expect(
        draft.done_when!.filter((c) => typeof c !== 'string' && c.kind === 'rubric'),
      ).toHaveLength(3);
      const publish = plan.tasks.find((x) => x.type === 'publish')!;
      expect(publish.owner).toBeUndefined();
      // The person's question names the project.
      const voice = plan.tasks[0]!.done_when!.find(
        (c) => typeof c !== 'string' && c.kind === 'human',
      );
      expect(voice).toMatchObject({ ask: 'Does brand/voice.md sound like launch?' });
    }
  });

  it('ship rubrics the judge reads, on a 0 to 4 scale', () => {
    const t = PROJECT_TEMPLATES.find((x) => x.id === 'campaign')!;
    for (const f of ['brand-voice', 'claim-accuracy', 'channel-fit']) {
      const r = parseRubric(t.files[`rubrics/${f}.md`]!, f);
      expect(r.id).toBe(f);
      expect(r.scale).toEqual({ min: 0, max: 4 });
      expect(r.inputs).toContain('files');
      expect(r.body).toMatch(/\*\*4\*\*/);
    }
  });
});

describe('newProject with a content template', () => {
  it('writes the files and a map that checks clean, and files the tasks with their criteria', () => {
    const parent = tempDir();
    const target = join(parent, 'news');
    const res = newProject(target, 'content', {
      actor: 'human:dawid',
      human: 'human:dawid',
      env: env(parent),
    });
    for (const f of [
      'brand/voice.md',
      'facts/claims.md',
      'rubrics/channel-fit.md',
      'posts/README.md',
    ]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    expect(existsSync(join(target, 'calendar.md'))).toBe(false);
    expect(res.files).toContain('.swarmup/map/_INDEX.md');
    expect(readRootConfig(res.dir).workspace_types).toEqual(['task', 'docs', 'content']);
    const ws = new Workspace({ cwd: target, env: env(parent), actor: 'human:dawid' });
    const views = res.tasks.map((t) => ws.view(t.id));
    expect(views.map((v) => v.meta.type)).toEqual(['docs', 'docs', 'content', 'publish']);
    expect(views[3]!.meta.owner).toBe('human:dawid');
    expect(views[2]!.meta.review).toBe('codex:editor');
    expect(views[2]!.criteria!.map((c) => c.id)).toEqual([
      'exists',
      'front-matter',
      'voice',
      'claims',
      'channel',
    ]);
    expect(views[3]!.criteria![0]).toMatchObject({ check: 'url-ok', when: 'publish' });
    // Commit what new-project wrote: the map then has nothing to report against it.
    git(target, 'add', '-A');
    git(
      target,
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'start',
    );
    const map = checkMap(target, { base: 'HEAD' });
    expect(map.errors).toEqual([]);
    expect(map.nodes).toBe(6);
  });

  it('with --store, commits on main, keeps the store apart and registers the root', () => {
    const parent = tempDir();
    const target = join(parent, 'swarmup-launch');
    const store = join(parent, 'store', 'launch');
    writeFileSync(join(parent, 'config.yml'), '# my settings\nme: human:dawid\nroots: []\n');
    const res = newProject(target, 'campaign', {
      actor: 'human:dawid',
      human: 'human:dawid',
      env: env(parent),
      name: 'launch',
      prefix: 'LC',
      store,
    });
    expect(res.base).toBe('main');
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(target, 'status', '--porcelain').trim()).toBe('');
    expect(res.commit).toBe(git(target, 'rev-parse', 'HEAD').trim());
    expect(existsSync(join(target, '.swarmup', 'config.yml'))).toBe(false);
    expect(existsSync(join(store, '.swarmup', 'config.yml'))).toBe(true);
    expect(existsSync(join(store, '.git'))).toBe(true);
    expect(res.tasks.map((t) => t.id)).toEqual([
      'LC-0001',
      'LC-0002',
      'LC-0003',
      'LC-0004',
      'LC-0005',
    ]);
    const text = readFileSync(join(parent, 'config.yml'), 'utf8');
    expect(text).toMatch(/^# my settings/);
    const cfg = YAML.parse(text);
    expect(cfg.roots).toHaveLength(1);
    expect(cfg.swarmupd.code.launch).toBe(target);
    expect(cfg.swarmupd.merge.launch).toEqual({
      base: 'main',
      checkout: target,
      checks: ['swarmup map check --base main'],
    });
    expect(cfg.swarmupd.test_changes.launch).toEqual({
      checks: ['brand/**', 'facts/**', 'rubrics/**'],
    });
    // The map checks clean against main on the first commit.
    const map = checkMap(target, { base: 'main' });
    expect(map.errors).toEqual([]);
    expect(map.nodes).toBe(7);
  });

  it('with --store, refuses a project inside a repo, a store inside it, and a loaded name', () => {
    const parent = tempDir();
    writeFileSync(join(parent, 'config.yml'), 'roots: []\n');
    const opts = { actor: 'human:dawid', env: env(parent) };
    expect(() =>
      newProject(join(parent, 'p'), 'campaign', { ...opts, store: join(parent, 'p', 'tasks') }),
    ).toThrow(/outside the project/);
    const repo = join(parent, 'repo');
    git(parent, 'init', '-q', 'repo');
    expect(() =>
      newProject(join(repo, 'p'), 'campaign', { ...opts, store: join(parent, 's') }),
    ).toThrow(/inside a git repo/);
    newProject(join(parent, 'one'), 'campaign', {
      ...opts,
      name: 'same',
      store: join(parent, 's1'),
    });
    expect(() =>
      newProject(join(parent, 'two'), 'campaign', {
        ...opts,
        name: 'same',
        store: join(parent, 's2'),
      }),
    ).toThrow(/loaded already/);
    expect(existsSync(join(parent, 'two'))).toBe(false);
  });
});

describe('newProject with tasks: []', () => {
  it('files none of the template tasks, for a root that files its own', () => {
    const parent = tempDir();
    const res = newProject(join(parent, 'blog'), 'content', {
      actor: 'human:dawid',
      env: env(parent),
      tasks: [],
    });
    expect(res.tasks).toEqual([]);
    expect(res.agents).toContain('codex:editor');
  });
});

describe('yardstick tasks', () => {
  it('go to the person for review, whoever reviews other work', () => {
    const parent = tempDir();
    const target = join(parent, 'blog');
    newProject(target, 'content', { actor: 'human:dawid', human: 'human:dawid', env: env(parent) });
    const ws = (actor: string) => new Workspace({ cwd: target, env: env(parent), actor });
    ws('claude:writer').start('1', 'voice');
    const res = ws('claude:writer').review('1', 'BL-0001: voice written');
    expect(res.view.reviewer).toBe('human:dawid');
    expect(res.notes?.join(' ')).toMatch(/only the person reviews/);
  });
});

describe('workspaceTypes', () => {
  it('reads the root config, else the default', () => {
    expect([...workspaceTypes({ config: {} })]).toEqual([...DEFAULT_WORKSPACE_TYPES]);
    expect([...workspaceTypes({ config: { workspace_types: ['content', ' docs '] } })]).toEqual([
      'content',
      'docs',
    ]);
    expect([...workspaceTypes({ config: { workspace_types: [] } })]).toEqual([
      ...DEFAULT_WORKSPACE_TYPES,
    ]);
  });
});
