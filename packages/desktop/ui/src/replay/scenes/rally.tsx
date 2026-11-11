// Review rally (AO-0082): one task's review rounds as a short rally between author and reviewer.
// Each round is two shots: the author serves the work, the reviewer returns the verdict. Every
// return is labeled with its verdict and leaves a chip on the scoreboard, and the clip ends on the
// last verdict, "approved" for a task that passed. The rally keeps its own pace (`RALLY_MS`), not
// the timeline's time axis: the rounds share the clip equally, whatever their real length.
import { minutes as minutesText } from '../../lib/format';
import { identity } from '../../lib/identity';
import { utcStamp } from '../../lib/replay';
import type { ReviewRound, Timeline } from '../../types';
import type { Choice, Scene, Stage } from '../scene';
import { cut } from './wrapped';

/** The rally's clip length: short enough for a post, long enough to read each verdict. */
export const RALLY_MS = 10_000;

export interface RallyRound {
  /** The round number from the task's history. */
  round: number;
  author: string;
  reviewer: string;
  verdict: string;
  color: string;
  /** False while the round waits for its verdict: the ball stays with the reviewer. */
  returned: boolean;
  /** When the review was requested, as UTC text. */
  asked: string;
}

export interface RallyData {
  /** The data root the task lives in: task ids are unique only within a root. */
  root: string;
  task: string;
  title: string;
  rounds: RallyRound[];
  /** Real time from the first review request to the last verdict, such as `2h14m`. */
  span: string;
}

export interface Verdict {
  text: string;
  color: string;
}

const VERDICTS: Record<'approve' | 'changes', Verdict> = {
  approve: { text: 'approved', color: '#3ddc97' },
  changes: { text: 'changes asked', color: '#ff9f43' },
};

const ENDED: Record<string, string> = {
  release: 'released',
  handoff: 'handed off',
  expired: 'lease expired',
  done: 'closed',
};

const PURPLE = '#b18cff';
const GREY = '#94a3b8';

/** The label a round's return carries: its verdict, or how the round ended without one. */
export function verdictOf(r: ReviewRound): Verdict {
  if (r.verdict) return VERDICTS[r.verdict];
  if (r.end === null) return { text: 'in review', color: PURPLE };
  return { text: ENDED[r.endedBy] ?? r.endedBy, color: GREY };
}

/** A task's key across roots, such as `swarmup/AO-0082`: the id of its choice. */
export const rallyKey = (r: Pick<ReviewRound, 'root' | 'task'>): string => `${r.root}/${r.task}`;

/** The window's review rounds per task, keyed by `rallyKey`, oldest first. */
function roundsByTask(tl: Timeline): Map<string, ReviewRound[]> {
  const out = new Map<string, ReviewRound[]>();
  for (const r of tl.reviews) {
    const key = rallyKey(r);
    const list = out.get(key) ?? [];
    list.push(r);
    out.set(key, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start) || a.round - b.round);
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Tasks with review rounds in the window: most rounds first, then approved ones, then by key.
 * A label names the root only when more than one root has a task with that id.
 */
export function rallyChoices(tl: Timeline): Choice[] {
  const approved = (rs: ReviewRound[]): number => (rs.at(-1)?.verdict === 'approve' ? 1 : 0);
  const tasks = [...roundsByTask(tl)];
  const roots = new Map<string, number>();
  for (const [, rs] of tasks) roots.set(rs[0]!.task, (roots.get(rs[0]!.task) ?? 0) + 1);
  return tasks
    .sort(
      ([a, ra], [b, rb]) =>
        rb.length - ra.length || approved(rb) - approved(ra) || a.localeCompare(b),
    )
    .map(([key, rs]) => {
      const task = rs[0]!.task;
      const name = (roots.get(task) ?? 0) > 1 ? key : task;
      return {
        id: key,
        label: `${name} · ${plural(rs.length, 'round', 'rounds')} · ${cut(rs[0]!.title, 40)}`,
      };
    });
}

/**
 * The rally of the task keyed `choice` (`root/id`, see `rallyKey`), or of the first choice when
 * `choice` is missing or unknown.
 */
export function prepareRally(tl: Timeline, choice?: string): RallyData {
  const tasks = roundsByTask(tl);
  const id = choice !== undefined && tasks.has(choice) ? choice : rallyChoices(tl)[0]?.id;
  const list = id === undefined ? [] : (tasks.get(id) ?? []);
  if (list.length === 0) return { root: '', task: '', title: '', rounds: [], span: '' };
  const rounds = list.map((r) => {
    const v = verdictOf(r);
    return {
      round: r.round,
      author: r.author,
      reviewer: r.decidedBy ?? r.reviewer ?? 'human',
      verdict: v.text,
      color: v.color,
      returned: r.end !== null,
      asked: utcStamp(Date.parse(r.start)),
    };
  });
  const last = list.at(-1)!;
  const ms = Date.parse(last.end ?? last.start) - Date.parse(list[0]!.start);
  return {
    root: list[0]!.root,
    task: list[0]!.task,
    title: list[0]!.title,
    rounds,
    span: minutesText(Math.max(0, Math.round(ms / 60_000))),
  };
}

/** The share of the clip for the title before the first serve, and where the end card starts. */
const INTRO = 0.12;
const OUTRO = 0.8;

export interface RallyMoment {
  phase: 'intro' | 'rally' | 'end';
  /** The round in play; the last one at the end. */
  index: number;
  shot: 'serve' | 'return';
  /** How far the ball is from the hitter to the other side, 0 to 1. */
  u: number;
}

/** Where a rally of `n` rounds is at clip fraction `k` (0 to 1). */
export function rallyAt(n: number, k: number): RallyMoment {
  if (n === 0 || k >= OUTRO)
    return { phase: 'end', index: Math.max(0, n - 1), shot: 'return', u: 1 };
  if (k < INTRO) return { phase: 'intro', index: 0, shot: 'serve', u: 0 };
  const x = ((k - INTRO) / (OUTRO - INTRO)) * n;
  const index = Math.min(n - 1, Math.floor(x));
  const f = x - index;
  return f < 0.5
    ? { phase: 'rally', index, shot: 'serve', u: f * 2 }
    : { phase: 'rally', index, shot: 'return', u: (f - 0.5) * 2 };
}

/** The clip fraction at which round `i` of `n` gets its chip: when the verdict lands. */
export function chipAt(i: number, n: number, returned = true): number {
  return INTRO + ((OUTRO - INTRO) / n) * (i + (returned ? 1 : 0.5));
}

interface Point {
  x: number;
  y: number;
}

interface Court {
  s: number;
  wide: boolean;
  /** Where the author and the reviewer hit the ball. */
  a: Point;
  b: Point;
  /** The side the ball arcs to, as a unit vector, and how far. */
  n: Point;
  arc: number;
  /** Where the label of the shot in flight goes. */
  label: Point;
  /** The center of the end card. */
  center: Point;
}

/** Landscape and square stages play left to right; portrait plays bottom to top. */
function court(st: Stage): Court {
  const { width: w, height: h } = st;
  const s = Math.min(w, h) / 1080;
  if (w >= h) {
    const y = 0.56 * h;
    return {
      s,
      wide: true,
      a: { x: 0.17 * w, y },
      b: { x: 0.83 * w, y },
      n: { x: 0, y: -1 },
      arc: 0.2 * h,
      label: { x: 0.5 * w, y: y - 0.2 * h - 60 * s },
      center: { x: 0.5 * w, y: 0.5 * h },
    };
  }
  return {
    s,
    wide: false,
    a: { x: 0.5 * w, y: 0.74 * h },
    b: { x: 0.5 * w, y: 0.32 * h },
    n: { x: 1, y: 0 },
    arc: 0.26 * w,
    // Opposite the arc, clear of the court line.
    label: { x: 0.28 * w, y: 0.53 * h },
    center: { x: 0.5 * w, y: 0.53 * h },
  };
}

/** The ball `u` of the way from `p` to `q`, on an arc to the court's side. */
function ballAt(c: Court, p: Point, q: Point, u: number): Point {
  const lift = c.arc * Math.sin(Math.PI * u);
  return { x: p.x + (q.x - p.x) * u + c.n.x * lift, y: p.y + (q.y - p.y) * u + c.n.y * lift };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const easeOut = (x: number): number => 1 - (1 - x) ** 3;
const easeOutBack = (x: number): number => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const color = (agent: string): string => identity(agent).provider.color;

/** How long a paddle glows after it hits, in clip ms. */
const GLOW_MS = 300;

function Player(props: {
  c: Court;
  at: Point;
  side: 'author' | 'reviewer';
  agent: string;
  glow: number;
}) {
  const { c, at, side, agent, glow } = props;
  const { s } = c;
  const out = side === 'author' ? -1 : 1;
  // The paddle sits just behind where the ball is hit, across the line of play.
  const px = c.wide ? at.x + out * 34 * s : at.x;
  const py = c.wide ? at.y : at.y - out * 34 * s;
  const [pw, ph] = c.wide ? [22 * s, 160 * s] : [160 * s, 22 * s];
  const nameY = c.wide ? at.y + 140 * s : side === 'author' ? at.y + 110 * s : at.y - 120 * s;
  const fill = color(agent);
  return (
    <g data-player={side}>
      {glow > 0 && (
        <circle
          cx={px}
          cy={py}
          r={(40 + 70 * (1 - glow)) * s}
          fill="none"
          stroke={fill}
          strokeWidth={6 * s}
          strokeOpacity={glow}
        />
      )}
      <rect x={px - pw / 2} y={py - ph / 2} width={pw} height={ph} rx={10 * s} fill={fill} />
      <text x={px} y={nameY} fill={fill} fontSize={36 * s} fontWeight={600} textAnchor="middle">
        {agent}
      </text>
      <text x={px} y={nameY + 40 * s} fill="#8b98a5" fontSize={26 * s} textAnchor="middle">
        {side}
      </text>
    </g>
  );
}

function Scoreboard(props: { d: RallyData; k: number; frame: Stage; s: number }) {
  const { d, k, frame, s } = props;
  const n = d.rounds.length;
  const chipW = 230 * s;
  const chipH = 58 * s;
  const gap = 16 * s;
  const perRow = Math.max(1, Math.floor((frame.width - 80 * s + gap) / (chipW + gap)));
  const rows = Math.ceil(n / perRow);
  return (
    <g data-scoreboard="">
      {d.rounds.map((r, i) => {
        const row = Math.floor(i / perRow);
        const inRow = Math.min(perRow, n - row * perRow);
        const x0 = frame.width / 2 - (inRow * (chipW + gap) - gap) / 2;
        const x = x0 + (i % perRow) * (chipW + gap);
        const y = frame.height - 70 * s - (rows - row) * (chipH + gap) + gap;
        const done = k >= chipAt(i, n, r.returned);
        return (
          <g key={i} data-chip={done ? r.verdict : 'pending'}>
            <rect
              x={x}
              y={y}
              width={chipW}
              height={chipH}
              rx={chipH / 2}
              fill={done ? r.color : 'none'}
              fillOpacity={0.16}
              stroke={done ? r.color : '#ffffff'}
              strokeOpacity={done ? 0.9 : 0.15}
              strokeWidth={2 * s}
            />
            <text
              x={x + chipW / 2}
              y={y + chipH / 2}
              fill={done ? r.color : '#8b98a5'}
              fontSize={24 * s}
              fontWeight={600}
              textAnchor="middle"
              dominantBaseline="central"
            >
              {done ? `R${r.round} ${r.verdict}` : `R${r.round}`}
            </text>
          </g>
        );
      })}
    </g>
  );
}

export const rallyScene: Scene<RallyData> = {
  id: 'rally',
  label: 'Review rally',
  description:
    "One task's review rounds as a 10 s rally between author and reviewer, each return labeled with its verdict",
  pick: {
    label: 'Task',
    empty: 'No review rounds in this window',
    choices: rallyChoices,
  },
  clipMs: RALLY_MS,
  prepare: (tl, _stage, choice) => prepareRally(tl, choice),
  render(d, frame) {
    const c = court(frame);
    const { s } = c;
    const font = "'IBM Plex Sans', 'Segoe UI', sans-serif";
    const n = d.rounds.length;
    if (n === 0) {
      return (
        <text
          x={frame.width / 2}
          y={frame.height / 2}
          fill="#8b98a5"
          fontSize={40 * s}
          textAnchor="middle"
          fontFamily={font}
        >
          No review rounds in this window
        </text>
      );
    }
    const k = frame.duration > 0 ? clamp01(frame.t / frame.duration) : 1;
    const m = rallyAt(n, k);
    const r = d.rounds[m.index]!;
    const last = d.rounds[n - 1]!;
    const shotMs = (((OUTRO - INTRO) / n) * frame.duration) / 2;
    const intro = easeOut(clamp01(k / INTRO));
    const end = m.phase === 'end' ? clamp01((k - OUTRO) / 0.06) : 0;

    // The ball: with the author before the first serve, in flight during the rally, gone at the end.
    const serve = m.shot === 'serve';
    const waiting = !serve && !r.returned;
    const [from, to] = serve ? [c.a, c.b] : [c.b, c.a];
    const ball = m.phase === 'intro' ? c.a : waiting ? c.b : ballAt(c, from, to, m.u);
    const ballColor = serve ? PURPLE : r.color;
    const flying = m.phase === 'rally' && !waiting;
    const trail = flying
      ? [1, 2, 3, 4]
          .map((j) => ({ j, u: m.u - j * 0.035 }))
          .filter((x) => x.u > 0)
          .map((x) => ({ j: x.j, p: ballAt(c, from, to, x.u) }))
      : [];
    const hitAge = m.u * shotMs;
    const glow = flying && hitAge < GLOW_MS ? 1 - hitAge / GLOW_MS : 0;

    const label = serve ? `Round ${r.round}` : r.verdict;
    const labelOpacity =
      m.phase === 'rally' ? clamp01(m.u / 0.15) * (serve ? clamp01((1 - m.u) / 0.15) : 1) : 0;

    const endText = last.verdict.toUpperCase();
    const endSize = Math.min(130 * s, (0.75 * frame.width) / (0.66 * endText.length));
    const pop = easeOutBack(end);
    const net = 0.15 * Math.min(frame.width, frame.height);
    const mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };

    return (
      <g fontFamily={font} data-round={m.phase === 'rally' ? r.round : m.phase}>
        <g opacity={intro}>
          <text
            x={frame.width / 2}
            y={90 * s}
            fill={PURPLE}
            fontSize={30 * s}
            fontWeight={600}
            textAnchor="middle"
            letterSpacing={4 * s}
          >
            {`REVIEW RALLY · ${d.task}`}
          </text>
          <text
            x={frame.width / 2}
            y={152 * s}
            fill="#e6edf3"
            fontSize={50 * s}
            fontWeight={700}
            textAnchor="middle"
          >
            {cut(d.title, c.wide && frame.width > frame.height ? 56 : 32)}
          </text>
          <text
            x={frame.width / 2}
            y={204 * s}
            fill="#8b98a5"
            fontSize={28 * s}
            textAnchor="middle"
          >
            {m.phase === 'rally'
              ? `Round ${r.round} · requested ${r.asked}`
              : `${plural(n, 'review round', 'review rounds')} in ${d.span}`}
          </text>
        </g>
        <g opacity={intro * (1 - 0.85 * end)}>
          <line
            x1={c.a.x}
            y1={c.a.y}
            x2={c.b.x}
            y2={c.b.y}
            stroke="#ffffff"
            strokeOpacity={0.08}
            strokeWidth={3 * s}
          />
          <line
            x1={mid.x - c.n.x * net * 0.2}
            y1={mid.y - c.n.y * net * 0.2}
            x2={mid.x + c.n.x * net * 0.6}
            y2={mid.y + c.n.y * net * 0.6}
            stroke="#ffffff"
            strokeOpacity={0.25}
            strokeWidth={4 * s}
            strokeDasharray={`${10 * s} ${10 * s}`}
          />
          <Player c={c} at={c.a} side="author" agent={r.author} glow={serve ? glow : 0} />
          <Player c={c} at={c.b} side="reviewer" agent={r.reviewer} glow={serve ? 0 : glow} />
          {trail.map((x) => (
            <circle
              key={x.j}
              cx={x.p.x}
              cy={x.p.y}
              r={(20 - 3 * x.j) * s}
              fill={ballColor}
              fillOpacity={0.3 * (1 - x.j / 5)}
            />
          ))}
          {m.phase !== 'end' && (
            <circle cx={ball.x} cy={ball.y} r={22 * s} fill={ballColor} data-ball="" />
          )}
          <text
            x={c.label.x}
            y={c.label.y}
            fill={serve ? PURPLE : r.color}
            fontSize={48 * s}
            fontWeight={700}
            textAnchor="middle"
            opacity={labelOpacity}
            data-label=""
          >
            {label}
          </text>
        </g>
        {end > 0 && (
          <g transform={`translate(${c.center.x} ${c.center.y})`} data-ending={last.verdict}>
            <circle
              r={0.3 * Math.min(frame.width, frame.height)}
              fill={last.color}
              fillOpacity={0.07 * end}
            />
            <g transform={`scale(${0.6 + 0.4 * pop})`} opacity={end}>
              <text
                y={0}
                fill={last.color}
                fontSize={endSize}
                fontWeight={800}
                textAnchor="middle"
                letterSpacing={6 * s}
              >
                {endText}
              </text>
              <text
                y={80 * s}
                fill="#e6edf3"
                fontSize={40 * s}
                fontWeight={600}
                textAnchor="middle"
              >
                {`${plural(n, 'round', 'rounds')} · ${d.span}`}
              </text>
              <text y={134 * s} fill="#8b98a5" fontSize={30 * s} textAnchor="middle">
                {`${last.author} ↔ ${last.reviewer}`}
              </text>
            </g>
          </g>
        )}
        <Scoreboard d={d} k={k} frame={frame} s={s} />
      </g>
    );
  },
};
