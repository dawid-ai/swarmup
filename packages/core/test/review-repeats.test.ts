import { describe, expect, it } from 'vitest';
import { namedCommits, repeatedVerdicts } from '../src/index.js';
import type { OpsEvent } from '../src/index.js';
import { setup } from './helpers.js';

// AO-0159: a review request that names the commit the last `changes` verdict already judged goes
// to the person instead of looping between an engineer and an agent reviewer.

function ev(type: string, body: string, extra: Partial<OpsEvent> = {}): OpsEvent {
  return { id: `E${body.length}${type}`, type, actor: 'x:y', at: '', body, ...extra };
}

describe('namedCommits', () => {
  it('prefers the `<commit> on branch` commit over others in the text', () => {
    expect(namedCommits('fixes 1234abc; now 44b19ca7 on branch `claude/ao-1`')).toEqual([
      '44b19ca7',
    ]);
  });

  it('lists every commit without repeats, and skips words and plain numbers', () => {
    expect(namedCommits('defaced 1234567 44b19ca7, then 44b19ca7 and abc1234')).toEqual([
      '44b19ca7',
      'abc1234',
    ]);
  });
});

describe('repeatedVerdicts', () => {
  const review = (c: string) => ev('review', `${c} on branch a-b`);
  const changes = (t: string) => ev('verdict', t, { verdict: 'changes' });

  it('returns the changes verdicts in a row on the same commit, oldest first', () => {
    const v1 = changes('fix the copy');
    const v2 = changes('still the copy, same commit');
    const events = [review('44b19ca7'), v1, review('44b19ca'), v2];
    expect(repeatedVerdicts(events, '44b19ca7 on branch a-b: synced')).toEqual([v1, v2]);
  });

  it('is empty for a new commit, an approval, or a request that names no commit', () => {
    const events = [review('44b19ca7'), changes('fix it')];
    expect(repeatedVerdicts(events, 'abc1234 on branch a-b: fixed')).toEqual([]);
    expect(repeatedVerdicts(events, 'PR: https://x/pull/3')).toEqual([]);
    const approved = [...events, review('44b19ca7'), ev('verdict', 'ok', { verdict: 'approve' })];
    expect(repeatedVerdicts(approved, '44b19ca7 on branch a-b')).toEqual([]);
  });

  it('stops at a verdict on another commit', () => {
    const v2 = changes('fix the copy');
    const events = [review('1234abc'), changes('fix it'), review('44b19ca7'), v2];
    expect(repeatedVerdicts(events, '44b19ca7 on branch a-b')).toEqual([v2]);
  });

  it("uses the verdict's own commit when its review named none", () => {
    const v = changes('44b19ca7 is unchanged');
    const events = [ev('review', 'synced the files'), v];
    expect(repeatedVerdicts(events, 'base 44b19ca7, one uncommitted file')).toEqual([v]);
  });
});

describe('review of a commit that already got changes', () => {
  function looped() {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'x', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start('1');
    eng.review('1', '44b19ca7 on branch claude/t-1: first round', 'codex:reviewer');
    const verdict = as('codex:reviewer').verdict('1', 'changes', 'sync the skill copy');
    eng.start('1');
    return { as, eng, verdict: verdict.events[0]! };
  }

  it('goes to the human with the earlier verdict quoted', () => {
    const { eng, verdict } = looped();
    const res = eng.review(
      '1',
      '44b19ca7 on branch claude/t-1: synced, uncommitted',
      'codex:reviewer',
    );
    expect(res.view.reviewer).toBe('human:dawid');
    expect(res.warnings?.join('\n')).toMatch(/sent to human:dawid instead of codex:reviewer/);
    const body = res.events[0]!.body;
    expect(body.startsWith('44b19ca7 on branch claude/t-1: synced, uncommitted')).toBe(true);
    expect(body).toContain(`T-0001#${verdict.id}, \`changes\` from codex:reviewer`);
    expect(body).toContain('> sync the skill copy');
    expect(body).toMatch(/Decide: approve it, send it back/);
  });

  it('goes to the agent reviewer for a new commit', () => {
    const { eng } = looped();
    const res = eng.review('1', 'abc1234 on branch claude/t-1: synced', 'codex:reviewer');
    expect(res.view.reviewer).toBe('codex:reviewer');
    expect(res.warnings).toBeUndefined();
  });

  it('keeps the agent reviewer with --force and marks the event', () => {
    const { as } = looped();
    const res = as('claude:engineer', { force: true }).review(
      '1',
      '44b19ca7 on branch claude/t-1: the finding is wrong',
      'codex:reviewer',
    );
    expect(res.view.reviewer).toBe('codex:reviewer');
    expect(res.events[0]!.forced).toBe(true);
  });
});
