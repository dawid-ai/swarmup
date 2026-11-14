import { readFileSync } from 'node:fs';
import { OpsError } from './ids.js';

export interface TableDecisionRow {
  /** The decision text. Empty when the row is reported as skipped. */
  text: string;
  body: string;
  source: string;
  /** ISO time at midnight UTC. Absent when neither the row nor its headings name a date. */
  createdAt?: string;
  heading: string;
  row: number;
}

interface Heading {
  level: number;
  text: string;
  date?: string;
}

const DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

function dateIn(text: string): string | undefined {
  const value = DATE.exec(text)?.[1];
  if (!value) return undefined;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(at) || new Date(at).toISOString().slice(0, 10) !== value) return undefined;
  return new Date(at).toISOString();
}

/** A Markdown table row, with escaped pipes kept as literal pipes. */
function cells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const out: string[] = [];
  let cell = '';
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      cell += char === '|' ? '|' : `\\${char}`;
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      out.push(cell.trim());
      cell = '';
    } else {
      cell += char;
    }
  }
  if (escaped) cell += '\\';
  out.push(cell.trim());
  return out;
}

function separator(line: string, width: number): boolean {
  const found = cells(line);
  return (
    found.length === width && found.every((value) => /^:?-{3,}:?$/.test(value.replace(/\s+/g, '')))
  );
}

function headerName(value: string): string {
  return value.replace(/[`*_]/g, '').trim().toLowerCase();
}

function bodyFor(headers: string[], values: string[], excluded: Set<number>): string {
  return headers
    .map((header, index) =>
      excluded.has(index) || !values[index]?.trim()
        ? ''
        : `**${header.trim() || `Column ${index + 1}`}:** ${values[index]!.trim()}`,
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Reads every Markdown table below a heading whose text contains `Decisions`. A `Date` column
 * wins; historical tables without one take the closest dated ancestor heading, then the latest
 * dated heading before the table. The latter covers the old hub's sibling `Decisions` heading.
 */
export function readDecisionTable(file: string): TableDecisionRow[] {
  let markdown: string;
  try {
    markdown = readFileSync(file, 'utf8');
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new OpsError(`cannot read import file ${file}: ${why}`, 2);
  }
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const stack: Heading[] = [];
  const rowByHeading = new Map<string, number>();
  let latestDate: string | undefined;
  const out: TableDecisionRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]!);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      while (stack.at(-1)?.level !== undefined && stack.at(-1)!.level >= level) stack.pop();
      const date = dateIn(text);
      if (date) latestDate = date;
      stack.push({ level, text, date });
      continue;
    }

    if (!lines[i]!.includes('|') || i + 1 >= lines.length) continue;
    const headers = cells(lines[i]!);
    if (headers.length < 2 || !separator(lines[i + 1]!, headers.length)) continue;
    const decisions = [...stack].reverse().find((h) => /decisions/i.test(h.text));
    if (!decisions) continue;
    const names = headers.map(headerName);
    const decision = names.findIndex((name) => name === 'decision' || name === 'what');
    const dateColumn = names.findIndex((name) => name === 'date' || name === 'when');
    if (decision < 0) continue;
    const contextualDate =
      [...stack].reverse().find((h) => h.date)?.date ?? decisions.date ?? latestDate;
    const key = decisions.text;
    i += 2;
    while (i < lines.length && lines[i]!.includes('|')) {
      const values = cells(lines[i]!);
      if (values.length !== headers.length) break;
      const row = (rowByHeading.get(key) ?? 0) + 1;
      rowByHeading.set(key, row);
      const rawDate = dateColumn >= 0 ? values[dateColumn] : undefined;
      const createdAt = rawDate !== undefined ? dateIn(rawDate) : contextualDate;
      const text = values[decision]?.trim() ?? '';
      out.push({
        text,
        body: bodyFor(
          headers,
          values,
          new Set([decision, ...(dateColumn >= 0 ? [dateColumn] : [])]),
        ),
        source: `${file}#${decisions.text}, row ${row}`,
        createdAt,
        heading: decisions.text,
        row,
      });
      i++;
    }
    i--;
  }
  return out;
}

export interface NoteMapping {
  slug: string;
  decisions: string[];
}

/** Parses repeatable `SLUG=D-ID[,D-ID]` note mappings. */
export function parseNoteMappings(values: string[], flag: string, one = false): NoteMapping[] {
  const out: NoteMapping[] = [];
  for (const raw of values) {
    const at = raw.indexOf('=');
    const slug = at > 0 ? raw.slice(0, at).trim() : '';
    const decisions =
      at > 0
        ? raw
            .slice(at + 1)
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
    if (!slug || decisions.length === 0 || (one && decisions.length !== 1)) {
      throw new OpsError(
        `${flag} needs ${one ? 'SLUG=D-ID' : 'SLUG=D-ID[,D-ID]'}, not '${raw}'`,
        2,
      );
    }
    out.push({ slug, decisions });
  }
  return out;
}
