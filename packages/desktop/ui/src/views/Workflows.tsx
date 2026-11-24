// Workflows (W5): each project's `workflows/<id>.yaml` with its parameters, stages and gates. A
// person creates one from a starter template or blank, edits it in a form or as YAML with a live
// check and a compiled preview, saves it into the store (swarmupd's sync commits it), starts it,
// or deletes it. Writes are the person's alone; a run's token cannot make them.
import {
  CircleCheck,
  CircleX,
  FilePlus2,
  Flag,
  PenLine,
  Play,
  Plus,
  Save,
  ShieldQuestion,
  Trash2,
  TriangleAlert,
  Workflow as WorkflowIcon,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Nav } from '../App';
import { api, refreshSoon, useData } from '../api';
import {
  Button,
  Empty,
  ErrorLine,
  Field,
  Input,
  Modal,
  Section,
  Select,
  TextArea,
  cx,
  toast,
  useAction,
} from '../components';
import { listText, newStageKey, readWorkflowYaml, setYaml, textList } from '../lib/workflow-yaml';
import type { YamlPath } from '../lib/workflow-yaml';
import type {
  DefProblem,
  RootInfo,
  Settings as SettingsData,
  WorkflowCheck,
  WorkflowInfo,
  WorkflowStageView,
  WorkflowTemplate,
} from '../types';
import { StartWorkflow } from '../ui/workflow';

/** A `done_when` value as one line: text as it is, a typed criterion as its kind. */
export function doneWhenText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const kind = Object.keys(o)[0];
    return kind ? `${kind}: ${typeof o[kind] === 'string' ? String(o[kind]) : '…'}` : '';
  }
  return JSON.stringify(v);
}

/** The stages of a workflow in a row, gates marked with their question. */
function StageFlow({ stages }: { stages: WorkflowStageView[] }) {
  return (
    <ol className="flex flex-wrap items-stretch gap-1.5" data-testid="workflow-stages">
      {stages.map((s) => {
        const gate = s.gate !== undefined || s.type === 'gate';
        return (
          <li
            key={s.key}
            data-stage={s.key}
            data-gate={gate ? 'true' : undefined}
            title={[
              s.title ?? s.gate?.ask ?? s.key,
              s.after?.length ? `after ${s.after.join(', ')}` : '',
              s.done_when ? `done when: ${doneWhenText(s.done_when)}` : '',
            ]
              .filter(Boolean)
              .join('\n')}
            className={cx(
              'flex max-w-64 min-w-0 flex-col rounded-lg px-2.5 py-1.5 text-xs ring-1 ring-inset',
              gate ? 'bg-warn/8 ring-warn/25' : 'bg-white/4 ring-white/8',
            )}
          >
            <span className="flex items-center gap-1.5">
              {gate ? (
                <ShieldQuestion size={12} className="shrink-0 text-warn" />
              ) : (
                <Flag size={11} className="shrink-0 text-fg-4" />
              )}
              <span className="font-mono text-[11px] text-fg-4">{s.key}</span>
              {s.estimate && <span className="text-[11px] text-fg-4">{s.estimate}</span>}
            </span>
            <span className="truncate text-fg-2">
              {gate ? `Gate: ${s.gate?.ask ?? s.title ?? ''}` : (s.title ?? s.key)}
            </span>
            <span className="truncate text-[11px] text-fg-4">
              {gate ? (s.gate?.to ?? 'the project’s person') : (s.owner ?? 'no owner')}
              {s.after?.length ? ` · after ${s.after.join(', ')}` : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function WorkflowCard({
  w,
  multi,
  onEdit,
  onStart,
  onDelete,
}: {
  w: WorkflowInfo;
  multi: boolean;
  onEdit: () => void;
  onStart: () => void;
  onDelete: () => void;
}) {
  const params = Object.entries(w.params ?? {});
  return (
    <div className="panel flex flex-col gap-3 px-4 py-3" data-testid={`workflow-${w.root}-${w.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <WorkflowIcon size={15} className="text-signal" />
        <span className="font-display text-base font-semibold">{w.title ?? w.id}</span>
        <span className="font-mono text-xs text-fg-4">
          {multi ? `${w.root}/` : ''}workflows/{w.id}.yaml
        </span>
        {w.ok ? (
          <span className="text-xs text-fg-3">
            {w.approval === 'starter' ? 'approved by your start' : 'the plan waits for approval'}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-bad">
            <CircleX size={12} /> does not check
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button size="sm" icon={Play} disabled={!w.ok} onClick={onStart}>
            Start
          </Button>
          <Button size="sm" icon={PenLine} onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" kind="ghost" icon={Trash2} onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>
      {w.description && <p className="text-sm text-fg-3">{w.description}</p>}
      {params.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-fg-4">Parameters</span>
          {params.map(([k, p]) => (
            <span
              key={k}
              title={p?.description}
              className="rounded-md bg-white/6 px-1.5 py-px font-mono text-[11px] text-fg-2"
            >
              {k}
              {p?.required && p.default === undefined ? ' *' : ''}
              {p?.options ? ` (${p.options.join(' | ')})` : ''}
              {p?.default !== undefined ? ` = ${p.default}` : ''}
            </span>
          ))}
        </div>
      )}
      {w.def && (
        <div className="text-xs text-fg-3">
          <span className="text-fg-4">Milestone </span>
          {w.def.milestone.title}
          <span className="text-fg-4"> · done when </span>
          {doneWhenText(w.def.milestone.done_when)}
        </div>
      )}
      {w.def && <StageFlow stages={w.def.stages} />}
      {!w.ok && (
        <ul className="list-disc pl-5 text-xs text-warn">
          {(w.issues?.length
            ? w.issues.map((p) => `line ${p.line}: ${p.message}`)
            : w.problems
          ).map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The problems of the edited text, each with its line and column. */
function Problems({ problems, error }: { problems: DefProblem[]; error?: string }) {
  if (error) {
    return (
      <div
        className="flex items-start gap-2 text-sm text-[#ffb3ba]"
        data-testid="workflow-problems"
      >
        <CircleX size={14} className="mt-0.5 shrink-0" />
        {error}
      </div>
    );
  }
  if (problems.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-ok" data-testid="workflow-no-problems">
        <CircleCheck size={14} /> Checks against the schema and compiles
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="workflow-problems">
      {problems.map((p, i) => (
        <li key={i} className="flex items-start gap-2 text-sm" data-problem-line={p.line}>
          {p.severity === 'error' ? (
            <CircleX size={14} className="mt-0.5 shrink-0 text-bad" />
          ) : (
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-warn" />
          )}
          <span className="min-w-0">
            <code className="text-xs text-fg-3">
              line {p.line}:{p.col}
            </code>{' '}
            <span className={p.severity === 'error' ? 'text-[#ffb3ba]' : 'text-fg-2'}>
              {p.message}
            </span>
            {p.path !== '(top)' && <code className="ml-1.5 text-[11px] text-fg-4">{p.path}</code>}
          </span>
        </li>
      ))}
    </ul>
  );
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v) : '';

/** A text field bound to one path of the YAML. */
function YField(props: {
  label: string;
  value: unknown;
  path: YamlPath;
  set: (path: YamlPath, v: unknown) => void;
  hint?: string;
  placeholder?: string;
  list?: boolean;
  area?: boolean;
  className?: string;
}) {
  const shown = props.list ? listText(props.value) : text(props.value);
  const write = (v: string): void => props.set(props.path, props.list ? textList(v) : v);
  // A typed value (a map) is left to the YAML tab: the form shows it but does not overwrite it.
  if (props.value && typeof props.value === 'object' && !Array.isArray(props.value)) {
    return (
      <Field label={props.label} className={props.className} hint="A typed value: edit it in YAML">
        <Input value={doneWhenText(props.value)} onChange={() => {}} disabled />
      </Field>
    );
  }
  return (
    <Field label={props.label} hint={props.hint} className={props.className}>
      {props.area ? (
        <TextArea value={shown} onChange={write} rows={2} placeholder={props.placeholder} />
      ) : (
        <Input value={shown} onChange={write} placeholder={props.placeholder} />
      )}
    </Field>
  );
}

/** The form of the common fields; everything else stays in the YAML. */
function WorkflowForm({ value, set }: { value: Obj; set: (path: YamlPath, v: unknown) => void }) {
  const [newParam, setNewParam] = useState('');
  const params = Object.entries(obj(value.params));
  const milestone = obj(value.milestone);
  const stages = Array.isArray(value.stages) ? value.stages.map(obj) : [];
  const keyRe = /^[a-z][a-z0-9_]{0,39}$/;
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-form">
      <div className="grid grid-cols-2 gap-3">
        <YField label="Title" value={value.title} path={['title']} set={set} />
        <Field label="Approval">
          <Select
            value={text(value.approval) || 'proposal'}
            onChange={(v) => set(['approval'], v === 'proposal' ? '' : v)}
            options={[
              ['proposal', 'proposal: the plan waits for a person'],
              ['starter', 'starter: a person’s start approves it'],
            ]}
          />
        </Field>
        <YField
          label="Description"
          value={value.description}
          path={['description']}
          set={set}
          className="col-span-2"
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="label-caps">Parameters</div>
        {params.length === 0 && (
          <p className="text-xs text-fg-4">None. {'{{name}}'} fills in any text.</p>
        )}
        {params.map(([k, raw]) => {
          const p = obj(raw);
          return (
            <div
              key={k}
              data-param={k}
              className="grid grid-cols-[8rem_1fr_7rem_1fr_auto] items-end gap-2 rounded-lg bg-white/3 p-2"
            >
              <div className="pb-2 font-mono text-sm text-fg-2">{k}</div>
              <YField
                label="Description"
                value={p.description}
                path={['params', k, 'description']}
                set={set}
              />
              <YField label="Default" value={p.default} path={['params', k, 'default']} set={set} />
              <YField
                label="Options"
                value={p.options}
                path={['params', k, 'options']}
                set={set}
                list
                placeholder="a, b, c"
              />
              <div className="flex items-center gap-2 pb-1.5">
                <label className="flex items-center gap-1 text-xs text-fg-3">
                  <input
                    type="checkbox"
                    checked={p.required === true}
                    onChange={(e) => set(['params', k, 'required'], e.target.checked)}
                  />
                  required
                </label>
                <button
                  type="button"
                  aria-label={`Remove parameter ${k}`}
                  title={`Remove parameter ${k}`}
                  onClick={() => set(['params', k], undefined)}
                  className="rounded-md p-1 text-fg-4 hover:bg-white/6 hover:text-fg"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          );
        })}
        <div className="flex items-center gap-2">
          <Input
            value={newParam}
            onChange={setNewParam}
            placeholder="new_parameter"
            className="w-48"
            onEnter={() => {
              if (!keyRe.test(newParam) || Object.hasOwn(obj(value.params), newParam)) return;
              set(['params', newParam, 'description'], 'What it is for');
              setNewParam('');
            }}
          />
          <Button
            size="sm"
            icon={Plus}
            disabled={!keyRe.test(newParam) || Object.hasOwn(obj(value.params), newParam)}
            onClick={() => {
              set(['params', newParam, 'description'], 'What it is for');
              setNewParam('');
            }}
          >
            Add parameter
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <YField
          label="Milestone title"
          value={milestone.title}
          path={['milestone', 'title']}
          set={set}
        />
        <YField
          label="Milestone done when"
          value={milestone.done_when}
          path={['milestone', 'done_when']}
          set={set}
        />
      </div>
      <div className="flex flex-col gap-2">
        <div className="label-caps">Stages</div>
        {stages.map((s, i) => {
          const gate = s.gate !== undefined;
          const g = obj(s.gate);
          const at = (k: string): YamlPath => ['stages', i, k];
          return (
            <div
              key={i}
              data-stage-form={text(s.key)}
              className={cx(
                'flex flex-col gap-2 rounded-lg p-2.5 ring-1 ring-inset',
                gate ? 'bg-warn/5 ring-warn/20' : 'bg-white/3 ring-white/8',
              )}
            >
              <div className="grid grid-cols-[8rem_1fr_10rem_5rem] gap-2">
                <YField label="Key" value={s.key} path={at('key')} set={set} />
                <YField label="Title" value={s.title} path={at('title')} set={set} />
                <YField
                  label="Owner"
                  value={s.owner}
                  path={at('owner')}
                  set={set}
                  placeholder="*:engineer"
                />
                <YField
                  label="Estimate"
                  value={s.estimate}
                  path={at('estimate')}
                  set={set}
                  placeholder="2h"
                />
              </div>
              <div className="grid grid-cols-[1fr_8rem_1fr] gap-2">
                <YField
                  label="After"
                  value={s.after}
                  path={at('after')}
                  set={set}
                  list
                  placeholder="key, key"
                />
                <YField
                  label="Type"
                  value={s.type}
                  path={at('type')}
                  set={set}
                  placeholder="task"
                />
                <YField label="Labels" value={s.labels} path={at('labels')} set={set} list />
              </div>
              <YField label="Done when" value={s.done_when} path={at('done_when')} set={set} />
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-fg-2">
                  <input
                    type="checkbox"
                    checked={gate}
                    onChange={(e) =>
                      set(at('gate'), e.target.checked ? { ask: 'Approve this stage?' } : undefined)
                    }
                  />
                  A person approves here (gate)
                </label>
                <span className="ml-auto">
                  <Button
                    size="sm"
                    kind="ghost"
                    icon={Trash2}
                    onClick={() => set(['stages', i], undefined)}
                  >
                    Remove stage
                  </Button>
                </span>
              </div>
              {gate && (
                <div className="grid grid-cols-[1fr_10rem_10rem] gap-2">
                  <YField
                    label="Gate question"
                    value={g.ask}
                    path={['stages', i, 'gate', 'ask']}
                    set={set}
                  />
                  <YField
                    label="Gate person"
                    value={g.to}
                    path={['stages', i, 'gate', 'to']}
                    set={set}
                    placeholder="the project’s person"
                  />
                  <Field label="On reject">
                    <Select
                      value={text(g.on_reject) || 'park'}
                      onChange={(v) =>
                        set(['stages', i, 'gate', 'on_reject'], v === 'park' ? '' : v)
                      }
                      options={[
                        ['park', 'park the rest'],
                        ['revise', 'reopen earlier stages'],
                      ]}
                    />
                  </Field>
                </div>
              )}
            </div>
          );
        })}
        <div>
          <Button
            size="sm"
            icon={Plus}
            onClick={() =>
              set(['stages', stages.length], {
                key: newStageKey(stages),
                title: 'New stage',
                owner: '*:engineer',
                estimate: '1h',
                ...(stages.length > 0 && stages[stages.length - 1]!.key
                  ? { after: [String(stages[stages.length - 1]!.key)] }
                  : {}),
              })
            }
          >
            Add stage
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The plan the edited workflow compiles to for the sample values. */
function Preview({
  check,
  values,
  setValues,
}: {
  check: WorkflowCheck | null;
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
}) {
  const params = Object.entries(check?.def?.params ?? {});
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-preview">
      {params.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {params.map(([k, p]) => (
            <Field key={k} label={k} hint={p?.description}>
              {p?.options ? (
                <Select
                  value={values[k] ?? check?.params?.[k] ?? ''}
                  onChange={(v) => setValues({ ...values, [k]: v })}
                  options={p.options.map((o): [string, string] => [o, o])}
                />
              ) : (
                <Input
                  value={values[k] ?? ''}
                  onChange={(v) => setValues({ ...values, [k]: v })}
                  placeholder={check?.params?.[k] ?? ''}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {!check?.def && <p className="text-sm text-fg-3">Fix the problems to see the plan.</p>}
      {check?.preview_error && <ErrorLine error={check.preview_error} />}
      {check?.plan && (
        <>
          <div className="text-sm">
            <span className="text-fg-4">Milestone </span>
            <span className="text-fg">{check.plan.milestone.title}</span>
            <span className="text-fg-4"> · done when </span>
            {doneWhenText(check.plan.milestone.done_when)}
          </div>
          <table className="w-full text-xs">
            <thead className="text-left text-fg-4">
              <tr>
                <th className="py-1 pr-2 font-normal">Key</th>
                <th className="py-1 pr-2 font-normal">Task</th>
                <th className="py-1 pr-2 font-normal">Owner</th>
                <th className="py-1 pr-2 font-normal">Estimate</th>
                <th className="py-1 font-normal">After</th>
              </tr>
            </thead>
            <tbody>
              {check.plan.items.map((it) => (
                <tr key={it.key} className="border-t border-white/5" data-plan-item={it.key}>
                  <td className="py-1 pr-2 font-mono text-fg-3">{it.key}</td>
                  <td className="py-1 pr-2 text-fg-2">
                    {it.gate && (
                      <span className="mr-1.5 rounded bg-warn/12 px-1 text-[10px] text-warn">
                        Gate
                      </span>
                    )}
                    {it.title}
                    {it.done_when !== undefined && (
                      <div className="text-[11px] text-fg-4">
                        done when {doneWhenText(it.done_when)}
                      </div>
                    )}
                  </td>
                  <td className="py-1 pr-2 font-mono text-fg-3">{it.owner}</td>
                  <td className="py-1 pr-2 text-fg-3">{it.estimate}</td>
                  <td className="py-1 font-mono text-fg-4">{it.after?.join(', ') ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {check.plan.dropped.length > 0 && (
            <p className="text-xs text-fg-4">
              Left out for these values: {check.plan.dropped.join(', ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Edits one workflow: a form of the common fields, the YAML for everything else, and the plan it
 * compiles to. The text is checked as you type; **Save** stays off while it has errors.
 */
export function WorkflowEditor(props: {
  me: string | null;
  root: string;
  id: string;
  /** The text the editor starts from: the file's, or a template's for a new workflow. */
  start: string;
  create: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(props.start);
  const [tab, setTab] = useState<'form' | 'yaml' | 'preview'>('form');
  const [check, setCheck] = useState<WorkflowCheck | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const act = useAction();
  const seq = useRef(0);
  const parsed = useMemo(() => readWorkflowYaml(text), [text]);
  useEffect(() => {
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      api<WorkflowCheck>('POST', '/api/workflows/check', {
        id: props.id,
        root: props.root,
        text,
        params: values,
      }).then(
        (r) => mine === seq.current && setCheck(r),
        (e: Error) =>
          mine === seq.current &&
          setCheck({
            ok: false,
            def: null,
            problems: [
              { file: '', path: '(top)', line: 1, col: 1, severity: 'error', message: e.message },
            ],
          }),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [text, values, props.id, props.root]);
  const set = (path: YamlPath, v: unknown): void => setText((t) => setYaml(t, path, v));
  const errors = (check?.problems ?? []).filter((p) => p.severity === 'error').length;
  const save = (): void =>
    act.run(
      () =>
        api('POST', '/api/workflows/save', {
          as: props.me,
          root: props.root,
          id: props.id,
          text,
          ...(props.create ? { create: true } : { expect: props.start }),
        }),
      () => {
        toast(`Saved workflows/${props.id}.yaml`, { tone: 'ok' });
        refreshSoon();
        props.onSaved();
      },
    );
  const tabs: Array<[typeof tab, string]> = [
    ['form', 'Form'],
    ['yaml', 'YAML'],
    ['preview', 'Preview'],
  ];
  return (
    <Modal
      title={`${props.create ? 'New workflow' : 'Edit workflow'}: ${props.id}`}
      icon={WorkflowIcon}
      onClose={props.onClose}
      width={960}
      dirty={text !== props.start}
    >
      <div className="flex flex-col gap-3" data-workflow-editor>
        <div className="flex gap-1 border-b border-white/6" role="tablist">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cx(
                '-mb-px border-b-2 px-3 py-1.5 text-sm',
                tab === k ? 'border-signal text-fg' : 'border-transparent text-fg-3 hover:text-fg',
              )}
            >
              {label}
            </button>
          ))}
          <span className="ml-auto self-center font-mono text-xs text-fg-4">
            {props.root}/workflows/{props.id}.yaml
          </span>
        </div>
        <div className="max-h-[56vh] overflow-auto pr-1">
          {tab === 'form' &&
            (parsed.value ? (
              <WorkflowForm value={parsed.value} set={set} />
            ) : (
              <p className="text-sm text-warn">
                The YAML does not parse ({parsed.error}); fix it in the YAML tab to use the form.
              </p>
            ))}
          {tab === 'yaml' && (
            <textarea
              aria-label="Workflow YAML"
              value={text}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              className="h-[50vh] w-full resize-y rounded-lg border border-white/10 bg-ink-950/60 p-2.5 font-mono text-[12px] leading-5 outline-none focus:border-signal/60"
            />
          )}
          {tab === 'preview' && <Preview check={check} values={values} setValues={setValues} />}
        </div>
        <div className="border-t border-white/6 pt-3">
          {check ? (
            <Problems problems={check.problems} error={parsed.value ? undefined : parsed.error} />
          ) : (
            <span className="text-xs text-fg-4">Checking…</span>
          )}
        </div>
        <ErrorLine error={act.error} />
        <div className="flex items-center gap-2">
          <Button
            kind="primary"
            icon={Save}
            disabled={act.busy || !check || errors > 0 || (!props.create && text === props.start)}
            onClick={save}
          >
            Save
          </Button>
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {errors > 0 && <span className="text-xs text-bad">Fix the errors to save</span>}
        </div>
      </div>
    </Modal>
  );
}

/** New workflow: the project, the id and a starter template or blank. */
function NewWorkflowDialog(props: {
  roots: RootInfo[];
  taken: WorkflowInfo[];
  onClose: () => void;
  onPick: (root: string, id: string, text: string) => void;
}) {
  const templates = useData<WorkflowTemplate[]>('/api/workflows/templates');
  const own = props.roots.filter((r) => !r.isMirror);
  const [root, setRoot] = useState(own[0]?.name ?? '');
  const [template, setTemplate] = useState('');
  const [id, setId] = useState('');
  const list = templates.data ?? [];
  const chosen = list.find((t) => t.id === (template || list[0]?.id));
  // The first template's id is the id to start with, as most projects take a starter as it is.
  const first = list[0]?.id;
  useEffect(() => {
    if (first && first !== 'blank') setId((cur) => cur || first);
  }, [first]);
  const idOk = /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
  const taken = props.taken.some((w) => w.root === root && w.id === id);
  return (
    <Modal title="New workflow" icon={FilePlus2} onClose={props.onClose} width={560}>
      <div className="flex flex-col gap-4" data-new-workflow>
        <ErrorLine error={templates.error} />
        {own.length > 1 && (
          <Field label="Project">
            <Select
              value={root}
              onChange={setRoot}
              options={own.map((r): [string, string] => [r.name, r.label ?? r.name])}
            />
          </Field>
        )}
        <Field label="Start from" hint={chosen?.description}>
          <Select
            value={chosen?.id ?? ''}
            onChange={(v) => {
              setTemplate(v);
              if (!id || list.some((t) => t.id === id)) setId(v === 'blank' ? '' : v);
            }}
            options={list.map((t): [string, string] => [
              t.id,
              t.id === 'blank' ? 'Blank' : `${t.title} (${t.id})`,
            ])}
          />
        </Field>
        <Field
          label="Id"
          hint={
            taken
              ? 'This project has a workflow with that id; edit it instead.'
              : 'The file name: workflows/<id>.yaml. Lowercase letters, digits and dashes.'
          }
        >
          <Input value={id} onChange={setId} placeholder="release-notes" />
        </Field>
        <div className="flex gap-2 border-t border-white/6 pt-4">
          <Button
            kind="primary"
            icon={PenLine}
            disabled={!chosen || !root || !idOk || taken}
            onClick={() => chosen && props.onPick(root, id, chosen.text)}
          >
            Open editor
          </Button>
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteDialog(props: {
  w: WorkflowInfo;
  me: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const act = useAction();
  return (
    <Modal title="Delete workflow" icon={Trash2} onClose={props.onClose} width={480}>
      <div className="flex flex-col gap-4 text-sm" data-delete-workflow>
        <p className="text-fg-2">
          Delete <code>workflows/{props.w.id}.yaml</code> from {props.w.root}? Milestones it started
          keep their tasks. swarmupd’s sync commits the removal, so git keeps the file’s history.
        </p>
        <ErrorLine error={act.error} />
        <div className="flex gap-2">
          <Button
            kind="danger"
            icon={Trash2}
            disabled={act.busy}
            onClick={() =>
              act.run(
                () =>
                  api('POST', '/api/workflows/delete', {
                    as: props.me,
                    root: props.w.root,
                    id: props.w.id,
                    ...(props.w.text !== undefined ? { expect: props.w.text } : {}),
                  }),
                () => {
                  toast(`Deleted workflows/${props.w.id}.yaml`);
                  refreshSoon();
                  props.onDone();
                },
              )
            }
          >
            Delete
          </Button>
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

type Editing = { root: string; id: string; start: string; create: boolean };

export function Workflows({ nav }: { nav: Nav }) {
  const list = useData<WorkflowInfo[]>('/api/workflows');
  const settings = useData<SettingsData>('/api/settings');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkflowInfo | null>(null);
  const all = list.data ?? [];
  const roots = settings.data?.rootList ?? [];
  const multi =
    new Set(all.map((w) => w.root)).size > 1 || roots.filter((r) => !r.isMirror).length > 1;
  const byRoot = new Map<string, WorkflowInfo[]>();
  for (const w of all) byRoot.set(w.root, [...(byRoot.get(w.root) ?? []), w]);
  return (
    <Section
      title="Workflows"
      icon={WorkflowIcon}
      subtitle="Repeatable milestone plans: each project's workflows/<id>.yaml"
      actions={
        <Button kind="primary" icon={Plus} onClick={() => setAdding(true)}>
          New workflow
        </Button>
      }
    >
      <div className="flex flex-col gap-4 p-6" data-testid="workflows">
        <ErrorLine error={list.error} />
        {list.data && all.length === 0 && (
          <Empty
            icon={WorkflowIcon}
            title="No workflows yet"
            action={
              <Button kind="primary" icon={Plus} onClick={() => setAdding(true)}>
                New workflow
              </Button>
            }
          >
            A workflow is a milestone plan you start again and again: its parameters, its stages
            with owners and estimates, and gates where a person approves. Start from a template
            (feature, bug fix, content piece, campaign launch) or a blank one.
          </Empty>
        )}
        {[...byRoot].map(([root, ws]) => (
          <div key={root} className="flex flex-col gap-3">
            {multi && <div className="label-caps">{root}</div>}
            {ws.map((w) => (
              <WorkflowCard
                key={`${w.root}/${w.id}`}
                w={w}
                multi={multi}
                onStart={() => setStarting(`${w.root}/${w.id}`)}
                onEdit={() =>
                  setEditing({ root: w.root, id: w.id, start: w.text ?? '', create: false })
                }
                onDelete={() => setDeleting(w)}
              />
            ))}
          </div>
        ))}
      </div>
      {adding && (
        <NewWorkflowDialog
          roots={roots}
          taken={all}
          onClose={() => setAdding(false)}
          onPick={(root, id, start) => {
            setAdding(false);
            setEditing({ root, id, start, create: true });
          }}
        />
      )}
      {editing && (
        <WorkflowEditor
          me={nav.me}
          {...editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {starting && (
        <StartWorkflow
          me={nav.me}
          initial={starting}
          onClose={() => setStarting(null)}
          onStarted={(ref) => {
            setStarting(null);
            nav.openTask(ref);
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          w={deleting}
          me={nav.me}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            list.reload();
          }}
        />
      )}
    </Section>
  );
}
