import { BookOpen, FilePlus2, PenLine, Save, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, q, refreshSoon, useData } from '../api';
import {
  Button,
  ErrorLine,
  Field,
  Input,
  Modal,
  Select,
  TextArea,
  Toggle,
  toast,
  useAction,
  cx,
} from '../components';
import { identity } from '../lib/identity';
import { splitList } from '../lib/thread';
import type { KbNote, RoleFile, Settings } from '../types';
import { ProviderMark } from './identity';
import { useProjectLabel } from './project-label';

const ROLE_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Creates a role file (`agents/<runtime>-<role>.md`) or edits one: instructions, the knowledge
 * it reads first (learn-note topics and files), its writing style and its limits. Tool
 * permissions stay in the file; the app does not change them.
 */
export function RoleEditor({
  id,
  preset,
  onClose,
  me,
}: {
  /** The role to edit; none creates a new one. */
  id?: string;
  /** Starts a new role with this provider and role name filled in. */
  preset?: { runtime: string; role: string };
  onClose: () => void;
  me: string | null;
}) {
  const creating = !id;
  const settings = useData<Settings>('/api/settings');
  const existing = useData<RoleFile>(id ? `/api/roles/${q(id)}` : null);
  const notes = useData<KbNote[]>('/api/kb');
  const topics = useMemo(
    () => [...new Set((notes.data ?? []).map((n) => n.topic))].sort(),
    [notes.data],
  );
  const runtimes = Object.keys(settings.data?.opsd.runtimes ?? { claude: 1, codex: 1 });
  const roots = (settings.data?.rootList ?? []).filter((r) => !r.isMirror);
  const projectLabel = useProjectLabel();

  const [runtime, setRuntime] = useState(preset?.runtime ?? 'claude');
  const [role, setRole] = useState(preset?.role ?? '');
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  /** Active as loaded: a folder layer gets `status` only when you change it (W5). */
  const [loadedActive, setLoadedActive] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [kb, setKb] = useState<string[]>([]);
  const [topicText, setTopicText] = useState('');
  const [files, setFiles] = useState('');
  const [style, setStyle] = useState('');
  const [budget, setBudget] = useState('');
  const [claims, setClaims] = useState('');
  const [wake, setWake] = useState(false);
  /** A folder agent (W5): edit the role's agent.md, or this runtime's addendum. */
  const [scope, setScope] = useState<'role' | 'runtime'>('role');
  const act = useAction();
  const folder = existing.data?.folder;

  useEffect(() => {
    const r = existing.data;
    if (!r) return;
    // A folder agent edits one of its two files; a legacy role file is the agent as it reads.
    const layer = r.layers ? (scope === 'runtime' ? r.layers.runtime : r.layers.role) : null;
    const d = (r.layers ? (layer?.data ?? {}) : r) as Partial<RoleFile>;
    setName(d.name ?? '');
    setDescription(d.description ?? '');
    const shown = (d.status ?? r.status) === 'active';
    setActive(shown);
    setLoadedActive(shown);
    setInstructions(r.layers ? (layer?.instructions ?? '') : (r.instructions ?? ''));
    setKb(d.kb ?? []);
    setFiles((d.files ?? []).join('\n'));
    setStyle(d.style ?? '');
    setBudget(d.budget_min === undefined ? '' : String(d.budget_min));
    setClaims((d.can_claim ?? []).join(', '));
  }, [existing.data, scope]);
  useEffect(() => {
    if (id && settings.data) setWake(settings.data.opsd.agents[id]?.wake ?? false);
  }, [id, settings.data]);
  useEffect(() => {
    if (!root && roots[0]) setRoot(roots[0].name);
  }, [roots, root]);

  const fullId = id ?? `${runtime}:${role.trim()}`;
  const roleOk = !creating || ROLE_RE.test(role.trim());
  const addTopic = (): void => {
    const t = topicText.trim().toLowerCase();
    if (t && !kb.includes(t)) setKb([...kb, t]);
    setTopicText('');
  };
  const save = (): void =>
    act.run(async () => {
      await api('POST', '/api/roles', {
        as: me,
        create: creating,
        root: creating ? root || undefined : undefined,
        ...(folder ? { scope } : {}),
        role: {
          id: fullId,
          name: name.trim() || null,
          description: description.trim() || null,
          // A folder layer without `status` reads it from the other layer: writing the shown value
          // back would copy one runtime's pause into agent.md, which pauses every runtime.
          ...(!folder || active !== loadedActive ? { status: active ? 'active' : 'paused' } : {}),
          instructions,
          kb: kb.length > 0 ? kb : null,
          files: splitList(files).length > 0 ? splitList(files) : null,
          style: style.trim() || null,
          budget_min: budget.trim() ? Number(budget) : null,
          can_claim: splitList(claims).length > 0 ? splitList(claims) : null,
        },
      });
      const wasWake = settings.data?.opsd.agents[fullId]?.wake ?? false;
      if (wake !== wasWake) {
        await api('POST', '/api/settings', { patch: { opsd: { agents: { [fullId]: { wake } } } } });
      }
      toast(creating ? `Created ${fullId}` : `Saved ${fullId}`);
      refreshSoon();
      onClose();
    });

  const who = identity(fullId);
  const slug = (fullId || 'runtime:role').replace(':', '-');
  const runtimeOf = fullId.slice(0, fullId.indexOf(':'));
  const roleOf = fullId.slice(fullId.indexOf(':') + 1);
  const savedAs = folder
    ? scope === 'runtime'
      ? `agents/${folder.role}/${runtimeOf}.md`
      : `agents/${folder.role}/agent.md`
    : `agents/${slug}.md`;
  return (
    <Modal
      title={creating ? 'Create role' : `Edit ${id}`}
      icon={creating ? FilePlus2 : PenLine}
      onClose={onClose}
      width={720}
    >
      <div className="flex flex-col gap-4">
        <p className="text-xs leading-relaxed text-fg-3">
          A role file tells an agent who it is and how to work. swarmupd points every run of{' '}
          <span className="font-mono">{fullId || 'runtime:role'}</span> at it, with the knowledge
          below. Saved as <span className="font-mono text-fg-2">{savedAs}</span> in the data root,
          so it syncs with the tasks.
        </p>
        {folder && (
          <div className="flex flex-col gap-2" data-role-scope>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="label-caps mr-1">Edit</span>
              {(
                [
                  [
                    'role',
                    `The ${roleOf} role`,
                    `agent.md: every runtime of the role reads it (${(existing.data?.providers ?? []).join(', ')})`,
                  ],
                  [
                    'runtime',
                    `Only ${runtimeOf}`,
                    `${runtimeOf}.md: overrides for ${fullId} alone`,
                  ],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  title={hint}
                  aria-pressed={scope === value}
                  data-scope={value}
                  onClick={() => setScope(value)}
                  className={cx(
                    'rounded-md px-2 py-1 text-xs transition',
                    scope === value
                      ? 'bg-signal/20 text-signal'
                      : 'bg-white/6 text-fg-3 hover:bg-white/10 hover:text-fg',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-fg-4">
              {scope === 'runtime'
                ? `Empty fields take the role's value from agent.md. The instructions here come ${
                    folder.bodyMode === 'replace'
                      ? "instead of the role's (body: replace)"
                      : "after the role's"
                  }.`
                : `Every runtime of the role reads these values, unless its own file overrides them. Its runtimes come from ${
                    folder.providersFrom === 'agent'
                      ? 'providers in agent.md'
                      : folder.providersFrom === 'swarm-role'
                        ? `roles.${roleOf}.providers in swarm.yaml`
                        : folder.providersFrom === 'swarm-runtimes'
                          ? 'the runtimes in swarm.yaml'
                          : 'the default providers'
                  }.`}
            </p>
          </div>
        )}
        {existing.data?.settings && existing.data.settings.length > 0 && (
          <div className="rounded-lg border border-white/8 p-2.5" data-role-settings>
            <div className="label-caps mb-1.5">Run settings and where they come from</div>
            <div className="flex flex-col gap-1">
              {existing.data.settings.map((s) => (
                <div
                  key={s.key}
                  className="flex flex-wrap items-center gap-2 text-xs"
                  data-setting={s.key}
                >
                  <span className="font-mono text-fg-3">{s.key}</span>
                  <span className="font-mono text-fg">{JSON.stringify(s.value)}</span>
                  <span
                    data-from={s.from}
                    className={cx(
                      'rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase',
                      s.from === 'machine'
                        ? 'bg-warn/15 text-warn'
                        : s.from === 'swarm.yaml'
                          ? 'bg-info/15 text-info'
                          : 'bg-white/8 text-fg-3',
                    )}
                  >
                    {s.from === 'machine'
                      ? 'this machine'
                      : s.from === 'swarm.yaml'
                        ? 'swarm.yaml'
                        : 'role file'}
                  </span>
                  {s.over !== undefined && (
                    <span className="text-fg-4">over {JSON.stringify(s.over)} from git</span>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-fg-4">
              A value set on this machine (Settings) wins over swarm.yaml and the role file.
            </p>
          </div>
        )}

        <ErrorLine error={existing.error ?? settings.error} />

        {creating ? (
          <div className="grid grid-cols-[1fr_1fr_1fr] gap-3">
            <Field label="Provider">
              <Select
                value={runtime}
                onChange={setRuntime}
                options={runtimes.map((r) => [r, identity(`${r}:x`).provider.label])}
              />
            </Field>
            <Field
              label="Role"
              hint={
                role && !roleOk ? (
                  <span className="text-warn">Lowercase letters, digits and hyphens</span>
                ) : (
                  'For example writer, designer, researcher'
                )
              }
            >
              <Input value={role} onChange={setRole} placeholder="writer" autoFocus />
            </Field>
            <Field label="Data root">
              <Select
                value={root}
                onChange={setRoot}
                options={roots.map((r) => [
                  r.name,
                  r.isMaster ? `${projectLabel(r.name)} (Master Repo)` : projectLabel(r.name),
                ])}
              />
            </Field>
          </div>
        ) : (
          <div className="flex items-center gap-2.5">
            <ProviderMark runtime={who.runtime} size={18} />
            <span className="font-mono text-sm" style={{ color: who.provider.color }}>
              {id}
            </span>
            {existing.data?.root && (
              <span className="text-xs text-fg-4">in {projectLabel(existing.data.root)}</span>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input value={name} onChange={setName} placeholder="Writer" />
          </Field>
          <Field label="Description">
            <Input
              value={description}
              onChange={setDescription}
              placeholder="Drafts posts and docs in my voice"
            />
          </Field>
        </div>

        <Field
          label="Instructions"
          hint="Markdown. What the role does, how it works, what done means."
        >
          <TextArea
            value={instructions}
            onChange={setInstructions}
            rows={8}
            placeholder={
              'You write blog posts and docs for SwarmUp.\n\n- Start from the task body; ask when the audience is unclear.\n- Finish with swarmup review to human:...'
            }
          />
        </Field>

        <Field
          label="Knowledge"
          hint="Learn-note topics the agent reads before it works (swarmup kb --topic)."
        >
          <div className="flex flex-wrap items-center gap-1.5">
            {kb.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1 rounded-md bg-info/12 px-2 py-0.5 font-mono text-xs text-info"
              >
                <BookOpen size={11} /> {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => setKb(kb.filter((x) => x !== t))}
                  className="text-info/70 hover:text-info"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <Input
              value={topicText}
              onChange={setTopicText}
              onEnter={addTopic}
              placeholder="add a topic, Enter"
              className="w-44"
            />
            {topics
              .filter((t) => !kb.includes(t))
              .slice(0, 12)
              .map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setKb([...kb, t])}
                  className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-xs text-fg-3 hover:bg-white/10 hover:text-fg"
                >
                  + {t}
                </button>
              ))}
          </div>
        </Field>

        <Field
          label="Files to read first"
          hint="One per line, relative to the project: style guides, examples, docs."
        >
          <TextArea
            value={files}
            onChange={setFiles}
            rows={3}
            placeholder={'docs/voice.md\nexamples/posts/'}
            className="font-mono text-xs"
          />
        </Field>

        <Field
          label="Writing style"
          hint="Tone, format, words to use and avoid. Repeated in every run's prompt."
        >
          <TextArea
            value={style}
            onChange={setStyle}
            rows={3}
            placeholder="Plain, direct, second person. Short paragraphs. No hype words."
          />
        </Field>

        <div className="flex flex-wrap items-end gap-4">
          <Field label="Budget (minutes)">
            <Input
              type="number"
              value={budget}
              onChange={setBudget}
              placeholder={String(settings.data?.opsd.budget_minutes ?? 180)}
              className="w-28"
            />
          </Field>
          <Field label="Task types it takes" hint="Empty: any type.">
            <Input value={claims} onChange={setClaims} placeholder="task, bug" className="w-48" />
          </Field>
          <div className="flex flex-col gap-2 pb-1">
            <Toggle checked={active} onChange={setActive} label={active ? 'Active' : 'Paused'} />
            <Toggle checked={wake} onChange={setWake} label="Wake on work" />
          </div>
        </div>
        <p className="-mt-2 text-[11px] text-fg-4">
          Wake on work: swarmupd starts a run by itself when this agent has inbox items or a task to
          claim. Off: it runs only when you press Run agent, a schedule starts it, or swarmup
          launch. Live runs per project for the role are set in Settings, Roles.
        </p>

        <div className="flex items-center gap-2 border-t border-white/6 pt-4">
          <Button
            kind="primary"
            icon={Save}
            disabled={act.busy || !roleOk || (creating && !role.trim())}
            onClick={save}
          >
            {creating ? 'Create role' : 'Save'}
          </Button>
          <Button kind="ghost" onClick={onClose}>
            Cancel
          </Button>
          <div className={cx('min-w-0 flex-1')}>
            <ErrorLine error={act.error} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
