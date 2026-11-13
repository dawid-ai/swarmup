import { ChevronDown, ChevronRight, Columns2, GitCommitHorizontal, Rows2, X } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api, q } from '../api';
import { cx, ErrorLine } from '../components';
import type { DiffLine, Hunk, Lang } from '../lib/diff';
import { highlight, languageOf, parsePatch, splitRows } from '../lib/diff';
import { ago } from '../lib/format';
import type { DiffFile, TaskDiff } from '../types';

type Mode = 'unified' | 'split';

const MODE_KEY = 'swarmup.diff.mode';

/** A file with more patch lines than this opens folded, so a large diff still opens fast. */
const FOLD_LINES = 1500;

function savedMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === 'unified' ? 'unified' : 'split';
  } catch {
    return 'split';
  }
}

const STATUS_MARK: Record<DiffFile['status'], { letter: string; color: string; label: string }> = {
  added: { letter: 'A', color: 'var(--color-ok)', label: 'added' },
  deleted: { letter: 'D', color: 'var(--color-bad)', label: 'deleted' },
  modified: { letter: 'M', color: 'var(--color-info)', label: 'modified' },
  renamed: { letter: 'R', color: 'var(--color-review)', label: 'renamed' },
  copied: { letter: 'C', color: 'var(--color-review)', label: 'copied' },
  type: { letter: 'T', color: 'var(--color-warn)', label: 'type changed' },
};

const short = (sha: string): string => sha.slice(0, 7);

/** What the diff compares, in a few words. */
export function diffTitle(d: TaskDiff): string {
  const src = d.source.branch ?? (d.source.commit ? short(d.source.commit) : short(d.to));
  if (d.merged) return `${src}, merged into ${d.base} as ${short(d.to)}`;
  return `${src} at ${short(d.to)}, against ${d.base}`;
}

/**
 * The diff of the commits a task's review names (AO-0106), over the whole window: the files on
 * the left, each file's changes on the right, side by side or unified. Read-only. Escape and the
 * close button close it and leave the task panel open.
 */
export function DiffDialog({ task, onClose }: { task: string; onClose: () => void }) {
  const [data, setData] = useState<TaskDiff>();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(savedMode);
  const [showCommits, setShowCommits] = useState(false);
  const pane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    api<TaskDiff>('GET', `/api/tasks/${q(task)}/diff`).then(
      (d) => live && setData(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [task]);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    // Capture on window runs before the task panel's own Escape handler.
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  const pick = (m: Mode): void => {
    setMode(m);
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      // No storage: the choice lasts for this dialog.
    }
  };
  const added = data?.files.reduce((n, f) => n + f.added, 0) ?? 0;
  const deleted = data?.files.reduce((n, f) => n + f.deleted, 0) ?? 0;
  const jump = (i: number): void => {
    pane.current?.querySelector(`[data-file="${i}"]`)?.scrollIntoView({ block: 'start' });
  };

  return (
    <div
      role="dialog"
      aria-label={`Changes of ${task}`}
      data-testid="diff-dialog"
      className="animate-fade fixed inset-0 z-40 flex flex-col bg-ink-900"
      // The task panel closes on a mousedown outside it; this dialog is not outside.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/7 px-5 py-3">
        <div className="min-w-0">
          <div className="font-display text-lg leading-tight font-semibold tracking-wide">
            Changes of <span className="font-mono text-base">{task.split('/').pop()}</span>
          </div>
          {data && (
            <div className="mt-0.5 truncate font-mono text-xs text-fg-3" data-testid="diff-range">
              {diffTitle(data)}
            </div>
          )}
        </div>
        {data && (
          <div className="flex items-center gap-3 text-xs text-fg-3">
            <span>
              {data.files.length} {data.files.length === 1 ? 'file' : 'files'}
            </span>
            <Counts added={added} deleted={deleted} />
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:text-fg"
              onClick={() => setShowCommits((s) => !s)}
              aria-expanded={showCommits}
            >
              <GitCommitHorizontal size={13} />
              {data.commits.length} {data.commits.length === 1 ? 'commit' : 'commits'}
              {showCommits ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          <div
            className="flex rounded-lg bg-white/5 p-0.5 text-xs"
            role="group"
            aria-label="Layout"
          >
            {(
              [
                ['split', 'Side by side', Columns2],
                ['unified', 'Unified', Rows2],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => pick(m)}
                className={cx(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 transition',
                  mode === m ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                )}
              >
                <Icon size={13} /> {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rounded-md p-1 text-fg-3 hover:bg-white/8 hover:text-fg"
            onClick={onClose}
            aria-label="Close changes"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      {data && showCommits && (
        <ol className="max-h-48 overflow-auto border-b border-white/7 px-5 py-2 text-xs">
          {data.commits.map((c) => (
            <li key={c.sha} className="flex items-baseline gap-3 py-0.5">
              <span className="font-mono text-fg-4">{short(c.sha)}</span>
              <span className="min-w-0 flex-1 truncate text-fg-2">{c.subject}</span>
              <span className="text-fg-4">
                {c.author}, {ago(c.at)}
              </span>
            </li>
          ))}
        </ol>
      )}

      <div className="flex min-h-0 flex-1">
        {data && data.files.length > 0 && (
          <nav
            aria-label="Changed files"
            className="w-72 shrink-0 overflow-auto border-r border-white/7 py-2"
          >
            {data.files.map((f, i) => (
              <button
                key={f.path}
                type="button"
                onClick={() => jump(i)}
                title={f.old ? `${f.old} → ${f.path}` : f.path}
                className="flex w-full items-center gap-2 px-4 py-1 text-left text-xs hover:bg-white/5"
              >
                <StatusMark status={f.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-fg-2" dir="rtl">
                  {/* Right-to-left clips the folders, not the file name; the mark keeps the path's own order. */}
                  &lrm;{f.path}
                </span>
                <Counts added={f.added} deleted={f.deleted} />
              </button>
            ))}
          </nav>
        )}
        <div ref={pane} className="min-w-0 flex-1 overflow-auto px-5 py-4">
          <ErrorLine error={error} />
          {!data && !error && <div className="text-sm text-fg-4">Reads the diff…</div>}
          {data?.note && (
            <div className="mb-3 rounded-lg border border-warn/20 bg-warn/[0.05] px-3 py-2 text-xs text-warn">
              {data.note}
            </div>
          )}
          {data && data.files.length === 0 && (
            <div className="text-sm text-fg-3">No file differs between these commits.</div>
          )}
          {data?.files.map((f, i) => (
            <FileDiff key={f.path} file={f} index={i} mode={mode} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Counts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      <span className="text-ok">+{added}</span> <span className="text-bad">−{deleted}</span>
    </span>
  );
}

function StatusMark({ status }: { status: DiffFile['status'] }) {
  const s = STATUS_MARK[status];
  return (
    <span
      className="w-3 shrink-0 text-center font-mono text-[11px] font-semibold"
      style={{ color: s.color }}
      title={s.label}
    >
      {s.letter}
    </span>
  );
}

/** One file: its path and counts, and its hunks unless folded. Parses only what it shows. */
const FileDiff = memo(function FileDiff({
  file: f,
  index,
  mode,
}: {
  file: DiffFile;
  index: number;
  mode: Mode;
}) {
  const hunks = useMemo(() => (f.patch ? parsePatch(f.patch) : []), [f.patch]);
  const lines = hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lines <= FOLD_LINES);
  const lang = useMemo(() => languageOf(f.path), [f.path]);
  const why = f.binary
    ? 'Binary file: no text to compare.'
    : f.omitted === 'file'
      ? 'This file’s diff is too large to show here.'
      : f.omitted === 'total'
        ? 'Left out: the diff of the files before it is already large.'
        : hunks.length === 0
          ? f.status === 'renamed' || f.status === 'copied'
            ? 'No change in its text.'
            : 'No text change, such as a file mode change or an empty file.'
          : null;
  return (
    <section
      data-file={index}
      className="mb-4 scroll-mt-2 overflow-hidden rounded-xl border border-white/8"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-white/[0.04] px-3 py-2 text-left text-xs hover:bg-white/[0.06]"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <StatusMark status={f.status} />
        <span className="min-w-0 flex-1 font-mono break-all text-fg">
          {f.old && <span className="text-fg-3">{f.old} → </span>}
          {f.path}
        </span>
        {!open && lines > FOLD_LINES && <span className="text-fg-4">{lines} lines, folded</span>}
        <Counts added={f.added} deleted={f.deleted} />
      </button>
      {open &&
        (why ? (
          <div className="px-3 py-2 text-xs text-fg-4">{why}</div>
        ) : (
          <table className={cx('diff', mode === 'split' && 'diff-split')}>
            {mode === 'split' ? (
              <colgroup>
                <col className="diff-n" />
                <col />
                <col className="diff-n" />
                <col />
              </colgroup>
            ) : (
              <colgroup>
                <col className="diff-n" />
                <col className="diff-n" />
                <col />
              </colgroup>
            )}
            <tbody>
              {hunks.map((h, i) =>
                mode === 'split' ? (
                  <SplitHunk key={i} hunk={h} lang={lang} />
                ) : (
                  <UnifiedHunk key={i} hunk={h} lang={lang} />
                ),
              )}
            </tbody>
          </table>
        ))}
    </section>
  );
});

function HunkHeader({ header, span }: { header: string; span: number }) {
  return (
    <tr className="diff-hunk">
      <td colSpan={span}>{header}</td>
    </tr>
  );
}

function Code({ line, lang }: { line: DiffLine; lang: Lang | null }) {
  return (
    <>
      {highlight(line.text, lang).map((t, i) =>
        t.kind === 'plain' ? (
          t.text
        ) : (
          <span key={i} className={`tok-${t.kind}`}>
            {t.text}
          </span>
        ),
      )}
      {line.noEol && <span className="diff-noeol" title="No line break at the end of the file" />}
    </>
  );
}

function UnifiedHunk({ hunk, lang }: { hunk: Hunk; lang: Lang | null }) {
  return (
    <>
      <HunkHeader header={hunk.header} span={3} />
      {hunk.lines.map((l, i) => (
        <tr key={i} className={`diff-${l.kind}`}>
          <td className="diff-num">{l.old}</td>
          <td className="diff-num">{l.new}</td>
          <td
            className="diff-code"
            data-sign={l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}
          >
            <Code line={l} lang={lang} />
          </td>
        </tr>
      ))}
    </>
  );
}

function SplitHunk({ hunk, lang }: { hunk: Hunk; lang: Lang | null }) {
  const side = (l: DiffLine | undefined, which: 'old' | 'new') =>
    l ? (
      <>
        <td className={`diff-num diff-${l.kind}`}>{l[which]}</td>
        <td className={`diff-code diff-${l.kind}`}>
          <Code line={l} lang={lang} />
        </td>
      </>
    ) : (
      <>
        <td className="diff-num diff-none" />
        <td className="diff-code diff-none" />
      </>
    );
  return (
    <>
      <HunkHeader header={hunk.header} span={4} />
      {splitRows(hunk.lines).map((r, i) => (
        <tr key={i}>
          {side(r.left, 'old')}
          {side(r.right, 'new')}
        </tr>
      ))}
    </>
  );
}
