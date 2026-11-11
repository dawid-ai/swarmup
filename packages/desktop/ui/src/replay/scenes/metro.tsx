// Metro map (AO-0081): the project as a transit map that grows as playback advances. The main
// line runs along the time axis. Each task is a line that branches off at its first claim, runs
// on its own track, and merges back into the main line when it closes. Review rounds are
// stations, filled in when the verdict lands; human decisions (answered asks, human verdicts and
// decisions) are interchanges; parked ideas are short stubs that end in a buffer.
//
// Time runs left to right on landscape and square stages, and top to bottom on portrait ones, so
// 9:16 gets a tall map instead of a squashed one. All layout happens in `prepare`; `render` only
// clips the prepared paths to the playhead.
import type { ReactElement } from 'react';
import { identity } from '../../lib/identity';
import { playbackOf, realAt, utcStamp } from '../../lib/replay';
import type { TimeMap, Timeline } from '../../types';
import type { Scene, Stage } from '../scene';

/** Line colors, in the order lines open. */
export const LINE_COLORS = [
  '#e4572e',
  '#f3a712',
  '#2ec4b6',
  '#4f86f7',
  '#b56cf0',
  '#ff5d8f',
  '#7bd34f',
  '#00b4d8',
  '#ff8c42',
  '#c9e265',
  '#f15bb5',
  '#9b8cff',
];

const MAIN_COLOR = '#e6edf3';
const IDEA_COLOR = '#ffc857';
const APPROVE_COLOR = '#3ddc97';
const CHANGES_COLOR = '#ff9f43';
const HUMAN_COLOR = identity('human:x').provider.color;
const TEXT = '#e6edf3';
const MUTED = '#8b98a5';
const BACK = '#0b0f14';

/** Track spacing bounds, in SVG units. Below the minimum, tracks are shared. */
const MAX_PITCH = 44;
const MIN_PITCH = 9;
/** The 45° corner where a line leaves or rejoins the main line. */
const CORNER = 14;
/** Room left between two lines that share a track. */
const TRACK_GAP = 10;
/** How long an idea stub runs before its buffer. */
const STUB = 26;
/** How long a new station, interchange or merge stays highlighted, in playback ms. */
const POP_MS = 450;

type Point = [number, number];

export interface Station {
  /** Playback ms it appears. */
  t: number;
  /** Position along the line's track. */
  u: number;
  kind: 'review' | 'interchange';
  /** For a review: the verdict and when it landed. */
  verdict?: 'approve' | 'changes';
  verdictT?: number;
  /** A review a human decided, which turns into an interchange when the verdict lands. */
  human: boolean;
}

export interface MetroLine {
  /** `root/task`, unique across roots. */
  key: string;
  task: string;
  color: string;
  /** Signed track number: 1, -1, 2, -2 and so on away from the main line. */
  track: number;
  /** Playback ms the line opens and the one its last point is reached. */
  t0: number;
  t1: number;
  /** How the line ends: back into the main line, still running at the end, or in a buffer. */
  end: 'merge' | 'open' | 'stop';
  stub: boolean;
  /** The path in (along, across) units, across measured from the main line. */
  points: Point[];
  /** Where the track run starts, for the label. */
  runU: number;
  label: boolean;
  stations: Station[];
}

export interface MetroData {
  portrait: boolean;
  /** The time axis, in along units. */
  u0: number;
  u1: number;
  /** The main line's across position on the stage. */
  main: number;
  pitch: number;
  lineWidth: number;
  lines: MetroLine[];
  /** Human decisions with no line on the map, drawn on the main line. */
  mainStops: Station[];
  duration: number;
  map: TimeMap;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/** Track order away from the main line: 1, -1, 2, -2, … up to `perSide` each way. */
function trackOrder(perSide: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= perSide; i++) out.push(i, -i);
  return out;
}

interface Interval {
  a: number;
  b: number;
}

/**
 * Puts each interval on the nearest free track. With `perSide` set and every track busy, the
 * interval shares the track that frees up first.
 */
export function allocateTracks(items: Interval[], perSide?: number): number[] {
  // n intervals never need more than n tracks a side, so that bounds the unlimited case.
  const order = trackOrder(Math.max(1, Math.min(perSide ?? items.length, items.length)));
  const ends = new Map<number, number>();
  return items.map((it) => {
    const free = order.find((k) => (ends.get(k) ?? -Infinity) < it.a);
    let pick = free ?? order[0]!;
    if (free === undefined) {
      for (const k of order)
        if ((ends.get(k) ?? -Infinity) < (ends.get(pick) ?? -Infinity)) pick = k;
    }
    ends.set(pick, Math.max(ends.get(pick) ?? -Infinity, it.b));
    return pick;
  });
}

/** The points of a line from `a0` to `a1` on track offset `v`, with 45° corners of up to `c`. */
function linePath(a0: number, a1: number, v: number, c: number, end: MetroLine['end']): Point[] {
  const s = Math.sign(v) || 1;
  const k = Math.min(c, Math.abs(v), end === 'merge' ? (a1 - a0) / 2 : a1 - a0);
  const pts: Point[] = [[a0, 0]];
  if (Math.abs(v) > k) pts.push([a0, v - s * k]);
  pts.push([a0 + k, v]);
  if (end === 'merge') {
    pts.push([a1 - k, v]);
    if (Math.abs(v) > k) pts.push([a1, v - s * k]);
    pts.push([a1, 0]);
  } else {
    pts.push([a1, v]);
  }
  return pts;
}

/** The part of a path up to `u` along; the path never runs backwards in `u`. */
export function clipPath(points: Point[], u: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p[0] <= u) {
      out.push(p);
      continue;
    }
    const prev = points[i - 1];
    if (prev && u > prev[0]) {
      const f = (u - prev[0]) / (p[0] - prev[0]);
      out.push([u, prev[1] + f * (p[1] - prev[1])]);
    }
    break;
  }
  return out;
}

interface Gather {
  root: string;
  task: string;
  starts: number[];
  ends: number[];
  open: boolean;
  close: number | null;
  stations: Array<Omit<Station, 'u'>>;
}

export function prepareMetro(tl: Timeline, stage: Stage): MetroData {
  const portrait = stage.height > stage.width;
  const duration = Math.max(0, tl.time.playbackMs);
  const at = (iso: string): number => clamp(playbackOf(tl.time, iso), 0, duration);
  // Items keep their real ends, which can fall after the window. Anything that ends at or after
  // `to` still runs at the window's end, so it counts as open and its verdict or answer is not
  // shown yet.
  const toMs = Date.parse(tl.to);
  const endIn = (end: string | null): string | null =>
    end !== null && !(Date.parse(end) >= toMs) ? end : null;

  // The stage split: header and legend on top and bottom, the map in between.
  const head = portrait ? 230 : 150;
  const foot = portrait ? 170 : 96;
  const u0 = portrait ? head + 30 : 110;
  const u1 = portrait ? stage.height - foot - 20 : stage.width - 70;
  const across0 = portrait ? 40 : head + 10;
  const across1 = portrait ? stage.width - 40 : stage.height - foot;
  const main = (across0 + across1) / 2;
  const half = (across1 - across0) / 2;
  const uOf = (t: number): number => (duration > 0 ? u0 + (t / duration) * (u1 - u0) : u0);

  // Everything each task did, keyed by root and task.
  const tasks = new Map<string, Gather>();
  const get = (root: string, task: string): Gather => {
    const key = `${root}/${task}`;
    let g = tasks.get(key);
    if (!g) {
      g = { root, task, starts: [], ends: [], open: false, close: null, stations: [] };
      tasks.set(key, g);
    }
    return g;
  };
  for (const s of tl.spans) {
    const g = get(s.root, s.task);
    g.starts.push(at(s.start));
    const end = endIn(s.end);
    if (end) g.ends.push(at(end));
    else g.open = true;
  }
  for (const r of tl.reviews) {
    const g = get(r.root, r.task);
    const t = at(r.start);
    g.starts.push(t);
    const end = endIn(r.end);
    if (end) g.ends.push(at(end));
    else g.open = true;
    const human = !!end && !!r.decidedBy && identity(r.decidedBy).human;
    g.stations.push({
      t,
      kind: 'review',
      human,
      ...(end && r.verdict ? { verdict: r.verdict, verdictT: at(end) } : {}),
    });
  }
  for (const w of tl.waits) {
    // An ask comes from an agent working the task, so it opens the line even when the claim
    // before it ended ahead of the window (`at` clamps its start to the window start). A block
    // can be filed on a task nobody claimed yet, so it only extends a line already on the map.
    const g = w.kind === 'ask' ? get(w.root, w.task) : tasks.get(`${w.root}/${w.task}`);
    if (!g) continue;
    if (w.kind === 'ask') g.starts.push(at(w.start));
    const end = endIn(w.end);
    if (end) g.ends.push(at(end));
    else g.open = true;
    if (w.kind === 'ask' && w.human && w.answered && end) {
      g.stations.push({ t: at(end), kind: 'interchange', human: true });
    }
  }
  for (const c of tl.closes) {
    const g = tasks.get(`${c.root}/${c.task}`);
    if (g && g.close === null) g.close = at(c.at);
  }
  const loose: Array<Omit<Station, 'u'>> = [];
  for (const d of tl.decisions) {
    const end = endIn(d.end);
    if (!end || !d.decidedBy || !identity(d.decidedBy).human) continue;
    const g = d.task ? tasks.get(`${d.root}/${d.task}`) : undefined;
    const st = { t: at(end), kind: 'interchange' as const, human: true };
    if (g) g.stations.push(st);
    else loose.push(st);
  }

  // Lines, then idea stubs, in the order they open.
  interface Draft {
    key: string;
    task: string;
    t0: number;
    t1: number;
    end: MetroLine['end'];
    stub: boolean;
    stations: Array<Omit<Station, 'u'>>;
  }
  const drafts: Draft[] = [];
  for (const [key, g] of tasks) {
    if (g.starts.length === 0) continue;
    const t0 = Math.min(...g.starts);
    let t1: number;
    let end: MetroLine['end'];
    if (g.close !== null && g.close >= t0) {
      t1 = g.close;
      end = 'merge';
    } else if (g.open) {
      t1 = duration;
      end = 'open';
    } else {
      t1 = Math.max(t0, ...g.ends);
      end = 'stop';
    }
    drafts.push({ key, task: g.task, t0, t1, end, stub: false, stations: g.stations });
  }
  for (const c of tl.created) {
    if (c.type !== 'idea' || tasks.has(`${c.root}/${c.task}`)) continue;
    const t = at(c.at);
    drafts.push({
      key: `${c.root}/${c.task}`,
      task: c.task,
      t0: t,
      t1: t,
      end: 'stop',
      stub: true,
      stations: [],
    });
  }
  drafts.sort((a, b) => a.t0 - b.t0 || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Along extents: a line is at least two corners long, a stub one corner and its run.
  const spans = drafts.map((d) => {
    const a0 = uOf(d.t0);
    const min = d.stub ? CORNER + STUB : d.end === 'merge' ? 2 * CORNER : CORNER;
    return { a: a0, b: Math.max(uOf(d.t1), a0 + min) };
  });
  const padded = spans.map((s) => ({ a: s.a, b: s.b + TRACK_GAP }));
  let tracks = allocateTracks(padded);
  const need = Math.max(1, ...tracks.map((k) => Math.abs(k)));
  const room = Math.max(1, Math.floor((half - 10) / MIN_PITCH));
  if (need > room) tracks = allocateTracks(padded, room);
  const perSide = Math.min(need, room);
  const pitch = clamp((half - 10) / (perSide + 0.4), MIN_PITCH, MAX_PITCH);
  const lineWidth = clamp(pitch * 0.32, 3, 10);
  const fontSize = clamp(pitch * 0.5, 11, 18);

  const lines: MetroLine[] = drafts.map((d, i) => {
    const { a: a0, b: a1 } = spans[i]!;
    const track = tracks[i]!;
    const v = track * pitch;
    const k = Math.min(CORNER, Math.abs(v));
    const points = linePath(a0, a1, v, CORNER, d.end);
    const runA = a0 + k;
    const runB = d.end === 'merge' ? a1 - k : a1;
    const stations: Station[] = d.stations
      .map((s) => ({
        ...s,
        u: runB > runA ? clamp(uOf(s.t), runA, runB) : (runA + runB) / 2,
      }))
      .sort((x, y) => x.t - y.t || x.u - y.u);
    const labelRoom = runB - runA - 8;
    return {
      key: d.key,
      task: d.task,
      color: d.stub ? IDEA_COLOR : LINE_COLORS[i % LINE_COLORS.length]!,
      track,
      t0: d.t0,
      t1: d.t1,
      end: d.end,
      stub: d.stub,
      points,
      runU: runA,
      label: !d.stub && pitch >= 18 && labelRoom >= d.task.length * fontSize * 0.62,
      stations,
    };
  });

  return {
    portrait,
    u0,
    u1,
    main,
    pitch,
    lineWidth,
    lines,
    mainStops: loose.map((s) => ({ ...s, u: uOf(s.t) })).sort((a, b) => a.t - b.t),
    duration,
    map: tl.time,
  };
}

/** Counts at playback time `t`, for the header. */
export function metroCounts(d: MetroData, t: number) {
  let lines = 0;
  let merged = 0;
  let stations = 0;
  let interchanges = 0;
  let ideas = 0;
  for (const l of d.lines) {
    if (l.t0 > t) continue;
    if (l.stub) ideas++;
    else lines++;
    if (l.end === 'merge' && l.t1 <= t) merged++;
    for (const s of l.stations) {
      if (s.t > t) continue;
      if (s.kind === 'interchange' || (s.human && s.verdictT !== undefined && s.verdictT <= t)) {
        interchanges++;
      } else stations++;
    }
  }
  for (const s of d.mainStops) if (s.t <= t) interchanges++;
  return { lines, merged, stations, interchanges, ideas };
}

const r1 = (x: number): number => Math.round(x * 10) / 10;

/** A pop factor: 1 + `amount` right after `since`, easing back to 1 over `POP_MS`. */
function pop(t: number, since: number, amount: number): number {
  const age = t - since;
  return age >= 0 && age < POP_MS ? 1 + amount * (1 - age / POP_MS) : 1;
}

function Interchange({ x, y, r }: { x: number; y: number; r: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r + 3} fill={HUMAN_COLOR} />
      <circle
        cx={x}
        cy={y}
        r={r}
        fill="#ffffff"
        stroke={BACK}
        strokeWidth={Math.max(2, r * 0.38)}
      />
    </g>
  );
}

function Legend({ d, width, y }: { d: MetroData; width: number; y: number }) {
  const lw = 6;
  const items: Array<{ label: string; icon: (x: number, y: number) => ReactElement }> = [
    {
      label: 'task line',
      icon: (x, cy) => (
        <path
          d={`M${x} ${cy + 9} L${x + 9} ${cy} L${x + 34} ${cy}`}
          stroke={LINE_COLORS[3]}
          strokeWidth={lw}
          fill="none"
          strokeLinejoin="round"
        />
      ),
    },
    {
      label: 'review station',
      icon: (x, cy) => (
        <circle cx={x + 14} cy={cy} r={8} fill={APPROVE_COLOR} stroke="#ffffff" strokeWidth={3} />
      ),
    },
    { label: 'human decision', icon: (x, cy) => <Interchange x={x + 14} y={cy} r={9} /> },
    {
      label: 'parked idea',
      icon: (x, cy) => (
        <g stroke={IDEA_COLOR} strokeWidth={lw} fill="none">
          <path d={`M${x} ${cy} L${x + 24} ${cy}`} strokeDasharray="6 4" />
          <path d={`M${x + 28} ${cy - 10} L${x + 28} ${cy + 10}`} />
        </g>
      ),
    },
  ];
  // Portrait: two columns of two. Otherwise one row, each entry as wide as its text (estimated
  // at 0.55 em a character, since a frame cannot measure text), centered.
  const fontSize = d.portrait ? 30 : width < 1400 ? 21 : 24;
  const wide = items.map((it) => 48 + it.label.length * fontSize * 0.55 + 40);
  const rowStart = (width - wide.reduce((a, b) => a + b, 0) + 40) / 2;
  const place = (i: number): Point =>
    d.portrait
      ? [60 + (i % 2) * ((width - 120) / 2), y + Math.floor(i / 2) * 52]
      : [rowStart + wide.slice(0, i).reduce((a, b) => a + b, 0), y];
  return (
    <g fontSize={fontSize} fill={MUTED}>
      {items.map((it, i) => {
        const [x, cy] = place(i);
        return (
          <g key={it.label}>
            {it.icon(x, cy)}
            <text x={x + 48} y={cy} dominantBaseline="middle">
              {it.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export const metroScene: Scene<MetroData> = {
  id: 'metro',
  label: 'Metro map',
  description:
    'Tasks branch off the main line at claim, stop at review stations and merge back on approval',
  prepare: prepareMetro,
  render(d, frame) {
    const t = clamp(frame.t, 0, d.duration);
    const ut = d.duration > 0 ? d.u0 + (t / d.duration) * (d.u1 - d.u0) : d.u0;
    const at = (u: number, v: number): Point => (d.portrait ? [d.main + v, u] : [u, d.main + v]);
    const pathOf = (pts: Point[]): string =>
      pts
        .map((p, i) => {
          const [x, y] = at(p[0], p[1]);
          return `${i === 0 ? 'M' : 'L'}${r1(x)} ${r1(y)}`;
        })
        .join(' ');
    const lw = d.lineWidth;
    const counts = metroCounts(d, t);
    const stamp = utcStamp(realAt(d.map, t));

    // Far tracks first, so lines near the main line draw over the risers that cross them.
    const visible = d.lines
      .filter((l) => l.t0 <= t)
      .sort((a, b) => Math.abs(b.track) - Math.abs(a.track) || a.t0 - b.t0);
    const mainEnd = at(Math.max(ut, d.u0), 0);
    const mainStart = at(d.u0, 0);
    const title = d.portrait ? 64 : 48;
    const stats = [
      `${counts.lines} lines`,
      `${counts.merged} merged`,
      `${counts.stations} stations`,
      `${counts.interchanges} human decisions`,
      ...(counts.ideas > 0 ? [`${counts.ideas} parked ideas`] : []),
    ].join('  ·  ');

    return (
      <g fontFamily="'IBM Plex Sans', sans-serif">
        <text
          x={d.portrait ? 60 : 80}
          y={d.portrait ? 110 : 82}
          fill={TEXT}
          fontSize={title}
          fontWeight={600}
        >
          Metro map
        </text>
        <text
          x={d.portrait ? 60 : 80}
          y={d.portrait ? 168 : 124}
          fill={MUTED}
          fontSize={d.portrait ? 27 : 24}
        >
          {stats}
        </text>
        <text
          x={frame.width - (d.portrait ? 60 : 80)}
          y={d.portrait ? 110 : 82}
          fill={MUTED}
          fontSize={d.portrait ? 28 : 26}
          textAnchor="end"
        >
          {stamp}
        </text>

        {visible.map((l) => {
          const pts = clipPath(l.points, ut);
          if (pts.length < 2) return null;
          const tip = pts[pts.length - 1]!;
          const done = l.t1 <= t;
          const [tx, ty] = at(tip[0], tip[1]);
          return (
            <g key={l.key}>
              <path
                d={pathOf(pts)}
                stroke={BACK}
                strokeWidth={lw + 5}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <path
                d={pathOf(pts)}
                stroke={l.color}
                strokeWidth={lw}
                fill="none"
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeOpacity={l.stub ? 0.85 : 1}
                {...(l.stub ? { strokeDasharray: `${r1(lw * 1.2)} ${r1(lw * 0.8)}` } : {})}
              />
              {done && l.end === 'stop' ? (
                <path
                  d={pathOf([
                    [tip[0], tip[1] - lw * 1.4],
                    [tip[0], tip[1] + lw * 1.4],
                  ])}
                  stroke={l.color}
                  strokeWidth={lw * 0.8}
                  strokeLinecap="round"
                />
              ) : null}
              {!done ? <circle cx={r1(tx)} cy={r1(ty)} r={r1(lw * 0.75)} fill="#ffffff" /> : null}
            </g>
          );
        })}

        <path
          d={`M${r1(mainStart[0])} ${r1(mainStart[1])} L${r1(mainEnd[0])} ${r1(mainEnd[1])}`}
          stroke={MAIN_COLOR}
          strokeWidth={r1(lw * 1.5)}
          strokeLinecap="round"
        />
        <text
          x={r1(d.portrait ? d.main : mainStart[0] - 18)}
          y={r1(d.portrait ? mainStart[1] - 18 : mainStart[1])}
          fill={MAIN_COLOR}
          fontSize={d.portrait ? 26 : 22}
          fontWeight={600}
          textAnchor={d.portrait ? 'middle' : 'end'}
          dominantBaseline={d.portrait ? 'auto' : 'middle'}
        >
          main
        </text>

        {visible.map((l) =>
          l.end === 'merge' && l.t1 <= t && t - l.t1 < POP_MS * 1.6 ? (
            <circle
              key={`m-${l.key}`}
              cx={r1(at(l.points[l.points.length - 1]![0], 0)[0])}
              cy={r1(at(l.points[l.points.length - 1]![0], 0)[1])}
              r={r1(lw * (1 + (2.4 * (t - l.t1)) / (POP_MS * 1.6)))}
              fill="none"
              stroke={l.color}
              strokeWidth={3}
              strokeOpacity={r1(1 - (t - l.t1) / (POP_MS * 1.6))}
            />
          ) : null,
        )}

        {visible.flatMap((l) =>
          l.stations
            .filter((s) => s.t <= t)
            .map((s, i) => {
              const [x, y] = at(s.u, l.track * d.pitch);
              const decided = s.verdictT !== undefined && s.verdictT <= t;
              const r = Math.max(4, lw * 0.95);
              if (s.kind === 'interchange' || (s.human && decided)) {
                const since = s.kind === 'interchange' ? s.t : (s.verdictT ?? s.t);
                return (
                  <Interchange
                    key={`${l.key}-${i}`}
                    x={r1(x)}
                    y={r1(y)}
                    r={r1(r * 1.25 * pop(t, since, 0.9))}
                  />
                );
              }
              const fill = decided
                ? s.verdict === 'approve'
                  ? APPROVE_COLOR
                  : CHANGES_COLOR
                : BACK;
              const grow = pop(t, decided ? (s.verdictT ?? s.t) : s.t, 0.8);
              return (
                <circle
                  key={`${l.key}-${i}`}
                  cx={r1(x)}
                  cy={r1(y)}
                  r={r1(r * grow)}
                  fill={fill}
                  stroke="#ffffff"
                  strokeWidth={r1(Math.max(2, lw * 0.4))}
                />
              );
            }),
        )}
        {d.mainStops
          .filter((s) => s.t <= t)
          .map((s, i) => {
            const [x, y] = at(s.u, 0);
            return (
              <Interchange
                key={`main-${i}`}
                x={r1(x)}
                y={r1(y)}
                r={r1(Math.max(5, lw * 1.3) * pop(t, s.t, 0.9))}
              />
            );
          })}

        <circle cx={r1(mainEnd[0])} cy={r1(mainEnd[1])} r={r1(lw * 1.1)} fill={MAIN_COLOR} />

        {/* Labels last, with a halo, so lines and stations drawn later never cover them. */}
        <g
          fontSize={r1(clamp(d.pitch * 0.5, 11, 18))}
          fontWeight={600}
          stroke={BACK}
          strokeWidth={4}
          strokeLinejoin="round"
          paintOrder="stroke"
        >
          {visible
            .filter((l) => l.label)
            .map((l) => {
              const s = Math.sign(l.track) || 1;
              const [x, y] = at(l.runU + 6, l.track * d.pitch + s * (lw / 2 + 5));
              return (
                <text
                  key={`l-${l.key}`}
                  x={r1(x)}
                  y={r1(y)}
                  fill={l.color}
                  dominantBaseline={s < 0 !== d.portrait ? 'auto' : 'hanging'}
                  {...(d.portrait ? { transform: `rotate(90 ${r1(x)} ${r1(y)})` } : {})}
                >
                  {l.task}
                </text>
              );
            })}
        </g>

        <Legend d={d} width={frame.width} y={d.portrait ? frame.height - 130 : frame.height - 48} />
      </g>
    );
  },
};
