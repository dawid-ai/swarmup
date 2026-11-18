import type { LucideIcon } from 'lucide-react';
import { Archive, ArchiveRestore, FolderInput, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, bridge, refreshSoon } from '../api';
import { Button, ErrorLine, Field, Input, Modal, cx, toast } from '../components';
import type { ListedProject } from '../types';

export interface ProjectMenuRequest {
  project: ListedProject;
  x: number;
  y: number;
}

type Dialog = { kind: 'name' | 'delete'; project: ListedProject } | null;

function projectName(project: ListedProject): string {
  return project.label?.trim() || project.name?.trim() || project.root;
}

/**
 * The context menu and its small dialogs. Project writes answer with the complete configured
 * project list, so the sidebar moves an archived project immediately and then refreshes board data.
 */
export function ProjectControls(props: {
  menu: ProjectMenuRequest | null;
  onCloseMenu: () => void;
  onChanged: (projects: ListedProject[]) => void;
  onProjectUnavailable: (project: ListedProject) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');

  const changed = (projects: ListedProject[]): void => {
    props.onChanged(projects);
    refreshSoon();
  };
  const showDialog = (kind: 'name' | 'delete'): void => {
    const project = props.menu?.project;
    if (!project) return;
    setDialog({ kind, project });
    setName(projectName(project));
    setError(null);
    props.onCloseMenu();
  };
  const write = (
    action: 'archive' | 'unarchive' | 'label' | 'remove',
    project: ListedProject,
    body: Record<string, unknown> = {},
  ): Promise<ListedProject[]> =>
    api<ListedProject[]>('POST', `/api/projects/${action}`, { root: project.root, ...body });

  const toggleArchive = (project: ListedProject): void => {
    props.onCloseMenu();
    const action = project.archived ? 'unarchive' : 'archive';
    write(action, project).then(
      (projects) => {
        changed(projects);
        if (!project.archived) props.onProjectUnavailable(project);
        toast(`${projectName(project)} ${project.archived ? 'unarchived' : 'archived'}`);
      },
      (e: Error) => toast(e.message, { tone: 'bad' }),
    );
  };

  const relocate = (project: ListedProject): void => {
    props.onCloseMenu();
    void bridge()
      .projectRelocate(project.root)
      .then((res) => {
        if (!res.ok || !res.data) {
          if (res.error !== 'cancelled')
            toast(res.error ?? 'project relocation failed', { tone: 'bad' });
          return;
        }
        changed(res.data);
        toast(`${projectName(project)} location updated`);
      })
      .catch((e: Error) => toast(e.message, { tone: 'bad' }));
  };

  const saveName = (): void => {
    if (!dialog || dialog.kind !== 'name') return;
    setBusy(true);
    setError(null);
    write('label', dialog.project, { label: name }).then(
      (projects) => {
        setBusy(false);
        changed(projects);
        setDialog(null);
        toast(`Project name changed to ${name.trim() || dialog.project.name || 'default'}`);
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };

  const remove = (): void => {
    if (!dialog || dialog.kind !== 'delete') return;
    const project = dialog.project;
    setBusy(true);
    setError(null);
    write('remove', project).then(
      (projects) => {
        setBusy(false);
        changed(projects);
        props.onProjectUnavailable(project);
        setDialog(null);
        toast(`${projectName(project)} removed from SwarmUp`);
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };

  return (
    <>
      {props.menu && (
        <ProjectMenu
          request={props.menu}
          onClose={props.onCloseMenu}
          onName={() => showDialog('name')}
          onLocation={() => relocate(props.menu!.project)}
          onArchive={() => toggleArchive(props.menu!.project)}
          onDelete={() => showDialog('delete')}
        />
      )}
      {dialog?.kind === 'name' && (
        <Modal
          title={`Edit ${projectName(dialog.project)}`}
          icon={Pencil}
          width={440}
          dirty={name !== projectName(dialog.project)}
          onClose={() => setDialog(null)}
        >
          <div className="space-y-4">
            <Field
              label="Project name"
              hint="This changes the name shown in SwarmUp. Task references keep the root's own name."
            >
              <Input value={name} onChange={setName} autoFocus onEnter={saveName} />
            </Field>
            <ErrorLine error={error} />
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button kind="primary" disabled={busy || !name.trim()} onClick={saveName}>
                {busy ? 'Saving…' : 'Save name'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          title={`Delete ${projectName(dialog.project)}?`}
          icon={TriangleAlert}
          width={470}
          onClose={() => setDialog(null)}
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-bad/20 bg-bad/7 p-4">
              <div className="font-medium text-fg">Remove this project from SwarmUp?</div>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-3">
                This removes it only from SwarmUp's project list. No files or folders on disk will
                be deleted.
              </p>
              <code className="mt-3 block truncate rounded-lg bg-black/20 px-2.5 py-2 text-xs text-fg-4">
                {dialog.project.root}
              </code>
            </div>
            <ErrorLine error={error} />
            <div className="flex justify-end gap-2">
              <Button kind="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button kind="danger" disabled={busy} onClick={remove} icon={Trash2}>
                {busy ? 'Removing…' : 'Delete project'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function ProjectMenu(props: {
  request: ProjectMenuRequest;
  onClose: () => void;
  onName: () => void;
  onLocation: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const width = 210;
  const height = 184;
  const left = Math.max(8, Math.min(props.request.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(props.request.y, window.innerHeight - height - 8));
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) props.onClose();
    };
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const items = [
        ...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
      ];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
    };
  }, [props]);

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={`${projectName(props.request.project)} project actions`}
      data-project-menu
      className="animate-fade fixed z-50 w-[210px] overflow-hidden rounded-xl border border-white/12 bg-ink-800 p-1.5 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.95)]"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <MenuItem icon={Pencil} label="Edit name" onClick={props.onName} />
      <MenuItem icon={FolderInput} label="Edit location" onClick={props.onLocation} />
      <MenuItem
        icon={props.request.project.archived ? ArchiveRestore : Archive}
        label={props.request.project.archived ? 'Unarchive' : 'Archive'}
        onClick={props.onArchive}
      />
      <div className="my-1 h-px bg-white/8" />
      <MenuItem icon={Trash2} label="Delete" danger onClick={props.onDelete} />
    </div>,
    document.body,
  );
}

function MenuItem(props: {
  icon: LucideIcon;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={props.onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition',
        props.danger
          ? 'text-bad hover:bg-bad/10 focus:bg-bad/10'
          : 'text-fg-2 hover:bg-white/7 hover:text-fg focus:bg-white/7 focus:text-fg',
      )}
    >
      <Icon size={15} strokeWidth={2} className={props.danger ? 'text-bad' : 'text-fg-4'} />
      {props.label}
    </button>
  );
}
