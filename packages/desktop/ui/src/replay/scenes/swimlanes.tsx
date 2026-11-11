// Swimlanes (AO-0077): one lane per actor on the playback time axis. Tasks are bars colored by
// state: held and worked on, in review on the reviewer's lane, blocked on the actor's lane, and
// waiting on a person on that person's lane. Review rounds arc from author to reviewer and back
// with the verdict; a wait on a person glows from the ask until the answer lands.
//
// The layout follows the stage: labels sit left of the lanes on a wide stage and above them on a
// square or tall one, and every size scales with the stage's short side, so 16:9, 1:1 and 9:16
// recordings all read at 1080 px.
//
// The clip closes on the Human loop stat card (AO-0083) for `CARD_MS` after the timeline ends.
import { identity } from '../../lib/identity';
import { playbackOf, realAt, utcStamp } from '../../lib/replay';
import type { TimeMap, Timeline } from '../../types';
import type { ReactElement } from 'react';
import type { Frame, Scene, Stage } from '../scene';
import type { LoopCard } from './loop-card';
import { CARD_MS, loopCard, renderLoopCard } from './loop-card';

export type BarState = 'working' | 'done' | 'review' | 'blocked' | 'waiting';

export const STATE_COLORS: Record<BarState, string> = {
  working: '#5aa9ff',
  done: '#3ddc97',
  review: '#b18cff',
  blocked: '#ff9f43',
  waiting: '#ffc857',
};

const LEGEND: Array<[BarState, string]> = [
  ['working', 'Working'],
  ['review', 'In review'],
  ['blocked', 'Blocked'],
  ['waiting', 'Waiting on a person'],
  ['done', 'Done'],
];

export const ARC_COLORS = {
  review: STATE_COLORS.review,
  approve: '#3ddc97',
  changes: '#ff9f43',
  ask: STATE_COLORS.waiting,
  answer: '#ffe08a',
} as const;

export type ArcKind = keyof typeof ARC_COLORS;

/** One bar on a lane, in playback ms. `end` is the clip end for items still open. */
export interface Bar {
  lane: number;
  track: number;
  task: string;
  start: number;
  end: number;
  state: BarState;
  /** For a work bar that ended with the task done: from `end` on it shows as done. */
  closes: boolean;
  /** Glows while the playhead is inside it: a wait on a person. */
  glow: boolean;
  /**
   * Playback time at which the next bar on the same lane and track starts (Infinity if none).
   * A full lane stacks overflow bars on top of each other; a label stays inside this room.
   */
  next: number;
}

/** A curve from one lane to another at playback time `at`. */
export interface Arc {
  from: number;
  to: number;
  at: number;
  kind: ArcKind;
}

export interface Lane {
  label: string;
  color: string;
  kind: 'agent' | 'human' | 'system' | 'others';
  tracks: number;
  /** Center of the lane's first track and the lane's band, in SVG units. */
  y: number;
  top: number;
  height: number;
}

export interface Layout {
  s: number;
  wide: boolean;
  x0: number;
  x1: number;
  /** Top of the first lane and bottom of the last. */
  top: number;
  bottom: number;
  trackHeight: number;
  /** Space above each lane for its label when labels sit above the lanes. */
  labelBand: number;
  legendRows: Array<Array<{ state: BarState; label: string; x: number }>>;
  headerY: number;
  /** The time stamp: right of the title when the stage is at least square, else below it. */
  stampY: number;
  stampEnd: boolean;
  legendY: number;
}

export interface SwimlanesData {
  lanes: Lane[];
  bars: Bar[];
  arcs: Arc[];
  /**
   * The opacity an arc fades to once drawn. A few arcs stay as the review history; with many,
   * they fade out, since hundreds of curves would hide the bars.
   */
  arcFloor: number;
  /** Task closes as `[lane, playback ms]`, drawn as a mark on the closer's lane. */
  closes: Array<[number, number]>;
  duration: number;
  map: TimeMap;
  layout: Layout;
  /** The closing stat card. */
  card: LoopCard;
}

/** Lanes past this many share one "others" lane, so labels and bars stay readable (16:9). */
export const MAX_LANES = 9;
/** Bars that overlap on one lane stack into at most this many tracks; more share the last. */
export const MAX_TRACKS = 3;
/** Up to this many arcs keep a trace once drawn; past it they fade out (see `arcFloor`). */
export const ARC_TRACE_LIMIT = 40;
const OTHERS = 'others';
const ORDER: Record<Lane['kind'], number> = { agent: 0, human: 1, system: 2, others: 3 };

/**
 * Lane and track limits for a stage. A square stage has the least room for lanes once each
 * carries its label above it, so it shows fewer lanes and tracks.
 */
export function laneLimits(stage: Stage): { lanes: number; tracks: number } {
  const ratio = stage.width / stage.height;
  if (ratio >= 1.3 || ratio <= 0.75) return { lanes: MAX_LANES, tracks: MAX_TRACKS };
  return { lanes: 7, tracks: 2 };
}

/** Sizes and positions for a stage; every length scales with its short side. */
export function swimlanesLayout(stage: Stage, laneCount: number): Layout {
  const s = Math.min(stage.width, stage.height) / 1080;
  const wide = stage.width / stage.height >= 1.3;
  const margin = 70 * s;
  const x0 = wide ? 360 * s : margin;
  const x1 = stage.width - margin;
  const headerY = 95 * s;
  const stampEnd = stage.width >= stage.height;
  const stampY = stampEnd ? headerY : headerY + 56 * s;
  // Legend chips wrap to the next row when the stage is narrow.
  const legendRows: Layout['legendRows'] = [[]];
  const chip = (label: string): number => (34 + label.length * 12 + 36) * s;
  let x = margin;
  for (const [state, label] of LEGEND) {
    if (x + chip(label) > x1 && legendRows[legendRows.length - 1]!.length > 0) {
      legendRows.push([]);
      x = margin;
    }
    legendRows[legendRows.length - 1]!.push({ state, label, x });
    x += chip(label);
  }
  const legendY = stampY + 70 * s;
  const top = legendY + (legendRows.length - 1) * 44 * s + 70 * s;
  const bottom = stage.height - 80 * s;
  const labelBand = wide ? 0 : 36 * s;
  const lanes = Math.max(1, laneCount);
  const trackHeight = Math.min((wide ? 34 : 40) * s, ((bottom - top) / lanes - labelBand) * 0.8);
  return {
    s,
    wide,
    x0,
    x1,
    top,
    bottom,
    trackHeight,
    labelBand,
    legendRows,
    headerY,
    stampY,
    stampEnd,
    legendY,
  };
}

interface Item {
  actor: string;
  task: string;
  start: number;
  end: number;
  state: BarState;
  closes: boolean;
  glow: boolean;
}

function laneKind(tl: Timeline, actor: string): Lane['kind'] {
  const lane = tl.lanes.find((l) => l.agent === actor);
  if (lane) return lane.kind;
  if (actor.startsWith('human:')) return 'human';
  return actor.startsWith('opsd:') ? 'system' : 'agent';
}

export function prepareSwimlanes(tl: Timeline, stage: Stage): SwimlanesData {
  const at = (iso: string): number => playbackOf(tl.time, iso);
  const duration = tl.time.playbackMs;
  const endOf = (iso: string | null): number => (iso ? at(iso) : duration);
  const firstHuman = tl.lanes.find((l) => l.kind === 'human')?.agent ?? null;

  const items: Item[] = [];
  const arcs: Array<{ from: string; to: string; at: number; kind: ArcKind }> = [];
  for (const s of tl.spans) {
    items.push({
      actor: s.agent,
      task: s.task,
      start: at(s.start),
      end: endOf(s.end),
      state: 'working',
      closes: s.endedBy === 'done',
      glow: false,
    });
  }
  for (const r of tl.reviews) {
    // No reviewer named means the person reviews.
    const reviewer = r.reviewer ?? firstHuman;
    if (!reviewer) continue;
    items.push({
      actor: reviewer,
      task: r.task,
      start: at(r.start),
      end: endOf(r.end),
      state: 'review',
      closes: false,
      glow: false,
    });
    arcs.push({ from: r.author, to: reviewer, at: at(r.start), kind: 'review' });
    if (r.end && r.verdict) {
      arcs.push({ from: r.decidedBy ?? reviewer, to: r.author, at: at(r.end), kind: r.verdict });
    }
  }
  for (const w of tl.waits) {
    const onPerson = w.human && w.waitingOn !== null;
    items.push({
      actor: onPerson ? w.waitingOn! : w.actor,
      task: w.task,
      start: at(w.start),
      end: endOf(w.end),
      state: onPerson ? 'waiting' : 'blocked',
      closes: false,
      glow: onPerson,
    });
    if (onPerson) {
      arcs.push({ from: w.actor, to: w.waitingOn!, at: at(w.start), kind: 'ask' });
      if (w.end && w.answered) {
        arcs.push({ from: w.waitingOn!, to: w.actor, at: at(w.end), kind: 'answer' });
      }
    }
  }

  // Lanes: everyone with something drawn, agents first, then people, then system actors; within
  // a kind, in the timeline's lane order.
  const actors = new Set<string>();
  for (const i of items) actors.add(i.actor);
  for (const a of arcs) actors.add(a.from).add(a.to);
  for (const c of tl.closes) actors.add(c.by);
  const laneOrder = tl.lanes.map((l) => l.agent);
  const rank = (a: string): number => {
    const i = laneOrder.indexOf(a);
    return i < 0 ? laneOrder.length : i;
  };
  const sorted = [...actors].sort(
    (a, b) =>
      ORDER[laneKind(tl, a)] - ORDER[laneKind(tl, b)] || rank(a) - rank(b) || a.localeCompare(b),
  );
  // Too many lanes: keep the busiest by drawn time, the rest share "others". People always keep
  // their lane, since their waits are the point.
  const limit = laneLimits(stage);
  let kept = sorted;
  if (sorted.length > limit.lanes) {
    const busy = new Map<string, number>();
    for (const i of items) busy.set(i.actor, (busy.get(i.actor) ?? 0) + (i.end - i.start));
    const people = sorted.filter((a) => laneKind(tl, a) === 'human').slice(0, limit.lanes - 1);
    const rest = sorted
      .filter((a) => laneKind(tl, a) !== 'human')
      .sort((a, b) => (busy.get(b) ?? 0) - (busy.get(a) ?? 0) || rank(a) - rank(b))
      .slice(0, limit.lanes - 1 - people.length);
    const keep = new Set([...people, ...rest]);
    kept = sorted.filter((a) => keep.has(a));
  }
  const labels = kept.length < sorted.length ? [...kept, OTHERS] : kept;
  const index = new Map(labels.map((l, i) => [l, i]));
  const laneOf = (actor: string): number => index.get(actor) ?? index.get(OTHERS)!;

  // Stack overlapping bars of a lane into tracks, first fit by start time.
  const ordered = items
    .map((i) => ({ ...i, lane: laneOf(i.actor) }))
    .sort((a, b) => a.lane - b.lane || a.start - b.start || a.task.localeCompare(b.task));
  const trackEnds = labels.map(() => [] as number[]);
  const gap = duration / 400;
  const bars: Bar[] = ordered.map((i) => {
    const ends = trackEnds[i.lane]!;
    let track = ends.findIndex((e) => e <= i.start);
    if (track < 0 && ends.length < limit.tracks) track = ends.length;
    if (track < 0) track = ends.indexOf(Math.min(...ends));
    ends[track] = Math.max(ends[track] ?? 0, i.end + gap);
    return {
      lane: i.lane,
      track,
      task: i.task,
      start: i.start,
      end: Math.max(i.start, i.end),
      state: i.state,
      closes: i.closes,
      glow: i.glow,
      next: Infinity,
    };
  });
  // Bars are in start order per lane, so the previous bar on a track ends its room here.
  const lastOnTrack = new Map<string, Bar>();
  for (const b of bars) {
    const key = `${b.lane}:${b.track}`;
    const prev = lastOnTrack.get(key);
    if (prev) prev.next = b.start;
    lastOnTrack.set(key, b);
  }

  const layout = swimlanesLayout(stage, labels.length);
  // Lane height grows with its track count, so a busy lane gets the room it needs.
  const tracks = trackEnds.map((e) => Math.max(1, e.length));
  const weight = (n: number): number => 1 + 0.8 * (n - 1);
  const total = tracks.reduce((sum, n) => sum + weight(n), 0) || 1;
  const unit = (layout.bottom - layout.top) / total;
  // Tracks are 1.25 track heights apart. One track height for every lane, small enough that the
  // tightest lane's stack fills at most 85% of the band under its label.
  const stackOf = (n: number): number => n + 0.25 * (n - 1);
  const trackHeight = Math.max(
    1,
    Math.min(
      layout.trackHeight,
      ...tracks.map((n) => ((unit * weight(n) - layout.labelBand) * 0.85) / stackOf(n)),
    ),
  );
  let y = layout.top;
  const lanes: Lane[] = labels.map((label, i) => {
    const height = unit * weight(tracks[i]!);
    const band = height - layout.labelBand;
    const stack = stackOf(tracks[i]!) * trackHeight;
    const lane: Lane = {
      label,
      color: label === OTHERS ? '#94a3b8' : identity(label).provider.color,
      kind: label === OTHERS ? 'others' : laneKind(tl, label),
      tracks: tracks[i]!,
      y: y + layout.labelBand + (band - stack) / 2 + trackHeight / 2,
      top: y,
      height,
    };
    y += height;
    return lane;
  });

  const drawn = arcs
    .map((a) => ({ from: laneOf(a.from), to: laneOf(a.to), at: a.at, kind: a.kind }))
    .filter((a) => a.from !== a.to)
    .sort((a, b) => a.at - b.at || a.from - b.from || a.to - b.to);
  return {
    lanes,
    bars,
    arcs: drawn,
    arcFloor: drawn.length <= ARC_TRACE_LIMIT ? 0.4 : 0,
    closes: tl.closes.map((c) => [laneOf(c.by), at(c.at)] as [number, number]),
    duration,
    map: tl.time,
    layout: { ...layout, trackHeight },
    card: loopCard(tl),
  };
}

/** How long an arc takes to draw itself, in playback ms. */
export const ARC_MS = 600;
/** One glow pulse, in playback ms. */
const PULSE_MS = 900;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** The state a bar shows at playback time `t`: a closing work bar turns done once it ends. */
export function barStateAt(bar: Bar, t: number): BarState {
  return bar.closes && t >= bar.end ? 'done' : bar.state;
}

/** Whether a bar glows at `t`: a wait on a person, from the ask until the answer. */
export function glowsAt(bar: Bar, t: number, duration: number): boolean {
  return bar.glow && t >= bar.start && (t < bar.end || (bar.end >= duration && t <= duration));
}

export const swimlanesScene: Scene<SwimlanesData> = {
  id: 'swimlanes',
  label: 'Swimlanes',
  description:
    'One lane per agent: tasks as bars by state, review rounds as arcs, waits on a person glowing until answered, then a stat card',
  // The card's agent hours and tasks closed come from the report of the same window.
  query: 'wrapped=1',
  outroMs: CARD_MS,
  prepare: prepareSwimlanes,
  render(d, frame) {
    const lanes = renderLanes(d, frame);
    if (frame.t <= d.duration) return lanes;
    return (
      <g>
        {lanes}
        {renderLoopCard(d.card, frame, frame.t - d.duration)}
      </g>
    );
  },
};

/** The lanes at `frame.t`, held at the last timeline frame during the card. */
function renderLanes(d: SwimlanesData, frame: Frame): ReactElement {
  const L = d.layout;
  const s = L.s;
  const t = Math.min(Math.max(0, frame.t), d.duration);
  const x = (ms: number): number =>
    d.duration > 0 ? L.x0 + (ms / d.duration) * (L.x1 - L.x0) : L.x0;
  const yOf = (lane: number, track = 0): number => {
    const l = d.lanes[lane];
    return l ? l.y + track * L.trackHeight * 1.25 : 0;
  };
  const th = L.trackHeight;
  const pulse = 0.55 + 0.45 * Math.sin((t / PULSE_MS) * 2 * Math.PI);
  const font = "'IBM Plex Sans', 'Segoe UI', sans-serif";
  const labelSize = L.wide
    ? Math.min(28 * s, d.lanes[0] ? d.lanes[0].height * 0.4 : 28 * s)
    : 26 * s;
  const glowing = d.bars.filter((b) => glowsAt(b, t, d.duration));

  const arcPath = (a: Arc): string => {
    const ax = x(a.at);
    const y1 = yOf(a.from);
    const y2 = yOf(a.to);
    const bulge = Math.min(90 * s, 30 * s + Math.abs(y2 - y1) * 0.25);
    return `M ${ax} ${y1} C ${ax + bulge} ${y1}, ${ax + bulge} ${y2}, ${ax} ${y2}`;
  };

  return (
    <g fontFamily={font}>
      <defs>
        <filter id="swim-glow" x="-50%" y="-200%" width="200%" height="500%">
          <feGaussianBlur stdDeviation={10 * s} />
        </filter>
      </defs>
      <text x={70 * s} y={L.headerY} fill="#e6edf3" fontSize={48 * s} fontWeight={600}>
        Swimlanes
      </text>
      <text
        x={L.stampEnd ? frame.width - 70 * s : 70 * s}
        y={L.stampY}
        fill="#8b98a5"
        fontSize={30 * s}
        textAnchor={L.stampEnd ? 'end' : 'start'}
      >
        {utcStamp(realAt(d.map, t))}
      </text>
      {L.legendRows.map((row, r) =>
        row.map((c) => (
          <g key={c.state}>
            <rect
              x={c.x}
              y={L.legendY + r * 44 * s - 11 * s}
              width={24 * s}
              height={22 * s}
              rx={5 * s}
              fill={STATE_COLORS[c.state]}
            />
            <text
              x={c.x + 34 * s}
              y={L.legendY + r * 44 * s}
              fill="#c3ccd5"
              fontSize={24 * s}
              dominantBaseline="middle"
            >
              {c.label}
            </text>
          </g>
        )),
      )}
      {d.lanes.map((lane, i) => (
        <g key={lane.label} data-lane={lane.label}>
          {i % 2 === 1 && (
            <rect
              x={40 * s}
              y={lane.top}
              width={frame.width - 80 * s}
              height={lane.height}
              rx={10 * s}
              fill="#ffffff"
              fillOpacity={0.025}
            />
          )}
          {Array.from({ length: lane.tracks }, (_, k) => (
            <line
              key={k}
              x1={L.x0}
              x2={L.x1}
              y1={yOf(i, k)}
              y2={yOf(i, k)}
              stroke="#ffffff"
              strokeOpacity={0.07}
              strokeWidth={2 * s}
            />
          ))}
          <text
            x={L.wide ? L.x0 - 30 * s : L.x0}
            // Wide: centered left of the tracks. Otherwise just above the first track, so the
            // label and its bars read as one block in a tall lane.
            y={L.wide ? yOf(i, (lane.tracks - 1) / 2) : lane.y - th / 2 - L.labelBand * 0.45}
            fill={lane.color}
            fontSize={labelSize}
            fontWeight={500}
            textAnchor={L.wide ? 'end' : 'start'}
            dominantBaseline="middle"
          >
            {lane.label}
          </text>
        </g>
      ))}
      {glowing.map((b, i) => (
        <rect
          key={`glow-${i}`}
          data-glow={b.task}
          x={x(b.start) - 6 * s}
          y={yOf(b.lane, b.track) - th / 2 - 6 * s}
          width={Math.max(0, x(Math.min(t, b.end)) - x(b.start)) + 12 * s}
          height={th + 12 * s}
          rx={th / 2}
          fill={STATE_COLORS.waiting}
          fillOpacity={0.35 + 0.45 * pulse}
          filter="url(#swim-glow)"
        />
      ))}
      {d.bars.map((b, i) => {
        if (t < b.start) return null;
        const state = barStateAt(b, t);
        const x1 = x(b.start);
        const w = Math.max(3 * s, x(Math.min(t, b.end)) - x1);
        const y = yOf(b.lane, b.track);
        // A task id only where it reads: 18 px or more, in a bar wide enough to hold it before
        // the next bar on its track covers it.
        const room = x(Math.min(t, b.end, b.next)) - x1;
        const label = room >= 110 * s && th * 0.7 >= 18 * s;
        return (
          <g key={i} data-bar={b.task} data-state={state}>
            <rect
              x={x1}
              y={y - th / 2}
              width={w}
              height={th}
              rx={Math.min(8 * s, th / 3)}
              fill={STATE_COLORS[state]}
              fillOpacity={state === 'blocked' ? 0.7 : 0.88}
            />
            {label && (
              <text
                x={x1 + 10 * s}
                y={y}
                fill="#0b0f14"
                fontSize={Math.min(20 * s, th * 0.7)}
                fontWeight={600}
                dominantBaseline="middle"
              >
                {b.task}
              </text>
            )}
          </g>
        );
      })}
      {d.closes.map(([lane, at], i) => {
        if (t < at) return null;
        const cx = x(at);
        const cy = yOf(lane);
        const r = Math.min(11 * s, th * 0.4);
        return (
          <path
            key={`close-${i}`}
            data-close
            d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`}
            fill={STATE_COLORS.done}
            stroke={'#0b0f14'}
            strokeWidth={2 * s}
          />
        );
      })}
      {d.arcs.map((a, i) => {
        const k = clamp01((t - a.at) / ARC_MS);
        // A fresh arc draws itself and stays bright, then fades to the floor: a trace of the
        // review history when arcs are few, nothing when they are many.
        const fade = 1 - (1 - d.arcFloor) * clamp01((t - a.at - ARC_MS) / (ARC_MS * 4));
        if (t < a.at || fade <= 0) return null;
        // An ask is dashed and fades in; the others draw themselves from their start lane.
        const ask = a.kind === 'ask';
        return (
          <path
            key={`arc-${i}`}
            data-arc={a.kind}
            d={arcPath(a)}
            fill="none"
            stroke={ARC_COLORS[a.kind]}
            strokeWidth={(k < 1 ? 4 : 3) * s}
            strokeOpacity={0.95 * fade * (ask ? k : 1)}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={ask ? '0.025 0.025' : `${k} 1`}
          />
        );
      })}
      <line
        x1={x(t)}
        x2={x(t)}
        y1={L.top - 16 * s}
        y2={L.bottom + 16 * s}
        stroke="#5ce1e6"
        strokeWidth={3 * s}
      />
    </g>
  );
}
