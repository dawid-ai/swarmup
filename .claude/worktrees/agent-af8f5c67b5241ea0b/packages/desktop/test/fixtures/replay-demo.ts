// A demo replay timeline: one working day of a small team, for scene tests and for stills
// (`node scripts/replay-stills.mjs --fixture`). Three agents build, a reviewer from the other
// provider reviews, the person answers asks and reviews one task, and swarmupd merges.
import type {
  ReviewRound,
  Timeline,
  TimelineClose,
  TimelineLane,
  Wait,
  WorkSpan,
} from '../../ui/src/types';

const H = 3_600_000;
const T0 = Date.parse('2026-11-02T08:00:00.000Z');
const HOURS = 9;
const iso = (h: number): string => new Date(T0 + h * H).toISOString();

const CE = 'claude:engineer';
const XE = 'codex:engineer';
const CD = 'claude:docs';
const XR = 'codex:reviewer';
const CR = 'claude:reviewer';
const ME = 'human:dawid';
const MERGE = 'opsd:merge';

function lane(agent: string, kind: TimelineLane['kind']): TimelineLane {
  return { agent, kind, first: iso(0), workMs: 0, runMs: 0, tokens: 0, tasks: 0, reviews: 0 };
}

/** The demo day over a clip of `clipMs` playback ms (real hours map evenly). */
export function demoTimeline(clipMs = 30_000): Timeline {
  const spans: WorkSpan[] = [];
  const reviews: ReviewRound[] = [];
  const waits: Wait[] = [];
  const closes: TimelineClose[] = [];
  const titles: Record<string, string> = {};
  const work = (task: string, agent: string, a: number, b: number | null, endedBy: string) =>
    spans.push({
      root: 'demo',
      task,
      title: titles[task] ?? task,
      agent,
      start: iso(a),
      end: b === null ? null : iso(b),
      endedBy,
    });
  const review = (
    task: string,
    author: string,
    reviewer: string | null,
    a: number,
    b: number | null,
    verdict?: 'approve' | 'changes',
  ) => {
    const round = reviews.filter((r) => r.task === task).length + 1;
    reviews.push({
      root: 'demo',
      task,
      title: task,
      round,
      author,
      reviewer,
      start: iso(a),
      end: b === null ? null : iso(b),
      ...(verdict ? { verdict, decidedBy: reviewer ?? ME } : {}),
      endedBy: b === null ? 'open' : 'verdict',
    });
  };
  const ask = (task: string, actor: string, a: number, b: number | null) =>
    waits.push({
      root: 'demo',
      task,
      title: task,
      kind: 'ask',
      actor,
      waitingOn: ME,
      on: [],
      human: true,
      start: iso(a),
      end: b === null ? null : iso(b),
      answered: b !== null,
      endedBy: b === null ? 'open' : 'answer',
    });
  const block = (task: string, actor: string, on: string, a: number, b: number | null) =>
    waits.push({
      root: 'demo',
      task,
      title: task,
      kind: 'block',
      actor,
      waitingOn: null,
      on: [on],
      human: false,
      start: iso(a),
      end: b === null ? null : iso(b),
      answered: false,
      endedBy: b === null ? 'open' : 'unblock',
    });
  const close = (task: string, by: string, h: number, via = 'merge') =>
    closes.push({ root: 'demo', task, title: task, at: iso(h), by, via });

  // AO-12: a three-round rally between Claude and Codex.
  work('AO-12', CE, 0.2, 1.6, 'review');
  review('AO-12', CE, XR, 1.6, 2.2, 'changes');
  work('AO-12', CE, 2.3, 3.0, 'review');
  review('AO-12', CE, XR, 3.0, 3.5, 'changes');
  work('AO-12', CE, 3.6, 4.0, 'review');
  review('AO-12', CE, XR, 4.0, 4.4, 'approve');
  close('AO-12', MERGE, 4.6);
  // AO-14: asks the person a scope question, waits, then lands in one round.
  work('AO-14', XE, 0.4, 1.1, 'ask');
  ask('AO-14', XE, 1.1, 2.4);
  work('AO-14', XE, 2.5, 4.6, 'review');
  review('AO-14', XE, CR, 4.6, 5.2, 'approve');
  close('AO-14', MERGE, 5.4);
  // AO-15: docs, blocked on AO-12 until it closes, then reviewed by the person.
  work('AO-15', CD, 0.8, 2.0, 'block');
  block('AO-15', CD, 'AO-12', 2.0, 4.6);
  work('AO-15', CD, 4.7, 6.0, 'review');
  review('AO-15', CD, null, 6.0, 6.9, 'approve');
  close('AO-15', ME, 6.9, 'verdict');
  // AO-17: overlaps AO-12 on the engineer's lane; done without review.
  work('AO-17', CE, 4.5, 6.2, 'done');
  close('AO-17', CE, 6.2, 'done');
  // AO-18: a change request, then an ask at the end of the day still open.
  work('AO-18', XE, 5.0, 6.4, 'review');
  review('AO-18', XE, CR, 6.4, 7.0, 'changes');
  work('AO-18', XE, 7.1, 7.9, 'ask');
  ask('AO-18', XE, 7.9, null);
  // AO-19: in review at the end of the window.
  work('AO-19', CE, 6.4, 8.1, 'review');
  review('AO-19', CE, XR, 8.1, null);
  // AO-20: docs work still open.
  work('AO-20', CD, 7.2, null, 'open');

  // Totals from the day itself. It has no supervised runs, so agent hours are the hours agents
  // held tasks; the person acts at 2.4 h (an answer) and 6.9 h (a verdict and its close), two
  // 2-minute sessions.
  const agentMs = spans
    .filter((s) => s.agent !== ME)
    .reduce((n, s) => n + Date.parse(s.end ?? iso(HOURS)) - Date.parse(s.start), 0);
  const agentHours = Math.round((agentMs / H) * 10) / 10;
  return {
    from: iso(0),
    to: iso(HOURS),
    lanes: [
      lane(CE, 'agent'),
      lane(XE, 'agent'),
      lane(CD, 'agent'),
      lane(XR, 'agent'),
      lane(CR, 'agent'),
      lane(ME, 'human'),
      lane(MERGE, 'system'),
    ],
    spans: spans.sort((a, b) => a.start.localeCompare(b.start)),
    reviews: reviews.sort((a, b) => a.start.localeCompare(b.start)),
    waits: waits.sort((a, b) => a.start.localeCompare(b.start)),
    runs: [],
    decisions: [],
    notes: [],
    created: [],
    closes: closes.sort((a, b) => a.at.localeCompare(b.at)),
    totals: {
      agentHours,
      workHours: agentHours,
      humanMinutes: 4,
      humanWaitMinutes: waits
        .filter((w) => w.human)
        .reduce(
          (n, w) =>
            n + Math.round((Date.parse(w.end ?? iso(HOURS)) - Date.parse(w.start)) / 60_000),
          0,
        ),
      asksAnswered: waits.filter((w) => w.kind === 'ask' && w.answered).length,
      reviewRounds: reviews.length,
      tasksClosed: closes.length,
      runs: 0,
      tokens: 0,
    },
    time: {
      segments: [{ start: T0, end: T0 + HOURS * H, playStart: 0, playEnd: clipMs, idle: false }],
      playbackMs: clipMs,
      maxGapMs: 1_800_000,
    },
  };
}
