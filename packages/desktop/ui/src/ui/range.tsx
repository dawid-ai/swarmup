import { useState } from 'react';
import { q } from '../api';
import { cx } from '../components';

/** A time window: the last `days` days, or a custom `from` to `to` of dates such as `2026-11-01`. */
export interface TimeRange {
  /** Days back from now; 0 for all time, where a view offers it. */
  days: number;
  custom: boolean;
  from: string;
  to: string;
}

/** The presets of the **Range** buttons, in days. */
export const RANGES: Array<[number, string]> = [
  [1, 'Day'],
  [7, 'Week'],
  [30, '30 days'],
  [90, '90 days'],
];

/** A `YYYY-MM-DD` date at local midnight, or null when it is not one. */
function localDay(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/**
 * A custom range's **From** and **to** dates as ISO times: from the local midnight of `from` to
 * the local midnight after `to`, so the whole `to` day counts. swarmupd reads a bare date as UTC
 * midnight, which would shift the range by the local offset. Without `to`, only `start`: the
 * range runs up to now. Null without a valid `from` or when it ends before it starts.
 */
export function customRange(from: string, to: string): { start: string; end?: string } | null {
  const start = localDay(from);
  if (!start) return null;
  const last = to ? localDay(to) : null;
  if (!last) return { start: start.toISOString() };
  const end = new Date(last);
  end.setDate(end.getDate() + 1);
  return end > start ? { start: start.toISOString(), end: end.toISOString() } : null;
}

/**
 * The query parameters swarmupd reads a window from, as `/api/report` and `/api/timeline` take
 * them: `days=7`, or `from=…&to=…` as the ISO times of `customRange`. '' for all time; null
 * while a custom window has no start or ends before it starts.
 */
export function rangeParams(r: TimeRange): string | null {
  if (r.custom) {
    const c = customRange(r.from, r.to);
    return c ? `from=${q(c.start)}${c.end ? `&to=${q(c.end)}` : ''}` : null;
  }
  return r.days > 0 ? `days=${r.days}` : '';
}

/** A saved range, or undefined when `raw` is not one. */
function parseRange(raw: string | null): TimeRange | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Partial<TimeRange>;
    if (
      typeof v.days === 'number' &&
      typeof v.custom === 'boolean' &&
      typeof v.from === 'string' &&
      typeof v.to === 'string'
    ) {
      return { days: v.days, custom: v.custom, from: v.from, to: v.to };
    }
  } catch {
    // Not JSON: start from the default.
  }
  return undefined;
}

/**
 * The range of a view, starting at `initial`. With `storageKey`, the range is saved in this
 * browser's storage and comes back on the next visit; storage that fails keeps it in memory.
 */
export function useTimeRange(
  initial: TimeRange,
  storageKey?: string,
): [TimeRange, (r: TimeRange) => void] {
  const [range, setRange] = useState<TimeRange>(() => {
    if (!storageKey) return initial;
    try {
      return parseRange(window.localStorage.getItem(storageKey)) ?? initial;
    } catch {
      return initial;
    }
  });
  const set = (r: TimeRange): void => {
    setRange(r);
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(r));
    } catch {
      // Private window or blocked storage: the range lasts until the view closes.
    }
  };
  return [range, set];
}

const PICK = 'rounded-md px-2.5 py-1 text-xs transition';
const ON = 'bg-signal/15 text-signal';
const OFF = 'text-fg-3 hover:text-fg';

/**
 * The **Range** buttons for a view's header: the presets, then **Custom**. With `all`, a first
 * button of that label picks all time (`days` 0).
 */
export function RangeButtons({
  value,
  onChange,
  all,
}: {
  value: TimeRange;
  onChange: (r: TimeRange) => void;
  all?: string;
}) {
  const presets: Array<[number, string]> = all ? [[0, all], ...RANGES] : RANGES;
  return (
    <div className="flex shrink-0 rounded-lg bg-white/5 p-0.5" role="group" aria-label="Range">
      {presets.map(([d, label]) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange({ ...value, days: d, custom: false })}
          aria-pressed={!value.custom && value.days === d}
          className={cx(PICK, !value.custom && value.days === d ? ON : OFF)}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => onChange({ ...value, custom: true })}
        aria-pressed={value.custom}
        className={cx(PICK, value.custom ? ON : OFF)}
      >
        Custom
      </button>
    </div>
  );
}

const DATE = 'h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-fg';

/** The **From** and **to** dates of a custom range; nothing while a preset is picked. */
export function RangeDates({
  value,
  onChange,
}: {
  value: TimeRange;
  onChange: (r: TimeRange) => void;
}) {
  if (!value.custom) return null;
  return (
    <>
      <span className="ml-2 text-fg-3">From</span>
      <input
        type="date"
        aria-label="From"
        value={value.from}
        onChange={(e) => onChange({ ...value, from: e.target.value })}
        className={DATE}
      />
      <span className="text-fg-3">to</span>
      <input
        type="date"
        aria-label="To"
        value={value.to}
        onChange={(e) => onChange({ ...value, to: e.target.value })}
        className={DATE}
      />
    </>
  );
}
