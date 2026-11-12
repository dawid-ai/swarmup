import { FolderGit2, FolderOpen, FolderPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { bridge, refreshSoon } from '../api';
import {
  Button,
  ErrorLine,
  Field,
  Input,
  Modal,
  Priority,
  toast,
  useAction,
  cx,
} from '../components';
import type { ProjectAdded, ProjectCreated, ProjectPlan, ProjectProposal } from '../types';

/** The window event that asks App to start Add project, from any view. */
export const ADD_PROJECT_EVENT = 'swarmup:add-project';

/** Starts Add project from anywhere: App opens the folder dialog, then the proposal. */
export function openAddProject(): void {
  window.dispatchEvent(new Event(ADD_PROJECT_EVENT));
}

/** What App holds while Add project is open: a proposal to review, or why the pick failed. */
export type AddProjectState = { proposal: ProjectProposal } | { error: string };

function addedText(a: ProjectAdded): string {
  const name = a.name ?? a.dir;
  const text = a.added ? `Added ${name}: it has a data root already` : `${name} is loaded already`;
  return a.reloaded ? text : `${text}. Restart swarmupd in Settings to load it`;
}

/**
 * Opens the system folder dialog and surveys the pick. Resolves the state for the dialog, or
 * null when there is nothing to review: the person cancelled, or the folder had a data root and
 * only joined the roots.
 */
export async function pickProject(): Promise<AddProjectState | null> {
  const res = await bridge().projectPick();
  if (!res.ok || !res.data) {
    return res.error === 'cancelled' ? null : { error: res.error ?? 'could not read the folder' };
  }
  if (res.data.kind === 'added') {
    toast(addedText(res.data));
    refreshSoon();
    return null;
  }
  return { proposal: res.data };
}

function Found({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-1 text-sm">
      <span className="label-caps w-24 shrink-0 pt-0.5 !text-[10px]">{label}</span>
      <span className={cx('min-w-0 break-words', value === 'none found' && 'text-fg-4')}>
        {value}
      </span>
    </div>
  );
}

const list = (items: string[]): string => items.join(', ') || 'none found';

/**
 * Add project (AO-0274): what the survey of the picked repo found and the root it proposes.
 * Nothing is written until Create. `auto` creates as soon as it shows, for the screenshot run.
 */
export function AddProject(props: {
  state: AddProjectState;
  /** Picks another folder; the dialog shows its proposal or its error. */
  onPick: () => void;
  onClose: () => void;
  onCreated: (p: ProjectCreated) => void;
  auto?: boolean;
}) {
  const proposal = 'proposal' in props.state ? props.state.proposal : null;
  const [plan, setPlan] = useState<ProjectPlan | null>(proposal?.plan ?? null);
  const [name, setName] = useState(proposal?.plan.name ?? '');
  const [prefix, setPrefix] = useState(proposal?.plan.prefix ?? '');
  /** The prefix follows the name until the person types one. */
  const [ownPrefix, setOwnPrefix] = useState(false);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [where, setWhere] = useState<'repo' | 'store'>('repo');
  const [store, setStore] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const act = useAction();

  // The first tasks name the project: a changed name gets its plan again, a moment after typing.
  const asked = useRef(proposal?.plan.name ?? '');
  useEffect(() => {
    const n = name.trim();
    if (!proposal || !n || n === asked.current) return;
    const timer = setTimeout(() => {
      asked.current = n;
      void bridge()
        .projectPlan(n)
        .then((res) => {
          if (!res.ok || !res.data || asked.current !== n) return;
          setPlan(res.data);
          if (!ownPrefix) setPrefix(res.data.prefix);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [name, proposal, ownPrefix]);

  const create = (): void => {
    if (!plan) return;
    const tasks = plan.tasks.map((_, i) => i).filter((i) => !off.has(i));
    act.run(async () => {
      const res = await bridge().projectCreate({ name: name.trim(), prefix, tasks, where });
      if (!res.ok || !res.data) throw new Error(res.error ?? 'could not create the project');
      refreshSoon();
      props.onCreated(res.data);
    });
  };
  const started = useRef(false);
  useEffect(() => {
    if (!props.auto || !plan || started.current) return;
    started.current = true;
    create();
  });

  const pickStore = (): void => {
    setStoreError(null);
    void bridge()
      .projectStore()
      .then((res) => {
        if (res.ok && res.data) setStore(res.data.dir);
        else if (res.error !== 'cancelled') setStoreError(res.error ?? 'could not use the folder');
      });
  };

  if (!proposal || !plan) {
    return (
      <Modal title="Add project" icon={FolderPlus} onClose={props.onClose} width={560}>
        <div className="flex flex-col gap-4">
          <ErrorLine error={'error' in props.state ? props.state.error : null} />
          <div className="flex justify-end gap-2">
            <Button kind="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button kind="primary" icon={FolderOpen} onClick={props.onPick}>
              Pick another folder
            </Button>
          </div>
        </div>
      </Modal>
    );
  }
  const s = proposal.survey;
  const tests = s.tests.files
    ? `${s.tests.files} files${s.tests.runner ? `, ${s.tests.runner}` : ''}${s.tests.command ? ` (${s.tests.command})` : ''}`
    : s.tests.runner
      ? `no test files; ${s.tests.runner} is set up`
      : 'none found';
  const ready =
    Boolean(name.trim()) && Boolean(prefix.trim()) && (where === 'repo' || Boolean(store));
  return (
    <Modal
      title="Add project"
      icon={FolderPlus}
      onClose={props.onClose}
      width={720}
      dirty={name !== proposal.plan.name || ownPrefix || off.size > 0 || where === 'store'}
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-2 rounded-lg bg-white/3 px-3 py-2 font-mono text-xs">
          <FolderGit2 size={14} className="shrink-0 text-fg-4" />
          <span className="min-w-0 flex-1 truncate" title={proposal.dir}>
            {proposal.dir}
          </span>
          <Button size="sm" kind="ghost" onClick={props.onPick}>
            Change
          </Button>
        </div>

        <section aria-label="What the survey found">
          <div className="label-caps pb-1.5">Found in the repo</div>
          <div className="grid grid-cols-2 gap-x-6 rounded-xl border border-white/8 px-3 py-1.5">
            <Found label="Languages" value={list(s.stacks)} />
            <Found label="Frameworks" value={list(s.frameworks)} />
            <Found label="Tests" value={tests} />
            <Found label="Build" value={s.build ?? 'none found'} />
            <Found label="Lint" value={s.lint ?? 'none found'} />
            <Found label="Docs" value={list([...s.docs, ...s.agentDocs])} />
            <Found label="CI" value={list(s.ci)} />
          </div>
        </section>

        <div className="grid grid-cols-[1fr_160px] gap-3">
          <Field label="Project name">
            <Input value={name} onChange={setName} autoFocus />
          </Field>
          <Field label="Id prefix" hint={`Tasks are ${prefix || 'T'}-0001 and up`}>
            <Input
              value={prefix}
              onChange={(v) => {
                setOwnPrefix(true);
                setPrefix(v.toUpperCase());
              }}
              className="font-mono"
            />
          </Field>
        </div>

        <section aria-label="Roles">
          <div className="label-caps pb-1.5">Roles</div>
          <ul className="flex flex-col gap-1">
            {plan.agents.map((a) => (
              <li key={a.id} className="flex gap-3 text-sm">
                <span className="w-36 shrink-0 font-mono text-xs leading-5 text-fg-2">{a.id}</span>
                <span className="text-fg-3">{a.why}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="First tasks">
          <div className="label-caps pb-1.5">First tasks</div>
          <ul className="flex flex-col gap-1">
            {plan.tasks.map((t, i) => (
              <li key={t.title}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-white/4">
                  <input
                    type="checkbox"
                    className="accent-[#5ce1e6]"
                    checked={!off.has(i)}
                    onChange={() => {
                      const next = new Set(off);
                      if (!next.delete(i)) next.add(i);
                      setOff(next);
                    }}
                  />
                  <span className="w-[76px] shrink-0">
                    <Priority p={t.priority} />
                  </span>
                  <span className={cx('min-w-0 flex-1', off.has(i) && 'text-fg-4 line-through')}>
                    {t.title}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section aria-label="Where tasks live">
          <div className="label-caps pb-1.5">Where tasks live</div>
          <div className="flex flex-col gap-2">
            <Where
              checked={where === 'repo'}
              onPick={() => setWhere('repo')}
              title="In this repo"
              text="A .swarmup folder in the repo, committed with the code."
            />
            <Where
              checked={where === 'store'}
              onPick={() => setWhere('store')}
              title="In a separate folder"
              text="For a public repo whose tasks stay private. Runs and merges still happen in the repo."
            >
              {where === 'store' && (
                <div className="mt-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={cx(
                        'min-w-0 flex-1 truncate rounded-lg bg-white/3 px-3 py-2 font-mono text-xs',
                        !store && 'text-fg-4',
                      )}
                    >
                      {store ?? 'No folder picked'}
                    </span>
                    <Button size="sm" icon={FolderOpen} onClick={pickStore}>
                      {store ? 'Change folder' : 'Pick or create a folder'}
                    </Button>
                  </div>
                  <div className="text-xs text-fg-4">
                    Your user config names this repo as the project's code checkout, and approved
                    work merges into{' '}
                    <span className="font-mono text-fg-3">{proposal.branch ?? 'its branch'}</span>,
                    the branch checked out now.
                  </div>
                  <ErrorLine error={storeError} />
                </div>
              )}
            </Where>
          </div>
        </section>

        <ErrorLine error={act.error} />
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-xs text-fg-4">Nothing is written until you create it.</span>
          <Button kind="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button kind="primary" icon={FolderPlus} disabled={!ready || act.busy} onClick={create}>
            {act.busy ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Where(props: {
  checked: boolean;
  onPick: () => void;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cx(
        'rounded-xl border px-3 py-2.5 transition',
        props.checked ? 'border-signal/40 bg-signal/5' : 'border-white/8',
      )}
    >
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="radio"
          name="where-tasks-live"
          className="mt-1 accent-[#5ce1e6]"
          checked={props.checked}
          onChange={props.onPick}
        />
        <span>
          <span className="block text-sm font-medium">{props.title}</span>
          <span className="block text-xs text-fg-3">{props.text}</span>
        </span>
      </label>
      {props.children}
    </div>
  );
}
