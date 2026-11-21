/**
 * The frontmatter of an agent file (`agents/<runtime>-<role>.md`): today's fields, plus the keys
 * agent folders bring. `runtimes.<rt>.{model, effort}` applies now; `role`, `providers`, `writes`
 * and `scorers` are accepted and warned about until agent folders land (phase 2).
 */
import { enumOf, int, list, map, obj, ref, str } from './schema.js';
import type { Schema } from './schema.js';
import { effortSchema, modelSchema } from './swarm.js';
import { ROLE_NAME_RE, RUNTIME_NAME_RE } from './values.js';

const names = (doc: string): Schema => list(str(), { doc, nullable: true });

const FOLDERS = 'agent folders (phase 2)';

/** The schema of an agent file's frontmatter. */
export const AGENT_SCHEMA: Schema = obj(
  {
    id: str({
      pattern: /^[a-z][a-z0-9]*:[a-z][a-z0-9-]*$/,
      hint: 'use <runtime>:<role>, such as claude:writer',
      doc: 'The agent id, `<runtime>:<role>`. Defaults to the file name.',
    }),
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
    role: str({
      pattern: ROLE_NAME_RE,
      hint: 'name a role such as engineer',
      inactive: FOLDERS,
    }),
    providers: list(str(), { inactive: FOLDERS }),
    writes: { kind: 'bool', inactive: FOLDERS },
    scorers: list(str(), { inactive: 'scorers in git come in phase 4' }),
  },
  { doc: 'Frontmatter of an agent file.' },
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
