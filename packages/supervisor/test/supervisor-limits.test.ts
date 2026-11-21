import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { initRoot, mirrorPair, parsePlan, planBody, Root, Workspace } from '@swarmup/core';
import type { OpsEvent } from '@swarmup/core';
import {
  opsdConfig,
  outsideSession,
  questionPrompt,
  runPrompt,
  Supervisor,
  UsageMeter,
} from '../src/index.js';
import { until } from './until.js';
import {
  FAKE_AGENT,
  HANG_RUNTIME,
  alive,
  ended,
  gitCommit,
  setup,
  startOf,
  sups,
  temp,
} from './supervisor-setup.js';

describe('run limits', () => {
  it('runs one engineer per project and several QA runs, across projects at once', async () => {
    const { sup, as } = setup({ mode: 'hang' });
    const h = as('human:dawid');
    h.newTask({ title: 'site work', owner: 'fake:engineer', project: 'site' });
    h.newTask({ title: 'ops work', owner: 'fake:engineer', project: 'ops' });
    h.newTask({ title: 'more site work', owner: 'fake:engineer', project: 'site' });
    const a = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    // Another project's engineer works in another checkout: one writing run per checkout.
    const b = await sup.launchFresh({ agent: 'fake:engineer', task: '2', cwd: temp() });
    expect(a.project).toBe('site');
    expect(b.project).toBe('ops');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '3' })).toThrow(
      /1 engineer run\(s\) live on site; per_project is 1/,
    );
    for (let i = 0; i < 3; i++) await sup.launchFresh({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(
      /3 qa run\(s\) live on test; per_project is 3/,
    );
    expect(sup.runs({ live: true })).toHaveLength(5);
  });

  it('lists live runs newest first without reading every run record', async () => {
    // AO-0164: GET /api/health and /api/runs?live read all run files, ~85 ms with 1,500 runs.
    const { sup } = setup({ mode: 'hang' });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await sup.launchFresh({ agent: 'fake:qa' })).id);
    const ended = {
      ...sup.run(ids[0]!),
      id: '00000000000000000000000000',
      status: 'ended' as const,
    };
    sup.store.save(ended);
    const list = vi.spyOn(sup.store, 'list');
    const get = vi.spyOn(sup.store, 'get');
    try {
      const live = sup.runs({ live: true });
      expect(live.map((r) => r.id)).toEqual([...ids].sort().reverse());
      expect(list).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
    } finally {
      list.mockRestore();
      get.mockRestore();
    }
    // The full list still has every record, the ended one too.
    expect(sup.runs().map((r) => r.id)).toContain('00000000000000000000000000');
  });

  it('counts every provider against the role limit', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        runtimes: {
          other: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] },
        },
      },
    });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'y', project: 'site' });
    await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    expect(() => sup.launch({ agent: 'other:engineer', task: '2' })).toThrow(
      /1 engineer run\(s\) live on site/,
    );
  });

  it('binds a claim held without a run to the run it launches', async () => {
    const { sup, as, repo } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    as('fake:engineer').claim('1');
    const run = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    expect(new Root(join(repo, '.swarmup')).claimRecord('T-0001').run).toBe(run.id);
    const asRun = (id: string) =>
      new Workspace({
        cwd: repo,
        env: { SWARMUP_CONFIG: 'none.yml' },
        actor: 'fake:engineer',
        run: id,
        user: {},
      });
    expect(asRun(run.id).holdsClaim('1')).toBe(true);
    expect(asRun('OTHER').holdsClaim('1')).toBe(false);
  });

  it('never renews or releases a claim that another run of the agent took over', async () => {
    const { sup, as, repo } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    const run = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    // The claim now belongs to run B, as after A lost it and B claimed again.
    new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: 'none.yml' },
      actor: 'fake:engineer',
      run: 'B',
      user: {},
    }).bindClaim('1');
    sup.kill(run.id);
    await ended(sup, run.id);
    const v = as('human:dawid').view('1');
    expect(v.claimedBy).toBe('fake:engineer');
    expect(
      as('human:dawid')
        .showEvents('1')
        .events.map((e) => e.type),
    ).not.toContain('release');
  });

  it('keeps to max_runs on this PC', async () => {
    const { sup } = setup({ mode: 'hang', opsd: { max_runs: 1 } });
    await sup.launchFresh({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:engineer' })).toThrow(/1 runs live; max_runs is 1/);
  });

  it('gives each run its own claim, so two runs of one agent id cannot act on each other', async () => {
    const { sup, as } = setup({ mode: 'hang' });
    as('human:dawid').newTask({ title: 'site', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'ops', owner: 'fake:engineer', project: 'ops' });
    const a = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    const b = await sup.launchFresh({ agent: 'fake:engineer', task: '2', cwd: temp() });
    const runA = as('fake:engineer');
    const asRun = (run: string) =>
      new Workspace({
        cwd: runA.roots[0]!.dir,
        env: { SWARMUP_CONFIG: 'none.yml' },
        actor: 'fake:engineer',
        run,
        user: {},
      });
    expect(asRun(a.id).holdsClaim('1')).toBe(true);
    expect(asRun(b.id).holdsClaim('1')).toBe(false);
    expect(() => asRun(b.id).release('1', 'not mine')).toThrow(/another run on this PC/);
    // A session of the agent with no run is another holder too; swarmupd asks for any of them.
    expect(sup.ws('fake:engineer').holdsClaim('1')).toBe(false);
    expect(sup.ws('fake:engineer').holdsClaim('1', { anyRun: true })).toBe(true);
    expect(() => sup.ws('fake:engineer').start('1', 'mine too')).toThrow(
      /a session outside swarmupd/,
    );
  });

  it('leaves a task to the session outside swarmupd that worked on it last (AO-0236)', async () => {
    let now = Date.now();
    const { sup, as } = setup({
      mode: 'hang',
      now: () => now,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const t = h.newTask({ title: 'x', owner: 'fake:engineer' });
    const ref = `test/${t.id}`;
    // A session with no run does the work and sends it to review; the change request comes back
    // while that session is still there.
    const session = as('fake:engineer');
    session.start(t.id, 'plan');
    session.review(t.id, 'check', 'codex:qa');
    now += 4 * 60_000;
    as('codex:qa').verdict(t.id, 'changes', 'one more case');
    now += 60_000;
    await sup.tick();
    expect(sup.runs({ live: true })).toEqual([]);
    expect(sup.waits().find((w) => w.task === ref)).toMatchObject({
      reason:
        'a session of fake:engineer outside swarmupd worked on it 5 min ago and may still do; ' +
        'a run starts in 25 min unless that session claims it (outside_session_minutes)',
    });
    // Its next event counts from then, and its own claim keeps the task out of the queue.
    session.start(t.id, 'the extra case');
    session.review(t.id, 'check again', 'codex:qa');
    as('codex:qa').verdict(t.id, 'changes', 'and another');
    now += 29 * 60_000;
    await sup.tick();
    expect(sup.runs({ live: true })).toEqual([]);
    // The session is gone: after outside_session_minutes a run takes the task.
    now += 60_000;
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([t.id]);
  });

  it('holds no task its last session gave away, or that a run worked on last', () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: { max_runs: 4, agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    // Released by the session that held it.
    const released = h.newTask({ title: 'released', owner: 'fake:engineer', project: 'a' });
    as('fake:engineer').start(released.id, 'plan');
    as('fake:engineer').release(released.id, 'not now');
    // Sent back, then routed by a person.
    const routed = h.newTask({ title: 'routed', owner: 'fake:engineer', project: 'b' });
    as('fake:engineer').start(routed.id, 'plan');
    as('fake:engineer').review(routed.id, 'check', 'codex:qa');
    as('codex:qa').verdict(routed.id, 'changes', 'more');
    h.assign(routed.id, 'fake:engineer');
    // Worked on by a supervised run, whose claim names it.
    const ran = h.newTask({ title: 'ran', owner: 'fake:engineer', project: 'c' });
    const run = new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: 'none.yml' },
      actor: 'fake:engineer',
      run: 'EARLIER',
      user: {},
    });
    run.start(ran.id, 'plan');
    run.review(ran.id, 'check', 'codex:qa');
    as('codex:qa').verdict(ran.id, 'changes', 'more');
    const waits = sup.waits().filter((w) => w.kind === 'task');
    expect(waits.map((w) => w.task?.split('/').pop()).sort()).toEqual(
      [released.id, routed.id, ran.id].sort(),
    );
    for (const w of waits) expect(w.reason).not.toMatch(/outside swarmupd/);
    expect(waits[0]!.reason).toBe('starts at the next tick');
  });

  it('judges a session outside swarmupd from the task events and the claim record', () => {
    const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString();
    const e = (type: string, actor: string, min: number, extra: Partial<OpsEvent> = {}) =>
      ({ id: `${min}`, type, actor, at: at(min), body: '', ...extra }) as OpsEvent;
    const events = [
      e('claim', 'a:engineer', 0, { token: 'T1' }),
      e('start', 'a:engineer', 1),
      e('review', 'a:engineer', 2),
      e('verdict', 'b:qa', 3, { verdict: 'changes' }),
    ];
    const session = { agent: 'a:engineer', at: Date.parse(at(2)) };
    expect(outsideSession(events, { token: 'T1' })).toEqual(session);
    // A claim a run made or swarmupd bound, another clone's claim, and no claim at all.
    expect(outsideSession(events, { token: 'T1', run: 'R' })).toBeNull();
    expect(outsideSession(events, { token: 'OTHER' })).toBeNull();
    expect(outsideSession(events, {})).toBeNull();
    expect(outsideSession([], { token: 'T1' })).toBeNull();
    // What swarmupd writes as the agent is no sign of a session; a comment of the agent is.
    expect(outsideSession([...events, e('run-end', 'a:engineer', 9)], { token: 'T1' })).toEqual(
      session,
    );
    expect(outsideSession([...events, e('comment', 'a:engineer', 9)], { token: 'T1' })).toEqual({
      agent: 'a:engineer',
      at: Date.parse(at(9)),
    });
    // The session gave the task away, or someone routed it since.
    expect(outsideSession([...events, e('release', 'a:engineer', 9)], { token: 'T1' })).toBeNull();
    expect(outsideSession([...events, e('assign', 'human:x', 9)], { token: 'T1' })).toBeNull();
    // Only the newest claim counts.
    const later = [...events, e('claim', 'a:engineer', 9, { token: 'T2' })];
    expect(outsideSession(later, { token: 'T1' })).toBeNull();
    expect(outsideSession(later, { token: 'T2' })?.at).toBe(Date.parse(at(9)));
  });

  it('keeps to the PC, provider and role settings', async () => {
    let free = 64 * 2 ** 30;
    const { sup } = setup({
      mode: 'hang',
      freeMem: () => free,
      opsd: {
        max_runs: 4,
        roles: { qa: { per_project: 10, max_live: 3 } },
        runtimes: {
          fake: {
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            max_live: 2,
          },
        },
      },
    });
    await sup.launchFresh({ agent: 'fake:qa' });
    await sup.launchFresh({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/2 fake runs live; max_live is 2/);
    expect(sup.blocker('fake:qa', 'test')).toMatch(/max_live is 2/);
    free = 2 * 2 ** 30;
    expect(sup.blocker('other:engineer', 'test')).toMatch(
      /2\.0 GB of memory free; min_free_gb is 4/,
    );
  });

  it('pauses new runs on a provider whose usage reached the threshold, until it resets', async () => {
    let now = Date.now();
    const reset = Math.floor(now / 1000) + 3600;
    const { sup, state } = setup({
      mode: 'limited',
      env: { FAKE_RESET: String(reset) },
      now: () => now,
    });
    const r = await sup.launchFresh({ agent: 'fake:qa' });
    await ended(sup, r.id);
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(
      /fake usage at 95% of the seven_day window \(pause at 90%\)/,
    );
    expect(sup.usageReport().fake).toMatchObject({ paused: expect.stringMatching(/95%/), live: 0 });
    expect(
      JSON.parse(readFileSync(join(state, 'usage.json'), 'utf8')).fake.windows.seven_day,
    ).toMatchObject({
      utilization: 0.95,
    });
    now = reset * 1000 + 1000;
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
  });

  it('wakes one run per task, skipping projects that are full', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      // Counts projects only: a role that writes also gets one run per checkout.
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'a1', owner: 'fake:engineer', project: 'a', priority: 'p1' });
    h.newTask({ title: 'a2', owner: 'fake:engineer', project: 'a', priority: 'p1' });
    h.newTask({ title: 'b1', owner: 'fake:engineer', project: 'b', priority: 'p2' });
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual(['T-0001', 'T-0003']);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(2);
  });

  it('counts a task with no project and one under an old name as one project', async () => {
    const { repo, sup, as } = setup({
      mode: 'hang',
      // Counts projects only: a role that writes also gets one run per checkout.
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'old name', owner: 'fake:engineer', project: 'v2', priority: 'p1' });
    h.newTask({ title: 'no project', owner: 'fake:engineer', priority: 'p1' });
    h.newTask({ title: 'other', owner: 'fake:engineer', project: 'b', priority: 'p2' });
    // Mapped after the tasks were filed: their task.md still says v2.
    const config = join(repo, '.swarmup', 'config.yml');
    writeFileSync(config, `${readFileSync(config, 'utf8')}project_aliases:\n  v2: test\n`);
    await sup.tick();
    const live = sup.runs({ live: true }).map((r) => [r.task, r.project]);
    expect(live.sort()).toEqual([
      ['T-0001', 'test'],
      ['T-0003', 'b'],
    ]);
    expect(sup.waits().map((w) => w.reason)).toEqual([
      'fake:engineer: 1 engineer run(s) live on test; per_project is 1',
    ]);
  });

  it('answers waits from its last plan until a task, a run or a tick changes it (AO-0166)', async () => {
    let now = 1_000_000;
    const { sup, as } = setup({
      mode: 'hang',
      now: () => now,
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'first', owner: 'fake:engineer', priority: 'p1' });
    const plans = vi.spyOn(sup as unknown as { planWake(): unknown }, 'planWake');
    const titles = (): string[] => sup.waits().map((w) => w.title);
    expect(titles()).toEqual(['first']);
    expect(titles()).toEqual(['first']);
    expect(plans).toHaveBeenCalledTimes(1);
    // A new task, or an event on one, plans again.
    h.newTask({ title: 'second', owner: 'fake:engineer', priority: 'p2' });
    expect(titles()).toEqual(['first', 'second']);
    h.comment('2', 'note');
    titles();
    expect(plans).toHaveBeenCalledTimes(3);
    // A run started outside a tick plans again: its task no longer waits.
    await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    expect(sup.waits().map((w) => [w.title, w.reason])).toEqual([
      ['second', 'fake:engineer: 1 engineer run(s) live on test; per_project is 1'],
    ]);
    expect(plans).toHaveBeenCalledTimes(4);
    // The run's own start event lands whenever its process gets to it. Wait for it here, or
    // under load it lands between two of the calls counted next and plans once more (AO-0253).
    await until(() => h.view('1').status === 'in-progress');
    // A tick plans its own wake, and the next waits plans again after it.
    await sup.tick();
    expect(plans).toHaveBeenCalledTimes(5);
    titles();
    titles();
    expect(plans).toHaveBeenCalledTimes(6);
    // Without any change, the plan holds for one tick's time, then counts limits again.
    now += sup.config.tick_seconds * 1000;
    titles();
    expect(plans).toHaveBeenCalledTimes(7);
  });

  it('plans waits again when a channel mention, a proposal or a ballot lands (AO-0166)', () => {
    const { sup, as } = setup({
      mode: 'hang',
      now: () => 1_000_000,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const plans = vi.spyOn(sup as unknown as { planWake(): unknown }, 'planWake');
    const titles = (): string[] => sup.waits().map((w) => w.title);
    expect(titles()).toEqual([]);
    expect(titles()).toEqual([]);
    expect(plans).toHaveBeenCalledTimes(1);
    // A mention in a channel puts an item in the agent's inbox.
    as('human:dawid').post('dev', 'look at this @fake:engineer');
    expect(titles()).toEqual(['1 new inbox item(s) for fake:engineer']);
    expect(plans).toHaveBeenCalledTimes(2);
    // A proposal that names the agent as a voter adds a vote to it.
    as('human:dawid').propose({
      question: 'Q?',
      options: ['a', 'b'],
      voters: ['fake:engineer', 'codex:qa'],
    });
    expect(titles()).toEqual(['2 new inbox item(s) for fake:engineer']);
    expect(plans).toHaveBeenCalledTimes(3);
    // The agent's ballot takes the vote out of its inbox.
    as('fake:engineer').vote('D-1', 'a');
    expect(titles()).toEqual(['1 new inbox item(s) for fake:engineer']);
    expect(plans).toHaveBeenCalledTimes(4);
  });

  it('runs one writing run per checkout, whatever project its task names', async () => {
    const { repo, sup, as } = setup({ mode: 'hang' });
    const h = as('human:dawid');
    h.newTask({ title: 'labeled', owner: 'fake:engineer', project: 'v2' });
    h.newTask({ title: 'unlabeled', owner: 'fake:engineer' });
    h.newTask({ title: 'docs', owner: 'fake:writer', project: 'docs' });
    const a = await sup.launchFresh({ agent: 'fake:engineer', task: '1' });
    expect(a.project).toBe('v2');
    // Another project in the same checkout, by the same role or another role that writes.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /fake:engineer works on test\/T-0001 in .+; one writing run per checkout/,
    );
    expect(() => sup.launch({ agent: 'fake:writer', task: '3' })).toThrow(
      /one writing run per checkout/,
    );
    // The checkout is one folder however its path is spelled.
    const spelled = process.platform === 'win32' ? repo.toUpperCase() : join(repo, '.');
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2', cwd: spelled })).toThrow(
      /one writing run per checkout/,
    );
    // Roles that only read share it; a run in another checkout starts.
    await sup.launchFresh({ agent: 'fake:qa' });
    await sup.launchFresh({ agent: 'fake:engineer', task: '2', cwd: temp() });
    expect(sup.runs({ live: true })).toHaveLength(3);
  });

  it('counts a run in a subfolder of a checkout as a run in that checkout', async () => {
    const tmp = temp();
    const sub = (name: string) => join(tmp, 'repo', 'packages', name);
    const { repo, sup, as } = setup({
      mode: 'hang',
      repo: join(tmp, 'repo'),
      opsd: { agents: { 'fake:writer': { cwd: sub('docs') } } },
    });
    for (const name of ['core', 'cli', 'docs']) mkdirSync(sub(name), { recursive: true });
    const h = as('human:dawid');
    h.newTask({ title: 'core', owner: 'fake:engineer', project: 'v2' });
    h.newTask({ title: 'cli', owner: 'fake:engineer', project: 'other' });
    h.newTask({ title: 'docs', owner: 'fake:writer', project: 'docs' });
    await sup.launchFresh({ agent: 'fake:engineer', task: '1', cwd: sub('core') });
    // An explicit launch folder in another subfolder of the same checkout.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2', cwd: sub('cli') })).toThrow(
      /one writing run per checkout/,
    );
    // The checkout's top, and an agent whose configured folder is a subfolder of it.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2', cwd: repo })).toThrow(
      /one writing run per checkout/,
    );
    expect(() => sup.launch({ agent: 'fake:writer', task: '3' })).toThrow(
      /one writing run per checkout/,
    );
    expect(sup.runs({ live: true })).toHaveLength(1);
  });

  it('wakes no second writing run in a checkout, and says why it waits', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const a = h.newTask({ title: 'a', owner: 'fake:engineer', project: 'v2', priority: 'p1' });
    const b = h.newTask({ title: 'b', owner: 'fake:engineer', priority: 'p2' });
    expect(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      [a.id, 'starts at the next tick'],
      [b.id, expect.stringMatching(/^fake:engineer: fake:engineer works on test\/T-0001 in /)],
    ]);
    await sup.tick();
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([a.id]);
  });
});

describe('questions (AO-0063)', () => {
  it('runs a question beside work in its project and checkout, and never counts it', () => {
    const { sup, as } = setup({ mode: 'hang' });
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer' });
    h.newTask({ title: 'Is T-0001 on track?', type: 'question', owner: 'fake:engineer' });
    h.newTask({ title: 'more work', owner: 'fake:engineer' });
    sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    const q = sup.launch({ agent: 'fake:engineer', task: 'T-0002' });
    expect(q.question).toBe(true);
    expect(as('human:dawid').view('2').claimedBy).toBe('fake:engineer');
    // Work still meets the limits, counting the work run only.
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'T-0003' })).toThrow(
      /1 engineer run\(s\) live on test; per_project is 1/,
    );
    expect(sup.runs({ live: true })).toHaveLength(2);
  });

  it('wakes the agent for a question while its work run holds the project', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer', priority: 'p1' });
    h.newTask({ title: 'Why?', type: 'question', owner: 'fake:engineer', priority: 'p3' });
    h.newTask({ title: 'more work', owner: 'fake:engineer', priority: 'p1' });
    sup.launch({ agent: 'fake:engineer', task: 'T-0001' });
    expect(sup.waits().map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      ['T-0002', 'starts at the next tick'],
      ['T-0003', expect.stringMatching(/per_project is 1/)],
    ]);
    await sup.tick();
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.task)
        .sort(),
    ).toEqual(['T-0001', 'T-0002']);
  });

  it('puts the question, its asker and what it references in the prompt', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer' });
    h.newTask({
      title: 'Is T-0001 on track?',
      body: 'Compare T-0001 with T-0009 in project:test.',
      type: 'question',
      owner: 'fake:qa',
    });
    const ws = as('fake:qa');
    const prompt = runPrompt({
      agent: 'fake:qa',
      task: 'T-0002',
      question: questionPrompt(ws, 'test/T-0002', ws.view('test/T-0002')),
    });
    expect(prompt).toContain('Answer the question T-0002 from human:dawid.');
    expect(prompt).toContain('Question: Is T-0001 on track?');
    expect(prompt).toContain('> Compare T-0001 with T-0009 in project:test.');
    // T-0009 does not exist: the text keeps it, the list leaves it out.
    expect(prompt).toContain('- T-0001 (todo): work\n\nProjects');
    expect(prompt).toContain('- test\n');
    expect(prompt).toContain(
      `\`swarmup done T-0002 "your answer"\`: the answer goes to human:dawid`,
    );
    expect(prompt).not.toContain('Work on T-0002');
    expect(prompt).not.toContain('If you cannot commit');
  });

  it('lists matching learn notes and asks for a note at the end (AO-0049)', () => {
    const notes = [{ ref: 'windows/taskkill-refused', title: 'Taskkill refused leaves the tree' }];
    const work = runPrompt({ agent: 'claude:engineer', task: 'AO-0001', notes });
    expect(work).toContain(
      'Learn notes that may apply; read the ones that fit with `swarmup kb --read <ref>`:\n' +
        '- `windows/taskkill-refused`: Taskkill refused leaves the tree\n\nWork on AO-0001:',
    );
    expect(work).toContain('- Before you finish, ask yourself what the next agent should know');
    expect(work).toContain('`swarmup learn <topic> "<title>" --task AO-0001 -m');

    // A review run lists the decisions in force after its instructions; a question run does not.
    const decisions = [{ id: 'D-0042', at: '2026-11-03T12:00:00.000Z', text: 'No approval' }];
    const reviewed = runPrompt({ agent: 'codex:qa', task: 'AO-0001', review: true, decisions });
    expect(reviewed).toContain(
      '`swarmup verdict AO-0001 changes "what to fix, file:line"`.\n\n' +
        'Decisions in force for AO-0001 (follow them; newest first):\n- D-0042 (2026-11-03): No approval\n',
    );
    expect(runPrompt({ agent: 'claude:engineer', decisions })).not.toContain('Decisions in force');
    expect(runPrompt({ agent: 'claude:engineer', task: 'AO-0001', decisions: [] })).not.toContain(
      'Decisions in force',
    );

    const review = runPrompt({ agent: 'codex:qa', task: 'AO-0001', review: true, notes });
    expect(review).toContain('- `windows/taskkill-refused`');
    expect(review).toContain('- If the work took several review rounds');
    expect(review).not.toContain('Before you finish, ask yourself');

    const question = runPrompt({
      agent: 'codex:qa',
      task: 'AO-0001',
      question: { from: 'human:dawid', title: 'Why?', body: '', tasks: [], projects: [] },
      notes,
    });
    expect(question).toContain('- `windows/taskkill-refused`');
    expect(question).not.toContain('swarmup learn <topic>');
    expect(runPrompt({ agent: 'claude:engineer' })).not.toContain('swarmup learn <topic>');
  });

  it('carries earlier answers and the reply a reopened question asks (AO-0134)', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'work', owner: 'fake:engineer' });
    h.newTask({ title: 'Can we talk here?', type: 'question', owner: 'fake:qa' });
    const qa = as('fake:qa');
    qa.start('T-0002', 'answer');
    qa.done('T-0002', 'Yes, ask away.');
    h.reopen('T-0002', 'Then: is T-0001 on track?');
    const prompt = runPrompt({
      agent: 'fake:qa',
      task: 'T-0002',
      question: questionPrompt(qa, 'test/T-0002', qa.view('test/T-0002')),
    });
    expect(prompt).toContain(
      'The conversation so far, oldest first:\n- fake:qa answered:\n  > Yes, ask away.\n' +
        '- human:dawid replied:\n  > Then: is T-0001 on track?\n\n' +
        'Answer the latest reply; you need not repeat earlier answers.',
    );
    // A reply's references count like the question's.
    expect(prompt).toContain('- T-0001 (todo): work');
  });
});

describe('bottlenecks and providers', () => {
  const HANG = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

  /** A task written by codex:engineer that now waits for fake:qa's review. */
  function inReview(as: (a: string) => Workspace, title: string, project: string): string {
    const meta = as('human:dawid').newTask({ title, owner: 'codex:engineer', project });
    const author = as('codex:engineer');
    author.start(meta.id, 'plan');
    author.review(meta.id, 'please check', 'fake:qa');
    return meta.id;
  }

  it('gives each review request one run, holding no claim', async () => {
    const { sup, as } = setup({ mode: 'hang', opsd: { agents: { 'fake:qa': { wake: true } } } });
    const id = inReview(as, 'x', 'a');
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ agent: 'fake:qa', task: id, review: true, project: 'a' });
    expect(as('human:dawid').view(id).status).toBe('needs-review');
    expect(() => sup.launch({ agent: 'fake:qa', task: id, review: true })).toThrow(
      /already has a live run/,
    );
    sup.kill(live[0]!.id);
    await ended(sup, live[0]!.id);
    await sup.tick();
    expect(sup.runs({ live: true })).toHaveLength(0);
    expect(() => sup.launch({ agent: 'fake:engineer', task: id, review: true })).toThrow(
      /does not wait for fake:engineer's review/,
    );
  });

  it('puts reviews first and holds new work where reviews pile up', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: true }, 'fake:engineer': { wake: true } } },
    });
    for (let i = 0; i < 4; i++) inReview(as, `review ${i}`, 'a');
    const urgent = as('human:dawid').newTask({
      title: 'urgent',
      owner: 'fake:engineer',
      project: 'a',
      priority: 'p0',
    });
    const other = as('human:dawid').newTask({
      title: 'other',
      owner: 'fake:engineer',
      project: 'b',
      priority: 'p3',
    });
    await sup.tick();
    const live = sup.runs({ live: true });
    // Four reviews in a project with a backlog: QA bursts past its 3 per project.
    expect(live.filter((r) => r.review)).toHaveLength(4);
    // No new work in project a until its reviews are back under the backlog; b goes ahead.
    expect(live.filter((r) => !r.review).map((r) => r.task)).toEqual([other.id]);
    expect(as('human:dawid').view(urgent.id).status).toBe('todo');
  });

  it('gives a review sent again after changes a new run', async () => {
    const { sup, as } = setup({ mode: 'hang', opsd: { agents: { 'fake:qa': { wake: true } } } });
    const id = inReview(as, 'x', 'a');
    await sup.tick();
    const first = sup.runs({ live: true })[0]!;
    sup.kill(first.id);
    await ended(sup, first.id);
    as('fake:qa').verdict(id, 'changes', 'fix the thing');
    as('codex:engineer').start(id, 'fix');
    as('codex:engineer').review(id, 'fixed', 'fake:qa');
    await sup.tick();
    const second = sup.runs({ live: true });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ task: id, review: true });
    expect(second[0]!.id).not.toBe(first.id);
  });

  it('takes *:role tasks only from listed providers, and waits for the first without overflow', async () => {
    const both = { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } };
    const unlisted = setup({
      mode: 'hang',
      opsd: {
        agents: both,
        runtimes: { other: HANG, fake: { ...HANG, max_live: 0 } },
        roles: { engineer: { providers: ['fake'] } },
      },
    });
    unlisted.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await unlisted.sup.tick();
    expect(unlisted.sup.runs({ live: true })).toHaveLength(0);

    const absent = setup({
      mode: 'hang',
      opsd: {
        agents: { 'other:engineer': { wake: true } },
        runtimes: { other: HANG },
        roles: { engineer: { providers: ['fake', 'other'], overflow: false } },
      },
    });
    absent.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await absent.sup.tick();
    expect(absent.sup.runs({ live: true })).toHaveLength(0);
  });

  it('never hands a *:role task to the provider of the reviewer it expects', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG, fake: HANG },
        roles: { engineer: { providers: ['fake', 'other'] } },
      },
    });
    const t = as('human:dawid').newTask({ title: 'x' });
    as('human:dawid').delegate(t.id, '*:engineer', { review: 'fake:qa' });
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toEqual(['other:engineer']);
  });

  it('never hands a *:role task to the provider of the reviewer its plan item names', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG, fake: HANG },
        roles: { engineer: { providers: ['fake', 'other'] } },
      },
    });
    // `review` in task.md: what an approved plan writes for an item with a reviewer (AO-0110).
    as('human:dawid').newTask({ title: 'x', owner: '*:engineer', review: 'fake:qa' });
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toEqual(['other:engineer']);
  });

  it('finishes a plan application that a crash left incomplete, then starts its task', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const m = h.newTask({
      title: 'Ship',
      type: 'milestone',
      owner: 'human:dawid',
      doneWhen: ['It ships'],
    });
    h.start(m.id, 'plan');
    const item =
      '  - key: build\n    title: Build it\n    owner: fake:engineer\n    estimate: 1h\n';
    const plan = h.planPropose(m.id, `items:\n${item}`).events[0]!;
    // The approval as a crash leaves it (AO-0110): the event is written, its task is not.
    h.defaultRoot().appendEvent(m.id, {
      type: 'plan-approve',
      actor: 'human:dawid',
      at: new Date().toISOString(),
      plan: plan.id,
      body: plan.body,
    });
    expect(h.view(m.id).planMissing).toEqual(['build']);
    await sup.tick();
    const task = h.views().find((v) => v.meta.plan_item === `${m.id}#build`);
    expect(task?.meta).toMatchObject({ parent: m.id, created_by: 'human:dawid' });
    expect(h.view(m.id).planMissing).toBeUndefined();
    expect(sup.runs({ live: true }).map((r) => r.agent)).toEqual(['fake:engineer']);
  });

  it('plans with each planned run counted, and reports what wake then does', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      // Counts projects only: a role that writes also gets one run per checkout.
      opsd: {
        agents: { 'fake:engineer': { wake: true } },
        roles: { engineer: { writes: false, per_project: 1 } },
      },
    });
    const h = as('human:dawid');
    const a1 = h.newTask({ title: 'a1', owner: 'fake:engineer', project: 'a' });
    const a2 = h.newTask({ title: 'a2', owner: 'fake:engineer', project: 'a' });
    const b1 = h.newTask({ title: 'b1', owner: 'fake:engineer', project: 'b' });
    const plan = sup.waits();
    // a1 starts; then b's project has fewer runs than a's, so b1 comes before a2, which waits.
    expect(plan.map((w) => [w.task?.split('/').pop(), w.reason])).toEqual([
      [a1.id, 'starts at the next tick'],
      [b1.id, 'starts at the next tick'],
      [a2.id, 'fake:engineer: 1 engineer run(s) live on a; per_project is 1'],
    ]);
    await sup.tick();
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.task)
        .sort(),
    ).toEqual([a1.id, b1.id].sort());
    expect(sup.waits().map((w) => w.task?.split('/').pop())).toEqual([a2.id]);
  });

  it('counts planned runs against max_runs, resumes answered work first, and reads inboxes last', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      // The agent's earlier work is written here with no run; it stands for a run's (AO-0236).
      opsd: {
        max_runs: 1,
        outside_session_minutes: 0,
        agents: { 'fake:engineer': { wake: true } },
      },
    });
    const h = as('human:dawid');
    const fresh = h.newTask({
      title: 'fresh',
      owner: 'fake:engineer',
      project: 'a',
      priority: 'p0',
    });
    const asked = h.newTask({
      title: 'asked',
      owner: 'fake:engineer',
      project: 'b',
      priority: 'p3',
    });
    as('fake:engineer').start(asked.id, 'plan');
    as('fake:engineer').ask(asked.id, 'which one?');
    h.answer(asked.id, 'the second');
    h.comment(fresh.id, 'a note for you', 'fake:engineer');
    const plan = sup.waits();
    expect(plan.map((w) => [w.kind, w.task?.split('/').pop() ?? null, w.reason])).toEqual([
      ['task', asked.id, 'starts at the next tick'],
      ['task', fresh.id, 'fake:engineer: 1 runs live; max_runs is 1'],
      ['inbox', null, 'a run of fake:engineer is live or starting'],
    ]);
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([asked.id]);
    // The run reads its own task, not the note on the other one: that still waits for an inbox run.
    expect(sup.waits().map((w) => [w.kind, w.reason])).toEqual([
      ['task', 'fake:engineer: 1 runs live; max_runs is 1'],
      ['inbox', 'a run of fake:engineer is live or starting'],
    ]);
  });

  it('still wakes an inbox run for a message after a task run on another task ended', async () => {
    const { sup, as } = setup({
      mode: 'done',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const h = as('human:dawid');
    const mine = h.newTask({ title: 'mine', owner: 'fake:engineer' });
    const other = h.newTask({ title: 'other', owner: 'codex:engineer' });
    h.comment(other.id, 'please look at this', 'fake:engineer');
    await sup.tick();
    const first = sup.runs({ live: true });
    expect(first.map((r) => r.task)).toEqual([mine.id]);
    await ended(sup, first[0]!.id);
    await sup.tick();
    const second = sup.runs().filter((r) => r.id !== first[0]!.id);
    expect(second).toHaveLength(1);
    expect(second[0]!.task).toBeUndefined();
  });

  it('starts an inbox run for new items when there is no task to claim', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const t = as('human:dawid').newTask({ title: 'someone else', owner: 'codex:engineer' });
    as('human:dawid').comment(t.id, 'have a look', 'fake:engineer');
    expect(sup.waits().map((w) => [w.kind, w.reason])).toEqual([
      ['inbox', 'starts at the next tick'],
    ]);
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live).toHaveLength(1);
    expect(live[0]!.task).toBeUndefined();
    expect(sup.waits()).toEqual([]);
  });

  /** A role that writes nothing yet takes work: qa and reviewer take only questions (AO-0136). */
  const AUDITOR = { auditor: { writes: false } };

  it('starts no task run beside a live inbox run of the same agent', async () => {
    // AO-0128: a verdict woke an inbox run, then a task run of the same agent on the same
    // task, and both did the work. The auditor writes nothing, so no checkout rule stops the
    // second.
    const { sup, as } = setup({
      mode: 'hang',
      // The auditor's first round is written here with no run; it stands for a run's (AO-0236).
      opsd: {
        outside_session_minutes: 0,
        agents: { 'fake:auditor': { wake: true } },
        roles: AUDITOR,
      },
    });
    const h = as('human:dawid');
    const other = h.newTask({ title: 'other', owner: 'codex:engineer' });
    h.comment(other.id, 'have a look', 'fake:auditor');
    await sup.tick();
    const inbox = sup.runs({ live: true });
    expect(inbox.map((r) => r.task)).toEqual([undefined]);
    const t = h.newTask({ title: 'merge', owner: 'fake:auditor' });
    as('fake:auditor').start(t.id, 'plan');
    as('fake:auditor').review(t.id, 'merged', 'codex:qa');
    as('codex:qa').verdict(t.id, 'changes', 'resolve the conflict');
    expect(sup.waits().filter((w) => w.kind === 'task')).toMatchObject([
      { reason: 'fake:auditor: an inbox run of fake:auditor is live or starting' },
    ]);
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.id)).toEqual([inbox[0]!.id]);
    // Once the inbox run ends, exactly one run takes the task.
    sup.kill(inbox[0]!.id);
    await ended(sup, inbox[0]!.id);
    await sup.tick();
    expect(sup.runs({ live: true }).map((r) => r.task)).toEqual([t.id]);
  });

  it('starts a task run beside a live scheduled run with its own prompt', async () => {
    // A scheduled run on its own prompt reads no inbox, so it holds no task of the agent back.
    const { sup, as } = setup({
      mode: 'hang',
      opsd: {
        agents: { 'fake:auditor': { wake: true } },
        roles: AUDITOR,
        schedules: [
          { name: 'sweep', every: '24h', agent: 'fake:auditor', prompt: 'Sweep the PRs.' },
        ],
      },
    });
    await sup.tick();
    const sched = sup.runs({ live: true });
    expect(sched.map((r) => [r.schedule, r.inbox])).toEqual([['sweep', undefined]]);
    const t = as('human:dawid').newTask({ title: 'merge', owner: 'fake:auditor' });
    expect(sup.waits().filter((w) => w.kind === 'task')).toMatchObject([
      { reason: 'starts at the next tick' },
    ]);
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual([t.id, undefined].sort());
  });

  it('starts a task run beside a live run with an empty custom prompt', async () => {
    // An empty --prompt-file still replaces the standard prompt, so the run reads no inbox.
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:auditor': { wake: true } }, roles: AUDITOR },
    });
    const own = sup.launch({ agent: 'fake:auditor', prompt: '' });
    expect(own.inbox).toBeUndefined();
    const t = as('human:dawid').newTask({ title: 'merge', owner: 'fake:auditor' });
    expect(sup.waits().filter((w) => w.kind === 'task')).toMatchObject([
      { reason: 'starts at the next tick' },
    ]);
    await sup.tick();
    const live = sup.runs({ live: true });
    expect(live.map((r) => r.task).sort()).toEqual([t.id, undefined].sort());
  });

  it('lists work owned by or waiting for an id no agent answers to', () => {
    const { sup, as, repo } = setup({ mode: 'hang' });
    // Written before any agent is defined, as tasks from before the check were.
    const h = as('human:dawid');
    const owned = h.newTask({ title: 'release', owner: 'claude:release' });
    const fine = h.newTask({ title: 'fine', owner: 'fake:engineer' });
    const review = h.newTask({ title: 'review', owner: 'fake:engineer' });
    as('fake:engineer').start(review.id, 'go');
    as('fake:engineer').review(review.id, 'ready', 'codex:backend');
    const later = h.newTask({ title: 'later', owner: 'claude:copywriter', blockedBy: [owned.id] });
    writeFileSync(
      join(repo, '.swarmup', 'agents', 'fake-engineer.md'),
      '---\nid: fake:engineer\n---\n',
    );
    const stranded = sup.waits().filter((w) => w.agents.length === 0);
    // No agent wakes here, so swarmupd cannot route the owners' work to a role group (AO-0140).
    const noRoute = '; swarmupd cannot route it: no waking agent answers to *:engineer';
    expect(stranded.map((w) => [w.task?.split('/').pop(), w.kind, w.reason])).toEqual([
      [owned.id, 'task', `owner claude:release is not a configured agent${noRoute}`],
      [review.id, 'review', 'reviewer codex:backend is not a configured agent'],
      [later.id, 'task', `owner claude:copywriter is not a configured agent${noRoute}`],
    ]);
    expect(stranded.map((w) => w.task)).not.toContain(fine.id);
    expect(
      as('human:dawid')
        .inbox()
        .filter((i) => i.kind === 'stranded'),
    ).toHaveLength(3);
  });

  it('reports what waits and why, without starting anything', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: true }, 'fake:engineer': { wake: true } } },
    });
    for (let i = 0; i < 3; i++) inReview(as, `review ${i}`, 'a');
    const held = as('human:dawid').newTask({ title: 'held', owner: 'fake:engineer', project: 'a' });
    const busy = as('human:dawid').newTask({ title: 'busy', owner: 'fake:engineer', project: 'b' });
    const next = as('human:dawid').newTask({ title: 'next', owner: 'fake:engineer', project: 'b' });
    sup.launch({ agent: 'fake:engineer', task: busy.id });
    const waits = sup.waits();
    expect(sup.runs({ live: true })).toHaveLength(1);
    const byTask = new Map(waits.map((w) => [(w.task ?? '').split('/').pop(), w]));
    expect(waits.slice(0, 3).every((w) => w.review)).toBe(true);
    expect(waits[0]!.reason).toBe('starts at the next tick');
    expect(byTask.get(held.id)?.reason).toMatch(/3 reviews wait in a; new work there waits/);
    expect(byTask.get(next.id)?.reason).toMatch(/1 engineer run\(s\) live on b; per_project is 1/);
    expect(byTask.has(busy.id)).toBe(false);
  });

  it('does not hold writers for reviews that wait for a person or an unknown agent', async () => {
    const { sup, as } = setup({
      mode: 'hang',
      opsd: { agents: { 'fake:qa': { wake: false }, 'fake:engineer': { wake: true } } },
    });
    const send = (title: string, reviewer: string): void => {
      const meta = as('human:dawid').newTask({ title, owner: 'codex:engineer', project: 'a' });
      as('codex:engineer').start(meta.id, 'plan');
      as('codex:engineer').review(meta.id, 'check', reviewer);
    };
    for (let i = 0; i < 3; i++) send(`human ${i}`, 'human:dawid');
    for (let i = 0; i < 3; i++) send(`unknown ${i}`, 'other:backend');
    const work = as('human:dawid').newTask({ title: 'work', owner: 'fake:engineer', project: 'a' });
    const byTask = new Map(sup.waits().map((w) => [(w.task ?? '').split('/').pop(), w]));
    expect(byTask.get(work.id)?.reason).toBe('starts at the next tick');
    for (let i = 0; i < 3; i++) send(`agent ${i}`, 'fake:qa');
    const held = new Map(sup.waits().map((w) => [(w.task ?? '').split('/').pop(), w]));
    expect(held.get(work.id)?.reason).toMatch(/3 reviews wait in a; new work there waits/);
  });

  it('hands a *:engineer task to the next provider when the preferred one has no room', async () => {
    const opsd = (fake: Record<string, unknown>, roles: Record<string, unknown> = {}) => ({
      agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
      runtimes: { other: HANG, fake: { ...HANG, ...fake } },
      roles: { engineer: { providers: ['fake', 'other'], ...roles } },
    });
    const first = setup({ mode: 'hang', opsd: opsd({}) });
    first.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await first.sup.tick();
    expect(first.sup.runs({ live: true }).map((r) => r.agent)).toEqual(['fake:engineer']);

    const full = setup({ mode: 'hang', opsd: opsd({ max_live: 0 }) });
    full.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await full.sup.tick();
    expect(full.sup.runs({ live: true }).map((r) => r.agent)).toEqual(['other:engineer']);

    const pinned = setup({ mode: 'hang', opsd: opsd({ max_live: 0 }, { overflow: false }) });
    pinned.as('human:dawid').newTask({ title: 'x', owner: '*:engineer' });
    await pinned.sup.tick();
    expect(pinned.sup.runs({ live: true })).toHaveLength(0);
  });
});

describe('helper runs', () => {
  it('starts helpers under the parent claim, within limits, and stops them with the parent', async () => {
    const { sup, as, repo } = setup({
      mode: 'hang',
      opsd: {
        runtimes: {
          fake: {
            command: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            max_live: 3,
          },
        },
      },
    });
    as('human:dawid').newTask({ title: 'main', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'second', owner: 'fake:engineer', project: 'site' });
    const parent = sup.launch({ agent: 'fake:engineer', task: '1' });
    expect(() => sup.launch({ agent: 'fake:engineer', parent: parent.id })).toThrow(
      /needs a prompt/,
    );
    const a = sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'look up X' });
    const b = sup.launch({ agent: 'fake:explorer', parent: parent.id, prompt: 'look up Y' });
    expect(a).toMatchObject({
      parent: parent.id,
      task: 'T-0001',
      project: 'site',
      cwd: parent.cwd,
    });
    expect(b.parent).toBe(parent.id);
    // The claim stays the parent's; a helper cannot act on it.
    expect(new Root(join(repo, '.swarmup')).claimRecord('T-0001').run).toBe(parent.id);
    const asRun = (run: string) =>
      new Workspace({
        cwd: repo,
        env: { SWARMUP_CONFIG: 'none.yml' },
        actor: 'fake:engineer',
        run,
        user: {},
      });
    expect(() => asRun(a.id).progress('1', 'x')).toThrow(/another run/);
    // Helpers count against the provider (3 fake runs live), not the role per project.
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/3 fake runs live; max_live is 3/);
    expect(() => sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'z' })).toThrow(
      /max_children is 2|max_live is 3/,
    );
    expect(() => sup.launch({ agent: 'fake:qa', parent: a.id, prompt: 'z' })).toThrow(
      /cannot start helpers of its own/,
    );
    sup.kill(parent.id);
    const [ea, eb] = await Promise.all([ended(sup, a.id), ended(sup, b.id)]);
    expect(ea.reason).toBe('parent-ended');
    expect(eb.reason).toBe('parent-ended');
  });

  it('starts helpers only for a run that works on a task it still holds, in its folder', async () => {
    const { sup, as, repo, state } = setup({ mode: 'hang', opsd: { agents: {} } });
    as('human:dawid').newTask({ title: 'x', owner: 'fake:engineer' });
    as('human:dawid').newTask({ title: 'y', owner: 'codex:engineer' });
    const taskless = sup.launch({ agent: 'fake:qa' });
    expect(() => sup.launch({ agent: 'fake:qa', parent: taskless.id, prompt: 'p' })).toThrow(
      /only a run working on a task/,
    );
    as('codex:engineer').start('2', 'plan');
    as('codex:engineer').review('2', 'check', 'fake:qa');
    const reviewer = sup.launch({ agent: 'fake:qa', task: '2', review: true });
    expect(() => sup.launch({ agent: 'fake:qa', parent: reviewer.id, prompt: 'p' })).toThrow(
      /only a run working on a task/,
    );
    const parent = sup.launch({ agent: 'fake:engineer', task: '1' });
    const helper = sup.launch({
      agent: 'fake:engineer',
      parent: parent.id,
      prompt: 'p',
      cwd: state,
    });
    expect(helper.cwd).toBe(parent.cwd);
    // The parent lost its claim to another run: no more helpers.
    new Workspace({
      cwd: repo,
      env: { SWARMUP_CONFIG: 'none.yml' },
      actor: 'fake:engineer',
      run: 'B',
      user: {},
    }).bindClaim('1');
    expect(() => sup.launch({ agent: 'fake:explorer', parent: parent.id, prompt: 'p' })).toThrow(
      /no longer holds/,
    );
  });

  it('ends a helper adopted after a restart when its parent already ended', async () => {
    const { sup, state } = setup();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
    });
    try {
      const start = await startOf(child.pid!);
      const base = {
        agent: 'fake:engineer',
        command: 'x',
        cwd: state,
        log: join(state, 'none.log'),
        started_at: new Date().toISOString(),
        budget_minutes: 60,
        tokens: 0,
        image: 'node.exe',
        task: 'T-0001',
        root: 'test',
      };
      sup.store.save({
        ...base,
        id: '01PARENT00000000000000000A',
        pid: 1,
        status: 'ended',
        ended_at: new Date().toISOString(),
        reason: 'exit',
        exit: 0,
      });
      sup.store.save({
        ...base,
        id: '01CHILD000000000000000000A',
        pid: child.pid!,
        proc_start: start,
        status: 'running',
        parent: '01PARENT00000000000000000A',
      });
      sup.adopt();
      expect(sup.runs({ live: true }).map((r) => r.id)).toEqual(['01CHILD000000000000000000A']);
      await sup.tick();
      await until(() => sup.run('01CHILD000000000000000000A').status === 'ended');
      expect(sup.run('01CHILD000000000000000000A').reason).toBe('parent-ended');
      await until(() => !alive(child.pid!));
    } finally {
      if (child.pid && alive(child.pid)) child.kill();
    }
  });

  it('keeps to max_children and leaves the role limit to the parent', () => {
    const { sup, as } = setup({ mode: 'hang', opsd: { roles: { engineer: { max_children: 1 } } } });
    as('human:dawid').newTask({ title: 'main', owner: 'fake:engineer', project: 'site' });
    as('human:dawid').newTask({ title: 'second', owner: 'fake:engineer', project: 'site' });
    const parent = sup.launch({ agent: 'fake:engineer', task: '1' });
    sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'help' });
    expect(() => sup.launch({ agent: 'fake:engineer', parent: parent.id, prompt: 'more' })).toThrow(
      /has 1 helper\(s\) live; max_children is 1/,
    );
    // One engineer on site: the parent; its helper does not take a second slot or free one.
    expect(() => sup.launch({ agent: 'fake:engineer', task: '2' })).toThrow(
      /1 engineer run\(s\) live on site/,
    );
    expect(() => sup.launch({ agent: 'fake:engineer', parent: 'NOPE', prompt: 'x' })).toThrow(
      /parent run NOPE is not live/,
    );
  });
});

describe('usage-limit errors', () => {
  it('keeps the reset a provider reported when an error without one comes with it', async () => {
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 7200;
    const { sup } = setup({ mode: 'hit-both', env: { FAKE_RESET: String(reset) }, now: () => now });
    const r = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r.id);
    expect(sup.usageReport().fake?.limited_until).toBe(reset * 1000);
  });

  it('pauses a provider until the reset its limit error names, or for the cooldown', async () => {
    let now = Date.now();
    const reset = Math.floor(now / 1000) + 7200;
    const named = setup({ mode: 'hit', env: { FAKE_RESET: String(reset) }, now: () => now });
    const r = named.sup.launch({ agent: 'fake:qa' });
    await ended(named.sup, r.id);
    expect(named.sup.blocker('fake:qa', 'test')).toMatch(/fake refused work \(usage limit\) until/);
    now = reset * 1000 + 1;
    expect(named.sup.blocker('fake:qa', 'test')).toBeNull();

    let later = Date.now();
    const plain = setup({
      mode: 'hit-codex',
      now: () => later,
      opsd: { usage_cooldown_minutes: 15 },
    });
    const p = plain.sup.launch({ agent: 'fake:qa' });
    await ended(plain.sup, p.id);
    expect(plain.sup.blocker('fake:qa', 'test')).toMatch(/refused work/);
    later += 16 * 60_000;
    expect(plain.sup.blocker('fake:qa', 'test')).toBeNull();
  });
});

describe('runtime backoff (AO-0150)', () => {
  it('reads a failed sign-in from Claude and Codex output, not from an agent prose', () => {
    const claude = new UsageMeter();
    claude.feed(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm0', content: [{ type: 'text', text: 'Failed to authenticate' }] },
        error: 'authentication_failed',
      }) + '\n',
    );
    expect(claude.authFailed).toBe(true);
    const result = new UsageMeter();
    result.feed(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' }) + '\n');
    expect(result.authFailed).toBe(true);
    const codex = new UsageMeter();
    codex.feed(JSON.stringify({ type: 'error', message: '401 Unauthorized' }) + '\n');
    expect(codex.authFailed).toBe(true);
    const prose = new UsageMeter();
    prose.feed(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'Failed to authenticate: expired' }] },
      }) + '\n',
    );
    prose.feed(JSON.stringify({ type: 'result', is_error: false, result: 'not logged in' }) + '\n');
    expect(prose.authFailed).toBe(false);
  });

  it('stops runs at the first failed sign-in, tells the human once and resumes after the check (AO-0154)', async () => {
    let now = Date.now();
    const signIn = join(temp(), 'signin');
    writeFileSync(signIn, 'out');
    const { sup, as, opsd } = setup({
      mode: 'auth',
      now: () => now,
      signIn,
      opsd: { agents: { 'fake:engineer': { wake: true } } },
    });
    const human = as('human:dawid');
    const notices = () =>
      human.inbox('human:dawid').filter((i) => i.kind === 'mention' && i.from === 'opsd:runtime');
    const t = human.newTask({ title: 'work', owner: 'fake:engineer' });
    const review = human.newTask({ title: 'to review', owner: 'other:engineer' });
    as('other:engineer').start(review.id, 'plan');
    as('other:engineer').review(review.id, 'check it', 'fake:qa');
    const r = sup.launch({ agent: 'fake:engineer', task: t.id });
    await ended(sup, r.id);
    // The sign-in check runs at once and confirms it; the notice follows.
    await until(() => sup.signedOut('fake')?.told === true);
    expect(sup.signedOut('fake')).toMatchObject({ run: r.id, task: `test/${t.id}` });
    expect(sup.signedOut('fake')?.no_check).toBeUndefined();
    const why = sup.blocker('fake:engineer', 'test');
    expect(why).toMatch(
      /^fake is signed out since .* UTC: sign in to fake again; swarmupd checks every 3 min/,
    );
    // Chat turns, helpers and question runs wait too: they would fail the same way.
    expect(sup.blocker('fake:qa', 'test', { chat: true })).toBe(why);
    expect(sup.blocker('fake:qa', 'test', { child: true })).toBe(why);
    expect(sup.blocker('fake:qa', 'test', { question: true })).toBe(why);
    expect(() => sup.launch({ agent: 'fake:qa' })).toThrow(/fake is signed out/);
    expect(sup.usageReport().fake).toMatchObject({
      paused: why,
      signed_out: { run: r.id, check: true, steps: 'sign in to fake again' },
    });
    expect(sup.waits().find((w) => w.task === `test/${t.id}`)?.reason).toBe(
      `fake:engineer: ${why}`,
    );
    expect(notices()).toHaveLength(1);
    expect(notices()[0]!.summary).toMatch(
      new RegExp(`^fake is signed out on this PC: run ${r.id} on test/${t.id} could not sign in`),
    );
    const text = human.channel('general').at(-1)!.body;
    expect(text).toContain('swarmupd checks the sign-in every 3 minutes');
    expect(text).toContain('click **Resume** in the app or run `swarmup daemon resume`');
    expect(text).toContain(`Reviews that wait for fake: ${review.id}.`);

    // Ticks while it stays signed out: no run, no second notice.
    for (let i = 0; i < 3; i++) {
      now += 2 * 60_000;
      await sup.tick();
      await until(() => !sup['signInChecking'].has('fake'));
    }
    expect(sup.runs()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
    // A restart reads the state: it neither starts a run nor tells the human again.
    const again = opsd();
    expect(again.signedOut('fake')).toMatchObject({ run: r.id, told: true });
    await again.checkSignIn('fake');
    expect(again.blocker('fake:engineer', 'test')).toBe(why);
    expect(notices()).toHaveLength(1);

    // Signed in again: the next check clears it without a run.
    writeFileSync(signIn, 'in');
    now += 3 * 60_000;
    await sup.tick();
    await until(() => sup.signedOut('fake') === null);
    expect(sup.blocker('fake:engineer', 'test')).toBeNull();
    expect(sup.runs()).toHaveLength(1);
    expect(notices()).toHaveLength(1);
  });

  it('checks the sign-in when it starts and starts no run before the check answers', async () => {
    const signIn = join(temp(), 'signin');
    writeFileSync(signIn, 'out');
    const { sup, as } = setup({ signIn, opsd: { agents: { 'fake:engineer': { wake: true } } } });
    sup.start();
    expect(sup.blocker('fake:engineer', 'test')).toBe('swarmupd checks whether fake is signed in');
    await until(() => sup.signedOut('fake') !== null);
    expect(sup.blocker('fake:engineer', 'test')).toMatch(/fake is signed out/);
    const notices = as('human:dawid')
      .inbox('human:dawid')
      .filter((i) => i.kind === 'mention' && i.from === 'opsd:runtime');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.summary).toMatch(/fake is signed out on this PC: its sign-in check says so/);
  });

  it('without a sign-in check, starts one run an hour to try the sign-in', async () => {
    let now = Date.now();
    const modeFile = join(temp(), 'mode');
    writeFileSync(modeFile, 'auth');
    const { sup, as } = setup({ now: () => now, env: { FAKE_MODE_FILE: modeFile } });
    const notices = () =>
      as('human:dawid')
        .inbox('human:dawid')
        .filter((i) => i.kind === 'mention' && i.from === 'opsd:runtime');
    const r1 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r1.id);
    expect(sup.signedOut('fake')).toMatchObject({ no_check: true, told: true });
    expect(sup.blocker('fake:qa', 'test')).toMatch(
      /swarmupd starts one fake run to try the sign-in at /,
    );
    expect(notices()[0]!.summary).toMatch(/could not sign in/);
    expect(as('human:dawid').channel('general').at(-1)!.body).toContain(
      'swarmupd cannot check the sign-in without a run, so it starts one fake run an hour',
    );
    now += 59 * 60_000;
    expect(sup.blocker('fake:qa', 'test')).not.toBeNull();
    now += 60_000;
    // One try at a time: a planned or live run of the provider holds the others.
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
    expect(
      sup.blocker('fake:qa', 'test', { live: [{ agent: 'fake:qa', project: 'test' }] }),
    ).toMatch(/signed out/);
    const r2 = sup.launch({ agent: 'fake:qa' });
    expect(sup.blocker('fake:engineer', 'test')).toMatch(/signed out/);
    await ended(sup, r2.id);
    expect(sup.signedOut('fake')).not.toBeNull();
    expect(notices()).toHaveLength(1);
    // A run that works clears it.
    now += 60 * 60_000;
    writeFileSync(modeFile, 'done');
    const r3 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r3.id);
    expect(sup.signedOut('fake')).toBeNull();
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
  });

  it('stops trusting a sign-in check that says signed in while runs cannot sign in', async () => {
    const now = Date.now();
    const signIn = join(temp(), 'signin');
    // The check finds stored credentials, but they no longer work.
    writeFileSync(signIn, 'in');
    const { sup, as } = setup({ mode: 'auth', now: () => now, signIn });
    const r1 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r1.id);
    await until(() => sup.signedOut('fake') === null && !sup['signInChecking'].has('fake'));
    const r2 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r2.id);
    expect(sup.signedOut('fake')).toMatchObject({ run: r2.id, no_check: true, told: true });
    await sup.checkSignIn('fake');
    expect(sup.signedOut('fake')).not.toBeNull();
    expect(
      as('human:dawid')
        .inbox('human:dawid')
        .filter((i) => i.kind === 'mention' && i.from === 'opsd:runtime'),
    ).toHaveLength(1);
  });

  it('counts a quick error exit, and a run that works clears the count', async () => {
    let now = Date.now();
    const modeFile = join(temp(), 'mode');
    writeFileSync(modeFile, 'crash');
    const { sup } = setup({ now: () => now, env: { FAKE_MODE_FILE: modeFile } });
    const r1 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r1.id);
    expect(sup.blocker('fake:qa', 'test')).toMatch(
      /fake runs ended with an error within 10 s 1 time\(s\) in a row/,
    );
    now += 60_000;
    writeFileSync(modeFile, 'done');
    const r2 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r2.id);
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
    // The count starts again: one failure waits a minute, not five.
    writeFileSync(modeFile, 'crash');
    const r3 = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r3.id);
    expect(sup.blocker('fake:qa', 'test')).toMatch(/1 time\(s\) in a row/);
  });

  it('tries a stopped runtime again when the human resumes it in Settings', async () => {
    let now = Date.now();
    const modeFile = join(temp(), 'mode');
    writeFileSync(modeFile, 'crash');
    const { sup } = setup({ now: () => now, env: { FAKE_MODE_FILE: modeFile } });
    for (let i = 0; i < 4; i++) {
      const r = sup.launch({ agent: 'fake:qa' });
      await ended(sup, r.id);
      if (i < 3) now += 16 * 60_000;
    }
    expect(sup.blocker('fake:qa', 'test')).toMatch(/4 time\(s\) in a row/);
    // Signed out too, from a run that could not sign in.
    now += 60 * 60_000;
    writeFileSync(modeFile, 'auth');
    const r = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r.id);
    expect(sup.blocker('fake:qa', 'test')).toMatch(/fake is signed out/);
    const fake = sup.config.runtimes.fake!;
    const settings = (paused: boolean): void =>
      sup.editConfig((doc) =>
        doc.setIn(['opsd'], { sync: false, runtimes: { fake: { ...fake, paused } } }),
      );
    settings(true);
    expect(sup.blocker('fake:qa', 'test')).toBe('fake is paused in Settings');
    settings(false);
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
    expect(sup.signedOut('fake')).toBeNull();
  });

  it('resumes a signed-out runtime from the app or swarmup daemon resume', async () => {
    const { sup } = setup({ mode: 'auth' });
    const r = sup.launch({ agent: 'fake:qa' });
    await ended(sup, r.id);
    expect(sup.signedOut('fake')).not.toBeNull();
    expect(sup.resumeSignIn('other')).toEqual([]);
    expect(sup.resumeSignIn('fake')).toEqual(['fake']);
    expect(sup.signedOut('fake')).toBeNull();
    expect(sup.blocker('fake:qa', 'test')).toBeNull();
    expect(sup.usageReport().fake?.signed_out).toBeUndefined();
  });

  it('starts role-group work and send-backs of a signed-out provider on the next provider', async () => {
    let now = Date.now();
    const { sup, as, repo } = setup({
      mode: 'hang',
      now: () => now,
      opsd: {
        // The author's work is written here with no run; it stands for a run's (AO-0236).
        outside_session_minutes: 0,
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG_RUNTIME },
        roles: { engineer: { providers: ['fake', 'other'], writes: false, per_project: 2 } },
      },
    });
    const h = as('human:dawid');
    // A send-back to fake:engineer, which pinned the task to the signed-out provider (AO-0148).
    const sent = h.newTask({ title: 'sent back', owner: 'fake:engineer' });
    const author = as('fake:engineer');
    author.start(sent.id, 'plan');
    author.review(sent.id, 'done', 'human:dawid');
    h.verdict(sent.id, 'changes', 'fix the test');
    // Its work is in a worktree, as runs make them.
    gitCommit(repo);
    const wt = join(repo, 'out', `wt-${sent.id}`);
    execFileSync('git', ['worktree', 'add', '-q', '-b', `fake/${sent.id.toLowerCase()}`, wt], {
      cwd: repo,
      windowsHide: true,
    });
    const group = h.newTask({ title: 'group work', owner: '*:engineer' });
    sup['markSignedOut']('fake', 'check');
    expect(sup.signedOut('fake')).not.toBeNull();
    // Role-group work goes to the next provider at once; the send-back waits for the sign-in.
    await sup.tick();
    const agentOf = (id: string) =>
      sup.runs({ live: true }).find((r) => r.task === id)?.agent ?? null;
    expect(agentOf(group.id)).toBe('other:engineer');
    expect(agentOf(sent.id)).toBeNull();
    expect(sup.waits().find((w) => w.task === `test/${sent.id}`)?.reason).toMatch(
      /^fake:engineer: fake is signed out/,
    );
    // After signed_out_handoff_minutes (15), swarmupd hands it to the same role on the next provider.
    now += 15 * 60_000;
    await sup.tick();
    expect(agentOf(sent.id)).toBe('other:engineer');
    const handoff = [...h.showEvents(sent.id).events].reverse().find((e) => e.type === 'handoff')!;
    expect(handoff).toMatchObject({ actor: 'opsd:runtime', to: 'other:engineer' });
    expect(handoff.body).toContain(`branch \`fake/${sent.id.toLowerCase()}\``);
    expect(handoff.body).toContain(`wt-${sent.id}`);
  });

  it('leaves a plan task with the agent its plan names while the provider is signed out (AO-0327)', async () => {
    let now = Date.now();
    const { sup, as } = setup({
      mode: 'hang',
      now: () => now,
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG_RUNTIME },
        roles: { engineer: { providers: ['fake', 'other'], writes: false, per_project: 2 } },
      },
    });
    const h = as('human:dawid');
    const milestone = h.newTask({
      title: 'Ships on macOS',
      type: 'milestone',
      owner: 'human:dawid',
      doneWhen: ['A signed build installs'],
    });
    const item = (key: string, owner: string) =>
      `  - key: ${key}\n    title: Item ${key}\n    owner: '${owner}'\n    estimate: 1h`;
    const body = planBody(
      parsePlan(`items:\n${item('build', 'fake:engineer')}\n${item('port', '*:engineer')}\n`),
    );
    const root = h.defaultRoot();
    const write = (type: string, extra: object = {}) =>
      root.appendEvent(milestone.id, {
        type,
        actor: 'human:dawid',
        at: new Date(now).toISOString(),
        body,
        ...extra,
      });
    const proposal = write('plan');
    write('plan-approve', { plan: proposal.id });
    const child = (key: string) =>
      h.newTask({
        title: `Item ${key}`,
        owner: 'fake:engineer',
        parent: milestone.id,
        planItem: `${milestone.id}#${key}`,
      });
    // The plan names fake:engineer for `build`, and any engineer for `port`.
    const build = child('build');
    const port = child('port');
    sup['markSignedOut']('fake', 'check');
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    now += 15 * 60_000;
    for (let i = 0; i < 3; i++) await sup.tick();
    expect(h.view(build.id).owner).toBe('fake:engineer');
    expect(h.showEvents(build.id).events.some((e) => e.type === 'handoff')).toBe(false);
    expect(warns.filter((w) => w.includes(build.id))).toEqual([]);
    // A plan task whose plan lets the other provider's agent take it is handed over as before.
    expect(h.view(port.id).owner).toBe('other:engineer');
  });

  it('reads the plan of a closed or archived milestone for the signed-out handoff (AO-0327)', async () => {
    let now = Date.now();
    const { sup, as } = setup({
      mode: 'hang',
      now: () => now,
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG_RUNTIME },
        roles: { engineer: { providers: ['fake', 'other'], writes: false, per_project: 2 } },
      },
    });
    const h = as('human:dawid');
    const root = h.defaultRoot();
    const body = planBody(
      parsePlan(
        "items:\n  - key: build\n    title: Item build\n    owner: 'fake:engineer'\n    estimate: 1h\n",
      ),
    );
    // A milestone with an approved plan and one open plan task its plan gives to fake:engineer.
    const planned = (title: string) => {
      const milestone = h.newTask({
        title,
        type: 'milestone',
        owner: 'human:dawid',
        doneWhen: ['A signed build installs'],
      });
      const write = (type: string, extra: object = {}) =>
        root.appendEvent(milestone.id, {
          type,
          actor: 'human:dawid',
          at: new Date(now).toISOString(),
          body,
          ...extra,
        });
      write('plan-approve', { plan: write('plan').id });
      const task = h.newTask({
        title: `Build for ${title}`,
        owner: 'fake:engineer',
        parent: milestone.id,
        planItem: `${milestone.id}#build`,
      });
      return { milestone, task };
    };
    const closed = planned('Closed milestone');
    const archived = planned('Archived milestone');
    h.done(closed.milestone.id, 'closed with a plan task open');
    root.archiveTask(archived.milestone.id);
    // Neither milestone is among the open tasks the handoff loop lists.
    const open = h.list().map((v) => v.meta.id);
    expect(open).not.toContain(closed.milestone.id);
    expect(open).not.toContain(archived.milestone.id);
    sup['markSignedOut']('fake', 'check');
    const warns: string[] = [];
    sup.on('warn', (m: string) => warns.push(m));
    now += 15 * 60_000;
    for (let i = 0; i < 3; i++) await sup.tick();
    for (const { task } of [closed, archived]) {
      expect(h.view(task.id).owner).toBe('fake:engineer');
      expect(h.showEvents(task.id).events.some((e) => e.type === 'handoff')).toBe(false);
      expect(warns.filter((w) => w.includes(task.id))).toEqual([]);
    }
  });

  it('hands send-backs to Codex with or without a worktree, since it commits there (AO-0175, AO-0234)', () => {
    let now = Date.now();
    const { sup, as, repo } = setup({
      now: () => now,
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'codex:engineer': { wake: true } },
        runtimes: { codex: HANG_RUNTIME },
      },
    });
    const h = as('human:dawid');
    const withTree = h.newTask({ title: 'in a worktree', owner: 'fake:engineer' });
    const plain = h.newTask({ title: 'no worktree', owner: 'fake:engineer' });
    gitCommit(repo);
    execFileSync('git', ['worktree', 'add', '-q', join(repo, 'out', `wt-${withTree.id}`)], {
      cwd: repo,
      windowsHide: true,
    });
    sup['markSignedOut']('fake', 'check');
    now += 15 * 60_000;
    sup['signedOutHandoffs']();
    expect(h.view(withTree.id).owner).toBe('codex:engineer');
    expect(h.view(plain.id).owner).toBe('codex:engineer');
    // The Codex run learns where to go on: the handoff names the worktree.
    const handoff = [...h.showEvents(withTree.id).events]
      .reverse()
      .find((e) => e.type === 'handoff')!;
    expect(handoff).toMatchObject({ to: 'codex:engineer' });
    expect(handoff.body).toContain(`wt-${withTree.id}`);
  });

  it('gives a send-back that comes after the sign-out its own handoff wait', () => {
    let now = Date.now();
    const { sup, as } = setup({
      now: () => now,
      opsd: {
        agents: { 'fake:engineer': { wake: true }, 'other:engineer': { wake: true } },
        runtimes: { other: HANG_RUNTIME },
      },
    });
    const h = as('human:dawid');
    const t = h.newTask({ title: 'sent back late', owner: 'fake:engineer' });
    const author = as('fake:engineer');
    author.start(t.id, 'plan');
    author.review(t.id, 'done', 'human:dawid');
    sup['markSignedOut']('fake', 'check');
    // Sent back 20 minutes into the sign-out: it waits 15 minutes from the send-back.
    now += 20 * 60_000;
    h.verdict(t.id, 'changes', 'fix the test');
    expect(h.view(t.id).todoSince).toBe(new Date(now).toISOString());
    sup['signedOutHandoffs']();
    expect(h.view(t.id).owner).toBe('fake:engineer');
    now += 14 * 60_000;
    sup['signedOutHandoffs']();
    expect(h.view(t.id).owner).toBe('fake:engineer');
    now += 60_000;
    sup['signedOutHandoffs']();
    expect(h.view(t.id).owner).toBe('other:engineer');
  });

  it('runs the sign-in check after the runtime args', () => {
    const { sup } = setup({ signIn: join(temp(), 'signin') });
    const check = sup['signInCheck']('fake') as { file: string; args: string[] };
    expect(check.args).toEqual([...sup.config.runtimes.fake!.args!, 'sign-in-status']);
  });
});

describe('same role, different projects', () => {
  it('runs one engineer per project at once, each in its own repo', async () => {
    const { repo: siteRepo, state } = setup({ mode: 'hang' });
    const apiRepo = temp();
    execFileSync('git', ['init', '-q'], { cwd: apiRepo, windowsHide: true });
    initRoot(apiRepo, { name: 'api', prefix: 'API', human: 'human:dawid' });
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(siteRepo, 'none.yml'),
      SWARMUP_STATE_DIR: state,
      FAKE_MODE: 'hang',
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    const user = { roots: [apiRepo] };
    const sup = new Supervisor({
      env,
      cwd: siteRepo,
      user,
      config: opsdConfig({
        opsd: {
          sync: false,
          // As in setup(): the default follows the CPU count, and a 2-core runner then refused
          // the third run on max_runs instead of per_project (AO-0240).
          max_runs: 16,
          runtimes: { fake: { command: process.execPath, args: [agentFile] } },
        },
      }),
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(sup);
    const human = new Workspace({ cwd: siteRepo, env, actor: 'human:dawid', user });
    human.newTask({ title: 'site work', owner: 'fake:engineer' });
    human.newTask({ title: 'more site work', owner: 'fake:engineer' });
    human.newTask(
      { title: 'api work', owner: 'fake:engineer' },
      human.roots.find((r) => r.name === 'api'),
    );

    const site = sup.launch({ agent: 'fake:engineer', task: 'test/T-0001' });
    const api = sup.launch({ agent: 'fake:engineer', task: 'api/API-0001' });
    expect(
      sup
        .runs({ live: true })
        .map((r) => r.id)
        .sort(),
    ).toEqual([site.id, api.id].sort());
    expect(site).toMatchObject({ project: 'test', root: 'test' });
    expect(api).toMatchObject({ project: 'api', root: 'api' });
    // Each run works in its own project's repo, so its commits land there.
    const same = (a: string, b: string) =>
      realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
    expect(same(site.cwd, siteRepo)).toBe(true);
    expect(same(api.cwd, apiRepo)).toBe(true);
    // The role limit still holds within one project.
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'test/T-0002' })).toThrow(
      /per_project is 1/,
    );
  });
});

describe('Master Repo', () => {
  it('starts no run on a project known only from the Master Repo unless given a folder', async () => {
    const { repo: projectRepo, state } = setup({ mode: 'hang' });
    const hubRepo = temp();
    execFileSync('git', ['init', '-q'], { cwd: hubRepo, windowsHide: true });
    initRoot(hubRepo, { name: 'hub', prefix: 'HUB', human: 'human:dawid' });
    const project = new Root(join(projectRepo, '.swarmup'));
    new Workspace({
      cwd: projectRepo,
      env: { SWARMUP_CONFIG: join(projectRepo, 'none.yml') },
      actor: 'human:dawid',
      user: {},
    }).newTask({
      title: 'mirrored work',
      owner: 'fake:engineer',
    });
    mirrorPair(project, new Root(join(hubRepo, '.swarmup')));
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(hubRepo, 'none.yml'),
      SWARMUP_STATE_DIR: state,
      FAKE_MODE: 'hang',
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    // This machine has only the Master Repo: the project shows up as its mirror root.
    const user = { master: hubRepo };
    const sup = new Supervisor({
      env,
      cwd: hubRepo,
      user,
      config: opsdConfig({
        opsd: { sync: false, runtimes: { fake: { command: process.execPath, args: [agentFile] } } },
      }),
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(sup);
    expect(
      sup
        .ws()
        .roots.map((r) => `${r.name}${r.isMirror ? ' (mirror)' : ''}`)
        .sort(),
    ).toEqual(['hub', 'test (mirror)']);
    expect(() => sup.launch({ agent: 'fake:engineer', task: 'test/T-0001' })).toThrow(
      /no checkout here/,
    );
    // Nothing was claimed by the refused launch.
    expect(sup.ws('human:dawid').view('test/T-0001').claimedBy).toBeNull();
    const work = temp();
    const run = sup.launch({ agent: 'fake:engineer', task: 'test/T-0001', cwd: work });
    expect(realpathSync(run.cwd).toLowerCase()).toBe(realpathSync(work).toLowerCase());
  });

  it('checks the plans of a project known only from the Master Repo (AO-0109)', async () => {
    const { repo: projectRepo, state } = setup();
    const hubRepo = temp();
    execFileSync('git', ['init', '-q'], { cwd: hubRepo, windowsHide: true });
    initRoot(hubRepo, { name: 'hub', prefix: 'HUB', human: 'human:dawid' });
    const agents = join(projectRepo, '.swarmup', 'agents');
    mkdirSync(agents, { recursive: true });
    for (const id of ['fake:pm', 'fake:engineer']) {
      writeFileSync(
        join(agents, `${id.replace(':', '-')}.md`),
        ['---', `id: ${id}`, 'status: active', '---', ''].join('\n'),
      );
    }
    new Workspace({
      cwd: projectRepo,
      env: { SWARMUP_CONFIG: join(projectRepo, 'none.yml') },
      actor: 'human:dawid',
      user: {},
    }).newTask({ title: 'Merge approved branches', owner: 'fake:engineer' });
    mirrorPair(new Root(join(projectRepo, '.swarmup')), new Root(join(hubRepo, '.swarmup')));
    const agentFile = join(temp(), 'fake-agent.mjs');
    writeFileSync(agentFile, FAKE_AGENT);
    const promptFile = join(temp(), 'prompt.txt');
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(hubRepo, 'none.yml'),
      SWARMUP_STATE_DIR: state,
      FAKE_MODE: 'done',
      FAKE_PROMPT: promptFile,
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    // This machine has only the Master Repo: the project is its mirror root.
    const user = { master: hubRepo };
    const sup = new Supervisor({
      env,
      cwd: hubRepo,
      user,
      config: opsdConfig({
        opsd: {
          sync: false,
          task_worktrees: false,
          runtimes: { fake: { command: process.execPath, args: [agentFile] } },
          agents: { 'fake:pm': { wake: true } },
        },
      }),
      freeMem: () => 64 * 2 ** 30,
    });
    sups.push(sup);
    expect(sup.ws().roots.find((r) => r.name === 'test')?.isMirror).toBe(true);
    const d = sup.ws('human:dawid').comment('test/T-0001', 'Never merge for me.', undefined, {
      text: 'swarmupd never merges; Dawid merges',
    }).decision!.id;
    const settle = async (): Promise<void> => {
      for (const r of sup.runs({ live: true })) await ended(sup, r.id);
    };
    // The first tick notes where the events stand; the record wakes an inbox run of the PM.
    await sup.tick();
    await settle();
    expect(sup.runs().filter((r) => r.plan_check)).toEqual([]);
    const plan = sup
      .ws('fake:engineer')
      .start('test/T-0001', 'merge approved branches automatically')
      .events.at(-1)!;
    await sup.tick();
    expect(sup.runs().filter((r) => r.plan_check)).toMatchObject([{ agent: 'fake:pm' }]);
    await settle();
    const prompt = readFileSync(promptFile, 'utf8');
    expect(prompt).toContain(
      [
        'test/T-0001 · Merge approved branches',
        `- Plan by fake:engineer (event ${plan.id}): merge approved branches automatically`,
        'Decisions in force for test/T-0001 (follow them; newest first):',
        `- ${d} (`,
      ].join('\n'),
    );
  });
});

describe('machine presence', () => {
  it('writes this machine into its roots on a tick, and only when it changed', async () => {
    const { repo, state } = setup();
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(repo, 'none.yml'),
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    delete env.SWARMUP_AGENT;
    delete env.SWARMUP_ROOTS;
    const sup = new Supervisor({
      env,
      cwd: repo,
      user: { machine: 'test-pc' },
      config: opsdConfig({ opsd: { sync: false } }),
      freeMem: () => 64 * 2 ** 30,
      build: '42',
      version: 'x',
    });
    sups.push(sup);
    await sup.tick();
    const file = join(repo, '.swarmup', 'machines', 'test-pc.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      machine: 'test-pc',
      live_runs: 0,
      build: '42',
    });
    const first = readFileSync(file, 'utf8');
    await sup.tick();
    expect(readFileSync(file, 'utf8')).toBe(first);
  });
});
