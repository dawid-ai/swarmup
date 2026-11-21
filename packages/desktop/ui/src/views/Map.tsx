import {
  CircleCheck,
  CircleX,
  ExternalLink,
  FileText,
  Link2,
  ListTree,
  Map as MapIcon,
  RefreshCw,
  Search,
  ShieldCheck,
  Tags,
  TriangleAlert,
  Waypoints,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, useData } from '../api';
import { Button, Empty, ErrorLine, Input, Section, Select, cx, toast } from '../components';
import { viewProject } from '../lib/filters';
import { hashColor } from '../lib/identity';
import type { MapHealth } from '../lib/map';
import { byKind, healthOf, isPathQuery, isUrl, reviewDue, treeRows } from '../lib/map';
import { renderMarkdown } from '../lib/markdown';
import type {
  MapCheck,
  MapNodeBrief,
  MapNodeView,
  MapProblem,
  MapType,
  MapView,
  Settings,
} from '../types';
import { MapGraph } from '../ui/map-graph';
import { useProjectLabel } from '../ui/project-label';

const TYPES: Array<[MapType, string]> = [
  ['code', 'Code'],
  ['website', 'Website'],
  ['campaign', 'Campaign or content'],
];

/**
 * The project map of one project (`.swarmup/map/` in its code checkout): the root summary, the
 * nodes by kind or as a tree, search by words or by a file, a node with its links, the check and
 * Rebuild index. A project without a map offers Create map. `selected` is a root name, with
 * `#<node id>` to open that node; a leading `check:` or `graph:` opens the check list or the graph
 * (`check:shop#core/fold`), for links and the screenshot run.
 */
export function ProjectMap({ selected }: { nav: Nav; selected?: string }) {
  const opts = (selected ?? '').split(':');
  const [wantRoot, wantNode] = (opts.pop() ?? '').split('#');
  const settings = useData<Settings>('/api/settings');
  const label = useProjectLabel();
  const roots = useMemo(
    () => (settings.data?.rootList ?? []).filter((r) => !r.isMirror && !r.isMaster),
    [settings.data],
  );
  const [picked, setPicked] = useState<string | undefined>(wantRoot || undefined);
  const shown = viewProject();
  const root =
    picked ?? (shown && roots.some((r) => r.name === shown) ? shown : undefined) ?? roots[0]?.name;
  const map = useData<MapView>(root ? `/api/map?root=${q(root)}` : null);
  const data = map.data?.root === root ? map.data : undefined;

  const [text, setText] = useState('');
  const [grouping, setGrouping] = useState<'kind' | 'tree'>('kind');
  const [pane, setPane] = useState<'node' | 'graph'>(opts.includes('graph') ? 'graph' : 'node');
  const [nodeId, setNodeId] = useState<string | null>(wantNode || null);
  const words = text.trim();
  const byFile = isPathQuery(words);
  const search = useData<MapNodeBrief[]>(
    root && data?.exists && words
      ? `/api/map/search?root=${q(root)}&${byFile ? 'file' : 'q'}=${q(words)}`
      : null,
  );
  const open = nodeId ?? (data?.exists ? 'index' : null);
  const node = useData<MapNodeView>(
    root && data?.exists && open ? `/api/map/node?root=${q(root)}&id=${q(open)}` : null,
  );

  // The check runs on open and after each write; Check runs it again and shows the list.
  const [check, setCheck] = useState<{ root: string; res: MapCheck } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [showCheck, setShowCheck] = useState(opts.includes('check'));
  const [base, setBase] = useState('');
  const runs = useRef(0);
  const runCheck = useCallback(
    (show: boolean) => {
      if (!root) return;
      const mine = ++runs.current;
      setChecking(true);
      setCheckError(null);
      if (show) setShowCheck(true);
      api<MapCheck>('POST', '/api/map/check', {
        root,
        ...(base.trim() ? { base: base.trim() } : {}),
      })
        .then(
          (res) => mine === runs.current && setCheck({ root, res }),
          (e: Error) => mine === runs.current && setCheckError(e.message),
        )
        .finally(() => mine === runs.current && setChecking(false));
    },
    [root, base],
  );
  const exists = data?.exists;
  useEffect(() => {
    setCheck(null);
    if (root && exists) runCheck(false);
    // Only a new project or a new map starts a check by itself, not each typed base.
  }, [root, exists]);
  const shownCheck = check && check.root === root ? check.res : null;

  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const write = <T,>(path: string, body: Record<string, unknown>, done: (res: T) => void): void => {
    setBusy(true);
    setWriteError(null);
    api<T>('POST', path, body).then(
      (res) => {
        setBusy(false);
        done(res);
        map.reload();
      },
      (e: Error) => {
        setBusy(false);
        setWriteError(e.message);
      },
    );
  };
  const rebuild = (): void =>
    write<{ nodes: number }>('/api/map/index', { root }, (res) => {
      toast(`Rebuilt _INDEX.md: ${res.nodes} nodes`, { tone: 'ok' });
      runCheck(false);
    });
  const [type, setType] = useState<MapType | ''>('');
  const create = (): void =>
    // The new map's `exists` starts its first check.
    write<{ type: string }>('/api/map/init', { root, type: type || data?.detected }, (res) =>
      toast(`Created a ${res.type} map`, { tone: 'ok' }),
    );

  const openNode = (id: string): void => {
    setNodeId(id);
    setPane('node');
  };
  const nodes = data?.nodes ?? [];
  const health = shownCheck ? healthOf(shownCheck) : null;

  return (
    <Section
      title="Map"
      icon={MapIcon}
      subtitle={
        data?.exists
          ? `${nodes.length} nodes in ${byKind(nodes).length} kinds`
          : 'What each part of the project is for, in linked notes agents keep true'
      }
      actions={
        <>
          {roots.length > 1 && (
            <label className="flex items-center gap-2 text-sm">
              <span className="text-fg-3">Project</span>
              <Select
                value={root ?? ''}
                onChange={(v) => {
                  setPicked(v);
                  setNodeId(null);
                  setShowCheck(false);
                  setText('');
                }}
                options={roots.map((r): [string, string] => [r.name, label(r.name)])}
                className="w-48"
              />
            </label>
          )}
          {data?.exists && (
            <>
              <HealthBadge
                health={health?.health}
                label={checking ? 'Checking…' : (health?.label ?? 'Not checked')}
                onClick={() => setShowCheck((s) => !s)}
              />
              <Button icon={ShieldCheck} onClick={() => runCheck(true)} disabled={checking}>
                Check
              </Button>
              <Button icon={RefreshCw} onClick={rebuild} disabled={busy}>
                Rebuild index
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {(map.error || writeError) && (
          <div className="px-6 pt-4">
            <ErrorLine error={map.error ?? writeError} />
          </div>
        )}
        {data && !data.exists && (
          <Empty
            icon={MapIcon}
            title="No project map yet"
            action={
              <div className="flex items-center justify-center gap-2">
                <Select
                  value={type || data.detected || 'code'}
                  onChange={(v) => setType(v as MapType)}
                  options={TYPES.map(([v, l]): [string, string] => [
                    v,
                    v === data.detected ? `${l} (detected)` : l,
                  ])}
                  className="w-56"
                />
                <Button kind="primary" icon={MapIcon} onClick={create} disabled={busy}>
                  Create map
                </Button>
              </div>
            }
          >
            A project map is a set of linked Markdown notes in{' '}
            <span className="font-mono">.swarmup/map/</span> that say what each part of the project
            is for. A run reads the one or two notes it needs instead of the whole project, and
            agents keep them true with each change.
            <div className="mt-2 font-mono text-xs break-all text-fg-4">{data.top}</div>
          </Empty>
        )}
        {data?.exists && (
          <>
            <RootBanner view={data} />
            {showCheck && (
              <CheckPanel
                check={shownCheck}
                checking={checking}
                error={checkError}
                base={base}
                onBase={setBase}
                onRun={() => runCheck(true)}
                onOpen={openNode}
                onClose={() => setShowCheck(false)}
              />
            )}
            <div className="flex min-h-0 flex-1">
              <aside className="flex w-80 shrink-0 flex-col border-r border-white/6">
                <div className="space-y-2 border-b border-white/6 p-3">
                  <div className="relative">
                    <Search
                      size={14}
                      className="pointer-events-none absolute top-2.5 left-2.5 text-fg-4"
                    />
                    <Input
                      value={text}
                      onChange={setText}
                      placeholder="Words, or a file path"
                      className="w-full pl-8"
                    />
                  </div>
                  {words ? (
                    <div className="text-xs text-fg-4">
                      {byFile ? 'Nodes that cover this file' : 'Nodes that match any word'}
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <Toggle on={grouping === 'kind'} onClick={() => setGrouping('kind')}>
                        <Tags size={13} /> By kind
                      </Toggle>
                      <Toggle on={grouping === 'tree'} onClick={() => setGrouping('tree')}>
                        <ListTree size={13} /> Tree
                      </Toggle>
                    </div>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pb-4">
                  <ErrorLine error={search.error} />
                  {words ? (
                    search.data && search.data.length === 0 ? (
                      <div className="p-4 text-sm text-fg-4">
                        {byFile ? 'No node covers this file.' : 'No node matches these words.'}
                      </div>
                    ) : (
                      (search.data ?? []).map((n) => (
                        <NodeRow key={n.id} node={n} active={open === n.id} onOpen={openNode} />
                      ))
                    )
                  ) : grouping === 'kind' ? (
                    byKind(nodes).map(([kind, list]) => (
                      <div key={kind}>
                        <div className="label-caps flex items-center gap-2 px-4 pt-3 pb-1">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: hashColor(kind) }}
                          />
                          {kind}
                          <span className="ml-auto text-fg-4">{list.length}</span>
                        </div>
                        {list.map((n) => (
                          <NodeRow key={n.id} node={n} active={open === n.id} onOpen={openNode} />
                        ))}
                      </div>
                    ))
                  ) : (
                    treeRows(nodes).map((r) => (
                      <NodeRow
                        key={r.node.id}
                        node={r.node}
                        label={r.node.id === 'index' ? 'index (root)' : r.label}
                        depth={r.depth}
                        active={open === r.node.id}
                        onOpen={openNode}
                      />
                    ))
                  )}
                </div>
              </aside>
              <article className="flex min-w-0 flex-1 flex-col">
                <div className="flex gap-1 border-b border-white/6 px-6 py-2">
                  <Toggle on={pane === 'node'} onClick={() => setPane('node')}>
                    <FileText size={13} /> Node
                  </Toggle>
                  <Toggle on={pane === 'graph'} onClick={() => setPane('graph')}>
                    <Waypoints size={13} /> Graph
                  </Toggle>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
                  {pane === 'graph' ? (
                    <MapGraph nodes={nodes} selected={open} onOpen={openNode} />
                  ) : (
                    <>
                      <ErrorLine error={node.error} />
                      {node.data && node.data.id === open && (
                        <NodeDetail node={node.data} onOpen={openNode} />
                      )}
                    </>
                  )}
                </div>
              </article>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

function Toggle(props: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onClick}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition',
        props.on ? 'bg-signal/10 text-signal' : 'text-fg-3 hover:bg-white/5 hover:text-fg',
      )}
    >
      {props.children}
    </button>
  );
}

const HEALTH_TONE: Record<MapHealth, string> = {
  errors: 'bg-bad/15 text-bad ring-bad/30',
  warnings: 'bg-warn/15 text-warn ring-warn/30',
  ok: 'bg-ok/15 text-ok ring-ok/30',
};

/** The check's result in the header; a click shows or hides the list. */
function HealthBadge(props: { health?: MapHealth; label: string; onClick: () => void }) {
  const Icon =
    props.health === 'errors' ? CircleX : props.health === 'warnings' ? TriangleAlert : CircleCheck;
  return (
    <button
      type="button"
      data-map-health={props.health ?? 'none'}
      title="Show or hide the check results"
      onClick={props.onClick}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ring-1 ring-inset',
        props.health ? HEALTH_TONE[props.health] : 'bg-white/5 text-fg-3 ring-white/10',
      )}
    >
      <Icon size={13} />
      {props.label}
    </button>
  );
}

function RootBanner({ view }: { view: MapView }) {
  return (
    <div className="flex items-start gap-3 border-b border-white/6 bg-white/2 px-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-fg">
          {view.summary || <span className="text-fg-4">The root node has no summary.</span>}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-fg-4" title={view.dir ?? ''}>
          {view.dir}
        </div>
      </div>
      {view.type && (
        <span className="shrink-0 rounded bg-white/6 px-1.5 py-0.5 text-xs text-fg-3">
          {view.type}
        </span>
      )}
    </div>
  );
}

function CheckPanel(props: {
  check: MapCheck | null;
  checking: boolean;
  error: string | null;
  base: string;
  onBase: (v: string) => void;
  onRun: () => void;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const { check } = props;
  const rows: Array<[MapProblem, 'error' | 'warning']> = check
    ? [
        ...check.errors.map((p): [MapProblem, 'error'] => [p, 'error']),
        ...check.warnings.map((p): [MapProblem, 'warning'] => [p, 'warning']),
      ]
    : [];
  return (
    <div data-map-check className="max-h-[40%] overflow-y-auto border-b border-white/6 px-6 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg">Check</span>
        {check && (
          <span className="text-xs text-fg-3">
            {check.errors.length} error{check.errors.length === 1 ? '' : 's'},{' '}
            {check.warnings.length} warning{check.warnings.length === 1 ? '' : 's'}; {check.changed}{' '}
            changed path{check.changed === 1 ? '' : 's'}
            {check.base && ` against ${check.base.ref} (${check.base.commit.slice(0, 8)})`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={props.base}
            onChange={props.onBase}
            onEnter={props.onRun}
            placeholder="Base: the merge branch"
            className="w-48"
          />
          <Button size="sm" onClick={props.onRun} disabled={props.checking}>
            {props.checking ? 'Checking…' : 'Run again'}
          </Button>
          <Button size="sm" kind="ghost" onClick={props.onClose}>
            Hide
          </Button>
        </div>
      </div>
      <ErrorLine error={props.error} />
      {check && rows.length === 0 && (
        <div className="mt-2 flex items-center gap-2 text-sm text-ok">
          <CircleCheck size={14} /> No errors or warnings.
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {rows.map(([p, level], i) => (
          <li key={i} data-map-problem={level} className="flex items-start gap-2 text-sm">
            {level === 'error' ? (
              <CircleX size={14} className="mt-0.5 shrink-0 text-bad" />
            ) : (
              <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
            )}
            {p.node ? (
              <button
                type="button"
                onClick={() => props.onOpen(p.node!)}
                className="shrink-0 font-mono text-xs text-signal hover:underline"
              >
                {p.node}
              </button>
            ) : p.path ? (
              <span className="shrink-0 font-mono text-xs text-fg-2">{p.path}</span>
            ) : null}
            <span className="min-w-0 break-words text-fg-3">{p.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeRow(props: {
  node: MapNodeBrief;
  active: boolean;
  onOpen: (id: string) => void;
  label?: string;
  depth?: number;
}) {
  const { node } = props;
  const due = reviewDue(node);
  return (
    <button
      type="button"
      aria-pressed={props.active}
      data-map-row={node.id}
      onClick={() => props.onOpen(node.id)}
      style={props.depth ? { paddingLeft: `${16 + props.depth * 14}px` } : undefined}
      className={cx(
        'block w-full border-b border-white/5 px-4 py-2 text-left transition',
        props.active ? 'bg-signal/8 shadow-[inset_2px_0_0_#5ce1e6]' : 'hover:bg-white/4',
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-xs text-fg">{props.label ?? node.id}</span>
        {due && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" title="Review due" />}
        <span className="ml-auto shrink-0 text-xs" style={{ color: hashColor(node.kind || '?') }}>
          {node.kind}
        </span>
      </div>
      <div className="mt-0.5 truncate text-xs text-fg-3">{node.summary}</div>
    </button>
  );
}

function NodeChip(props: { node: MapNodeBrief; onOpen: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => props.onOpen(props.node.id)}
      title={props.node.summary}
      className="inline-flex items-center gap-1 rounded-md bg-white/6 px-2 py-0.5 font-mono text-xs text-signal ring-1 ring-white/8 ring-inset hover:bg-white/10"
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: hashColor(props.node.kind || '?') }}
      />
      {props.node.id}
    </button>
  );
}

function NodeDetail({ node, onOpen }: { node: MapNodeView; onOpen: (id: string) => void }) {
  const due = reviewDue(node);
  return (
    <div className="animate-rise max-w-3xl" key={node.id} data-map-detail={node.id}>
      <div className="font-mono text-xs text-fg-4">{node.file}</div>
      <h2 className="mt-1 font-mono text-2xl font-semibold tracking-wide">{node.id}</h2>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-3">
        <span
          className="rounded px-1.5 py-0.5"
          style={{ color: hashColor(node.kind || '?'), background: 'rgba(255,255,255,0.06)' }}
        >
          {node.kind || 'no kind'}
        </span>
        <span>
          {node.size} line{node.size === 1 ? '' : 's'}
        </span>
        {node.verified && (
          <span>
            verified at <span className="font-mono text-fg-2">{node.verified}</span>
          </span>
        )}
        {node.review_after && (
          <span>
            review after <span className="font-mono text-fg-2">{node.review_after}</span>
          </span>
        )}
        {due && (
          <span className="rounded bg-warn/15 px-1.5 py-0.5 font-medium text-warn">Review due</span>
        )}
      </div>
      <p className="mt-3 text-sm text-fg">{node.summary}</p>
      {node.problems.length > 0 && (
        <ul className="mt-3 space-y-1">
          {node.problems.map((p) => (
            <li key={p} className="flex items-center gap-2 text-sm text-bad">
              <CircleX size={14} /> {p}
            </li>
          ))}
        </ul>
      )}
      {node.covers.length > 0 && (
        <div className="mt-5">
          <div className="label-caps">Covers</div>
          <ul className="mt-1.5 space-y-1">
            {node.covers.map((c) => (
              <li key={c} className="font-mono text-xs break-all text-fg-2">
                {isUrl(c) ? (
                  <a
                    href={c}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-signal hover:underline"
                  >
                    {c} <ExternalLink size={11} />
                  </a>
                ) : (
                  c
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {(node.linksTo.length > 0 || node.broken.length > 0) && (
        <div className="mt-5">
          <div className="label-caps flex items-center gap-1.5">
            <Link2 size={12} /> Links
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {node.linksTo.map((n) => (
              <NodeChip key={n.id} node={n} onOpen={onOpen} />
            ))}
            {node.broken.map((l) => (
              <span
                key={l}
                title="No node has this id"
                className="rounded-md bg-bad/10 px-2 py-0.5 font-mono text-xs text-bad line-through"
              >
                {l}
              </span>
            ))}
          </div>
        </div>
      )}
      {node.linkedFrom.length > 0 && (
        <div className="mt-4">
          <div className="label-caps">Linked from</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {node.linkedFrom.map((n) => (
              <NodeChip key={n.id} node={n} onOpen={onOpen} />
            ))}
          </div>
        </div>
      )}
      <div
        className="md mt-6 border-t border-white/6 pt-5 text-sm leading-relaxed"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(node.body) }}
      />
    </div>
  );
}
