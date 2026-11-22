import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyOverlay,
  clearDefinitionsCache,
  hashTexts,
  improvementPolicy,
  loadDefinitions,
  mergeAgentText,
  mergeValues,
  mergeYamlText,
  overlayAgents,
  policyProblems,
  textsHash,
  variantInfo,
} from '../src/index.js';
import { setup, tempDir } from './helpers.js';

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
      'scorers/x.yaml: frozen by the improvement policy (scorers/**, benchmarks/**, rubrics/**, swarm.yaml)',
      'swarm.yaml: frozen by the improvement policy (scorers/**, benchmarks/**, rubrics/**, swarm.yaml)',
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
