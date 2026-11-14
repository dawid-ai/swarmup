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
  const cwd = temp('swarmup-force-');
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
  const state = temp('swarmup-force-state-');
  return async (actor: string, ...argv: string[]) => {
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
}

const HUMAN = 'human:dawid';
const ENGINEER = 'claude:engineer';
const HEAD = 'Decisions in force for T-0001 (follow them; newest first):';
const LINE = /^- D-0002 \(\d{4}-\d{2}-\d{2}\): swarmupd merges approved work$/;
const CHECK = [
  "If your plan or a choice you are about to make conflicts with one, don't work around it:",
  'finish with `swarmup ask T-0001 "contradiction with D-0002: ..."`.',
];

/** T-0001 in project p under a superseded and a current decision; T-0002 in project q. */
async function world() {
  const swarmup = store();
  await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
  await swarmup(HUMAN, 'new', 'merge policy', '--project', 'p', '--to', ENGINEER);
  await swarmup(HUMAN, 'new', 'another project', '--project', 'q', '--to', ENGINEER);
  await swarmup(HUMAN, 'decision', 'swarmupd never merges', '--project', 'p');
  await swarmup(HUMAN, 'decision', 'swarmupd merges approved work', '--supersedes', 'D-0001');
  return swarmup;
}

describe('the decisions in force for a task (AO-0109)', () => {
  it('prints them on start, after the claim, with what to do on a conflict', async () => {
    const swarmup = await world();
    const started = await swarmup(ENGINEER, 'start', 'T-0001', 'a plan');
    expect(started.code).toBe(0);
    expect(started.out.split('\n')).toEqual([
      'T-0001 in-progress (claude:engineer)',
      HEAD,
      expect.stringMatching(LINE),
      ...CHECK,
    ]);
    // A task outside every scope prints no list, and --json stays one document.
    expect((await swarmup(ENGINEER, 'start', 'T-0002')).out).toBe(
      'T-0002 in-progress (claude:engineer)',
    );
    const json = await swarmup(ENGINEER, 'start', 'T-0001', '--json');
    expect(JSON.parse(json.out)).toMatchObject({ task: { id: 'T-0001' } });
  });

  it('prints them in show, between the task text and its events', async () => {
    const swarmup = await world();
    const shown = (await swarmup(ENGINEER, 'show', 'T-0001')).out.split('\n');
    const at = shown.indexOf(HEAD);
    expect(at).toBeGreaterThan(0);
    expect(shown[at - 1]).toBe('');
    expect(shown[at + 1]).toMatch(LINE);
    expect(shown.join('\n')).not.toContain('swarmupd never merges');
    expect(shown.join('\n')).not.toContain('If your plan');
    expect((await swarmup(ENGINEER, 'show', 'T-0002')).out).not.toContain('Decisions in force');

    const json = JSON.parse((await swarmup(ENGINEER, 'show', 'T-0001', '--json')).out) as {
      in_force: Array<{ id: string }>;
    };
    expect(json.in_force.map((e) => e.id)).toEqual(['D-0002']);
  });

  it('prints them before a verdict and before an answer are written', async () => {
    const swarmup = await world();
    await swarmup(ENGINEER, 'start', 'T-0001');
    await swarmup(
      ENGINEER,
      'ask',
      'T-0001',
      'T-0001: PR or merge?',
      '--human',
      '--recommend',
      'pr',
    );
    const answer = await swarmup(HUMAN, 'answer', 'T-0001', 'merge');
    expect(answer.code).toBe(0);
    expect(answer.out.split('\n')).toEqual([
      HEAD,
      expect.stringMatching(LINE),
      expect.stringMatching(/^T-0001 todo/),
    ]);

    await swarmup(ENGINEER, 'start', 'T-0001');
    await swarmup(ENGINEER, 'review', 'T-0001', 'T-0001: check the merge', '--to', HUMAN);
    const verdict = await swarmup(HUMAN, 'verdict', 'T-0001', 'approve', 'fine');
    expect(verdict.code).toBe(0);
    expect(verdict.out.split('\n').slice(0, 3)).toEqual([
      HEAD,
      expect.stringMatching(LINE),
      expect.stringMatching(/^T-0001 done/),
    ]);
    // A task that does not exist is reported once, by the command.
    const missing = await swarmup(HUMAN, 'answer', 'T-0099', 'x');
    expect(missing.code).toBe(2);
    expect(missing.out).toBe('');
    expect(missing.err).not.toContain('decisions not listed');
  });

  it('lists 30 of 31 decisions and how to list the rest', async () => {
    const swarmup = await world();
    for (let i = 1; i <= 30; i++) await swarmup(HUMAN, 'decision', `rule ${i}`, '--project', 'p');
    const started = (await swarmup(ENGINEER, 'start', 'T-0001')).out.split('\n');
    expect(started.filter((l) => /^- D-\d+ \(/.test(l))).toHaveLength(30);
    expect(started.at(-3)).toBe('1 more: swarmup decisions --log --task T-0001');
    // The oldest one is the one left out.
    expect(started.join('\n')).not.toContain('swarmupd merges approved work');
  });
});

describe('learn notes of the decisions topic (AO-0309)', () => {
  const TITLE = 'Ask Dawid only for crucial decisions';
  const REF = 'decisions/ask-dawid-only-for-crucial-decisions';

  it('learn decisions still writes the note and points at swarmup decision', async () => {
    const swarmup = await world();
    const learned = await swarmup(ENGINEER, 'learn', 'decisions', TITLE, '-m', 'He said so.');
    expect(learned.code).toBe(0);
    expect(learned.out).toBe(REF);
    expect(learned.err).toMatch(/^note: .*`swarmup decision "one line"`.*--to claude:pm/);
    expect((await swarmup(ENGINEER, 'kb', '--read', REF)).out).toContain('He said so.');
    // Another topic prints no pointer.
    const other = await swarmup(ENGINEER, 'learn', 'windows', 'Git Bash forks slowly', '-m', 'x');
    expect(other.err).toBe('');
  });

  it('kb --read names the record of an imported note, its scope and what superseded it', async () => {
    const swarmup = await world();
    await swarmup(ENGINEER, 'learn', 'decisions', TITLE, '-m', 'x');
    expect((await swarmup(ENGINEER, 'kb', '--read', REF)).out).not.toContain('decision:');

    const made = await swarmup(
      HUMAN,
      'decision',
      'Ask only for crucial decisions',
      '--project',
      'p',
      '--source',
      `kb/${REF}.md`,
    );
    expect(made.code).toBe(0);
    const read = (await swarmup(ENGINEER, 'kb', '--read', REF)).out.split('\n');
    expect(read[2]).toBe('decision: D-0003 (project p)');

    await swarmup(HUMAN, 'decision', 'Ask about everything', '--supersedes', 'D-0003');
    const after = (await swarmup(ENGINEER, 'kb', '--read', REF)).out.split('\n');
    expect(after[2]).toBe('decision: D-0003 (project p); superseded by D-0004');
    const json = JSON.parse((await swarmup(ENGINEER, 'kb', '--read', REF, '--json')).out) as {
      records: Array<{ id: string; state: string }>;
    };
    expect(json.records).toMatchObject([{ id: 'D-0003', state: 'superseded' }]);
  });
});
