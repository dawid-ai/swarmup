// A milestone in the task panel (AO-0110): its goal and `done_when`, the plan table, Approve
// plan, Edit and Send back while a plan waits, and the check history after. Approve plan and
// Send back post to the routes behind `swarmup plan approve` and `swarmup plan reject`, so the
// plan's rules live in core alone; what swarmupd refuses shows here as it says it.
import {
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardCheck,
  Flag,
  ListChecks,
  PenLine,
  Plus,
  Replace,
  Target,
  Trash2,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, q, refreshSoon, useData } from '../api';
import { Button, ErrorLine, StatusTag, TextArea, toast, useAction, Who, cx } from '../components';
import { ago } from '../lib/format';
import type { EditRow } from '../lib/plan';
import {
  addRow,
  checkHistory,
  editRows,
  minutesText,
  moveRow,
  planEdited,
  planOf,
  planSize,
  removeRow,
  replaceRow,
  rowsMinutes,
} from '../lib/plan';
import type { OpsEvent, PlanReport, PlanRow } from '../types';
import { Markdown } from './markdown';

/** The types a plan item's task may have; the empty choice leaves it to the default, `task`. */
const TYPES: Array<[string, string]> = [
  ['', 'task'],
  ['bug', 'bug'],
  ['docs', 'docs'],
];
const PRIORITIES: Array<[string, string]> = [
  ['', "milestone's"],
  ['p0', 'p0'],
  ['p1', 'p1'],
  ['p2', 'p2'],
  ['p3', 'p3'],
];

const FIELD =
  'h-8 w-full rounded-lg border border-white/10 bg-ink-950/60 px-2 text-xs outline-none transition placeholder:text-fg-4 focus:border-signal/60 disabled:cursor-not-allowed disabled:opacity-55';

export function MilestonePlan(props: {
  /** The milestone, as the panel names it. */
  id: string;
  /** The milestone's body: its goal. */
  goal: string;
  events: readonly OpsEvent[];
  nav: Nav;
  /** Opens the plan that waits in edit mode, as the screenshot run asks. */
  edit?: boolean;
  /** A write went through: `res` holds the events it wrote. */
  onWrote: (res: unknown) => void;
}) {
  const { id, nav } = props;
  const plan = useData<PlanReport>(`/api/tasks/${q(id)}/plan`);
  const p = plan.data;
  const pending = p?.pending ?? null;
  const [rows, setRows] = useState<EditRow[] | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const act = useAction();
  // Only a person approves a plan or sends it back; core refuses anyone else.
  const person = Boolean(nav.me?.startsWith('human:'));
  // `edit` may arrive after the panel opened, and the plan after that: enter edit mode once.
  const opened = useRef(false);
  useEffect(() => {
    if (!props.edit || opened.current || !pending) return;
    opened.current = true;
    setRows(editRows(pending.items));
  }, [props.edit, pending]);

  const edited = rows !== null && pending !== null && planEdited(rows, pending.items);
  const approve = (): void => {
    if (!pending || act.busy) return;
    const body = {
      as: nav.me,
      // Only an edited plan is sent: the approval then records its diff against the proposal.
      ...(rows && edited ? { plan: planOf(rows, pending.notes) } : {}),
    };
    act.run(async () => {
      const res = await api<{ created?: unknown[] }>(
        'POST',
        `/api/tasks/${q(id)}/plan-approve`,
        body,
      );
      const n = res.created?.length ?? 0;
      toast(`Plan of ${p?.id ?? id} approved: ${n} task${n === 1 ? '' : 's'} created`);
      setRows(null);
      plan.reload();
      refreshSoon();
      props.onWrote(res);
    });
  };
  const sendBack = (): void => {
    if (!pending || act.busy || !back?.trim()) return;
    act.run(async () => {
      const res = await api('POST', `/api/tasks/${q(id)}/plan-reject`, {
        as: nav.me,
        message: back,
      });
      toast(`Plan of ${p?.id ?? id} sent back to ${pending.actor}`);
      setBack(null);
      setRows(null);
      plan.reload();
      refreshSoon();
      props.onWrote(res);
    });
  };

  const history = checkHistory(props.events);
  const live = rows ? rowsMinutes(rows) : null;
  return (
    <div data-milestone-plan className="mt-4 flex flex-col gap-4">
      <div className="panel p-4">
        <div className="label-caps flex items-center gap-1.5">
          <Flag size={12} /> Goal
        </div>
        {props.goal.trim() ? (
          <Markdown text={props.goal} className="md-tight mt-1.5 text-sm text-fg-2" />
        ) : (
          <div className="mt-1.5 text-sm text-fg-4">No goal written.</div>
        )}
        <div className="label-caps mt-3 flex items-center gap-1.5">
          <Target size={12} /> Done when
        </div>
        <div className="mt-1.5 text-sm text-fg-2" data-done-when>
          {p?.doneWhen ? (
            <Markdown inline text={p.doneWhen} />
          ) : (
            <span className="text-fg-4">-</span>
          )}
        </div>
      </div>

      <ErrorLine error={plan.error} />

      {p && p.approval && (
        <section data-plan-approved>
          <h3 className="label-caps mb-2 flex items-center gap-1.5">
            <ListChecks size={12} /> Plan
            <span className="font-normal tracking-normal text-fg-4 normal-case">
              · {p.items.filter((r) => r.status === 'done').length}/{p.items.length} done,{' '}
              {minutesText(p.spent)} of {minutesText(p.minutes)}
              {p.planner ? `, planned by ${p.planner}` : ''}
            </span>
          </h3>
          {p.incomplete && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/8 px-3 py-2 text-xs text-warn">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              <span>
                The plan is not applied in full
                {p.incomplete.missing.length > 0 &&
                  `; no task yet for ${p.incomplete.missing.join(', ')}`}
                {p.incomplete.unapplied.length > 0 &&
                  `; change not applied to ${p.incomplete.unapplied.join(', ')}`}
                . swarmupd finishes it at its next tick.
              </span>
            </div>
          )}
          <PlanTable rows={p.items} tasks nav={nav} root={p.root} />
        </section>
      )}

      {p && pending && (
        <section
          data-plan-pending
          className="rounded-xl border border-[#ff7eb6]/25 bg-[#ff7eb6]/[0.04] p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps !text-[#ff7eb6]">
              {p.approval ? 'Plan change waits for approval' : 'Plan waits for approval'}
            </span>
            <span className="font-mono text-xs text-fg-2" data-plan-size>
              {live
                ? `${planSize(rows!.length, live.minutes)}${live.bad > 0 ? ` (${live.bad} without an estimate)` : ''}`
                : planSize(pending.items.length, pending.minutes)}
            </span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-fg-4">
              by <Who id={pending.actor} size="xs" plain />
            </span>
          </div>
          {pending.stale && (
            <div className="mt-2 flex items-start gap-2 text-xs text-warn">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              The plan changed since this proposal, so it cannot be approved. Send it back; the
              planner proposes again from the plan as it is now.
            </div>
          )}
          {pending.notes && (
            <Markdown text={pending.notes} className="md-tight mt-2 text-sm text-fg-3" />
          )}
          {pending.changes.length > 0 && !rows && (
            <ul
              className="mt-2 flex flex-col gap-0.5 font-mono text-[11px] text-fg-3"
              data-plan-changes
            >
              {pending.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}

          {rows ? (
            <Editor rows={rows} onChange={setRows} />
          ) : (
            <div className="mt-3">
              <PlanTable rows={pending.items} tasks={Boolean(p.approval)} nav={nav} root={p.root} />
            </div>
          )}

          {person && back !== null && (
            <div className="mt-3 flex flex-col gap-2" data-send-back>
              <TextArea
                value={back}
                onChange={setBack}
                rows={2}
                placeholder={`What ${pending.actor} should change in the plan`}
              />
            </div>
          )}
          {person && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {back === null ? (
                <>
                  <Button
                    kind="primary"
                    icon={Check}
                    disabled={act.busy || pending.stale || (rows !== null && rows.length === 0)}
                    title={
                      edited
                        ? 'Approves the plan as edited; the approval records what you changed'
                        : 'Creates one task per item; the milestone then waits for them'
                    }
                    onClick={approve}
                  >
                    Approve plan
                  </Button>
                  {rows ? (
                    <Button icon={X} disabled={act.busy} onClick={() => setRows(null)}>
                      Cancel edit
                    </Button>
                  ) : (
                    <Button
                      icon={PenLine}
                      disabled={act.busy || pending.stale}
                      title="Change, add, remove or reorder items before you approve"
                      onClick={() => setRows(editRows(pending.items))}
                    >
                      Edit
                    </Button>
                  )}
                  <Button
                    icon={Undo2}
                    disabled={act.busy}
                    title={`Returns the plan to ${pending.actor} with your note`}
                    onClick={() => setBack('')}
                  >
                    Send back
                  </Button>
                  {edited && <span className="text-xs text-warn">edited</span>}
                </>
              ) : (
                <>
                  <Button
                    kind="primary"
                    icon={Undo2}
                    disabled={act.busy || !back.trim()}
                    title={back.trim() ? undefined : 'Write what to change first'}
                    onClick={sendBack}
                  >
                    Send back
                  </Button>
                  <Button kind="ghost" disabled={act.busy} onClick={() => setBack(null)}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
          )}
          <div className="mt-2">
            <ErrorLine error={act.error} />
          </div>
        </section>
      )}

      {p && !p.approval && !pending && (
        <div className="text-sm text-fg-4" data-plan-none>
          No plan yet: its owner proposes one with <code>swarmup plan propose</code>.
        </div>
      )}

      {history.length > 0 && (
        <section data-check-history>
          <h3 className="label-caps mb-2 flex items-center gap-1.5">
            <ClipboardCheck size={12} /> Check history
          </h3>
          <ol className="flex flex-col gap-2">
            {history.map((s) => (
              <li
                key={s.event.id}
                className="rounded-lg border border-white/7 bg-white/[0.025] p-2.5"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={cx(
                      'font-medium',
                      s.tone === 'ok' ? 'text-ok' : s.tone === 'warn' ? 'text-warn' : 'text-info',
                    )}
                  >
                    {s.label}
                  </span>
                  <Who id={s.event.actor} size="xs" />
                  <span className="ml-auto text-fg-4">{ago(s.event.at)}</span>
                </div>
                {s.event.body.trim() && (
                  <Markdown text={s.event.body} clamp className="md-tight mt-1 text-sm text-fg-3" />
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/**
 * The plan table: each item with its owner and estimate, and with `tasks` its task id, status
 * and time spent. A click on a task id opens the task.
 */
function PlanTable(props: { rows: readonly PlanRow[]; tasks: boolean; nav: Nav; root: string }) {
  const { rows, tasks } = props;
  return (
    <table className="w-full border-collapse text-left text-xs" data-plan-table>
      <thead>
        <tr className="text-[10px] tracking-wider text-fg-4 uppercase">
          <th className="py-1 pr-2 font-medium">Item</th>
          {tasks && <th className="py-1 pr-2 font-medium">Task</th>}
          <th className="py-1 pr-2 font-medium">Owner</th>
          {tasks && <th className="py-1 pr-2 font-medium">Status</th>}
          <th className="py-1 pr-2 text-right font-medium">Estimate</th>
          {tasks && <th className="py-1 text-right font-medium">Spent</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-white/6 align-top" data-plan-row={r.key}>
            <td className="py-1.5 pr-2">
              <div className="text-sm text-fg">{r.title}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[11px] text-fg-4">
                <span>{r.key}</span>
                {r.after.length > 0 && <span>after {r.after.join(', ')}</span>}
                {r.for && <span>for {r.for}</span>}
                {r.review && <span>review {r.review}</span>}
                {r.origin && r.origin !== 'approve' && <span>{r.origin}</span>}
              </div>
              {r.done_when && <div className="mt-0.5 text-[11px] text-fg-3">{r.done_when}</div>}
            </td>
            {tasks && (
              <td className="py-1.5 pr-2 whitespace-nowrap">
                {r.task ? (
                  <button
                    type="button"
                    className="font-mono text-signal hover:underline"
                    onClick={() => props.nav.openTask(`${props.root}/${r.task}`)}
                  >
                    {r.task}
                  </button>
                ) : (
                  <span className="text-fg-4">-</span>
                )}
              </td>
            )}
            <td className="py-1.5 pr-2 whitespace-nowrap">
              <Who id={r.taskOwner ?? r.owner} size="xs" />
            </td>
            {tasks && (
              <td className="py-1.5 pr-2 whitespace-nowrap">
                {r.status ? <StatusTag status={r.status} /> : <span className="text-fg-4">-</span>}
              </td>
            )}
            <td className="py-1.5 pr-2 text-right font-mono whitespace-nowrap text-fg-2">
              {r.estimate}
            </td>
            {tasks && (
              <td className="py-1.5 text-right font-mono whitespace-nowrap text-fg-3">
                {r.spent !== undefined ? minutesText(r.spent) : '-'}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A text field of one row; `name` is the item field it edits. */
function Txt(props: {
  name: keyof EditRow;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  mono?: boolean;
  className?: string;
}) {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1', props.className)}>
      <span className="text-[10px] tracking-wider text-fg-4 uppercase">{props.label}</span>
      <input
        type="text"
        name={props.name}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className={cx(FIELD, props.mono && 'font-mono')}
      />
    </label>
  );
}

function Pick(props: {
  name: keyof EditRow;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] tracking-wider text-fg-4 uppercase">{props.label}</span>
      <select
        name={props.name}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className={FIELD}
      >
        {props.options.map(([v, label]) => (
          <option key={v} value={v} className="bg-ink-850">
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Edit mode: every item as a row of fields, with rows added, removed and reordered. A row whose
 * item already has a task keeps its title, `done_when`, reviewer, type and priority read-only,
 * since no event changes a task's file; **Replace item** swaps it for a new item.
 */
function Editor({ rows, onChange }: { rows: EditRow[]; onChange: (rows: EditRow[]) => void }) {
  const set = (uid: number, patch: Partial<EditRow>): void =>
    onChange(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  return (
    <div className="mt-3 flex flex-col gap-2" data-plan-editor>
      {rows.map((r, i) => {
        const fixed = Boolean(r.task);
        return (
          <div
            key={r.uid}
            data-edit-row={r.key}
            className="rounded-lg border border-white/8 bg-ink-900/70 p-2.5"
          >
            <div className="flex items-center gap-1.5">
              <span className="w-5 text-center font-mono text-[11px] text-fg-4">{i + 1}</span>
              <IconButton
                label="Move up"
                disabled={i === 0}
                onClick={() => onChange(moveRow(rows, r.uid, -1))}
              >
                <ArrowUp size={13} />
              </IconButton>
              <IconButton
                label="Move down"
                disabled={i === rows.length - 1}
                onClick={() => onChange(moveRow(rows, r.uid, 1))}
              >
                <ArrowDown size={13} />
              </IconButton>
              {fixed && (
                <span className="font-mono text-[11px] text-fg-3" title="The task this item has">
                  {r.key} · {r.task}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                {fixed && (
                  <Button
                    size="sm"
                    icon={Replace}
                    title={`Parks ${r.task} on approval and adds this item again under a new key, with every field editable`}
                    onClick={() => onChange(replaceRow(rows, r.uid))}
                  >
                    Replace item
                  </Button>
                )}
                <Button
                  size="sm"
                  kind="ghost"
                  icon={Trash2}
                  title={
                    fixed ? `Removes the item; the approval parks ${r.task}` : 'Removes the item'
                  }
                  onClick={() => onChange(removeRow(rows, r.uid))}
                >
                  Remove
                </Button>
              </span>
            </div>
            <div className="mt-2 grid grid-cols-[1fr_110px] gap-2">
              <Txt
                name="title"
                label="Title"
                value={r.title}
                disabled={fixed}
                onChange={(title) => set(r.uid, { title })}
              />
              {!fixed && (
                <Txt
                  name="key"
                  label="Key"
                  mono
                  value={r.key}
                  onChange={(key) => set(r.uid, { key })}
                />
              )}
            </div>
            <div className="mt-2 grid grid-cols-[1fr_80px_1fr] gap-2">
              <Txt
                name="owner"
                label="Owner"
                mono
                value={r.owner}
                placeholder="*:engineer"
                onChange={(owner) => set(r.uid, { owner })}
              />
              <Txt
                name="estimate"
                label="Estimate"
                mono
                value={r.estimate}
                placeholder="2h"
                onChange={(estimate) => set(r.uid, { estimate })}
              />
              <Txt
                name="after"
                label="After"
                mono
                value={r.after}
                placeholder="keys it waits for"
                onChange={(after) => set(r.uid, { after })}
              />
            </div>
            <div className="mt-2">
              <Txt
                name="done_when"
                label="Done when"
                value={r.done_when}
                disabled={fixed}
                placeholder="The item's check; the title when empty"
                onChange={(done_when) => set(r.uid, { done_when })}
              />
            </div>
            <div className="mt-2 grid grid-cols-[1fr_90px_110px] gap-2">
              <Txt
                name="review"
                label="Review"
                mono
                value={r.review}
                disabled={fixed}
                placeholder="codex:qa"
                onChange={(review) => set(r.uid, { review })}
              />
              <Pick
                name="type"
                label="Type"
                value={r.type}
                disabled={fixed}
                options={TYPES}
                onChange={(type) => set(r.uid, { type })}
              />
              <Pick
                name="priority"
                label="Priority"
                value={r.priority}
                disabled={fixed}
                options={PRIORITIES}
                onChange={(priority) => set(r.uid, { priority })}
              />
            </div>
          </div>
        );
      })}
      <div>
        <Button size="sm" icon={Plus} onClick={() => onChange(addRow(rows))}>
          Add item
        </Button>
      </div>
    </div>
  );
}

function IconButton(props: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className="rounded-md p-1 text-fg-3 transition hover:bg-white/8 hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
    >
      {props.children}
    </button>
  );
}
