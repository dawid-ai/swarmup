// Running totals that count up as the replay plays: tasks closed, review rounds, asks answered,
// runs, learn notes and tokens, each at the playback time it happened.
import { tokens as tokenText } from '../../lib/format';
import { playbackOf, realAt, utcStamp } from '../../lib/replay';
import type { TimeMap, Timeline } from '../../types';
import type { Scene } from '../scene';

interface Counter {
  label: string;
  color: string;
  /** Playback times, ascending; with `weights`, the amount each one adds. */
  times: number[];
  weights?: number[];
}

export interface CountersData {
  counters: Counter[];
  duration: number;
  map: TimeMap;
}

function counter(
  label: string,
  color: string,
  items: Array<[number, number]>,
  weighted = false,
): Counter {
  const sorted = [...items].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    label,
    color,
    times: sorted.map(([t]) => t),
    ...(weighted ? { weights: sorted.map(([, w]) => w) } : {}),
  };
}

export function prepareCounters(tl: Timeline): CountersData {
  const at = (iso: string): number => playbackOf(tl.time, iso);
  return {
    counters: [
      counter(
        'Tasks closed',
        '#3ddc97',
        tl.closes.map((c) => [at(c.at), 1]),
      ),
      counter(
        'Review rounds',
        '#b18cff',
        tl.reviews.map((r) => [at(r.start), 1]),
      ),
      counter(
        'Asks answered',
        '#ffc857',
        tl.waits.filter((w) => w.kind === 'ask' && w.answered && w.end).map((w) => [at(w.end!), 1]),
      ),
      counter(
        'Runs',
        '#94a3b8',
        tl.runs.map((r) => [at(r.start), 1]),
      ),
      counter(
        'Learn notes',
        '#4fd1c5',
        tl.notes.map((n) => [at(n.at), 1]),
      ),
      counter(
        'Tokens',
        '#f08a5d',
        tl.runs.filter((r) => r.end && r.tokens).map((r) => [at(r.end!), r.tokens!]),
        true,
      ),
    ],
    duration: tl.time.playbackMs,
    map: tl.time,
  };
}

/** The value of `c` at playback time `t`: the count (or weight sum) of times at or before it. */
export function valueAt(c: Counter, t: number): number {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < c.times.length && c.times[i]! <= t; i++) {
    n++;
    sum += c.weights?.[i] ?? 1;
  }
  return c.weights ? sum : n;
}

export const countersScene: Scene<CountersData> = {
  id: 'counters',
  label: 'Counters',
  description: 'Totals that count up as it plays: closes, review rounds, asks, runs, notes, tokens',
  prepare: (tl) => prepareCounters(tl),
  render(d, frame) {
    const t = Math.min(Math.max(0, frame.t), d.duration);
    const cols = 3;
    const pad = 80;
    const gap = 40;
    const top = 170;
    const w = (frame.width - pad * 2 - gap * (cols - 1)) / cols;
    const rows = Math.ceil(d.counters.length / cols);
    const h = Math.min(340, (frame.height - top - 160 - gap * (rows - 1)) / rows);
    const progress = d.duration > 0 ? t / d.duration : 0;
    return (
      <g fontFamily="'IBM Plex Sans', sans-serif">
        <text x={pad} y={92} fill="#e6edf3" fontSize={44} fontWeight={600}>
          Replay totals
        </text>
        <text x={frame.width - pad} y={92} fill="#8b98a5" fontSize={28} textAnchor="end">
          {utcStamp(realAt(d.map, t))}
        </text>
        {d.counters.map((c, i) => {
          const x = pad + (i % cols) * (w + gap);
          const y = top + Math.floor(i / cols) * (h + gap);
          const v = valueAt(c, t);
          return (
            <g key={c.label}>
              <rect
                x={x}
                y={y}
                width={w}
                height={h}
                rx={24}
                fill="#ffffff"
                fillOpacity={0.04}
                stroke={c.color}
                strokeOpacity={0.35}
                strokeWidth={2}
              />
              <text x={x + 40} y={y + 70} fill="#8b98a5" fontSize={30}>
                {c.label}
              </text>
              <text
                x={x + 40}
                y={y + h - 50}
                fill={c.color}
                fontSize={Math.min(130, h * 0.45)}
                fontWeight={600}
              >
                {c.weights ? tokenText(v) : String(v)}
              </text>
            </g>
          );
        })}
        <rect
          x={pad}
          y={frame.height - 90}
          width={frame.width - pad * 2}
          height={10}
          rx={5}
          fill="#ffffff"
          fillOpacity={0.08}
        />
        <rect
          x={pad}
          y={frame.height - 90}
          width={(frame.width - pad * 2) * progress}
          height={10}
          rx={5}
          fill="#5ce1e6"
        />
      </g>
    );
  },
};
