import { Archive, FilePlus2, FolderCog, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, q, refreshSoon } from '../api';
import { Button, ErrorLine, Field, Input, Modal, cx, toast, useAction } from '../components';
import type { RootInfo } from '../types';

export interface MenuPosition {
  x: number;
  y: number;
}

/** The compact, project-local command surface opened by a sidebar right click. */
export function ProjectMenu(props: {
  project: RootInfo;
  at: MenuPosition;
  onClose: () => void;
  onNew: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const self = useRef<HTMLDivElement>(null);
  const act = useAction();
  useEffect(() => {
    const close = (e: MouseEvent): void => {
      if (!self.current?.contains(e.target as Node)) props.onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [props]);
  const archive = (): void =>
    act.run(
      () =>
        api('POST', `/api/roots/${q(props.project.name)}/archive`, {
          on: !props.project.archived,
        }),
      () => {
        toast(
          props.project.archived
            ? `Restored ${props.project.name}`
            : `Archived ${props.project.name}`,
        );
        props.onClose();
        props.onChanged();
        refreshSoon();
      },
    );
  return (
    <div
      ref={self}
      role="menu"
      aria-label={`${props.project.name} project actions`}
      className="animate-rise fixed z-50 w-48 overflow-hidden rounded-xl border border-white/12 bg-ink-800/98 p-1.5 text-sm shadow-[0_20px_55px_-18px_rgba(0,0,0,0.95)] backdrop-blur-xl"
      style={{ left: props.at.x, top: props.at.y }}
    >
      <div className="truncate px-2.5 pt-1 pb-2 font-mono text-[10px] tracking-wide text-fg-4 uppercase">
        {props.project.name}
      </div>
      {!props.project.archived && <Item icon={FilePlus2} label="Add new" onClick={props.onNew} />}
      {!props.project.archived && !props.project.isMirror && (
        <Item icon={FolderCog} label="Edit" onClick={props.onEdit} />
      )}
      <Item
        icon={props.project.archived ? RotateCcw : Archive}
        label={props.project.archived ? 'Restore' : 'Archive'}
        disabled={act.busy}
        onClick={archive}
      />
      <div className="my-1 border-t border-white/7" />
      <Item icon={Trash2} label="Remove" danger onClick={props.onRemove} />
      <ErrorLine error={act.error} />
    </div>
  );
}

function Item(props: {
  icon: typeof Archive;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition disabled:opacity-50',
        props.danger ? 'text-bad hover:bg-bad/10' : 'text-fg-2 hover:bg-white/7 hover:text-fg',
      )}
    >
      <Icon size={15} />
      {props.label}
    </button>
  );
}

/** The same project facts Add project establishes, editable without touching folders on disk. */
export function EditProjectDialog(props: {
  project: RootInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const p = props.project;
  const initial = {
    name: p.name,
    root: p.listed ?? p.dir,
    code: p.code ?? '',
    base: p.base ?? '',
  };
  const [name, setName] = useState(initial.name);
  const [root, setRoot] = useState(initial.root);
  const [code, setCode] = useState(initial.code);
  const [base, setBase] = useState(initial.base);
  const act = useAction();
  const dirty =
    name !== initial.name ||
    root !== initial.root ||
    code !== initial.code ||
    base !== initial.base;
  const save = (): void =>
    act.run(
      () =>
        api('POST', `/api/roots/${q(p.name)}/edit`, {
          name: name.trim(),
          root: root.trim(),
          code: code.trim() || null,
          base: base.trim() || null,
        }),
      () => {
        toast(`Saved ${name.trim()}`);
        props.onClose();
        props.onSaved();
        refreshSoon();
      },
    );
  return (
    <Modal
      title={`Edit ${p.name}`}
      icon={FolderCog}
      width={620}
      dirty={dirty}
      onClose={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <Field label="Project name">
          <Input value={name} onChange={setName} autoFocus />
        </Field>
        <Field label="Task store" hint="The repo with .swarmup, or a dedicated data repo">
          <Input value={root} onChange={setRoot} className="font-mono" />
        </Field>
        <div className="grid grid-cols-[1fr_150px] gap-3">
          <Field label="Code checkout" hint="Blank when the task store lives in the code repo">
            <Input value={code} onChange={setCode} className="font-mono" />
          </Field>
          <Field label="Merge branch">
            <Input value={base} onChange={setBase} className="font-mono" />
          </Field>
        </div>
        <div className="rounded-lg border border-white/7 bg-white/3 px-3 py-2 text-xs text-fg-3">
          Changing these settings only changes where SwarmUp looks. It never moves a folder or
          changes the checked-out branch for you.
        </div>
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            kind="primary"
            disabled={!dirty || !name.trim() || !root.trim() || act.busy}
            onClick={save}
          >
            Save project
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function RemoveProjectDialog(props: {
  project: RootInfo;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const act = useAction();
  const remove = (): void =>
    act.run(
      () => api('POST', `/api/roots/${q(props.project.name)}/remove`),
      () => {
        toast(`Removed ${props.project.name} from SwarmUp`);
        props.onClose();
        props.onRemoved();
        refreshSoon();
      },
    );
  return (
    <Modal
      title={`Remove ${props.project.name}?`}
      icon={Trash2}
      width={520}
      onClose={props.onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-bad/25 bg-bad/7 px-4 py-3 text-sm text-fg-2">
          This removes the project from SwarmUp on this PC. The task store, code checkout and any
          Master Repo copy stay on disk; no files or folders are deleted.
        </div>
        <div className="truncate font-mono text-xs text-fg-4" title={props.project.dir}>
          {props.project.dir}
        </div>
        <ErrorLine error={act.error} />
        <div className="flex justify-end gap-2">
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button kind="danger" disabled={act.busy} onClick={remove}>
            Remove from SwarmUp
          </Button>
        </div>
      </div>
    </Modal>
  );
}
