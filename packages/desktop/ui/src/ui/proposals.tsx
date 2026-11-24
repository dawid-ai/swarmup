// Proposals (W6): changes to the definitions the improver recorded as variants, each with the
// agents and scorers it addresses, its diff against the base, its benchmark, and Promote and
// Reject for the person. Shown in the Agents view, beside the scores that led to them.
import { Check, FlaskConical, GitPullRequestArrow, X } from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import { Button, ErrorLine, Input, cx, toast, useAction } from '../components';
import { ago } from '../lib/format';
import type { ProposalBenchmark, ProposalView } from '../types';
import { Markdown } from './markdown';

const pts = (v: number | null | undefined): string =>
  v === null || v === undefined ? '-' : `${v > 0 ? '+' : ''}${Math.round(v * 100)} pts`;

/** `benchmark: better (+20 pts pass rate)`, or where the benchmark stands. */
export function benchmarkText(b: ProposalBenchmark | undefined): string {
  if (!b) return 'no benchmark';
  if (b.state === 'running') return 'benchmark running';
  if (b.state === 'failed') return `benchmark failed${b.error ? `: ${b.error}` : ''}`;
  if (b.state === 'skipped') return `benchmark skipped${b.error ? `: ${b.error}` : ''}`;
  const d = b.delta ?? {};
  const cost =
    d.costPerAttempt === null || d.costPerAttempt === undefined
      ? ''
      : `, ${d.costPerAttempt >= 0 ? '+' : '-'}$${Math.abs(d.costPerAttempt).toFixed(2)} per attempt`;
  return `benchmark: ${b.verdict ?? 'same'} (pass rate ${pts(d.passRate)}, hidden ${pts(d.hiddenPassRate)}${cost})`;
}

function Diff({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <div className="text-xs text-fg-4">no line changes</div>;
  return (
    <pre className="max-h-72 overflow-auto rounded-md bg-ink-950/60 px-3 py-2 font-mono text-[11px] leading-relaxed">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cx(
            'whitespace-pre-wrap',
            l.startsWith('+') ? 'text-ok' : l.startsWith('-') ? 'text-bad' : 'text-fg-3',
          )}
        >
          {l}
        </div>
      ))}
    </pre>
  );
}

function ProposalCard({ p, nav, onDone }: { p: ProposalView; nav: Nav; onDone: () => void }) {
  const act = useAction();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const path = `/api/defs/variants/${encodeURIComponent(p.name)}`;
  const decide = (verb: 'promote' | 'reject'): void =>
    act.run(
      () =>
        api('POST', `${path}/${verb}`, {
          root: p.root,
          ...(verb === 'reject' ? { message: note.trim() } : {}),
        }),
      () => {
        toast(verb === 'promote' ? `Promoted ${p.name}` : `Rejected ${p.name}`);
        setRejecting(false);
        onDone();
        refreshSoon();
      },
    );
  const verdict = p.benchmark?.verdict;
  return (
    <div className="panel flex flex-col gap-3 px-4 py-3" data-testid={`proposal-${p.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <GitPullRequestArrow size={15} className="text-signal" />
        <span className="font-mono text-sm text-fg">
          {p.root}/{p.name}
        </span>
        <span className="font-mono text-xs text-fg-4">{p.hash.slice(0, 14)}</span>
        <span className="text-xs text-fg-3">{p.from_ref ? 'from a git ref' : p.status}</span>
        {p.stale && (
          <span className="text-xs text-warn" title="The base definitions changed since">
            base changed
          </span>
        )}
        {p.proposal && (
          <button
            type="button"
            className="ml-auto font-mono text-xs text-signal hover:underline"
            onClick={() => nav.openTask(p.proposal!.task)}
          >
            {p.proposal.task}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-3">
        <span>
          <span className="text-fg-4">Agents </span>
          {p.agents.join(', ') || '-'}
        </span>
        <span>
          <span className="text-fg-4">Scorers </span>
          {p.proposal?.scorers.join(', ') || '-'}
        </span>
        {p.proposal && (
          <span>
            <span className="text-fg-4">By </span>
            {p.proposal.by}, {ago(p.proposal.at)}
          </span>
        )}
      </div>
      {p.proposal?.message && <Markdown text={p.proposal.message} className="text-sm" />}
      <div
        className={cx(
          'flex items-center gap-1.5 text-xs',
          verdict === 'better' ? 'text-ok' : verdict === 'worse' ? 'text-bad' : 'text-fg-3',
        )}
        data-testid="proposal-benchmark"
      >
        <FlaskConical size={12} />
        {benchmarkText(p.benchmark)}
      </div>
      {p.diffs.map((d) => (
        <div key={d.path} className="flex flex-col gap-1">
          <div className="text-xs">
            <span className="font-mono text-fg-2">{d.path}</span>{' '}
            <span className="text-fg-4">{d.kind}</span>
          </div>
          <Diff lines={d.lines} />
        </div>
      ))}
      {p.problems.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-warn">
          {p.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      <ErrorLine error={act.error} />
      {p.description && <p className="text-xs text-fg-2">{p.description}</p>}
      {p.from_ref ? (
        <p className="text-xs text-fg-3" data-testid="variant-from-ref">
          The definitions at <span className="font-mono">{p.from_ref}</span>
          {p.commit ? <span className="font-mono"> ({p.commit.slice(0, 10)})</span> : null}. Change
          or remove it in <span className="font-mono">swarm.yaml</span>; there is nothing to
          promote.
        </p>
      ) : rejecting ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={note}
            onChange={setNote}
            placeholder="Why not, for the improver"
            className="min-w-64 flex-1"
            autoFocus
            onEnter={() => note.trim() && decide('reject')}
          />
          <Button
            kind="danger"
            disabled={act.busy || !note.trim()}
            onClick={() => decide('reject')}
          >
            Reject
          </Button>
          <Button kind="ghost" onClick={() => setRejecting(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button
            kind="primary"
            icon={Check}
            disabled={act.busy || !p.ok}
            title={p.ok ? 'Write the change onto the definition files' : 'It does not check'}
            onClick={() => decide('promote')}
          >
            Promote
          </Button>
          <Button icon={X} disabled={act.busy} onClick={() => setRejecting(true)}>
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

/** The Proposals list; nothing while no variant waits. */
export function Proposals({ nav }: { nav: Nav }) {
  const list = useData<ProposalView[]>('/api/defs/variants');
  if (!list.data?.length && !list.error) return null;
  return (
    <section data-testid="proposals">
      <div className="mb-3 flex items-center gap-2">
        <span className="label-caps">Proposals</span>
        <span className="font-mono text-xs text-fg-4">{list.data?.length ?? 0}</span>
        <span className="text-xs text-fg-4">
          Changes to agent definitions; a person promotes or rejects each one.
        </span>
      </div>
      <ErrorLine error={list.error} />
      <div className="flex flex-col gap-3">
        {(list.data ?? []).map((p) => (
          <ProposalCard key={`${p.root}/${p.name}`} p={p} nav={nav} onDone={list.reload} />
        ))}
      </div>
    </section>
  );
}
