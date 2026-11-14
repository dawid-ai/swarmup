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
  const cwd = temp('swarmup-decision-');
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
  const state = temp('swarmup-decision-state-');
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

describe('swarmup decision and swarmup decisions --log', () => {
  it('records a decision by a person and lists it in the log', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'in p', '--project', 'p');
    await swarmup(HUMAN, 'new', 'under it', '--parent', 'T-0001');
    await swarmup(HUMAN, 'new', 'in q', '--project', 'q');

    const first = await swarmup(
      HUMAN,
      'decision',
      'No AI attribution in any repo',
      '--project',
      'p',
    );
    expect(first).toMatchObject({ code: 0, out: 'D-0001', err: '' });
    const tree = await swarmup(HUMAN, 'decision', 'Tray app first', '--task', 'T-0001');
    expect(tree.out).toBe('D-0002');

    const log = await swarmup(HUMAN, 'decisions', '--log');
    expect(log.code).toBe(0);
    const lines = log.out.split('\n');
    // Newest first: id, date, scope, the one line, then where it came from and who decided.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^D-0002 {2}\d{4}-\d{2}-\d{2} {2}tree T-0001 {2}Tray app first +\(human:dawid\)$/,
    );
    expect(lines[1]).toMatch(
      /^D-0001 {2}\d{4}-\d{2}-\d{2} {2}project p {4}No AI attribution in any repo +\(human:dawid\)$/,
    );

    // --task: a record whose scope holds the task, and not one outside it.
    expect((await swarmup(HUMAN, 'decisions', '--log', '--task', 'T-0002')).out).toMatch(
      /^D-0002 .*\nD-0001 /,
    );
    expect((await swarmup(HUMAN, 'decisions', '--log', '--task', 'T-0003')).out).toBe(
      'no decisions in force',
    );
    expect((await swarmup(HUMAN, 'decisions', '--log', '--project', 'q')).out).toBe(
      'no decisions in force',
    );
    const json = JSON.parse((await swarmup(HUMAN, 'decisions', '--log', '--json')).out) as Array<{
      id: string;
      scope: string;
    }>;
    expect(json.map((e) => [e.id, e.scope])).toEqual([
      ['D-0002', 'tree'],
      ['D-0001', 'project'],
    ]);

    // Without --log the command lists votes, as before.
    expect((await swarmup(HUMAN, 'decisions')).out).toBe('no open votes');
    expect((await swarmup(HUMAN, 'decisions', '--all')).out).toBe('no open votes');
    expect((await swarmup(HUMAN, 'decisions', '--task', 'T-0001')).code).toBe(2);
    // `tally` prints a record.
    const shown = await swarmup(HUMAN, 'tally', 'D-0002');
    expect(shown.out).toContain('state:    recorded');
    expect(shown.out).toContain('scope:    tree T-0001');
  });

  it('marks superseded and narrowed decisions, and refuses the wrong flag with exit 2', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'in p', '--project', 'p');
    await swarmup(HUMAN, 'new', 'in p too', '--project', 'p');
    await swarmup(HUMAN, 'decision', 'swarmupd never merges', '--project', 'p');
    await swarmup(HUMAN, 'decision', 'PRs for every change', '--project', 'p');

    // A tree is inside a project scope: that is --narrows, not --supersedes.
    const wrong = await swarmup(
      HUMAN,
      'decision',
      'x',
      '--scope',
      'tree',
      '--task',
      'T-0001',
      '--supersedes',
      'D-0001',
    );
    expect(wrong.code).toBe(2);
    expect(wrong.err).toMatch(/use --narrows D-0001/);
    expect(
      (await swarmup(HUMAN, 'decision', 'x', '--project', 'p', '--narrows', 'D-0001')).code,
    ).toBe(2);
    expect((await swarmup(HUMAN, 'decision', 'x'.repeat(201))).code).toBe(2);
    expect((await swarmup(HUMAN, 'decision', 'x', '--scope', 'all')).code).toBe(2);

    expect(
      (
        await swarmup(
          HUMAN,
          'decision',
          'This tree merges',
          '--task',
          'T-0001',
          '--narrows',
          'D-0001',
        )
      ).out,
    ).toBe('D-0003');
    // No --scope: the replacement takes the scope of the decision it supersedes.
    expect((await swarmup(HUMAN, 'decision', 'No PRs', '--supersedes', 'D-0002')).out).toBe(
      'D-0004',
    );

    const log = (await swarmup(HUMAN, 'decisions', '--log')).out;
    expect(log).not.toMatch(/D-0002/);
    expect(log).toMatch(/^D-0001 .*\(human:dawid; narrowed under T-0001 by D-0003\)$/m);
    const all = (await swarmup(HUMAN, 'decisions', '--log', '--all')).out;
    expect(all).toMatch(/^D-0002 .*\(human:dawid; superseded by D-0004\)$/m);
    // For one task: what is in force there, without notes.
    const one = (await swarmup(HUMAN, 'decisions', '--log', '--task', 'T-0002')).out;
    expect(one.split('\n').map((l) => l.slice(0, 6))).toEqual(['D-0004', 'D-0001']);
    expect(one).not.toMatch(/narrowed/);
    expect((await swarmup(HUMAN, 'tally', 'D-0002')).out).toContain('state:    superseded');
  });

  it('lets the PM record only with a source, and refuses other agents with exit 1', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'a task');
    await swarmup(HUMAN, 'comment', 'T-0001', 'Subtasks of an approved task need no approval.');
    const ids = (await swarmup(HUMAN, 'show', 'T-0001', '--ids')).out;
    const event = /^([0-9A-HJKMNP-TV-Z]{26}) .*comment/m.exec(ids)?.[1];
    expect(event).toBeTruthy();

    const engineer = await swarmup('claude:engineer', 'decision', 'my own choice');
    expect(engineer.code).toBe(1);
    expect(engineer.err).toMatch(/cannot record a decision/);
    // The same answer whatever the source: no lookup happens for an agent that cannot record.
    expect((await swarmup('codex:qa', 'decision', 'x', '--source', 'chat:01M7B2')).code).toBe(1);

    expect((await swarmup('claude:pm', 'decision', 'Subtasks need no approval')).code).toBe(1);
    const pm = await swarmup(
      'claude:pm',
      'decision',
      'Subtasks need no approval',
      '--source',
      `T-0001#${event}`,
    );
    expect(pm).toMatchObject({ code: 0, out: 'D-0001' });
    expect((await swarmup(HUMAN, 'decisions', '--log')).out).toMatch(
      /\(T-0001, human:dawid, recorded by claude:pm\)$/,
    );
    expect((await swarmup(HUMAN, 'tally', 'D-0001')).out).toContain(
      'recorded by claude:pm from human:dawid',
    );

    // A chat source is read from the swarmupd of this machine: stopped, the command refuses.
    const chat = await swarmup(
      'claude:pm',
      'decision',
      'x',
      '--source',
      'chat:01M7B2XK4T9QZ8R5V3W1Y6N0PD',
    );
    expect(chat.code).toBe(2);
    expect(chat.err).toMatch(/swarmupd is not running/);
    expect((await swarmup(HUMAN, 'decisions', '--log')).out.split('\n')).toHaveLength(1);
  });

  it('stores --scope on swarmup decide and lists the vote in the log', async () => {
    const swarmup = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'in p', '--project', 'p');
    await swarmup(HUMAN, 'new', 'beside', '--project', 'p');
    await swarmup(
      HUMAN,
      'propose',
      'Shell?',
      '--option',
      'Electron',
      '--option',
      'Tauri',
      '--voters',
      HUMAN,
      '--task',
      'T-0001',
    );
    expect((await swarmup(HUMAN, 'decide', 'D-0001', 'Electron', '--scope', 'nowhere')).code).toBe(
      2,
    );
    expect((await swarmup(HUMAN, 'decide', 'D-0001', 'Electron', '--scope', 'project')).code).toBe(
      0,
    );
    expect((await swarmup(HUMAN, 'decisions', '--log', '--task', 'T-0002')).out).toMatch(
      /^D-0001 {2}\d{4}-\d{2}-\d{2} {2}project p {2}Shell\? → Electron +\(vote, human:dawid\)$/,
    );
    // A redecision adds an outcome; --all lists the earlier one under the vote.
    expect(
      (await swarmup(HUMAN, 'decide', 'D-0001', 'Tauri', '--scope', 'project', '--force')).code,
    ).toBe(0);
    const all = (await swarmup(HUMAN, 'decisions', '--log', '--all')).out.split('\n');
    expect(all[0]).toMatch(/Shell\? → Tauri/);
    expect(all[1]).toMatch(/revised: was 'Electron' \(human:dawid\)$/);
  });
});
