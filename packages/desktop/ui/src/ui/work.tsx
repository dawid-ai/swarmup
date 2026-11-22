// The task panel's **Work** (W8): the artifacts the latest review names, read at the reviewed
// commit. Markdown renders as it reads, with a word-level diff against the base on **Changes**;
// images show inline; URLs and documents open in the browser. Criterion evidence that names an
// artifact's path links here.
import type { LucideIcon } from 'lucide-react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Link2,
  Loader2,
  Newspaper,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, q } from '../api';
import { cx, ErrorLine } from '../components';
import type { OpsEvent, ReviewArtifact, TaskArtifact } from '../types';
import { ProseDiff } from './diff';
import { Markdown } from './markdown';

/** A request to open one artifact; a new `n` asks again for the same path. */
export interface ArtifactFocus {
  path: string;
  n: number;
}

/** The latest review that names artifacts, else none: the work the reviewer read. */
export function reviewWithArtifacts(events: readonly OpsEvent[]): OpsEvent | undefined {
  return [...events].reverse().find((e) => e.type === 'review' && (e.artifacts?.length ?? 0) > 0);
}

const KIND_ICON: Record<ReviewArtifact['kind'], LucideIcon> = {
  file: FileText,
  image: ImageIcon,
  url: Link2,
  doc: Newspaper,
};

const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);

/** Front matter split off a Markdown file: it shows as fields, not as a rule and a paragraph. */
function splitFrontMatter(text: string): { front: string | null; body: string } {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { front: null, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { front: null, body: src };
  const after = src.indexOf('\n', end + 4);
  return { front: src.slice(4, end), body: after < 0 ? '' : src.slice(after + 1) };
}

/** The anchor id of an artifact row, so evidence links can scroll to it. */
export function artifactAnchor(path: string): string {
  return `artifact-${path.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * Text with each artifact path it names as a button that opens the artifact in **Work**: for a
 * criterion's evidence, such as `posts/x.md: 2 of 7 blocks out of range`.
 */
export function EvidenceLinks({
  text,
  paths,
  onOpen,
}: {
  text: string;
  paths: readonly string[];
  onOpen: (path: string) => void;
}) {
  const parts = useMemo(() => {
    const known = [...new Set(paths)].filter(Boolean).sort((a, b) => b.length - a.length);
    if (known.length === 0) return [text];
    const re = new RegExp(
      known.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'g',
    );
    const out: ReactNode[] = [];
    let at = 0;
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      if (i > at) out.push(text.slice(at, i));
      const path = m[0];
      out.push(
        <button
          key={`${i}-${path}`}
          type="button"
          data-evidence-artifact={path}
          onClick={() => onOpen(path)}
          className="text-signal underline decoration-dotted underline-offset-2 hover:text-fg-1"
          title="Open it in Work"
        >
          {path}
        </button>,
      );
      at = i + path.length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
  }, [text, paths, onOpen]);
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}

/** One artifact: a header that folds it, and its content read at the commit when open. */
function ArtifactRow({
  task,
  artifact,
  commit,
  open,
  onToggle,
}: {
  task: string;
  artifact: ReviewArtifact;
  commit: string | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const Icon = KIND_ICON[artifact.kind] ?? FileText;
  const web = artifact.kind === 'url' || artifact.kind === 'doc';
  if (web) {
    return (
      <li
        id={artifactAnchor(artifact.ref)}
        data-artifact={artifact.ref}
        className="flex items-center gap-2 rounded-lg border border-white/7 bg-white/[0.02] px-3 py-1.5 text-sm"
      >
        <Icon size={13} className="shrink-0 text-fg-4" />
        <a
          href={artifact.ref}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-signal hover:underline"
          title={artifact.ref}
        >
          {artifact.label ?? artifact.ref}
        </a>
        {artifact.rev && (
          <span className="font-mono text-[11px] text-fg-4">rev {artifact.rev}</span>
        )}
        <ExternalLink size={12} className="shrink-0 text-fg-4" />
      </li>
    );
  }
  return (
    <li
      id={artifactAnchor(artifact.ref)}
      data-artifact={artifact.ref}
      className="rounded-lg border border-white/7 bg-white/[0.02] text-sm"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-white/[0.03]"
      >
        {open ? (
          <ChevronDown size={13} className="text-fg-4" />
        ) : (
          <ChevronRight size={13} className="text-fg-4" />
        )}
        <Icon size={13} className="shrink-0 text-fg-4" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">
          {artifact.ref}
        </span>
        {artifact.label && <span className="text-xs text-fg-4">{artifact.label}</span>}
      </button>
      {open && <ArtifactBody task={task} artifact={artifact} commit={commit} />}
    </li>
  );
}

/** An open artifact: fetched once, rendered by type, with **Changes** for text at a commit. */
function ArtifactBody({
  task,
  artifact,
  commit,
}: {
  task: string;
  artifact: ReviewArtifact;
  commit: string | undefined;
}) {
  const [data, setData] = useState<TaskArtifact>();
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState(false);
  useEffect(() => {
    let live = true;
    const path =
      `/api/tasks/${q(task)}/artifact?path=${encodeURIComponent(artifact.ref)}` +
      (commit ? `&commit=${encodeURIComponent(commit)}` : '');
    api<TaskArtifact>('GET', path).then(
      (d) => live && setData(d),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [task, artifact.ref, commit]);
  if (error) {
    return (
      <div className="px-3 pb-2">
        <ErrorLine error={error} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex items-center gap-1.5 px-3 pb-2 text-xs text-fg-3">
        <Loader2 size={12} className="animate-spin text-signal" /> reading…
      </div>
    );
  }
  if (data.kind === 'image') {
    return (
      <div className="px-3 pb-3">
        <img
          data-artifact-image
          src={data.data}
          alt={artifact.label ?? artifact.ref}
          className="max-h-96 max-w-full rounded-lg border border-white/8"
        />
      </div>
    );
  }
  const text = data.text ?? '';
  const md = isMarkdown(data.path);
  const canDiff = data.base !== undefined && data.base !== null;
  return (
    <div className="px-3 pb-3">
      {canDiff && (
        <div className="mb-2 flex items-center gap-2 text-xs">
          <button
            type="button"
            data-artifact-changes
            aria-pressed={changes}
            onClick={() => setChanges(!changes)}
            className={cx(
              'rounded-md px-2 py-0.5',
              changes ? 'bg-signal/15 text-signal' : 'bg-white/5 text-fg-3 hover:text-fg-1',
            )}
          >
            Changes
          </button>
          <span className="text-fg-4">
            {data.base?.text === null
              ? 'new in this work'
              : `against ${data.base!.commit.slice(0, 7)}`}
          </span>
        </div>
      )}
      {changes && canDiff ? (
        <ProseDiff before={data.base!.text} after={text} />
      ) : md ? (
        <MarkdownArtifact text={text} />
      ) : (
        <pre className="max-h-[32rem] overflow-auto rounded-lg bg-black/30 p-2 font-mono text-[12px] whitespace-pre-wrap text-fg-2">
          {text}
        </pre>
      )}
    </div>
  );
}

function MarkdownArtifact({ text }: { text: string }) {
  const { front, body } = splitFrontMatter(text);
  return (
    <div data-artifact-markdown>
      {front && (
        <pre className="mb-2 rounded-lg bg-black/20 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-fg-3">
          {front}
        </pre>
      )}
      <Markdown text={body} className="text-sm text-fg-2" />
    </div>
  );
}

/**
 * The **Work** section: shown when the task's latest review names artifacts. The first Markdown
 * file and the first images open on their own; the others open on a click, or from a criterion's
 * evidence (`focus`).
 */
export function WorkSection({
  task,
  events,
  focus,
}: {
  task: string;
  events: readonly OpsEvent[];
  focus?: ArtifactFocus | null;
}) {
  const review = reviewWithArtifacts(events);
  const items = useMemo(() => review?.artifacts ?? [], [review]);
  const commit = review?.commit;
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const box = useRef<HTMLElement>(null);
  const firstMd = items.find((a) => a.kind === 'file' && isMarkdown(a.ref))?.ref;
  const images = items
    .filter((a) => a.kind === 'image')
    .slice(0, 4)
    .map((a) => a.ref);
  const isOpen = (ref: string): boolean =>
    opened.has(ref) || (!closed.has(ref) && (ref === firstMd || images.includes(ref)));

  useEffect(() => {
    if (!focus) return;
    setOpened((s) => new Set(s).add(focus.path));
    setClosed((s) => {
      const n = new Set(s);
      n.delete(focus.path);
      return n;
    });
    const el = box.current?.querySelector(`#${artifactAnchor(focus.path)}`);
    (el as HTMLElement | null)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [focus]);

  if (!review || items.length === 0) return null;
  const toggle = (ref: string): void => {
    if (isOpen(ref)) {
      setOpened((s) => {
        const n = new Set(s);
        n.delete(ref);
        return n;
      });
      setClosed((s) => new Set(s).add(ref));
    } else {
      setOpened((s) => new Set(s).add(ref));
      setClosed((s) => {
        const n = new Set(s);
        n.delete(ref);
        return n;
      });
    }
  };
  return (
    <section data-work ref={box}>
      <h3 className="label-caps mt-6 mb-2 flex items-center gap-1.5">
        <FileText size={12} /> Work
        <span className="font-normal tracking-normal text-fg-4 normal-case">
          {commit ? `· at ${commit.slice(0, 7)}` : '· in the workspace'}
        </span>
      </h3>
      <ul className="flex flex-col gap-1.5">
        {items.map((a) => (
          <ArtifactRow
            key={`${a.kind}:${a.ref}`}
            task={task}
            artifact={a}
            commit={commit}
            open={isOpen(a.ref)}
            onToggle={() => toggle(a.ref)}
          />
        ))}
      </ul>
    </section>
  );
}
