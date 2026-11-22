/**
 * Checks across the definition files of one store: unique agent ids, role providers, agent
 * runtime overrides and secrets. Each file's own shape is checked by its schema first.
 */
import { join } from 'node:path';
import type { AgentDef } from '../agents.js';
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
  /** Each agent file's frontmatter as plain data, by file. */
  agentValues: Map<string, unknown>;
  /** Text of each definition file, by path in the store. */
  texts: Map<string, string>;
  machineRuntimes?: readonly string[];
  machineAgents?: readonly string[];
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

  // `runtimes.<rt>` in an agent file applies only to the runtime of its id.
  for (const a of input.agents) {
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
