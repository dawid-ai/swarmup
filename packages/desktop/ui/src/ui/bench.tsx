import type { LucideIcon } from 'lucide-react';
import {
  CheckCircle2,
  CircleDashed,
  Coins,
  FileDiff,
  FlaskConical,
  Loader2,
  Play,
  ScrollText,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api, q } from '../api';
import { Button, ErrorLine, Field, Input, Modal, Select, cx, useAction } from '../components';
import { readableLog } from '../lib/format';
import type {
  BenchAttempt,
  BenchComparison,
  BenchEntrySummary,
  BenchMode,
  BenchOverall,
  BenchPlan,
  BenchRunView,
  BenchSetView,
} from '../types';

// ---- Figures ------------------------------------------------------------------------------------

export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`;
}

/** `$1.23`; `~$1.23` for a cost estimated from tokens (Codex reports no dollar figure). */
export function usd(v: number | null | undefined, estimated?: boolean): string {
  return v === null || v === undefined ? '–' : `${estimated ? '~' : ''}$${v.toFixed(2)}`;
}

/** A pass-rate spread over repeats: `60–80% ±8`; empty without one. */
export function spread(e: {
  passRateMin?: number | null;
  passRateMax?: number | null;
  passRateSd?: number | null;
}): string {
  if (e.passRateSd === undefined || e.passRateSd === null) return '';
  const p = (x: number | null | undefined): string =>
    x === null || x === undefined ? '?' : `${Math.round(x * 100)}`;
  const range = e.passRateMin !== undefined ? `${p(e.passRateMin)}–${p(e.passRateMax)}% ` : '';
  return `${range}±${Math.round(e.passRateSd * 100)}`;
}

/** `42s`, `3m 05s`, `1h 12m`. */
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function num(v: number | null | undefined): string {
  return v === null || v === undefined ? '–' : String(Math.round(v * 10) / 10);
}

/** Who ran: the agent, then the model and effort when set. */
export function whoRan(r: Pick<BenchRunView, 'agent' | 'model' | 'effort' | 'mode'>): string {
  if (r.mode === 'reference') return 'reference patches';
  if (r.mode === 'none') return 'no agent';
  return [r.agent, r.model, r.effort].filter(Boolean).join(' · ') || '–';
}

/** A signed delta: `+12 pts`, `-$0.40`, `±0`; empty when either side is missing. */
export function signed(v: number | null, f: (x: number) => string): string {
  if (v === null) return '';
  if (Math.abs(v) < 1e-9) return '±0';
  return `${v > 0 ? '+' : '-'}${f(Math.abs(v))}`;
}

// ---- Pills --------------------------------------------------------------------------------------

const STATE_LOOK: Record<
  BenchRunView['state'],
  { label: string; color: string; icon: LucideIcon }
> = {
  running: { label: 'Running', color: '#3ddc97', icon: Loader2 },
  done: { label: 'Done', color: '#7f8899', icon: CheckCircle2 },
  failed: { label: 'Failed', color: '#ff5d6c', icon: XCircle },
};

function Pill({
  color,
  icon: Icon,
  children,
}: {
  color: string;
  icon?: LucideIcon;
  children: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium"
      style={{
        color,
        background: `color-mix(in oklab, ${color} 12%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 28%, transparent)`,
      }}
    >
      {Icon && <Icon size={11} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

export function StatePill({ run }: { run: Pick<BenchRunView, 'state' | 'done' | 'total'> }) {
  const l = STATE_LOOK[run.state];
  const progress = run.state === 'running' && run.total ? ` ${run.done ?? 0}/${run.total}` : '';
  return (
    <Pill color={l.color} icon={l.icon}>
      {l.label + progress}
    </Pill>
  );
}

const MODE_TEXT: Record<BenchMode, string> = {
  agent: 'agent',
  reference: 'reference',
  none: 'no agent',
};

export function ModeTag({ mode }: { mode?: BenchMode }) {
  if (!mode) return null;
  return (
    <span
      className={cx(
        'rounded-md px-1.5 py-px text-[10px] font-semibold tracking-wider uppercase',
        mode === 'agent' ? 'bg-warn/12 text-warn' : 'bg-white/6 text-fg-3',
      )}
    >
      {MODE_TEXT[mode]}
    </span>
  );
}

const RESULT_LOOK: Record<
  BenchAttempt['criteria'][number]['result'],
  { color: string; icon: LucideIcon }
> = {
  pass: { color: '#3ddc97', icon: CheckCircle2 },
  fail: { color: '#ff5d6c', icon: XCircle },
  pending: { color: '#ffb547', icon: CircleDashed },
  na: { color: '#7f8899', icon: CircleDashed },
};

export function ResultPill({ result }: { result: BenchAttempt['criteria'][number]['result'] }) {
  const l = RESULT_LOOK[result];
  return (
    <Pill color={l.color} icon={l.icon}>
      {result}
    </Pill>
  );
}

/** A thin bar for a run's progress. */
export function Progress({ done, total }: { done: number; total: number }) {
  const share = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/8"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
    >
      <div
        className="h-full rounded-full bg-signal transition-all"
        style={{ width: `${share * 100}%` }}
      />
    </div>
  );
}

// ---- Attempt files ------------------------------------------------------------------------------

/** An attempt's diff or agent log, read on open. */
export function AttemptFileDialog({
  run,
  entry,
  attempt,
  file,
  onClose,
}: {
  run: string;
  entry: string;
  attempt: number;
  file: 'diff' | 'log';
  onClose: () => void;
}) {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<string>(
      'GET',
      `/api/bench/runs/${q(run)}/attempt?entry=${q(entry)}&n=${attempt}&file=${file}`,
    ).then(
      (t) => live && setText(typeof t === 'string' ? t : JSON.stringify(t, null, 2)),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [run, entry, attempt, file]);
  const log = useMemo(() => (file === 'log' && text ? readableLog(text, 800) : []), [file, text]);
  return (
    <Modal
      title={`${file === 'diff' ? 'Diff' : 'Agent log'} of ${entry} #${attempt}`}
      icon={file === 'diff' ? FileDiff : ScrollText}
      onClose={onClose}
      width={920}
    >
      <ErrorLine error={error} />
      {text === undefined && !error && <div className="text-sm text-fg-3">Reading…</div>}
      {text !== undefined && file === 'diff' && (
        <pre
          className="max-h-[70vh] overflow-auto rounded-lg border border-white/8 bg-ink-950/60 p-3 font-mono text-[12px] leading-5"
          data-testid="bench-diff"
        >
          {text.trim() === '' ? (
            <span className="text-fg-3">No change</span>
          ) : (
            text.split('\n').map((l, i) => (
              <div
                key={i}
                className={cx(
                  l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ')
                    ? 'text-fg'
                    : l.startsWith('+')
                      ? 'text-ok'
                      : l.startsWith('-')
                        ? 'text-bad'
                        : l.startsWith('@@')
                          ? 'text-info'
                          : 'text-fg-3',
                )}
              >
                {l || ' '}
              </div>
            ))
          )}
        </pre>
      )}
      {text !== undefined && file === 'log' && (
        <div
          className="max-h-[70vh] overflow-auto rounded-lg border border-white/8 bg-ink-950/60 p-3 font-mono text-[12px] leading-5"
          data-testid="bench-log"
        >
          {log.length === 0 && <span className="text-fg-3">The log is empty</span>}
          {log.map((l, i) => (
            <div
              key={i}
              className={cx(
                'whitespace-pre-wrap',
                l.kind === 'tool' ? 'text-info' : l.kind === 'error' ? 'text-bad' : 'text-fg-2',
              )}
            >
              {l.text}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---- Compare ------------------------------------------------------------------------------------

function Cell({
  a,
  b,
  f,
  fd,
  better,
}: {
  a: number | null;
  b: number | null;
  f: (x: number | null) => string;
  fd: (x: number) => string;
  better: 'higher' | 'lower';
}) {
  const d = a === null || b === null ? null : b - a;
  const good = d !== null && Math.abs(d) > 1e-9 && (better === 'higher' ? d > 0 : d < 0);
  const bad = d !== null && Math.abs(d) > 1e-9 && !good;
  return (
    <td className="px-2 py-2 text-right tabular-nums">
      <span className="text-fg-3">{f(a)}</span>
      <span className="px-1 text-fg-4">→</span>
      <span>{f(b)}</span>
      {d !== null && (
        <span className={cx('ml-1.5 text-xs', good ? 'text-ok' : bad ? 'text-bad' : 'text-fg-4')}>
          {signed(d, fd)}
        </span>
      )}
    </td>
  );
}

const hiddenText = (e: BenchEntrySummary | null): string =>
  e?.hiddenPass ? `${e.hiddenPass.passed}/${e.hiddenPass.attempts}` : '–';
const pts = (x: number): string => `${Math.round(x * 100)} pts`;

/** Two runs side by side, per entry and over the entries both have, with B minus A. */
export function CompareTable({ c }: { c: BenchComparison }) {
  const o = c.overall;
  return (
    <div className="panel overflow-x-auto" data-testid="bench-compare">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-fg-4">
          <tr>
            <th className="px-4 py-2 font-normal">Entry</th>
            <th className="px-2 py-2 text-right font-normal">Pass rate</th>
            <th className="px-2 py-2 text-right font-normal">Hidden pass</th>
            <th className="px-2 py-2 text-right font-normal">Cost</th>
            <th className="px-2 py-2 text-right font-normal">Time</th>
            <th className="px-2 py-2 text-right font-normal">Tools before edit</th>
          </tr>
        </thead>
        <tbody>
          {c.rows.map((r) => (
            <tr key={r.entry} className="border-t border-white/5" data-entry={r.entry}>
              <td className="px-4 py-2 font-mono text-xs">{r.entry}</td>
              <Cell
                a={r.a?.passRate ?? null}
                b={r.b?.passRate ?? null}
                f={pct}
                fd={pts}
                better="higher"
              />
              <td className="px-2 py-2 text-right tabular-nums">
                <span className="text-fg-3">{hiddenText(r.a)}</span>
                <span className="px-1 text-fg-4">→</span>
                {hiddenText(r.b)}
              </td>
              <Cell
                a={r.a?.costUsd ?? null}
                b={r.b?.costUsd ?? null}
                f={usd}
                fd={(x) => `$${x.toFixed(2)}`}
                better="lower"
              />
              <Cell
                a={r.a?.wallMs ?? null}
                b={r.b?.wallMs ?? null}
                f={dur}
                fd={(x) => dur(x)}
                better="lower"
              />
              <Cell
                a={r.a?.toolCallsBeforeEdit ?? null}
                b={r.b?.toolCallsBeforeEdit ?? null}
                f={num}
                fd={(x) => num(x)}
                better="lower"
              />
            </tr>
          ))}
          <tr className="border-t border-white/10 font-medium" data-entry="all">
            <td className="px-4 py-2">All shared entries</td>
            <Cell a={o.a.passRate} b={o.b.passRate} f={pct} fd={pts} better="higher" />
            <Cell a={o.a.hiddenPassRate} b={o.b.hiddenPassRate} f={pct} fd={pts} better="higher" />
            <Cell
              a={o.a.costPerAttempt}
              b={o.b.costPerAttempt}
              f={usd}
              fd={(x) => `$${x.toFixed(2)}`}
              better="lower"
            />
            <Cell a={o.a.wallMs} b={o.b.wallMs} f={dur} fd={(x) => dur(x)} better="lower" />
            <Cell
              a={o.a.toolCallsBeforeEdit}
              b={o.b.toolCallsBeforeEdit}
              f={num}
              fd={(x) => num(x)}
              better="lower"
            />
          </tr>
        </tbody>
      </table>
      <p className="border-t border-white/6 px-4 py-2 text-xs text-fg-4">
        Cost, time and tools before the first edit are means per attempt. The last row covers the
        entries both runs have. With one repeat, an entry&apos;s pass rate moves in large steps.
      </p>
    </div>
  );
}

/** Figures of a run, as a row of small numbers. */
export function overallBits(o: BenchOverall | undefined): Array<[string, string]> {
  if (!o) return [];
  return [
    ['Pass rate', pct(o.passRate)],
    ['Hidden pass', pct(o.hiddenPassRate)],
    ['Cost', usd(o.costUsd, o.costEstimated)],
    ['Time per attempt', dur(o.wallMs)],
    ['Attempts', String(o.attempts)],
    ...(o.passRateSd !== undefined && o.passRateSd !== null
      ? ([['Pass rate spread', `±${Math.round(o.passRateSd * 100)} pts`]] as Array<
          [string, string]
        >)
      : []),
  ];
}

// ---- Start a run --------------------------------------------------------------------------------

interface RunForm {
  set: string;
  entries: string[];
  mode: BenchMode;
  agent: string;
  model: string;
  effort: string;
  repeat: string;
  budget: string;
  maxUsd: string;
  repo: string;
  hidden: string;
  reference: string;
}

const FORM_KEY = 'swarmup.bench.form';

function savedForms(): Record<string, Partial<RunForm>> {
  try {
    return JSON.parse(window.localStorage.getItem(FORM_KEY) ?? '{}') as Record<
      string,
      Partial<RunForm>
    >;
  } catch {
    return {};
  }
}

function saveForm(f: RunForm): void {
  try {
    const all = savedForms();
    all[f.set] = f;
    window.localStorage.setItem(FORM_KEY, JSON.stringify(all));
  } catch {
    // No storage: the form starts from the set's defaults next time.
  }
}

function formFor(set: BenchSetView | undefined): RunForm {
  const kept = set ? savedForms()[set.file] : undefined;
  return {
    set: set?.file ?? '',
    entries: [],
    mode: 'agent',
    agent: '',
    model: '',
    effort: '',
    repeat: '',
    budget: '',
    maxUsd: '',
    repo: '',
    hidden: set?.hiddenDir ?? '',
    reference: '',
    ...kept,
    ...(set ? { set: set.file } : {}),
  };
}

/** The request `POST /api/bench/run` takes for a form. */
export function runBody(f: RunForm, dryRun: boolean): Record<string, unknown> {
  return {
    set: f.set,
    repo: f.repo.trim(),
    mode: f.mode,
    ...(f.entries.length ? { entries: f.entries } : {}),
    ...(f.mode === 'agent' && f.agent.trim() ? { agent: f.agent.trim() } : {}),
    ...(f.mode === 'agent' && f.model.trim() ? { model: f.model.trim() } : {}),
    ...(f.mode === 'agent' && f.effort.trim() ? { effort: f.effort.trim() } : {}),
    ...(f.mode === 'agent' && f.repeat.trim() ? { repeat: Number(f.repeat) } : {}),
    ...(f.mode === 'agent' && f.budget.trim() ? { budget_min: Number(f.budget) } : {}),
    ...(f.mode === 'agent' && f.maxUsd.trim() ? { max_usd: Number(f.maxUsd) } : {}),
    ...(f.hidden.trim() ? { hidden_dir: f.hidden.trim() } : {}),
    ...(f.mode === 'reference' ? { reference_dir: f.reference.trim() } : {}),
    dry_run: dryRun,
  };
}

/** A caption over a group of buttons: a `<label>` would pass its clicks to the first button. */
function Group(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={props.label}>
      <span className="label-caps">{props.label}</span>
      {props.children}
      {props.hint && <span className="text-xs text-fg-4">{props.hint}</span>}
    </div>
  );
}

const MODES: Array<[BenchMode, string, string]> = [
  ['agent', 'Agent', 'Runs the agent on each entry; spends tokens'],
  ['reference', 'Reference', 'Applies known good patches; checks the criteria, costs nothing'],
  ['none', 'No agent', 'Changes nothing; hidden tests should fail; costs nothing'],
];

/**
 * Start a benchmark run: the form, then the plan from a dry run with what it costs, then the
 * run. A run with an agent asks for a second, explicit confirmation of the cost.
 */
export function RunDialog({
  sets,
  initialSet,
  onClose,
  onStarted,
}: {
  sets: BenchSetView[];
  initialSet?: string;
  onClose: () => void;
  onStarted: (id: string) => void;
}) {
  const usable = sets.filter((s) => !s.error);
  const [form, setForm] = useState<RunForm>(() =>
    formFor(usable.find((s) => s.file === initialSet) ?? usable[0]),
  );
  const [plan, setPlan] = useState<BenchPlan | null>(null);
  const [agreed, setAgreed] = useState(false);
  const act = useAction();
  const set = usable.find((s) => s.file === form.set);
  const put = (patch: Partial<RunForm>): void => {
    setPlan(null);
    setAgreed(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const review = (): void =>
    act.run(async () => {
      saveForm(form);
      const r = await api<{ plan: BenchPlan }>('POST', '/api/bench/run', runBody(form, true));
      setPlan(r.plan);
    });
  const start = (): void =>
    act.run(async () => {
      const r = await api<{ id: string }>('POST', '/api/bench/run', runBody(form, false));
      onStarted(r.id);
    });
  const toggleEntry = (id: string): void =>
    put({
      entries: form.entries.includes(id)
        ? form.entries.filter((e) => e !== id)
        : [...form.entries, id],
    });
  return (
    <Modal title="Run a benchmark" icon={FlaskConical} onClose={onClose} width={720} dirty={!!plan}>
      <div className="flex flex-col gap-3 text-sm">
        <Field label="Set">
          <Select
            value={form.set}
            onChange={(v) => {
              setPlan(null);
              setForm(formFor(usable.find((s) => s.file === v)));
            }}
            options={usable.map((s) => [s.file, `${s.id} (${s.entries.length} entries)`])}
          />
        </Field>
        {set && (
          <Group label="Entries" hint="None picked runs every entry">
            <div
              className="flex max-h-32 flex-wrap gap-1.5 overflow-auto"
              data-testid="bench-entries"
            >
              {set.entries.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  title={e.title}
                  aria-pressed={form.entries.includes(e.id)}
                  onClick={() => toggleEntry(e.id)}
                  className={cx(
                    'rounded-md px-2 py-0.5 font-mono text-xs ring-1 ring-inset',
                    form.entries.includes(e.id)
                      ? 'bg-signal/15 text-signal ring-signal/40'
                      : 'bg-white/4 text-fg-3 ring-white/10 hover:text-fg',
                  )}
                >
                  {e.id}
                </button>
              ))}
            </div>
          </Group>
        )}
        <Group label="Mode">
          <div
            className="flex gap-1 rounded-lg bg-white/5 p-0.5"
            role="radiogroup"
            aria-label="Mode"
          >
            {MODES.map(([m, label, hint]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={form.mode === m}
                title={hint}
                onClick={() => put({ mode: m })}
                className={cx(
                  'flex-1 rounded-md px-3 py-1.5 text-xs font-medium',
                  form.mode === m ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </Group>
        <Field label="Repo under test" hint="A git repo with each entry's base commit">
          <Input value={form.repo} onChange={(v) => put({ repo: v })} placeholder="C:\dev\app" />
        </Field>
        {form.mode === 'agent' && (
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Agent"
              hint={set?.defaults?.agent ? `Set default: ${set.defaults.agent}` : undefined}
            >
              <Input
                value={form.agent}
                onChange={(v) => put({ agent: v })}
                placeholder={set?.defaults?.agent ?? 'claude:engineer'}
              />
            </Field>
            <Field label="Model">
              <Input
                value={form.model}
                onChange={(v) => put({ model: v })}
                placeholder="provider default"
              />
            </Field>
            <Field label="Effort">
              <Input
                value={form.effort}
                onChange={(v) => put({ effort: v })}
                placeholder="provider default"
              />
            </Field>
            <Field label="Repeats per entry">
              <Input
                value={form.repeat}
                type="number"
                onChange={(v) => put({ repeat: v })}
                placeholder={String(set?.defaults?.repeat ?? 1)}
              />
            </Field>
            <Field label="Budget per attempt (min)">
              <Input
                value={form.budget}
                type="number"
                onChange={(v) => put({ budget: v })}
                placeholder={String(set?.defaults?.budget ?? 30)}
              />
            </Field>
            <Field label="Cost cap (USD)" hint="No attempt starts once the run cost this much">
              <Input
                value={form.maxUsd}
                type="number"
                onChange={(v) => put({ maxUsd: v })}
                placeholder="none"
              />
            </Field>
          </div>
        )}
        <Field label="Hidden tests folder" hint="Outside the repo under test">
          <Input
            value={form.hidden}
            onChange={(v) => put({ hidden: v })}
            placeholder={set?.hiddenDir ?? 'none'}
          />
        </Field>
        {form.mode === 'reference' && (
          <Field label="Reference patches folder" hint="Holds <entry>.patch for each entry">
            <Input value={form.reference} onChange={(v) => put({ reference: v })} />
          </Field>
        )}
        {plan && <PlanBox plan={plan} />}
        {plan?.spends && (
          <label className="flex items-start gap-2 text-sm text-warn">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1"
            />
            I understand this run spends tokens on my {plan.agent.split(':')[0]} account.
          </label>
        )}
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          {!plan ? (
            <Button
              kind="primary"
              disabled={act.busy || !form.set || !form.repo.trim()}
              onClick={review}
            >
              Review plan
            </Button>
          ) : (
            <Button
              kind={plan.spends ? 'danger' : 'primary'}
              icon={Play}
              disabled={act.busy || (plan.spends && !agreed)}
              onClick={start}
            >
              {plan.spends ? `Start ${plan.attempts.length} agent runs` : 'Start run'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** A dry run's plan: entries × repeats, who runs, the budget, and what it costs. */
export function PlanBox({ plan }: { plan: BenchPlan }) {
  const budgets = [...new Set(plan.attempts.map((a) => a.budgetMin))];
  return (
    <div className="panel flex flex-col gap-2 p-3" data-testid="bench-plan">
      <div className="label-caps">Plan</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div>
          <div className="text-xs text-fg-4">Entries × repeats</div>
          <div data-testid="bench-plan-size">
            {plan.entries.length} × {plan.repeat} = {plan.attempts.length} attempt
            {plan.attempts.length === 1 ? '' : 's'}
          </div>
        </div>
        <div>
          <div className="text-xs text-fg-4">Agent</div>
          <div>{whoRan(plan)}</div>
        </div>
        {plan.spends && (
          <>
            <div>
              <div className="text-xs text-fg-4">Budget per attempt</div>
              <div>{budgets.join(', ')} min</div>
            </div>
            <div>
              <div className="text-xs text-fg-4">Agent time at most</div>
              <div>{plan.maxMinutes} min</div>
            </div>
            {plan.maxUsd !== undefined && (
              <div data-testid="bench-plan-cap">
                <div className="text-xs text-fg-4">Cost cap</div>
                <div>{usd(plan.maxUsd)}</div>
              </div>
            )}
          </>
        )}
      </div>
      {plan.skipped.length > 0 && (
        <div className="text-xs text-fg-3">
          No reference patch, skipped: {plan.skipped.join(', ')}
        </div>
      )}
      {plan.spends ? (
        <div
          className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn ring-1 ring-warn/30 ring-inset"
          data-testid="bench-cost-warning"
        >
          <Coins size={16} className="mt-0.5 shrink-0" />
          <span>
            This run starts {plan.attempts.length} {plan.agent} session
            {plan.attempts.length === 1 ? '' : 's'}, one at a time. Each spends tokens until it ends
            or its budget runs out, up to {plan.maxMinutes} minutes of agent time in all
            {plan.maxUsd !== undefined
              ? `, and no attempt starts once the run cost ${usd(plan.maxUsd)}`
              : ''}
            . Try two or three entries and one repeat first.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 text-sm text-ok" data-testid="bench-free">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          {plan.mode === 'reference'
            ? 'Reference mode applies the patches and runs no agent: it costs nothing.'
            : 'No-agent mode changes nothing and runs no agent: it costs nothing.'}
        </div>
      )}
      <details className="text-xs text-fg-3">
        <summary className="cursor-pointer">Dry run output</summary>
        <pre className="mt-1 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
          {plan.lines.join('\n')}
        </pre>
      </details>
    </div>
  );
}

/** A warning line for a set that does not read. */
export function SetError({ set }: { set: BenchSetView }) {
  return (
    <div className="flex items-start gap-1.5 text-xs text-bad">
      <TriangleAlert size={13} className="mt-0.5 shrink-0" />
      <span className="min-w-0 break-words">{set.error}</span>
    </div>
  );
}
