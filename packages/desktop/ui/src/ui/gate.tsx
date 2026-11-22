// Gates (W5): a person's decision inside a workflow's plan. Approve posts `done` and the stages
// after the gate start; Reject posts `park`, which parks the gate and every stage after it, or with
// `on_reject: revise` reopens the stages the gate waits for. The rules live in core; what swarmupd
// refuses shows here as it says it.
import { Check, DoorOpen, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { api, q, refreshSoon } from '../api';
import { Button, ErrorLine, TextArea, toast, useAction, cx } from '../components';
import type { GateSpec } from '../types';

/** What a rejection of `gate` does, in a short line for the button's hint. */
export function rejectHint(gate: GateSpec): string {
  return gate.on_reject === 'revise'
    ? 'Reject sends the work before this gate back for revision; the gate asks again after it.'
    : 'Reject parks this gate and every stage after it.';
}

/**
 * The question of a gate with **Approve** and **Reject**. Answers the gate offers fill the note;
 * a rejection needs one.
 */
export function GateActions(props: {
  /** The gate's task, as the inbox or panel names it. */
  task: string;
  gate: GateSpec;
  me: string | null;
  /** A decision went through. */
  onDone?: (what: 'approved' | 'rejected') => void;
  className?: string;
}) {
  const { task, gate } = props;
  const [note, setNote] = useState('');
  const act = useAction();
  const decide = (what: 'approved' | 'rejected'): void => {
    if (what === 'rejected' && !note.trim()) return;
    act.run(async () => {
      await api('POST', `/api/tasks/${q(task)}/${what === 'approved' ? 'done' : 'park'}`, {
        as: props.me,
        message: note.trim(),
      });
      setNote('');
      toast(
        what === 'approved'
          ? `Approved ${task}: the stages after it start`
          : gate.on_reject === 'revise'
            ? `Sent ${task} back for revision`
            : `Rejected ${task}: it and the stages after it are parked`,
      );
      refreshSoon();
      props.onDone?.(what);
    });
  };
  return (
    <div className={cx('flex flex-col gap-2', props.className)} data-gate={task}>
      <div className="flex items-start gap-2 text-sm text-fg">
        <DoorOpen size={15} className="mt-0.5 shrink-0 text-warn" />
        <span data-gate-ask>{gate.ask}</span>
      </div>
      {gate.options && gate.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-gate-options>
          {gate.options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setNote(o)}
              className={cx(
                'rounded-md px-2 py-0.5 text-xs transition',
                note === o
                  ? 'bg-signal/20 text-signal'
                  : 'bg-white/6 text-fg-3 hover:bg-white/10 hover:text-fg',
              )}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <TextArea
        value={note}
        onChange={setNote}
        rows={2}
        placeholder="A note: your answer, or what to change (needed to reject)"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          kind="primary"
          size="sm"
          icon={Check}
          disabled={act.busy}
          onClick={() => decide('approved')}
        >
          Approve
        </Button>
        <Button
          kind="danger"
          size="sm"
          icon={gate.on_reject === 'revise' ? Undo2 : X}
          disabled={act.busy || !note.trim()}
          title={rejectHint(gate)}
          onClick={() => decide('rejected')}
        >
          {gate.on_reject === 'revise' ? 'Send back' : 'Reject'}
        </Button>
        <span className="text-[11px] text-fg-4">{rejectHint(gate)}</span>
      </div>
      <ErrorLine error={act.error} />
    </div>
  );
}
