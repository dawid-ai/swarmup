import { Check, ChevronDown, FolderPlus, SquarePen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, refreshSoon } from '../api';
import { Button, ErrorLine, Field, Modal, PriorityIcon, useAction, cx } from '../components';
import { rootOfProject, setBoardShowsIdeas } from '../lib/filters';
import { PRIORITIES } from '../lib/identity';
import { QUESTION } from '../lib/question';
import type { RootInfo, Task } from '../types';
import type { Due } from '../ui/pickers';
import { AgentPicker, DuePicker, dueToApi, MentionArea, Popover } from '../ui/pickers';
import { openAddProject } from './AddProject';

const TYPES: Array<[string, string]> = [
  ['task', 'Task'],
  ['bug', 'Bug'],
  ['idea', 'Idea'],
  [QUESTION, 'Question'],
  ['finding', 'Finding'],
  ['doc', 'Doc'],
  ['eval', 'Eval'],
];

/**
 * The project of a new task: the loaded projects, filtered as you type (a match anywhere in the
 * name), with **Add project** as the last row. Arrow keys move, Enter picks, Esc closes the list.
 */
function ProjectPicker(props: {
  value: string | undefined;
  options: string[];
  onChange: (name: string) => void;
  onAdd: () => void;
  /** Opens the list with this text typed, for the screenshot run. */
  search?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState(props.search ?? '');
  // Opened after the first render: the list places itself under the field, which must be there.
  const { search } = props;
  useEffect(() => {
    if (search !== undefined) setOpen(true);
  }, [search]);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const needle = q.trim().toLowerCase();
  const shown = props.options.filter((o) => o.toLowerCase().includes(needle));
  // The row after the projects is Add project.
  const last = shown.length;
  const reset = (): void => {
    setOpen(false);
    setQ('');
    setHi(0);
  };
  const close = (): void => {
    reset();
    input.current?.blur();
  };
  const pick = (i: number): void => {
    close();
    if (i === last) props.onAdd();
    else if (shown[i]) props.onChange(shown[i]);
  };
  const row = (active: boolean): string =>
    cx(
      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
      active ? 'bg-white/8 text-fg' : 'text-fg-2 hover:bg-white/6 hover:text-fg',
    );
  return (
    <div ref={box} className="relative">
      <input
        ref={input}
        role="combobox"
        aria-label="Project"
        aria-expanded={open}
        aria-autocomplete="list"
        value={open ? q : (props.value ?? '')}
        placeholder={open ? (props.value ?? 'Search projects') : 'Default project'}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        // Rows keep the focus here (they prevent the mousedown), so a blur means leaving the field.
        onBlur={reset}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setHi((h) => Math.min(h + 1, last));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter' && open) {
            e.preventDefault();
            pick(hi);
          }
        }}
        className="h-[34px] w-full rounded-lg border border-white/10 bg-ink-950/60 pr-7 pl-2.5 text-sm outline-none transition placeholder:text-fg-4 focus:border-signal/60 focus:shadow-[0_0_0_3px_rgba(92,225,230,0.12)]"
      />
      <ChevronDown
        size={13}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-4"
      />
      {/* Esc closes only the list: the Popover takes the key before the dialog sees it. */}
      <Popover anchor={box} open={open} onClose={close}>
        <div role="listbox" aria-label="Projects" className="max-h-72 overflow-auto">
          {shown.map((o, i) => (
            <button
              key={o}
              type="button"
              role="option"
              aria-selected={i === hi}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(i)}
              className={row(i === hi)}
            >
              <span className="min-w-0 flex-1 truncate">{o}</span>
              {o === props.value && <Check size={14} className="text-signal" />}
            </button>
          ))}
          {shown.length === 0 && (
            <div className="px-2.5 py-1.5 text-xs text-fg-4">No project matches</div>
          )}
          <button
            type="button"
            role="option"
            aria-selected={hi === last}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setHi(last)}
            onClick={() => pick(last)}
            className={cx(row(hi === last), 'mt-1 border-t border-white/8')}
          >
            <FolderPlus size={14} className="text-fg-3" />
            Add project
          </button>
        </div>
      </Popover>
    </div>
  );
}

export function NewTask({
  me,
  onClose,
  onCreated,
  roots,
  tasks,
  project: shownProject,
  added,
  search,
}: {
  me: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
  /** The loaded data roots, the default one first (`rootList` of the settings). */
  roots?: RootInfo[];
  /** The tasks App has loaded: they say which root a filtered project's tasks live in. */
  tasks?: Array<Pick<Task, 'project' | 'root'>>;
  /** The project the Board or List behind the form is filtered to. */
  project?: string;
  /** The project Add project created while the form was open: it becomes the choice. */
  added?: string;
  /** Opens the project list with this text typed, for the screenshot run. */
  search?: string;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [owner, setOwner] = useState<string[]>([]);
  const [priority, setPriority] = useState('p2');
  const [type, setType] = useState('task');
  /** The project picked in the form; until then the view's project, else the default root. */
  const [picked, setPicked] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (added) setPicked(added);
  }, [added]);
  const [due, setDue] = useState<Due | null>(null);
  // The sidebar's projects: every root but the Master Repo, which stays only when it is the
  // default root, so the choice the form opens with is in the list.
  const fallback = roots?.[0]?.name;
  const names = (roots ?? []).filter((r) => !r.isMaster || r.name === fallback).map((r) => r.name);
  // A filter names a project, and a root's tasks may carry another name than the root's: the
  // tasks say which root the filter stands for.
  const shownRoot = rootOfProject(shownProject, tasks ?? [], names);
  const root = picked ?? shownRoot ?? fallback;
  const act = useAction();
  const [uploading, setUploading] = useState(false);
  // An idea is not work yet: like `swarmup new --type idea`, it has no owner and no due date, and stays
  // out of every queue until someone changes its type.
  const idea = type === 'idea';
  // A question goes to one agent (or group) and only it takes it; the answer comes back to your
  // inbox. No due date: nothing is delegated.
  const question = type === QUESTION;
  const people = owner.some((o) => o.startsWith('human:'));
  const missing = question && (owner.length === 0 || people);
  const create = (): void => {
    if (!title.trim() || act.busy || uploading || missing) return;
    let created = '';
    act.run(
      async () => {
        const t = await api<Task>('POST', '/api/tasks', {
          title: title.trim(),
          body,
          to: idea ? undefined : owner[0],
          priority,
          type,
          // The data root the task goes to: its store, code checkout, agents and merge settings.
          root,
          // The filter's own name while its root is the choice, so the task shows in that view;
          // otherwise the root's default project.
          project: shownProject && root === shownRoot ? shownProject : undefined,
        });
        created = `${t.root}/${t.id}`;
        if (question) return;
        if (idea) {
          setBoardShowsIdeas(true);
          return;
        }
        // A due date is part of a delegation: hand it to the owner (or you) with the date.
        const dueValue = dueToApi(due);
        if (dueValue) {
          await api('POST', `/api/tasks/${encodeURIComponent(created)}/delegate`, {
            as: me,
            to: owner[0] ?? me,
            due: dueValue,
            message: '',
          });
        }
      },
      () => {
        refreshSoon();
        onCreated(created);
      },
    );
  };
  return (
    <Modal
      title="New task"
      icon={SquarePen}
      onClose={onClose}
      width={640}
      dirty={Boolean(title.trim() || body.trim() || owner.length > 0 || picked || due)}
    >
      <div className="flex flex-col gap-4">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder={question ? 'The question, in one line' : 'Task title'}
          className="w-full border-b border-white/10 bg-transparent pb-2 font-display text-xl font-semibold tracking-wide outline-none placeholder:text-fg-4 focus:border-signal/60"
        />
        <MentionArea
          value={body}
          onChange={setBody}
          me={me}
          rows={6}
          placeholder="What to do, what done means, links (Markdown). @ mentions an agent. Paste or drop images"
          onSubmit={create}
          // Images go to the default root whichever project is picked: the upload can come before
          // the choice, and an image shows from any loaded root.
          attach={{}}
          onUploading={setUploading}
        />
        <div className="grid grid-cols-[1fr_180px] gap-3">
          {idea ? (
            <Field label="Owner">
              <p className="py-2 text-xs text-fg-3">
                Ideas have no owner and stay out of every queue. Change the type to task or bug when
                it becomes work.
              </p>
            </Field>
          ) : question ? (
            <Field
              label="Ask"
              hint="The agent that answers; only it takes the question, and the answer comes back to your inbox"
            >
              <AgentPicker
                value={owner.filter((o) => !o.startsWith('human:'))}
                onChange={setOwner}
                me={me}
                noHumans
                placeholder="codex:qa, claude:pm…"
              />
            </Field>
          ) : (
            <Field
              label="Owner"
              hint="An agent, a group such as codex:* or *:engineer, or a person"
            >
              <AgentPicker value={owner} onChange={setOwner} me={me} placeholder="Unassigned" />
            </Field>
          )}
          <Field label="Project">
            <ProjectPicker
              value={root}
              options={names}
              onChange={setPicked}
              onAdd={openAddProject}
              search={search}
            />
          </Field>
        </div>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Priority">
            <div className="flex gap-1">
              {PRIORITIES.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPriority(p.key)}
                  title={p.key}
                  className={cx(
                    'inline-flex h-[34px] items-center gap-1.5 rounded-lg px-2.5 text-xs transition',
                    priority === p.key ? 'ring-1' : 'bg-white/4 text-fg-3 hover:bg-white/8',
                  )}
                  style={
                    priority === p.key
                      ? {
                          color: p.key === 'p3' ? '#b4bccb' : p.color,
                          background: `color-mix(in oklab, ${p.color} 14%, transparent)`,
                          boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${p.color} 45%, transparent)`,
                        }
                      : undefined
                  }
                >
                  <PriorityIcon p={p.key} /> {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Type">
            <div className="flex gap-1">
              {TYPES.map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setType(v)}
                  className={cx(
                    'h-[34px] rounded-lg px-2.5 text-xs transition',
                    type === v
                      ? 'bg-white/12 text-fg ring-1 ring-white/20'
                      : 'bg-white/4 text-fg-3 hover:bg-white/8',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>
          {!idea && !question && (
            <Field label="Due">
              <DuePicker value={due} onChange={setDue} />
            </Field>
          )}
        </div>
        <ErrorLine error={act.error} />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-fg-4">
            Ctrl+Enter in the description creates it
          </span>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={!title.trim() || act.busy || uploading || missing}
            title={
              uploading
                ? 'Waiting for the image upload'
                : missing
                  ? 'Pick the agent that answers first'
                  : undefined
            }
            onClick={create}
          >
            {idea ? 'Create idea' : question ? 'Ask' : 'Create task'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
