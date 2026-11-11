// A plain scene: one row per actor, a dot for each thing they did, appearing as the playhead
// passes it. It shows the player works end to end; the richer scenes build on the same data.
import { identity } from '../../lib/identity';
import { playbackOf, realAt, utcStamp } from '../../lib/replay';
import type { TimeMap, Timeline } from '../../types';
import type { Scene, Stage } from '../scene';

export type MarkKind =
  | 'create'
  | 'claim'
  | 'review'
  | 'approve'
  | 'changes'
  | 'ask'
  | 'answer'
  | 'run'
  | 'note'
  | 'close'
  | 'decision';

export const MARK_COLORS: Record<MarkKind, string> = {
  create: '#5aa9ff',
  claim: '#5ce1e6',
  review: '#b18cff',
  approve: '#3ddc97',
  changes: '#ff9f43',
  ask: '#ffc857',
  answer: '#ffe08a',
  run: '#94a3b8',
  note: '#4fd1c5',
  close: '#3ddc97',
  decision: '#ff7eb6',
};

interface Mark {
  at: number;
  row: number;
  kind: MarkKind;
}

interface Row {
  label: string;
  color: string;
  y: number;
}

export interface EventsData {
  rows: Row[];
  rowHeight: number;
  marks: Mark[];
  duration: number;
  map: TimeMap;
  x0: number;
  x1: number;
  top: number;
}

/** Rows past this many share one "others" row, so labels stay readable. */
const MAX_ROWS = 12;
const OTHERS = 'others';

/** Every actor event in the timeline, as `[actor, ISO time, kind]`. */
function actions(tl: Timeline): Array<[string, string, MarkKind]> {
  const out: Array<[string, string, MarkKind]> = [];
  for (const c of tl.created) out.push([c.by, c.at, 'create']);
  for (const s of tl.spans) out.push([s.agent, s.start, 'claim']);
  for (const r of tl.reviews) {
    out.push([r.author, r.start, 'review']);
    if (r.end && r.decidedBy && r.verdict) out.push([r.decidedBy, r.end, r.verdict]);
  }
  for (const w of tl.waits) {
    if (w.kind !== 'ask') continue;
    out.push([w.actor, w.start, 'ask']);
    if (w.end && w.answered && w.waitingOn) out.push([w.waitingOn, w.end, 'answer']);
  }
  for (const r of tl.runs) out.push([r.agent, r.start, 'run']);
  for (const n of tl.notes) out.push([n.agent, n.at, 'note']);
  for (const c of tl.closes) out.push([c.by, c.at, 'close']);
  for (const d of tl.decisions) {
    out.push([d.proposedBy, d.start, 'decision']);
    if (d.end && d.decidedBy) out.push([d.decidedBy, d.end, 'decision']);
  }
  return out;
}

export function prepareEvents(tl: Timeline, stage: Stage): EventsData {
  const all = actions(tl);
  // Rows in the timeline's lane order, then anyone the lanes leave out.
  const order = [...tl.lanes.map((l) => l.agent)];
  for (const [actor] of all) if (!order.includes(actor)) order.push(actor);
  const shown = order.length > MAX_ROWS ? order.slice(0, MAX_ROWS - 1) : order;
  const labels = order.length > MAX_ROWS ? [...shown, OTHERS] : shown;
  const top = 170;
  const bottom = stage.height - 90;
  const rowHeight = labels.length > 0 ? Math.min(90, (bottom - top) / labels.length) : 90;
  const rows = labels.map((label, i) => ({
    label,
    color: label === OTHERS ? '#94a3b8' : identity(label).provider.color,
    y: top + rowHeight * (i + 0.5),
  }));
  const rowOf = new Map(labels.map((l, i) => [l, i]));
  const marks = all
    .map(([actor, at, kind]) => ({
      at: playbackOf(tl.time, at),
      row: rowOf.get(actor) ?? rowOf.get(OTHERS) ?? 0,
      kind,
    }))
    .sort((a, b) => a.at - b.at || a.row - b.row || a.kind.localeCompare(b.kind));
  return {
    rows,
    rowHeight,
    marks,
    duration: tl.time.playbackMs,
    map: tl.time,
    x0: 330,
    x1: stage.width - 80,
    top,
  };
}

/** How long a new dot stays enlarged, in playback ms. */
const POP_MS = 400;

export const eventsScene: Scene<EventsData> = {
  id: 'events',
  label: 'Events',
  description: 'One row per actor, a dot for each claim, review, ask, run, note and close',
  prepare: prepareEvents,
  render(d, frame) {
    const t = Math.min(Math.max(0, frame.t), d.duration);
    const x = (at: number): number =>
      d.duration > 0 ? d.x0 + (at / d.duration) * (d.x1 - d.x0) : d.x0;
    const shown = d.marks.filter((m) => m.at <= t);
    const r = Math.max(4, Math.min(9, d.rowHeight / 8));
    return (
      <g fontFamily="'IBM Plex Sans', sans-serif">
        <text x={80} y={92} fill="#e6edf3" fontSize={44} fontWeight={600}>
          Replay
        </text>
        <text x={frame.width - 80} y={92} fill="#8b98a5" fontSize={28} textAnchor="end">
          {utcStamp(realAt(d.map, t))}
        </text>
        {d.rows.map((row) => (
          <g key={row.label}>
            <line
              x1={d.x0}
              x2={d.x1}
              y1={row.y}
              y2={row.y}
              stroke="#ffffff"
              strokeOpacity={0.06}
              strokeWidth={2}
            />
            <text
              x={d.x0 - 30}
              y={row.y}
              fill={row.color}
              fontSize={Math.min(26, d.rowHeight * 0.45)}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {row.label}
            </text>
          </g>
        ))}
        {shown.map((m, i) => {
          const age = t - m.at;
          const pop = age < POP_MS ? 1 + 0.8 * (1 - age / POP_MS) : 1;
          return (
            <circle
              key={i}
              cx={x(m.at)}
              cy={d.rows[m.row]?.y ?? 0}
              r={r * pop}
              fill={MARK_COLORS[m.kind]}
              fillOpacity={0.9}
            />
          );
        })}
        <line
          x1={x(t)}
          x2={x(t)}
          y1={d.top - 20}
          y2={frame.height - 70}
          stroke="#5ce1e6"
          strokeWidth={3}
        />
      </g>
    );
  },
};
