import { describe, expect, it } from 'vitest';
import type { OpsEvent } from '@swarmup/core';
import { opsdConfig } from '../src/config.js';
import type { ResumeInput } from '../src/resume.js';
import { resumeDecision, resumeInvocation, resumePrompt } from '../src/resume.js';
import type { RunRecord } from '../src/runs.js';
import { invocation } from '../src/runtimes.js';
import { UsageMeter } from '../src/usage.js';

const AGENT = 'claude:engineer';
const WT = 'C:\\dev\\app\\out\\wt-AO-0001';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-21T08:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** A ULID-like event id that sorts by time, as real ones do. */
function eid(ms: number, n = 0): string {
  return `${ms.toString(36).toUpperCase().padStart(10, '0')}${String(n).padStart(16, '0')}`;
}

function ev(type: string, at: number, extra: Partial<OpsEvent> = {}): OpsEvent {
  return { id: eid(at), type, actor: AGENT, at: iso(at), body: `${type} text`, ...extra };
}

function run(extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: eid(T0),
    agent: AGENT,
    task: 'AO-0001',
    root: 'app',
    pid: 1,
    image: 'claude.exe',
    command: 'claude -p',
    cwd: WT,
    log: 'x.log',
    started_at: iso(T0),
    ended_at: iso(T0 + HOUR),
    status: 'ended',
    exit: 0,
    reason: 'exit',
    budget_minutes: 180,
    tokens: 100_000,
    session: '6b21cef5-e3c3-4a8b-b561-a97294dc686d',
    ...extra,
  };
}

/** The thread of a task whose work came back: run, review, reviewer's run, `changes`. */
function thread(): OpsEvent[] {
  return [
    ev('run-start', T0, { run: eid(T0) }),
    ev('review', T0 + 50 * 60_000),
    ev('run-end', T0 + HOUR, { run: eid(T0) }),
    ev('run-start', T0 + 2 * HOUR, { run: 'REVIEWRUN', actor: 'codex:reviewer' }),
    ev('verdict', T0 + 3 * HOUR, {
      actor: 'codex:reviewer',
      verdict: 'changes',
      body: 'Fix the parser: src/parse.ts:12',
    }),
    ev('comment', T0 + 3 * HOUR + 60_000, { actor: 'human:dawid', body: 'Also keep CRLF.' }),
  ];
}

function input(extra: Partial<ResumeInput> = {}): ResumeInput {
  return {
    enabled: true,
    maxHours: 24,
    agent: AGENT,
    root: 'app',
    task: 'AO-0001',
    cwd: WT,
    events: thread(),
    runs: [run()],
    now: T0 + 4 * HOUR,
    exists: () => true,
    samePath: (a, b) => a.toLowerCase() === b.toLowerCase(),
    ...extra,
  };
}

const why = (d: ReturnType<typeof resumeDecision>): string => (d.resume ? 'resume' : d.why);

describe('resume after changes', () => {
  it('resumes the session of the run that did the work', () => {
    const d = resumeDecision(input());
    expect(d.resume).toBe(true);
    if (!d.resume) return;
    expect(d.session).toBe('6b21cef5-e3c3-4a8b-b561-a97294dc686d');
    expect(d.run.id).toBe(eid(T0));
    expect(d.verdict.body).toBe('Fix the parser: src/parse.ts:12');
    expect(d.since.map((e) => e.body)).toEqual(['Also keep CRLF.']);
  });

  it('resumes after a merge failure that opsd:merge sent back', () => {
    const events = [
      ...thread().slice(0, 4),
      ev('verdict', T0 + 3 * HOUR, { actor: 'codex:reviewer', verdict: 'approve' }),
      ev('verdict', T0 + 4 * HOUR, {
        actor: 'opsd:merge',
        verdict: 'changes',
        body: 'merge conflict in src/a.ts',
      }),
    ];
    const d = resumeDecision(input({ events, now: T0 + 5 * HOUR }));
    expect(why(d)).toBe('resume');
    const prompt = d.resume
      ? resumePrompt({
          agent: AGENT,
          task: 'AO-0001',
          run: d.run.id,
          verdict: d.verdict,
          since: [],
        })
      : '';
    expect(prompt).toContain('swarmupd could not merge the approved work');
    expect(prompt).toContain('> merge conflict in src/a.ts');
  });

  it('starts fresh unless every condition holds', () => {
    expect(why(resumeDecision(input({ enabled: false })))).toMatch(/resume_on_changes is off/);
    expect(why(resumeDecision(input({ agent: 'gemini:engineer' })))).toMatch(/do not resume/);
    expect(why(resumeDecision(input({ runs: [] })))).toMatch(/no earlier work run/);
    // The last work run was another agent's (and so maybe another runtime's).
    const other = run({ id: eid(T0 + 1), agent: 'codex:engineer' });
    expect(why(resumeDecision(input({ runs: [run(), other] })))).toMatch(/codex:engineer's/);
    // Reviews, helpers and chat turns are no work runs.
    expect(
      why(resumeDecision(input({ runs: [run(), run({ id: eid(T0 + 2), review: true })] }))),
    ).toBe('resume');
    expect(why(resumeDecision(input({ runs: [run({ session: undefined })] })))).toMatch(
      /no session id/,
    );
    expect(why(resumeDecision(input({ runs: [run({ reason: 'budget', exit: null })] })))).toMatch(
      /ended with budget/,
    );
    expect(why(resumeDecision(input({ runs: [run({ exit: 1 })] })))).toMatch(/exit 1/);
    expect(why(resumeDecision(input({ runs: [run({ status: 'running' })] })))).toMatch(
      /has not ended/,
    );
    // The newest verdict approves.
    const approved = [
      ...thread(),
      ev('verdict', T0 + 3.5 * HOUR, { actor: 'codex:reviewer', verdict: 'approve' }),
    ];
    expect(why(resumeDecision(input({ events: approved })))).toMatch(/no `changes`/);
    // The verdict answers a review someone else asked for.
    const others = thread().map((e) => (e.type === 'review' ? { ...e, actor: 'codex:qa' } : e));
    expect(why(resumeDecision(input({ events: others })))).toMatch(/answers no review/);
    // A run started since the verdict.
    const started = [...thread(), ev('run-start', T0 + 3.5 * HOUR, { run: 'OTHER' })];
    expect(why(resumeDecision(input({ events: started })))).toMatch(/run OTHER started/);
    // Another folder, a folder that is gone, too old, over half the token budget.
    expect(why(resumeDecision(input({ cwd: 'C:\\dev\\app' })))).toMatch(/not C:/);
    expect(why(resumeDecision(input({ exists: () => false })))).toMatch(/is gone/);
    expect(why(resumeDecision(input({ now: T0 + 26 * HOUR })))).toMatch(/over 24 h ago/);
    expect(why(resumeDecision(input({ maxHours: 2 })))).toMatch(/over 2 h ago/);
    expect(why(resumeDecision(input({ tokenBudget: 150_000 })))).toMatch(/budget's half/);
    expect(why(resumeDecision(input({ tokenBudget: 400_000 })))).toBe('resume');
  });

  it("resumes Claude with --resume after -p, so --add-dir's values stay apart", () => {
    const inv = invocation({ command: 'claude', args: ['--foo'] }, AGENT, undefined, WT, [
      'C:\\store',
      'C:\\scratch',
    ]);
    const next = resumeInvocation(inv, 'claude', 'abc-123', 1)!;
    expect(next.args.slice(0, 4)).toEqual(['--foo', '-p', '--resume', 'abc-123']);
    expect(next.args.slice(4)).toEqual(inv.args.slice(2));
    expect(next.args.slice(-2)).toEqual(['--add-dir', 'C:\\scratch']);
    // Never a flag, never a second session.
    expect(resumeInvocation(inv, 'claude', '--dangerous', 1)).toBeNull();
    expect(resumeInvocation(next, 'claude', 'abc-123', 1)).toBeNull();
  });

  it('resumes only a full-access Codex run, with codex exec resume', () => {
    const rc = { command: 'codex', model: 'gpt-5', effort: 'high' };
    const full = invocation(
      rc,
      'codex:engineer',
      undefined,
      WT,
      [],
      [],
      undefined,
      false,
      false,
      [],
      [],
      undefined,
      true,
    );
    expect(resumeInvocation(full, 'codex', 'th-1')!.args).toEqual([
      'exec',
      'resume',
      '-m',
      'gpt-5',
      '-c',
      'model_reasoning_effort=high',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'th-1',
      '-',
    ]);
    const sandboxed = invocation(rc, 'codex:engineer', undefined, WT, ['C:\\store']);
    expect(sandboxed.args).toContain('workspace-write');
    expect(resumeInvocation(sandboxed, 'codex', 'th-1')).toBeNull();
    expect(resumeInvocation({ args: ['x'], unsetEnv: [] }, 'gemini', 'th-1')).toBeNull();
  });

  it('writes a short resumed prompt with the verdict and what was said since', () => {
    const d = resumeDecision(input());
    if (!d.resume) throw new Error(d.why);
    const p = resumePrompt({
      agent: AGENT,
      task: 'AO-0001',
      run: d.run.id,
      verdict: d.verdict,
      since: d.since,
    });
    expect(p).toContain(`swarmupd resumed your earlier session of AO-0001 (run ${d.run.id})`);
    expect(p).toContain('codex:reviewer asked for changes');
    expect(p).toContain('> Fix the parser: src/parse.ts:12');
    expect(p).toContain('human:dawid comment');
    expect(p).toContain('  > Also keep CRLF.');
    expect(p).toContain('swarmup start AO-0001');
    expect(p).toContain('swarmup sync --session-end');
    expect(p.length).toBeLessThan(2_000);
  });

  it("captures Claude's session id and Codex's thread id from the run's output", () => {
    const m = new UsageMeter();
    m.feed('{"type":"system","subtype":"hook_started","session_id":"early"}\n');
    expect(m.sessionId).toBeNull();
    m.feed('{"type":"system","subtype":"init","cwd":"C:\\\\w","session_id":"6b21cef5"}\n');
    m.feed('{"type":"system","subtype":"init","session_id":"later"}\n');
    expect(m.sessionId).toBe('6b21cef5');
    const c = new UsageMeter();
    c.feed('{"type":"thread.started","thread_id":"019a-thread"}\n');
    expect(c.threadId).toBe('019a-thread');
    expect(c.sessionId).toBeNull();
  });

  it('turns resume on by default and checks its settings', () => {
    const cfg = opsdConfig({} as never);
    expect(cfg.resume_on_changes).toBe(true);
    expect(cfg.resume_max_hours).toBe(24);
    const off = opsdConfig({
      swarmupd: { resume_on_changes: false, resume_max_hours: 6 },
    } as never);
    expect(off.resume_on_changes).toBe(false);
    expect(off.resume_max_hours).toBe(6);
    expect(() => opsdConfig({ swarmupd: { resume_on_changes: 'yes' } } as never)).toThrow(
      /resume_on_changes/,
    );
    expect(() => opsdConfig({ swarmupd: { resume_max_hours: -1 } } as never)).toThrow(
      /resume_max_hours/,
    );
  });
});
