import { cx } from '../components';

/** The preset ranges in days, with their button labels. */
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
 * the local midnight after `to`, so the whole `to` day counts. Without `to`, only `start`: the
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

/** The **Range** buttons of a view header: the presets, then **Custom**. */
export function RangeButtons(props: {
  days: number;
  custom: boolean;
  onDays: (days: number) => void;
  onCustom: () => void;
}) {
  const { days, custom } = props;
  return (
    <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Range">
      {RANGES.map(([d, label]) => (
        <button
          key={d}
          type="button"
          onClick={() => props.onDays(d)}
          aria-pressed={!custom && days === d}
          className={cx(
            'rounded-md px-2.5 py-1 text-xs transition',
            !custom && days === d ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
          )}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        onClick={props.onCustom}
        aria-pressed={custom}
        className={cx(
          'rounded-md px-2.5 py-1 text-xs transition',
          custom ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
        )}
      >
        Custom
      </button>
    </div>
  );
}

/** The **From** and **to** date inputs of a custom range, as `YYYY-MM-DD` values. */
export function DateInputs(props: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  className?: string;
}) {
  const input = 'h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-fg';
  return (
    <>
      <span className={cx('text-fg-3', props.className)}>From</span>
      <input
        type="date"
        aria-label="From"
        value={props.from}
        onChange={(e) => props.onFrom(e.target.value)}
        className={input}
      />
      <span className="text-fg-3">to</span>
      <input
        type="date"
        aria-label="To"
        value={props.to}
        onChange={(e) => props.onTo(e.target.value)}
        className={input}
      />
    </>
  );
}
