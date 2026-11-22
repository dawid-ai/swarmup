import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import { userConfigPath } from './config.js';
import { OpsError } from './ids.js';

/**
 * MCP servers on roles (W8): a role file names the servers it may use (`mcp`), the machine defines
 * them in `swarmupd.mcp.servers.<name>`, and `secrets.yml` next to the user config holds the
 * values their environment takes from `{secret: NAME}`. A run gets the servers its role asks for
 * that the machine defines and grants to its root and agent; `publish: true` servers never reach
 * a run.
 */

/** A value of a server's `env`: plain text, or the name of a value in `secrets.yml`. */
export type McpEnvValue = string | { secret: string };

/** Which tools of a server a run may list and call: names or `*` globs. */
export interface McpToolRules {
  allow?: string[];
  deny?: string[];
}

/** One server in `swarmupd.mcp.servers`. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, McpEnvValue>;
  /** Root names the server is granted to; none: every root. */
  roots?: string[];
  /** Agents the server is granted to (`claude:writer`, `writer`, `*:writer`); none: every agent. */
  agents?: string[];
  tools?: McpToolRules;
  /** Only publish adapters use it; never granted to a role. */
  publish?: boolean;
}

/** `swarmupd.mcp`, checked. */
export interface McpConfig {
  /**
   * Every Claude run gets `--strict-mcp-config`, so no run loads the MCP servers of your own
   * Claude config, only the ones SwarmUp grants. Off by default: only runs with granted servers
   * get it.
   */
  strict: boolean;
  servers: Record<string, McpServerConfig>;
}

export const MCP_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const SERVER_KEYS = ['command', 'args', 'env', 'roots', 'agents', 'tools', 'publish'];

function fail(message: string): never {
  throw new OpsError(message, 2);
}

function textList(v: unknown, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
    fail(`${where}: use a list of text`);
  }
  return (v as string[]).map((x) => x.trim());
}

/** One server entry, checked. Refuses with exit 2 and the key path that is wrong. */
export function checkMcpServer(raw: unknown, where: string): McpServerConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where}: use ${SERVER_KEYS.join(', ')}`);
  }
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !SERVER_KEYS.includes(k));
  if (extra) fail(`${where}: unknown key ${extra}; use ${SERVER_KEYS.join(', ')}`);
  if (typeof r.command !== 'string' || r.command.trim() === '') {
    fail(`${where}.command: name the program that starts the server`);
  }
  const out: McpServerConfig = { command: r.command.trim() };
  if (r.args !== undefined && r.args !== null) {
    if (!Array.isArray(r.args) || r.args.some((a) => typeof a !== 'string')) {
      fail(`${where}.args: use a list of text`);
    }
    out.args = r.args as string[];
  }
  if (r.env !== undefined && r.env !== null) {
    if (typeof r.env !== 'object' || Array.isArray(r.env)) {
      fail(`${where}.env: map variable names to text or {secret: NAME}`);
    }
    const env: Record<string, McpEnvValue> = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (!ENV_NAME_RE.test(k)) fail(`${where}.env.${k}: not a variable name`);
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        env[k] = String(v);
      } else if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        Object.keys(v).length === 1 &&
        typeof (v as { secret?: unknown }).secret === 'string' &&
        ENV_NAME_RE.test((v as { secret: string }).secret)
      ) {
        env[k] = { secret: (v as { secret: string }).secret };
      } else {
        fail(`${where}.env.${k}: use text or {secret: NAME}`);
      }
    }
    out.env = env;
  }
  const roots = textList(r.roots, `${where}.roots`);
  if (roots) out.roots = roots;
  const agents = textList(r.agents, `${where}.agents`);
  if (agents) out.agents = agents;
  if (r.tools !== undefined && r.tools !== null) {
    if (typeof r.tools !== 'object' || Array.isArray(r.tools)) {
      fail(`${where}.tools: use allow and deny`);
    }
    const t = r.tools as Record<string, unknown>;
    const bad = Object.keys(t).find((k) => k !== 'allow' && k !== 'deny');
    if (bad) fail(`${where}.tools: unknown key ${bad}; use allow and deny`);
    const allow = textList(t.allow, `${where}.tools.allow`);
    const deny = textList(t.deny, `${where}.tools.deny`);
    out.tools = { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) };
  }
  if (r.publish !== undefined && r.publish !== null) {
    if (typeof r.publish !== 'boolean') fail(`${where}.publish: use true or false`);
    if (r.publish) out.publish = true;
  }
  return out;
}

/** `swarmupd.mcp`, checked; none gives no servers. Refuses a bad entry with exit 2. */
export function checkMcpConfig(raw: unknown): McpConfig {
  if (raw === undefined || raw === null) return { strict: false, servers: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('swarmupd.mcp: use strict and servers');
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => k !== 'strict' && k !== 'servers');
  if (extra) fail(`swarmupd.mcp: unknown key ${extra}; use strict and servers`);
  if (r.strict !== undefined && r.strict !== null && typeof r.strict !== 'boolean') {
    fail('swarmupd.mcp.strict: use true or false');
  }
  const servers: Record<string, McpServerConfig> = {};
  if (r.servers !== undefined && r.servers !== null) {
    if (typeof r.servers !== 'object' || Array.isArray(r.servers)) {
      fail('swarmupd.mcp.servers: map server names to their settings');
    }
    for (const [name, s] of Object.entries(r.servers as Record<string, unknown>)) {
      if (!MCP_NAME_RE.test(name)) {
        fail(`swarmupd.mcp.servers.${name}: use lowercase letters, digits, - and _`);
      }
      servers[name] = checkMcpServer(s, `swarmupd.mcp.servers.${name}`);
    }
  }
  return { strict: r.strict === true, servers };
}

/** True when an agent id matches a grant entry: an id, a role, or `*` for one side. */
export function agentMatches(entry: string, agent: string): boolean {
  if (entry === '*' || entry === agent) return true;
  const [rt, role] = agent.split(':');
  if (!entry.includes(':')) return entry === role;
  const [ert, erole] = entry.split(':');
  return (ert === '*' || ert === rt) && (erole === '*' || erole === role);
}

/** A server a run asked for that it does not get, and why. */
export interface McpWithheld {
  name: string;
  why: string;
}

/** What a run gets of the servers its role asks for. */
export interface McpGrant {
  /** Asked for, defined and granted to this root and agent. */
  granted: string[];
  /** Asked for but not defined on this machine. */
  missing: string[];
  /** Defined but not granted to this run. */
  withheld: McpWithheld[];
}

/**
 * The servers a run of `agent` in `root` gets: the intersection of its role's `mcp` names with the
 * servers the machine defines and grants to that root and agent. `publish: true` servers are
 * never granted. A run without a root gets only servers that name no roots.
 */
export function mcpGrant(
  cfg: McpConfig,
  asked: readonly string[] | undefined,
  scope: { agent: string; root?: string },
): McpGrant {
  const out: McpGrant = { granted: [], missing: [], withheld: [] };
  for (const name of [...new Set(asked ?? [])]) {
    const s = cfg.servers[name];
    if (!s) {
      out.missing.push(name);
      continue;
    }
    if (s.publish) {
      out.withheld.push({ name, why: 'it is a publish server, which only publish adapters use' });
      continue;
    }
    if (s.roots && s.roots.length > 0 && !(scope.root && s.roots.includes(scope.root))) {
      out.withheld.push({
        name,
        why: scope.root ? `it is not granted to ${scope.root}` : 'the run has no project',
      });
      continue;
    }
    if (s.agents && s.agents.length > 0 && !s.agents.some((e) => agentMatches(e, scope.agent))) {
      out.withheld.push({ name, why: `it is not granted to ${scope.agent}` });
      continue;
    }
    out.granted.push(name);
  }
  return out;
}

/** The prompt lines that tell a run which servers it asked for and does not have. */
export function mcpPromptNote(grant: McpGrant): string {
  if (grant.missing.length === 0 && grant.withheld.length === 0) return '';
  const lines = ['', 'MCP servers your role file names that this run does not have:'];
  for (const n of grant.missing) {
    lines.push(`- ${n}: this machine does not define it (swarmupd.mcp.servers.${n}).`);
  }
  for (const w of grant.withheld) lines.push(`- ${w.name}: ${w.why}.`);
  lines.push(
    'Work without them. If the task needs one, say so with `swarmup ask` instead of looking for',
    'another way in.',
    '',
  );
  return lines.join('\n');
}

/** A `*` glob over a tool name. */
function toolGlob(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
}

/** True when the rules let a run list and call `tool`: allowed (or no allow list), not denied. */
export function mcpToolAllowed(rules: McpToolRules | undefined, tool: string): boolean {
  if (rules?.deny?.some((p) => toolGlob(p).test(tool))) return false;
  if (rules?.allow && rules.allow.length > 0)
    return rules.allow.some((p) => toolGlob(p).test(tool));
  return true;
}

/** SHA-256 of a tool call's arguments as JSON, for `mcp.log`: what was called, never with what. */
export function mcpArgsHash(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(args ?? null))
    .digest('hex');
}

// ---- secrets.yml -------------------------------------------------------------------------------

export const SECRETS_FILE = 'secrets.yml';

/** `secrets.yml` in the user config's folder. It is never synced and never in a repo. */
export function secretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userConfigPath(env)), SECRETS_FILE);
}

/** The values in `secrets.yml`, by name; none when the file is missing. */
export function readSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = secretsPath(env);
  if (!existsSync(file)) return {};
  let data: unknown;
  try {
    data = YAML.parse(readFileSync(file, 'utf8'));
  } catch {
    // Not the parser's message: it can quote a line of the file.
    throw new OpsError(`${file} is not valid YAML; fix it by hand`, 2);
  }
  if (data === null || data === undefined) return {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new OpsError(`${file}: use NAME: value lines`, 2);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/** The names of the values `secrets.yml` holds, never the values. */
export function secretNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(readSecrets(env)).sort();
}

/**
 * Sets (or with `null` removes) one value of `secrets.yml`. The file is written through a temporary
 * file and is readable by its owner only where the system has such modes.
 */
export function setSecret(env: NodeJS.ProcessEnv, name: string, value: string | null): void {
  if (!ENV_NAME_RE.test(name)) {
    throw new OpsError(`secret name: letters, digits and _, not starting with a digit`, 2);
  }
  if (value !== null && (value === '' || /[\r\n]/.test(value))) {
    throw new OpsError('secret value: one line of text', 2);
  }
  const file = secretsPath(env);
  const all = readSecrets(env);
  if (value === null) delete all[name];
  else all[name] = value;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text =
    '# Values for swarmupd.mcp.servers.<name>.env entries written as {secret: NAME}.\n' +
    '# Keep this file out of every repo and sync folder.\n' +
    (Object.keys(all).length > 0 ? YAML.stringify(all) : '');
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no such modes; the file stays in the user's profile.
  }
}

/**
 * Why `secrets.yml` is readable by other users, or null when it is not, is missing, or the
 * system cannot tell (Windows ACLs are not checked).
 */
export function secretsExposure(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === 'win32') return null;
  const file = secretsPath(env);
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    return null;
  }
  if ((mode & 0o077) === 0) return null;
  return `${file} is readable by other users (mode ${(mode & 0o777).toString(8)})`;
}

/** A server's environment with each `{secret: NAME}` filled from `secrets`, and names not set. */
export function resolveMcpEnv(
  server: McpServerConfig,
  secrets: Record<string, string>,
): { env: Record<string, string>; missing: string[] } {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const [k, v] of Object.entries(server.env ?? {})) {
    if (typeof v === 'string') env[k] = v;
    else if (secrets[v.secret] !== undefined) env[k] = secrets[v.secret]!;
    else missing.push(v.secret);
  }
  return { env, missing };
}

/** The secret names a server's environment reads. */
export function mcpSecretRefs(server: McpServerConfig): string[] {
  return Object.values(server.env ?? {})
    .filter((v): v is { secret: string } => typeof v !== 'string')
    .map((v) => v.secret);
}
