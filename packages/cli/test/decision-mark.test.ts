import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A repo with a data root, and `swarmup` run in it as an actor. No swarmupd runs for it. */
function store() {
  const cwd = temp('swarmup-mark-');
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
  const state = temp('swarmup-mark-state-');
  const swarmup = async (actor: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const env = {
      SWARMUP_CONFIG: join(cwd, 'none.yml'),
      SWARMUP_AGENT: actor,
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return swarmup;
}

const HUMAN = 'human:dawid';
const ENGINEER = 'claude:engineer';

describe('swarmup --decision on answer, verdict, comment, retype and park', () => {
  it('records the mark of an answer, lists it in the log and prints it in show', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'merge policy', '--project', 'p', '--to', ENGINEER);
    await swarmup(ENGINEER, 'start', 'T-0001');
    await swarmup(ENGINEER, 'ask', 'T-0001', 'PR or merge?', '--human', '--recommend', 'pr');

    const answer = await swarmup(
      HUMAN,
      'answer',
      'T-0001',
      'pr; I merge',
      '--decision',
      'swarmupd opens PRs; Dawid merges',
    );
    expect(answer.code).toBe(0);
    expect(answer.out.split('\n')).toEqual([
      expect.stringMatching(/^T-0001 todo/),
      'D-0001 recorded (tree T-0001): swarmupd opens PRs; Dawid merges',
    ]);

    // The log names the task and the person as the source.
    expect((await swarmup(HUMAN, 'decisions', '--log')).out).toMatch(
      /^D-0001 {2}\d{4}-\d{2}-\d{2} {2}tree T-0001 {2}swarmupd opens PRs; Dawid merges +\(T-0001, human:dawid\)$/,
    );

    const shown = (await swarmup(HUMAN, 'show', 'T-0001', '--ids')).out.split('\n');
    const at = shown.findIndex((l) => / answer -> claude:engineer: pr; I merge$/.test(l));
    expect(at).toBeGreaterThan(0);
    expect(shown[at + 1]).toBe(
      '    decision: D-0001 (tree T-0001): swarmupd opens PRs; Dawid merges',
    );
    // The record's source is that event.
    const event = shown[at]!.slice(0, 26);
    expect((await swarmup(HUMAN, 'tally', 'D-0001')).out).toContain(`source:   T-0001#${event}`);

    const json = JSON.parse((await swarmup(HUMAN, 'show', 'T-0001', '--json')).out) as {
      events: Array<{ id: string; type: string; decision?: string }>;
      decisions: Record<string, Array<{ id: string }>>;
    };
    expect(json.events.find((e) => e.type === 'answer')).toMatchObject({
      id: event,
      decision: 'D-0001',
    });
    expect(json.decisions[event]).toMatchObject([{ id: 'D-0001' }]);
  });

  it('takes the flags on verdict, comment, retype and park', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'docs', '--project', 'p', '--to', ENGINEER);
    await swarmup(HUMAN, 'new', 'a finding', '--project', 'p', '--type', 'finding');
    await swarmup(HUMAN, 'new', 'slack', '--project', 'p');
    await swarmup(ENGINEER, 'start', 'T-0001');
    await swarmup(ENGINEER, 'review', 'T-0001', 'SECURITY.md is ready', '--human');

    const verdict = await swarmup(
      HUMAN,
      'verdict',
      'T-0001',
      'changes',
      'Too much jargon.',
      '--decision',
      'SECURITY.md stays in plain English',
    );
    expect(verdict).toMatchObject({ code: 0 });
    expect(verdict.out).toContain('D-0001 recorded (tree T-0001)');

    const comment = await swarmup(
      HUMAN,
      'comment',
      'T-0001',
      'For every doc.',
      '--decision',
      'Docs stay in plain English',
      '--scope',
      'project',
      '--supersedes',
      'D-0001',
    );
    expect(comment.out).toContain('D-0002 recorded (project p): Docs stay in plain English');

    const retype = await swarmup(
      HUMAN,
      'retype',
      'T-0002',
      'task',
      'Accepted',
      '--decision',
      'Findings about docs are accepted',
      '--scope',
      'project',
    );
    expect(retype.out).toContain('D-0003 recorded (project p)');

    const park = await swarmup(
      HUMAN,
      'park',
      'T-0003',
      'Not now',
      '--decision',
      'No Slack integration in v2',
      '--narrows',
      'D-0002',
    );
    expect(park.out).toContain('D-0004 recorded (tree T-0003): No Slack integration in v2');
    expect(park.out).toMatch(/^T-0003 parked/);

    const all = (await swarmup(HUMAN, 'decisions', '--log', '--all')).out;
    expect(all).toMatch(/^D-0001 .*\(T-0001, human:dawid; superseded by D-0002\)$/m);
    expect(all).toMatch(/^D-0002 .*\(T-0001, human:dawid; narrowed under T-0003 by D-0004\)$/m);
    expect(all).toMatch(/^D-0003 .*\(T-0002, human:dawid\)$/m);
    expect(all).toMatch(/^D-0004 .*\(T-0003, human:dawid\)$/m);
  });

  it('refuses a long mark, a line break and a flag without --decision with exit 2', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'a task');

    const long = await swarmup(HUMAN, 'comment', 'T-0001', 'text', '--decision', 'x'.repeat(201));
    expect(long.code).toBe(2);
    expect(long.err).toMatch(/200 characters at most/);
    const lines = await swarmup(HUMAN, 'comment', 'T-0001', 'text', '--decision', 'one\ntwo');
    expect(lines.code).toBe(2);
    expect(lines.err).toMatch(/one line/);
    const lone = await swarmup(HUMAN, 'comment', 'T-0001', 'text', '--scope', 'project');
    expect(lone.code).toBe(2);
    expect(lone.err).toMatch(/add --decision/);
    expect((await swarmup(HUMAN, 'park', 'T-0001', 'no', '--supersedes', 'D-0001')).code).toBe(2);

    expect((await swarmup(HUMAN, 'decisions', '--log')).out).toBe('no decisions in force');
    expect((await swarmup(HUMAN, 'show', 'T-0001')).out).not.toMatch(/comment|park/);
  });

  it('refuses a mark by an agent with exit 1 and writes neither file', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'a task', '--to', ENGINEER);

    const agent = await swarmup(
      ENGINEER,
      'comment',
      'T-0001',
      'my choice',
      '--decision',
      'Use SQLite',
    );
    expect(agent.code).toBe(1);
    expect(agent.err).toMatch(/claude:engineer cannot record a decision/);
    const pm = await swarmup('claude:pm', 'park', 'T-0001', 'no', '--decision', 'Not in v2');
    expect(pm.code).toBe(1);
    expect(pm.err).toMatch(/cannot mark a decision on its own event/);

    expect((await swarmup(HUMAN, 'decisions', '--log', '--all')).out).toBe('no decisions in force');
    const shown = (await swarmup(HUMAN, 'show', 'T-0001')).out;
    expect(shown).not.toMatch(/comment|park/);
    expect(shown).toMatch(/^status: {3}todo/m);
  });
});
