// Proposals (W6): changes to the definitions the improver recorded as variants, each with the
// agents and scorers it addresses, its diff against the base, its benchmark, and Promote and
// Reject for the person. Shown in the Agents view, beside the scores that led to them.
import { Bot, Check, FlaskConical, GitPullRequestArrow, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import {
  Button,
  ErrorLine,
  Field,
  Input,
  Modal,
  Select,
  TextArea,
  Toggle,
  cx,
  toast,
  useAction,
} from '../components';
import { ago } from '../lib/format';
import type { Agent, ImproveStatus, ProposalBenchmark, ProposalView, RoleFile } from '../types';
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
      {p.requires && (
        <div
          className={cx('flex items-start gap-1.5 text-xs', requiresText(p.requires).tone)}
          data-testid="proposal-requires"
        >
          <ShieldCheck size={12} className="mt-0.5 shrink-0" />
          {requiresText(p.requires).text}
        </div>
      )}
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

/** `improvement.requires` of a proposal's store, and whether it lets a promote through now. */
export function requiresText(r: ProposalView['requires']): { text: string; tone: string } {
  if (!r) return { text: '', tone: 'text-fg-4' };
  if (!r.benchmark) {
    return { text: 'improvement.requires: no benchmark; you may promote it', tone: 'text-fg-3' };
  }
  const min = `${r.min_delta > 0 ? '+' : ''}${Math.round(r.min_delta * 100)} pts`;
  if (r.problems.length === 0) {
    return {
      text: `improvement.requires: a benchmark at ${min} or better; met`,
      tone: 'text-ok',
    };
  }
  return {
    text: `improvement.requires: a benchmark at ${min} or better; not met: ${r.problems.join('; ')}`,
    tone: 'text-warn',
  };
}

/** The improver's state: its switches on this machine, the benchmark gate, each store's policy. */
function ImproverStatus({ nav }: { nav: Nav }) {
  const status = useData<ImproveStatus>('/api/improve');
  const act = useAction();
  const s = status.data;
  const turn = (patch: { enabled?: boolean; notes?: boolean }): void =>
    act.run(async () => {
      const next = await api<ImproveStatus>('POST', '/api/improve/settings', {
        as: nav.me,
        ...patch,
      });
      if (next && Array.isArray(next.roots)) status.set(next);
    });
  // An older swarmupd has no improver state to show; the list works without it.
  if (status.error || !s || !Array.isArray(s.roots)) return null;
  return (
    <div
      className="panel flex flex-col gap-2 px-4 py-3 text-xs text-fg-3"
      data-testid="improver-status"
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="flex items-center gap-1.5 text-fg-2">
          <Bot size={13} className="text-signal" />
          Improver <span className="font-mono text-fg-4">{s.agent}</span>
        </span>
        <span data-improve-switch="enabled">
          <Toggle
            checked={s.enabled}
            onChange={(v) => turn({ enabled: v })}
            label="Files tasks from failing scores"
          />
        </span>
        <span data-improve-switch="notes">
          <Toggle
            checked={s.notes}
            onChange={(v) => turn({ notes: v })}
            label="Folds learn notes into roles"
          />
        </span>
      </div>
      <div>
        {s.enabled
          ? `Every ${s.check_hours} h, an agent with ${s.threshold} or more failing task and run scores in ${s.max_age_days} days gets an improvement task.`
          : 'Off: improvement tasks come only from Propose an improvement on a failing score.'}{' '}
        These switches set <code>swarmupd.improve.enabled</code> and{' '}
        <code>swarmupd.improve.notes</code> in your user config.
      </div>
      <div data-testid="benchmark-gate">
        <FlaskConical size={12} className="mr-1 inline" />
        {s.benchmark ? (
          <>
            Benchmark gate: each proposal is replayed on set{' '}
            <span className="font-mono">{s.benchmark.set}</span>
            {s.benchmark.entries?.length ? ` (${s.benchmark.entries.join(', ')})` : ''} against{' '}
            <span className="font-mono">{s.benchmark.repo}</span>, {s.benchmark.repeat} repeat(s)
            per side.
          </>
        ) : (
          <>
            Benchmark gate: off. Set <code>swarmupd.improve.benchmark</code> (a set and the repo
            under test) in your user config to replay each proposal against the base; it spends
            tokens. See <b>Benchmarks</b> for the sets.
          </>
        )}
      </div>
      {s.roots.map((r) => (
        <div key={r.root} data-improve-root={r.root}>
          <span className="font-mono text-fg-2">{r.root}</span>:{' '}
          {r.policy.requires.benchmark
            ? `a promote needs a benchmark at ${r.policy.requires.min_delta > 0 ? '+' : ''}${Math.round(r.policy.requires.min_delta * 100)} pts or better`
            : 'a promote needs no benchmark'}
          ; {r.open} of {r.policy.max_open_proposals} proposals open.{' '}
          <button
            type="button"
            className="text-signal hover:underline"
            onClick={() => nav.go('settings', 'definitions')}
          >
            Set in swarm.yaml (improvement)
          </button>
        </div>
      ))}
      <ErrorLine error={act.error} />
    </div>
  );
}

/**
 * **Propose a change**: a person edits an agent's role file and records it as a variant
 * proposal, on a task they name or a new improvement task. Nothing changes until a promote.
 */
export function ProposeDialog({
  me,
  onClose,
  onDone,
}: {
  me: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const agents = useData<Agent[]>('/api/agents');
  const withFile = (agents.data ?? []).filter((a) => a.file);
  const [agent, setAgent] = useState('');
  const chosen = agent || withFile[0]?.id || '';
  const role = useData<RoleFile>(chosen ? `/api/roles/${encodeURIComponent(chosen)}` : null);
  const [text, setText] = useState<string | null>(null);
  const [why, setWhy] = useState('');
  const [task, setTask] = useState('');
  const act = useAction();
  const start = role.data?.text ?? '';
  const shown = text ?? start;
  const changed = role.data?.text !== undefined && shown !== start;
  const submit = (): void =>
    act.run(async () => {
      const res = await api<{ variant: string; task: string }>('POST', '/api/defs/propose', {
        as: me,
        agent: chosen,
        text: shown,
        message: why.trim(),
        ...(task.trim() ? { task: task.trim() } : {}),
      });
      toast(`Proposed ${res.variant} on ${res.task}`, { tone: 'ok' });
      refreshSoon();
      onDone();
    });
  return (
    <Modal
      title="Propose a change"
      icon={GitPullRequestArrow}
      onClose={onClose}
      width={820}
      dirty={changed || Boolean(why.trim())}
    >
      <div className="flex flex-col gap-3" data-propose-change>
        <p className="text-sm text-fg-3">
          Edit the agent's role file and say why. It is recorded as a variant proposal: the file
          stays as it is until you promote the proposal, and with a benchmark gate swarmupd replays
          it against the base first.
        </p>
        <ErrorLine error={agents.error ?? role.error} />
        <Field label="Agent">
          <Select
            value={chosen}
            onChange={(v) => {
              setAgent(v);
              setText(null);
            }}
            options={withFile.map((a): [string, string] => [
              a.id,
              a.name ? `${a.id} (${a.name})` : a.id,
            ])}
          />
        </Field>
        {agents.data && withFile.length === 0 && (
          <p className="text-sm text-warn">
            No agent has a role file yet; create one with Create role.
          </p>
        )}
        {role.data && (
          <Field label={role.data.path ?? 'Role file'}>
            <textarea
              aria-label="Role file"
              value={shown}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              className="h-72 w-full resize-y rounded-lg border border-white/10 bg-ink-950/60 p-2.5 font-mono text-[12px] leading-5 outline-none focus:border-signal/60"
            />
          </Field>
        )}
        <Field
          label="Why"
          hint="The proposal's message: what fails today and what the change fixes."
        >
          <TextArea value={why} onChange={setWhy} rows={3} />
        </Field>
        <Field
          label="Task"
          hint="An existing task to link it to; empty files an improvement task for you."
        >
          <Input value={task} onChange={setTask} placeholder="T-0042" />
        </Field>
        <ErrorLine error={act.error} />
        <div className="flex items-center gap-2">
          <Button
            kind="primary"
            icon={GitPullRequestArrow}
            disabled={act.busy || !chosen || !changed || !why.trim()}
            onClick={submit}
          >
            Propose
          </Button>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          {role.data && !changed && (
            <span className="text-xs text-fg-4">Change the file to propose it</span>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** The Proposals list, with the improver's state; an empty state says what a proposal is. */
export function Proposals({ nav }: { nav: Nav }) {
  const list = useData<ProposalView[]>('/api/defs/variants');
  const [proposing, setProposing] = useState(false);
  const count = list.data?.length ?? 0;
  return (
    <section data-testid="proposals">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="label-caps">Proposals</span>
        <span className="font-mono text-xs text-fg-4">{count}</span>
        <span className="text-xs text-fg-4">
          Changes to agent definitions; a person promotes or rejects each one.
        </span>
        <span className="ml-auto">
          <Button size="sm" icon={GitPullRequestArrow} onClick={() => setProposing(true)}>
            Propose a change
          </Button>
        </span>
      </div>
      <div className="flex flex-col gap-3">
        <ImproverStatus nav={nav} />
        <ErrorLine error={list.error} />
        {list.data && count === 0 && (
          <div className="panel px-4 py-3 text-sm text-fg-3" data-testid="proposals-empty">
            <p className="text-fg-2">No proposal waits for you.</p>
            <p className="mt-1">
              A proposal is a reviewed change to an agent's definition, such as its role file, kept
              as a variant beside the files until you promote or reject it. The improver writes one
              when an agent's scores keep failing (from <b>Propose an improvement</b> on a failing
              score, or on its own when the switch above is on) or when learn notes keep mattering.
              You write one with <b>Propose a change</b>. Each shows its diff, its benchmark and
              what <code>improvement.requires</code> still needs.
            </p>
          </div>
        )}
        {(list.data ?? []).map((p) => (
          <ProposalCard key={`${p.root}/${p.name}`} p={p} nav={nav} onDone={list.reload} />
        ))}
      </div>
      {proposing && (
        <ProposeDialog
          me={nav.me}
          onClose={() => setProposing(false)}
          onDone={() => {
            setProposing(false);
            list.reload();
          }}
        />
      )}
    </section>
  );
}
