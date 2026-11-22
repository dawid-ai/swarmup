import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_SCHEMA,
  agentRuntimeValues,
  checkEffort,
  checkModel,
  checkValue,
  checkYaml,
  definitionHash,
  definitionsFingerprint,
  formatProblem,
  hashTexts,
  initRoot,
  loadDefinitions,
  readAgentFiles,
  schemaFiles,
  shortHash,
  SWARM_SCHEMA,
  TEMPLATES_DIR,
  toJsonSchema,
} from '../src/index.js';
import { bool, enumOf, int, list, map, obj, oneOf, ref, str } from '../src/defs/schema.js';
import { tempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));

const lines = (text: string, file = 'swarm.yaml', strict = false): string[] =>
  checkYaml(SWARM_SCHEMA, text, { file, strict }).problems.map(formatProblem);

describe('schema language', () => {
  it('reports each problem with its file, line, column, path and message', () => {
    const text = [
      'swarmup_defs: 1',
      'runtimes:',
      '  claude:',
      '    model: opus',
      '    efort: high',
      '    command: claude',
      'roles:',
      '  engineer:',
      '    per_project: -1',
      '    providers: [claude, Codex]',
      '    writes: yes please',
      'policy:',
      '  review_rounds: 2',
      '',
    ].join('\n');
    expect(lines(text)).toEqual([
      "swarm.yaml:5:5: warning: runtimes.claude.efort: unknown key 'efort'; did you mean 'effort'?",
      'swarm.yaml:6:5: error: runtimes.claude.command: command is machine-only: set it under swarmupd.runtimes.<rt> in the user config, where swarmupd trusts the commands it runs',
      'swarm.yaml:9:18: error: roles.engineer.per_project: use a whole number of at least 0; got -1',
      "swarm.yaml:10:25: error: roles.engineer.providers[1]: name a runtime such as claude; got 'Codex'",
      'swarm.yaml:11:13: error: roles.engineer.writes: use true or false; got text',
    ]);
  });

  it('makes unknown keys errors under strict', () => {
    expect(lines('swarmup_defs: 1\nextra: 1\n', 'swarm.yaml', true)).toEqual([
      "swarm.yaml:2:1: error: extra: unknown key 'extra'; known keys: swarmup_defs, defaults, runtimes, roles, policy, work_types, scoring, checks, variants, experiments, improvement",
    ]);
    expect(lines('swarmup_defs: 1\nextra: 1\n')[0]).toContain(': warning: extra:');
  });

  it('requires the format key and a known version', () => {
    expect(lines('roles: {}\n')).toEqual([
      "swarm.yaml:1:1: error: (top): missing key 'swarmup_defs'",
    ]);
    expect(lines('swarmup_defs: 2\n')).toEqual([
      'swarm.yaml:1:15: error: swarmup_defs: use 1; got 2',
    ]);
  });

  it('reports YAML syntax errors with their place and checks nothing else', () => {
    const out = lines('swarmup_defs: 1\nroles:\n  qa: {per_project: 1\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^swarm\.yaml:\d+:\d+: error: \(top\): /);
    expect(lines('swarmup_defs: 1\nswarmup_defs: 1\n')[0]).toMatch(/unique/);
  });

  it('accepts empty maps and null entries', () => {
    expect(lines('swarmup_defs: 1\nroles:\n  qa:\nruntimes:\ndefaults:\n')).toEqual([]);
  });

  it('counts frontmatter lines after the opening ---', () => {
    const r = checkYaml(AGENT_SCHEMA, 'status: sleeping\n', { file: 'a.md', lineOffset: 1 });
    expect(r.problems.map(formatProblem)).toEqual([
      "a.md:2:9: error: status: use one of active, paused, proposed; got 'sleeping'",
    ]);
  });

  it('checks lists, enums, one-of and refs, and emits JSON Schema 2020-12', () => {
    const schema = obj(
      {
        n: int({ min: 1, doc: 'A count.' }),
        tags: list(str(), { maxItems: 2 }),
        mode: enumOf(['a', 'b']),
        either: oneOf([bool(), int()]),
        named: map(
          ref('thing', () => obj({ on: bool() })),
          { keyPattern: /^[a-z]+$/ },
        ),
      },
      { required: ['n'] },
    );
    const problems = checkValue(
      schema,
      { n: 0, tags: ['x', 'y', 'z'], mode: 'c', either: 'no', named: { Bad: {}, ok: { on: 1 } } },
      { file: 'x' },
    );
    expect(problems.map((p) => `${p.path}: ${p.message}`)).toEqual([
      'n: use a whole number of at least 1; got 0',
      'tags: at most 2 entries',
      "mode: use one of a, b; got 'c'",
      'either: use true or false, or a whole number; got text',
      "named.Bad: bad name; got 'Bad'",
      'named.ok.on: use true or false; got 1',
    ]);
    expect(toJsonSchema(schema, { id: 'x', title: 'X' })).toEqual({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'x',
      title: 'X',
      type: 'object',
      properties: {
        n: { description: 'A count.', type: 'integer', minimum: 1 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
        mode: { enum: ['a', 'b'] },
        either: { oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
        named: {
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          additionalProperties: { $ref: '#/$defs/thing' },
        },
      },
      required: ['n'],
      additionalProperties: false,
      $defs: {
        thing: {
          type: 'object',
          properties: { on: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    });
  });
});

describe('generated JSON Schemas', () => {
  it('match the schema language (run `node scripts/gen-schemas.mjs` after a change)', () => {
    const dir = join(here, '..', 'schemas');
    for (const [name, text] of Object.entries(schemaFiles())) {
      expect(readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n'), name).toBe(text);
    }
  });
});

describe('model and effort checks', () => {
  it('moved to core with the same messages', () => {
    expect(checkModel('gpt-5-codex', 'x')).toBe('gpt-5-codex');
    expect(() => checkModel('--yolo', 'agents.x.model')).toThrow(
      'agents.x.model: name a model such as opus or gpt-5-codex',
    );
    expect(checkEffort('high', 'x')).toBe('high');
    expect(() => checkEffort('High', 'e')).toThrow('e: name an effort level such as low');
  });

  it('give agent runtimes overrides before the agent file values', () => {
    const def = { model: 'opus', effort: 'low', runtimes: { claude: { model: 'sonnet' } } };
    expect(agentRuntimeValues(def, 'claude')).toEqual({ model: 'sonnet', effort: 'low' });
    expect(agentRuntimeValues(def, 'codex')).toEqual({ model: 'opus', effort: 'low' });
  });
});

describe('definition hash', () => {
  it('ignores line ends, a BOM and file order', () => {
    const a = hashTexts({
      'swarm.yaml': 'swarmup_defs: 1\n',
      'agents/claude-qa.md': '---\nid: claude:qa\n---\n',
    });
    const b = hashTexts({
      'agents/claude-qa.md': 'FEFF---\r\nid: claude:qa\r\n---\r\n',
      'swarm.yaml': 'swarmup_defs: 1\r\n',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^d:[0-9a-f]{64}$/);
    expect(shortHash(a)).toBe(a.slice(0, 14));
    expect(hashTexts({ 'swarm.yaml': 'swarmup_defs: 1\n' })).not.toBe(a);
    // A file's path is part of the hash, not only its content.
    expect(hashTexts({ 'agents/a.md': 'x' })).not.toBe(hashTexts({ 'agents/b.md': 'x' }));
  });

  it('hashes what the store holds the same as loose texts', () => {
    const root = initRoot(tempDir(), { name: 't' });
    writeFileSync(join(root, 'swarm.yaml'), 'swarmup_defs: 1\r\n');
    writeFileSync(join(root, 'agents', 'claude-qa.md'), '---\nid: claude:qa\n---\n');
    const set = loadDefinitions(root);
    expect(set.hash).toBe(
      hashTexts({
        'agents/.gitkeep': '',
        'agents/claude-qa.md': '---\nid: claude:qa\n---\n',
        'swarm.yaml': 'swarmup_defs: 1\n',
      }),
    );
    expect(definitionHash(set.files)).toBe(set.hash);
  });
});

describe('loadDefinitions', () => {
  it('reads the agents of a store without swarm.yaml exactly as before, with no problems', () => {
    const root = initRoot(tempDir(), { name: 't', withAgents: true });
    const set = loadDefinitions(root);
    expect(set.present).toBe(false);
    expect(set.swarm).toBeNull();
    expect(set.agents).toEqual(readAgentFiles(root).agents);
    expect(set.agents.length).toBeGreaterThan(5);
    expect(set.problems).toEqual([]);
    expect(set.ok).toBe(true);
  });

  it('finds no problem in the shipped templates', () => {
    const root = initRoot(tempDir(), { name: 't', withAgents: true });
    writeFileSync(join(root, 'swarm.yaml'), readFileSync(join(TEMPLATES_DIR, 'swarm.yaml')));
    const set = loadDefinitions(root, { strict: true });
    expect(set.problems.map(formatProblem)).toEqual([]);
    expect(set.swarm).not.toBeNull();
  });

  it('keeps only the values of swarm.yaml that apply', () => {
    const root = initRoot(tempDir(), { name: 't' });
    writeFileSync(
      join(root, 'swarm.yaml'),
      [
        'swarmup_defs: 1',
        'defaults: {model: opus, budget_min: 30}',
        'runtimes:',
        '  codex: {model: gpt-5-codex, effort: high}',
        'roles:',
        '  reviewer: {providers: [codex, claude], per_project: 2}',
        'policy: {stuck_runs: 2}',
        'scoring: {sample: 1}',
        '',
      ].join('\n'),
    );
    const set = loadDefinitions(root);
    expect(set.ok).toBe(true);
    expect(set.swarm).toEqual({
      swarmup_defs: 1,
      defaults: { model: 'opus', budget_min: 30 },
      policy: { stuck_runs: 2 },
      runtimes: { codex: { model: 'gpt-5-codex', effort: 'high' } },
      roles: { reviewer: { providers: ['codex', 'claude'], per_project: 2 } },
    });
  });

  it('drops swarm.yaml values with an error and reports agent files by line', () => {
    const root = initRoot(tempDir(), { name: 't' });
    writeFileSync(join(root, 'swarm.yaml'), 'swarmup_defs: 1\nroles:\n  qa: {burst: x}\n');
    writeFileSync(
      join(root, 'agents', 'claude-qa.md'),
      '---\nid: claude:qa\nmodel: --yolo\nruntimes:\n  codex: {model: o3}\n---\nBody\n',
    );
    const set = loadDefinitions(root, { machineRuntimes: ['claude'] });
    expect(set.swarm).toBeNull();
    expect(set.ok).toBe(false);
    const out = set.problems.map((p) =>
      formatProblem({ ...p, file: p.file.slice(root.length + 1) }),
    );
    expect(out).toEqual([
      expect.stringMatching(/^agents[\\/]claude-qa\.md:3:8: error: model: name a model/),
      expect.stringMatching(
        /^agents[\\/]claude-qa\.md:5:3: warning: runtimes\.codex: claude:qa runs on claude; this entry never applies$/,
      ),
      'swarm.yaml:3:15: error: roles.qa.burst: use a whole number of at least 0; got text',
    ]);
  });

  it('flags duplicate ids, providers this machine lacks, folders and secrets', () => {
    const root = initRoot(tempDir(), { name: 't' });
    writeFileSync(
      join(root, 'swarm.yaml'),
      'swarmup_defs: 1\nroles:\n  engineer:\n    providers: [claude, cursor]\n  ghost: {}\n',
    );
    writeFileSync(join(root, 'agents', 'claude-engineer.md'), '---\nid: claude:engineer\n---\n');
    writeFileSync(join(root, 'agents', 'other.md'), '---\nid: claude:engineer\n---\n');
    writeFileSync(join(root, 'agents', 'codex-qa.md'), `---\nstyle: ghp_${'a'.repeat(36)}\n---\n`);
    mkdirSync(join(root, 'agents', 'writer'));
    writeFileSync(join(root, 'agents', 'writer', 'agent.md'), '---\nname: W\n---\n');
    const set = loadDefinitions(root, { machineRuntimes: ['claude', 'codex'], machineAgents: [] });
    const out = set.problems.map((p) => `${p.severity}: ${p.path}: ${p.message}`);
    expect(out).toEqual(
      expect.arrayContaining([
        'error: id: claude:engineer is defined in 2 files; keep one',
        'error: (top): this line looks like a GitHub token; keep secrets in the user config',
        'warning: roles.engineer.providers: this machine has no runtime cursor; add it in Settings > Providers, or this machine skips it',
        'warning: roles.ghost: no agent has the role ghost',
      ]),
    );
    const secret = set.problems.find((p) => p.message.includes('GitHub token'))!;
    expect([secret.line, secret.col]).toEqual([2, 1]);
  });

  it('reads again only when a file changes', () => {
    const root = initRoot(tempDir(), { name: 't' });
    writeFileSync(join(root, 'swarm.yaml'), 'swarmup_defs: 1\n');
    const first = loadDefinitions(root);
    expect(loadDefinitions(root)).toBe(first);
    const before = definitionsFingerprint(root);
    writeFileSync(join(root, 'swarm.yaml'), 'swarmup_defs: 1\nroles: {qa: {burst: 4}}\n');
    expect(definitionsFingerprint(root)).not.toBe(before);
    const second = loadDefinitions(root);
    expect(second).not.toBe(first);
    expect(second.hash).not.toBe(first.hash);
    expect(second.swarm?.roles).toEqual({ qa: { burst: 4 } });
  });
});
