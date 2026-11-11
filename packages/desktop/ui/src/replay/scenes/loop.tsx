// Human loop (AO-0083): hours of agent work against minutes of human input. Agents fill the lower
// band with how many of them work at once; each human action is a tick on the upper band. Every ask
// to a person and every review a person does is a beam up from the agent band, and the answer or
// verdict is a beam back down; while it waits, the wait glows between the bands. Two counters run
// in the header, and the clip ends on the stat card (`loop-card.tsx`).
//
// The counters end on the card's figures: each grows with the share of its total reached so far
// (run time for agents, human session time for people), so the pace is real and the last frame
// agrees with the card.
import { playbackAt, playbackOf, realAt, utcStamp } from '../../lib/replay';
import type { TimeMap, Timeline } from '../../types';
import type { Scene, Stage } from '../scene';
import type { LoopCard } from './loop-card';
import { CARD_MS, countUp, loopCard, renderLoopCard } from './loop-card';

export type BeamKind = 'ask' | 'answer' | 'review' | 'approve' | 'changes';

export const BEAM_COLORS: Record<BeamKind, string> = {
  ask: '#ffc857',
  answer: '#ffe08a',
  review: '#b18cff',
  approve: '#3ddc97',
  changes: '#ff9f43',
};

const LEGEND: Array<[BeamKind, string]> = [
  ['ask', 'Ask'],
  ['answer', 'Answer'],
  ['review', 'Review by a person'],
  ['approve', 'Verdict'],
];

const AGENT_COLOR = '#5aa9ff';
const HUMAN_COLOR = '#ffc857';

/** A beam at playback time `at`: up from the agents to a person, or down from a person. */
export interface Beam {
  at: number;
  kind: BeamKind;
  up: boolean;
  task: string;
}

/** A wait on a person, from the up beam to the down beam (the clip end while open). */
export interface LoopWait {
  start: number;
  end: number;
  open: boolean;
  kind: 'ask' | 'review';
  task: string;
  track: number;
}

/** A real-time interval in ms since the epoch, clipped to the window. */
type Interval = [number, number];

export interface LoopLayout {
  s: number;
  wide: boolean;
  x0: number;
  x1: number;
  headerY: number;
  stampY: number;
  stampEnd: boolean;
  counterY: number;
  counterX: [number, number];
  legendRows: Array<Array<{ kind: BeamKind; label: string; x: number }>>;
  legendY: number;
  human: { top: number; bottom: number };
  agents: { top: number; bottom: number };
  waitY: number;
  waitTrack: number;
}

export interface LoopData {
  /** The timeline's playback length; the card follows it. */
  duration: number;
  map: TimeMap;
  /** How many agents work at once, as steps `[playback ms, count]` from 0. */
  steps: Array<[number, number]>;
  peak: number;
  /** Playback times of human actions, ascending. */
  human: number[];
  beams: Beam[];
  waits: LoopWait[];
  /** Real-time agent work and human session intervals, for the running counters. */
  agentWork: Interval[];
  humanWork: Interval[];
  card: LoopCard;
  layout: LoopLayout;
}

/** A beam travels from band to band in this many playback ms. */
export const BEAM_MS = 700;
/** Up to this many beams keep a trace once landed; past it they fade out. */
export const BEAM_TRACE_LIMIT = 60;
/** Waits on a person stack into at most this many tracks between the bands. */
export const WAIT_TRACKS = 3;
/** A human tick flashes for this many playback ms. */
const FLASH_MS = 500;
const PULSE_MS = 900;
// The same session rule as the timeline's `humanMinutes` (packages/core/src/timeline.ts).
const HUMAN_GAP_MS = 10 * 60_000;
const HUMAN_EVENT_MS = 2 * 60_000;

const isHuman = (actor: string | null | undefined): boolean => !!actor?.startsWith('human:');
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Sizes and positions for a stage; every length scales with its short side. */
export function loopLayout(stage: Stage): LoopLayout {
  const s = Math.min(stage.width, stage.height) / 1080;
  const wide = stage.width / stage.height >= 1.3;
  const margin = 70 * s;
  const x0 = wide ? 300 * s : margin;
  const x1 = stage.width - margin;
  const headerY = 95 * s;
  const stampEnd = stage.width >= stage.height;
  const stampY = stampEnd ? headerY : headerY + 56 * s;
  const counterY = stampY + 85 * s;
  const counterX: [number, number] = [margin, margin + (wide ? 560 : 490) * s];
  const legendRows: LoopLayout['legendRows'] = [[]];
  const chip = (label: string): number => (34 + label.length * 12 + 36) * s;
  let x = margin;
  for (const [kind, label] of LEGEND) {
    if (x + chip(label) > x1 && legendRows[legendRows.length - 1]!.length > 0) {
      legendRows.push([]);
      x = margin;
    }
    legendRows[legendRows.length - 1]!.push({ kind, label, x });
    x += chip(label);
  }
  const legendY = counterY + 60 * s;
  // Labels sit above the bands unless the stage is wide.
  const labelBand = wide ? 0 : 40 * s;
  const top = legendY + (legendRows.length - 1) * 44 * s + 50 * s;
  const bottom = stage.height - 70 * s;
  const plot = bottom - top;
  const human = { top: top + labelBand, bottom: top + plot * 0.2 };
  const agents = { top: bottom - plot * 0.38 + labelBand, bottom };
  const gapTop = human.bottom + 20 * s;
  const gapBottom = agents.top - labelBand - 20 * s;
  return {
    s,
    wide,
    x0,
    x1,
    headerY,
    stampY,
    stampEnd,
    counterY,
    counterX,
    legendRows,
    legendY,
    human,
    agents,
    waitY: (gapTop + gapBottom) / 2,
    waitTrack: Math.min(28 * s, (gapBottom - gapTop) / (WAIT_TRACKS * 1.6)),
  };
}

/** Human session intervals of `times` (ms since the epoch), as the timeline counts them. */
export function humanSessions(times: number[]): Interval[] {
  const sorted = [...times].sort((a, b) => a - b);
  const out: Interval[] = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && t - (last[1] - HUMAN_EVENT_MS) <= HUMAN_GAP_MS) last[1] = t + HUMAN_EVENT_MS;
    else out.push([t, t + HUMAN_EVENT_MS]);
  }
  return out;
}

/** The share (0 to 1) of the total length of `intervals` that lies before real time `ms`. */
export function shareBefore(intervals: Interval[], ms: number): number {
  let total = 0;
  let done = 0;
  for (const [a, b] of intervals) {
    total += b - a;
    done += Math.max(0, Math.min(b, ms) - a);
  }
  return total > 0 ? done / total : 0;
}

export function prepareLoop(tl: Timeline, stage: Stage): LoopData {
  const at = (iso: string): number => playbackOf(tl.time, iso);
  const duration = tl.time.playbackMs;
  const fromMs = tl.from ? Date.parse(tl.from) : -Infinity;
  const toMs = Date.parse(tl.to);
  const kinds = new Map(tl.lanes.map((l) => [l.agent, l.kind]));
  const isAgent = (a: string): boolean =>
    (kinds.get(a) ?? (isHuman(a) ? 'human' : a.startsWith('opsd:') ? 'system' : 'agent')) ===
    'agent';

  // Agent work: supervised runs when there are any, else the time agents held tasks.
  const work = (tl.runs.length > 0 ? tl.runs : tl.spans).filter((w) => isAgent(w.agent));
  const agentWork: Interval[] = [];
  const delta: Array<[number, number]> = [];
  for (const w of work) {
    const a = Math.max(Date.parse(w.start), fromMs);
    const b = Math.min(w.end ? Date.parse(w.end) : toMs, toMs);
    if (b <= a) continue;
    agentWork.push([a, b]);
    delta.push([playbackAt(tl.time, a), 1], [playbackAt(tl.time, b), -1]);
  }
  delta.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const steps: Array<[number, number]> = [[0, 0]];
  let n = 0;
  let peak = 0;
  for (const [t, d] of delta) {
    n += d;
    peak = Math.max(peak, n);
    if (steps[steps.length - 1]![0] === t) steps[steps.length - 1]![1] = n;
    else steps.push([t, n]);
  }

  // Human actions: the ones the timeline names (creates, closes, answers, verdicts, decisions),
  // plus every event a person wrote when the timeline carries `graph`.
  const humanTimes = new Set<number>();
  const add = (iso: string | null | undefined, actor: string | null | undefined): void => {
    if (!iso || !isHuman(actor)) return;
    const ms = Date.parse(iso);
    if (ms >= fromMs && ms <= toMs) humanTimes.add(ms);
  };
  for (const e of tl.graph?.touches ?? []) add(e.at, e.actor);
  for (const c of tl.created) add(c.at, c.by);
  for (const c of tl.closes) add(c.at, c.by);
  for (const r of tl.reviews) if (r.end) add(r.end, r.decidedBy);
  for (const w of tl.waits)
    if (w.end && (w.answered || w.endedBy === 'unblock')) add(w.end, w.waitingOn);
  for (const d of tl.decisions) {
    add(d.start, d.proposedBy);
    for (const b of d.ballots) add(b.at, b.actor);
    if (d.end) add(d.end, d.decidedBy);
  }
  const times = [...humanTimes].sort((a, b) => a - b);

  // Beams and waits: asks and blocks on a person, and reviews a person does.
  const beams: Beam[] = [];
  const waits: Array<Omit<LoopWait, 'track'>> = [];
  for (const w of tl.waits) {
    if (!w.human || !w.waitingOn) continue;
    beams.push({ at: at(w.start), kind: 'ask', up: true, task: w.task });
    const answered = w.end !== null && (w.answered || w.endedBy === 'unblock');
    if (answered) beams.push({ at: at(w.end!), kind: 'answer', up: false, task: w.task });
    waits.push({
      start: at(w.start),
      end: w.end ? at(w.end) : duration,
      open: w.end === null,
      kind: 'ask',
      task: w.task,
    });
  }
  for (const r of tl.reviews) {
    // A round with no reviewer named goes to a person, unless an agent decided it.
    const reviewer = r.reviewer ?? r.decidedBy ?? null;
    if (reviewer !== null && !isHuman(reviewer)) continue;
    beams.push({ at: at(r.start), kind: 'review', up: true, task: r.task });
    if (r.end && r.verdict) beams.push({ at: at(r.end), kind: r.verdict, up: false, task: r.task });
    waits.push({
      start: at(r.start),
      end: r.end ? at(r.end) : duration,
      open: r.end === null,
      kind: 'review',
      task: r.task,
    });
  }
  beams.sort((a, b) => a.at - b.at || Number(b.up) - Number(a.up) || a.task.localeCompare(b.task));
  waits.sort((a, b) => a.start - b.start || a.task.localeCompare(b.task));
  const ends: number[] = [];
  const gap = duration / 400;
  const placed: LoopWait[] = waits.map((w) => {
    let track = ends.findIndex((e) => e <= w.start);
    if (track < 0 && ends.length < WAIT_TRACKS) track = ends.length;
    if (track < 0) track = ends.indexOf(Math.min(...ends));
    ends[track] = Math.max(ends[track] ?? 0, w.end + gap);
    return { ...w, track };
  });

  return {
    duration,
    map: tl.time,
    steps,
    peak,
    human: times.map((t) => playbackAt(tl.time, t)),
    beams,
    waits: placed,
    agentWork,
    humanWork: humanSessions(times),
    card: loopCard(tl),
    layout: loopLayout(stage),
  };
}

/** The running counters at playback time `t`: they reach the card's figures at the end. */
export function countersAt(d: LoopData, t: number): { agentHours: number; humanMinutes: number } {
  if (t >= d.duration) return { agentHours: d.card.agentHours, humanMinutes: d.card.humanMinutes };
  const real = realAt(d.map, t);
  return {
    agentHours: d.card.agentHours * shareBefore(d.agentWork, real),
    humanMinutes: d.card.humanMinutes * shareBefore(d.humanWork, real),
  };
}

/** Where a beam's head is at `t`, 0 at its start band to 1 at the other; null before it fires. */
export function beamProgress(b: Beam, t: number): number | null {
  return t < b.at ? null : clamp01((t - b.at) / BEAM_MS);
}

/** How many agents work at playback time `t`. */
export function agentsAt(d: LoopData, t: number): number {
  let n = 0;
  for (const [at, c] of d.steps) {
    if (at > t) break;
    n = c;
  }
  return n;
}

export const loopScene: Scene<LoopData> = {
  id: 'loop',
  label: 'Human loop',
  description:
    'Hours of agent work against minutes of human input: asks and answers as beams, then a stat card',
  // The same query as Swimlanes: one timeline and one time map, so a beam lands where the
  // Swimlanes arc did, and switching between the two keeps the playhead.
  query: 'wrapped=1',
  outroMs: CARD_MS,
  prepare: prepareLoop,
  render(d, frame) {
    const L = d.layout;
    const s = L.s;
    const t = Math.min(Math.max(0, frame.t), d.duration);
    const x = (ms: number): number =>
      d.duration > 0 ? L.x0 + (ms / d.duration) * (L.x1 - L.x0) : L.x0;
    const font = "'IBM Plex Sans', 'Segoe UI', sans-serif";
    const pulse = 0.55 + 0.45 * Math.sin((t / PULSE_MS) * 2 * Math.PI);
    const counters = countersAt(d, t);
    const traceFloor = d.beams.length <= BEAM_TRACE_LIMIT ? 0.25 : 0;
    const humanMid = (L.human.top + L.human.bottom) / 2;
    const tick = (L.human.bottom - L.human.top) * 0.55;
    const agentH = L.agents.bottom - L.agents.top;
    const peak = Math.max(1, d.peak);
    const yAgents = (n: number): number => L.agents.bottom - (n / peak) * agentH * 0.92;

    // The agent area up to the playhead, as one step path.
    let area = `M ${x(0)} ${L.agents.bottom}`;
    let prev = 0;
    for (const [at, c] of d.steps) {
      if (at > t) break;
      area += ` L ${x(at)} ${yAgents(prev)} L ${x(at)} ${yAgents(c)}`;
      prev = c;
    }
    area += ` L ${x(t)} ${yAgents(prev)} L ${x(t)} ${L.agents.bottom} Z`;

    const yWait = (track: number): number =>
      L.waitY + (track - (WAIT_TRACKS - 1) / 2) * L.waitTrack * 1.6;
    const label = (text: string, band: { top: number; bottom: number }, color: string) => (
      <text
        x={L.wide ? L.x0 - 30 * s : L.x0}
        y={L.wide ? (band.top + band.bottom) / 2 : band.top - 16 * s}
        fill={color}
        fontSize={30 * s}
        fontWeight={600}
        textAnchor={L.wide ? 'end' : 'start'}
        dominantBaseline={L.wide ? 'middle' : 'auto'}
      >
        {text}
      </text>
    );

    const scene = (
      <g fontFamily={font}>
        <defs>
          <filter id="loop-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={8 * s} />
          </filter>
        </defs>
        <text x={70 * s} y={L.headerY} fill="#e6edf3" fontSize={48 * s} fontWeight={600}>
          Human in the loop
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
        {(
          [
            ['agent', countUp(counters.agentHours, 1, 1), 'agent hours', AGENT_COLOR],
            ['human', countUp(counters.humanMinutes, 1, 0), 'human minutes', HUMAN_COLOR],
          ] as const
        ).map(([id, value, unit, color], i) => (
          <text key={id} data-counter={id} x={L.counterX[i]} y={L.counterY}>
            <tspan fill={color} fontSize={60 * s} fontWeight={700}>
              {value}
            </tspan>
            <tspan fill="#c3ccd5" fontSize={30 * s} dx={14 * s}>
              {unit}
            </tspan>
          </text>
        ))}
        {L.legendRows.map((row, r) =>
          row.map((c) => (
            <g key={c.kind}>
              <rect
                x={c.x}
                y={L.legendY + r * 44 * s - 4 * s}
                width={24 * s}
                height={8 * s}
                rx={4 * s}
                fill={BEAM_COLORS[c.kind]}
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
        {/* Bands. */}
        <rect
          x={L.x0 - 10 * s}
          y={L.human.top}
          width={L.x1 - L.x0 + 20 * s}
          height={L.human.bottom - L.human.top}
          rx={10 * s}
          fill={HUMAN_COLOR}
          fillOpacity={0.04}
        />
        <rect
          x={L.x0 - 10 * s}
          y={L.agents.top}
          width={L.x1 - L.x0 + 20 * s}
          height={agentH}
          rx={10 * s}
          fill={AGENT_COLOR}
          fillOpacity={0.04}
        />
        {label('People', L.human, HUMAN_COLOR)}
        {label('Agents', L.agents, AGENT_COLOR)}
        <line
          x1={L.x0}
          x2={L.x1}
          y1={humanMid}
          y2={humanMid}
          stroke="#ffffff"
          strokeOpacity={0.07}
          strokeWidth={2 * s}
        />
        <path
          data-agents={agentsAt(d, t)}
          d={area}
          fill={AGENT_COLOR}
          fillOpacity={0.35}
          stroke={AGENT_COLOR}
          strokeOpacity={0.9}
          strokeWidth={2 * s}
          strokeLinejoin="round"
        />
        {d.waits.map((w, i) => {
          if (t < w.start) return null;
          const end = Math.min(t, w.end);
          const live = t < w.end || (w.open && t <= d.duration);
          const color = w.kind === 'ask' ? BEAM_COLORS.ask : BEAM_COLORS.review;
          const y = yWait(w.track);
          const h = L.waitTrack;
          return (
            <g key={`wait-${i}`} data-wait={w.task} data-live={live ? '1' : '0'}>
              {live && (
                <rect
                  x={x(w.start) - 4 * s}
                  y={y - h / 2 - 4 * s}
                  width={Math.max(0, x(end) - x(w.start)) + 8 * s}
                  height={h + 8 * s}
                  rx={h / 2}
                  fill={color}
                  fillOpacity={0.25 + 0.4 * pulse}
                  filter="url(#loop-glow)"
                />
              )}
              <rect
                x={x(w.start)}
                y={y - h / 2}
                width={Math.max(3 * s, x(end) - x(w.start))}
                height={h}
                rx={h / 2}
                fill={color}
                fillOpacity={live ? 0.85 : 0.35}
              />
            </g>
          );
        })}
        {d.human.map((ht, i) => {
          if (t < ht) return null;
          const flash = 1 - clamp01((t - ht) / FLASH_MS);
          return (
            <g key={`human-${i}`} data-human>
              {flash > 0 && (
                <circle
                  cx={x(ht)}
                  cy={humanMid}
                  r={(10 + 18 * (1 - flash)) * s}
                  fill={HUMAN_COLOR}
                  fillOpacity={0.6 * flash}
                  filter="url(#loop-glow)"
                />
              )}
              <rect
                x={x(ht) - 2 * s}
                y={humanMid - tick / 2}
                width={4 * s}
                height={tick}
                rx={2 * s}
                fill={HUMAN_COLOR}
              />
            </g>
          );
        })}
        {d.beams.map((b, i) => {
          const k = beamProgress(b, t);
          if (k === null) return null;
          const fade = 1 - (1 - traceFloor) * clamp01((t - b.at - BEAM_MS) / (BEAM_MS * 3));
          if (fade <= 0) return null;
          const yA = L.agents.top + 6 * s;
          const yH = L.human.bottom - 6 * s;
          const from = b.up ? yA : yH;
          const to = b.up ? yH : yA;
          const head = from + (to - from) * k;
          const bx = x(b.at);
          const color = BEAM_COLORS[b.kind];
          return (
            <g key={`beam-${i}`} data-beam={b.kind} opacity={fade}>
              <line
                x1={bx}
                x2={bx}
                y1={from}
                y2={head}
                stroke={color}
                strokeWidth={(k < 1 ? 10 : 6) * s}
                strokeOpacity={0.5}
                filter="url(#loop-glow)"
              />
              <line
                x1={bx}
                x2={bx}
                y1={from}
                y2={head}
                stroke={color}
                strokeWidth={3 * s}
                strokeLinecap="round"
              />
              {k < 1 && <circle cx={bx} cy={head} r={7 * s} fill="#ffffff" />}
              {k >= 1 && t - b.at - BEAM_MS < FLASH_MS && (
                <circle
                  cx={bx}
                  cy={to}
                  r={(8 + 26 * clamp01((t - b.at - BEAM_MS) / FLASH_MS)) * s}
                  fill="none"
                  stroke={color}
                  strokeWidth={3 * s}
                  strokeOpacity={1 - clamp01((t - b.at - BEAM_MS) / FLASH_MS)}
                />
              )}
            </g>
          );
        })}
        <line
          x1={x(t)}
          x2={x(t)}
          y1={L.human.top - 12 * s}
          y2={L.agents.bottom + 12 * s}
          stroke="#5ce1e6"
          strokeWidth={3 * s}
        />
      </g>
    );
    if (frame.t <= d.duration) return scene;
    return (
      <g>
        {scene}
        {renderLoopCard(d.card, frame, frame.t - d.duration)}
      </g>
    );
  },
};
