// Start a workflow (W5): pick one of a root's workflows (`workflows/<id>.yaml`), fill in its
// parameters, and start it, as `swarmup workflow start` does. A workflow with `approval: starter`
// is approved by your start and its tasks are created; any other waits in the Inbox as a plan.
import { Play, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, refreshSoon, useData } from '../api';
import { Button, ErrorLine, Field, Input, Modal, Select, toast, useAction } from '../components';
import type { WorkflowInfo } from '../types';

/** The key of a workflow in the dialog's choice: root and id. */
const keyOf = (w: Pick<WorkflowInfo, 'root' | 'id'>): string => `${w.root}/${w.id}`;

/** The parameters a start sends: the values filled in, then each default the person left alone. */
export function startParams(
  w: WorkflowInfo,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(w.params)) {
    const v = values[k]?.trim() ?? '';
    if (v) out[k] = v;
    else if (p?.default !== undefined) out[k] = p.default;
  }
  return out;
}

/** The required parameters without a value, by name. */
export function missingParams(w: WorkflowInfo, values: Record<string, string>): string[] {
  return Object.entries(w.params)
    .filter(([k, p]) => p?.required && p.default === undefined && !values[k]?.trim())
    .map(([k]) => k);
}

export function StartWorkflow(props: {
  me: string | null;
  onClose: () => void;
  /** The milestone was created: its ref. */
  onStarted: (ref: string) => void;
  /** Opens with this workflow chosen, as `root/id` or `id`. */
  initial?: string;
}) {
  const list = useData<WorkflowInfo[]>('/api/workflows');
  const usable = useMemo(() => (list.data ?? []).filter((w) => w.ok), [list.data]);
  const broken = (list.data ?? []).filter((w) => !w.ok);
  const [chosen, setChosen] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const act = useAction();
  useEffect(() => {
    if (chosen || usable.length === 0) return;
    const want = props.initial;
    const hit = want ? usable.find((w) => keyOf(w) === want || w.id === want) : undefined;
    setChosen(keyOf(hit ?? usable[0]!));
  }, [usable, chosen, props.initial]);
  const w = usable.find((x) => keyOf(x) === chosen);
  const missing = w ? missingParams(w, values) : [];
  const roots = new Set(usable.map((x) => x.root));
  const start = (): void => {
    if (!w || missing.length > 0) return;
    act.run(async () => {
      const res = await api<{ milestone: { id: string }; approved: boolean; created: unknown[] }>(
        'POST',
        '/api/workflows/start',
        {
          as: props.me,
          id: w.id,
          root: w.root,
          params: startParams(w, values),
          ...(title.trim() ? { title: title.trim() } : {}),
        },
      );
      const ref = roots.size > 1 ? `${w.root}/${res.milestone.id}` : res.milestone.id;
      toast(
        res.approved
          ? `Started ${w.id} as ${res.milestone.id}: ${res.created.length} task(s) created`
          : `Started ${w.id} as ${res.milestone.id}: its plan waits for approval in the Inbox`,
      );
      refreshSoon();
      props.onStarted(ref);
    });
  };
  return (
    <Modal title="Start a workflow" icon={Workflow} onClose={props.onClose} width={600}>
      <div className="flex flex-col gap-4" data-start-workflow>
        <ErrorLine error={list.error} />
        {list.data && usable.length === 0 && (
          <p className="text-sm text-fg-3" data-no-workflows>
            No workflows yet. Add <span className="font-mono">workflows/&lt;id&gt;.yaml</span> to a
            project's data root; new projects from a template come with starter workflows.
          </p>
        )}
        {usable.length > 0 && (
          <Field label="Workflow">
            <Select
              value={chosen}
              onChange={(v) => {
                setChosen(v);
                setValues({});
              }}
              options={usable.map((x) => [
                keyOf(x),
                `${roots.size > 1 ? `${x.root}: ` : ''}${x.title ?? x.id}`,
              ])}
            />
          </Field>
        )}
        {w && (
          <>
            {w.description && <p className="-mt-2 text-xs text-fg-3">{w.description}</p>}
            <p className="-mt-2 text-xs text-fg-4" data-approval={w.approval}>
              {w.approval === 'starter'
                ? `${w.stages} stages. Your start approves the plan, and its tasks are created.`
                : `${w.stages} stages. The plan waits for your approval in the Inbox.`}
            </p>
            {Object.entries(w.params).map(([k, p]) => (
              <Field
                key={k}
                label={`${k}${p?.required && p.default === undefined ? ' *' : ''}`}
                hint={p?.description}
              >
                {p?.options ? (
                  <Select
                    value={values[k] ?? p.default ?? ''}
                    onChange={(v) => setValues({ ...values, [k]: v })}
                    options={[
                      ...(p.default === undefined
                        ? ([['', 'pick one']] as Array<[string, string]>)
                        : []),
                      ...p.options.map((o): [string, string] => [o, o]),
                    ]}
                  />
                ) : (
                  <Input
                    value={values[k] ?? ''}
                    onChange={(v) => setValues({ ...values, [k]: v })}
                    placeholder={p?.default ?? ''}
                  />
                )}
              </Field>
            ))}
            <Field label="Milestone title" hint="Empty: the title the workflow gives.">
              <Input value={title} onChange={setTitle} placeholder="From the workflow" />
            </Field>
          </>
        )}
        {broken.length > 0 && (
          <p className="text-xs text-warn">
            {broken.map((b) => b.id).join(', ')} do not check: run swarmup validate.
          </p>
        )}
        <div className="flex items-center gap-2 border-t border-white/6 pt-4">
          <Button
            kind="primary"
            icon={Play}
            disabled={act.busy || !w || missing.length > 0}
            onClick={start}
          >
            Start
          </Button>
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {missing.length > 0 && (
            <span className="text-xs text-fg-4">Fill in {missing.join(', ')}</span>
          )}
          <div className="min-w-0 flex-1">
            <ErrorLine error={act.error} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
