/**
 * Checks across the definition files of one store: unique agent ids, role providers, agent
 * runtime overrides and secrets. Each file's own shape is checked by its schema first.
 */
import { join } from 'node:path';
import type { AgentDef, ShadowedAgent } from '../agents.js';
import { AGENT_FOLDER_FILE, folderProviders } from '../agents.js';
import { isActorId, slugToActor } from '../ids.js';
import { secretKind } from '../secrets.js';
import type { DefProblem, Locate } from './schema.js';
import type { SwarmDefs } from './swarm.js';
import { SWARM_FILE } from './swarm.js';

export interface ValidateInput {
  root: string;
  swarm: SwarmDefs | null;
  /** The agent files that read, as `readAgentFiles` returns them. */
  agents: AgentDef[];
  /** Each legacy agent file's frontmatter as plain data, by file. */
  agentValues: Map<string, unknown>;
  /** The frontmatter of each agent folder file (`agent.md`, addenda) as plain data, by file. */
  folderValues?: Map<string, unknown>;
  /** Folder agents a legacy file of the same id hides. */
  shadowed?: ShadowedAgent[];
  /** Text of each definition file, by path in the store. */
  texts: Map<string, string>;
  machineRuntimes?: readonly string[];
  machineAgents?: readonly string[];
  /** MCP servers this machine defines (`swarmupd.mcp.servers`), to check role `mcp` names. */
  machineMcp?: readonly string[];
  /** Where a key path is in each checked file, by file. */
  locate?: Map<string, Locate>;
  /** The file a path in the store is reported as; a variant reports its overlay files. */
  fileOf?: (path: string) => string;
}

const roleOf = (id: string): string => id.slice(id.indexOf(':') + 1);
const runtimeOf = (id: string): string => id.slice(0, id.indexOf(':'));

export function validateDefinitions(input: ValidateInput): DefProblem[] {
  const out: DefProblem[] = [];
  const fileOf = input.fileOf ?? ((path: string) => join(input.root, path));
  const swarmFile = fileOf(SWARM_FILE);
  const at = (file: string, path: string, severity: DefProblem['severity'], message: string) => {
    const keys = path === '(top)' ? [] : path.split('.');
    const pos = input.locate?.get(file)?.(keys) ?? { line: 1, col: 1 };
    out.push({ file, path, ...pos, severity, message });
  };

  // Two files for one agent: the queue would use whichever it read last.
  const byId = new Map<string, string[]>();
  for (const a of input.agents) byId.set(a.id, [...(byId.get(a.id) ?? []), a.file]);
  for (const [id, files] of byId) {
    if (files.length < 2) continue;
    for (const f of files) {
      at(f, 'id', 'error', `${id} is defined in ${files.length} files; keep one`);
    }
  }

  // An `id` that is no agent id leaves the file out of the queue without a word.
  for (const [file, value] of input.agentValues) {
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && !isActorId(id)) {
      at(file, 'id', 'warning', `'${id}' is no agent id, so the queue skips this file`);
    }
    if (id === undefined) {
      const name = file.replace(/\\/g, '/').split('/').pop() ?? '';
      if (!isActorId(slugToActor(name.replace(/\.md$/, '')))) {
        at(file, '(top)', 'warning', 'the file name is no <runtime>-<role>, so the queue skips it');
      }
    }
  }

  // A legacy file defines one agent: `providers` belongs to agent folders, and `role` must agree
  // with the id.
  for (const [file, value] of input.agentValues) {
    const v = (value ?? {}) as { id?: unknown; role?: unknown; providers?: unknown };
    if (v.providers !== undefined && v.providers !== null) {
      at(
        file,
        'providers',
        'warning',
        'providers applies to agent folders (agents/<role>/agent.md); a legacy file defines one agent, so it is not read',
      );
    }
    const name = file.replace(/\\/g, '/').split('/').pop() ?? '';
    const id = typeof v.id === 'string' ? v.id : slugToActor(name.replace(/\.md$/, ''));
    if (typeof v.role === 'string' && isActorId(id) && roleOf(id) !== v.role) {
      at(file, 'role', 'warning', `${id} has the role ${roleOf(id)}; role ${v.role} is not read`);
    }
  }

  // Agent folders: a legacy file that hides one, `role` against the folder name, addenda without
  // agent.md or for a runtime the folder does not expand into, and `runtimes.<rt>` entries that
  // never apply.
  for (const s of input.shadowed ?? []) {
    const name = s.by.replace(/\\/g, '/').split('/').pop() ?? s.by;
    at(
      s.file,
      '(top)',
      'warning',
      `${s.id} is also defined in agents/${name}, which wins; remove it, or run swarmup defs migrate --prune`,
    );
  }
  const folders = new Map<string, { agent?: string; addenda: Map<string, string> }>();
  for (const file of input.folderValues?.keys() ?? []) {
    const parts = file.replace(/\\/g, '/').split('/');
    const role = parts.at(-2) ?? '';
    const base = parts.at(-1) ?? '';
    const f = folders.get(role) ?? { addenda: new Map<string, string>() };
    if (base === AGENT_FOLDER_FILE) f.agent = file;
    else f.addenda.set(base.replace(/\.md$/, ''), file);
    folders.set(role, f);
  }
  for (const [role, f] of folders) {
    if (!f.agent) {
      for (const file of f.addenda.values()) {
        at(
          file,
          '(top)',
          'warning',
          `agents/${role}/ has no agent.md, so this addendum is not read`,
        );
      }
      continue;
    }
    const value = (input.folderValues!.get(f.agent) ?? {}) as {
      role?: unknown;
      providers?: unknown;
      runtimes?: unknown;
    };
    if (typeof value.role === 'string' && value.role !== role) {
      at(
        f.agent,
        'role',
        'warning',
        `the folder agents/${role}/ names the role; role ${value.role} is not read`,
      );
    }
    const { providers } = folderProviders(value.providers, role, input.texts.get(SWARM_FILE));
    if (providers.length === 0) {
      at(
        f.agent,
        'providers',
        'warning',
        `no runtime takes the role ${role}, so it defines no agent`,
      );
    }
    for (const [rt, file] of f.addenda) {
      if (!providers.includes(rt)) {
        at(
          file,
          '(top)',
          'warning',
          `agents/${role}/ expands into ${providers.join(', ') || 'no runtime'}; add ${rt} to its providers, or this addendum never applies`,
        );
      }
    }
    for (const file of [f.agent, ...f.addenda.values()]) {
      const rts = (input.folderValues!.get(file) as { runtimes?: unknown } | undefined)?.runtimes;
      if (!rts || typeof rts !== 'object') continue;
      for (const rt of Object.keys(rts)) {
        if (providers.includes(rt)) continue;
        at(
          file,
          `runtimes.${rt}`,
          'warning',
          `the role ${role} does not run on ${rt}; this entry never applies`,
        );
      }
    }
  }

  // `runtimes.<rt>` in a legacy agent file applies only to the runtime of its id.
  for (const a of input.agents) {
    if (a.folder) continue;

    const rts = (input.agentValues.get(a.file) as { runtimes?: unknown } | undefined)?.runtimes;
    if (!rts || typeof rts !== 'object') continue;
    for (const rt of Object.keys(rts)) {
      if (rt !== runtimeOf(a.id)) {
        at(
          a.file,
          `runtimes.${rt}`,
          'warning',
          `${a.id} runs on ${runtimeOf(a.id)}; this entry never applies`,
        );
      }
    }
  }

  // A run asks for each server its role file names; one this machine does not define is left out.
  if (input.machineMcp) {
    const told = new Set<string>();
    for (const a of input.agents) {
      for (const name of a.mcp ?? []) {
        if (input.machineMcp.includes(name)) continue;
        // The agents of one folder share their agent.md: one warning per file and server.
        const file = a.folder?.addendum ?? a.file;
        if (told.has(`${file}\0${name}`)) continue;
        told.add(`${file}\0${name}`);
        at(
          file,
          'mcp',
          'warning',
          `this machine defines no MCP server ${name}; add it in Settings > MCP servers, or ${a.id} runs without it`,
        );
      }
    }
  }

  const roles = input.swarm?.roles ?? {};
  const knownRoles = new Set([
    ...input.agents.map((a) => roleOf(a.id)),
    ...(input.machineAgents ?? []).filter(isActorId).map(roleOf),
  ]);
  for (const [role, r] of Object.entries(roles)) {
    const providers = r.providers;
    if (providers) {
      const seen = new Set<string>();
      for (const p of providers) {
        if (seen.has(p)) at(swarmFile, `roles.${role}.providers`, 'warning', `${p} is named twice`);
        seen.add(p);
        if (input.machineRuntimes && !input.machineRuntimes.includes(p)) {
          at(
            swarmFile,
            `roles.${role}.providers`,
            'warning',
            `this machine has no runtime ${p}; add it in Settings > Providers, or this machine skips it`,
          );
        }
      }
      if (providers.length === 0) {
        at(swarmFile, `roles.${role}.providers`, 'warning', 'no provider takes work of this role');
      }
    }
    // Only with the machine's agents: most agents live in the user config, not in agent files.
    if (input.machineAgents && knownRoles.size > 0 && !knownRoles.has(role)) {
      at(swarmFile, `roles.${role}`, 'warning', `no agent has the role ${role}`);
    }
  }

  for (const [path, text] of input.texts) out.push(...secretProblems(fileOf(path), text));
  return out;
}

/**
 * An error for each line of `text` that looks like it holds a secret: definitions are shared
 * through git, so a secret in one reaches every clone.
 */
export function secretProblems(file: string, text: string): DefProblem[] {
  const out: DefProblem[] = [];
  text.split('\n').forEach((line, i) => {
    const kind = secretKind(line);
    if (!kind) return;
    out.push({
      file,
      path: '(top)',
      line: i + 1,
      col: 1,
      severity: 'error',
      message: `this line looks like a ${kind}; keep secrets in the user config`,
    });
  });
  return out;
}
