import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpsEvent } from '@swarmup/core';
import { initRoot, Workspace } from '@swarmup/core';
import {
  BODY_MAX,
  briefRefreshLines,
  briefsToRefresh,
  cut,
  FOCUS_MAX,
  runContext,
  runContextLines,
  summaryOf,
  THREAD_MAX,
  threadOf,
} from '../src/run-context.js';
import { runPrompt } from '../src/runtimes.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const repo = mkdtempSync(join(tmpdir(), 'swarmup-context-'));
  dirs.push(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  const env = { SWARMUP_CONFIG: join(repo, 'none.yml') } as NodeJS.ProcessEnv;
  return (actor: string) => new Workspace({ cwd: repo, env, actor });
}

/** Waits for the clock to pass the current millisecond, so two writes never share a time. */
function nextMs(): void {
  const t = Date.now();
  while (Date.now() <= t) {
    // Spin: at most one millisecond.
  }
}

let n = 0;
const ev = (type: string, body: string, extra: Partial<OpsEvent> = {}): OpsEvent => ({
  id: `01M7Y00000000000000000${String(++n).padStart(4, '0')}`,
  type,
  actor: 'claude:engineer',
  at: '2026-11-21T10:00:00.000Z',
  body,
  ...extra,
});

describe('run context', () => {
  it('cuts text at a line or word end and marks the cut', () => {
    expect(cut('short', 10)).toEqual({ text: 'short', cut: false });
    const c = cut('one two three four five six seven', 20);
    expect(c.cut).toBe(true);
    expect(c.text).toBe('one two three four …');
  });

  it('summarizes a body by its first paragraph under a heading, at most three lines', () => {
    expect(summaryOf('# Goal\n\nShip it.\n\nMore detail.')).toEqual({
      text: 'Ship it.',
      cut: true,
    });
    expect(summaryOf('a\nb\nc\nd').text).toBe('a\nb\nc');
    expect(summaryOf('One line.')).toEqual({ text: 'One line.', cut: false });
  });

  it('keeps the newest thread events within the cap, oldest first, and counts the rest', () => {
    const events = [
      ev('claim', ''),
      ev('run-start', 'claude run'),
      ...Array.from({ length: 30 }, (_, i) => ev('comment', `comment ${i} ${'x'.repeat(300)}`)),
      ev('review', `ready ${'r'.repeat(3_000)}`),
      ev('verdict', `fix the parser ${'v'.repeat(3_000)}`, {
        actor: 'codex:reviewer',
        verdict: 'changes',
      }),
    ];
    const { items, earlier } = threadOf(events);
    const size = items.reduce((s, i) => s + i.text.length, 0);
    expect(size).toBeLessThanOrEqual(THREAD_MAX);
    expect(earlier).toBeGreaterThan(0);
    expect(items.length + earlier).toBe(32);
    const last = items[items.length - 1]!;
    expect(last.label).toBe('verdict changes');
    expect(last.actor).toBe('codex:reviewer');
    // The verdict and the review request it answers get the larger cap.
    expect(last.cut).toBe(true);
    expect(last.text.length).toBeLessThanOrEqual(FOCUS_MAX + 2);
    expect(last.text.length).toBeGreaterThan(1_000);
    expect(items.some((i) => i.label === 'run-start' || i.label === 'claim')).toBe(false);
  });

  it('always keeps the newest event, even alone over the cap', () => {
    const { items, earlier } = threadOf([ev('comment', 'a'), ev('comment', 'b'.repeat(500))], 100);
    expect(items.map((i) => i.text)).toEqual(['b'.repeat(500)]);
    expect(earlier).toBe(1);
  });

  it('reads the task text, the thread and the parent chain with the nearest brief', () => {
    const as = setup();
    const human = as('human:dawid');
    const goal = human.newTask({ title: 'Ship the parser', body: '# Goal\n\nParse every file.' });
    const mid = human.newTask({
      title: 'Parser core',
      parent: goal.id,
      body: 'Core work.\n\nDetails.',
    });
    const task = human.newTask({
      title: 'Parse events',
      parent: mid.id,
      body: `Read events. ${'y'.repeat(BODY_MAX)}`,
      owner: 'claude:engineer',
    });
    as('claude:pm').brief(mid.id, '## Outcome\nCore parses.\n\n## Next\nEvents.');
    human.comment(task.id, 'Mind the CRLF files.');
    const c = runContext(human, `test/${task.id}`);
    expect(c.bodyCut).toBe(true);
    expect(c.body.length).toBeLessThanOrEqual(BODY_MAX + 2);
    expect(c.thread.map((t) => t.text)).toEqual(['Mind the CRLF files.']);
    expect(c.chain.map((p) => p.ref)).toEqual([mid.id, goal.id]);
    expect(c.chain[0]!.summary).toBe('## Outcome\nCore parses.\n\n## Next\nEvents.');
    expect(c.chain[0]!.brief?.actor).toBe('claude:pm');
    expect(c.chain[1]!.summary).toBe('Parse every file.');
    expect(c.chain[1]!.brief).toBeUndefined();

    const prompt = runPrompt({ agent: 'claude:engineer', task: task.id, context: c });
    expect(prompt).toContain(`Context of ${task.id}`);
    expect(prompt).toContain('> Read events.');
    expect(prompt).toContain('human:dawid comment');
    expect(prompt).toContain('> Mind the CRLF files.');
    expect(prompt).toContain(`- ${mid.id} (task, todo): Parser core. Brief by claude:pm`);
    expect(prompt).toContain('  > ## Outcome');
    expect(prompt).toContain(`- ${goal.id} (task, todo): Ship the parser. First paragraph:`);
    // The context comes before the rules, and a run without it is unchanged.
    expect(prompt.indexOf('Context of')).toBeLessThan(prompt.indexOf('Rules for supervised runs'));
    expect(runPrompt({ agent: 'claude:engineer', task: task.id })).not.toContain('Context of');
  });

  it("shows a parent's own brief to a run on it", () => {
    const as = setup();
    const human = as('human:dawid');
    const goal = human.newTask({ title: 'Goal', body: 'Text.' });
    human.brief(goal.id, 'Outcome: done soon.');
    const lines = runContextLines(goal.id, runContext(human, `test/${goal.id}`)).join('\n');
    expect(lines).toContain(`Brief of ${goal.id} (by human:dawid,`);
    expect(lines).toContain('> Outcome: done soon.');
  });

  it('lists milestones and briefed parents whose children closed after the brief', () => {
    const as = setup();
    const human = as('human:dawid');
    const milestone = human.newTask({
      title: 'Ship signing',
      type: 'milestone',
      doneWhen: ['The signed build passes the signature check'],
    });
    const briefed = human.newTask({ title: 'Briefed parent' });
    const plain = human.newTask({ title: 'Plain parent' });
    const kids = [milestone, briefed, plain].map((p) =>
      human.newTask({ title: `child of ${p.id}`, parent: p.id }),
    );
    human.brief(briefed.id, 'Outcome: x.');
    nextMs();
    for (const k of kids) human.done(k.id, 'done');
    nextMs();
    const found = briefsToRefresh(human, human.views());
    expect(found.map((b) => b.ref).sort()).toEqual([milestone.id, briefed.id].sort());
    const m = found.find((b) => b.ref === milestone.id)!;
    expect(m.closed).toEqual([kids[0]!.id]);
    expect(m.briefAt).toBeUndefined();
    // A new brief settles it.
    human.brief(milestone.id, 'Outcome: signed.');
    human.brief(briefed.id, 'Outcome: y.');
    expect(briefsToRefresh(human, human.views())).toEqual([]);
    const lines = briefRefreshLines(found).join('\n');
    expect(lines).toContain('swarmup brief ID --body-file -');
    expect(lines).toContain(
      `- ${milestone.id} (milestone) Ship signing: ${kids[0]!.id} closed; no brief yet`,
    );
    // A PM's inbox run gets the lines; a task run does not.
    expect(runPrompt({ agent: 'claude:pm', briefs: found })).toContain('Briefs to refresh');
    expect(runPrompt({ agent: 'claude:pm', task: milestone.id, briefs: found })).not.toContain(
      'Briefs to refresh',
    );
  });
});
