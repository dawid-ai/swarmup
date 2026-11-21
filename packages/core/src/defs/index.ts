/**
 * Definitions as code (W5): `swarm.yaml` and the agent files in a task store, checked against
 * schemas, hashed, and merged under the machine's settings by swarmupd.
 */
import { AGENT_SCHEMA } from './agent.js';
import { toJsonSchema } from './schema.js';
import { SWARM_SCHEMA } from './swarm.js';

export { AGENT_SCHEMA, agentRuntimeValues } from './agent.js';
export type { DefFile } from './hash.js';
export {
  DEF_FOLDERS,
  DEFS_HASH_PREFIX,
  definitionHash,
  definitionsFingerprint,
  hashTexts,
  listDefFiles,
  normalText,
  shortHash,
} from './hash.js';
export type { DefinitionSet, LoadOptions } from './load.js';
export { clearDefinitionsCache, loadDefinitions, sortProblems } from './load.js';
export type { Checked, CheckOptions, DefProblem, Locate, Schema, Severity } from './schema.js';
export {
  checkValue,
  checkYaml,
  formatProblem,
  JSON_SCHEMA_DIALECT,
  toJsonSchema,
} from './schema.js';
export type { SwarmDefs, SwarmRole, SwarmRuntime } from './swarm.js';
export { DEFS_FORMAT, SWARM_FILE, SWARM_SCHEMA, swarmDefs } from './swarm.js';
export type { ValidateInput } from './validate.js';
export { validateDefinitions } from './validate.js';
export {
  checkEffort,
  checkModel,
  EFFORT_HINT,
  EFFORT_RE,
  MODEL_HINT,
  MODEL_RE,
  ROLE_NAME_RE,
  RUNTIME_NAME_RE,
} from './values.js';

const SCHEMA_BASE = 'https://swarmup.tech/schemas/';

/**
 * The generated JSON Schema files, by file name, as `scripts/gen-schemas.mjs` writes them to
 * `packages/core/schemas/` and `swarmup validate --write-schemas` to a store's `.schemas/`.
 */
export function schemaFiles(): Record<string, string> {
  const files: Record<string, unknown> = {
    'swarm.schema.json': toJsonSchema(SWARM_SCHEMA, {
      id: `${SCHEMA_BASE}swarm.schema.json`,
      title: 'swarm.yaml',
      description: 'Team settings kept in a SwarmUp task store (`swarm.yaml`).',
    }),
    'agent.schema.json': toJsonSchema(AGENT_SCHEMA, {
      id: `${SCHEMA_BASE}agent.schema.json`,
      title: 'Agent file frontmatter',
      description: 'The frontmatter of a SwarmUp agent file (`agents/<runtime>-<role>.md`).',
    }),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, json]) => [name, `${JSON.stringify(json, null, 2)}\n`]),
  );
}
