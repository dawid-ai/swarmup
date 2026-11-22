import { KeyRound, Pencil, Plug, Plus, Save, Trash2, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { api, useData } from '../api';
import { Button, ErrorLine, Field, Input, Toggle, toast, useAction, Who } from '../components';
import { joinArgs, splitArgs } from '../lib/thread';
import type { McpServerView, McpView } from '../types';

/** A comma-separated list as text, and back. */
const listText = (l: readonly string[] | undefined): string => (l ?? []).join(', ');
const textList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * A server's environment as the form's text: one `NAME=value` per line, and `NAME=secret:KEY`
 * for a value kept in `secrets.yml`.
 */
export function envText(env: McpServerView['env']): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : `secret:${v.secret}`}`)
    .join('\n');
}

/** The form's environment text as `env`, or the line that is wrong. */
export function parseEnvText(
  text: string,
): { env: Record<string, string | { secret: string }> } | { error: string } {
  const env: Record<string, string | { secret: string }> = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf('=');
    const name = at > 0 ? line.slice(0, at).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { error: `Line ${i + 1}: write NAME=value or NAME=secret:KEY` };
    }
    const value = line.slice(at + 1).trim();
    const secret = /^secret:([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
    env[name] = secret ? { secret: secret[1]! } : value;
  }
  return { env };
}

function Panel(props: { icon: typeof Plug; title: string; hint?: ReactNode; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <section className="panel animate-rise">
      <header className="flex items-start gap-3 border-b border-white/6 px-5 py-3.5">
        <Icon size={18} className="mt-0.5 text-signal" />
        <div>
          <h2 className="font-display text-base font-semibold tracking-wide">{props.title}</h2>
          {props.hint && <div className="text-xs text-fg-3">{props.hint}</div>}
        </div>
      </header>
      <div className="px-5 py-4">{props.children}</div>
    </section>
  );
}

/**
 * **Settings > MCP servers** (W8): the servers this machine defines, with their scope and tool
 * rules; the secrets they read, set or replaced but never shown; and each agent's servers.
 */
export function McpServersPanel() {
  const { data, error, set } = useData<McpView>('/api/mcp');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const act = useAction();
  const remove = (name: string): void =>
    act.run(async () => {
      set(await api<McpView>('POST', `/api/mcp/servers/${encodeURIComponent(name)}/delete`));
      toast(`Removed ${name}: runs that start from now on do not get it`);
    });
  const strict = (on: boolean): void =>
    act.run(async () => set(await api<McpView>('POST', '/api/mcp/strict', { strict: on })));
  return (
    <div data-mcp-settings className="flex flex-col gap-5">
      <ErrorLine error={error ?? data?.error ?? null} />
      <Panel
        icon={Plug}
        title="Servers"
        hint="A role file names the servers it may use (mcp); a run gets those this machine defines and grants to its project and agent"
      >
        <div className="flex flex-col gap-2">
          {data && data.servers.length === 0 && editing !== 'new' && (
            <div className="text-sm text-fg-4">No MCP servers on this machine.</div>
          )}
          {data?.servers.map((s) =>
            editing === s.name ? (
              <McpServerForm
                key={s.name}
                existing={s}
                onDone={(view) => {
                  if (view) set(view);
                  setEditing(null);
                }}
              />
            ) : (
              <div
                key={s.name}
                data-mcp-server={s.name}
                className="flex items-start gap-3 rounded-xl bg-white/3 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-fg">{s.name}</span>
                    {s.publish && (
                      <span className="rounded bg-warn/12 px-1.5 text-[11px] text-warn">
                        publish only
                      </span>
                    )}
                  </div>
                  <div className="truncate font-mono text-xs text-fg-3">
                    {s.command} {joinArgs(s.args)}
                  </div>
                  <div data-mcp-scope className="text-xs text-fg-3">
                    {s.publish
                      ? 'Never granted to a role'
                      : `Projects: ${s.roots.length ? s.roots.join(', ') : 'all'} · Agents: ${s.agents.length ? s.agents.join(', ') : 'all'}`}
                  </div>
                  {(s.tools.allow?.length || s.tools.deny?.length) && (
                    <div data-mcp-tools className="text-xs text-fg-3">
                      {s.tools.allow?.length ? `Tools allowed: ${s.tools.allow.join(', ')}` : ''}
                      {s.tools.allow?.length && s.tools.deny?.length ? ' · ' : ''}
                      {s.tools.deny?.length ? `Tools denied: ${s.tools.deny.join(', ')}` : ''}
                    </div>
                  )}
                  {Object.entries(s.env).map(([k, v]) =>
                    typeof v === 'string' ? null : (
                      <div key={k} className="text-xs text-fg-3">
                        {k} from secret <span className="font-mono">{v.secret}</span>:{' '}
                        {v.set ? (
                          <span className="text-ok">set</span>
                        ) : (
                          <span className="text-warn">not set</span>
                        )}
                      </div>
                    ),
                  )}
                </div>
                <Button
                  size="sm"
                  kind="ghost"
                  icon={Pencil}
                  onClick={() => setEditing(s.name)}
                  title="Edit"
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  kind="ghost"
                  icon={Trash2}
                  disabled={act.busy}
                  onClick={() => remove(s.name)}
                  title="Remove"
                >
                  Remove
                </Button>
              </div>
            ),
          )}
          {editing === 'new' ? (
            <McpServerForm
              taken={data?.servers.map((s) => s.name) ?? []}
              onDone={(view) => {
                if (view) set(view);
                setEditing(null);
              }}
            />
          ) : (
            <div className="flex items-center gap-4">
              <Button size="sm" icon={Plus} onClick={() => setEditing('new')}>
                Add server
              </Button>
              {data && (
                <Toggle
                  checked={data.strict}
                  onChange={strict}
                  label="Runs get only these servers, never the ones in your own Claude config"
                />
              )}
            </div>
          )}
          <ErrorLine error={act.error} />
        </div>
      </Panel>
      {data && <McpSecretsPanel data={data} onSaved={set} />}
      {data && <McpAgentsPanel data={data} />}
    </div>
  );
}

/** Adds a server, or edits one; the name of an existing server can change too. */
function McpServerForm({
  existing,
  taken = [],
  onDone,
}: {
  existing?: McpServerView;
  taken?: string[];
  onDone: (view: McpView | null) => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [args, setArgs] = useState(joinArgs(existing?.args));
  const [env, setEnv] = useState(existing ? envText(existing.env) : '');
  const [roots, setRoots] = useState(listText(existing?.roots));
  const [agents, setAgents] = useState(listText(existing?.agents));
  const [allow, setAllow] = useState(listText(existing?.tools.allow));
  const [deny, setDeny] = useState(listText(existing?.tools.deny));
  const [publish, setPublish] = useState(existing?.publish ?? false);
  const act = useAction();
  const n = name.trim();
  const parsed = parseEnvText(env);
  const problem =
    n && !/^[a-z][a-z0-9_-]{0,39}$/.test(n)
      ? 'Name: lowercase letters, digits, - and _'
      : !existing && taken.includes(n)
        ? 'A server has that name'
        : 'error' in parsed
          ? parsed.error
          : null;
  const save = (): void =>
    act.run(async () => {
      if ('error' in parsed) return;
      const view = await api<McpView>('POST', '/api/mcp/servers', {
        name: n,
        ...(existing ? { previous: existing.name } : {}),
        server: {
          command: command.trim(),
          args: splitArgs(args),
          env: parsed.env,
          roots: textList(roots),
          agents: textList(agents),
          tools: { allow: textList(allow), deny: textList(deny) },
          publish,
        },
      });
      toast(existing ? `Saved ${n}` : `Added ${n}`);
      onDone(view);
    });
  return (
    <div
      data-mcp-form
      className="animate-rise flex flex-col gap-3 rounded-xl border border-white/8 p-4"
    >
      <div className="grid grid-cols-[160px_1fr] gap-3">
        <Field label="Name" hint="As role files name it in mcp">
          <Input value={name} onChange={setName} placeholder="github" autoFocus={!existing} />
        </Field>
        <Field label="Program" hint="A name on PATH or a full path">
          <Input value={command} onChange={setCommand} placeholder="npx" className="font-mono" />
        </Field>
      </div>
      <Field label="Arguments" hint="Quote values with spaces. Never put a secret here.">
        <Input
          value={args}
          onChange={setArgs}
          placeholder="-y @modelcontextprotocol/server-github"
          className="font-mono"
        />
      </Field>
      <Field
        label="Environment"
        hint="One NAME=value per line; NAME=secret:KEY reads KEY from secrets.yml, set below"
      >
        <textarea
          aria-label="Environment"
          value={env}
          spellCheck={false}
          onChange={(e) => setEnv(e.target.value)}
          placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=secret:GITHUB_PAT"
          className="h-20 w-full resize-y rounded-lg border border-white/10 bg-ink-950/60 p-2.5 font-mono text-[12px] leading-5 outline-none focus:border-signal/60"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Projects" hint="Root names, comma-separated; empty: every project">
          <Input value={roots} onChange={setRoots} placeholder="launch, swarmup" />
        </Field>
        <Field label="Agents" hint="claude:writer, writer or *:writer; empty: every agent">
          <Input value={agents} onChange={setAgents} placeholder="claude:researcher" />
        </Field>
        <Field label="Tools allowed" hint="Names or * globs; empty: every tool">
          <Input value={allow} onChange={setAllow} placeholder="search_*, get_file" />
        </Field>
        <Field label="Tools denied" hint="Hidden from runs and refused when called">
          <Input value={deny} onChange={setDeny} placeholder="delete_*, push_*" />
        </Field>
      </div>
      <Toggle
        checked={publish}
        onChange={setPublish}
        label="Publish only: never granted to a role"
      />
      <div className="flex items-center gap-2">
        <Button
          kind="primary"
          size="sm"
          icon={existing ? Save : Plus}
          disabled={!n || !command.trim() || Boolean(problem) || act.busy}
          onClick={save}
        >
          {existing ? 'Save server' : 'Add server'}
        </Button>
        <Button size="sm" kind="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
        {problem && <span className="text-xs text-warn">{problem}</span>}
      </div>
      <ErrorLine error={act.error} />
    </div>
  );
}

/**
 * The secrets the servers read: set or replace a value, or remove it. A value is sent once and
 * never shown again; swarmupd answers with names only.
 */
function McpSecretsPanel({ data, onSaved }: { data: McpView; onSaved: (v: McpView) => void }) {
  const wanted = [
    ...new Set(
      data.servers.flatMap((s) =>
        Object.values(s.env)
          .filter((v): v is { secret: string; set: boolean } => typeof v !== 'string')
          .map((v) => v.secret),
      ),
    ),
  ];
  const names = [...new Set([...wanted, ...data.secrets])].sort();
  const [values, setValues] = useState<Record<string, string>>({});
  const [other, setOther] = useState('');
  const act = useAction();
  const send = (name: string, value: string | null): void =>
    act.run(async () => {
      const view = await api<McpView>('POST', '/api/mcp/secrets', { name, value });
      setValues((v) => ({ ...v, [name]: '' }));
      if (name === other) setOther('');
      onSaved(view);
      toast(value === null ? `Removed ${name}` : `Saved ${name}`);
    });
  const row = (name: string): ReactNode => {
    const isSet = data.secrets.includes(name);
    return (
      <div key={name} data-mcp-secret={name} className="flex items-center gap-3">
        <span className="w-56 truncate font-mono text-sm">{name}</span>
        <span className={isSet ? 'w-16 text-xs text-ok' : 'w-16 text-xs text-warn'}>
          {isSet ? 'set' : 'not set'}
        </span>
        <Input
          type="password"
          value={values[name] ?? ''}
          onChange={(v) => setValues({ ...values, [name]: v })}
          placeholder={isSet ? 'New value' : 'Value'}
          className="flex-1 font-mono"
        />
        <Button
          size="sm"
          icon={Save}
          disabled={!(values[name] ?? '').trim() || act.busy}
          onClick={() => send(name, (values[name] ?? '').trim())}
        >
          {isSet ? 'Replace' : 'Set'}
        </Button>
        {isSet && (
          <Button
            size="sm"
            kind="ghost"
            icon={Trash2}
            disabled={act.busy}
            onClick={() => send(name, null)}
          >
            Remove
          </Button>
        )}
      </div>
    );
  };
  return (
    <Panel
      icon={KeyRound}
      title="Secrets"
      hint={`Kept in ${data.secrets_path}, never synced; values are write-only`}
    >
      <div className="flex flex-col gap-2">
        {names.length === 0 && <div className="text-sm text-fg-4">No secrets yet.</div>}
        {names.map(row)}
        <div className="flex items-center gap-3 border-t border-white/6 pt-3">
          <Input
            value={other}
            onChange={setOther}
            placeholder="OTHER_SECRET"
            className="w-56 font-mono"
          />
          <Input
            type="password"
            value={values[other] ?? ''}
            onChange={(v) => setValues({ ...values, [other]: v })}
            placeholder="Value"
            className="flex-1 font-mono"
          />
          <Button
            size="sm"
            icon={Plus}
            disabled={
              !/^[A-Za-z_][A-Za-z0-9_]*$/.test(other.trim()) ||
              !(values[other] ?? '').trim() ||
              act.busy
            }
            onClick={() => send(other.trim(), (values[other] ?? '').trim())}
          >
            Add secret
          </Button>
        </div>
        <ErrorLine error={act.error} />
      </div>
    </Panel>
  );
}

/** Per agent: the servers its role file asks for, and the ones its runs get in each project. */
function McpAgentsPanel({ data }: { data: McpView }) {
  return (
    <Panel
      icon={Users}
      title="Agents"
      hint="Asked for: the role file's mcp. Granted: what a run of the agent gets in each project."
    >
      {data.agents.length === 0 && (
        <div className="text-sm text-fg-4">No role file names an MCP server.</div>
      )}
      <div className="flex flex-col gap-1.5">
        {data.agents.map((a) => (
          <div
            key={a.id}
            data-mcp-agent={a.id}
            className="flex flex-col gap-1 rounded-xl bg-white/3 px-3 py-2"
          >
            <div className="flex items-center gap-3">
              <div className="w-56">
                <Who id={a.id} label />
              </div>
              <span className="text-xs text-fg-3">
                Asked for: <span className="font-mono">{a.asked.join(', ')}</span>
              </span>
            </div>
            {a.missing.length > 0 && (
              <div data-mcp-missing className="text-xs text-warn">
                Not defined here: {a.missing.join(', ')}; its runs start without them
              </div>
            )}
            {Object.entries(a.granted).map(([root, names]) => (
              <div key={root} data-mcp-granted={root} className="text-xs text-fg-3">
                Granted in {root}:{' '}
                <span className="font-mono">{names.length ? names.join(', ') : 'none'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  );
}
