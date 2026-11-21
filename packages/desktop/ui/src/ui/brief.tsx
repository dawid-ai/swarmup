// The goal brief of a milestone or a parent task in the task panel: the newest `brief` event as
// Markdown with its author and date, an **Edit** action that writes a new one
// (`swarmup brief ID --body-file -`), and a hint when children closed after it was written.
import { BookOpen, Pencil } from 'lucide-react';
import { useState } from 'react';
import { api, q } from '../api';
import { Button, ErrorLine, TextArea, useAction, Who } from '../components';
import { ago } from '../lib/format';
import type { Brief, BriefChild } from '../types';
import { Markdown } from './markdown';

/** A skeleton for a first brief, with the parts docs/protocol.md names. */
export const BRIEF_TEMPLATE =
  '## Outcome\n\n\n## Done\n\n\n## Next\n\n\n## Open questions\n\n\n## Decisions in force\n';

/** The hint under the brief: the children closed since it, or since the start without one. */
export function closedHint(closed: string[], hasBrief: boolean): string | null {
  if (closed.length === 0) return null;
  const n = closed.length;
  const list = closed.join(', ');
  return hasBrief
    ? `${n} ${n === 1 ? 'child' : 'children'} closed since this brief: ${list}. Update it so runs on the other children read what is done.`
    : `${n} ${n === 1 ? 'child' : 'children'} closed and there is no brief yet: ${list}.`;
}

export function BriefSection({
  task,
  me,
  brief,
  children,
  closed,
  onWrote,
}: {
  task: string;
  me: string | null;
  brief?: Brief;
  children?: BriefChild[];
  /** Children closed since the brief, from swarmupd (`closedSinceBrief`). */
  closed?: string[];
  onWrote: (res: unknown) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const act = useAction();
  const kids = children ?? [];
  const done = kids.filter((k) => k.status === 'done').length;
  const hint = closedHint(closed ?? [], Boolean(brief));
  const edit = (): void => {
    setText(brief?.body ?? BRIEF_TEMPLATE);
    setEditing(true);
  };
  const save = (): void =>
    act.run(async () => {
      const res = await api('POST', `/api/tasks/${q(task)}/brief`, { as: me, message: text });
      setEditing(false);
      onWrote(res);
    });
  return (
    <section data-brief>
      <h3 className="label-caps mt-6 mb-2 flex items-center gap-1.5">
        <BookOpen size={12} /> Brief
        {kids.length > 0 && (
          <span data-brief-children className="font-normal tracking-normal text-fg-4 normal-case">
            · {done} of {kids.length} {kids.length === 1 ? 'child' : 'children'} done
          </span>
        )}
        {!editing && (
          <button
            type="button"
            onClick={edit}
            className="ml-auto inline-flex items-center gap-1 font-sans text-xs font-normal tracking-normal text-fg-4 normal-case hover:text-signal"
          >
            <Pencil size={11} /> {brief ? 'Edit' : 'Write a brief'}
          </button>
        )}
      </h3>
      {hint && !editing && (
        <div
          data-brief-stale
          className="mb-2 rounded-lg border border-warn/20 bg-warn/[0.05] px-3 py-2 text-xs text-warn"
        >
          {hint}
        </div>
      )}
      {editing ? (
        <div className="panel animate-rise flex flex-col gap-2 p-3">
          <TextArea
            value={text}
            onChange={setText}
            rows={12}
            className="font-mono text-[13px]"
            placeholder="Outcome, what is done, what comes next, open questions, decisions in force (Markdown)"
          />
          <p className="text-[11px] leading-snug text-fg-4">
            Saving writes a new <code>brief</code> event; the newest one is the brief. Work and
            review runs on the children read it in their prompt.
          </p>
          <ErrorLine error={act.error} />
          <div className="flex items-center gap-2">
            <Button kind="primary" size="sm" disabled={!text.trim() || act.busy} onClick={save}>
              Save brief
            </Button>
            <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : brief ? (
        <div className="rounded-xl border border-white/7 bg-white/[0.02] p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-fg-4">
            <Who id={brief.actor} size="xs" />
            <span title={new Date(brief.at).toLocaleString()}>{ago(brief.at)}</span>
          </div>
          <Markdown text={brief.body} className="md-tight text-sm text-fg-2" />
        </div>
      ) : (
        <p className="text-xs text-fg-4">
          No brief yet. A brief holds the outcome, what is done, what comes next, the open questions
          and the decisions in force; runs on the children read it.
        </p>
      )}
    </section>
  );
}
