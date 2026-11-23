/**
 * Five-field cron expressions for git triggers (W5 phase 4): minute, hour, day of month, month
 * and day of week, read in the local time of the machine that checks them. Each field takes `*`,
 * a value, a range `a-b`, a step `*\/s`, `a-b/s` or `a/s`, and lists of those joined by commas.
 * Months take `jan` to `dec`, days of the week `sun` to `sat` (0 or 7 is Sunday). As in Vixie
 * cron, when both day fields are restricted a day matches either; when one starts with `*`, only
 * the other one counts.
 */
import { OpsError } from '../ids.js';

/** A parsed cron expression: the allowed values of each field. */
export interface Cron {
  /** The text as given, trimmed, with single spaces. */
  source: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 (Sunday) to 6. */
  weekdays: ReadonlySet<number>;
  /** The day-of-month field starts with `*`. */
  anyDay: boolean;
  /** The day-of-week field starts with `*`. */
  anyWeekday: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Field {
  name: string;
  min: number;
  max: number;
  /** Names by value offset from `min`; for months and days of the week. */
  names?: string[];
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  // 7 is Sunday too; it becomes 0 after parsing.
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS },
];

export const CRON_HINT =
  'use five fields: minute hour day-of-month month day-of-week, such as `0 9 * * mon-fri`';

function bad(expr: string, why: string): never {
  throw new OpsError(`bad cron '${expr}': ${why}`, 2);
}

function value(f: Field, text: string, expr: string): number {
  const lower = text.toLowerCase();
  const named = f.names?.indexOf(lower) ?? -1;
  if (named >= 0) return named + f.min;
  if (!/^\d+$/.test(text))
    bad(expr, `${f.name}: '${text}' is no number${f.names ? ' or name' : ''}`);
  const n = Number(text);
  if (n < f.min || n > f.max) bad(expr, `${f.name}: ${n} is outside ${f.min}-${f.max}`);
  return n;
}

function parseField(f: Field, text: string, expr: string): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(',')) {
    if (!item) bad(expr, `${f.name}: an empty list entry`);
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined) bad(expr, `${f.name}: '${item}' has two steps`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        bad(expr, `${f.name}: the step in '${item}' must be a whole number of at least 1`);
      }
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      hi = f.max;
    } else if (range!.includes('-')) {
      const [a, b, more] = range!.split('-');
      if (more !== undefined || !a || !b) bad(expr, `${f.name}: '${item}' is no range`);
      lo = value(f, a, expr);
      hi = value(f, b, expr);
      // `fri-sun`: Sunday at the end of a range is 7.
      if (f.names === WEEKDAYS && hi === 0 && lo > 0) hi = 7;
      if (lo > hi) bad(expr, `${f.name}: the range '${item}' runs backwards`);
    } else {
      lo = value(f, range!, expr);
      // `5/15` runs from 5 to the end of the field.
      hi = stepText !== undefined ? f.max : lo;
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

/** Parses a five-field cron expression; throws an `OpsError` that names the field at fault. */
export function parseCron(expr: string): Cron {
  const source = expr.trim().replace(/\s+/g, ' ');
  const parts = source ? source.split(' ') : [];
  if (parts.length !== 5) bad(expr, CRON_HINT);
  const [minutes, hours, days, months, weekdays] = FIELDS.map((f, i) =>
    parseField(f, parts[i]!, expr),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    source,
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2]!.startsWith('*'),
    anyWeekday: parts[4]!.startsWith('*'),
  };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.days.has(d.getDate());
  const dow = c.weekdays.has(d.getDay());
  if (c.anyDay && c.anyWeekday) return true;
  if (c.anyDay) return dow;
  if (c.anyWeekday) return dom;
  return dom || dow;
}

/** Whether `ms` falls in a minute the expression names, in local time. */
export function cronMatches(c: Cron, ms: number): boolean {
  const d = new Date(ms);
  return (
    c.months.has(d.getMonth() + 1) &&
    dayMatches(c, d) &&
    c.hours.has(d.getHours()) &&
    c.minutes.has(d.getMinutes())
  );
}

/** How far {@link nextCron} looks ahead: four years and a day, so 29 February is found. */
const LOOKAHEAD_MS = (4 * 365 + 2) * 24 * 3_600_000;

/**
 * The start of the first minute after `afterMs` that the expression names, in local time; null
 * when none comes within four years (such as `0 0 30 2 *`). Fields that do not match skip ahead
 * by month, day or hour, so the search stays short. A time daylight saving skips fires at the
 * first minute after the gap.
 */
export function nextCron(c: Cron, afterMs: number): number | null {
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = afterMs + LOOKAHEAD_MS;
  let prev = afterMs;
  while (d.getTime() <= end) {
    // Daylight saving can move a local-time step backwards; time only goes forward here.
    if (d.getTime() <= prev) d.setTime(prev + 60_000);
    prev = d.getTime();
    if (!c.months.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
    } else if (!dayMatches(c, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    } else {
      const hour = d.getHours();
      const date = d.getDate();
      if (!c.hours.has(hour)) d.setHours(hour + 1, 0, 0, 0);
      else if (!c.minutes.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1, 0, 0);
      else return d.getTime();
      // Daylight saving skipped an hour the expression names: as in Vixie cron, it fires at the
      // first minute after the gap.
      if (d.getDate() === date) {
        for (let h = hour + 1; h < d.getHours(); h++) if (c.hours.has(h)) return d.getTime();
      }
    }
  }
  return null;
}
