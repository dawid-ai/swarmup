import {
  CircleCheck,
  CircleX,
  FileCode2,
  FilePlus2,
  Import,
  PenLine,
  RefreshCw,
  Save,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, useData } from '../api';
import { Button, Empty, ErrorLine, Modal, cx, toast, useAction } from '../components';
import type { DefProblem, DefsImportPlan, DefsRoot, DefsValue, DefsView } from '../types';

/** A value as the YAML file writes it: lists in brackets, text bare. */
export function defsValueText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(defsValueText).join(', ')}]`;
  if (v === null || v === undefined) return '–';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** `file:line:col` with the file relative to the store folder when it is inside it. */
export function problemWhere(p: DefProblem, dir: string): string {
  const norm = (s: string): string => s.replace(/\\/g, '/');
  const file = norm(p.file).startsWith(`${norm(dir)}/`)
    ? norm(p.file).slice(norm(dir).length + 1)
    : norm(p.file);
  return `${file}:${p.line}:${p.col}`;
}

const SOURCE_LOOK: Record<DefsValue['source'], { label: string; cls: string; hint: string }> = {
  git: {
    label: 'git',
    cls: 'bg-ok/12 text-ok ring-ok/25',
    hint: 'swarm.yaml sets it and this machine does not',
  },
  machine: {
    label: 'this machine',
    cls: 'bg-warn/12 text-warn ring-warn/25',
    hint: 'your user config sets it too, and the machine wins',
  },
  unused: {
    label: 'unused',
    cls: 'bg-white/6 text-fg-3 ring-white/10',
    hint: 'no runtime on this machine takes it',
  },
};

function SourceTag({ source }: { source: DefsValue['source'] }) {
  const l = SOURCE_LOOK[source];
  return (
    <span
      title={l.hint}
      className={cx('rounded-md px-1.5 py-px text-[11px] font-medium ring-1 ring-inset', l.cls)}
    >
      {l.label}
    </span>
  );
}

function Severity({ p }: { p: Pick<DefProblem, 'severity'> }) {
  return p.severity === 'error' ? (
    <CircleX size={14} className="mt-0.5 shrink-0 text-bad" aria-label="error" />
  ) : (
    <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" aria-label="warning" />
  );
}

function ProblemList({ problems, dir }: { problems: DefProblem[]; dir: string }) {
  if (problems.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-ok" data-testid="defs-no-problems">
        <CircleCheck size={15} /> No problems
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5" data-testid="defs-problems">
      {problems.map((p, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          <Severity p={p} />
          <span className="min-w-0">
            <code className="text-xs text-fg-3">{problemWhere(p, dir)}</code>{' '}
            <span className={p.severity === 'error' ? 'text-[#ffb3ba]' : 'text-fg-2'}>
              {p.message}
            </span>
            {p.path !== '(top)' && <code className="ml-1.5 text-[11px] text-fg-4">{p.path}</code>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * `swarm.yaml` with line numbers, each line that has a problem marked and its messages under it.
 * Read-only.
 */
export function YamlView({ text, problems }: { text: string; problems: DefProblem[] }) {
  const lines = text.replace(/\n$/, '').split('\n');
  const byLine = new Map<number, DefProblem[]>();
  for (const p of problems) byLine.set(p.line, [...(byLine.get(p.line) ?? []), p]);
  return (
    <div
      className="max-h-[420px] overflow-auto rounded-lg border border-white/8 bg-ink-950/60 py-2 font-mono text-[12px] leading-5"
      data-testid="defs-yaml"
    >
      {lines.map((line, i) => {
        const here = byLine.get(i + 1) ?? [];
        const error = here.some((p) => p.severity === 'error');
        return (
          <div
            key={i}
            data-line={i + 1}
            data-problem={here.length ? (error ? 'error' : 'warning') : undefined}
          >
            <div
              className={cx(
                'flex whitespace-pre',
                error ? 'bg-bad/12' : here.length ? 'bg-warn/10' : '',
              )}
            >
              <span className="w-10 shrink-0 pr-3 text-right text-fg-4 select-none">{i + 1}</span>
              <span className={line.trimStart().startsWith('#') ? 'text-fg-4' : 'text-fg-2'}>
                {line || ' '}
              </span>
            </div>
            {here.map((p, j) => (
              <div
                key={j}
                className={cx(
                  'flex gap-1.5 py-0.5 pr-3 pl-10 font-sans text-xs',
                  p.severity === 'error' ? 'text-[#ffb3ba]' : 'text-warn',
                )}
              >
                <Severity p={p} />
                <span>
                  {p.col > 1 ? `col ${p.col}: ` : ''}
                  {p.message}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** A `+`/`-` line diff, as `swarmup defs import-config` prints it. */
function LineDiff({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <div className="text-sm text-fg-3">No change</div>;
  return (
    <pre
      className="max-h-[360px] overflow-auto rounded-lg border border-white/8 bg-ink-950/60 p-2 font-mono text-[12px] leading-5"
      data-testid="defs-import-diff"
    >
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'text-ok' : 'text-bad'}>
          {l}
        </div>
      ))}
    </pre>
  );
}

/**
 * Import from my settings: previews `defs import-config` for one root, then writes swarm.yaml on
 * confirm. The user config keeps every key, so this machine still overrides them.
 */
function ImportDialog({
  root,
  onClose,
  onDone,
}: {
  root: DefsRoot;
  onClose: () => void;
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<DefsImportPlan>();
  const [error, setError] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    let live = true;
    api<DefsImportPlan>('POST', '/api/defs/import', { root: root.root }).then(
      (p) => live && setPlan(p),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [root.root]);
  const write = (): void =>
    act.run(
      () => api('POST', '/api/defs/import', { root: root.root, write: true, expect: plan!.after }),
      () => {
        toast(`Wrote swarm.yaml in ${root.root}`, { tone: 'ok' });
        onDone();
      },
    );
  const blocked = !plan || plan.empty || plan.problems.length > 0 || plan.diff.length === 0;
  return (
    <Modal title="Import from my settings" icon={Import} onClose={onClose} width={680}>
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-fg-3">
          Copies the model and effort of each provider and your role settings from your user config
          into <code>{plan?.file ?? 'swarm.yaml'}</code>, keeping its comments. Your user config
          keeps those keys, so this machine still overrides them.
        </p>
        <ErrorLine error={error} />
        {!plan && !error && <div className="text-fg-3">Reading your settings…</div>}
        {plan?.empty && (
          <div className="text-fg-2">
            Your user config sets no provider model or effort and no roles, so there is nothing to
            import.
          </div>
        )}
        {plan && !plan.empty && (
          <>
            <div className="text-xs text-fg-3">
              {plan.exists ? 'Changes to the file' : 'A new file'}: {plan.keys.length} key
              {plan.keys.length === 1 ? '' : 's'}
            </div>
            <LineDiff lines={plan.diff} />
            {plan.problems.length > 0 && <ProblemList problems={plan.problems} dir={root.dir} />}
          </>
        )}
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button kind="primary" icon={Save} disabled={blocked || act.busy} onClick={write}>
            {plan?.exists ? 'Update swarm.yaml' : 'Write swarm.yaml'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Edits swarm.yaml in place: checks the text as you type and saves it whole. */
function YamlEditor({
  root,
  onCancel,
  onSaved,
}: {
  root: DefsRoot;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const start = root.text ?? '';
  const [text, setText] = useState(start);
  const [problems, setProblems] = useState<DefProblem[]>(root.problems);
  const act = useAction();
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api<{ problems: DefProblem[] }>('POST', '/api/defs/validate', {
        file: `${root.dir}/swarm.yaml`,
        text,
      }).then(
        (r) => mine === seq.current && setProblems(r.problems),
        () => {},
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [text, root.dir]);
  const errors = problems.filter((p) => p.severity === 'error').length;
  const save = (): void =>
    act.run(
      () => api('POST', '/api/defs/save', { root: root.root, text, expect: start }),
      () => {
        toast('Saved swarm.yaml', { tone: 'ok' });
        onSaved();
      },
    );
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="swarm.yaml"
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        className="h-80 w-full resize-y rounded-lg border border-white/10 bg-ink-950/60 p-2.5 font-mono text-[12px] leading-5 outline-none focus:border-signal/60"
      />
      <ProblemList problems={problems} dir={root.dir} />
      <ErrorLine error={act.error} />
      <div className="flex items-center gap-2">
        <Button
          kind="primary"
          size="sm"
          icon={Save}
          disabled={act.busy || errors > 0 || text === start}
          onClick={save}
        >
          Save
        </Button>
        <Button size="sm" kind="ghost" icon={X} onClick={onCancel}>
          Cancel
        </Button>
        {errors > 0 && <span className="text-xs text-bad">Fix the errors to save</span>}
      </div>
    </div>
  );
}

function commitText(r: DefsRoot): { text: string; tone: string } {
  if (r.dirty) return { text: 'uncommitted changes', tone: 'text-warn' };
  if (r.commit) return { text: `commit ${r.commit.slice(0, 8)}`, tone: 'text-fg-3' };
  return { text: 'commit not known yet', tone: 'text-fg-4' };
}

/** One root's definitions: state, effective values, problems, the file, and the actions. */
export function DefsRootCard({
  root,
  values,
  conflicts,
  onChanged,
}: {
  root: DefsRoot;
  values: DefsValue[];
  conflicts: DefsView['conflicts'];
  onChanged: () => void;
}) {
  const [checked, setChecked] = useState<DefProblem[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const act = useAction();
  const problems = checked ?? root.problems;
  const errors = problems.filter((p) => p.severity === 'error').length;
  const warnings = problems.length - errors;
  // Problems of swarm.yaml itself mark its lines; the agent files' show in the list only.
  const swarmProblems = useMemo(
    () => problems.filter((p) => /[\\/]swarm\.yaml$/.test(p.file)),
    [problems],
  );
  useEffect(() => setChecked(null), [root.hash]);
  const validate = (): void =>
    act.run(() =>
      api<{ ok: boolean; problems: DefProblem[] }>('POST', '/api/defs/validate', {
        root: root.root,
      }).then((r) => {
        setChecked(r.problems);
        const e = r.problems.filter((p) => p.severity === 'error').length;
        toast(
          e > 0
            ? `${e} error${e === 1 ? '' : 's'} in ${root.root}`
            : `${root.root}: definitions check${r.problems.length ? ' with warnings' : ''}`,
          { tone: e > 0 ? 'bad' : 'ok' },
        );
      }),
    );
  const create = (): void =>
    act.run(
      () => api('POST', '/api/defs/create', { root: root.root }),
      () => {
        toast(`Created swarm.yaml in ${root.root}`, { tone: 'ok' });
        onChanged();
      },
    );
  const c = commitText(root);
  const mine = conflicts.filter((x) => x.roots.includes(root.root));
  return (
    <section className="panel animate-rise" data-testid={`defs-root-${root.root}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/6 px-5 py-3.5">
        <FileCode2 size={18} className="text-signal" />
        <h2 className="font-display text-base font-semibold tracking-wide">{root.root}</h2>
        {root.present ? (
          <>
            <code className="text-xs text-fg-2" title={root.hash}>
              {root.short}
            </code>
            <span className={cx('text-xs', c.tone)}>{c.text}</span>
            {root.stale && (
              <span
                className="rounded-md bg-warn/12 px-1.5 py-px text-[11px] text-warn"
                title="swarm.yaml has errors, so swarmupd keeps the last good version"
              >
                last good version in use
              </span>
            )}
            <span
              className={cx('text-xs', errors ? 'text-bad' : warnings ? 'text-warn' : 'text-ok')}
            >
              {errors
                ? `${errors} error${errors === 1 ? '' : 's'}`
                : warnings
                  ? `${warnings} warning${warnings === 1 ? '' : 's'}`
                  : 'checks'}
            </span>
          </>
        ) : (
          <span className="text-xs text-fg-3">No swarm.yaml</span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" icon={RefreshCw} disabled={act.busy} onClick={validate}>
            Validate
          </Button>
          <Button size="sm" icon={Import} onClick={() => setImporting(true)}>
            Import from my settings
          </Button>
          {!root.present && (
            <Button size="sm" kind="primary" icon={FilePlus2} disabled={act.busy} onClick={create}>
              Create swarm.yaml
            </Button>
          )}
        </div>
      </header>
      <div className="flex flex-col gap-4 px-5 py-4">
        <ErrorLine error={act.error} />
        {!root.present && (
          <p className="text-sm text-fg-3">
            This project keeps its team settings on this machine only. A <code>swarm.yaml</code> in{' '}
            <code>{root.dir}</code> holds provider models, efforts and role limits in git, so every
            machine that syncs the project runs with them. Your user config still wins where it sets
            the same key.
          </p>
        )}
        {root.present && (
          <div>
            <div className="label-caps mb-2">Effective values</div>
            {values.length === 0 ? (
              <div className="text-sm text-fg-3">swarm.yaml sets no key this phase applies.</div>
            ) : (
              <table className="w-full text-sm" data-testid="defs-values">
                <thead className="text-left text-xs text-fg-4">
                  <tr>
                    <th className="py-1.5 font-normal">Key</th>
                    <th className="py-1.5 font-normal">Value</th>
                    <th className="py-1.5 font-normal">Source</th>
                    <th className="py-1.5 font-normal">In git</th>
                  </tr>
                </thead>
                <tbody>
                  {values.map((v) => (
                    <tr key={v.key} className="border-t border-white/5" data-key={v.key}>
                      <td className="py-1.5 pr-3">
                        <code className="text-xs">{v.key}</code>
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{defsValueText(v.value)}</td>
                      <td className="py-1.5 pr-3">
                        <SourceTag source={v.source} />
                      </td>
                      <td className="py-1.5 font-mono text-xs text-fg-3">
                        {v.source === 'machine' && JSON.stringify(v.git) !== JSON.stringify(v.value)
                          ? defsValueText(v.git)
                          : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {mine.map((x) => (
              <div key={x.key} className="mt-2 flex items-center gap-2 text-xs text-warn">
                <TriangleAlert size={13} />
                <code>{x.key}</code> differs in {x.roots.join(' and ')}; {x.roots[0]}&apos;s wins
              </div>
            ))}
          </div>
        )}
        {(root.present || problems.length > 0) && (
          <div>
            <div className="label-caps mb-2">Problems</div>
            <ProblemList problems={problems} dir={root.dir} />
          </div>
        )}
        {root.present && (
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="label-caps">swarm.yaml</div>
              {!editing && (
                <Button size="sm" kind="ghost" icon={PenLine} onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </div>
            {editing ? (
              <YamlEditor
                root={root}
                onCancel={() => setEditing(false)}
                onSaved={() => {
                  setEditing(false);
                  onChanged();
                }}
              />
            ) : (
              <YamlView text={root.text ?? ''} problems={swarmProblems} />
            )}
          </div>
        )}
      </div>
      {importing && (
        <ImportDialog
          root={root}
          onClose={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** Settings > Definitions: a card per project with its swarm.yaml. */
export function DefinitionsPanel() {
  const { data, error, reload } = useData<DefsView>('/api/defs');
  if (error) return <ErrorLine error={error} />;
  if (!data) return <div className="text-sm text-fg-3">Reading definitions…</div>;
  if (data.roots.length === 0) {
    return (
      <Empty icon={FileCode2} title="No projects">
        Add a project to keep its team settings in git.
      </Empty>
    );
  }
  return (
    <>
      {data.roots.map((r) => (
        <DefsRootCard
          key={r.root}
          root={r}
          values={data.values.filter((v) => v.root === r.root)}
          conflicts={data.conflicts}
          onChanged={reload}
        />
      ))}
    </>
  );
}
