// The Human loop stat card (AO-0083): agent hours against human minutes, then asks answered, review
// rounds and tasks closed. It closes the Human loop scene and the Swimlanes clip as an outro.
//
// Agent hours and tasks closed are figures `swarmup report` also shows, so with
// `/api/timeline?wrapped=1` they come from the report of the same window (`timeline.wrapped`) and
// match it. The report counts neither human minutes, asks answered nor review rounds; those come
// from the timeline totals. Without `wrapped`, every figure comes from the timeline totals.
import type { ReactElement } from 'react';
import { identity } from '../../lib/identity';
import type { Timeline } from '../../types';
import { BACKDROP } from '../scene';
import type { Frame } from '../scene';

export interface LoopCard {
  agentHours: number;
  humanMinutes: number;
  asksAnswered: number;
  reviewRounds: number;
  tasksClosed: number;
  /** `project · from to to`. */
  footer: string;
  /** Agent hours and tasks closed come from the report of the same window. */
  fromReport: boolean;
}

/** How long the card runs after the timeline ends, in ms. */
export const CARD_MS = 6000;
/** The card fades in over this many ms, then counts its numbers up over `COUNT_MS`. */
export const CARD_FADE_MS = 500;
export const COUNT_MS = 1500;

export const CARD_COLORS = {
  agent: '#5aa9ff',
  human: identity('human:x').provider.color,
  asks: '#ffe08a',
  reviews: '#b18cff',
  closed: '#3ddc97',
} as const;

const day = (iso: string): string => iso.slice(0, 10);

/** The card's figures for a timeline; see the file comment for where each comes from. */
export function loopCard(tl: Timeline): LoopCard {
  const w = tl.wrapped;
  const project = w ? (w.project ?? 'All projects') : null;
  const window = tl.from ? `${day(tl.from)} to ${day(tl.to)}` : `to ${day(tl.to)}`;
  return {
    agentHours: w ? w.agentHours : tl.totals.agentHours,
    humanMinutes: tl.totals.humanMinutes,
    asksAnswered: tl.totals.asksAnswered,
    reviewRounds: tl.totals.reviewRounds,
    tasksClosed: w ? w.closed : tl.totals.tasksClosed,
    footer: project ? `${project} · ${window}` : window,
    fromReport: w !== undefined,
  };
}

/**
 * Agent minutes per human minute, rounded to a whole number from 10 up and to one decimal below;
 * null when either side is zero.
 */
export function minutesPerHumanMinute(card: LoopCard): number | null {
  if (!(card.agentHours > 0) || !(card.humanMinutes > 0)) return null;
  const r = (card.agentHours * 60) / card.humanMinutes;
  return r >= 10 ? Math.round(r) : Math.round(r * 10) / 10;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const easeOut = (x: number): number => 1 - (1 - x) ** 3;

/** `value` counted up to `k` (0 to 1) of the way, with `decimals` places. */
export function countUp(value: number, k: number, decimals = 0): string {
  const f = 10 ** decimals;
  return (Math.round(value * easeOut(clamp01(k)) * f) / f).toFixed(decimals);
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

interface Figure {
  id: keyof typeof CARD_COLORS;
  value: number;
  decimals: number;
  unit: string;
}

function figures(card: LoopCard): { heroes: Figure[]; row: Figure[] } {
  return {
    heroes: [
      {
        id: 'agent',
        value: card.agentHours,
        decimals: 1,
        unit: plural(card.agentHours, 'agent hour', 'agent hours'),
      },
      {
        id: 'human',
        value: card.humanMinutes,
        decimals: 0,
        unit: plural(card.humanMinutes, 'human minute', 'human minutes'),
      },
    ],
    row: [
      {
        id: 'asks',
        value: card.asksAnswered,
        decimals: 0,
        unit: plural(card.asksAnswered, 'ask answered', 'asks answered'),
      },
      {
        id: 'reviews',
        value: card.reviewRounds,
        decimals: 0,
        unit: plural(card.reviewRounds, 'review round', 'review rounds'),
      },
      {
        id: 'closed',
        value: card.tasksClosed,
        decimals: 0,
        unit: plural(card.tasksClosed, 'task closed', 'tasks closed'),
      },
    ],
  };
}

/** Where the card's parts sit on a stage: heroes side by side when wide, stacked otherwise. */
interface CardLayout {
  s: number;
  title: number;
  footer: number;
  heroes: Array<{ x: number; y: number }>;
  heroSize: number;
  against: { x: number; y: number };
  ratio: number;
  row: Array<{ x: number; y: number }>;
  rowSize: number;
}

export function cardLayout(stage: { width: number; height: number }): CardLayout {
  const s = Math.min(stage.width, stage.height) / 1080;
  const cx = stage.width / 2;
  if (stage.width / stage.height >= 1.3) {
    return {
      s,
      title: 150 * s,
      footer: 205 * s,
      heroes: [
        { x: cx - 470 * s, y: 500 * s },
        { x: cx + 470 * s, y: 500 * s },
      ],
      heroSize: 200 * s,
      against: { x: cx, y: 460 * s },
      ratio: 680 * s,
      row: [-1, 0, 1].map((k) => ({ x: cx + k * 440 * s, y: 860 * s })),
      rowSize: 96 * s,
    };
  }
  // Stacked: one column, centered, its spacing stretched on a tall stage.
  const k = Math.min(1.5, Math.max(1, (stage.height - 300 * s) / (800 * s)));
  const top = (stage.height - 800 * s * k) / 2 + 30 * s;
  const at = (y: number): number => top + y * s * k;
  return {
    s,
    title: at(0),
    footer: at(48),
    heroes: [
      { x: cx, y: at(250) },
      { x: cx, y: at(520) },
    ],
    heroSize: 160 * s,
    against: { x: cx, y: at(355) },
    ratio: at(630),
    row: [-1, 0, 1].map((j) => ({ x: cx + j * 340 * s, y: at(770) })),
    rowSize: 84 * s,
  };
}

/**
 * Draws the card `elapsed` ms after it starts: it fades in over `CARD_FADE_MS`, and its numbers
 * count up over `COUNT_MS` from then on. `backdrop` dims what is under it, for an outro.
 */
export function renderLoopCard(
  card: LoopCard,
  frame: Frame,
  elapsed: number,
  backdrop = true,
): ReactElement {
  const L = cardLayout(frame);
  const s = L.s;
  const cx = frame.width / 2;
  const fade = easeOut(clamp01(elapsed / CARD_FADE_MS));
  const k = clamp01((elapsed - CARD_FADE_MS * 0.6) / COUNT_MS);
  const { heroes, row } = figures(card);
  const ratio = minutesPerHumanMinute(card);
  const dy = (1 - fade) * 40 * s;
  return (
    <g data-card="loop" fontFamily="'IBM Plex Sans', 'Segoe UI', sans-serif">
      {backdrop && (
        <rect width={frame.width} height={frame.height} fill={BACKDROP} fillOpacity={0.95 * fade} />
      )}
      <g opacity={fade} transform={`translate(0 ${dy})`}>
        <circle
          cx={cx}
          cy={frame.height / 2}
          r={Math.min(frame.width, frame.height) * 0.46}
          fill={CARD_COLORS.agent}
          fillOpacity={0.05}
        />
        <text
          x={cx}
          y={L.title}
          fill="#5ce1e6"
          fontSize={40 * s}
          fontWeight={600}
          textAnchor="middle"
          letterSpacing={4 * s}
        >
          HUMAN IN THE LOOP
        </text>
        <text x={cx} y={L.footer} fill="#8b98a5" fontSize={28 * s} textAnchor="middle">
          {card.footer}
        </text>
        {heroes.map((f, i) => (
          <g key={f.id} data-figure={f.id}>
            <text
              x={L.heroes[i]!.x}
              y={L.heroes[i]!.y}
              fill={CARD_COLORS[f.id]}
              fontSize={L.heroSize}
              fontWeight={700}
              textAnchor="middle"
            >
              {countUp(f.value, k, f.decimals)}
            </text>
            <text
              x={L.heroes[i]!.x}
              y={L.heroes[i]!.y + 62 * s}
              fill="#e6edf3"
              fontSize={44 * s}
              textAnchor="middle"
            >
              {f.unit}
            </text>
          </g>
        ))}
        <text
          x={L.against.x}
          y={L.against.y}
          fill="#8b98a5"
          fontSize={36 * s}
          fontStyle="italic"
          textAnchor="middle"
        >
          against
        </text>
        {ratio !== null && (
          <text
            x={cx}
            y={L.ratio}
            fill="#c3ccd5"
            fontSize={34 * s}
            textAnchor="middle"
            opacity={clamp01((k - 0.7) / 0.3)}
          >
            {`${ratio} agent ${plural(ratio, 'minute', 'minutes')} for every human minute`}
          </text>
        )}
        {row.map((f, i) => (
          <g key={f.id} data-figure={f.id}>
            <text
              x={L.row[i]!.x}
              y={L.row[i]!.y}
              fill={CARD_COLORS[f.id]}
              fontSize={L.rowSize}
              fontWeight={700}
              textAnchor="middle"
            >
              {countUp(f.value, k, f.decimals)}
            </text>
            <text
              x={L.row[i]!.x}
              y={L.row[i]!.y + 48 * s}
              fill="#c3ccd5"
              fontSize={30 * s}
              textAnchor="middle"
            >
              {f.unit}
            </text>
          </g>
        ))}
      </g>
    </g>
  );
}
