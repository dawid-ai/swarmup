// The timeline the Replay tests play.
import type { Timeline } from '../ui/src/types';

export const H = 3_600_000;
export const T0 = Date.parse('2026-11-02T09:00:00.000Z');
export const iso = (h: number): string => new Date(T0 + h * H).toISOString();

/** Three hours of work squeezed into a 30 s clip: real hour h plays at h * 10 s. */
export function fixture(): Timeline {
  return {
    from: iso(0),
    to: iso(3),
    lanes: [
      {
        agent: 'claude:engineer',
        kind: 'agent',
        first: iso(0),
        workMs: 2 * H,
        runMs: H,
        tokens: 5000,
        tasks: 1,
        reviews: 0,
      },
      {
        agent: 'codex:reviewer',
        kind: 'agent',
        first: iso(1),
        workMs: 0,
        runMs: 0,
        tokens: 0,
        tasks: 0,
        reviews: 1,
      },
      {
        agent: 'human:dawid',
        kind: 'human',
        first: iso(0),
        workMs: 0,
        runMs: 0,
        tokens: 0,
        tasks: 0,
        reviews: 0,
      },
    ],
    spans: [
      {
        root: 'r',
        task: 'AO-1',
        title: 'One',
        agent: 'claude:engineer',
        start: iso(0.1),
        end: iso(1),
        endedBy: 'review',
      },
    ],
    reviews: [
      {
        root: 'r',
        task: 'AO-1',
        title: 'One',
        round: 1,
        author: 'claude:engineer',
        reviewer: 'codex:reviewer',
        start: iso(1),
        end: iso(2),
        decidedBy: 'codex:reviewer',
        verdict: 'approve',
        endedBy: 'verdict',
      },
    ],
    waits: [
      {
        root: 'r',
        task: 'AO-1',
        title: 'One',
        kind: 'ask',
        actor: 'claude:engineer',
        waitingOn: 'human:dawid',
        on: [],
        human: true,
        start: iso(0.5),
        end: iso(0.8),
        answered: true,
        endedBy: 'answer',
      },
    ],
    runs: [
      {
        root: 'r',
        task: 'AO-1',
        agent: 'claude:engineer',
        run: 'run1',
        start: iso(0.1),
        end: iso(1),
        tokens: 5000,
      },
    ],
    decisions: [],
    notes: [{ root: 'r', task: 'AO-1', agent: 'claude:engineer', at: iso(0.9), title: 'A note' }],
    created: [{ root: 'r', task: 'AO-1', title: 'One', at: iso(0), by: 'human:dawid' }],
    closes: [
      { root: 'r', task: 'AO-1', title: 'One', at: iso(2), by: 'codex:reviewer', via: 'verdict' },
    ],
    totals: {
      agentHours: 0.9,
      workHours: 0.9,
      humanMinutes: 4,
      humanWaitMinutes: 18,
      asksAnswered: 1,
      reviewRounds: 1,
      tasksClosed: 1,
      runs: 1,
      tokens: 5000,
    },
    time: {
      segments: [
        { start: T0, end: T0 + H, playStart: 0, playEnd: 10_000, idle: false },
        { start: T0 + H, end: T0 + 2 * H, playStart: 10_000, playEnd: 20_000, idle: false },
        { start: T0 + 2 * H, end: T0 + 3 * H, playStart: 20_000, playEnd: 30_000, idle: false },
      ],
      playbackMs: 30_000,
      maxGapMs: 30 * 60_000,
    },
    graph: {
      tasks: [{ root: 'r', task: 'AO-1', title: 'One', created: iso(0), blockedBy: [] }],
      files: [
        {
          root: 'r',
          task: 'AO-1',
          actor: 'claude:engineer',
          at: iso(0.6),
          path: 'packages/core/src/a.ts',
        },
      ],
      touches: [],
    },
    wrapped: {
      from: iso(0),
      to: iso(3),
      project: null,
      closed: 1,
      opened: 1,
      agentMinutes: 60,
      agentHours: 1,
      humanMinutes: 4,
      busiest: { agent: 'claude:engineer', runs: 1, minutes: 60, tokens: 5000 },
      rally: null,
      fastest: null,
      blocked: null,
    },
  };
}

/**
 * A busy week of a project, for the constellation (AO-0080): 180 tasks (some subtasks, some
 * blocked), 9 actors, 30 learn notes, 400 file mentions over 120 distinct paths and 600 other
 * events, in a 60 s clip.
 * Built from a fixed formula, so it is the same every run.
 */
export function busyFixture(): Timeline {
  const base = fixture();
  const agents = [
    'claude:engineer',
    'claude:pm',
    'claude:qa',
    'codex:engineer',
    'codex:reviewer',
    'cursor:engineer',
    'human:dawid',
    'opsd:merge',
    'opsd:router',
  ];
  const at = (i: number, n: number): string => iso((i / n) * 6);
  const id = (i: number): string => `AO-${String(i + 1).padStart(4, '0')}`;
  const tasks = Array.from({ length: 180 }, (_, i) => ({
    root: 'swarmup',
    task: id(i),
    title: `Task number ${i + 1}`,
    created: at(i, 180),
    ...(i % 7 === 3 ? { parent: id(i - 3) } : {}),
    blockedBy: i % 11 === 5 ? [id(i - 5)] : [],
  }));
  const files = Array.from({ length: 400 }, (_, i) => ({
    root: 'swarmup',
    task: id((i * 37) % 180),
    actor: agents[i % 6]!,
    at: at(i, 400),
    path: `packages/${['core', 'cli', 'desktop', 'supervisor'][i % 4]}/src/file-${(i * 13) % 120}.ts`,
  }));
  return {
    ...base,
    from: iso(0),
    to: iso(6),
    lanes: agents.map((agent, i) => ({
      agent,
      kind: agent.startsWith('human') ? 'human' : agent.startsWith('opsd') ? 'system' : 'agent',
      first: iso(i * 0.1),
      workMs: H,
      runMs: H,
      tokens: 0,
      tasks: 1,
      reviews: 0,
    })),
    created: tasks
      .filter((_, i) => i % 3 === 0)
      .map((t) => ({
        root: t.root,
        task: t.task,
        title: t.title,
        at: t.created,
        by: 'human:dawid',
      })),
    spans: tasks.map((t, i) => ({
      root: t.root,
      task: t.task,
      title: t.title,
      agent: agents[i % 6]!,
      start: at(i, 180),
      end: at(i + 2, 180),
      endedBy: 'review',
    })),
    reviews: [],
    waits: tasks
      .filter((_, i) => i % 13 === 0 && i > 0)
      .map((t, n) => ({
        root: t.root,
        task: t.task,
        title: t.title,
        kind: 'block' as const,
        actor: agents[n % 6]!,
        waitingOn: null,
        on: [id(n)],
        human: false,
        start: t.created,
        end: null,
        answered: false,
        endedBy: 'open',
      })),
    runs: [],
    notes: Array.from({ length: 30 }, (_, i) => ({
      root: 'swarmup',
      task: id(i * 6),
      agent: agents[i % 6]!,
      at: at(i, 30),
      ref: `topic-${i % 5}/a-learn-note-about-thing-number-${i}`,
      title: `A learn note about thing number ${i}`,
    })),
    closes: tasks
      .filter((_, i) => i % 2 === 0)
      .map((t, i) => ({
        root: t.root,
        task: t.task,
        title: t.title,
        at: at(i * 2 + 3, 180),
        by: 'codex:reviewer',
        via: 'verdict',
      })),
    decisions: [],
    // Progress and comments from every actor, including the system ones that hold no task.
    graph: {
      tasks,
      files,
      touches: Array.from({ length: 600 }, (_, i) => ({
        root: 'swarmup',
        task: id((i * 53) % 180),
        actor: agents[i % agents.length]!,
        at: at(i, 600),
        type: i % 2 ? 'comment' : 'progress',
      })),
    },
    time: {
      segments: [{ start: T0, end: T0 + 6 * H, playStart: 0, playEnd: 60_000, idle: false }],
      playbackMs: 60_000,
      maxGapMs: 30 * 60_000,
    },
  };
}
