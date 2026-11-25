/**
 * Definitions as code (W5): `swarm.yaml`, the agent files, the workflows and the triggers in a task store,
 * checked against schemas, hashed, and merged under the machine's settings by swarmupd.
 */
import { ADDENDUM_SCHEMA, AGENT_SCHEMA, FOLDER_AGENT_SCHEMA } from './agent.js';
import { toJsonSchema } from './schema.js';
import { SWARM_SCHEMA } from './swarm.js';
import { SCORER_SCHEMA } from './scorer.js';
import { TRIGGER_SCHEMA } from './trigger.js';
import { WORKFLOW_SCHEMA } from './workflow.js';

export { ADDENDUM_SCHEMA, AGENT_SCHEMA, agentRuntimeValues, FOLDER_AGENT_SCHEMA } from './agent.js';
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
export {
  checkDefinitionText,
  clearDefinitionsCache,
  loadDefinitions,
  loadDefinitionsAtRef,
  sortProblems,
} from './load.js';
export type { DefsRefSnapshot } from './ref.js';
export {
  checkDefsRef,
  clearDefsSnapshots,
  DEFS_REF_RE,
  defsRefGit,
  defsSnapshotAt,
  gitWhy,
  keepDefsSnapshot,
  keptDefsSnapshot,
  readDefsAtRef,
  snapshotTexts,
} from './ref.js';
export type { Checked, CheckOptions, DefProblem, Locate, Schema, Severity } from './schema.js';
export {
  checkValue,
  checkYaml,
  formatProblem,
  JSON_SCHEMA_DIALECT,
  toJsonSchema,
} from './schema.js';
export type { ChecksTrust, GitMergeCheck } from './checks.js';
export {
  CHECKS_HASH_PREFIX,
  CHECKS_HASH_RE,
  checksHash,
  checksTrust,
  checksTrustProblem,
  gitMergeChecks,
  untrustedChecksText,
} from './checks.js';
export type { ExperimentPick, ExperimentSubject } from './experiments.js';
export {
  experimentActive,
  experimentFraction,
  experimentTakes,
  shareFraction,
  pickExperiment,
  priorSide,
} from './experiments.js';
export type {
  SwarmCheck,
  SwarmDefs,
  SwarmExperiment,
  SwarmExperimentScope,
  SwarmVariant,
  SwarmScoring,
  SwarmImport,
  SwarmImprovement,
  SwarmImprovementRequires,
  SwarmPolicy,
  SwarmRole,
  SwarmRuntime,
  SwarmTestChanges,
  SwarmWorkType,
} from './swarm.js';
export {
  DEFAULT_DAILY_JUDGE_TOKENS,
  DEFS_FORMAT,
  EXPERIMENT_ID_RE,
  POLICY_KEYS,
  setSwarmValues,
  SWARM_FILE,
  SWARM_SCHEMA,
  swarmDefs,
} from './swarm.js';
export type {
  ImprovementPolicy,
  PromotedFile,
  PromotedRecord,
  PromotedSummary,
  ProposalBenchmark,
  ProposalMeta,
  VariantFile,
  VariantInfo,
} from './proposals.js';
export {
  ALWAYS_FROZEN_KEYS,
  applyVariantToBase,
  DEFAULT_FROZEN,
  DEFAULT_IMPROVER,
  DEFAULT_MAX_OPEN_PROPOSALS,
  DEFAULT_MAY_CHANGE,
  improvementPolicy,
  listPromoted,
  listVariants,
  overlayFrom,
  policyProblems,
  PROMOTED_DIR,
  readPromoted,
  readProposal,
  removeVariant,
  requiresProblems,
  rollbackPromoted,
  variantInfo,
  variantNames,
  writePromoted,
  writeProposal,
  writeVariantFiles,
} from './proposals.js';
export {
  applyOverlay,
  checkVariantName,
  DELETE_SUFFIX,
  listVariantNames,
  mergeAgentText,
  mergeValues,
  mergeYamlText,
  overlayAgents,
  overlayFromFiles,
  overlayTargets,
  PROPOSAL_FILE,
  readOverlay,
  splitFrontmatter,
  textsHash,
  VARIANT_NAME_RE,
  variantDir,
  VARIANTS_DIR,
} from './variants.js';
export type { MigrationPlan } from './migrate.js';
export { agentDifferences, applyMigration, migrationDiff, planMigration } from './migrate.js';
export type {
  CompiledWorkflow,
  CompileOptions,
  WorkflowDef,
  WorkflowGate,
  WorkflowInfo,
  WorkflowParam,
  WorkflowStage,
} from './workflow.js';
export {
  assertWorkflowUnchanged,
  BLANK_WORKFLOW,
  checkWorkflowText,
  compileWorkflow,
  gateBody,
  readWorkflow,
  readWorkflowText,
  readWorkflows,
  removeWorkflowFile,
  sampleParams,
  workflowFile,
  writeWorkflowFile,
  WORKFLOW_ID_RE,
  WORKFLOW_SCHEMA,
  workflowIdOf,
  workflowParams,
  WORKFLOWS_DIR,
} from './workflow.js';
export type { Cron } from './cron.js';
export { CRON_HINT, cronMatches, nextCron, parseCron } from './cron.js';
export type { ScorerAppliesTo, ScorerDef, ScorerFileInfo } from './scorer.js';
export {
  BUILTIN_SCORER_IDS,
  checkScorerText,
  effectiveSample,
  SCORER_ID_RE,
  SCORER_SCHEMA,
  scorerIdOf,
  SCORERS_DIR,
} from './scorer.js';
export type {
  TriggerAction,
  TriggerDef,
  TriggerInfo,
  WebhookDef,
  WebhookVerify,
} from './trigger.js';
export {
  checkTriggerText,
  SECRET_REF_RE,
  WEBHOOK_DEFAULT_RATE,
  WEBHOOK_VERIFIES,
  nextTriggerFire,
  scheduleTriggerText,
  TRIGGER_ACTIONS,
  TRIGGER_ACTOR,
  TRIGGER_NAME_RE,
  TRIGGER_SCHEMA,
  TRIGGERS_HASH_PREFIX,
  TRIGGERS_HASH_RE,
  triggersHash,
  triggersTrust,
  triggersTrustProblem,
  untrustedTriggersText,
  triggerCron,
  triggerDue,
  triggerNameOf,
  triggerRunsOn,
  TRIGGERS_DIR,
  triggerTarget,
  triggerWhen,
} from './trigger.js';
export type { ValidateInput } from './validate.js';
export { secretProblems, validateDefinitions } from './validate.js';
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
    'agent-folder.schema.json': toJsonSchema(FOLDER_AGENT_SCHEMA, {
      id: `${SCHEMA_BASE}agent-folder.schema.json`,
      title: 'Agent folder frontmatter',
      description: 'The frontmatter of an agent folder file (`agents/<role>/agent.md`).',
    }),
    'agent-addendum.schema.json': toJsonSchema(ADDENDUM_SCHEMA, {
      id: `${SCHEMA_BASE}agent-addendum.schema.json`,
      title: 'Agent addendum frontmatter',
      description: 'The frontmatter of a runtime addendum (`agents/<role>/<runtime>.md`).',
    }),
    'workflow.schema.json': toJsonSchema(WORKFLOW_SCHEMA, {
      id: `${SCHEMA_BASE}workflow.schema.json`,
      title: 'Workflow',
      description: 'A SwarmUp workflow (`workflows/<id>.yaml`): a repeatable milestone plan.',
    }),
    'scorer.schema.json': toJsonSchema(SCORER_SCHEMA, {
      id: `${SCHEMA_BASE}scorer.schema.json`,
      title: 'Scorer',
      description:
        'A SwarmUp scorer in git (`scorers/<id>.yaml`): settings of a built-in scorer, or a rubric scorer.',
    }),
    'trigger.schema.json': toJsonSchema(TRIGGER_SCHEMA, {
      id: `${SCHEMA_BASE}trigger.schema.json`,
      title: 'Trigger',
      description:
        'A SwarmUp git trigger (`triggers/<name>.yaml`): when swarmupd starts something.',
    }),
  };
  return Object.fromEntries(
    Object.entries(files).map(([name, json]) => [name, `${JSON.stringify(json, null, 2)}\n`]),
  );
}
