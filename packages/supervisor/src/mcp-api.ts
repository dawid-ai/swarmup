import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpConfig, McpGrant, McpServerConfig, McpToolRules } from '@swarmup/core';
import {
  checkMcpServer,
  daemonKeyIn,
  MCP_NAME_RE,
  mcpGrant,
  mcpPromptNote,
  OpsError,
  readSecrets,
  resolveMcpEnv,
  secretNames,
  secretsPath,
  setSecret,
} from '@swarmup/core';
import { cliEntry } from './bench-runs.js';
import type { RunRecord } from './runs.js';
import type { McpInvocation } from './runtimes.js';
import { claudeMcpJson, mcpProxyEntries } from './runtimes.js';
import type { Supervisor } from './supervisor.js';

/** The file in a run's scratch folder the proxy reads its run token and swarmupd's folder from. */
export const MCP_TOKEN_FILE = 'mcp-token.json';

/** What `swarmup mcp exec` reads from {@link MCP_TOKEN_FILE}. */
export interface McpTokenFile {
  token: string;
  state_dir: string;
}

/** What a run starts with for MCP: the grant, the runtime's part and the prompt note. */
export interface McpRunSetup {
  grant: McpGrant;
  inv?: McpInvocation;
  note: string;
}

/**
 * Grants a run its MCP servers and writes what the proxy needs into its scratch folder: the run
 * token file, and for Claude `mcp.json`. Only Claude and Codex runs take servers; a run of another
 * runtime gets none, and its prompt says so. Writes nothing for a run without servers.
 */
export function prepareMcpRun(input: {
  cfg: McpConfig;
  asked: readonly string[] | undefined;
  agent: string;
  runtime: string;
  root?: string;
  scratch: string;
  token: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
}): McpRunSetup {
  let grant = mcpGrant(input.cfg, input.asked, { agent: input.agent, root: input.root });
  const takes = input.runtime === 'claude' || input.runtime === 'codex';
  if (!takes && grant.granted.length > 0) {
    grant = {
      ...grant,
      granted: [],
      withheld: [
        ...grant.withheld,
        ...grant.granted.map((name) => ({
          name,
          why: `SwarmUp passes MCP servers to Claude and Codex runs only, not ${input.runtime}`,
        })),
      ],
    };
  }
  const note = mcpPromptNote(grant);
  const strict = input.cfg.strict && input.runtime === 'claude';
  if (grant.granted.length === 0)
    return { grant, note, ...(strict ? { inv: { entries: [], strict } } : {}) };
  const tokenFile: McpTokenFile = { token: input.token, state_dir: input.stateDir };
  writeFileSync(join(input.scratch, MCP_TOKEN_FILE), JSON.stringify(tokenFile), { mode: 0o600 });
  const entries = mcpProxyEntries(grant.granted, input.scratch, {
    command: process.execPath,
    args: [cliEntry(input.env)],
    // Inside Electron, execPath is the app: ELECTRON_RUN_AS_NODE makes it a plain Node process.
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
  });
  let configFile: string | undefined;
  if (input.runtime === 'claude') {
    configFile = join(input.scratch, 'mcp.json');
    writeFileSync(configFile, claudeMcpJson(entries));
  }
  return { grant, note, inv: { entries, ...(configFile ? { configFile } : {}), strict } };
}

// ---- Settings > MCP servers --------------------------------------------------------------------

/** A server as **Settings** shows it: every setting, and for each secret only whether it is set. */
export interface McpServerView {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string | { secret: string; set: boolean }>;
  roots: string[];
  agents: string[];
  tools: McpToolRules;
  publish: boolean;
}

/** What an agent's role file asks for, and what its runs get in each root. */
export interface McpAgentView {
  id: string;
  asked: string[];
  missing: string[];
  /** Granted servers by root name. */
  granted: Record<string, string[]>;
}

export interface McpView {
  path: string;
  secrets_path: string;
  strict: boolean;
  servers: McpServerView[];
  /** The names `secrets.yml` holds. Never a value. */
  secrets: string[];
  agents: McpAgentView[];
  /** Why the secrets could not be read, when they could not. */
  error?: string;
}

/** `GET /api/mcp`: servers, secret names and each agent's servers. Never a secret value. */
export function mcpView(sup: Supervisor): McpView {
  const cfg = sup.machineConfig.mcp;
  const { env } = sup.context;
  let names: string[] = [];
  let error: string | undefined;
  try {
    names = secretNames(env);
  } catch (err) {
    error = (err as Error).message;
  }
  const servers = Object.entries(cfg.servers).map(([name, s]): McpServerView => ({
    name,
    command: s.command,
    args: s.args ?? [],
    env: Object.fromEntries(
      Object.entries(s.env ?? {}).map(([k, v]) => [
        k,
        typeof v === 'string' ? v : { secret: v.secret, set: names.includes(v.secret) },
      ]),
    ),
    roots: s.roots ?? [],
    agents: s.agents ?? [],
    tools: s.tools ?? {},
    publish: s.publish === true,
  }));
  let agents: McpAgentView[] = [];
  let roots: string[] = [];
  try {
    const ws = sup.ws();
    roots = ws.roots.filter((r) => !r.isMirror).map((r) => r.name);
    agents = ws
      .agents()
      .filter((a) => (a.mcp ?? []).length > 0)
      .map((a) => {
        const asked = [...new Set(a.mcp ?? [])];
        const byRoot: Record<string, string[]> = {};
        for (const root of roots) {
          byRoot[root] = mcpGrant(sup.config.mcp, asked, { agent: a.id, root }).granted;
        }
        return {
          id: a.id,
          asked,
          missing: asked.filter((n) => !sup.config.mcp.servers[n]),
          granted: byRoot,
        };
      });
  } catch {
    agents = [];
  }
  return {
    path: sup.configPath,
    secrets_path: secretsPath(env),
    strict: cfg.strict,
    servers,
    secrets: names,
    agents,
    ...(error ? { error } : {}),
  };
}

function serverDoc(s: McpServerConfig): Record<string, unknown> {
  return {
    command: s.command,
    ...(s.args && s.args.length > 0 ? { args: s.args } : {}),
    ...(s.env && Object.keys(s.env).length > 0 ? { env: s.env } : {}),
    ...(s.roots && s.roots.length > 0 ? { roots: s.roots } : {}),
    ...(s.agents && s.agents.length > 0 ? { agents: s.agents } : {}),
    ...(s.tools && (s.tools.allow?.length || s.tools.deny?.length)
      ? {
          tools: {
            ...(s.tools.allow?.length ? { allow: s.tools.allow } : {}),
            ...(s.tools.deny?.length ? { deny: s.tools.deny } : {}),
          },
        }
      : {}),
    ...(s.publish ? { publish: true } : {}),
  };
}

/**
 * `POST /api/mcp/servers`: adds a server, or replaces the one `previous` names (renaming it).
 * The body is `{name, previous?, server}`; `server` has the keys of `swarmupd.mcp.servers.<name>`.
 * Secret values never come this way: `env` names them with `{secret: NAME}`.
 */
export function saveMcpServer(sup: Supervisor, body: Record<string, unknown>): McpView {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!MCP_NAME_RE.test(name)) {
    throw new OpsError(
      'server name: lowercase letters, digits, - and _, starting with a letter',
      2,
    );
  }
  const previous =
    typeof body.previous === 'string' && body.previous.trim() ? body.previous.trim() : undefined;
  const server = checkMcpServer(body.server, `swarmupd.mcp.servers.${name}`);
  const existing = sup.machineConfig.mcp.servers;
  if (previous && !existing[previous]) throw new OpsError(`no MCP server '${previous}'`, 2);
  if ((!previous || previous !== name) && existing[name]) {
    throw new OpsError(`MCP server '${name}' exists`, 2);
  }
  sup.editConfig((doc) => {
    const key = daemonKeyIn(doc);
    if (previous && previous !== name) doc.deleteIn([key, 'mcp', 'servers', previous]);
    doc.setIn([key, 'mcp', 'servers', name], doc.createNode(serverDoc(server)));
  });
  return mcpView(sup);
}

/** `POST /api/mcp/servers/<name>/delete`. Its secrets stay in `secrets.yml`. */
export function deleteMcpServer(sup: Supervisor, name: string): McpView {
  if (!sup.machineConfig.mcp.servers[name]) throw new OpsError(`no MCP server '${name}'`, 2);
  sup.editConfig((doc) => {
    doc.deleteIn([daemonKeyIn(doc), 'mcp', 'servers', name]);
  });
  return mcpView(sup);
}

/** `POST /api/mcp/strict`: `{strict}`. */
export function setMcpStrict(sup: Supervisor, strict: unknown): McpView {
  if (typeof strict !== 'boolean') throw new OpsError('strict: use true or false', 2);
  sup.editConfig((doc) => {
    const key = daemonKeyIn(doc);
    if (strict) doc.setIn([key, 'mcp', 'strict'], true);
    else doc.deleteIn([key, 'mcp', 'strict']);
  });
  return mcpView(sup);
}

/**
 * `POST /api/mcp/secrets`: `{name, value}` sets or replaces one value of `secrets.yml`, and
 * `{name, value: null}` removes it. The answer names the secrets, never a value.
 */
export function setMcpSecret(sup: Supervisor, body: Record<string, unknown>): McpView {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const value = body.value;
  if (value !== null && typeof value !== 'string') {
    throw new OpsError('value: send the secret as text, or null to remove it', 2);
  }
  setSecret(sup.context.env, name, value === null || value === '' ? null : value);
  return mcpView(sup);
}

/** The spec `swarmup mcp exec` starts: the real server, its environment and tool rules. */
export interface McpResolved {
  name: string;
  command: string;
  args: string[];
  /** The server's environment with secret values filled in. Only a granted run gets it. */
  env: Record<string, string>;
  tools: McpToolRules;
}

/** An answer of {@link resolveMcp} that is not a spec: the HTTP status and why. */
export class McpResolveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * `POST /api/mcp/resolve`: the spec of one server for the run whose token called. Only a run gets
 * it, and only for a server it was granted at its start that the machine still grants it.
 */
export function resolveMcp(sup: Supervisor, run: RunRecord | undefined, name: string): McpResolved {
  if (!run) throw new McpResolveError(403, 'MCP specs are for runs; a person token gets none');
  if (!(run.mcp ?? []).includes(name)) {
    throw new McpResolveError(403, `run ${run.id} was not granted the MCP server ${name}`);
  }
  const cfg = sup.config.mcp;
  const server = cfg.servers[name];
  if (!server) throw new McpResolveError(404, `this machine no longer defines ${name}`);
  if (!mcpGrant(cfg, [name], { agent: run.agent, root: run.root }).granted.includes(name)) {
    throw new McpResolveError(403, `${name} is no longer granted to ${run.agent}`);
  }
  const { env, missing } = resolveMcpEnv(server, readSecrets(sup.context.env));
  if (missing.length > 0) {
    throw new McpResolveError(
      409,
      `secrets.yml has no value for ${missing.join(', ')}; set it in Settings > MCP servers`,
    );
  }
  return {
    name,
    command: server.command,
    args: server.args ?? [],
    env,
    tools: server.tools ?? {},
  };
}
