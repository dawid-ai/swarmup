// W5 phase 3: workflows. `workflows/<id>.yaml` compiles to a plan (golden files for the starter
// workflows), parameters fill `{{name}}` and `when` drops stages, gates are a person's (done
// approves, park rejects), a person's start of a `starter` workflow approves it while an agent's
// start is always a proposal, and `work_types` give `swarmup new` its default criteria.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compileWorkflow,
  initRoot,
  loadDefinitions,
  newProject,
  OpsError,
  planYaml,
  readWorkflow,
  readWorkflows,
  TEMPLATES_DIR,
  templateWorkflowIds,
  validatePlan,
  Workspace,
} from '../src/index.js';
import type { WorkflowDef } from '../src/index.js';
import { setup, tempDir } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(here, 'fixtures', 'workflows');

/** Params each starter workflow compiles with for its golden file. */
const GOLDEN_PARAMS: Record<string, Record<string, string>> = {
  feature: { feature: 'export to CSV' },
  bugfix: { bug: 'login fails with a + in the email', severity: 'p1' },
  'content-piece': { piece: 'launch post', channel: 'linkedin' },
  'campaign-launch': { campaign: 'v1 launch', date: '2026-12-15' },
};

function refusal(fn: () => unknown): OpsError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OpsError) return err;
    throw err;
  }
  throw new Error('expected a refusal, but the call passed');
}

/** A store with the starter workflows copied in, as a template's store has them. */
function withStarters(rootDir: string): void {
  mkdirSync(join(rootDir, 'workflows'), { recursive: true });
  for (const id of templateWorkflowIds()) {
    copyFileSync(
      join(TEMPLATES_DIR, 'workflows', `${id}.yaml`),
      join(rootDir, 'workflows', `${id}.yaml`),
    );
  }
}

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

describe('starter workflows', () => {
  it('ship feature, bugfix, content-piece and campaign-launch, and each checks', () => {
    expect(templateWorkflowIds()).toEqual([
      'bugfix',
      'campaign-launch',
      'content-piece',
      'feature',
    ]);
    const root = initRoot(tempDir(), { name: 't', human: 'human:dawid' });
    withStarters(root);
    const set = loadDefinitions(root, { strict: true });
    expect(set.problems).toEqual([]);
    expect(set.workflows.map((w) => w.id)).toEqual([
      'bugfix',
      'campaign-launch',
      'content-piece',
      'feature',
    ]);
    // The definition hash covers workflows.
    expect(set.files.some((f) => f.path === 'workflows/feature.yaml')).toBe(true);
  });

  it('compile to the golden plans', () => {
    const root = initRoot(tempDir(), { name: 't', human: 'human:dawid' });
    withStarters(root);
    const golden = readdirSync(GOLDEN)
      .filter((f) => f.endsWith('.yaml'))
      .sort();
    expect(golden).toEqual(templateWorkflowIds().map((id) => `${id}.yaml`));
    for (const id of templateWorkflowIds()) {
      const compiled = compileWorkflow(readWorkflow(root, id), {
        params: GOLDEN_PARAMS[id],
        human: 'human:dawid',
      });
      const text = [
        `# milestone: ${compiled.milestone.title}`,
        `# done_when: ${JSON.stringify(compiled.milestone.done_when)}`,
        `# approval: ${compiled.approval}`,
        planYaml(compiled.doc),
      ].join('\n');
      expect(text, id).toBe(readFileSync(join(GOLDEN, `${id}.yaml`), 'utf8'));
    }
  });
});

const BASE: WorkflowDef = {
  id: 'demo',
  params: {
    thing: { required: true },
    extra: { default: 'no', options: ['yes', 'no'] },
  },
  milestone: { title: 'Do {{thing}}', done_when: '{{thing}} is done' },
  criteria: { docs: 'The docs for {{thing}} read well' },
  stages: [
    { key: 'a', title: 'Start {{thing}}', owner: '*:engineer', estimate: '1h' },
    {
      key: 'b',
      title: 'Extra for {{thing}}',
      owner: '*:engineer',
      estimate: '1h',
      after: ['a'],
      when: { param: 'extra', equals: 'yes' },
    },
    { key: 'ok', after: ['b'], gate: { ask: 'Is {{thing}} right?', options: ['yes', 'no'] } },
    {
      key: 'c',
      title: 'Write up {{thing}}',
      owner: '*:engineer',
      estimate: '30m',
      type: 'docs',
      after: ['ok'],
      rework: { to: '*:engineer', max: 1 },
    },
  ],
};

describe('compileWorkflow', () => {
  it('fills parameters and defaults, and keeps a stage whose when holds', () => {
    const c = compileWorkflow(BASE, { params: { thing: 'X', extra: 'yes' }, human: 'human:dawid' });
    expect(c.milestone).toEqual({ title: 'Do X', done_when: 'X is done' });
    expect(c.approval).toBe('proposal');
    expect(c.doc.items.map((i) => [i.key, i.title, i.after ?? []])).toEqual([
      ['a', 'Start X', []],
      ['b', 'Extra for X', ['a']],
      ['ok', 'Is X right?', ['b']],
      ['c', 'Write up X', ['ok']],
    ]);
    const gate = c.doc.items.find((i) => i.key === 'ok')!;
    expect(gate).toMatchObject({
      type: 'gate',
      owner: 'human:dawid',
      estimate: '15m',
      gate: { ask: 'Is X right?', options: ['yes', 'no'] },
      done_when: 'A person approved: Is X right?',
    });
    const c2 = c.doc.items.find((i) => i.key === 'c')!;
    expect(c2.done_when).toBe('The docs for X read well');
    expect(c2.body).toContain(
      'Rework: when a check fails, *:engineer reworks this stage, at most 1 round(s)',
    );
    expect(c.doc.notes).toBe('From workflow demo (thing=X, extra=yes).');
  });

  it('drops a stage whose when does not hold, and rewires what waited on it', () => {
    const c = compileWorkflow(BASE, { params: { thing: 'X' }, human: 'human:dawid' });
    expect(c.dropped).toEqual(['b']);
    expect(c.doc.items.find((i) => i.key === 'ok')!.after).toEqual(['a']);
    expect(c.params).toEqual({ human: 'human:dawid', thing: 'X', extra: 'no' });
  });

  it('refuses a missing, unknown or bad parameter, and an unknown {{name}}', () => {
    expect(refusal(() => compileWorkflow(BASE, { human: 'human:dawid' })).message).toBe(
      'workflow demo needs --param thing=...',
    );
    expect(
      refusal(() =>
        compileWorkflow(BASE, { params: { thing: 'X', nope: '1' }, human: 'human:dawid' }),
      ).message,
    ).toBe("workflow demo has no parameter 'nope'; it takes thing, extra");
    expect(
      refusal(() =>
        compileWorkflow(BASE, { params: { thing: 'X', extra: 'maybe' }, human: 'human:dawid' }),
      ).message,
    ).toBe("--param extra: use one of yes, no; got 'maybe'");
    const typo: WorkflowDef = { ...BASE, milestone: { title: 'Do {{thng}}', done_when: 'x' } };
    expect(
      refusal(() => compileWorkflow(typo, { params: { thing: 'X' }, human: 'human:dawid' }))
        .message,
    ).toBe('workflow demo, milestone: {{thng}} names no parameter of the workflow');
  });

  it('runs the plan rules: a gate is a person’s, and after must name a stage', () => {
    const agentGate: WorkflowDef = {
      ...BASE,
      stages: [{ key: 'ok', gate: { ask: 'Fine?', to: 'claude:pm' } }],
    };
    expect(
      refusal(() => compileWorkflow(agentGate, { params: { thing: 'X' }, human: 'human:dawid' }))
        .message,
    ).toBe("item 'ok': a gate is owned by a person (human:<name>), not claude:pm");
    const dangling: WorkflowDef = {
      ...BASE,
      stages: [{ key: 'a', title: 'A', owner: '*:engineer', estimate: '1h', after: ['zz'] }],
    };
    expect(
      refusal(() => compileWorkflow(dangling, { params: { thing: 'X' }, human: 'human:dawid' }))
        .message,
    ).toBe("workflow demo, stage 'a': after names no stage 'zz'");
  });

  it('reports schema and compile problems in validate', () => {
    const root = initRoot(tempDir(), { name: 't', human: 'human:dawid' });
    put(
      root,
      'workflows/bad.yaml',
      'milestone: {title: T, done_when: d}\nstages:\n  - key: a\n    titel: A\n',
    );
    put(root, 'workflows/Bad Name.yaml', 'x: 1\n');
    put(root, 'swarm.yaml', 'swarmup_defs: 1\nwork_types:\n  - types: [bug]\n    workflow: nope\n');
    const out = loadDefinitions(root).problems.map(
      (p) =>
        `${p.severity}: ${p.file.slice(root.length + 1).replace(/\\/g, '/')}: ${p.path}: ${p.message}`,
    );
    expect(out).toEqual(
      expect.arrayContaining([
        "warning: workflows/bad.yaml: stages[0].titel: unknown key 'titel'; did you mean 'title'?",
        "error: workflows/bad.yaml: (top): workflow bad, stage 'a' has no title",
        'warning: workflows/Bad Name.yaml: (top): a workflow is workflows/<id>.yaml, with an id of lowercase letters, digits and dashes; this file is not read',
        'warning: swarm.yaml: work_types.0.workflow: no workflows/nope.yaml in this store',
      ]),
    );
    expect(readWorkflows(root).find((w) => w.id === 'bad')!.def).toBeNull();
  });
});

/** A store with the demo workflow and a human; `approval` as given. */
function world(approval: 'proposal' | 'starter' = 'proposal') {
  const w = setup();
  const def = [
    'params:',
    '  thing: {required: true}',
    'milestone:',
    "  title: 'Do {{thing}}'",
    "  done_when: '{{thing}} is done'",
    `approval: ${approval}`,
    'stages:',
    "  - {key: draft, title: 'Draft {{thing}}', owner: 'claude:engineer', estimate: 1h}",
    '  - key: ok',
    '    after: draft',
    "    gate: {ask: 'Is {{thing}} right?'}",
    "  - {key: ship, title: 'Ship {{thing}}', owner: 'claude:engineer', estimate: 1h, after: ok}",
    "  - {key: tell, title: 'Tell about {{thing}}', owner: 'claude:engineer', estimate: 1h, after: ship}",
    '',
  ].join('\n');
  put(w.rootDir, 'workflows/demo.yaml', def);
  put(
    w.rootDir,
    'workflows/revise.yaml',
    def.replace(
      "gate: {ask: 'Is {{thing}} right?'}",
      "gate: {ask: 'Is {{thing}} right?', on_reject: revise}",
    ),
  );
  const h = w.as('human:dawid');
  return { ...w, h };
}

/** The plan task of `key` in milestone `ms`. */
function taskOf(h: ReturnType<typeof world>['h'], ms: string, key: string) {
  return h.list({ all: true }).find((v) => v.meta.plan_item === `${ms}#${key}`)!;
}

describe('workflow start', () => {
  it('records the workflow and the definition hash, and a starter start by a person approves it', () => {
    const { h, rootDir } = world('starter');
    const res = h.workflowStart('demo', { params: { thing: 'X' } });
    const meta = h.view(res.milestone.id).meta;
    expect(meta).toMatchObject({ type: 'milestone', title: 'Do X', workflow: 'demo' });
    expect(meta.defs_hash).toBe(loadDefinitions(rootDir).hash);
    expect(meta.done_when).toEqual(['X is done']);
    expect(res.approved).toBeDefined();
    expect(res.approved!.created.map((c) => c.key)).toEqual(['draft', 'ok', 'ship', 'tell']);
    const gate = taskOf(h, res.milestone.id, 'ok');
    expect(gate.meta).toMatchObject({
      type: 'gate',
      owner: 'human:dawid',
      gate: { ask: 'Is X right?' },
    });
    expect(h.showEvents(gate.meta.id).body).toContain('**Gate:** Is X right?');
  });

  it('is a proposal when the workflow says so, or when an agent starts it', () => {
    const { h, as } = world('starter');
    const agent = as('claude:pm').workflowStart('demo', { params: { thing: 'Y' } });
    expect(agent.approved).toBeUndefined();
    expect(h.view(agent.milestone.id).plan?.pending).toBeTruthy();
    expect(h.inbox().some((i) => i.task === agent.milestone.id && i.plan)).toBe(true);
    const { h: h2 } = world('proposal');
    const person = h2.workflowStart('demo', { params: { thing: 'Z' }, title: 'Own title' });
    expect(person.approved).toBeUndefined();
    expect(person.milestone.title).toBe('Own title');
    expect(h2.view(person.milestone.id).plan?.pending).toBeTruthy();
  });

  it('proposes a workflow for a held milestone with plan propose --workflow', () => {
    const { h, as } = world();
    const ms = h.newTask({
      title: 'M',
      type: 'milestone',
      doneWhen: ['it works'],
      owner: 'claude:pm',
    }).id;
    const pm = as('claude:pm');
    pm.claim(ms);
    pm.start(ms, 'plan it');
    const res = pm.planProposeWorkflow(ms, 'demo', { params: { thing: 'W' } });
    const plan = h.planShow(ms);
    expect(plan.pending?.items.map((i) => i.key)).toEqual(['draft', 'ok', 'ship', 'tell']);
    expect(
      res.events.some((e) => e.type === 'plan' && e.body.includes('Workflow demo (definitions d:')),
    ).toBe(true);
  });
});

describe('gates', () => {
  it('hold the stages after them until the person approves with done', () => {
    const { h, as } = world('starter');
    const ms = h.workflowStart('demo', { params: { thing: 'X' } }).milestone.id;
    const draft = taskOf(h, ms, 'draft');
    const gate = taskOf(h, ms, 'ok');
    const ship = taskOf(h, ms, 'ship');
    expect(h.view(ship.meta.id).unblocked).toBe(false);
    expect(h.inbox().some((i) => i.kind === 'gate')).toBe(false);
    // Approving before the stage it waits for is done would start `ship` on no draft.
    expect(() => h.done(gate.meta.id, 'early')).toThrow(/waits for/);
    h.done(draft.meta.id, 'drafted');
    // The gate waits for the person now.
    const item = h.inbox().find((i) => i.kind === 'gate')!;
    expect(item).toMatchObject({ task: gate.meta.id, gate: { ask: 'Is X right?' }, milestone: ms });
    // No agent answers a gate, by claim or by done.
    const eng = as('claude:engineer');
    expect(() => eng.claim(gate.meta.id)).toThrow(/human:dawid/);
    expect(() => eng.done(gate.meta.id)).toThrow(/only a person can approve it/);
    expect(() => as('human:dawid', { run: '01RUN' }).done(gate.meta.id)).toThrow(/outside any run/);
    // Neither --force nor a retype by the PM turns the gate into work an agent closes.
    expect(() => as('claude:engineer', { force: true }).claim(gate.meta.id)).toThrow(
      /a gate is a person's decision/,
    );
    expect(() => as('claude:pm').retype(gate.meta.id, 'task', 'mine now')).toThrow(
      /only a person changes its type/,
    );
    // Another person decides a gate that asks dawid only with --force.
    expect(() => as('human:alex').done(gate.meta.id)).toThrow(/asks human:dawid/);
    h.done(gate.meta.id, 'yes');
    expect(h.view(gate.meta.id).status).toBe('done');
    expect(h.view(ship.meta.id).unblocked).toBe(true);
    expect(h.inbox().some((i) => i.kind === 'gate')).toBe(false);
  });

  it('park the gate and every stage after it, and the milestone, on a park rejection', () => {
    const { h } = world('starter');
    const ms = h.workflowStart('demo', { params: { thing: 'X' } }).milestone.id;
    h.done(taskOf(h, ms, 'draft').meta.id);
    const gate = taskOf(h, ms, 'ok').meta.id;
    expect(() => h.park(gate, '')).toThrow(/say why/);
    h.park(gate, 'not what we need');
    for (const key of ['ok', 'ship', 'tell']) {
      expect(h.view(taskOf(h, ms, key).meta.id).status, key).toBe('parked');
    }
    expect(h.view(taskOf(h, ms, 'draft').meta.id).status).toBe('done');
    expect(h.view(ms).status).toBe('parked');
    expect(h.showEvents(gate).events.at(-1)!.body.trim()).toBe('Rejected: not what we need');
  });

  it('reopen the work before the gate on a revise rejection, and ask again after it', () => {
    const { h } = world('starter');
    const ms = h.workflowStart('revise', { params: { thing: 'X' } }).milestone.id;
    const draft = taskOf(h, ms, 'draft').meta.id;
    const gate = taskOf(h, ms, 'ok').meta.id;
    h.done(draft);
    h.park(gate, 'tighten the intro');
    expect(h.view(gate).status).not.toBe('parked');
    expect(h.view(draft).status).toBe('todo');
    expect(h.view(gate).unblocked).toBe(false);
    expect(h.showEvents(gate).events.at(-1)!.body.trim()).toBe(
      'Sent back for revision: tighten the intro',
    );
    expect(h.showEvents(draft).events.at(-1)!.body).toContain('sent this back: tighten the intro');
    expect(h.inbox().some((i) => i.kind === 'gate')).toBe(false);
    h.done(draft, 'tightened');
    expect(h.inbox().find((i) => i.kind === 'gate')?.task).toBe(gate);
  });

  it('read and check as plan items: a hand-written gate gets its title as the question', () => {
    const doc = {
      items: [
        { key: 'a', title: 'A', owner: 'claude:engineer', estimate: '1h' },
        {
          key: 'g',
          title: 'Fine?',
          owner: 'claude:pm',
          estimate: '15m',
          type: 'gate',
          after: ['a'],
        },
      ],
    };
    expect(() => validatePlan(doc, 'proposal', null)).toThrow(/a gate is owned by a person/);
  });
});

describe('work_types', () => {
  it('give a task filed without criteria the default ones, and name the workflow', () => {
    const { h, rootDir } = world();
    put(
      rootDir,
      'swarm.yaml',
      [
        'swarmup_defs: 1',
        'work_types:',
        '  - types: [bug]',
        '    workflow: demo',
        "    done_when: ['A test reproduces it and passes with the fix']",
        '  - labels: [ui]',
        '    done_when: [{id: shot, kind: human, ask: Does the screen look right?}]',
        '',
      ].join('\n'),
    );
    const bug = h.addTask({ title: 'Crash', type: 'bug' });
    expect(bug.meta.done_when).toEqual(['A test reproduces it and passes with the fix']);
    expect(bug.notes).toContain('this kind of work has a workflow: swarmup workflow start demo');
    const ui = h.addTask({ title: 'Button', labels: ['ui'] });
    expect(ui.meta.done_when).toEqual([
      { id: 'shot', kind: 'human', ask: 'Does the screen look right?' },
    ]);
    // Criteria given win, and a task of no kind keeps the defaults it had.
    const own = h.addTask({ title: 'Crash 2', type: 'bug', doneWhen: ['npm test passes'] });
    expect(own.meta.done_when).toEqual(['npm test passes']);
    const plain = h.addTask({ title: 'Other' });
    expect(plain.meta.done_when).toBeUndefined();
  });
});

describe('content-piece on a campaign project', () => {
  it('comes with new-project --template campaign and runs brief, gate, draft, publish', () => {
    const top = tempDir();
    const env = { SWARMUP_CONFIG: join(top, 'no-user-config.yml') } as NodeJS.ProcessEnv;
    const res = newProject(join(top, 'launch'), 'campaign', {
      actor: 'human:dawid',
      human: 'human:dawid',
      env,
      tasks: [],
    });
    const store = join(top, 'launch', '.swarmup');
    expect(readdirSync(join(store, 'workflows')).sort()).toEqual([
      'campaign-launch.yaml',
      'content-piece.yaml',
    ]);
    expect(res.dir).toBe(store);
    const h = new Workspace({ cwd: join(top, 'launch'), env, actor: 'human:dawid' });
    const started = h.workflowStart('content-piece', {
      params: { piece: 'launch post', channel: 'x' },
    });
    expect(started.approved).toBeUndefined();
    h.planApprove(started.milestone.id);
    const ms = started.milestone.id;
    const brief = taskOf(h as never, ms, 'brief');
    const gate = taskOf(h as never, ms, 'brief-ok');
    const draft = taskOf(h as never, ms, 'draft');
    const publish = taskOf(h as never, ms, 'publish');
    expect(brief.meta.owner).toBe('*:writer');
    expect(gate.meta).toMatchObject({ type: 'gate', owner: 'human:dawid' });
    expect(draft.meta).toMatchObject({ type: 'content', review: 'codex:editor' });
    expect(draft.meta.done_when).toEqual([
      { id: 'voice', kind: 'rubric', rubric: 'rubrics/brand-voice.md', pass: 0.7 },
    ]);
    expect(publish.meta).toMatchObject({ type: 'publish', owner: 'human:dawid' });
    expect(publish.meta.blocked_by).toEqual([draft.meta.id]);
    expect(draft.meta.blocked_by).toEqual([gate.meta.id]);
  });
});
