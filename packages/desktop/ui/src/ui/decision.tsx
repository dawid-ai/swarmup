import { Gavel, GitCompareArrows } from 'lucide-react';
import { useState } from 'react';
import { q, useData } from '../api';
import { Button, Input, Toggle, cx } from '../components';
import type { MarkValue } from '../lib/decision';
import {
  contradicted,
  DECISION_TEXT_MAX,
  decisionLength,
  firstSentence,
  markFields,
  markProblem,
  scopeText,
} from '../lib/decision';
import { localTime } from '../lib/format';
import type { LogEntry } from '../types';
import { RefText } from './refs';

/** The **Decision** control of one form: its value, what the write carries, and why it waits. */
export interface Mark extends MarkValue {
  setOn: (on: boolean) => void;
  setLine: (line: string) => void;
  setProjectWide: (on: boolean) => void;
  setTreeOnly: (on: boolean) => void;
  /** The scope of `replaces`, as the log prints it, when the app knows it. */
  replacesScope?: string;
  /** False when `replaces` covers this task's tree and no more: nothing smaller to narrow to. */
  canNarrow: boolean;
  /** **Accept change**: the mark supersedes decision `id`. */
  replace: (id: string, scope?: string, canNarrow?: boolean) => void;
  /** Off and empty again, after the form sent it. */
  reset: () => void;
  /** Why the form must not send yet, or null. */
  problem: string | null;
  /** The fields the task write carries; none while it is off. */
  fields: Record<string, unknown>;
}

/**
 * The state of a form's **Decision** control (AO-0109). The line starts as the first sentence of
 * `message` and follows it until the person edits the line.
 */
export function useDecisionMark(message: string): Mark {
  const [on, setOn] = useState(false);
  const [edited, setEdited] = useState<string | null>(null);
  const [projectWide, setProjectWide] = useState(false);
  const [replaces, setReplaces] = useState<{ id: string; scope?: string; canNarrow: boolean }>();
  const [treeOnly, setTreeOnly] = useState(false);
  const value: MarkValue = {
    on,
    line: edited ?? firstSentence(message),
    projectWide,
    replaces: replaces?.id,
    treeOnly: treeOnly && replaces?.canNarrow !== false,
  };
  const reset = (): void => {
    setOn(false);
    setEdited(null);
    setProjectWide(false);
    setReplaces(undefined);
    setTreeOnly(false);
  };
  return {
    ...value,
    replacesScope: replaces?.scope,
    canNarrow: replaces?.canNarrow !== false,
    setOn: (v) => (v ? setOn(true) : reset()),
    setLine: setEdited,
    setProjectWide,
    setTreeOnly,
    replace: (id, scope, canNarrow = true) => {
      setOn(true);
      setReplaces({ id, scope, canNarrow });
      setTreeOnly(false);
    },
    reset,
    problem: markProblem(value),
    fields: markFields(value),
  };
}

function Check(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-fg-2">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[#5ce1e6]"
      />
      {props.label}
    </label>
  );
}

/**
 * The **Decision** toggle of the answer, verdict, comment and triage forms: one line that the
 * event records as a decision, with its scope. Only a person decides, so an agent sees nothing.
 */
export function DecisionMark({ mark, me }: { mark: Mark; me: string | null }) {
  if (!me?.startsWith('human:')) return null;
  const n = decisionLength(mark.line);
  const over = n > DECISION_TEXT_MAX;
  const old = mark.replaces;
  const hint = !old
    ? mark.projectWide
      ? 'Recorded for the whole project.'
      : 'Recorded for this task and the tasks below it.'
    : mark.treeOnly
      ? `Narrows ${old}: an exception for this task and the tasks below it; ${old} stays in force elsewhere.`
      : `Supersedes ${old} and takes its scope${mark.replacesScope ? `: ${mark.replacesScope}` : ''}.`;
  return (
    <div data-decision-mark className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Toggle checked={mark.on} onChange={mark.setOn} label="Decision" />
        {mark.on && (
          <>
            <div className="relative min-w-56 flex-1">
              <Input
                value={mark.line}
                onChange={mark.setLine}
                placeholder="The decision, in one line"
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
            {!old && (
              <Check
                checked={mark.projectWide}
                onChange={mark.setProjectWide}
                label="Project-wide"
              />
            )}
            {old && mark.canNarrow && (
              <Check
                checked={mark.treeOnly}
                onChange={mark.setTreeOnly}
                label="Only this task tree"
              />
            )}
          </>
        )}
      </div>
      {mark.on && (
        <p data-decision-hint className="text-[11px] leading-snug text-fg-4">
          {hint}
        </p>
      )}
      {mark.on && over && (
        <p data-decision-error className="text-xs text-bad">
          {mark.problem}
        </p>
      )}
    </div>
  );
}

/**
 * On an ask that names a contradiction (`contradiction with D-0007`): the decision it conflicts
 * with, and **Accept change**, which turns the form's **Decision** on as a replacement of it.
 * The answer then records the new decision with `supersedes`, or with `narrows` under **Only
 * this task tree**. Renders nothing for any other ask.
 */
export function Contradiction({
  text,
  task,
  mark,
  me,
}: {
  /** The ask: its title and text. */
  text: string;
  /** The task ref the API resolves. */
  task: string;
  mark: Mark;
  me: string | null;
}) {
  const id = me?.startsWith('human:') ? contradicted(text) : null;
  const { data } = useData<LogEntry[]>(id ? `/api/decisions?log&task=${q(task)}` : null);
  if (!id) return null;
  const entry = data?.find((e) => e.id === id);
  const bare = task.slice(task.indexOf('/') + 1);
  const active = mark.on && mark.replaces === id;
  return (
    <div
      data-contradiction={id}
      className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-warn/8 px-2.5 py-2 text-sm ring-1 ring-warn/20 ring-inset"
    >
      <GitCompareArrows size={14} className="shrink-0 text-warn" />
      <span className="text-xs text-fg-4">Contradicts</span>
      <span className="min-w-0 flex-1 text-fg-2">
        <span className="font-mono text-xs text-fg-3">{id}</span>
        {entry && (
          <>
            {' '}
            <span className="text-xs text-fg-4">({localTime(entry.at).slice(0, 10)})</span>{' '}
            <RefText text={entry.text} />{' '}
            <span className="text-xs text-fg-4">· {scopeText(entry)}</span>
          </>
        )}
      </span>
      <Button
        size="sm"
        kind={active ? 'plain' : 'primary'}
        icon={Gavel}
        title={
          active
            ? `Keeps ${id}: your answer records no new decision`
            : `Changes direction: your answer records a decision that supersedes ${id}`
        }
        onClick={() =>
          active
            ? mark.reset()
            : mark.replace(
                id,
                entry ? scopeText(entry) : undefined,
                !(entry?.scope === 'tree' && entry.task === bare),
              )
        }
      >
        {active ? `Keep ${id}` : 'Accept change'}
      </Button>
    </div>
  );
}
