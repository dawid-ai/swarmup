import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpsEvent } from '@swarmup/core';
import { secretKind } from '@swarmup/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  changesRounds,
  failureKey,
  failureNote,
  runFailure,
  unfinishedRuns,
} from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'swarmupd-stuck-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function ev(type: string, body = ''): OpsEvent {
  n++;
  return { id: String(n), type, actor: 'codex:engineer', at: '2026-11-10T00:00:00Z', body };
}
const runEnds = (k: number): OpsEvent[] =>
  Array.from({ length: k }, (_, i) => [
    ev('claim'),
    ev('run-start'),
    ev('run-end'),
    ev('release', `run R${i} ended (exit, exit 0) without finishing`),
  ]).flat();

describe('unfinishedRuns (AO-0173)', () => {
  it('counts the runs in a row that ended without finishing', () => {
    expect(unfinishedRuns([])).toBe(0);
    expect(unfinishedRuns(runEnds(3))).toBe(3);
    // A start the run wrote is no work on its own.
    expect(unfinishedRuns([...runEnds(1), ev('claim'), ev('start', 'plan'), ...runEnds(1)])).toBe(
      2,
    );
  });

  it('starts again after any work or a person on the task', () => {
    expect(unfinishedRuns([...runEnds(4), ev('progress', 'did a thing'), ...runEnds(1)])).toBe(1);
    expect(unfinishedRuns([...runEnds(4), ev('unblock'), ...runEnds(2)])).toBe(2);
    expect(unfinishedRuns([...runEnds(4), ev('verdict')])).toBe(0);
    // A person's release, with no run note, is not a run that ended.
    expect(unfinishedRuns([...runEnds(4), ev('claim'), ev('release', 'not now')])).toBe(0);
  });

  it('counts a run that swarmupd renewed as no work', () => {
    // A run that sits out its budget renews its lease before it ends.
    const renewed = (i: number): OpsEvent[] => [
      ev('claim'),
      ev('run-start'),
      ev('renew'),
      ev('renew'),
      ev('run-end'),
      ev('release', `run R${i} ended (budget, exit -) without finishing`),
    ];
    expect(unfinishedRuns([...renewed(0), ...renewed(1), ...renewed(2)])).toBe(3);
  });
});

describe('changesRounds (AO-0288)', () => {
  const verdict = (v: 'approve' | 'changes', body = 'fix it'): OpsEvent => ({
    ...ev('verdict', body),
    actor: 'codex:reviewer',
    verdict: v,
  });
  const round = (v: 'approve' | 'changes', body?: string): OpsEvent[] => [
    ev('claim'),
    ev('start', 'plan'),
    ev('review', 'check'),
    verdict(v, body),
  ];
  const WATCH = 'opsd:watch';

  it('counts the changes verdicts in a row while the newest waits for the author', () => {
    expect(changesRounds([], WATCH)).toEqual([]);
    const three = [...round('changes', 'a'), ...round('changes', 'b'), ...round('changes', 'c')];
    expect(changesRounds(three, WATCH).map((e) => e.body)).toEqual(['a', 'b', 'c']);
    // Notes after the verdict leave it waiting.
    expect(changesRounds([...three, ev('comment', 'note')], WATCH)).toHaveLength(3);
    // The author took it up, or it waits for a review: not a verdict waiting for the author.
    expect(changesRounds([...three, ev('claim')], WATCH)).toEqual([]);
    expect(changesRounds([...three, ...round('changes').slice(0, 3)], WATCH)).toEqual([]);
  });

  it('starts again after an approval, a reopen and its own earlier stop', () => {
    const two = [...round('changes'), ...round('changes')];
    expect(changesRounds([...two, ...round('approve'), ev('reopen'), ...two], WATCH)).toHaveLength(
      2,
    );
    expect(changesRounds([...two, ev('reopen'), ...round('changes')], WATCH)).toHaveLength(1);
    const stop: OpsEvent = { ...ev('block', 'stopped'), actor: WATCH };
    const after = [...two, ...round('changes'), stop, ev('answer', 'narrowed')];
    expect(changesRounds(after, WATCH)).toEqual([]);
    expect(changesRounds([...after, ...round('changes')], WATCH)).toHaveLength(1);
    // Another block, such as the author's own question, does not end the row.
    expect(
      changesRounds([...two, ev('block', 'q'), ev('answer', 'a'), ...round('changes')], WATCH),
    ).toHaveLength(3);
  });
});

describe('runFailure (AO-0173)', () => {
  it('reads the error lines and last message of a Codex log', () => {
    const log = join(dir, 'codex.log');
    const err =
      '2026-11-10T06:54:23.908820Z ERROR codex_core::tools::router: error=exec_command failed: ' +
      'CreateProcess { message: "UnsupportedOperation(\\"windows elevated sandbox cannot reopen ' +
      'writable descendants under read-only carveouts directly; refusing to run unsandboxed\\")" }';
    writeFileSync(
      log,
      [
        JSON.stringify({ type: 'thread.started', thread_id: 't' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Plan.' } }),
        err,
        err.replace('06:54:23', '06:54:28'),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Blocked before task execution.' },
        }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1 } }),
      ].join('\n'),
    );
    const f = runFailure(log);
    expect(f.errors).toHaveLength(1);
    expect(f.errors[0]!.count).toBe(2);
    expect(f.errors[0]!.text).toMatch(/^ERROR codex_core::tools::router: .*refusing to run/);
    expect(f.said).toBe('Blocked before task execution.');
    expect(failureNote(f)).toMatch(
      /^- Error \(2 times\): ERROR codex_core.*\n- Last message: Blocked/,
    );
  });

  it('reads a Claude result, and nothing from a missing log', () => {
    const log = join(dir, 'claude.log');
    writeFileSync(
      log,
      JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached' }),
    );
    expect(runFailure(log)).toEqual({
      errors: [{ text: 'Claude AI usage limit reached', count: 1 }],
      said: 'Claude AI usage limit reached',
    });
    expect(runFailure(join(dir, 'missing.log'))).toEqual({ errors: [], said: undefined });
    expect(failureNote({ errors: [] })).toBe('');
  });

  it('removes secret-looking text before it cuts a line to length', () => {
    // Built at run time, so the source holds no token-shaped string.
    const token = `ghp_${'a1B2'.repeat(10)}`;
    const log = join(dir, 'secret.log');
    writeFileSync(
      log,
      [
        // Long enough that a cut at 300 characters would split the token.
        `Error: ${'x'.repeat(280)} GITHUB_TOKEN=${token}`,
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: `I printed the env:\nGH=${token}\nthen stopped.` },
        }),
      ].join('\n'),
    );
    const f = runFailure(log);
    const all = `${failureNote(f)}\n${failureKey(f)}`;
    expect(all).not.toContain('ghp_');
    expect(secretKind(all)).toBeNull();
    expect(f.errors[0]!.text).toBe('[line removed: it looks like a GitHub token]');
    expect(f.said).toBe(
      'I printed the env: [line removed: it looks like a GitHub token] then stopped.',
    );
  });

  it('keys one kind of failure the same across runs and paths', () => {
    const a = failureKey({
      errors: [
        { text: 'fatal: Unable to create C:/dev/a/.git/index.lock: Permission denied', count: 1 },
      ],
    });
    const b = failureKey({
      errors: [
        { text: 'fatal: Unable to create D:/x/y/.git/index.lock: Permission denied', count: 4 },
      ],
    });
    expect(a).toBe(b);
    expect(failureKey({ errors: [] })).toBe('no error in the run log');
  });
});
