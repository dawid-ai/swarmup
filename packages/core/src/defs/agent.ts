/**
 * The frontmatter of an agent file: a legacy `agents/<runtime>-<role>.md`, an agent folder's
 * `agents/<role>/agent.md`, or a runtime addendum `agents/<role>/<runtime>.md` (W5). Today's
 * fields, plus `role`, `providers`, `writes`, `scorers` and `runtimes.<rt>.{model, effort}`.
 */
import { enumOf, int, list, map, obj, ref, str } from './schema.js';
import type { Schema } from './schema.js';
import { effortSchema, modelSchema } from './swarm.js';
import { ROLE_NAME_RE, RUNTIME_NAME_RE } from './values.js';

const names = (doc: string): Schema => list(str(), { doc, nullable: true });

const ID_IN_FOLDER =
  'id is refused in an agent folder: the folder name gives the role, and providers the runtimes';

/** The keys every agent file shares. */
const COMMON: Record<string, Schema> = {
  name: str({ nullable: true, doc: 'Display name.' }),
  description: str({ nullable: true, doc: 'One line on what the agent does.' }),
  status: enumOf(['active', 'paused', 'proposed'], {
    nullable: true,
    doc: 'Only an active agent runs and takes work. Default active.',
  }),
  can_claim: names('Task types the role takes from the queue; `*` for any.'),
  projects: names('Projects the agent works on; `*` for any.'),
  model: {
    ...modelSchema("Model for the agent's runs; `default` takes the runtime's."),
    nullable: true,
  },
  effort: { ...effortSchema("Reasoning effort for the agent's runs."), nullable: true },
  budget_min: int({ min: 1, nullable: true, doc: 'Default run budget in minutes.' }),
  tools: names('Tool permissions for the role.'),
  mcp: names('MCP server names the role may use.'),
  kb: names('Learn-note topics (`kb/<topic>/`) the agent reads before it works.'),
  files: names('Files or folders the agent reads before it works, relative to the project.'),
  style: str({
    nullable: true,
    doc: 'How the agent writes: tone, format, words to use and avoid.',
  }),
  runtimes: map(
    ref(
      'agent-runtime',
      () =>
        obj(
          {
            model: modelSchema("Model for this runtime's runs of the agent."),
            effort: effortSchema("Reasoning effort for this runtime's runs of the agent."),
          },
          { doc: 'Overrides for one runtime.' },
        ),
      { nullable: true },
    ),
    {
      keyPattern: RUNTIME_NAME_RE,
      keyHint: 'name a runtime such as claude',
      nullable: true,
      doc: 'Overrides per runtime; a machine setting for the agent still wins.',
    },
  ),
  writes: {
    kind: 'bool',
    nullable: true,
    doc: "The role changes files. A machine's `swarmupd.roles.<role>.writes` wins; this wins over `swarm.yaml`.",
  },
  scorers: names('Scorers that judge the agent’s work.'),
};

const roleKey = (doc: string): Schema =>
  str({ pattern: ROLE_NAME_RE, hint: 'name a role such as engineer', nullable: true, doc });

const providersKey = list(
  str({ pattern: RUNTIME_NAME_RE, hint: 'name a runtime such as claude' }),
  {
    nullable: true,
    doc: "Runtimes the folder expands into, one agent each. Default: the role's providers in `swarm.yaml`, then its runtimes, then claude and codex.",
  },
);

/** The schema of a legacy agent file's frontmatter (`agents/<runtime>-<role>.md`). */
export const AGENT_SCHEMA: Schema = obj(
  {
    id: str({
      pattern: /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/,
      hint: 'use <runtime>:<role>, such as claude:writer',
      doc: 'The agent id, `<runtime>:<role>`. Defaults to the file name.',
    }),
    ...COMMON,
    role: roleKey('The role; the same as the part of the id after the colon.'),
    providers: providersKey,
  },
  { doc: 'Frontmatter of an agent file.' },
);

/** The schema of an agent folder's `agents/<role>/agent.md` (W5). */
export const FOLDER_AGENT_SCHEMA: Schema = obj(
  {
    ...COMMON,
    role: roleKey('The role; the same as the folder name.'),
    providers: providersKey,
  },
  { doc: 'Frontmatter of an agent folder’s agent.md.', refuse: { id: ID_IN_FOLDER } },
);

/** The schema of a runtime addendum `agents/<role>/<runtime>.md` (W5). */
export const ADDENDUM_SCHEMA: Schema = obj(
  {
    ...COMMON,
    body: enumOf(['append', 'replace'], {
      nullable: true,
      doc: "How this file's body applies: after the role's body (append, the default) or instead of it.",
    }),
  },
  {
    doc: 'Frontmatter of a runtime addendum: values that overlay agent.md for one runtime.',
    refuse: {
      id: ID_IN_FOLDER,
      role: 'role belongs in agent.md; the folder name gives it',
      providers: 'providers belongs in agent.md, where it names every runtime of the role',
    },
  },
);

/**
 * The model and effort an agent file gives runtime `rt`: its `runtimes.<rt>` entry, then its own
 * `model` and `effort`.
 */
export function agentRuntimeValues(
  def: { model?: string | null; effort?: string | null; runtimes?: unknown },
  rt: string,
): { model?: string; effort?: string } {
  const rts = def.runtimes;
  const own =
    rts && typeof rts === 'object' && !Array.isArray(rts)
      ? (rts as Record<string, unknown>)[rt]
      : undefined;
  const o = own && typeof own === 'object' ? (own as { model?: unknown; effort?: unknown }) : {};
  const model = typeof o.model === 'string' ? o.model : (def.model ?? undefined);
  const effort = typeof o.effort === 'string' ? o.effort : (def.effort ?? undefined);
  return {
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}
