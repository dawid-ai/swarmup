import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Workspace } from '@swarmup/core';
import type { RunRecord, UsageState } from '../src/index.js';
import { chatPrompt, runPrompt, Supervisor, WATCH_ACTOR } from '../src/index.js';
import { until } from './until.js';
import { ended, FAKE_AGENT, setup, temp } from './supervisor-setup.js';

describe('runs', () => {
  it('claims, runs the agent to the end and records the run on the task', async () => {
    const { sup, as } = setup();
    as('human:dawid').newTask({ title: 'fake work', owner: 'fake:engineer' });
    const run = await sup.launchFresh({ agent: 'fake:engineer', task: 'T-0001' });
    expect(as('human:dawid').view('1').claimedBy).toBe('fake:engineer');
    expect(() => sup.launch({ agent: 'fake:engineer' })).toThrow(
      /1 engineer run\(s\) live on test; per_project is 1/,
    );
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'T-0001' })).toThrow(
      /T-0001 already has a live run/,
    );
    const r = await ended(sup, run.id);
    expect(r).toMatchObject({ exit: 0, reason: 'exit', tokens: 150 });
    const v = as('human:dawid').view('1');
    expect(v.status).toBe('done');
    const types = as('human:dawid')
      .showEvents('1')
      .events.map((e) => e.type);
    expect(types).toEqual(['claim', 'run-start', 'start', 'done', 'run-end']);
    expect(readFileSync(r.log, 'utf8')).toContain('"output_tokens":50');
    expect(sup.runs()[0]!.id).toBe(run.id);
  });

  it("puts matching learn notes in a task run's prompt and records them as shown (AO-0049)", async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const { sup, as } = setup({ env: { FAKE_PROMPT: promptFile } });
    const human = as('human:dawid');
    human.newTask({
      title: 'killTree: taskkill refused leaves the run tree alive',
      owner: 'fake:engineer',
    });
    as('fake:engineer').learn({
      topic: 'windows',
      title: 'Taskkill refused leaves the process tree alive',
      body: 'Use a job object.',
    });
    const run = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    await ended(sup, run.id);
    expect(readFileSync(promptFile, 'utf8')).toContain(
      '- `windows/taskkill-refused-leaves-the-process-tree-alive`: Taskkill refused leaves the ' +
        'process tree alive',
    );
    expect(human.kbUsage().notes).toEqual([
      expect.objectContaining({
        shown: 1,
        reads: 0,
        note: expect.objectContaining({ root: 'test' }),
      }),
    ]);
  });

  it("lists the decisions in force for a task in its run's prompt (AO-0109)", async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const { sup, as } = setup({ env: { FAKE_PROMPT: promptFile } });
    const human = as('human:dawid');
    for (const project of ['p', 'q', 'r', 'p']) {
      human.newTask({ title: `work in ${project}`, project, owner: 'fake:engineer' });
    }
    const old = human.recordDecision({ text: 'swarmupd never merges', project: 'p' }).meta.id;
    const fresh = human.recordDecision({
      text: 'swarmupd merges approved work',
      project: 'p',
      supersedes: [old],
    }).meta.id;
    for (let i = 1; i <= 31; i++) human.recordDecision({ text: `rule ${i} of r`, project: 'r' });
    const promptOf = async (req: { task?: string; extra?: string }): Promise<string> => {
      await ended(sup, (await sup.launchFresh({ agent: 'fake:engineer', ...req })).id);
      return readFileSync(promptFile, 'utf8');
    };

    // Inside the scope: the replacement is listed, the superseded record is not.
    const inScope = await promptOf({ task: '1' });
    expect(inScope).toMatch(
      new RegExp(
        '\\nDecisions in force for T-0001 \\(follow them; newest first\\):\\n' +
          `- ${fresh} \\(\\d{4}-\\d{2}-\\d{2}\\): swarmupd merges approved work\\n` +
          "If your plan or a choice you are about to make conflicts with one, don't work around it:\\n" +
          `finish with \`swarmup ask T-0001 "contradiction with ${fresh}: \\.\\.\\."\`\\.\\n` +
          '\\nRules for supervised runs:',
      ),
    );
    expect(inScope).not.toContain('swarmupd never merges');
    // Outside every scope: no list.
    expect(await promptOf({ task: '2' })).not.toContain('Decisions in force');
    // 31 decisions: the newest 30, then how to list the rest.
    const capped = await promptOf({ task: '3' });
    expect(capped.split('\n').filter((l) => /^- D-\d+ \(/.test(l))).toHaveLength(30);
    expect(capped).toContain('): rule 31 of r\n');
    expect(capped).toContain('): rule 2 of r\n1 more: swarmup decisions --log --task T-0003\nIf ');
    expect(capped).not.toContain('): rule 1 of r\n');
    // A schedule with a task carries the list with its own instructions.
    const scheduled = await promptOf({ task: '4', extra: 'Write the digest.' });
    expect(scheduled).toContain('Write the digest.\n\nDecisions in force for T-0004 ');
    // An inbox run has no task, so no list.
    expect(await promptOf({})).not.toContain('Decisions in force');
  });

  it('frees the task when the run ends without finishing', async () => {
    const { sup, as } = setup({ mode: 'crash' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const r = await ended(sup, (await sup.launchFresh({ agent: 'fake:engineer', task: '1' })).id);
    expect(r).toMatchObject({ exit: 3, reason: 'exit' });
    const { events } = as('human:dawid').showEvents('1');
    expect(events.at(-1)).toMatchObject({ type: 'release', actor: 'fake:engineer' });
    expect(events.at(-2)).toMatchObject({ type: 'run-end', exit: 3 });
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  /** Active role files for `ids` in the task repo, with the `model` of each in `models`. */
  function roleFiles(repo: string, ids: string[], models: Record<string, string> = {}): void {
    const agents = join(repo, '.swarmup', 'agents');
    mkdirSync(agents, { recursive: true });
    for (const id of ids) {
      const model = models[id] ? [`model: ${models[id]}`] : [];
      writeFileSync(
        join(agents, `${id.replace(':', '-')}.md`),
        ['---', `id: ${id}`, 'status: active', ...model, '---', ''].join('\n'),
      );
    }
  }

  /** Puts the fake provider's Fable window at 95%, past the default pause_at. */
  function fableWindowFull(sup: Supervisor): void {
    (sup as unknown as { usage: UsageState }).usage = {
      fake: {
        // Refused: a model's own window holds runs only then, whatever its share.
        windows: {
          seven_day_fable: {
            utilization: 1,
            resets_at: Date.now() + 3_600_000,
            status: 'rejected',
          },
        },
        updated_at: Date.now(),
      },
    };
  }

  it("counts a stuck run against the window of its role file's model only (AO-0342)", async () => {
    const { repo, sup, as } = setup({ mode: 'sandbox-fail' });
    roleFiles(repo, ['fake:engineer', 'fake:qa'], {
      'fake:engineer': 'opus',
      'fake:qa': 'fable',
    });
    const h = as('human:dawid');
    const opus = h.newTask({ title: 'opus', owner: 'fake:engineer' });
    const fable = h.newTask({ title: 'fable', owner: 'fake:qa' });
    for (const [agent, task] of [
      ['fake:engineer', opus.id],
      ['fake:qa', fable.id],
    ] as const) {
      for (let i = 0; i < 2; i++) await ended(sup, (await sup.launchFresh({ agent, task })).id);
    }
    // The third runs end while the Fable window is past pause_at.
    const third = [
      await sup.launchFresh({ agent: 'fake:engineer', task: opus.id }),
      await sup.launchFresh({ agent: 'fake:qa', task: fable.id }),
    ];
    fableWindowFull(sup);
    for (const r of third) await ended(sup, r.id);
    // The Opus run is not paused: its task is stuck and stopped. The Fable run is paused: its
    // task is freed for when the window resets.
    expect(h.view(opus.id).status).toBe('blocked');
    expect(h.view(fable.id).status).toBe('todo');
  });

  it('stops a task whose runs keep ending without finishing, and tells a PM (AO-0173)', async () => {
    // A token in the run log: the excerpts must not carry it, or every write that quotes them
    // is refused and the task stays claimed.
    const token = `ghp_${'a1B2'.repeat(10)}`;
    const { repo, sup, as } = setup({
      mode: 'sandbox-fail',
      env: { FAKE_SECRET: token },
      // The stuck run's own provider has a waking PM too: it is never the one told.
      opsd: { agents: { 'fake:pm': { wake: true }, 'claude:pm': { wake: true } } },
    });
    roleFiles(repo, ['claude:pm', 'fake:pm', 'fake:engineer']);
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    // The first two runs free the task, and say what their logs say.
    for (let i = 0; i < 2; i++) {
      await ended(sup, (await sup.launchFresh({ agent: 'fake:engineer', task: '1' })).id);
      expect(as('human:dawid').view('1').status).toBe('todo');
    }
    const release = as('human:dawid').showEvents('1').events.at(-1)!;
    expect(release.type).toBe('release');
    expect(release.body).toMatch(
      /Error \(3 times\): ERROR codex_core.*refusing to run unsandboxed/,
    );
    expect(release.body).toMatch(/Last message: Blocked before task execution/);
    expect(release.body).toContain('[line removed: it looks like a GitHub token]');
    expect(release.body).not.toContain('ghp_');
    // The third is stopped: blocked for the PM of another provider, not freed for a fourth.
    const third = await ended(
      sup,
      (await sup.launchFresh({ agent: 'fake:engineer', task: '1' })).id,
    );
    const v = as('human:dawid').view('1');
    expect(v.status).toBe('blocked');
    expect(v.waitingOn).toBe('claude:pm');
    const block = as('human:dawid').showEvents('1').events.at(-1)!;
    expect(block).toMatchObject({ type: 'block', to: 'claude:pm' });
    expect(block.body).toContain('3 runs of fake:engineer in a row');
    expect(block.body).toContain(third.id);
    // One finding for the PM tracks the failure.
    const findings = as('human:dawid')
      .views()
      .filter((f) => f.meta.type === 'finding');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.owner).toBe('claude:pm');
    expect(findings[0]!.meta.title).toMatch(
      /^fake:engineer runs end without finishing: ERROR codex_core/,
    );
    expect(block.body).toContain(`Tracked as ${findings[0]!.meta.id}`);
    expect(block.body).not.toContain('ghp_');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '1' })).toThrow();
  });

  it("blocks a stuck task for the human when only the run's own provider has a PM", async () => {
    const { repo, sup, as } = setup({
      mode: 'sandbox-fail',
      // claude:pm has an active role file but does not wake: it would never read the block.
      opsd: { agents: { 'fake:pm': { wake: true } } },
    });
    roleFiles(repo, ['claude:pm', 'fake:pm', 'fake:engineer']);
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    for (let i = 0; i < 3; i++) {
      await ended(sup, (await sup.launchFresh({ agent: 'fake:engineer', task: '1' })).id);
    }
    const v = as('human:dawid').view('1');
    expect(v.status).toBe('blocked');
    const block = as('human:dawid').showEvents('1').events.at(-1)!;
    expect(block).toMatchObject({ type: 'block', to: 'human:dawid' });
    expect(v.waitingOn).toBe('human:dawid');
    const finding = as('human:dawid')
      .views()
      .find((f) => f.meta.type === 'finding');
    expect(finding).toBeDefined();
    expect(['fake:pm', 'claude:pm']).not.toContain(finding!.owner);
  });

  it('keeps freeing a task with stuck_runs 0', async () => {
    const { sup, as } = setup({ mode: 'sandbox-fail', opsd: { stuck_runs: 0 } });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    for (let i = 0; i < 3; i++) {
      await ended(sup, (await sup.launchFresh({ agent: 'fake:engineer', task: '1' })).id);
    }
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  /** One review round by a session outside swarmupd that ends with a change request. */
  function changesRound(as: (a: string) => Workspace, id: string, text: string): void {
    as('fake:engineer').start(id, 'plan');
    as('fake:engineer').review(id, 'check', 'codex:reviewer');
    as('codex:reviewer').verdict(id, 'changes', text);
  }

  it('blocks a task for the PM at review_rounds changes verdicts in a row, not before (AO-0288)', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      opsd: {
        outside_session_minutes: 0,
        agents: { 'fake:engineer': { wake: true }, 'fake:pm': { wake: true } },
      },
    });
    roleFiles(repo, ['fake:pm', 'fake:engineer', 'codex:reviewer']);
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'fake:engineer' });
    changesRound(as, t.id, 'first gap');
    changesRound(as, t.id, 'second gap');
    // Two in a row: the author is woken as before.
    await sup.tick();
    expect(h.view(t.id).status).not.toBe('blocked');
    const woken = sup.runs({ live: true });
    expect(woken).toMatchObject([{ agent: 'fake:engineer', task: t.id }]);
    sup.kill(woken[0]!.id);
    await ended(sup, woken[0]!.id);
    expect(h.view(t.id).status).toBe('todo');
    // The third: blocked for the PM with the count and the verdicts, and no run of the author.
    changesRound(as, t.id, 'third gap');
    await sup.tick();
    const v = h.view(t.id);
    expect(v.status).toBe('blocked');
    expect(v.waitingOn).toBe('fake:pm');
    const block = h.showEvents(t.id).events.find((e) => e.type === 'block')!;
    expect(block).toMatchObject({ actor: WATCH_ACTOR, to: 'fake:pm' });
    expect(block.body).toContain('3 reviews in a row');
    for (const text of ['first gap', 'second gap', 'third gap']) {
      expect(block.body).toContain(`codex:reviewer, ${block.at.slice(0, 10)}: ${text}`);
    }
    expect(sup.runs({ live: true }).filter((r) => r.agent === 'fake:engineer')).toEqual([]);
    expect(warns.filter((m) => m.startsWith('review-rounds:'))).toEqual([
      expect.stringContaining(`test/${t.id} stopped after 3 changes verdicts in a row (limit 3`),
    ]);
    // The PM's answer frees it, and the count starts again: one more change request wakes the
    // author.
    for (const r of sup.runs({ live: true })) {
      sup.kill(r.id);
      await ended(sup, r.id);
    }
    as('fake:pm').answer(t.id, 'narrowed to the first gap');
    changesRound(as, t.id, 'fourth gap');
    await sup.tick();
    expect(h.view(t.id).status).not.toBe('blocked');
    expect(sup.runs({ live: true }).map((r) => r.agent)).toContain('fake:engineer');
  });

  it('blocks a task at its review limit for the human when no PM wakes', async () => {
    const { sup, as } = setup({ opsd: { review_rounds: 1 } });
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'fake:engineer' });
    changesRound(as, t.id, 'gap');
    await sup.tick();
    expect(h.view(t.id)).toMatchObject({ status: 'blocked', waitingOn: 'human:dawid' });
  });

  it('keeps waking the author with review_rounds 0', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        review_rounds: 0,
        outside_session_minutes: 0,
        agents: { 'fake:engineer': { wake: true } },
      },
    });
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'fake:engineer' });
    for (let i = 0; i < 4; i++) changesRound(as, t.id, `gap ${i}`);
    await sup.tick();
    expect(h.view(t.id).status).not.toBe('blocked');
    expect(sup.runs({ live: true })).toMatchObject([{ agent: 'fake:engineer' }]);
  });

  it('starts one PM plan check for new plans, with the decisions in force for their tasks (AO-0109)', async () => {
    // Event ids come from the real clock, so the test clock runs with it, moved ahead by hand.
    let ahead = 0;
    const promptFile = join(temp(), 'prompt.txt');
    const { repo, sup, as, state } = setup({
      now: () => Date.now() + ahead,
      env: { FAKE_PROMPT: promptFile },
      // Only the PM wakes: the plans come from sessions of the engineer outside swarmupd.
      opsd: { agents: { 'fake:pm': { wake: true } } },
    });
    roleFiles(repo, ['fake:pm', 'fake:engineer']);
    const h = as('human:dawid');
    const eng = as('fake:engineer');
    const a = h.newTask({ title: 'Merge approved branches', project: 'p', owner: 'fake:engineer' });
    const b = h.newTask({ title: 'Tidy the docs', project: 'q', owner: 'fake:engineer' });
    const old = h.newTask({ title: 'Started earlier', project: 'p', owner: 'fake:engineer' });
    const rule = h.recordDecision({ text: 'swarmupd never merges; Dawid merges', project: 'p' });
    const d = rule.meta.id;
    eng.start(old.id, 'a plan from before swarmupd looked');
    const checks = (): RunRecord[] => sup.runs().filter((r) => r.plan_check);
    const settle = async (): Promise<void> => {
      for (const r of sup.runs({ live: true })) await ended(sup, r.id);
    };

    // The first tick only notes where the events stand: earlier plans are not checked. The new
    // record wakes an inbox run of the PM, which is no plan check.
    await sup.tick();
    await settle();
    expect(checks()).toEqual([]);
    expect(sup.runs()).toMatchObject([{ agent: 'fake:pm', inbox: true }]);
    const inboxPrompt = readFileSync(promptFile, 'utf8');
    expect(inboxPrompt).toContain('A `record` item in your inbox');
    // The PM's inbox run and its chat carry the ask check; other roles get neither.
    expect(inboxPrompt).toContain('- Before you answer an ask, compare the answer you would give');
    expect(inboxPrompt).toContain(
      '`swarmup ask ID "contradiction with D-NNNN (YYYY-MM-DD): <the line of the decision>.',
    );
    expect(inboxPrompt).toContain('--recommend "keep: <why>"`');
    expect(runPrompt({ agent: 'claude:engineer' })).not.toContain('Before you answer an ask');
    const chat = (agent: string): string =>
      chatPrompt({ agent, human: 'human:dawid', first: true, messages: [] });
    expect(chat('claude:pm')).toContain('- Before you answer an ask, compare the answer');
    expect(chat('claude:pm')).toContain('If it conflicts\n  with a decision in force');
    expect(chat('claude:orchestrator')).not.toContain('Before you answer an ask');

    // New plans: a start and a checkpoint `--next` on a task with a decision in force, a start
    // on a task without one, and a person's own start.
    const started = eng.start(a.id, 'merge approved branches\nautomatically').events.at(-1)!;
    const next = eng.checkpoint(a.id, 'merge code done', 'push main after each merge').events[0]!;
    eng.start(b.id, 'fix the typos');
    eng.checkpoint(old.id, 'half done');
    await sup.tick();
    const first = checks();
    expect(first).toMatchObject([{ agent: 'fake:pm' }]);
    expect(first[0]!.task).toBeUndefined();
    expect(first[0]!.inbox).toBeUndefined();
    expect(sup.runs({ live: true }).map((r) => r.id)).toEqual([first[0]!.id]);
    await settle();
    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain(
      [
        'Plan check: compare each new plan below with the decisions in force for its task. Do',
        'nothing else in this run: handle no inbox item and start no task.',
        '',
        `${a.id} · Merge approved branches`,
        `- Plan by fake:engineer (event ${started.id}): merge approved branches automatically`,
        `- Next step by fake:engineer (event ${next.id}): push main after each merge`,
        `Decisions in force for ${a.id} (follow them; newest first):`,
        `- ${d} (`,
      ].join('\n'),
    );
    expect(prompt).toContain('): swarmupd never merges; Dawid merges\n\nFor each plan:\n');
    expect(prompt).toContain('contradiction with D-NNNN (YYYY-MM-DD): <the line of the decision>');
    expect(prompt).toContain('--to human:<name>');
    // No decision is in force for the other task, and the earlier plan stays unchecked.
    expect(prompt).not.toContain(b.id);
    expect(prompt).not.toContain('fix the typos');
    expect(prompt).not.toContain('a plan from before swarmupd looked');
    // The plan check carries the rules of a supervised run, and no inbox instructions.
    expect(prompt).toContain('Rules for supervised runs:');
    expect(prompt).not.toContain('Run `swarmup inbox`');

    // Inside 30 minutes of the last check, a new plan starts none.
    ahead += 10 * 60_000;
    const later = eng.checkpoint(a.id, 'pushed once', 'delete merged branches').events[0]!;
    await sup.tick();
    ahead += 19 * 60_000;
    await sup.tick();
    expect(checks()).toHaveLength(1);
    // After it, one run with only what is new since the last check.
    ahead += 2 * 60_000;
    await sup.tick();
    expect(checks()).toHaveLength(2);
    await settle();
    const second = readFileSync(promptFile, 'utf8');
    expect(second).toContain(
      `- Next step by fake:engineer (event ${later.id}): delete merged branches`,
    );
    expect(second).not.toContain('push main after each merge');

    // Nothing new: no run, however long ago the last check was.
    ahead += 45 * 60_000;
    await sup.tick();
    // New plans on a task without a decision, or by a person, start none either.
    const unread = eng.checkpoint(b.id, 'typos fixed', 'check the links').events[0]!;
    h.comment(a.id, 'looks fine');
    await sup.tick();
    expect(checks()).toHaveLength(2);
    // The events read are not read again.
    const mark = JSON.parse(readFileSync(join(state, 'plan-check.json'), 'utf8')) as {
      last: string;
    };
    expect(mark.last > unread.id).toBe(true);
  });

  it("starts a plan check when only a window of another model than the PM's is full (AO-0342)", async () => {
    let ahead = 0;
    const { repo, sup, as } = setup({
      now: () => Date.now() + ahead,
      opsd: { agents: { 'fake:pm': { wake: true } } },
    });
    roleFiles(repo, ['fake:pm', 'fake:engineer'], { 'fake:pm': 'opus' });
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'fake:engineer' });
    h.recordDecision({ text: 'swarmupd never merges', source: 'notes.md' });
    fableWindowFull(sup);
    await sup.tick();
    for (const r of sup.runs({ live: true })) await ended(sup, r.id);
    ahead += 60_000;
    as('fake:engineer').start(t.id, 'merge automatically');
    await sup.tick();
    expect(sup.runs().filter((r) => r.plan_check)).toMatchObject([{ agent: 'fake:pm' }]);
    for (const r of sup.runs({ live: true })) await ended(sup, r.id);
  });

  it("holds a provider for a window of one model only when the provider's model is that one (AO-0342)", () => {
    const { sup } = setup();
    fableWindowFull(sup);
    const fake = sup.config.runtimes.fake!;
    const model = (m: string | undefined): void =>
      sup.editConfig((doc) =>
        doc.setIn(['opsd'], { sync: false, runtimes: { fake: { ...fake, model: m } } }),
      );
    // No model: the provider's default may be Fable, so the window holds it, as before.
    expect(sup.providerHold('fake')?.text).toMatch(/seven_day_fable window .*fable runs only/);
    model('claude-opus-5-5');
    expect(sup.providerHold('fake')).toBeNull();
    model('claude-fable-5-2');
    expect(sup.providerHold('fake')).toMatchObject({ signedOut: false });
  });

  it('starts no plan check with plan_check_minutes 0', async () => {
    let now = Date.now();
    const { repo, sup, as } = setup({
      now: () => now,
      opsd: { plan_check_minutes: 0, agents: { 'fake:pm': { wake: true } } },
    });
    roleFiles(repo, ['fake:pm', 'fake:engineer']);
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'fake:engineer' });
    as('fake:pm').inbox('fake:pm', { markRead: true });
    await sup.tick();
    now += 60_000;
    h.recordDecision({ text: 'swarmupd never merges', source: 'notes.md' });
    as('fake:engineer').start(t.id, 'merge automatically');
    await sup.tick();
    expect(sup.runs().filter((r) => r.plan_check)).toEqual([]);
  });

  it('kills a run over its time or token budget, and only its own tree', async () => {
    let now = Date.now();
    const { sup, as } = setup({ mode: 'hang', now: () => now });
    as('human:dawid').newTask({ title: 'slow', owner: 'fake:engineer' });
    as('human:dawid').newTask({ title: 'hungry', owner: 'fake:qa' });
    const slow = await sup.launchFresh({ agent: 'fake:engineer', task: '1', budget: '5m' });
    const hungry = await sup.launchFresh({ agent: 'fake:qa', task: '2', tokens: '100' });
    await until(() => readFileSync(hungry.log, 'utf8').includes('usage'));
    await until(() => as('human:dawid').view('2').status === 'in-progress');
    await sup.tick();
    const h = await ended(sup, hungry.id);
    expect(h).toMatchObject({ reason: 'tokens', exit: null, tokens: 150 });
    expect(sup.run(slow.id).status).toBe('running');
    now += 6 * 60_000;
    await sup.tick();
    const s = await ended(sup, slow.id);
    expect(s.reason).toBe('budget');
    expect(as('human:dawid').view('1').status).toBe('todo');
  });

  it('renews the lease while the run lives', async () => {
    let now = Date.now();
    const { sup, as } = setup({ mode: 'hang', now: () => now });
    as('human:dawid').newTask({ title: 'long', owner: 'fake:engineer' });
    const run = await sup.launchFresh({ agent: 'fake:engineer', task: '1', budget: '10h' });
    await until(() => as('human:dawid').view('1').status === 'in-progress');
    await sup.tick();
    expect(
      as('human:dawid')
        .showEvents('1')
        .events.some((e) => e.type === 'renew'),
    ).toBe(false);
    now += 150 * 60_000;
    await sup.tick();
    const renew = as('human:dawid')
      .showEvents('1')
      .events.find((e) => e.type === 'renew');
    expect(renew).toMatchObject({ actor: 'fake:engineer', run: run.id });
    expect(Date.parse(as('human:dawid').view('1').leaseUntil!)).toBeGreaterThan(now + 3 * 3600_000);
    sup.kill(run.id);
    expect((await ended(sup, run.id)).reason).toBe('killed');
  });

  it('wakes an agent that has a task, and runs schedules', async () => {
    const { sup, as } = setup({
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        schedules: [{ name: 'digest', every: '24h', agent: 'fake:writer', prompt: 'Write it.' }],
      },
    });
    await sup.tick();
    const first = sup.runs();
    expect(first.map((r) => [r.agent, r.schedule])).toEqual([['fake:writer', 'digest']]);
    await ended(sup, first[0]!.id);
    as('human:dawid').newTask({ title: 'for the engineer', owner: 'fake:engineer' });
    await sup.tick();
    const woke = sup.runs({ live: true });
    expect(woke.map((r) => [r.agent, r.task])).toEqual([['fake:engineer', 'T-0001']]);
    await ended(sup, woke[0]!.id);
    expect(as('human:dawid').view('1').status).toBe('done');
    // The schedule does not run again within its interval.
    await sup.tick();
    expect(sup.runs().filter((r) => r.schedule === 'digest')).toHaveLength(1);
  });

  it('marks runs lost when their process is gone or the PID runs something else', () => {
    const { sup, state } = setup();
    const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    const base = {
      agent: 'fake:engineer',
      command: 'x',
      cwd: state,
      log: join(state, 'none.log'),
      started_at: new Date().toISOString(),
      status: 'running' as const,
      budget_minutes: 60,
      tokens: 0,
    };
    sup.store.save({ ...base, id: '01AAAAAAAAAAAAAAAAAAAAAAA1', pid: 999_999, image: 'node.exe' });
    sup.store.save({
      ...base,
      id: '01AAAAAAAAAAAAAAAAAAAAAAA2',
      agent: 'fake:qa',
      pid: process.pid,
      image: 'not-node.exe',
    });
    sup.adopt();
    expect(sup.runs({ live: true })).toEqual([]);
    expect(sup.runs().map((r) => r.reason)).toEqual(['lost', 'lost']);
    dead.kill();
  });

  it('checks launches', () => {
    const { sup, as } = setup({ opsd: { max_runs: 0 } });
    as('human:dawid').newTask({ title: 'x' });
    expect(() => sup.launch({ agent: 'nobody:x' })).toThrow(/no provider 'nobody'/);
    expect(() => sup.launch({ agent: 'fake:engineer' })).toThrow(/max_runs/);
  });
});

// Moved from supervisor.test.ts after its split (AO-0397).
describe('session resume after changes', () => {
  it('records the session id and resumes it when the work comes back with changes', async () => {
    const promptFile = join(temp(), 'prompt.txt');
    const agentFile = join(temp(), 'fake-claude.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const { sup, as } = setup({
      mode: 'session-review',
      env: { FAKE_PROMPT: promptFile },
      opsd: { runtimes: { claude: { command: process.execPath, args: [agentFile] } } },
    });
    const human = as('human:dawid');
    human.newTask({
      title: 'Parse events',
      body: 'Read the event files.',
      owner: 'claude:engineer',
    });
    const first = await ended(sup, sup.launch({ agent: 'claude:engineer', task: '1' }).id);
    expect(first.session).toBe('sess-1');
    expect(first.resumed).toBeUndefined();
    // The work prompt carries the task text, so the run need not fetch it.
    expect(readFileSync(promptFile, 'utf8')).toContain('Context of T-0001');
    expect(readFileSync(promptFile, 'utf8')).toContain('> Read the event files.');
    const end = human.showEvents('1').events.find((e) => e.type === 'run-end');
    expect(end?.session).toBe('sess-1');

    human.verdict('1', 'changes', 'Handle CRLF in src/parse.ts');
    const second = await ended(sup, sup.launch({ agent: 'claude:engineer', task: '1' }).id);
    expect(second.resumed).toBe('sess-1');
    expect(second.resumed_from).toBe(first.id);
    expect(second.command).toContain('-p --resume sess-1 ');
    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain(`swarmupd resumed your earlier session of T-0001 (run ${first.id})`);
    expect(prompt).toContain('> Handle CRLF in src/parse.ts');
    expect(prompt).not.toContain('Rules for supervised runs');
    const start = human
      .showEvents('1')
      .events.filter((e) => e.type === 'run-start')
      .pop();
    expect(start?.session).toBe('sess-1');
    expect(start?.body).toContain(`resumed session sess-1 of run ${first.id}`);
  });

  it('starts fresh when resume_on_changes is off', async () => {
    const agentFile = join(temp(), 'fake-claude.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const { sup, as } = setup({
      mode: 'session-review',
      opsd: {
        resume_on_changes: false,
        runtimes: { claude: { command: process.execPath, args: [agentFile] } },
      },
    });
    const human = as('human:dawid');
    human.newTask({ title: 'Parse events', owner: 'claude:engineer' });
    await ended(sup, sup.launch({ agent: 'claude:engineer', task: '1' }).id);
    human.verdict('1', 'changes', 'Handle CRLF');
    const second = await ended(sup, sup.launch({ agent: 'claude:engineer', task: '1' }).id);
    expect(second.resumed).toBeUndefined();
    expect(second.command).not.toContain('--resume');
  });
});
