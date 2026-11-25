import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOverlay,
  clearDefinitionsCache,
  hashTexts,
  IMPROVE_BENCH_ACTOR,
  improvementPolicy,
  listVariants,
  loadDefinitions,
  mergeAgentText,
  mergeValues,
  mergeYamlText,
  overlayAgents,
  policyProblems,
  requiresProblems,
  textsHash,
  variantInfo,
} from '../src/index.js';
import { git, gitRepo, setup, tempDir } from './helpers.js';

const ENGINEER = [
  '---',
  'id: claude:engineer',
  'status: active',
  'can_claim: [task, bug]',
  'model: opus',
  'tools: [Read, Edit]',
  '---',
  '',
  '# Engineer',
  '',
  'Write the code.',
  '',
].join('\n');

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** A store with swarm.yaml and an engineer file. */
function store(): string {
  const dir = tempDir();
  put(dir, 'swarm.yaml', 'swarmup_defs: 1\n# the team\nruntimes:\n  claude: { model: opus }\n');
  put(dir, 'agents/claude-engineer.md', ENGINEER);
  return dir;
}

describe('overlay merge rules', () => {
  it('merges maps, replaces lists and deletes with null', () => {
    expect(
      mergeValues(
        { a: 1, list: [1, 2], m: { x: 1, y: 2 }, gone: true },
        { list: [3], m: { y: 3, z: { k: null, v: 1 } }, gone: null, new: 'n' },
      ),
    ).toEqual({ a: 1, list: [3], m: { x: 1, y: 3, z: { v: 1 } }, new: 'n' });
  });

  it('keeps the comments of the base YAML', () => {
    const out = mergeYamlText(
      'swarmup_defs: 1\n# the team\nruntimes:\n  claude:\n    model: opus\n',
      'runtimes:\n  claude:\n    effort: high\n',
    );
    expect(out).toContain('# the team');
    expect(out).toContain('model: opus');
    expect(out).toContain('effort: high');
  });

  it('merges agent frontmatter and replaces a non-empty body', () => {
    const merged = mergeAgentText(ENGINEER, '---\neffort: high\nmodel: null\n---\n\nNew rules.\n');
    expect(merged).toContain('effort: high');
    expect(merged).not.toContain('model: opus');
    expect(merged).toMatch(/can_claim: \[ ?task, bug ?\]/);
    expect(merged).toContain('New rules.');
    expect(merged).not.toContain('Write the code.');
    // A body-only overlay keeps the frontmatter text as it was.
    const body = mergeAgentText(ENGINEER, 'Run the tests first.\n');
    expect(body.startsWith(ENGINEER.slice(0, ENGINEER.indexOf('# Engineer')))).toBe(true);
    expect(body).toContain('Run the tests first.');
    // An empty body keeps the base body.
    expect(mergeAgentText(ENGINEER, '---\neffort: low\n---\n')).toContain('Write the code.');
  });

  it('removes a file with .delete and adds a new one', () => {
    const base = new Map([
      ['agents/a.md', 'A'],
      ['swarm.yaml', 'swarmup_defs: 1\n'],
    ]);
    const out = applyOverlay(
      base,
      new Map([
        ['agents/a.md.delete', ''],
        ['workflows/x.yaml', 'a: 1\n'],
      ]),
    );
    expect([...out.keys()]).toEqual(['swarm.yaml', 'workflows/x.yaml']);
  });

  it('hashes the base with the overlay, as the base hash would hash the same files', () => {
    const base = new Map([['agents/claude-engineer.md', ENGINEER]]);
    const out = applyOverlay(base, new Map([['agents/claude-engineer.md', 'Tests first.\n']]));
    expect(textsHash(out)).toBe(hashTexts(Object.fromEntries(out)));
    expect(textsHash(out)).not.toBe(textsHash(base));
  });

  it('names the agents an overlay changes', () => {
    expect(
      overlayAgents(
        new Map([
          ['agents/claude-personal-assistant.md', 'x'],
          ['swarm.yaml', ''],
        ]),
      ),
    ).toEqual(['claude:personal-assistant']);
  });
});

describe('loadDefinitions with a variant', () => {
  it('reads the base with the overlay on top and hashes per variant', () => {
    const dir = store();
    put(
      dir,
      'variants/tests-first/agents/claude-engineer.md',
      '---\neffort: high\n---\n\nTests first.\n',
    );
    clearDefinitionsCache();
    const base = loadDefinitions(dir);
    const v = loadDefinitions(dir, { variant: 'tests-first' });
    expect(v.ok).toBe(true);
    expect(v.variant).toBe('tests-first');
    expect(v.baseHash).toBe(base.hash);
    expect(v.hash).not.toBe(base.hash);
    const eng = v.agents.find((a) => a.id === 'claude:engineer')!;
    expect(eng.effort).toBe('high');
    expect(eng.model).toBe('opus');
    expect(eng.body.trim()).toBe('Tests first.');
    expect(eng.file).toBe(join(dir, 'variants', 'tests-first', 'agents', 'claude-engineer.md'));
    // The base never counts the variants folder.
    expect(base.files.map((f) => f.path)).toEqual(['agents/claude-engineer.md', 'swarm.yaml']);
    expect(() => loadDefinitions(dir, { variant: 'missing' })).toThrow(/no variant 'missing'/);
  });

  it('reads a from_ref variant as the store had its definitions at the ref', () => {
    const dir = gitRepo();
    put(dir, 'swarm.yaml', 'swarmup_defs: 1\n');
    put(dir, 'agents/claude-engineer.md', ENGINEER);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'defs');
    git(dir, 'tag', 'v1');
    put(dir, 'agents/claude-engineer.md', ENGINEER.replace('Write the code.', 'Changed since.'));
    put(
      dir,
      'swarm.yaml',
      [
        'swarmup_defs: 1',
        'variants:',
        '  old-engineer: {from_ref: v1, description: The engineer as v1 had it}',
        '  tests-first: {description: Write the test first}',
        'experiments:',
        '  - {id: trial, variant: old-engineer, share: 0.5}',
        '',
      ].join('\n'),
    );
    put(dir, 'variants/tests-first/agents/claude-engineer.md', '---\n---\n\nTests first.\n');
    clearDefinitionsCache();
    const base = loadDefinitions(dir, { checkRefs: true });
    expect(base.problems).toEqual([]);
    expect(base.swarm?.variants).toEqual({
      'old-engineer': { from_ref: 'v1', description: 'The engineer as v1 had it' },
      'tests-first': { description: 'Write the test first' },
    });
    const v = loadDefinitions(dir, { variant: 'old-engineer' });
    expect(v).toMatchObject({ ok: true, variant: 'old-engineer', ref: 'v1', baseHash: base.hash });
    expect(v.commit).toBe(git(dir, 'rev-parse', 'v1').trim());
    expect(v.agents.find((a) => a.id === 'claude:engineer')!.body).toContain('Write the code.');
    // `defs variants` lists both, with their descriptions, and the ref variant's change.
    const info = variantInfo(dir, 'old-engineer');
    expect(info).toMatchObject({
      from_ref: 'v1',
      description: 'The engineer as v1 had it',
      agents: ['claude:engineer'],
      ok: true,
    });
    expect(info.files.map((f) => `${f.kind} ${f.path}`)).toEqual([
      'changed agents/claude-engineer.md',
      'changed swarm.yaml',
    ]);
    expect(listVariants(dir).map((x) => [x.name, x.description])).toEqual([
      ['old-engineer', 'The engineer as v1 had it'],
      ['tests-first', 'Write the test first'],
    ]);
  });

  it('refuses a from_ref git cannot read and a name that is a folder too', () => {
    const dir = gitRepo();
    put(dir, 'agents/claude-engineer.md', ENGINEER);
    put(
      dir,
      'swarm.yaml',
      [
        'swarmup_defs: 1',
        'variants:',
        '  gone: {from_ref: no-such-ref}',
        '  both: {from_ref: HEAD}',
        '  loose: {description: no folder}',
        '',
      ].join('\n'),
    );
    put(dir, 'variants/both/agents/claude-engineer.md', '---\n---\n\nBoth.\n');
    clearDefinitionsCache();
    const problems = loadDefinitions(dir, { checkRefs: true }).problems.map(
      (p) => `${p.line}:${p.col} ${p.severity} ${p.path}: ${p.message}`,
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(
      /^3:10 error variants\.gone\.from_ref: git cannot read no-such-ref/,
    );
    expect(problems.slice(1)).toEqual([
      '4:10 error variants.both.from_ref: variants/both/ is a folder variant too; a name is a folder or a from_ref variant, not both',
      '5:3 warning variants.loose: no variants/loose/ in this store and no from_ref',
    ]);
    expect(() => loadDefinitions(dir, { variant: 'gone' })).toThrow(/git cannot read no-such-ref/);
  });

  it('reports a schema error in the overlay against the overlay file', () => {
    const dir = store();
    put(dir, 'variants/bad/agents/claude-engineer.md', '---\nstatus: sleeping\n---\n');
    const v = loadDefinitions(dir, { variant: 'bad' });
    expect(v.ok).toBe(false);
    expect(v.problems[0]!.file).toBe(join(dir, 'variants', 'bad', 'agents', 'claude-engineer.md'));
  });
});

describe('improvement policy', () => {
  const base = new Map([
    ['swarm.yaml', 'swarmup_defs: 1\n'],
    ['agents/claude-engineer.md', ENGINEER],
  ]);
  const policy = improvementPolicy(null);

  it('allows agent instructions by default', () => {
    expect(
      policyProblems(base, new Map([['agents/claude-engineer.md', 'Tests.\n']]), policy),
    ).toEqual([]);
  });

  it('refuses frozen paths and paths outside may_change', () => {
    const out = policyProblems(
      base,
      new Map([
        ['swarm.yaml', 'roles: {}\n'],
        ['scorers/x.yaml', 'a: 1\n'],
        ['AGENTS.md', 'x'],
      ]),
      policy,
    );
    expect(out).toEqual([
      'AGENTS.md: outside what a proposal may change (agents/*.md, agents/*/*.md, workflows/**)',
      'scorers/x.yaml: frozen by the improvement policy (scorers/**, benchmarks/**, rubrics/**, triggers/**, swarm.yaml)',
      'swarm.yaml: frozen by the improvement policy (scorers/**, benchmarks/**, rubrics/**, triggers/**, swarm.yaml)',
    ]);
  });

  it('refuses a change to tools, writes, can_claim or id, and removing an agent', () => {
    const out = policyProblems(
      base,
      new Map([
        [
          'agents/claude-engineer.md',
          '---\ntools: [Read, Edit, Bash]\nmcp: [notion]\nwrites: true\n---\n',
        ],
      ]),
      policy,
    );
    expect(out).toEqual([
      'agents/claude-engineer.md: tools is always frozen; a person changes it by hand',
      'agents/claude-engineer.md: mcp is always frozen; a person changes it by hand',
      'agents/claude-engineer.md: writes is always frozen; a person changes it by hand',
    ]);
    expect(
      policyProblems(base, new Map([['agents/claude-engineer.md.delete', '']]), policy),
    ).toEqual(['agents/claude-engineer.md: a proposal does not remove an agent file']);
    // The same value again is no change.
    expect(
      policyProblems(
        base,
        new Map([['agents/claude-engineer.md', '---\ncan_claim: [task, bug]\n---\n']]),
        policy,
      ),
    ).toEqual([]);
  });

  it('reads may_change, frozen and max_open_proposals from swarm.yaml', () => {
    const dir = store();
    put(
      dir,
      'swarm.yaml',
      'swarmup_defs: 1\nimprovement:\n  may_change: [agents/*.md, swarm.yaml]\n  frozen: []\n  max_open_proposals: 1\n',
    );
    const set = loadDefinitions(dir);
    expect(set.problems.filter((p) => p.path.startsWith('improvement'))).toEqual([]);
    expect(improvementPolicy(set.swarm)).toEqual({
      agent: 'claude:improver',
      may_change: ['agents/*.md', 'swarm.yaml'],
      frozen: [],
      max_open_proposals: 1,
      requires: { benchmark: false, min_delta: 0 },
    });
  });
});

describe('defs propose, promote and reject', () => {
  function world() {
    const w = setup();
    put(w.rootDir, 'swarm.yaml', 'swarmup_defs: 1\n');
    put(w.rootDir, 'agents/claude-engineer.md', ENGINEER);
    const dawid = w.as('human:dawid', { force: true });
    const task = dawid.newTask({
      title: 'Improve claude:engineer',
      owner: 'claude:improver',
      body: 'Agent: claude:engineer\nScorers: review-rounds, merge-failures\nEvidence: test/T-0009, test/T-0010\n',
    }).id;
    const overlay = (name: string, text = 'Run the tests before you ask for review.\n'): string => {
      const dir = join(tempDir(), name);
      put(dir, 'agents/claude-engineer.md', text);
      return dir;
    };
    return { ...w, dawid, task, overlay, improver: w.as('claude:improver', { force: true }) };
  }

  it('writes the variant and a defs-propose event with the hash and regressions', () => {
    const w = world();
    const res = w.improver.defsPropose(w.task, {
      dir: w.overlay('a'),
      name: 'tests-first',
      message: 'Review rounds come from untested changes.',
    });
    const dir = join(w.rootDir, 'variants', 'tests-first');
    expect(readFileSync(join(dir, 'agents', 'claude-engineer.md'), 'utf8')).toContain(
      'Run the tests',
    );
    const meta = JSON.parse(readFileSync(join(dir, 'proposal.json'), 'utf8'));
    expect(meta).toMatchObject({
      task: `test/${w.task}`,
      agents: ['claude:engineer'],
      scorers: ['review-rounds', 'merge-failures'],
      by: 'claude:improver',
      hash: res.proposal.hash,
    });
    const e = res.events[0]!;
    expect(e.type).toBe('defs-propose');
    expect(e.variant).toBe('tests-first');
    expect(e.defs).toBe(res.proposal.hash.slice(0, 14));
    expect(e.body).toContain('## Regressions addressed');
    expect(e.body).toContain('- Evidence: test/T-0009, test/T-0010');
    const info = variantInfo(w.rootDir, 'tests-first');
    expect(info).toMatchObject({ status: 'proposed', ok: true, stale: false });
    expect(info.files.map((f) => [f.path, f.kind])).toEqual([
      ['agents/claude-engineer.md', 'changed'],
    ]);
  });

  it('refuses a policy breach and a variant that does not check, writing nothing', () => {
    const w = world();
    expect(() =>
      w.improver.defsPropose(w.task, {
        dir: w.overlay('b', '---\ntools: [Bash]\n---\n'),
        name: 'more-tools',
        message: 'x',
      }),
    ).toThrow(/tools is always frozen/);
    expect(() =>
      w.improver.defsPropose(w.task, {
        dir: w.overlay('c', '---\nstatus: sleeping\n---\n'),
        name: 'broken',
        message: 'x',
      }),
    ).toThrow(/does not check/);
    expect(existsSync(join(w.rootDir, 'variants', 'more-tools'))).toBe(false);
    expect(existsSync(join(w.rootDir, 'variants', 'broken'))).toBe(false);
  });

  it('caps open proposals at max_open_proposals', () => {
    const w = world();
    for (const n of ['one', 'two']) {
      w.improver.defsPropose(w.task, { dir: w.overlay(n), name: n, message: 'x' });
    }
    expect(() =>
      w.improver.defsPropose(w.task, { dir: w.overlay('three'), name: 'three', message: 'x' }),
    ).toThrow(/2 proposal\(s\) wait for a person.*max_open_proposals is 2/);
  });

  it('lets only a person promote: the base file changes, the event has both hashes, the folder goes', () => {
    const w = world();
    w.improver.defsPropose(w.task, { dir: w.overlay('a'), name: 'tests-first', message: 'x' });
    expect(() => w.improver.defsPromote('tests-first')).toThrow(/only a person promotes/);
    clearDefinitionsCache();
    const before = loadDefinitions(w.rootDir).hash;
    const done = w.dawid.defsPromote('tests-first', { message: 'Looks right.' });
    expect(done.written).toEqual(['agents/claude-engineer.md']);
    const text = readFileSync(join(w.rootDir, 'agents', 'claude-engineer.md'), 'utf8');
    expect(text).toContain('Run the tests before you ask for review.');
    expect(text).toContain('tools: [Read, Edit]');
    expect(existsSync(join(w.rootDir, 'variants', 'tests-first'))).toBe(false);
    const e = done.events[0]!;
    expect(e).toMatchObject({ type: 'defs-promote', variant: 'tests-first' });
    expect(e.defs_from).toBe(before.slice(0, 14));
    clearDefinitionsCache();
    expect(e.defs_to).toBe(loadDefinitions(w.rootDir).hash.slice(0, 14));
  });

  it('holds a promote to improvement.requires until a recorded benchmark passes', () => {
    const w = world();
    put(
      w.rootDir,
      'swarm.yaml',
      'swarmup_defs: 1\nimprovement:\n  requires: {benchmark: true, min_delta: 0.05}\n',
    );
    w.improver.defsPropose(w.task, { dir: w.overlay('a'), name: 'tests-first', message: 'x' });
    clearDefinitionsCache();
    const hash = loadDefinitions(w.rootDir, { variant: 'tests-first' }).hash;
    expect(() => w.dawid.defsPromote('tests-first')).toThrow(/has none yet/);
    // Only swarmupd's improvement loop records a benchmark.
    const bench = { hash, state: 'done' as const, at: '2026-11-22T20:00:00Z' };
    expect(() => w.dawid.defsRecordBenchmark('tests-first', 'test', bench)).toThrow(
      /only swarmupd records/,
    );
    const loop = w.as(IMPROVE_BENCH_ACTOR);
    loop.defsRecordBenchmark('tests-first', 'test', { ...bench, hash: 'd:old' });
    expect(() => w.dawid.defsPromote('tests-first')).toThrow(/changed after its benchmark/);
    loop.defsRecordBenchmark('tests-first', 'test', {
      ...bench,
      verdict: 'better',
      pass_delta: 0.02,
    });
    expect(() => w.dawid.defsPromote('tests-first')).toThrow(/\+2 pts.*at least \+5 pts/);
    loop.defsRecordBenchmark('tests-first', 'test', {
      ...bench,
      verdict: 'better',
      pass_delta: 0.1,
    });
    const done = w.dawid.defsPromote('tests-first');
    expect(done.events[0]!.body).toContain('Benchmark: better, pass rate +10 pts.');
  });

  it('lets a person promote over improvement.requires with --force, and records it', () => {
    const w = world();
    put(w.rootDir, 'swarm.yaml', 'swarmup_defs: 1\nimprovement:\n  requires: {benchmark: true}\n');
    w.improver.defsPropose(w.task, { dir: w.overlay('a'), name: 'tests-first', message: 'x' });
    clearDefinitionsCache();
    const done = w.dawid.defsPromote('tests-first', { force: true });
    expect(done.events[0]!.body).toContain('Promoted with --force over improvement.requires');
    expect(requiresProblems(improvementPolicy(null), undefined, 'd:x')).toEqual([]);
  });

  it('rolls a promote back for a person: the base text returns and the task records it', () => {
    const w = world();
    put(w.rootDir, 'workflows/extra.yaml', 'stages: []\n');
    const overlay = w.overlay('a');
    put(overlay, 'workflows/extra.yaml.delete', '');
    w.improver.defsPropose(w.task, { dir: overlay, name: 'tests-first', message: 'x' });
    clearDefinitionsCache();
    const before = loadDefinitions(w.rootDir).hash;
    w.dawid.defsPromote('tests-first');
    expect(existsSync(join(w.rootDir, 'workflows', 'extra.yaml'))).toBe(false);
    // The app lists the promote for Roll back, with the files it changed.
    expect(w.dawid.promotedChanges()).toEqual([
      expect.objectContaining({
        variant: 'tests-first',
        by: 'human:dawid',
        files: ['agents/claude-engineer.md', 'workflows/extra.yaml'],
        changed: [],
      }),
    ]);
    expect(w.dawid.promotedChanges()[0]!.rolled_back).toBeUndefined();
    expect(() => w.improver.defsRollback('tests-first', 'bad')).toThrow(/only a person rolls back/);
    expect(() => w.dawid.defsRollback('tests-first', ' ')).toThrow(/say why/);
    // A change made after the promote needs --force: the rollback would drop it.
    const file = join(w.rootDir, 'agents', 'claude-engineer.md');
    const promoted = readFileSync(file, 'utf8');
    writeFileSync(file, `${promoted}Edited by hand.\n`);
    expect(w.dawid.promotedChanges()[0]!.changed).toEqual(['agents/claude-engineer.md']);
    expect(() => w.dawid.defsRollback('tests-first', 'worse')).toThrow(
      /agents\/claude-engineer\.md changed after the promote/,
    );
    writeFileSync(file, promoted);
    const done = w.dawid.defsRollback('tests-first', 'Review rounds went up.');
    expect(done.written).toEqual(['agents/claude-engineer.md', 'workflows/extra.yaml']);
    expect(readFileSync(file, 'utf8')).toBe(ENGINEER);
    clearDefinitionsCache();
    expect(loadDefinitions(w.rootDir).hash).toBe(before);
    expect(done.events[0]).toMatchObject({ type: 'defs-rollback', variant: 'tests-first' });
    expect(done.events[0]!.body).toContain('Review rounds went up.');
    expect(() => w.dawid.defsRollback('tests-first', 'again')).toThrow(/rolled back already/);
    expect(w.dawid.variants()).toEqual([]);
    expect(w.dawid.promotedChanges()).toEqual([
      expect.objectContaining({
        variant: 'tests-first',
        changed: [],
        rolled_back: expect.objectContaining({ by: 'human:dawid' }),
      }),
    ]);
  });

  it('lets only a person reject: a defs-reject event, the folder goes, the base stays', () => {
    const w = world();
    w.improver.defsPropose(w.task, { dir: w.overlay('a'), name: 'tests-first', message: 'x' });
    expect(() => w.improver.defsReject('tests-first', 'no')).toThrow(/only a person rejects/);
    expect(() => w.dawid.defsReject('tests-first', ' ')).toThrow(/say why/);
    const done = w.dawid.defsReject('tests-first', 'Too broad.');
    expect(done.events[0]).toMatchObject({
      type: 'defs-reject',
      variant: 'tests-first',
      body: 'Too broad.',
    });
    expect(existsSync(join(w.rootDir, 'variants'))).toBe(false);
    expect(readFileSync(join(w.rootDir, 'agents', 'claude-engineer.md'), 'utf8')).toBe(ENGINEER);
    expect(w.dawid.variants()).toEqual([]);
  });
});
