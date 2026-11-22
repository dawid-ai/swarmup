// W5 phase 2: agent folders. `agents/<role>/agent.md` expands into one agent per provider, a
// runtime addendum overlays it, a legacy file of the same id wins with a warning, `id` is refused
// in folder files, writes follow where the agent lives, `swarmup defs migrate` moves legacy files
// into folders only when the result is the same agent set, and variants overlay folders.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentDifferences,
  agentText,
  applyMigration,
  clearDefinitionsCache,
  initRoot,
  loadDefinitions,
  overlayAgents,
  planMigration,
  readAgentFiles,
  Root,
  writeAgent,
} from '../src/index.js';
import { tempDir } from './helpers.js';

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const WRITER = [
  '---',
  'name: Writer',
  'kb: [voice]',
  'style: Plain.',
  'runtimes:',
  '  codex: { effort: high }',
  '---',
  '',
  'Write the drafts.',
  '',
].join('\n');

function store(): string {
  return initRoot(tempDir(), { name: 't' });
}

const byId = (dir: string) => new Map(readAgentFiles(dir).agents.map((a) => [a.id, a] as const));

describe('agent folders', () => {
  it('expand into the default providers without swarm.yaml', () => {
    const dir = store();
    put(dir, 'agents/writer/agent.md', WRITER);
    const agents = byId(dir);
    expect([...agents.keys()].sort()).toEqual(['claude:writer', 'codex:writer']);
    const w = agents.get('codex:writer')!;
    expect(w).toMatchObject({
      role: 'writer',
      name: 'Writer',
      kb: ['voice'],
      status: 'active',
      providers: ['claude', 'codex'],
      folder: { role: 'writer', providersFrom: 'default' },
      file: join(dir, 'agents', 'writer', 'agent.md'),
    });
    expect(w.body.trim()).toBe('Write the drafts.');
  });

  it('take providers from the file, then swarm.yaml roles, then swarm.yaml runtimes', () => {
    const dir = store();
    put(dir, 'agents/writer/agent.md', WRITER);
    put(dir, 'swarm.yaml', 'swarmup_defs: 1\nruntimes:\n  claude: {model: opus}\n');
    expect([...byId(dir).keys()]).toEqual(['claude:writer']);
    expect(byId(dir).get('claude:writer')!.folder!.providersFrom).toBe('swarm-runtimes');
    put(
      dir,
      'swarm.yaml',
      'swarmup_defs: 1\nruntimes:\n  claude: {}\nroles:\n  writer: {providers: [codex]}\n',
    );
    expect([...byId(dir).keys()]).toEqual(['codex:writer']);
    expect(byId(dir).get('codex:writer')!.folder!.providersFrom).toBe('swarm-role');
    put(
      dir,
      'agents/writer/agent.md',
      WRITER.replace('name: Writer', 'name: Writer\nproviders: [cursor, claude]'),
    );
    expect([...byId(dir).keys()]).toEqual(['cursor:writer', 'claude:writer']);
    expect(byId(dir).get('claude:writer')!.folder!.providersFrom).toBe('agent');
  });

  it('overlay a runtime addendum: maps merge, lists replace, null deletes, body appends', () => {
    const dir = store();
    put(dir, 'agents/writer/agent.md', WRITER);
    put(
      dir,
      'agents/writer/codex.md',
      '---\nkb: [voice, claims]\nstyle: null\nruntimes:\n  codex: { model: o3 }\n---\n\nKeep it short.\n',
    );
    const agents = byId(dir);
    const codex = agents.get('codex:writer')!;
    expect(codex.kb).toEqual(['voice', 'claims']);
    expect(codex.style).toBeUndefined();
    expect(codex.runtimes).toEqual({ codex: { effort: 'high', model: 'o3' } });
    expect(codex.body).toBe('Write the drafts.\n\nKeep it short.\n');
    expect(codex.folder).toMatchObject({
      addendum: join(dir, 'agents', 'writer', 'codex.md'),
      bodyMode: 'append',
    });
    // The other runtime reads agent.md alone.
    expect(agents.get('claude:writer')!.kb).toEqual(['voice']);
    expect(agents.get('claude:writer')!.folder!.addendum).toBeUndefined();
  });

  it('replace the body with body: replace, and render the agent as one file', () => {
    const dir = store();
    put(dir, 'agents/writer/agent.md', WRITER);
    put(dir, 'agents/writer/claude.md', '---\nbody: replace\nstatus: paused\n---\n\nOnly this.\n');
    const claude = byId(dir).get('claude:writer')!;
    expect(claude.body.trim()).toBe('Only this.');
    expect(claude.status).toBe('paused');
    const text = agentText(claude);
    expect(text).toContain('id: claude:writer');
    expect(text).toContain('status: paused');
    expect(text).not.toContain('providers');
    expect(text.trim().endsWith('Only this.')).toBe(true);
  });

  it('refuse id in folder files and skip only that agent', () => {
    const dir = store();
    put(dir, 'agents/writer/agent.md', `---\nid: claude:writer\n---\nx\n`);
    put(dir, 'agents/editor/agent.md', '---\nname: E\n---\n');
    put(dir, 'agents/editor/codex.md', '---\nid: codex:editor\n---\n');
    const files = readAgentFiles(dir);
    expect(files.agents.map((a) => a.id)).toEqual(['claude:editor']);
    expect(files.problems.map((p) => p.message)).toEqual(
      [
        'id is refused in an agent folder: agents/editor/codex.md is codex:editor',
        'id is refused in an agent folder: the folder agents/writer/ names the role',
      ].sort((a, b) => (a.includes('writer') ? 1 : b.includes('writer') ? -1 : 0)),
    );
    const set = loadDefinitions(dir);
    const out = set.problems.map((p) => `${p.severity}: ${p.path}: ${p.message}`);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^error: id: id is refused in an agent folder/),
      ]),
    );
  });

  it('lose to a legacy file of the same id, with a warning on the folder', () => {
    const dir = store();
    put(dir, 'agents/writer/agent.md', WRITER);
    put(dir, 'agents/claude-writer.md', '---\nname: Old writer\n---\nOld.\n');
    const files = readAgentFiles(dir);
    const claude = files.agents.find((a) => a.id === 'claude:writer')!;
    expect(claude.name).toBe('Old writer');
    expect(claude.folder).toBeUndefined();
    expect(files.agents.find((a) => a.id === 'codex:writer')!.folder).toBeDefined();
    expect(files.shadowed).toEqual([
      {
        id: 'claude:writer',
        file: join(dir, 'agents', 'writer', 'agent.md'),
        by: join(dir, 'agents', 'claude-writer.md'),
      },
    ]);
    const warning = loadDefinitions(dir).problems.find((p) => p.message.includes('which wins'));
    expect(warning).toMatchObject({
      severity: 'warning',
      file: join(dir, 'agents', 'writer', 'agent.md'),
      message:
        'claude:writer is also defined in agents/claude-writer.md, which wins; remove it, or run swarmup defs migrate --prune',
    });
  });

  it('validate addenda, folder names and keys that belong elsewhere', () => {
    const dir = store();
    put(dir, 'swarm.yaml', 'swarmup_defs: 1\nruntimes:\n  claude: {}\n');
    put(dir, 'agents/writer/agent.md', '---\nrole: author\nruntimes:\n  codex: {model: o3}\n---\n');
    put(dir, 'agents/writer/codex.md', '---\nproviders: [codex]\n---\n');
    put(dir, 'agents/writer/Notes.md', '---\nname: n\n---\n');
    put(dir, 'agents/lonely/claude.md', '---\nname: L\n---\n');
    put(dir, 'agents/claude-qa.md', '---\nproviders: [claude]\nrole: tester\n---\n');
    const out = loadDefinitions(dir).problems.map(
      (p) =>
        `${p.severity}: ${p.file.slice(dir.length + 1).replace(/\\/g, '/')}: ${p.path}: ${p.message}`,
    );
    expect(out).toEqual(
      expect.arrayContaining([
        'error: agents/writer/codex.md: providers: providers belongs in agent.md, where it names every runtime of the role',
        'warning: agents/writer/codex.md: (top): agents/writer/ expands into claude; add codex to its providers, or this addendum never applies',
        'warning: agents/writer/agent.md: role: the folder agents/writer/ names the role; role author is not read',
        'warning: agents/writer/agent.md: runtimes.codex: the role writer does not run on codex; this entry never applies',
        'warning: agents/writer/Notes.md: (top): neither agent.md nor a runtime addendum (<runtime>.md); this file is not read',
        'warning: agents/lonely/claude.md: (top): agents/lonely/ has no agent.md, so this addendum is not read',
        'warning: agents/claude-qa.md: providers: providers applies to agent folders (agents/<role>/agent.md); a legacy file defines one agent, so it is not read',
        'warning: agents/claude-qa.md: role: claude:qa has the role qa; role tester is not read',
      ]),
    );
    expect(out.some((p) => p.includes('not active yet'))).toBe(false);
  });
});

describe('writing folder agents', () => {
  it('writes a new role to a legacy file without swarmup_defs, and to a folder with it', () => {
    const dir = store();
    const root = new Root(dir);
    writeAgent(root, { id: 'claude:writer', name: 'W', instructions: 'Draft.' });
    expect(existsSync(join(dir, 'agents', 'claude-writer.md'))).toBe(true);
    put(dir, 'swarm.yaml', 'swarmup_defs: 1\n');
    const def = writeAgent(root, { id: 'codex:editor', name: 'E', instructions: 'Edit.' });
    expect(readFileSync(join(dir, 'agents', 'editor', 'agent.md'), 'utf8')).toBe(
      '---\nproviders:\n  - codex\nstatus: active\nname: E\n---\n\nEdit.\n',
    );
    expect(def).toMatchObject({ id: 'codex:editor', folder: { providersFrom: 'agent' } });
  });

  it('edits agent.md by default and the addendum with scope runtime', () => {
    const dir = store();
    const root = new Root(dir);
    put(
      dir,
      'agents/writer/agent.md',
      WRITER.replace('name: Writer', 'name: Writer\ntools: [Read]'),
    );
    writeAgent(root, {
      id: 'claude:writer',
      description: 'Drafts posts',
      instructions: 'New body.',
    });
    const head = readFileSync(join(dir, 'agents', 'writer', 'agent.md'), 'utf8');
    expect(head).toContain('description: Drafts posts');
    expect(head).toContain('tools:');
    expect(byId(dir).get('codex:writer')!.description).toBe('Drafts posts');
    writeAgent(
      root,
      { id: 'codex:writer', style: 'Terse.', instructions: 'Codex only.' },
      { scope: 'runtime' },
    );
    expect(readFileSync(join(dir, 'agents', 'writer', 'codex.md'), 'utf8')).toBe(
      '---\nstyle: Terse.\n---\n\nCodex only.\n',
    );
    const agents = byId(dir);
    expect(agents.get('codex:writer')!.style).toBe('Terse.');
    expect(agents.get('codex:writer')!.body).toBe('New body.\n\nCodex only.\n');
    expect(agents.get('claude:writer')!.style).toBe('Plain.');
  });

  it('adds a new runtime to an existing folder with its own values in its addendum', () => {
    const dir = store();
    const root = new Root(dir);
    put(
      dir,
      'agents/writer/agent.md',
      WRITER.replace('name: Writer', 'name: Writer\nproviders: [claude]'),
    );
    writeAgent(root, { id: 'codex:writer', name: 'Writer', style: 'Terse.' }, { create: true });
    expect(readFileSync(join(dir, 'agents', 'writer', 'agent.md'), 'utf8')).toContain(
      'providers:\n  - claude\n  - codex',
    );
    expect(readFileSync(join(dir, 'agents', 'writer', 'codex.md'), 'utf8')).toBe(
      '---\nstyle: Terse.\n---\n',
    );
    expect(() => writeAgent(root, { id: 'codex:writer' }, { create: true })).toThrow(
      /already has a role file/,
    );
  });

  it('keeps editing a legacy file where it is', () => {
    const dir = store();
    put(dir, 'swarm.yaml', 'swarmup_defs: 1\n');
    put(dir, 'agents/other.md', '---\nid: claude:qa\ntools: [Read]\n---\nCheck.\n');
    writeAgent(new Root(dir), { id: 'claude:qa', name: 'QA' });
    expect(readFileSync(join(dir, 'agents', 'other.md'), 'utf8')).toContain('name: QA');
    expect(existsSync(join(dir, 'agents', 'qa'))).toBe(false);
  });
});

const LEGACY = {
  'agents/claude-writer.md':
    '---\nid: claude:writer\nname: Writer\nkb: [voice]\nmodel: opus\ntools: [Read, Edit]\n---\n\nWrite the drafts.\n',
  'agents/codex-writer.md':
    '---\nname: Writer\nkb: [voice]\neffort: high\ntools: [Read, Edit]\n---\n\nWrite the drafts.\n',
  'agents/cursor-writer.md':
    '---\nname: Writer\nkb: [voice]\ntools: [Read, Edit]\nstatus: paused\n---\n\nWrite in the editor.\n',
  'agents/claude-qa.md': '---\ncan_claim: [test]\n---\n\nCheck.\n',
};

function legacyStore(): string {
  const dir = store();
  for (const [path, text] of Object.entries(LEGACY)) put(dir, path, text);
  put(dir, 'swarm.yaml', 'swarmup_defs: 1\n');
  return dir;
}

describe('swarmup defs migrate', () => {
  it('plans folders that give every agent the same fields', () => {
    const dir = legacyStore();
    const plan = planMigration(dir);
    expect(plan.refused).toEqual([]);
    expect(plan.agents).toEqual(['claude:qa', 'claude:writer', 'codex:writer', 'cursor:writer']);
    expect(plan.legacy).toEqual(Object.keys(LEGACY).sort());
    expect(plan.writes).toEqual({
      'agents/qa/agent.md': '---\nproviders:\n  - claude\ncan_claim:\n  - test\n---\n\nCheck.\n',
      'agents/writer/agent.md':
        '---\nproviders:\n  - claude\n  - codex\n  - cursor\nname: Writer\nkb:\n  - voice\ntools:\n  - Read\n  - Edit\n---\n\nWrite the drafts.\n',
      'agents/writer/claude.md': '---\nmodel: opus\n---\n',
      'agents/writer/codex.md': '---\neffort: high\n---\n',
      'agents/writer/cursor.md':
        '---\nstatus: paused\nbody: replace\n---\n\nWrite in the editor.\n',
    });
  });

  it('round-trips: after --prune the store reads the same agents', () => {
    const dir = legacyStore();
    const before = byId(dir);
    const plan = planMigration(dir);
    const done = applyMigration(plan, { prune: true });
    expect(done.removed).toEqual(Object.keys(LEGACY).sort());
    clearDefinitionsCache();
    const after = byId(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, was] of before) {
      expect(agentDifferences(was, after.get(id))).toEqual([]);
      expect(after.get(id)!.folder).toBeDefined();
    }
    expect(loadDefinitions(dir).problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(planMigration(dir).agents).toEqual([]);
  });

  it('keeps the legacy files without --prune, and they shadow the folders', () => {
    const dir = legacyStore();
    applyMigration(planMigration(dir));
    expect(existsSync(join(dir, 'agents', 'claude-writer.md'))).toBe(true);
    expect(readAgentFiles(dir).shadowed).toHaveLength(4);
  });

  it('removes the legacy files with --prune after an --apply that kept them', () => {
    const dir = legacyStore();
    applyMigration(planMigration(dir));
    clearDefinitionsCache();
    const again = planMigration(dir);
    expect(again.refused).toEqual([]);
    expect(again.writes).toEqual({});
    expect(again.legacy).toEqual(Object.keys(LEGACY).sort());
    expect(applyMigration(again, { prune: true }).removed).toEqual(Object.keys(LEGACY).sort());
    clearDefinitionsCache();
    expect(readAgentFiles(dir).shadowed).toHaveLength(0);
  });

  it('leaves legacy files that differ from an existing folder alone', () => {
    const dir = legacyStore();
    applyMigration(planMigration(dir));
    put(
      dir,
      'agents/claude-qa.md',
      LEGACY['agents/claude-qa.md']!.replace('Check.', 'Check twice.'),
    );
    clearDefinitionsCache();
    const again = planMigration(dir);
    expect(again.legacy).not.toContain('agents/claude-qa.md');
    expect(again.skipped).toEqual([expect.stringMatching(/^qa: agents\/qa\/ exists and differs/)]);
  });

  it('refuses when a legacy file does not read, and without swarmup_defs', () => {
    const dir = legacyStore();
    put(dir, 'agents/claude-pm.md', '---\ncan_claim: nope\n---\n');
    const plan = planMigration(dir);
    expect(plan.refused).toEqual([
      expect.stringMatching(/^agents\/claude-pm\.md does not read \(can_claim: use a list/),
    ]);
    expect(() => applyMigration(plan)).toThrow(/the migration refuses/);
    const other = store();
    put(other, 'agents/claude-qa.md', LEGACY['agents/claude-qa.md']);
    expect(() => applyMigration(planMigration(other))).toThrow(/swarmup_defs: 1/);
  });

  it('refuses a plan whose folders would differ from the legacy files', () => {
    const dir = legacyStore();
    const plan = planMigration(dir);
    plan.writes['agents/writer/codex.md'] = '---\neffort: low\n---\n';
    // The check runs when the plan is made; a changed plan is checked by agentDifferences.
    const was = byId(dir).get('codex:writer')!;
    expect(agentDifferences(was, { ...was, effort: 'low', body: was.body })).toEqual([
      'codex:writer: effort is "high" in the legacy file, "low" from the folder',
    ]);
    expect(agentDifferences(was, undefined)).toEqual([
      'codex:writer: the folders define no such agent',
    ]);
  });

  it('skips a role whose existing folder differs from its legacy files', () => {
    const dir = legacyStore();
    put(dir, 'agents/qa/agent.md', '---\nproviders: [codex]\n---\n');
    const plan = planMigration(dir);
    expect(plan.skipped).toEqual([
      expect.stringMatching(/^qa: agents\/qa\/ exists and differs from its legacy files/),
    ]);
    expect(plan.agents).not.toContain('claude:qa');
  });
});

describe('variants over agent folders', () => {
  it('overlay agents/<role>/agent.md and addenda', () => {
    const dir = store();
    put(dir, 'swarm.yaml', 'swarmup_defs: 1\n');
    put(
      dir,
      'agents/writer/agent.md',
      WRITER.replace('name: Writer', 'name: Writer\nproviders: [claude, codex]'),
    );
    put(dir, 'variants/terse/agents/writer/agent.md', '---\nstyle: Terse.\n---\n\nWrite less.\n');
    put(dir, 'variants/terse/agents/writer/codex.md', '---\neffort: low\n---\n');
    const set = loadDefinitions(dir, { variant: 'terse' });
    expect(set.ok).toBe(true);
    const claude = set.agents.find((a) => a.id === 'claude:writer')!;
    const codex = set.agents.find((a) => a.id === 'codex:writer')!;
    expect(claude.style).toBe('Terse.');
    expect(claude.body.trim()).toBe('Write less.');
    expect(claude.kb).toEqual(['voice']);
    expect(claude.file).toBe(join(dir, 'variants', 'terse', 'agents', 'writer', 'agent.md'));
    expect(codex.effort).toBe('low');
    expect(codex.folder!.addendum).toBe(
      join(dir, 'variants', 'terse', 'agents', 'writer', 'codex.md'),
    );
    // The base is unchanged.
    expect(byId(dir).get('claude:writer')!.style).toBe('Plain.');
    expect(
      overlayAgents(
        new Map([
          ['agents/writer/agent.md', ''],
          ['agents/writer/codex.md', ''],
          ['agents/claude-qa.md', ''],
        ]),
      ),
    ).toEqual(['*:writer', 'claude:qa', 'codex:writer']);
  });
});
