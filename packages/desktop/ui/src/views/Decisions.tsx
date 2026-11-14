import { Clock, Gavel, Replace, ScrollText, Trophy, Users, Vote } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import {
  Avatar,
  Button,
  Empty,
  ErrorLine,
  Input,
  Section,
  toast,
  Toggle,
  useAction,
  Who,
  cx,
} from '../components';
import { DECISION_TEXT_MAX, decisionLength, logNotes, logOrigin, scopeText } from '../lib/decision';
import { ago, localTime } from '../lib/format';
import type { Decision, LogEntry } from '../types';
import { Markdown } from '../ui/markdown';
import { RefText } from '../ui/refs';

type Tab = 'log' | 'votes';

/**
 * Two lists under one view: the decision log (what people decided, as `swarmup decisions --log`
 * prints it) and the votes. `selected` is a vote to show (`root/D-0001`), or `log` or `votes` to
 * open that tab. Without it, open votes come first: they wait for someone; else the log.
 */
export function Decisions({ nav, selected }: { nav: Nav; selected?: string }) {
  const vote = selected && selected !== 'log' && selected !== 'votes' ? selected : undefined;
  const [picked, setPicked] = useState<Tab | null>(
    selected === 'log' ? 'log' : selected ? 'votes' : null,
  );
  const votes = useData<Decision[]>('/api/decisions');
  const open = (votes.data ?? []).filter((d) => !d.outcome).length;
  const tab: Tab | null = picked ?? (votes.data ? (open > 0 ? 'votes' : 'log') : null);
  // A vote opened from search may be decided: show decided ones then.
  const [decided, setDecided] = useState(Boolean(vote));
  const [superseded, setSuperseded] = useState(false);
  const tabs = (
    <div role="tablist" className="inline-flex rounded-lg bg-white/5 p-0.5 ring-1 ring-white/8">
      {(
        [
          ['log', 'Log', undefined],
          ['votes', 'Votes', open || undefined],
        ] as const
      ).map(([key, label, count]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => setPicked(key)}
          className={cx(
            'inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition',
            tab === key ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
          )}
        >
          {label}
          {count !== undefined && (
            <span className="rounded-full bg-white/10 px-1.5 font-mono text-[10px]">{count}</span>
          )}
        </button>
      ))}
    </div>
  );
  return (
    <Section
      title="Decisions"
      icon={Vote}
      subtitle={
        tab === 'log'
          ? 'What people decided, newest first; agents follow the ones in force for their task'
          : votes.data
            ? `${open} open · agents and people vote; ties and missing quorum go to a person`
            : 'Agents and people vote; ties and missing quorum go to a person'
      }
      actions={
        <div className="flex items-center gap-4">
          {tab === 'votes' && (
            <Toggle checked={decided} onChange={setDecided} label="Include decided" />
          )}
          {tab === 'log' && (
            <Toggle checked={superseded} onChange={setSuperseded} label="Include superseded" />
          )}
          {tabs}
        </div>
      }
    >
      {tab === 'votes' && <Votes nav={nav} selected={vote} all={decided} />}
      {tab === 'log' && (
        <DecisionLog nav={nav} all={superseded} onVote={() => setPicked('votes')} />
      )}
    </Section>
  );
}

/** A date as the log prints it: `2026-11-03`, local. */
const day = (at: string): string => localTime(at).slice(0, 10);

/**
 * The decision log: one row per recorded decision or decided vote, with its scope, where the
 * words are, and how it was replaced. `all` adds the superseded ones (`--all`).
 */
function DecisionLog({ nav, all, onVote }: { nav: Nav; all: boolean; onVote: () => void }) {
  const { data, error, reload } = useData<LogEntry[]>(
    all ? '/api/decisions?log&all' : '/api/decisions?log',
  );
  const [superseding, setSuperseding] = useState<string | null>(null);
  // An id alone is not unique across roots: each row carries its root when there are several.
  const roots = new Set((data ?? []).map((e) => e.root)).size > 1;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2.5 px-6 py-5">
      <ErrorLine error={error} />
      {data && data.length === 0 && (
        <Empty icon={ScrollText} title="No decisions in force">
          Mark a decision with the Decision toggle when you answer, review, comment or triage, or
          record one with <code>swarmup decision</code>. It shows here and in the prompt of every
          run it applies to.
          {!all && ' Turn on Include superseded to see replaced ones.'}
        </Empty>
      )}
      {data?.map((e) => {
        const ref = `${e.root}/${e.id}`;
        return (
          <LogRow
            key={ref}
            e={e}
            nav={nav}
            roots={roots}
            onVote={onVote}
            superseding={superseding === ref}
            onSupersede={(on) => setSuperseding(on ? ref : null)}
            onRecorded={() => {
              setSuperseding(null);
              reload();
              refreshSoon();
            }}
          />
        );
      })}
    </div>
  );
}

function LogRow({
  e,
  nav,
  roots,
  onVote,
  superseding,
  onSupersede,
  onRecorded,
}: {
  e: LogEntry;
  nav: Nav;
  roots: boolean;
  onVote: () => void;
  superseding: boolean;
  onSupersede: (on: boolean) => void;
  onRecorded: () => void;
}) {
  const origin = logOrigin(e);
  const notes = logNotes(e);
  const old = e.state === 'superseded';
  return (
    <article
      data-log-entry={e.id}
      data-state={e.state}
      className={cx('panel animate-rise px-4 py-3', old && 'opacity-60')}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono text-xs text-fg-3">{roots ? `${e.root}/${e.id}` : e.id}</span>
        <span className="font-mono text-xs text-fg-4" title={new Date(e.at).toLocaleString()}>
          {day(e.at)}
        </span>
        <span
          data-scope
          className="rounded-md bg-signal/8 px-1.5 py-px font-mono text-[11px] text-signal ring-1 ring-signal/20 ring-inset"
          title={
            e.scope === 'tree'
              ? `Applies to ${e.task} and the tasks below it`
              : e.project === undefined
                ? 'Applies to every task of the root'
                : `Applies to every task of project ${e.project}`
          }
        >
          {scopeText(e)}
        </span>
        {old && (
          <span className="rounded-md bg-white/6 px-1.5 py-px text-[11px] text-fg-3">
            superseded
          </span>
        )}
        {nav.me?.startsWith('human:') && !old && (
          <span className="ml-auto">
            <Button
              size="sm"
              kind={superseding ? 'plain' : 'ghost'}
              icon={Replace}
              title={`Opens a new decision that replaces ${e.id}`}
              onClick={() => onSupersede(!superseding)}
            >
              Supersede
            </Button>
          </span>
        )}
      </div>
      <div className={cx('mt-1.5 text-sm text-fg', old && 'line-through decoration-white/30')}>
        <RefText text={e.text} />
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-4">
        {origin.kind === 'event' && (
          <button
            type="button"
            className="font-mono text-signal hover:underline"
            title="Opens the event that holds the decider's words"
            onClick={() => nav.openTask(`${e.root}/${origin.ref}`)}
          >
            {origin.task}
          </button>
        )}
        {origin.kind === 'chat' && <span>PM chat</span>}
        {origin.kind === 'vote' && (
          <button type="button" className="text-signal hover:underline" onClick={onVote}>
            vote
          </button>
        )}
        {origin.kind === 'file' && <span className="font-mono">{origin.file}</span>}
        {origin.kind === 'none' && e.scope === 'project' && e.task && (
          <button
            type="button"
            className="font-mono text-signal hover:underline"
            onClick={() => nav.openTask(`${e.root}/${e.task}`)}
          >
            {e.task}
          </button>
        )}
        <Who id={e.by} size="xs" />
        {e.recorded_by && (
          <span className="inline-flex items-center gap-1">
            recorded by <Who id={e.recorded_by} size="xs" plain />
          </span>
        )}
        {e.supersedes.length > 0 && <span>· supersedes {e.supersedes.join(', ')}</span>}
        {e.narrows.length > 0 && <span>· narrows {e.narrows.join(', ')}</span>}
        {notes.map((n) => (
          <span key={n} data-log-note>
            · {n}
          </span>
        ))}
      </div>
      {(e.revised ?? []).map((r) => (
        <div key={`${r.at}:${r.choice}`} className="mt-1 text-xs text-fg-4">
          {day(r.at)} revised: was '{r.choice}' ({r.by})
        </div>
      ))}
      {superseding && (
        <SupersedeForm e={e} me={nav.me} onCancel={() => onSupersede(false)} onDone={onRecorded} />
      )}
    </article>
  );
}

/**
 * A new record that replaces `e` (`swarmup decision TEXT --supersedes ID`): one line, and the
 * scope it takes, which is the old decision's because no scope is sent.
 */
function SupersedeForm({
  e,
  me,
  onCancel,
  onDone,
}: {
  e: LogEntry;
  me: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [line, setLine] = useState('');
  const act = useAction();
  const n = decisionLength(line);
  const over = n > DECISION_TEXT_MAX;
  const ready = n > 0 && !over && !act.busy;
  const record = (): void => {
    if (!ready) return;
    act.run(
      () =>
        api<{ id: string }>('POST', '/api/decisions', {
          as: me,
          root: e.root,
          text: line.trim(),
          supersedes: [e.id],
        }).then((res) => toast(`Recorded ${res.id}: it supersedes ${e.id}`)),
      onDone,
    );
  };
  return (
    <div
      data-supersede-form
      className="mt-3 flex flex-col gap-2 rounded-lg bg-white/4 p-3 ring-1 ring-white/8 ring-inset"
    >
      <div className="label-caps">New decision · supersedes {e.id}</div>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            value={line}
            onChange={setLine}
            onEnter={record}
            autoFocus
            placeholder="The new decision, in one line"
            className={cx('w-full pr-16', over && '!border-bad/60')}
          />
          <span
            data-decision-count
            className={cx(
              'pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[11px]',
              over ? 'text-bad' : 'text-fg-4',
            )}
          >
            {n}/{DECISION_TEXT_MAX}
          </span>
        </div>
        <Button kind="primary" size="sm" icon={Gavel} disabled={!ready} onClick={record}>
          Record
        </Button>
        <Button kind="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-fg-4">
        Takes the scope of {e.id}: {scopeText(e)}. {e.id} leaves the list; Include superseded shows
        it.
      </p>
      {over && (
        <p data-decision-error className="text-xs text-bad">
          A decision is one line of {DECISION_TEXT_MAX} characters at most; this one has {n}
        </p>
      )}
      <ErrorLine error={act.error} />
    </div>
  );
}

function Votes({ nav, selected, all }: { nav: Nav; selected?: string; all: boolean }) {
  const { data, error } = useData<Decision[]>(all ? '/api/decisions?all' : '/api/decisions');
  return (
    <>
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-6 py-5">
        <ErrorLine error={error} />
        {data && data.length === 0 && (
          <Empty icon={Vote} title="No open votes">
            When an agent calls a vote, the options and ballots show here.
            {!all && ' Turn on Include decided to see past results.'}
          </Empty>
        )}
        {data?.map((d, i) => (
          <DecisionCard
            key={`${d.root}/${d.meta.id}`}
            d={d}
            nav={nav}
            delay={Math.min(i * 50, 300)}
            picked={selected === `${d.root}/${d.meta.id}`}
          />
        ))}
      </div>
    </>
  );
}

const STATE: Record<string, { label: string; color: string }> = {
  open: { label: 'Voting', color: '#5ce1e6' },
  ready: { label: 'Ready', color: '#3ddc97' },
  tie: { label: 'Tie', color: '#ffb547' },
  'no-quorum': { label: 'No quorum', color: '#ffb547' },
  decided: { label: 'Decided', color: '#7f8899' },
};

/** One color per option, in order, so each bar reads as its own lane. */
const LANES = ['#5ce1e6', '#b18cff', '#ff9f43', '#5aa9ff', '#ff7eb6', '#a3e635', '#ffd166'];

function DecisionCard({
  d,
  nav,
  delay,
  picked,
}: {
  d: Decision;
  nav: Nav;
  delay: number;
  picked?: boolean;
}) {
  const card = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (picked) card.current?.scrollIntoView({ block: 'center' });
  }, [picked]);
  const [reason, setReason] = useState('');
  const act = useAction();
  const t = d.tally;
  const max = Math.max(1, ...Object.values(t.counts));
  const ref = `${d.root}/${d.meta.id}`;
  const send = (action: 'vote' | 'decide', choice: string) =>
    act.run(
      () =>
        api('POST', `/api/decisions/${q(ref)}/${action}`, { as: nav.me, choice, message: reason }),
      refreshSoon,
    );
  const me = nav.me;
  const runtime = me?.split(':')[0];
  const eligible =
    !!me &&
    (!d.meta.voters ||
      d.meta.voters.some((v) => v === me || (v.endsWith(':*') && v.split(':')[0] === runtime)));
  const voted = d.ballots.some((b) => b.actor === me);
  // Voting while it is open; deciding only when the vote ended in a tie or without quorum, or to
  // record a ready result. A voter following a vote from the inbox never finalizes by accident.
  const canVote = !d.outcome && t.state === 'open' && eligible && !voted;
  const canDecide =
    !d.outcome && !!me && (t.state === 'tie' || t.state === 'no-quorum' || t.state === 'ready');
  const decideFor = (opt: string): boolean =>
    canDecide && (t.state !== 'ready' || t.leaders[0] === opt);
  const state = STATE[t.state] ?? STATE.open!;
  const quorumPct = Math.min(100, (t.votes / Math.max(1, d.meta.quorum)) * 100);
  return (
    <article
      ref={card}
      className={cx(
        'panel animate-rise relative overflow-hidden p-5',
        d.outcome && !picked && 'opacity-85',
        picked && 'ring-2 ring-signal/60',
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
        style={{ background: `linear-gradient(90deg, transparent, ${state.color}, transparent)` }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-mono text-xs text-fg-4">{d.meta.id}</span>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
          style={{
            color: state.color,
            background: `color-mix(in oklab, ${state.color} 12%, transparent)`,
            boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${state.color} 28%, transparent)`,
          }}
        >
          <span
            className={cx('h-1.5 w-1.5 rounded-full', t.state === 'open' && 'animate-pulse-dot')}
            style={{ background: state.color, color: state.color }}
          />
          {state.label}
        </span>
        <span className="flex items-center gap-2 text-xs text-fg-3" title="Votes cast / quorum">
          <Users size={12} />
          <span className="font-mono">
            {t.votes}/{d.meta.quorum}
          </span>
          <span className="h-1 w-16 overflow-hidden rounded-full bg-ink-600">
            <span
              className="block h-full rounded-full"
              style={{ width: `${quorumPct}%`, background: state.color }}
            />
          </span>
        </span>
        {d.meta.deadline && (
          <span className="flex items-center gap-1 text-xs text-fg-3">
            <Clock size={12} /> closes {ago(d.meta.deadline)}
          </span>
        )}
        <span className="flex items-center gap-1.5 text-xs text-fg-4">
          by <Who id={d.meta.created_by} size="xs" />
        </span>
        {d.meta.task && (
          <button
            className="ml-auto rounded-md bg-signal/8 px-1.5 py-px font-mono text-[11px] text-signal ring-1 ring-signal/20 transition ring-inset hover:bg-signal/15"
            onClick={() => nav.openTask(`${d.root}/${d.meta.task}`)}
          >
            {d.meta.task}
          </button>
        )}
      </div>

      <h2 className="mt-3 font-display text-lg leading-snug font-semibold tracking-wide">
        <Markdown inline text={d.meta.question} />
      </h2>
      {d.body && <Markdown text={d.body} className="md-tight mt-1 text-sm text-fg-3" />}

      <div className="mt-4 flex flex-col gap-2">
        {d.meta.options.map((opt, i) => {
          const count = t.counts[opt] ?? 0;
          const chosen = d.outcome?.choice === opt;
          const leading = !d.outcome && count > 0 && t.leaders.includes(opt);
          const lane = chosen ? '#3ddc97' : LANES[i % LANES.length]!;
          const voters = d.ballots.filter((b) => b.choice === opt);
          const pct = t.votes ? Math.round((count / t.votes) * 100) : 0;
          return (
            <div
              key={opt}
              className="relative flex items-center gap-3 overflow-hidden rounded-xl px-3 py-2.5"
              style={{
                background: 'rgb(255 255 255 / 0.02)',
                boxShadow: `inset 0 0 0 1px ${
                  chosen || leading
                    ? `color-mix(in oklab, ${lane} 45%, transparent)`
                    : 'rgb(255 255 255 / 0.06)'
                }`,
              }}
            >
              <div
                className="absolute inset-y-0 left-0 transition-all duration-500"
                style={{
                  width: `${(count / max) * 100}%`,
                  background: `linear-gradient(90deg, color-mix(in oklab, ${lane} 8%, transparent), color-mix(in oklab, ${lane} 22%, transparent))`,
                  boxShadow: count ? `inset -2px 0 0 ${lane}` : undefined,
                }}
              />
              <span
                className="relative h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: lane, boxShadow: `0 0 10px ${lane}` }}
              />
              <span className="relative min-w-0 flex-1 truncate text-sm font-medium text-fg">
                <RefText text={opt} />
              </span>
              {chosen && (
                <span className="relative inline-flex items-center gap-1 rounded-full bg-ok/15 px-2 py-0.5 text-xs font-medium text-ok">
                  <Trophy size={12} /> chosen
                </span>
              )}
              {voters.length > 0 && (
                <span className="relative flex -space-x-1.5">
                  {voters.slice(0, 6).map((b) => (
                    <span key={b.actor} className="rounded-[30%] ring-2 ring-ink-850">
                      <Avatar id={b.actor} size={20} />
                    </span>
                  ))}
                  {voters.length > 6 && (
                    <span className="flex h-5 items-center pl-2.5 text-[10px] text-fg-3">
                      +{voters.length - 6}
                    </span>
                  )}
                </span>
              )}
              <span className="relative w-14 text-right">
                <span
                  className="font-display text-lg leading-none font-semibold"
                  style={{ color: count ? lane : '#566074' }}
                >
                  {count}
                </span>
                <span className="ml-1 text-[10px] text-fg-4">{pct}%</span>
              </span>
              {canVote && (
                <span className="relative">
                  <Button
                    kind="primary"
                    size="sm"
                    icon={Vote}
                    disabled={act.busy}
                    onClick={() => send('vote', opt)}
                  >
                    Vote
                  </Button>
                </span>
              )}
              {decideFor(opt) && (
                <span className="relative">
                  <Button
                    size="sm"
                    icon={Gavel}
                    disabled={act.busy}
                    onClick={() => send('decide', opt)}
                  >
                    {t.state === 'ready' ? 'Record result' : 'Decide'}
                  </Button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {d.ballots.length > 0 && (
        <div className="mt-4">
          <div className="label-caps mb-1.5">Ballots</div>
          <ul className="flex flex-col gap-1.5">
            {d.ballots.map((b) => {
              const idx = d.meta.options.indexOf(b.choice);
              const lane =
                d.outcome?.choice === b.choice
                  ? '#3ddc97'
                  : LANES[(idx < 0 ? 0 : idx) % LANES.length]!;
              return (
                <li key={b.actor} className="flex items-start gap-2 text-xs">
                  <Who id={b.actor} />
                  <span className="text-fg-4">voted</span>
                  <span
                    className="rounded-full px-1.5 py-px font-medium"
                    style={{
                      color: lane,
                      background: `color-mix(in oklab, ${lane} 12%, transparent)`,
                    }}
                  >
                    <RefText text={b.choice} />
                  </span>
                  {b.body && <Markdown text={b.body} className="md-tight min-w-0 text-fg-3" />}
                  <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-4">
                    {ago(b.at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {t.missing.length > 0 && !d.outcome && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-4">
          <span>Waiting for</span>
          {t.missing.map((m) => (
            <span key={m} className="opacity-75">
              <Who id={m} size="xs" />
            </span>
          ))}
        </div>
      )}
      {d.outcome ? (
        <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-ok/8 px-3 py-2.5 text-sm text-fg-2 ring-1 ring-ok/25 ring-inset">
          <Trophy size={16} className="mt-0.5 shrink-0 text-ok" />
          <div className="min-w-0">
            Decided{' '}
            <b className="text-ok">
              <RefText text={d.outcome.choice} />
            </b>{' '}
            by <Who id={d.outcome.decided_by} /> {ago(d.outcome.at)}
            {d.outcome.body && (
              <Markdown text={d.outcome.body} className="md-tight mt-1 text-fg-3" />
            )}
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <Input
            value={reason}
            onChange={setReason}
            placeholder={
              canVote
                ? 'Why (optional, recorded with your ballot; ballots are final)'
                : 'Why (optional, recorded with the decision)'
            }
            className="w-full"
          />
        </div>
      )}
      {act.error && (
        <div className="mt-2">
          <ErrorLine error={act.error} />
        </div>
      )}
    </article>
  );
}
