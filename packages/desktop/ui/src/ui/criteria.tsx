// Typed success criteria (`done_when`) in the app: each criterion's spec and last result, the
// builder that writes typed criteria per kind, **Run checks**, and the per-criterion results a
// verdict gives. The shapes mirror `packages/core/src/criteria.ts`; swarmupd checks them again.
import type { LucideIcon } from 'lucide-react';
import {
  AlignLeft,
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleMinus,
  CircleX,
  FlaskConical,
  Gavel,
  Loader2,
  MapIcon,
  Plus,
  Scale,
  ShieldCheck,
  Terminal,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, q, useData } from '../api';
import { Button, cx, ErrorLine, Input, Select, useAction, Who } from '../components';
import { ago } from '../lib/format';
import { EvidenceLinks } from './work';
import type {
  CriteriaCheckJob,
  Criterion,
  CriterionLast,
  CriterionSpec,
  CriterionVerdict,
  TaskDetail,
} from '../types';

/** The artifacts of the task's review, for evidence that names one (W8). */
export interface ArtifactLinks {
  paths: readonly string[];
  open: (path: string) => void;
}

export type CriterionKind = CriterionSpec['kind'];
export type CriterionResult = CriterionVerdict['result'];

/** Each kind's icon, label, color and who judges it, as the table in docs/protocol.md says. */
export const KINDS: Record<
  CriterionKind,
  { icon: LucideIcon; label: string; color: string; judge: string }
> = {
  prose: {
    icon: AlignLeft,
    label: 'Prose',
    color: '#b4bccb',
    judge: 'The reviewer judges it by reading the work',
  },
  command: {
    icon: Terminal,
    label: 'Command',
    color: '#5aa9ff',
    judge: 'swarmupd runs it at merge; Run checks runs it now',
  },
  check: {
    icon: ShieldCheck,
    label: 'Check',
    color: '#5ce1e6',
    judge: 'A built-in check, no model: swarmupd runs it at merge; Run checks runs it now',
  },
  rubric: {
    icon: Scale,
    label: 'Rubric',
    color: '#b18cff',
    judge:
      'An LLM judge scores the work against the rubric file (Judge, or the merge where turned on); else the reviewer gives a score',
  },
  human: {
    icon: UserRound,
    label: 'Human',
    color: '#ffc857',
    judge: 'The reviewer answers the question by reading the work',
  },
  map: {
    icon: MapIcon,
    label: 'Map',
    color: '#3ddc97',
    judge: '`swarmup map check` covers the change, where the build has it',
  },
};

export const KIND_ORDER: CriterionKind[] = ['prose', 'command', 'check', 'rubric', 'human', 'map'];

/** The kinds the merge and **Run checks** run; a reviewer leaves them to the checks. */
export const RUN_KINDS: ReadonlySet<CriterionKind> = new Set(['command', 'check']);

/** The kinds a reviewer judges by reading the work. */
export const JUDGED_KINDS: ReadonlySet<CriterionKind> = new Set(['prose', 'rubric', 'human']);

type ArgType = 'text' | 'list' | 'number' | 'bool' | 'select' | 'map';

interface ArgField {
  key: string;
  label: string;
  type: ArgType;
  required?: boolean;
  placeholder?: string;
  /** bool and select: the choices, value then label; the empty value leaves the argument out. */
  choices?: Array<[string, string]>;
}

/** A file check's paths: one or several, comma-separated; a glob checks each file it matches. */
function pathField(placeholder: string): ArgField {
  return { key: 'path', label: 'Path', type: 'list', required: true, placeholder };
}

/**
 * The built-in checks and their arguments. A `list` takes one value or several, comma-separated;
 * a `map` takes `key: pattern` pairs separated by `;`.
 */
export const CHECKS: Record<string, ArgField[]> = {
  'file-exists': [pathField('dist/app.js, posts/*.md')],
  regex: [
    pathField('README.md'),
    { key: 'pattern', label: 'Pattern', type: 'text', required: true, placeholder: '^## Install' },
    { key: 'flags', label: 'Flags', type: 'text', placeholder: 'm' },
    {
      key: 'expect',
      label: 'Match',
      type: 'bool',
      choices: [
        ['', 'Must match'],
        ['false', 'Must not match'],
      ],
    },
  ],
  'word-count': [
    pathField('content/post.md'),
    { key: 'min', label: 'Min', type: 'number', placeholder: '600' },
    { key: 'max', label: 'Max', type: 'number', placeholder: '900' },
  ],
  'char-count': [
    pathField('posts/x-*.md'),
    { key: 'min', label: 'Min', type: 'number', placeholder: '1' },
    { key: 'max', label: 'Max', type: 'number', placeholder: '280' },
    {
      key: 'per',
      label: 'Per',
      type: 'select',
      choices: [
        ['', 'Whole file'],
        ['block', 'Each block'],
        ['line', 'Each line'],
      ],
    },
    { key: 'separator', label: 'Separator', type: 'text', placeholder: '---' },
    { key: 'urls_as', label: 'Each link counts', type: 'number', placeholder: '23' },
  ],
  contains: [
    pathField('posts/*.md'),
    { key: 'text', label: 'Text', type: 'list', required: true, placeholder: 'example.com/repo' },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      choices: [
        ['', 'All of them'],
        ['any', 'Any of them'],
      ],
    },
    {
      key: 'expect',
      label: 'Expect',
      type: 'bool',
      choices: [
        ['', 'Must contain'],
        ['false', 'Must not contain'],
      ],
    },
    {
      key: 'case-sensitive',
      label: 'Case',
      type: 'bool',
      choices: [
        ['', 'Ignore case'],
        ['true', 'Match case'],
      ],
    },
  ],
  'heading-structure': [
    pathField('docs/*.md'),
    { key: 'headings', label: 'Headings', type: 'list', placeholder: '# Title, ## Why' },
    {
      key: 'single-h1',
      label: 'H1',
      type: 'bool',
      choices: [
        ['', 'Exactly one h1'],
        ['false', 'Any number of h1'],
      ],
    },
    {
      key: 'no-skip',
      label: 'Levels',
      type: 'bool',
      choices: [
        ['', 'No skipped levels'],
        ['false', 'Levels may skip'],
      ],
    },
  ],
  'front-matter': [
    pathField('posts/*.md'),
    { key: 'keys', label: 'Keys', type: 'list', placeholder: 'channel, status, task' },
    { key: 'match', label: 'Match', type: 'map', placeholder: 'status: ^(draft|approved)$' },
  ],
  'image-alt': [pathField('posts/*.md')],
  'image-size': [
    pathField('assets/og/*.png'),
    { key: 'width', label: 'Width', type: 'number', required: true, placeholder: '1200' },
    { key: 'height', label: 'Height', type: 'number', required: true, placeholder: '630' },
    { key: 'max_kb', label: 'Max KB', type: 'number', placeholder: '500' },
  ],
  'links-resolve': [
    pathField('docs/index.md'),
    { key: 'root', label: 'Root', type: 'text', placeholder: 'docs' },
    {
      key: 'url-ok',
      label: 'Web links',
      type: 'bool',
      choices: [
        ['', 'Skip web links'],
        ['true', 'Check web links'],
      ],
    },
  ],
  'url-ok': [
    {
      key: 'url',
      label: 'URL',
      type: 'list',
      required: true,
      placeholder: 'https://example.com',
    },
  ],
};

const CHECK_NAMES = Object.keys(CHECKS);

/** What a criterion checks, in one line: its spec, with its description first when it has one. */
export function criterionLine(c: CriterionSpec | string): string {
  if (typeof c === 'string') return c;
  const line = kindLine(c);
  return c.when === 'publish' ? `${line} (after publish)` : line;
}

function kindLine(c: CriterionSpec): string {
  const own = (s: string): string => (c.text ? `${c.text} (${s})` : s);
  switch (c.kind) {
    case 'prose':
      return c.text ?? '';
    case 'command':
      return own(c.run ?? '');
    case 'check':
      return own(`${c.check ?? ''}${argsText(c.args) ? ` ${argsText(c.args)}` : ''}`);
    case 'rubric':
      return own(`${c.rubric ?? ''}${c.pass !== undefined ? `, passes at ${c.pass}` : ''}`);
    case 'human':
      return own(c.ask ?? '');
    case 'map':
      return c.text ?? 'the project map covers the change';
  }
}

function argText(v: unknown): string {
  return typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
}

/** A `map` argument as the builder's text: `key: pattern` pairs separated by `; `. */
function mapText(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return argText(v);
  return Object.entries(v as Record<string, unknown>)
    .map(([k, p]) => `${k}: ${String(p)}`)
    .join('; ');
}

/** The builder's `key: pattern; key: pattern` text as a mapping, or null when a pair has no key. */
function parseMapText(raw: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const t = part.trim();
    if (!t) continue;
    const at = t.indexOf(':');
    if (at <= 0) return null;
    out[t.slice(0, at).trim()] = t.slice(at + 1).trim();
  }
  return out;
}

function argsText(args: Record<string, unknown> | undefined): string {
  return Object.entries(args ?? {})
    .map(([k, v]) => `${k}=${argText(v)}`)
    .join(' ');
}

/** A kind as its icon and label, in the kind's color. */
export function KindTag({ kind }: { kind: CriterionKind }) {
  const k = KINDS[kind] ?? KINDS.prose;
  const Icon = k.icon;
  return (
    <span
      data-kind={kind}
      title={k.judge}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium"
      style={{
        color: k.color,
        background: `color-mix(in oklab, ${k.color} 12%, transparent)`,
      }}
    >
      <Icon size={11} />
      {k.label}
    </span>
  );
}

const RESULT_STYLE: Record<CriterionResult, { icon: LucideIcon; cls: string; label: string }> = {
  pass: { icon: CircleCheck, cls: 'text-ok bg-ok/10', label: 'pass' },
  fail: { icon: CircleX, cls: 'text-bad bg-bad/10', label: 'fail' },
  na: { icon: CircleMinus, cls: 'text-fg-3 bg-white/6', label: 'n/a' },
};

/** A result as a small colored pill. */
export function ResultBadge({ result }: { result: CriterionResult }) {
  const s = RESULT_STYLE[result] ?? RESULT_STYLE.na;
  const Icon = s.icon;
  return (
    <span
      data-result={result}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]',
        s.cls,
      )}
    >
      <Icon size={11} />
      {s.label}
    </span>
  );
}

/** What a criterion checks, by kind: its command, check and arguments, rubric or question. */
export function CriterionSpecView({ c }: { c: CriterionSpec }) {
  const desc = c.kind !== 'prose' && c.text ? <div className="text-fg-2">{c.text}</div> : null;
  const code = 'rounded bg-black/30 px-1.5 py-0.5 font-mono text-[12px] text-fg-2';
  switch (c.kind) {
    case 'prose':
      return <div className="text-fg-2">{c.text}</div>;
    case 'command':
      return (
        <div className="flex flex-col gap-1">
          {desc}
          <code className={cx(code, 'self-start break-all')}>{c.run}</code>
        </div>
      );
    case 'check':
      return (
        <div className="flex flex-col gap-1">
          {desc}
          <div className="flex flex-wrap items-center gap-1.5">
            <code className={code}>{c.check}</code>
            {Object.entries(c.args ?? {}).map(([k, v]) => (
              <span key={k} className="rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-fg-3">
                {k} <span className="font-mono text-fg-2">{argText(v)}</span>
              </span>
            ))}
          </div>
        </div>
      );
    case 'rubric':
      return (
        <div className="flex flex-col gap-1">
          {desc}
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-3">
            <code className={code}>{c.rubric}</code>
            {c.pass !== undefined && <span>passes at {c.pass}</span>}
          </div>
        </div>
      );
    case 'human':
      return (
        <div className="flex flex-col gap-1">
          {desc}
          <div className="text-fg-2 italic">{c.ask}</div>
        </div>
      );
    case 'map':
      return <div className="text-fg-2">{c.text ?? 'The project map covers the change'}</div>;
  }
}

/** Where a last result came from, in a sentence. */
const LAST_FROM: Record<string, string> = {
  verdict: 'the verdict',
  'criteria-check': 'Run checks',
  merge: 'the merge',
};

const EVENT_NAME: Record<string, string> = {
  verdict: 'verdict',
  'criteria-check': 'Run checks',
  merge: 'merge',
};

/** A result with its score, note and evidence, and who recorded it when. */
export function ResultDetail({
  r,
  who,
  links,
}: {
  r: CriterionVerdict;
  /** The event that recorded it, for the last result of a criterion. */
  who?: Pick<CriterionLast, 'actor' | 'at' | 'type' | 'by'>;
  /** Artifact paths in the evidence become links to the **Work** section. */
  links?: ArtifactLinks;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-fg-3">
        <ResultBadge result={r.result} />
        {r.score !== undefined && (
          <span data-score className="font-mono">
            score {r.score}
          </span>
        )}
        {who && (
          <>
            <span className="inline-flex items-center gap-1">
              by <Who id={who.actor} size="xs" plain />
            </span>
            <span title={new Date(who.at).toLocaleString()}>{ago(who.at)}</span>
            <span className="text-fg-4">
              · {who.by === 'judge' ? 'Judge' : (EVENT_NAME[who.type] ?? who.type)}
            </span>
          </>
        )}
      </div>
      {r.note && <div className="text-xs text-fg-2">{r.note}</div>}
      {r.evidence && (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-4 hover:text-fg-2">Evidence</summary>
          <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-3">
            {links ? (
              <EvidenceLinks text={r.evidence} paths={links.paths} onOpen={links.open} />
            ) : (
              r.evidence
            )}
          </pre>
        </details>
      )}
    </div>
  );
}

/**
 * The task panel's **Done when**: each criterion with its kind, spec and last result. While
 * **Run checks** runs, the criteria it runs show its progress and new results.
 */
export function CriteriaList({
  criteria,
  results,
  job: checkJob,
  judge,
  links,
}: {
  criteria: Criterion[];
  results?: Record<string, CriterionLast>;
  job?: CriteriaCheckJob | null;
  /** The **Judge** run under way or last ended, for the rubric criteria. */
  judge?: CriteriaCheckJob | null;
  /** The review's artifacts, which evidence that names them links to. */
  links?: ArtifactLinks;
}) {
  return (
    <ul data-criteria className="flex flex-col gap-2 text-sm">
      {criteria.map((c) => {
        const judged = Boolean(judge?.ids.includes(c.id));
        const job = judged ? judge : checkJob;
        const running = job && !job.endedAt ? job : null;
        const last = results?.[c.id];
        // A result of the run under way, or of one that ended after this read.
        const live = job?.results[c.id];
        const fresh =
          live && (!last || Date.parse(last.at) < Date.parse(job!.startedAt)) ? live : undefined;
        const waiting = running?.ids.includes(c.id) && !live;
        return (
          <li
            key={c.id}
            data-criterion={c.id}
            className="rounded-lg border border-white/7 bg-white/[0.02] px-3 py-2"
          >
            <div className="flex items-start gap-2">
              <KindTag kind={c.kind} />
              <span className="mt-0.5 font-mono text-[11px] text-fg-4">{c.id}</span>
              <div className="min-w-0 flex-1">
                <CriterionSpecView c={c} />
              </div>
              {c.when === 'publish' && (
                <span
                  data-when="publish"
                  title="Checked after swarmup published records the post, not at merge"
                  className="shrink-0 rounded-md bg-white/6 px-1.5 py-0.5 text-[11px] text-fg-3"
                >
                  after publish
                </span>
              )}
            </div>
            <div className="mt-1.5 pl-1" data-criterion-result>
              {waiting ? (
                <span className="inline-flex items-center gap-1.5 text-xs text-fg-3">
                  <Loader2 size={12} className="animate-spin text-signal" />
                  {running?.current === c.id ? 'running…' : 'queued'}
                </span>
              ) : fresh ? (
                <ResultDetail
                  r={fresh}
                  links={links}
                  who={{
                    actor: job!.by,
                    at: job!.startedAt,
                    type: 'criteria-check',
                    ...(judged ? { by: 'judge' } : {}),
                  }}
                />
              ) : last ? (
                <ResultDetail r={last} who={last} links={links} />
              ) : (
                <span className="text-xs text-fg-4">no result yet</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---- The builder --------------------------------------------------------------------------------

/** One row of the builder: every field as text, so the inputs stay controlled. */
export interface DraftCriterion {
  key: number;
  kind: CriterionKind;
  /** Empty: a position id (`c<n>`); prose without an id is saved as plain text. */
  id: string;
  text: string;
  run: string;
  check: string;
  args: Record<string, string>;
  /** Arguments the form has no field for, kept as they were. */
  extra: Record<string, unknown>;
  rubric: string;
  pass: string;
  ask: string;
  /** `publish`: checked after `swarmup published`; empty: at merge (W8). */
  when: string;
}

let draftSeq = 0;

export function newDraft(kind: CriterionKind = 'prose'): DraftCriterion {
  return {
    key: ++draftSeq,
    kind,
    id: '',
    text: '',
    run: '',
    check: kind === 'check' ? 'file-exists' : '',
    args: {},
    extra: {},
    rubric: '',
    pass: '',
    ask: '',
    when: '',
  };
}

/**
 * A criterion as a builder row. A prose criterion whose id is its position id stays plain text;
 * any other keeps its id, so reordering keeps its last result.
 */
export function draftOf(c: Criterion | CriterionSpec | string, i: number): DraftCriterion {
  const d = newDraft();
  if (typeof c === 'string') return { ...d, text: c };
  const fields = CHECKS[c.check ?? ''] ?? [];
  const args: Record<string, string> = {};
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c.args ?? {})) {
    const f = fields.find((x) => x.key === k);
    if (f) args[k] = f.type === 'map' ? mapText(v) : argText(v);
    else extra[k] = v;
  }
  const plainProse = c.kind === 'prose' && (!c.id || c.id === `c${i + 1}`);
  return {
    ...d,
    kind: c.kind,
    id: plainProse ? '' : (c.id ?? ''),
    text: c.text ?? '',
    run: c.run ?? '',
    check: c.check ?? (c.kind === 'check' ? 'file-exists' : ''),
    args,
    extra,
    rubric: c.rubric ?? '',
    pass: c.pass !== undefined ? String(c.pass) : '',
    ask: c.ask ?? '',
    when: c.when ?? '',
  };
}

function argValue(f: ArgField, raw: string): unknown {
  const s = raw.trim();
  if (!s) return undefined;
  switch (f.type) {
    case 'number':
      return Number(s);
    case 'bool':
      return s === 'true';
    case 'map': {
      const m = parseMapText(s);
      return m && Object.keys(m).length > 0 ? m : undefined;
    }
    case 'list': {
      const parts = s
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      return parts.length > 1 ? parts : parts[0];
    }
    default:
      return s;
  }
}

/** A builder row as a `done_when` entry: plain text for prose without an id, else typed. */
export function entryOf(d: DraftCriterion): string | CriterionSpec {
  const text = d.text.trim();
  const id = d.id.trim();
  if (d.kind === 'prose' && !id) return text;
  const out: CriterionSpec = { ...(id ? { id } : {}), kind: d.kind };
  if (text) out.text = text;
  if (d.when === 'publish') out.when = 'publish';
  switch (d.kind) {
    case 'command':
      out.run = d.run.trim();
      break;
    case 'check': {
      out.check = d.check;
      const args: Record<string, unknown> = { ...d.extra };
      for (const f of CHECKS[d.check] ?? []) {
        const v = argValue(f, d.args[f.key] ?? '');
        if (v !== undefined) args[f.key] = v;
      }
      out.args = args;
      break;
    }
    case 'rubric':
      out.rubric = d.rubric.trim();
      if (d.pass.trim()) out.pass = Number(d.pass);
      break;
    case 'human':
      out.ask = d.ask.trim();
      break;
  }
  return out;
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** What keeps a row from saving, or null. swarmupd checks the same again. */
export function draftProblem(d: DraftCriterion): string | null {
  const id = d.id.trim();
  if (id && !ID_RE.test(id)) return 'An id is a letter, then letters, digits, - or _';
  switch (d.kind) {
    case 'prose':
      return d.text.trim() ? null : 'Write the check';
    case 'command':
      return d.run.trim() ? null : 'Write the command';
    case 'check': {
      if (!CHECKS[d.check]) return 'Pick a check';
      for (const f of CHECKS[d.check]!) {
        const raw = (d.args[f.key] ?? '').trim();
        if (f.required && !raw) return `${f.label} is required`;
        if (f.type === 'number' && raw && !(Number(raw) >= 0)) return `${f.label} is a number`;
        if (f.type === 'map' && raw && !parseMapText(raw)) {
          return `${f.label}: write key: pattern pairs, separated by ;`;
        }
      }
      if (
        (d.check === 'word-count' || d.check === 'char-count') &&
        !d.args.min?.trim() &&
        !d.args.max?.trim()
      ) {
        return 'Set Min or Max';
      }
      if (d.check === 'front-matter' && !d.args.keys?.trim() && !d.args.match?.trim()) {
        return 'Set Keys or Match';
      }
      return null;
    }
    case 'rubric': {
      if (!d.rubric.trim()) return 'Name the rubric file';
      const p = d.pass.trim();
      if (p && !(Number(p) >= 0 && Number(p) <= 1)) return 'Passes at is a number from 0 to 1';
      return null;
    }
    case 'human':
      return d.ask.trim() ? null : 'Write the question';
    case 'map':
      return null;
  }
}

/** Problems of a whole list: each row's, and two rows with one id. */
export function draftsProblem(list: DraftCriterion[]): string | null {
  const seen = new Set<string>();
  for (const [i, d] of list.entries()) {
    const p = draftProblem(d);
    if (p) return `Criterion ${i + 1}: ${p}`;
    const id = d.id.trim() || `c${i + 1}`;
    if (seen.has(id)) return `Two criteria have the id ${id}`;
    seen.add(id);
  }
  return null;
}

/** Whether a list holds a criterion beyond prose, as `swarmup new` checks. */
export function hasCheckable(list: DraftCriterion[]): boolean {
  return list.some((d) => d.kind !== 'prose');
}

const KIND_OPTIONS: Array<[string, string]> = KIND_ORDER.map((k) => [k, KINDS[k].label]);

/**
 * The criteria builder: a row per criterion with its kind and the fields that kind takes, moved
 * up or down or removed, and a button per kind to add one. Prose without an id is plain text.
 */
export function CriteriaEditor({
  value,
  onChange,
}: {
  value: DraftCriterion[];
  onChange: (next: DraftCriterion[]) => void;
}) {
  const set = (i: number, patch: Partial<DraftCriterion>): void =>
    onChange(value.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, by: -1 | 1): void => {
    const next = [...value];
    const [d] = next.splice(i, 1);
    next.splice(i + by, 0, d!);
    onChange(next);
  };
  return (
    <div data-criteria-editor className="flex flex-col gap-2">
      {value.map((d, i) => (
        <DraftRow
          key={d.key}
          d={d}
          i={i}
          last={i === value.length - 1}
          onSet={(p) => set(i, p)}
          onMove={(by) => move(i, by)}
          onRemove={() => onChange(value.filter((_, j) => j !== i))}
        />
      ))}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-fg-4">Add</span>
        {KIND_ORDER.map((k) => {
          const Icon = KINDS[k].icon;
          return (
            <button
              key={k}
              type="button"
              data-add-kind={k}
              title={KINDS[k].judge}
              onClick={() => onChange([...value, newDraft(k)])}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-white/5 px-2 text-xs text-fg-3 ring-1 ring-white/8 ring-inset transition hover:bg-white/10 hover:text-fg"
            >
              <Plus size={11} />
              <Icon size={12} style={{ color: KINDS[k].color }} />
              {KINDS[k].label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DraftRow({
  d,
  i,
  last,
  onSet,
  onMove,
  onRemove,
}: {
  d: DraftCriterion;
  i: number;
  last: boolean;
  onSet: (patch: Partial<DraftCriterion>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const problem = draftProblem(d);
  const plain = d.kind === 'prose' && !d.id.trim();
  const icon = 'rounded-md p-1 text-fg-4 hover:bg-white/8 hover:text-fg disabled:opacity-30';
  return (
    <div
      data-draft={i}
      className="rounded-lg border border-white/8 bg-white/[0.02] p-2.5"
      style={{ borderLeft: `2px solid ${KINDS[d.kind].color}` }}
    >
      <div className="flex items-center gap-2">
        <span className="w-4 text-right font-mono text-[11px] text-fg-4">{i + 1}</span>
        <Select
          value={d.kind}
          onChange={(k) => {
            const kind = k as CriterionKind;
            onSet({ kind, check: kind === 'check' && !d.check ? 'file-exists' : d.check });
          }}
          options={KIND_OPTIONS}
          className="w-32"
        />
        <Input
          value={d.id}
          onChange={(id) => onSet({ id })}
          placeholder={`c${i + 1}`}
          className="w-28 font-mono"
        />
        {plain && (
          <span
            data-plain
            className="text-[11px] text-fg-4"
            title="Saved as plain text with a position id. Give it an id, or pick another kind, to make it typed."
          >
            plain text
          </span>
        )}
        <div className="ml-auto flex items-center">
          <button
            type="button"
            className={icon}
            disabled={i === 0}
            onClick={() => onMove(-1)}
            aria-label="Move up"
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            className={icon}
            disabled={last}
            onClick={() => onMove(1)}
            aria-label="Move down"
          >
            <ArrowDown size={14} />
          </button>
          <button
            type="button"
            className={cx(icon, 'hover:text-bad')}
            onClick={onRemove}
            aria-label="Remove criterion"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-2 pl-6">
        <KindFields d={d} onSet={onSet} />
        {(d.kind === 'check' || d.kind === 'command') && (
          <Select
            value={d.when}
            onChange={(when) => onSet({ when })}
            options={[
              ['', 'Checked at merge'],
              ['publish', 'Checked after publish'],
            ]}
            className="w-48"
          />
        )}
        {d.kind !== 'prose' && (
          <Input
            value={d.text}
            onChange={(text) => onSet({ text })}
            placeholder="Description (optional)"
          />
        )}
        {problem && <span className="text-[11px] text-warn">{problem}</span>}
      </div>
    </div>
  );
}

function KindFields({
  d,
  onSet,
}: {
  d: DraftCriterion;
  onSet: (patch: Partial<DraftCriterion>) => void;
}) {
  switch (d.kind) {
    case 'prose':
      return (
        <Input
          value={d.text}
          onChange={(text) => onSet({ text })}
          placeholder="What someone checks, such as: the intro names the new price"
        />
      );
    case 'command':
      return (
        <Input
          value={d.run}
          onChange={(run) => onSet({ run })}
          placeholder="pnpm test -- --changed main"
          className="font-mono"
        />
      );
    case 'check':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={d.check}
            onChange={(check) => onSet({ check })}
            options={CHECK_NAMES.map((n) => [n, n])}
            className="w-36 font-mono"
          />
          {(CHECKS[d.check] ?? []).map((f) =>
            f.type === 'bool' || f.type === 'select' ? (
              <Select
                key={f.key}
                value={d.args[f.key] ?? ''}
                onChange={(v) => onSet({ args: { ...d.args, [f.key]: v } })}
                options={f.choices ?? []}
                className="w-40"
              />
            ) : (
              <label key={f.key} className="flex items-center gap-1.5 text-xs text-fg-3">
                {f.label}
                <Input
                  value={d.args[f.key] ?? ''}
                  onChange={(v) => onSet({ args: { ...d.args, [f.key]: v } })}
                  placeholder={f.placeholder}
                  className={cx(
                    'font-mono',
                    f.type === 'number' ? 'w-20' : f.type === 'map' ? 'w-64' : 'w-44',
                  )}
                />
              </label>
            ),
          )}
        </div>
      );
    case 'rubric':
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={d.rubric}
            onChange={(rubric) => onSet({ rubric })}
            placeholder="rubrics/brand-voice.md"
            className="w-64 font-mono"
          />
          <label className="flex items-center gap-1.5 text-xs text-fg-3">
            Passes at
            <Input
              value={d.pass}
              onChange={(pass) => onSet({ pass })}
              placeholder="0.8"
              className="w-20 font-mono"
            />
          </label>
        </div>
      );
    case 'human':
      return (
        <Input
          value={d.ask}
          onChange={(ask) => onSet({ ask })}
          placeholder="Does the intro make the pricing change clear?"
        />
      );
    case 'map':
      return (
        <span className="text-xs text-fg-4">
          The project map covers the change (`swarmup map check`).
        </span>
      );
  }
}

/**
 * **Edit** on **Done when**: the builder over the task's criteria, saved as a `criteria` event
 * (`swarmup criteria ID --set-file`). swarmupd applies the CLI's permission rules; its refusal
 * shows under the form.
 */
export function CriteriaForm({
  task,
  me,
  criteria,
  onSaved,
  onCancel,
}: {
  task: string;
  me: string | null;
  criteria: Criterion[];
  onSaved: (res: unknown) => void;
  onCancel: () => void;
}) {
  const [list, setList] = useState<DraftCriterion[]>(() =>
    criteria.length > 0 ? criteria.map(draftOf) : [newDraft()],
  );
  const act = useAction();
  const problem = list.length === 0 ? 'Add at least one criterion' : draftsProblem(list);
  const save = (): void =>
    act.run(async () => {
      const res = await api('POST', `/api/tasks/${q(task)}/criteria`, {
        as: me,
        done_when: list.map(entryOf),
      });
      onSaved(res);
    });
  return (
    <div data-criteria-form className="panel animate-rise flex flex-col gap-3 p-3">
      <CriteriaEditor value={list} onChange={setList} />
      <p className="text-[11px] leading-snug text-fg-4">
        Saving writes a <code>criteria</code> event with the whole list. A criterion you change or
        remove loses its last result.
      </p>
      <ErrorLine error={act.error} />
      <div className="flex items-center gap-2">
        <Button
          kind="primary"
          size="sm"
          disabled={problem !== null || act.busy}
          title={problem ?? undefined}
          onClick={save}
        >
          Save criteria
        </Button>
        <Button kind="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {problem && <span className="text-xs text-warn">{problem}</span>}
      </div>
    </div>
  );
}

// ---- Run checks ---------------------------------------------------------------------------------

/** How often the app reads a running check run. */
const POLL_MS = 1000;

/**
 * The task's **Run checks**: reads the running or last run once, starts one with `start`, and
 * reads it every second while it runs. `onEnded` runs once when a run this hook watched ends.
 */
export function useCriteriaCheck(
  task: string,
  onEnded: () => void,
  /** `criteria-judge` reads and starts the task's **Judge** instead. */
  action: 'criteria-check' | 'criteria-judge' = 'criteria-check',
): {
  job: CriteriaCheckJob | null;
  running: boolean;
  error: string | null;
  start: (me: string | null) => void;
} {
  const [job, setJob] = useState<CriteriaCheckJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  const live = useRef(true);
  const path = `/api/tasks/${q(task)}/${action}`;
  const watch = useCallback(
    (j: CriteriaCheckJob | null, wasRunning: boolean): void => {
      if (!live.current) return;
      setJob(j);
      if (j && !j.endedAt) {
        timer.current = setTimeout(() => {
          api<{ job: CriteriaCheckJob | null }>('GET', path).then(
            (r) => watch(r.job, true),
            (e: Error) => live.current && setError(e.message),
          );
        }, POLL_MS);
      } else if (wasRunning) ended.current();
    },
    [path],
  );
  useEffect(() => {
    live.current = true;
    api<{ job: CriteriaCheckJob | null } | undefined>('GET', path).then(
      (r) => watch(r?.job ?? null, false),
      () => undefined,
    );
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, [path, watch]);
  const start = (me: string | null): void => {
    setError(null);
    api<{ job: CriteriaCheckJob }>('POST', path, { as: me }).then(
      (r) => watch(r.job, true),
      (e: Error) => live.current && setError(e.message),
    );
  };
  return { job, running: Boolean(job && !job.endedAt), error, start };
}

/** The **Run checks** button with the run's progress next to it. */
export function RunChecksButton({
  check,
  me,
  count,
}: {
  check: ReturnType<typeof useCriteriaCheck>;
  me: string | null;
  /** How many command and check criteria the task has. */
  count: number;
}) {
  const { job, running } = check;
  const done = job ? job.ids.filter((id) => job.results[id]).length : 0;
  const failed = job ? job.ids.filter((id) => job.results[id]?.result === 'fail').length : 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        icon={running ? Loader2 : FlaskConical}
        disabled={running || count === 0}
        title={
          count === 0
            ? 'This task has no command or check criteria'
            : 'Runs the command and check criteria in the task worktree, as swarmup criteria check does'
        }
        onClick={() => check.start(me)}
      >
        {running ? 'Running checks' : 'Run checks'}
      </Button>
      {job && (
        <span data-check-progress className="text-xs text-fg-3">
          {running
            ? `${done} of ${job.ids.length} done`
            : job.error
              ? null
              : failed > 0
                ? `${failed} of ${job.ids.length} failed`
                : `${job.ids.length} passed`}
          {job.endedAt && !job.error && <span className="text-fg-4"> · {ago(job.endedAt)}</span>}
        </span>
      )}
      {job?.error && <ErrorLine error={job.error} />}
      <ErrorLine error={check.error} />
    </div>
  );
}

/**
 * The **Judge** button, next to **Run checks**: an LLM judge scores the rubric criteria against
 * the task branch's diff, as `swarmup criteria judge` does. It spends tokens.
 */
export function JudgeButton({
  judge,
  me,
  count,
}: {
  judge: ReturnType<typeof useCriteriaCheck>;
  me: string | null;
  /** How many rubric criteria the task has. */
  count: number;
}) {
  const { job, running } = judge;
  const done = job ? job.ids.filter((id) => job.results[id]).length : 0;
  const failed = job ? job.ids.filter((id) => job.results[id]?.result === 'fail').length : 0;
  const cost = typeof job?.costUsd === 'number' ? ` · $${job.costUsd.toFixed(4)}` : '';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        icon={running ? Loader2 : Gavel}
        disabled={running || count === 0}
        title={
          count === 0
            ? 'This task has no rubric criteria'
            : 'An LLM judge scores the rubric criteria against the task branch, as swarmup criteria judge does; it spends tokens'
        }
        onClick={() => judge.start(me)}
      >
        {running ? 'Judging' : 'Judge'}
      </Button>
      {job && (
        <span data-judge-progress className="text-xs text-fg-3">
          {running
            ? `${done} of ${job.ids.length} judged`
            : job.error
              ? null
              : failed > 0
                ? `${failed} of ${job.ids.length} below the pass mark${cost}`
                : `${job.ids.length} passed${cost}`}
          {job.endedAt && !job.error && <span className="text-fg-4"> · {ago(job.endedAt)}</span>}
        </span>
      )}
      {job?.error && <ErrorLine error={job.error} />}
      <ErrorLine error={judge.error} />
    </div>
  );
}

// ---- Review -------------------------------------------------------------------------------------

/** A reviewer's mark on one criterion while the form is open. */
export interface ReviewMark {
  result?: CriterionResult;
  note: string;
  score: string;
}

export type ReviewMarks = Record<string, ReviewMark>;

/** The verdict's `criteria` map: each marked criterion's result, note and score. */
export function verdictCriteria(marks: ReviewMarks): Record<string, CriterionVerdict> | undefined {
  const out: Record<string, CriterionVerdict> = {};
  for (const [id, m] of Object.entries(marks)) {
    if (!m.result) continue;
    const score = m.score.trim() === '' ? undefined : Number(m.score);
    out[id] = {
      result: m.result,
      ...(m.note.trim() ? { note: m.note.trim() } : {}),
      ...(score !== undefined && Number.isFinite(score) ? { score } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The ids marked fail, which block **Approve** unless the person confirms. */
export function failedIds(marks: ReviewMarks): string[] {
  return Object.entries(marks)
    .filter(([, m]) => m.result === 'fail')
    .map(([id]) => id);
}

/**
 * Pass, fail or n/a per criterion, with a note (and a score for a rubric). The command, check
 * and map criteria show their last result: the checks judge them, so a reviewer usually leaves
 * them unmarked.
 */
export function CriteriaReview({
  criteria,
  results,
  value,
  onChange,
}: {
  criteria: Criterion[];
  results?: Record<string, CriterionLast>;
  value: ReviewMarks;
  onChange: (next: ReviewMarks) => void;
}) {
  const set = (id: string, patch: Partial<ReviewMark>): void => {
    const cur = value[id] ?? { note: '', score: '' };
    onChange({ ...value, [id]: { ...cur, ...patch } });
  };
  return (
    <ul data-criteria-review className="flex flex-col gap-1.5">
      {criteria.map((c) => {
        const m = value[c.id];
        const last = results?.[c.id];
        const checked = !JUDGED_KINDS.has(c.kind);
        return (
          <li
            key={c.id}
            data-review-criterion={c.id}
            className="rounded-lg border border-white/7 bg-white/[0.02] px-2.5 py-2"
          >
            <div className="flex items-center gap-2">
              <KindTag kind={c.kind} />
              <span className="font-mono text-[11px] text-fg-4">{c.id}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg-2" title={criterionLine(c)}>
                {criterionLine(c)}
              </span>
              <div role="group" aria-label={`Result of ${c.id}`} className="flex gap-0.5">
                {(['pass', 'fail', 'na'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={m?.result === r}
                    data-mark={r}
                    onClick={() => set(c.id, { result: m?.result === r ? undefined : r })}
                    className={cx(
                      'h-6 rounded-md px-2 font-mono text-[11px] transition',
                      m?.result === r
                        ? RESULT_STYLE[r].cls
                        : 'bg-white/4 text-fg-4 hover:bg-white/8',
                      m?.result === r && 'ring-1 ring-white/15 ring-inset',
                    )}
                  >
                    {RESULT_STYLE[r].label}
                  </button>
                ))}
              </div>
            </div>
            {checked && (
              <div className="mt-1 flex items-center gap-2 pl-1 text-[11px] text-fg-4">
                {last ? <ResultBadge result={last.result} /> : null}
                <span>
                  {last ? `last result from ${LAST_FROM[last.type] ?? last.type}` : 'no result yet'}
                  ; the checks judge this one
                </span>
              </div>
            )}
            {m?.result && (
              <div className="mt-1.5 flex gap-2">
                <Input
                  value={m.note}
                  onChange={(note) => set(c.id, { note })}
                  placeholder={m.result === 'fail' ? 'What is missing' : 'Note (optional)'}
                  className="h-7 flex-1 text-xs"
                />
                {c.kind === 'rubric' && (
                  <Input
                    value={m.score}
                    onChange={(score) => set(c.id, { score })}
                    placeholder={c.pass !== undefined ? `score (≥ ${c.pass})` : 'score'}
                    className="h-7 w-28 font-mono text-xs"
                  />
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The confirmation an approval with a failed criterion needs, as `swarmup verdict --force`:
 * approving records the failure and closes the task anyway.
 */
export function ForceApprove({
  failed,
  onConfirm,
  onCancel,
}: {
  failed: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Approve with failed criteria?"
      className="flex flex-wrap items-center gap-3 rounded-xl bg-warn/10 px-3 py-2 text-sm text-warn ring-1 ring-warn/30 ring-inset"
    >
      <span className="min-w-0 flex-1">
        You marked {failed.join(', ')} fail. Approve anyway? The verdict records it as forced.
      </span>
      <Button size="sm" kind="ghost" onClick={onCancel}>
        Keep reviewing
      </Button>
      <Button size="sm" kind="danger" onClick={onConfirm}>
        Approve anyway
      </Button>
    </div>
  );
}

/** The per-criterion results an event carries: a verdict, a check run or a merge. */
export function EventCriteria({ results }: { results: Record<string, CriterionVerdict> }) {
  return (
    <ul data-event-criteria className="mt-1.5 flex flex-col gap-1">
      {Object.entries(results).map(([id, r]) => (
        <li key={id} data-event-criterion={id} className="flex items-start gap-2 text-xs">
          <span className="mt-0.5 w-16 shrink-0 truncate font-mono text-[11px] text-fg-4">
            {id}
          </span>
          <div className="min-w-0 flex-1">
            <ResultDetail r={r} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The new list a `criteria` event sets. */
export function EventDoneWhen({ list }: { list: Array<string | CriterionSpec> }) {
  return (
    <ol data-event-done-when className="mt-1.5 flex flex-col gap-1 text-xs">
      {list.map((c, i) => {
        const kind = typeof c === 'string' ? 'prose' : c.kind;
        const id = typeof c === 'string' ? `c${i + 1}` : (c.id ?? `c${i + 1}`);
        return (
          <li key={id} className="flex items-center gap-2">
            <KindTag kind={kind} />
            <span className="font-mono text-[11px] text-fg-4">{id}</span>
            <span className="min-w-0 flex-1 truncate text-fg-2">{criterionLine(c)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The `notes` a swarmupd write carries: soft checks, such as a judged criterion left unmarked. */
export function notesOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const n = (data as { notes?: unknown }).notes;
  return Array.isArray(n) ? n.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/**
 * The per-criterion review of a task the view has not read, such as an inbox review item: reads
 * the task's criteria and their last results, then shows {@link CriteriaReview}.
 */
export function ReviewCriteriaOf({
  task,
  value,
  onChange,
}: {
  task: string;
  value: ReviewMarks;
  onChange: (next: ReviewMarks) => void;
}) {
  const { data, error } = useData<TaskDetail>(`/api/tasks/${q(task)}`);
  if (error) return <ErrorLine error={error} />;
  if (!data) return <span className="text-xs text-fg-4">Reading the criteria…</span>;
  if (!data.criteria?.length) {
    return <span className="text-xs text-fg-4">This task has no criteria.</span>;
  }
  return (
    <CriteriaReview
      criteria={data.criteria}
      results={data.criteriaResults}
      value={value}
      onChange={onChange}
    />
  );
}
