// Wrapped cards (AO-0084): a short sequence of stat cards for a project or a window. Each card
// gets an equal slot of the clip: it slides in, counts its number up, holds, then fades for the
// next. The figures come from `timeline.wrapped` (`/api/timeline?wrapped=1`), which uses the
// report of the same window, so the cards show what `swarmup report` shows.
import { minutes as minutesText, tokens as tokenText } from '../../lib/format';
import type { Timeline, Wrapped } from '../../types';
import type { Scene, Stage } from '../scene';

export interface WrappedCard {
  /** Stable key, used in PNG file names. */
  id: string;
  /** The small label above the number. */
  title: string;
  /** The big number; null for the title card. */
  value: number | null;
  decimals: number;
  /** The words after the number, or the title card's heading. */
  unit: string;
  /** A name or task under the number. */
  subject: string;
  detail: string;
  color: string;
}

export interface WrappedData {
  cards: WrappedCard[];
  /** `project · from to to`, shown on every card. */
  footer: string;
}

const day = (iso: string): string => iso.slice(0, 10);

/** Cuts `s` to `n` characters with an ellipsis. */
export function cut(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

const VERDICT = { approve: 'approved', changes: 'changes asked' } as const;

/** The cards for `w`, title card first; a card with nothing to show is left out. */
export function wrappedCards(w: Wrapped): WrappedCard[] {
  const cards: WrappedCard[] = [
    {
      id: 'title',
      title: 'SwarmUp Wrapped',
      value: null,
      decimals: 0,
      unit: w.project ?? 'All projects',
      subject: `${day(w.from)} to ${day(w.to)}`,
      detail: '',
      color: '#5ce1e6',
    },
    {
      id: 'closed',
      title: 'Shipped',
      value: w.closed,
      decimals: 0,
      unit: w.closed === 1 ? 'task closed' : 'tasks closed',
      subject: `${w.opened} opened`,
      detail: '',
      color: '#3ddc97',
    },
    {
      id: 'hours',
      title: 'Agents against humans',
      value: w.agentHours,
      decimals: 1,
      unit: 'agent hours',
      subject: `against ${w.humanMinutes} human minutes`,
      detail: 'Agents in supervised runs; human minutes estimated from their actions',
      color: '#f08a5d',
    },
  ];
  if (w.busiest) {
    cards.push({
      id: 'busiest',
      title: 'Busiest agent',
      value: w.busiest.runs,
      decimals: 0,
      unit: w.busiest.runs === 1 ? 'run' : 'runs',
      subject: w.busiest.agent,
      detail: `${minutesText(w.busiest.minutes)} in runs, ${tokenText(w.busiest.tokens)} tokens`,
      color: '#94a3b8',
    });
  }
  if (w.rally) {
    const verdict = w.rally.verdict ? VERDICT[w.rally.verdict] : 'still open';
    cards.push({
      id: 'rally',
      title: 'Longest review rally',
      value: w.rally.rounds,
      decimals: 0,
      unit: w.rally.rounds === 1 ? 'review round' : 'review rounds',
      subject: cut(`${w.rally.task} ${w.rally.title}`, 52),
      detail: `${w.rally.players.join(' ↔ ')}, ${verdict}`,
      color: '#b18cff',
    });
  }
  if (w.fastest) {
    const m = w.fastest.minutes;
    cards.push({
      id: 'fastest',
      title: 'Fastest answer',
      value: m < 10 ? m : Math.round(m),
      decimals: m < 10 ? 1 : 0,
      unit: 'min from ask to answer',
      subject: cut(`${w.fastest.task} ${w.fastest.title}`, 52),
      detail: w.fastest.asked ? `asked ${w.fastest.asked}` : '',
      color: '#ffc857',
    });
  }
  if (w.blocked) {
    const hours = w.blocked.minutes >= 120;
    cards.push({
      id: 'blocked',
      title: 'Most blocked',
      value: hours ? Math.round((w.blocked.minutes / 60) * 10) / 10 : w.blocked.minutes,
      decimals: hours ? 1 : 0,
      unit: hours ? 'hours waiting' : 'minutes waiting',
      subject: cut(`${w.blocked.task} ${w.blocked.title}`, 52),
      detail: `${w.blocked.waits} ${w.blocked.waits === 1 ? 'wait' : 'waits'}`,
      color: '#ff6b6b',
    });
  }
  return cards;
}

export function prepareWrapped(tl: Timeline): WrappedData {
  const w = tl.wrapped;
  if (!w) return { cards: [], footer: '' };
  return {
    cards: wrappedCards(w),
    footer: `${w.project ?? 'All projects'} · ${day(w.from)} to ${day(w.to)}`,
  };
}

/** The card shown at playback time `t`, and how far into its slot it is (0 to 1). */
export function cardAt(n: number, duration: number, t: number): { index: number; u: number } {
  if (n === 0 || duration <= 0) return { index: 0, u: 1 };
  const slot = duration / n;
  const clamped = Math.min(Math.max(0, t), duration);
  const index = Math.min(n - 1, Math.floor(clamped / slot));
  return { index, u: Math.min(1, (clamped - index * slot) / slot) };
}

/** A playback time at which card `index` shows in full, number counted up: for PNG export. */
export function cardTime(index: number, n: number, duration: number): number {
  return n > 0 && duration > 0 ? (duration / n) * (index + 0.6) : 0;
}

/** The PNG file name for card `index`, such as `wrapped-swarmup-2026-11-08-2-closed.png`. */
export function cardFileName(
  w: Pick<Wrapped, 'project' | 'to'>,
  card: WrappedCard,
  index: number,
): string {
  const project = (w.project ?? 'all-projects').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const name = `wrapped-${project}-${day(w.to)}-${index + 1}-${card.id}`;
  return `${name.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 76)}.png`;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const easeOut = (x: number): number => 1 - (1 - x) ** 3;

function shown(card: WrappedCard, u: number): string {
  if (card.value === null) return '';
  const k = easeOut(clamp01((u - 0.08) / 0.4));
  const f = 10 ** card.decimals;
  const v = Math.round(card.value * k * f) / f;
  return v.toFixed(card.decimals);
}

function layout(stage: Stage): { s: number; cx: number } {
  return { s: Math.min(stage.width, stage.height) / 1080, cx: stage.width / 2 };
}

export const wrappedScene: Scene<WrappedData> = {
  id: 'wrapped',
  label: 'Wrapped',
  description:
    'Stat cards: tasks closed, agent hours against human minutes, busiest agent, longest review rally, fastest answer, most blocked task',
  query: 'wrapped=1',
  prepare: (tl) => prepareWrapped(tl),
  render(d, frame) {
    const { s, cx } = layout(frame);
    const font = "'IBM Plex Sans', 'Segoe UI', sans-serif";
    if (d.cards.length === 0) {
      return (
        <text
          x={cx}
          y={frame.height / 2}
          fill="#8b98a5"
          fontSize={40 * s}
          textAnchor="middle"
          fontFamily={font}
        >
          Loading Wrapped…
        </text>
      );
    }
    const n = d.cards.length;
    const { index, u } = cardAt(n, frame.duration, frame.t);
    const card = d.cards[index]!;
    const enter = easeOut(clamp01(u / 0.12));
    const exit = index < n - 1 ? clamp01((u - 0.92) / 0.08) : 0;
    const opacity = enter * (1 - exit);
    const dy = (1 - enter) * 60 * s - exit * 30 * s;
    const mid = frame.height * 0.5;
    const title = card.value === null;
    return (
      <g fontFamily={font} data-card={card.id}>
        <circle
          cx={cx}
          cy={mid}
          r={frame.height * 0.42}
          fill={card.color}
          fillOpacity={0.06 * opacity}
        />
        <g opacity={opacity} transform={`translate(0 ${dy})`}>
          <text
            x={cx}
            y={mid - 230 * s}
            fill={card.color}
            fontSize={40 * s}
            fontWeight={600}
            textAnchor="middle"
            letterSpacing={4 * s}
          >
            {card.title.toUpperCase()}
          </text>
          {title ? (
            <text
              x={cx}
              y={mid + 30 * s}
              fill="#e6edf3"
              fontSize={130 * s}
              fontWeight={700}
              textAnchor="middle"
            >
              {cut(card.unit, 22)}
            </text>
          ) : (
            <>
              <text
                x={cx}
                y={mid + 60 * s}
                fill={card.color}
                fontSize={260 * s}
                fontWeight={700}
                textAnchor="middle"
              >
                {shown(card, u)}
              </text>
              <text x={cx} y={mid + 130 * s} fill="#e6edf3" fontSize={48 * s} textAnchor="middle">
                {card.unit}
              </text>
            </>
          )}
          <text
            x={cx}
            y={mid + (title ? 120 : 210) * s}
            fill="#e6edf3"
            fontSize={40 * s}
            fontWeight={600}
            textAnchor="middle"
          >
            {card.subject}
          </text>
          {card.detail && (
            <text
              x={cx}
              y={mid + (title ? 180 : 270) * s}
              fill="#8b98a5"
              fontSize={30 * s}
              textAnchor="middle"
            >
              {card.detail}
            </text>
          )}
        </g>
        <text x={cx} y={80 * s} fill="#8b98a5" fontSize={28 * s} textAnchor="middle">
          {d.footer}
        </text>
        {d.cards.map((c, i) => (
          <circle
            key={c.id}
            cx={cx + (i - (n - 1) / 2) * 32 * s}
            cy={frame.height - 60 * s}
            r={8 * s}
            fill={i === index ? card.color : '#ffffff'}
            fillOpacity={i === index ? 1 : 0.2}
          />
        ))}
      </g>
    );
  },
};
