// Reading a file's patch for the diff view (AO-0106): hunks, the rows of the side-by-side
// layout, and the colors of a line of code. No React here, so it tests without a DOM.

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  /** The line's number in the old file; unset for an added line. */
  old?: number;
  /** The line's number in the new file; unset for a deleted line. */
  new?: number;
  text: string;
  /** The file ends at this line without a line break. */
  noEol?: true;
}

export interface Hunk {
  /** The `@@ -1,4 +1,6 @@ function name` line. */
  header: string;
  lines: DiffLine[];
}

/** The hunks of a file's patch in unified format, from its first `@@` line on. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  const lines = patch.split('\n');
  // The patch ends with a line break, which is no line of its own.
  if (lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      cur = { header: raw, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    const text = raw.slice(1).replace(/\r$/, '');
    if (raw[0] === '+') cur.lines.push({ kind: 'add', new: newNo++, text });
    else if (raw[0] === '-') cur.lines.push({ kind: 'del', old: oldNo++, text });
    else if (raw[0] === '\\') {
      const last = cur.lines[cur.lines.length - 1];
      if (last) last.noEol = true;
    } else cur.lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text });
  }
  return hunks;
}

export interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * A hunk's lines as rows of the side-by-side layout: a line both files have fills both sides, and
 * a run of deleted lines pairs up with the added lines that follow it.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === 'ctx') {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (lines[i]?.kind === 'del') dels.push(lines[i++]!);
    while (lines[i]?.kind === 'add') adds.push(lines[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k], right: adds[k] });
    }
  }
  return rows;
}

// ---- Syntax colors ------------------------------------------------------------------------------

export type TokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number';

export interface Token {
  kind: TokenKind;
  text: string;
}

/** What the colors need to know about a language; a line is read alone, with no state. */
export interface Lang {
  /** What starts a comment that runs to the end of the line. */
  line?: string[];
  /** A comment between two marks, such as slash-star and star-slash. */
  block?: [string, string];
  quotes: string[];
  keywords: Set<string>;
  /** Keywords match in any case, as in SQL. */
  anyCase?: boolean;
}

const words = (s: string): Set<string> => new Set(s.split(' '));

const C_LIKE = {
  line: ['//'],
  block: ['/*', '*/'] as [string, string],
  quotes: ['"', "'"],
};

const JS: Lang = {
  ...C_LIKE,
  quotes: ['"', "'", '`'],
  keywords: words(
    'abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unknown var void while yield',
  ),
};

const PYTHON: Lang = {
  line: ['#'],
  quotes: ['"', "'"],
  keywords: words(
    'False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  ),
};

const SHELL: Lang = {
  line: ['#'],
  quotes: ['"', "'"],
  keywords: words(
    'case do done elif else esac export fi for function if in local return then until while',
  ),
};

const CONFIG: Lang = {
  line: ['#'],
  quotes: ['"', "'"],
  keywords: words('true false null yes no on off'),
};

const JSON_LANG: Lang = { quotes: ['"'], keywords: words('true false null') };

const CSS: Lang = { block: ['/*', '*/'], quotes: ['"', "'"], keywords: words('!important') };

const MARKUP: Lang = { block: ['<!--', '-->'], quotes: ['"', "'"], keywords: new Set() };

const SQL: Lang = {
  line: ['--'],
  block: ['/*', '*/'],
  quotes: ["'"],
  anyCase: true,
  keywords: words(
    'add alter and as asc begin by case commit create delete desc distinct drop else end exists from group having in index inner insert into is join key left limit not null on or order outer primary references right rollback select set table then union unique update values view when where',
  ),
};

/** Go, Rust, Java, C, C++, C# and Swift share enough words for a diff to read well. */
const C_FAMILY: Lang = {
  ...C_LIKE,
  keywords: words(
    'abstract as async auto await bool boolean break byte case catch chan char class const continue crate default defer delete do double dyn else enum extends extern false final finally float fn for func go goto if impl implements import in int interface let long loop map match mod mut namespace new nil null nullptr operator override package private protected pub public range ref return select self short signed sizeof static string struct super switch template this throw throws trait true try type typedef union unsafe unsigned use using var virtual void volatile where while',
  ),
};

const BY_EXT: Record<string, Lang> = {
  ts: JS,
  tsx: JS,
  mts: JS,
  cts: JS,
  js: JS,
  jsx: JS,
  mjs: JS,
  cjs: JS,
  json: JSON_LANG,
  jsonc: { ...JSON_LANG, ...C_LIKE, quotes: ['"'] },
  py: PYTHON,
  sh: SHELL,
  bash: SHELL,
  zsh: SHELL,
  ps1: { ...SHELL, block: ['<#', '#>'] },
  yml: CONFIG,
  yaml: CONFIG,
  toml: CONFIG,
  ini: { ...CONFIG, line: ['#', ';'] },
  css: CSS,
  scss: { ...CSS, line: ['//'] },
  html: MARKUP,
  htm: MARKUP,
  xml: MARKUP,
  svg: MARKUP,
  sql: SQL,
  go: C_FAMILY,
  rs: C_FAMILY,
  java: C_FAMILY,
  kt: C_FAMILY,
  c: C_FAMILY,
  h: C_FAMILY,
  cc: C_FAMILY,
  cpp: C_FAMILY,
  hpp: C_FAMILY,
  cs: C_FAMILY,
  swift: C_FAMILY,
};

/** The language of a file by its name, or null for one the view shows in one color. */
export function languageOf(path: string): Lang | null {
  const name = path.split('/').pop() ?? '';
  if (name === 'Dockerfile' || name === 'Makefile') return SHELL;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

const WORD = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?/y;

/**
 * One line of code as colored tokens. It reads the line alone: a comment or string that began on
 * an earlier line is not known, apart from a line that starts with the middle or the end of a
 * block comment (`*`), which a diff shows often.
 */
export function highlight(text: string, lang: Lang | null): Token[] {
  if (!lang || text === '') return [{ kind: 'plain', text }];
  const out: Token[] = [];
  const push = (kind: TokenKind, s: string): void => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += s;
    else if (s) out.push({ kind, text: s });
  };
  if (lang.block?.[0] === '/*' && /^\s*\*(?:[\s/]|$)/.test(text)) {
    return [{ kind: 'comment', text }];
  }
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (lang.block && text.startsWith(lang.block[0], i)) {
      const end = text.indexOf(lang.block[1], i + lang.block[0].length);
      const stop = end < 0 ? text.length : end + lang.block[1].length;
      push('comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    const line = lang.line?.find((mark) => text.startsWith(mark, i));
    // `#` starts a comment only at the start of a word: `$#`, `a#b` and `#fff` in a URL do not.
    if (line && (line !== '#' || i === 0 || /\s/.test(text[i - 1]!))) {
      push('comment', text.slice(i));
      break;
    }
    if (lang.quotes.includes(ch)) {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, text.length);
      push('string', text.slice(i, j));
      i = j;
      continue;
    }
    const before = i > 0 ? text[i - 1]! : ' ';
    if (/\d/.test(ch) && !/[\w$]/.test(before)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      if (m) {
        push('number', m[0]);
        i += m[0].length;
        continue;
      }
    }
    WORD.lastIndex = i;
    const w = WORD.exec(text);
    if (w) {
      const word = lang.anyCase ? w[0].toLowerCase() : w[0];
      push(lang.keywords.has(word) ? 'keyword' : 'plain', w[0]);
      i += w[0].length;
      continue;
    }
    push('plain', ch);
    i++;
  }
  return out;
}
