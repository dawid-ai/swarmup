import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FileDiff,
  FlaskConical,
  GitCompareArrows,
  Play,
  ScrollText,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Nav } from '../App';
import { api, q, useData } from '../api';
import { Button, Empty, ErrorLine, Section, Stat, cx, toast, useAction } from '../components';
import { ago, localTime } from '../lib/format';
import type {
  BenchAttempt,
  BenchComparison,
  BenchEntrySummary,
  BenchRunDetail,
  BenchRunView,
  BenchSetView,
} from '../types';
import {
  AttemptFileDialog,
  CompareTable,
  ModeTag,
  Progress,
  ResultPill,
  RunDialog,
  SetError,
  StatePill,
  dur,
  num,
  overallBits,
  pct,
  spread,
  usd,
  whoRan,
} from '../ui/bench';

/** How often the view reads a run under way again. */
const POLL_MS = 2000;

/** Calls `fn` every `ms` while `on` holds. */
function usePoll(on: boolean, ms: number, fn: () => void): void {
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  }, [on, ms, fn]);
}

/**
 * Benchmarks (W7): the sets swarmupd finds, the runs under its state folder, a run's attempts,
 * and two runs side by side. `selected` is a run id, or `compare:<a>:<b>`.
 */
export function Bench({ nav, selected }: { nav: Nav; selected?: string }) {
  const sets = useData<BenchSetView[]>('/api/bench/sets');
  const runs = useData<BenchRunView[]>('/api/bench/runs');
  const [running, setRunning] = useState<string | null>(null);
  const live = (runs.data ?? []).some((r) => r.state === 'running');
  usePoll(live, POLL_MS, runs.reload);
  const compare = selected?.startsWith('compare:') ? selected.slice(8).split(':') : null;
  const open = (id: string): void => nav.go('bench', id);
  return (
    <Section
      title="Benchmarks"
      icon={FlaskConical}
      subtitle="Replay real tasks against an agent setup and score the results"
      actions={
        <Button
          kind="primary"
          size="sm"
          icon={Play}
          disabled={!(sets.data ?? []).some((s) => !s.error)}
          onClick={() => setRunning('')}
        >
          Run benchmark
        </Button>
      }
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-6">
        <ErrorLine error={sets.error ?? runs.error} />
        {compare && compare.length === 2 ? (
          <CompareView a={compare[0]!} b={compare[1]!} runs={runs.data ?? []} nav={nav} />
        ) : selected ? (
          <RunView id={selected} nav={nav} onChanged={runs.reload} />
        ) : (
          <>
            <RunsList runs={runs.data} nav={nav} onOpen={open} />
            <SetsList sets={sets.data} onRun={(file) => setRunning(file)} />
          </>
        )}
      </div>
      {running !== null && sets.data && (
        <RunDialog
          sets={sets.data}
          initialSet={running || undefined}
          onClose={() => setRunning(null)}
          onStarted={(id) => {
            setRunning(null);
            toast(`Started bench run ${id}`, { tone: 'ok' });
            runs.reload();
            open(id);
          }}
        />
      )}
    </Section>
  );
}

function SetsList({
  sets,
  onRun,
}: {
  sets: BenchSetView[] | undefined;
  onRun: (file: string) => void;
}) {
  const [openSet, setOpenSet] = useState<string | null>(null);
  if (!sets) return null;
  return (
    <div className="panel" data-testid="bench-sets">
      <div className="label-caps border-b border-white/6 px-4 py-2.5">Sets</div>
      {sets.length === 0 && (
        <p className="px-4 py-3 text-sm text-fg-3">
          No benchmark sets. Put <code>&lt;set&gt;.yaml</code> files in a project&apos;s{' '}
          <code>.swarmup/benchmarks/</code> folder, or list them under{' '}
          <code>swarmupd.bench.sets</code> in your user config.
        </p>
      )}
      {sets.map((s) => {
        const shown = openSet === s.file;
        return (
          <div key={s.file} className="border-t border-white/5 first:border-t-0" data-set={s.id}>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <button
                type="button"
                aria-expanded={shown}
                onClick={() => setOpenSet(shown ? null : s.file)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                {shown ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="font-mono text-sm">{s.id}</span>
                <span className="text-xs text-fg-4">
                  {s.error ? 'does not read' : `${s.entries.length} entries`}
                </span>
                {s.description && (
                  <span className="min-w-0 truncate text-xs text-fg-3">{s.description}</span>
                )}
              </button>
              <code
                className="hidden max-w-[40%] truncate text-[11px] text-fg-4 md:block"
                title={s.file}
              >
                {s.source === 'config' ? 'config' : s.source.replace(/^root:/, '')} · {s.file}
              </code>
              {!s.error && (
                <Button size="sm" icon={Play} onClick={() => onRun(s.file)}>
                  Run
                </Button>
              )}
            </div>
            {s.error && (
              <div className="px-4 pb-2.5">
                <SetError set={s} />
              </div>
            )}
            {shown && !s.error && (
              <table className="mb-2 w-full text-sm">
                <thead className="text-left text-xs text-fg-4">
                  <tr>
                    <th className="px-4 py-1.5 font-normal">Entry</th>
                    <th className="px-2 py-1.5 font-normal">Title</th>
                    <th className="px-2 py-1.5 text-right font-normal">Visible</th>
                    <th className="px-2 py-1.5 text-right font-normal">Hidden</th>
                    <th className="px-2 py-1.5 text-right font-normal">Pending</th>
                    <th className="px-4 py-1.5 font-normal">Base</th>
                  </tr>
                </thead>
                <tbody>
                  {s.entries.map((e) => (
                    <tr key={e.id} className="border-t border-white/5">
                      <td className="px-4 py-1.5 font-mono text-xs">{e.id}</td>
                      <td className="px-2 py-1.5">{e.title}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{e.criteria.visible}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{e.criteria.hidden}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{e.criteria.pending}</td>
                      <td className="px-4 py-1.5 font-mono text-xs text-fg-3">
                        {e.base.slice(0, 12)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RunsList({
  runs,
  nav,
  onOpen,
}: {
  runs: BenchRunView[] | undefined;
  nav: Nav;
  onOpen: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  if (!runs) return <div className="text-sm text-fg-3">Reading runs…</div>;
  const pick = (id: string): void =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id].slice(-2)));
  const done = new Set(runs.filter((r) => r.state === 'done').map((r) => r.id));
  return (
    <div className="panel overflow-x-auto" data-testid="bench-runs">
      <div className="flex items-center gap-3 border-b border-white/6 px-4 py-2">
        <div className="label-caps">Runs</div>
        <span className="text-xs text-fg-4">Pick two finished runs to compare them</span>
        <div className="ml-auto">
          <Button
            size="sm"
            icon={GitCompareArrows}
            disabled={picked.length !== 2}
            onClick={() => nav.go('bench', `compare:${picked[0]}:${picked[1]}`)}
          >
            Compare
          </Button>
        </div>
      </div>
      {runs.length === 0 ? (
        <Empty icon={FlaskConical} title="No runs yet">
          Start one with <b>Run benchmark</b>. Reference and no-agent runs cost nothing and check
          the set itself.
        </Empty>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-fg-4">
            <tr>
              <th className="w-8 px-3 py-2 font-normal" />
              <th className="px-2 py-2 font-normal">When</th>
              <th className="px-2 py-2 font-normal">Set</th>
              <th className="px-2 py-2 font-normal">Agent</th>
              <th className="px-2 py-2 font-normal">Mode</th>
              <th className="px-2 py-2 text-right font-normal">Pass</th>
              <th className="px-2 py-2 text-right font-normal">Hidden</th>
              <th className="px-2 py-2 text-right font-normal">Cost</th>
              <th className="px-2 py-2 text-right font-normal">Time</th>
              <th className="px-3 py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                data-run={r.id}
                className="cursor-pointer border-t border-white/5 hover:bg-white/3"
                onClick={() => onOpen(r.id)}
              >
                <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Compare ${r.id}`}
                    disabled={!done.has(r.id)}
                    checked={picked.includes(r.id)}
                    onChange={() => pick(r.id)}
                  />
                </td>
                <td className="px-2 py-2 text-xs text-fg-3" title={localTime(r.startedAt)}>
                  {r.startedAt ? ago(r.startedAt) : '–'}
                </td>
                <td className="px-2 py-2 font-mono text-xs">{r.set ?? r.id}</td>
                <td className="px-2 py-2 text-xs">{whoRan(r)}</td>
                <td className="px-2 py-2">
                  <ModeTag mode={r.mode} />
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{pct(r.overall?.passRate)}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {pct(r.overall?.hiddenPassRate)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {usd(r.overall?.costUsd, r.overall?.costEstimated)}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">
                  {r.startedAt && r.finishedAt
                    ? dur(Date.parse(r.finishedAt) - Date.parse(r.startedAt))
                    : '–'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-col items-start gap-1">
                    <StatePill run={r} />
                    {r.state === 'running' && r.total ? (
                      <Progress done={r.done ?? 0} total={r.total} />
                    ) : null}
                    {r.state === 'failed' && r.error && (
                      <span className="max-w-56 truncate text-[11px] text-bad" title={r.error}>
                        {r.error}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Per entry figures from the attempts, for a run whose summary is not written yet. */
function entriesOf(detail: BenchRunDetail): BenchEntrySummary[] {
  if (detail.summary) return detail.summary.entries;
  const ids = [...new Set(detail.attempts.map((a) => a.entry))];
  return ids.map((entry) => {
    const xs = detail.attempts.filter((a) => a.entry === entry);
    const mean = (v: Array<number | null>): number | null => {
      const n = v.filter((x): x is number => x !== null);
      return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null;
    };
    const withHidden = xs.filter((a) => a.score.hidden.total > 0);
    return {
      entry,
      attempts: xs.length,
      passRate: mean(xs.map((a) => a.score.passRate)),
      hiddenPass: withHidden.length
        ? {
            passed: withHidden.filter((a) => a.score.hidden.passed === a.score.hidden.total).length,
            attempts: withHidden.length,
          }
        : null,
      pending: xs.reduce((s, a) => s + a.score.pending, 0),
      costUsd: mean(xs.map((a) => a.metrics.costUsd)),
      wallMs: mean(xs.map((a) => a.run.wallMs)),
      toolCallsBeforeEdit: mean(xs.map((a) => a.metrics.toolCallsBeforeEdit)),
      timedOut: xs.filter((a) => a.run.timedOut).length,
      errors: xs.filter((a) => a.run.error).length,
    };
  });
}

function RunView({ id, nav, onChanged }: { id: string; nav: Nav; onChanged: () => void }) {
  const { data, error, reload } = useData<BenchRunDetail>(`/api/bench/runs/${q(id)}`);
  const [file, setFile] = useState<{ entry: string; attempt: number; file: 'diff' | 'log' } | null>(
    null,
  );
  const stop = useAction();
  usePoll(data?.run.state === 'running', POLL_MS, reload);
  const back = (
    <Button size="sm" kind="ghost" icon={ArrowLeft} onClick={() => nav.go('bench')}>
      All runs
    </Button>
  );
  if (error) {
    return (
      <>
        {back}
        <ErrorLine error={error} />
      </>
    );
  }
  if (!data) return <div className="text-sm text-fg-3">Reading the run…</div>;
  const r = data.run;
  const entries = entriesOf(data);
  const spreads = entries.some((e) => spread(e) !== '');
  const cap = data.summary?.cap;
  return (
    <div className="flex flex-col gap-4" data-testid="bench-run">
      <div>{back}</div>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-display text-lg font-semibold tracking-wide">{r.set ?? r.id}</h2>
        <StatePill run={r} />
        <ModeTag mode={r.mode} />
        <span className="text-sm text-fg-2">{whoRan(r)}</span>
        <span className="text-xs text-fg-4" title={r.dir}>
          {r.id}
          {r.startedAt ? ` · ${localTime(r.startedAt)}` : ''}
        </span>
        {r.state === 'running' && (
          <div className="ml-auto">
            <Button
              size="sm"
              kind="danger"
              icon={CircleStop}
              disabled={stop.busy}
              onClick={() =>
                stop.run(
                  () => api('POST', `/api/bench/runs/${q(r.id)}/stop`),
                  () => {
                    reload();
                    onChanged();
                  },
                )
              }
            >
              Stop
            </Button>
          </div>
        )}
      </div>
      <ErrorLine error={stop.error} />
      {r.state === 'running' && (
        <div className="panel flex flex-col gap-2 p-3" data-testid="bench-progress">
          <div className="text-sm">
            {r.done ?? 0} of {r.total ?? '?'} attempts done
            {r.current ? `; now ${r.current}` : ''}
          </div>
          <Progress done={r.done ?? 0} total={r.total ?? 0} />
        </div>
      )}
      {r.state === 'failed' && r.error && <ErrorLine error={r.error} />}
      {r.overall && (
        <div className="flex flex-wrap gap-3">
          {overallBits(r.overall).map(([label, value]) => (
            <Stat key={label} label={label} value={value} />
          ))}
        </div>
      )}
      {cap && (
        <div className={cx('text-sm', cap.hit ? 'text-warn' : 'text-fg-3')} data-testid="bench-cap">
          Cost cap {usd(cap.maxUsd)}: spent {usd(cap.spentUsd, r.overall?.costEstimated)}
          {cap.hit
            ? `; reached, so ${data.summary?.skipped?.length ?? 0} attempt(s) didn't start`
            : '; not reached'}
          {cap.uncounted > 0
            ? `; ${cap.uncounted} attempt(s) with no known cost weren't counted`
            : ''}
        </div>
      )}
      {entries.length > 0 && (
        <div className="panel overflow-x-auto" data-testid="bench-entries-table">
          <div className="label-caps border-b border-white/6 px-4 py-2.5">Entries</div>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-fg-4">
              <tr>
                <th className="px-4 py-2 font-normal">Entry</th>
                <th className="px-2 py-2 text-right font-normal">Attempts</th>
                <th className="px-2 py-2 text-right font-normal">Pass rate</th>
                <th className="px-2 py-2 text-right font-normal">Hidden pass</th>
                <th className="px-2 py-2 text-right font-normal">Pending</th>
                {spreads && <th className="px-2 py-2 text-right font-normal">Spread</th>}
                <th className="px-2 py-2 text-right font-normal">Cost</th>
                <th className="px-2 py-2 text-right font-normal">Time</th>
                <th className="px-4 py-2 text-right font-normal">Tools before edit</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.entry} className="border-t border-white/5" data-entry={e.entry}>
                  <td className="px-4 py-2 font-mono text-xs">{e.entry}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{e.attempts}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{pct(e.passRate)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">
                    {e.hiddenPass ? `${e.hiddenPass.passed}/${e.hiddenPass.attempts}` : '–'}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{e.pending}</td>
                  {spreads && (
                    <td
                      className="px-2 py-2 text-right tabular-nums"
                      title="Pass rate over repeats"
                    >
                      {spread(e) || '–'}
                    </td>
                  )}
                  <td
                    className="px-2 py-2 text-right tabular-nums"
                    title={e.unpriced?.length ? `No price for ${e.unpriced.join(', ')}` : undefined}
                  >
                    {usd(e.costUsd, e.costEstimated)}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{dur(e.wallMs)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {num(e.toolCallsBeforeEdit)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.attempts.map((a) => (
        <AttemptCard
          key={`${a.entry}/${a.attempt}`}
          a={a}
          onOpen={(f) => setFile({ entry: a.entry, attempt: a.attempt, file: f })}
        />
      ))}
      {data.log && (
        <details className="panel px-4 py-2.5 text-xs" data-testid="bench-run-log">
          <summary className="label-caps cursor-pointer">Runner output</summary>
          <pre className="mt-2 max-h-80 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-fg-3">
            {data.log}
          </pre>
        </details>
      )}
      {file && <AttemptFileDialog run={r.id} {...file} onClose={() => setFile(null)} />}
    </div>
  );
}

function AttemptCard({ a, onOpen }: { a: BenchAttempt; onOpen: (file: 'diff' | 'log') => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const s = a.score;
  return (
    <div className="panel" data-attempt={`${a.entry}#${a.attempt}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/6 px-4 py-2.5 text-sm">
        <span className="font-mono">
          {a.entry} <span className="text-fg-4">#{a.attempt}</span>
        </span>
        <span className={cx(s.passRate === 1 ? 'text-ok' : s.passRate === 0 ? 'text-bad' : '')}>
          {s.passed}/{s.checkable} pass
        </span>
        {s.hidden.total > 0 && (
          <span
            className={s.hidden.passed === s.hidden.total ? 'text-ok' : 'text-bad'}
            data-testid="bench-hidden"
          >
            hidden {s.hidden.passed}/{s.hidden.total}
          </span>
        )}
        {s.pending > 0 && <span className="text-warn">{s.pending} pending</span>}
        <span className="text-fg-3">{usd(a.metrics.costUsd, a.metrics.costEstimated)}</span>
        <span className="text-fg-3">{dur(a.run.wallMs)}</span>
        <span className="text-fg-3" title="Tool calls before the first edit">
          orientation {num(a.metrics.toolCallsBeforeEdit)}
        </span>
        <span className="text-xs text-fg-4">
          {a.diff.files} files +{a.diff.insertions} -{a.diff.deletions}
        </span>
        {a.run.timedOut && <span className="text-warn">timed out</span>}
        <div className="ml-auto flex gap-1.5">
          <Button size="sm" kind="ghost" icon={FileDiff} onClick={() => onOpen('diff')}>
            Diff
          </Button>
          {a.mode === 'agent' && (
            <Button size="sm" kind="ghost" icon={ScrollText} onClick={() => onOpen('log')}>
              Log
            </Button>
          )}
        </div>
      </div>
      {a.run.error && <div className="px-4 pt-2 text-xs text-bad">{a.run.error}</div>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-fg-4">
          <tr>
            <th className="px-4 py-1.5 font-normal">Criterion</th>
            <th className="px-2 py-1.5 font-normal">Kind</th>
            <th className="px-2 py-1.5 font-normal">What</th>
            <th className="px-4 py-1.5 font-normal">Result</th>
          </tr>
        </thead>
        <tbody>
          {a.criteria.map((c) => (
            <tr
              key={c.id}
              data-criterion={c.id}
              className={cx('border-t border-white/5 align-top', c.evidence && 'cursor-pointer')}
              onClick={() => c.evidence && setShown(shown === c.id ? null : c.id)}
            >
              <td className="px-4 py-1.5 font-mono text-xs">
                {c.id}
                {c.hidden && (
                  <span className="ml-1.5 rounded bg-review/15 px-1 py-px font-sans text-[10px] text-review">
                    hidden
                  </span>
                )}
              </td>
              <td className="px-2 py-1.5 text-xs text-fg-3">{c.kind}</td>
              <td className="px-2 py-1.5">
                <div className="break-words">{c.what}</div>
                {(c.note || (shown === c.id && c.evidence)) && (
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-ink-950/60 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg-3">
                    {[c.note, shown === c.id ? c.evidence : null].filter(Boolean).join('\n')}
                  </pre>
                )}
              </td>
              <td className="px-4 py-1.5">
                <ResultPill result={c.result} />
                {c.score !== undefined && (
                  <span data-score className="ml-1.5 font-mono text-[11px] text-fg-3">
                    {c.score}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareView({
  a,
  b,
  runs,
  nav,
}: {
  a: string;
  b: string;
  runs: BenchRunView[];
  nav: Nav;
}) {
  const [data, setData] = useState<BenchComparison>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(null);
    api<BenchComparison>('POST', '/api/bench/compare', { a, b }).then(
      (c) => live && setData(c),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [a, b]);
  const head = (id: string, label: string) => {
    const r = runs.find((x) => x.id === id);
    return (
      <div className="panel min-w-0 flex-1 px-4 py-3">
        <div className="label-caps">{label}</div>
        <button
          type="button"
          className="mt-1 block truncate text-left font-mono text-sm hover:text-signal"
          onClick={() => nav.go('bench', id)}
        >
          {id}
        </button>
        {r && (
          <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
            <ModeTag mode={r.mode} /> {whoRan(r)}
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-4" data-testid="bench-compare-view">
      <div>
        <Button size="sm" kind="ghost" icon={ArrowLeft} onClick={() => nav.go('bench')}>
          All runs
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        {head(a, 'A')}
        {head(b, 'B')}
      </div>
      <ErrorLine error={error} />
      {!data && !error && <div className="text-sm text-fg-3">Comparing…</div>}
      {data && <CompareTable c={data} />}
    </div>
  );
}
