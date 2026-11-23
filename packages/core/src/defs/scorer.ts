/**
 * Scorers in git (W5 phase 4): `scorers/<id>.yaml` in a task store. `kind: builtin` sets the
 * threshold and the filters of one of the W4 built-in scorers for the store's work; swarmupd's
 * scoring uses it. `kind: rubric` names a rubric file and a judge; swarmupd judges a sample of the
 * closed tasks it applies to on a machine that turns it on (`swarmupd.judge.scorers`, W5 phase 5).
 */
import { checkYaml, enumOf, list, num, obj, str, bool } from './schema.js';
import type { DefProblem, Schema } from './schema.js';
import { normalText } from './hash.js';
import { effortSchema, modelSchema } from './swarm.js';
import { RUNTIME_NAME_RE } from './values.js';

export const SCORERS_DIR = 'scorers';

/** A scorer's id: its file name without `.yaml`. */
export const SCORER_ID_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/**
 * The W4 built-in scorers, by id, in report order. `packages/supervisor/src/scores.ts` holds
 * them; a test there keeps this list the same.
 */
export const BUILTIN_SCORER_IDS: readonly string[] = [
  'criteria-pass-rate',
  'verdict-completeness',
  'review-rounds',
  'merge-failures',
  'cost-per-merged-task',
  'human-touches',
  'escalation-correctness',
  'recommendation-acceptance',
  'stuck-runs',
  'orientation',
  'post-approval-edits',
];

/** Which work a scorer scores: every list that is set must match. */
export interface ScorerAppliesTo {
  /** Task types. */
  types?: string[];
  /** Labels, of which a task carries one. */
  labels?: string[];
  /** Roles of the agent whose work it is (`engineer` of `claude:engineer`). */
  roles?: string[];
  /** Workflows a task's milestone was started from. */
  workflows?: string[];
}

/** A checked scorer file. */
export interface ScorerDef {
  id: string;
  kind: 'builtin' | 'rubric';
  description?: string;
  /** builtin: the built-in scorer it sets; the file id when unset. */
  scorer?: string;
  /** The threshold: for a built-in, in its unit and direction; for a rubric, a share from 0 to 1. */
  pass?: number;
  applies_to?: ScorerAppliesTo;
  /** Default true. */
  enabled: boolean;
  /** rubric: the rubric (`rubrics/<id>.md`). */
  rubric?: string;
  /** rubric: the judge's runtime, model and effort; `swarmupd.judge` fills what it leaves out. */
  judge?: { runtime?: string; model?: string; effort?: string };
  /** rubric: the share of subjects judged, from 0 to 1; a machine may only lower it. */
  sample?: number;
  /** rubric: the judge does not see which agent did the work. Default true. */
  blind?: boolean;
}

/** One scorer file, checked: its definition, or null when it has an error. */
export interface ScorerFileInfo {
  id: string;
  file: string;
  def: ScorerDef | null;
  problems: DefProblem[];
}

const names = (doc: string): Schema => list(str({ pattern: /\S/, hint: 'use a name' }), { doc });

/** The schema of a scorer file. */
export const SCORER_SCHEMA: Schema = obj(
  {
    kind: enumOf(['builtin', 'rubric'], {
      doc: 'builtin: the threshold and filters of a built-in scorer. rubric: an LLM judge scores a sample of closed tasks against a rubric file, on a machine with `swarmupd.judge.scorers: true`.',
    }),
    description: str({ doc: 'What the scorer is for.' }),
    scorer: enumOf([...BUILTIN_SCORER_IDS], {
      doc: 'builtin: the built-in scorer this file sets; the file name when unset.',
    }),
    pass: num({
      doc: "The threshold. A built-in's is in its unit and direction (`swarmup scores` lists them); a rubric's is a share from 0 to 1. A machine's `swarmupd.scorers.<id>.pass` wins.",
    }),
    applies_to: obj(
      {
        types: names('Task types.'),
        labels: names('Labels, of which a task carries one.'),
        roles: names('Roles of the agent whose work it is, such as engineer.'),
        workflows: names("Workflows a task's milestone was started from."),
      },
      {
        nullable: true,
        doc: "Which of this store's work it scores; every list that is set must match. All of it when unset.",
      },
    ),
    enabled: bool({ doc: "Default true; false turns the scorer off for this store's work." }),
    rubric: str({
      pattern: /^[a-z0-9][a-z0-9-]{0,59}$/,
      hint: 'name a rubric (rubrics/<id>.md) such as copy-quality',
      doc: 'rubric: the rubric file, `rubrics/<id>.md`.',
    }),
    judge: obj(
      {
        runtime: str({ pattern: RUNTIME_NAME_RE, hint: 'name a runtime such as claude' }),
        model: modelSchema('The model; `swarmupd.judge.model` when unset.'),
        effort: effortSchema('The effort; `swarmupd.judge.effort` when unset.'),
      },
      { nullable: true, doc: 'rubric: the judge; `swarmupd.judge` fills what it leaves out.' },
    ),
    sample: num({
      min: 0,
      max: 1,
      doc: 'rubric: the share of subjects judged, from 0 to 1. Default 1; a machine may only lower it (`swarmupd.scorers.<id>.sample`).',
    }),
    blind: bool({ doc: 'rubric: the judge does not see which agent did the work. Default true.' }),
  },
  {
    required: ['kind'],
    doc: 'A scorer in git: settings of a built-in scorer, or a rubric scorer.',
  },
);

const RUBRIC_KEYS = ['rubric', 'judge', 'sample', 'blind'] as const;
const BUILTIN_KEYS = ['scorer'] as const;

/** A scorer id from a path in the store (`scorers/<id>.yaml`), or null for another path. */
export function scorerIdOf(path: string): string | null {
  const m = /^scorers\/([^/]+)\.ya?ml$/.exec(path);
  return m && SCORER_ID_RE.test(m[1]!) ? m[1]! : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const strings = (x: unknown): string[] | undefined =>
  Array.isArray(x) ? x.map((e) => String(e).trim()).filter(Boolean) : undefined;

/** Checks one scorer file's text: its schema, then the rules of its kind. */
export function checkScorerText(
  id: string,
  source: string,
  opts: { file: string; strict?: boolean },
): ScorerFileInfo {
  const checked = checkYaml(SCORER_SCHEMA, normalText(source), opts);
  const problems = [...checked.problems];
  const fail = (): ScorerFileInfo => ({ id, file: opts.file, def: null, problems });
  if (problems.some((p) => p.severity === 'error') || !isRecord(checked.value)) return fail();
  const v = checked.value;
  const at = (path: string, severity: DefProblem['severity'], message: string): void => {
    problems.push({ file: opts.file, path, ...checked.at([path]), severity, message });
  };
  const kind = v.kind as ScorerDef['kind'];
  const other = kind === 'builtin' ? RUBRIC_KEYS : BUILTIN_KEYS;
  for (const k of other) {
    if (v[k] !== undefined && v[k] !== null) {
      at(k, 'warning', `${k} is for kind ${kind === 'builtin' ? 'rubric' : 'builtin'}; not read`);
    }
  }
  const scorer = typeof v.scorer === 'string' ? v.scorer : id;
  if (kind === 'builtin' && !BUILTIN_SCORER_IDS.includes(scorer)) {
    at(
      'kind',
      'error',
      `${id} is no built-in scorer; set scorer to one of ${BUILTIN_SCORER_IDS.join(', ')}`,
    );
  }
  if (kind === 'rubric') {
    if (typeof v.rubric !== 'string') at('kind', 'error', 'kind rubric needs rubric');
    if (typeof v.pass === 'number' && (v.pass < 0 || v.pass > 1)) {
      at('pass', 'error', `a rubric scorer passes at a share from 0 to 1; got ${v.pass}`);
    }
  }
  if (problems.some((p) => p.severity === 'error')) return fail();
  const def: ScorerDef = { id, kind, enabled: v.enabled !== false };
  if (typeof v.description === 'string') def.description = v.description;
  if (typeof v.pass === 'number') def.pass = v.pass;
  if (isRecord(v.applies_to)) {
    const a: ScorerAppliesTo = {};
    for (const k of ['types', 'labels', 'roles', 'workflows'] as const) {
      const list = strings(v.applies_to[k]);
      if (list && list.length > 0) a[k] = list;
    }
    if (Object.keys(a).length > 0) def.applies_to = a;
  }
  if (kind === 'builtin') def.scorer = scorer;
  else {
    def.rubric = v.rubric as string;
    if (isRecord(v.judge)) {
      const j: NonNullable<ScorerDef['judge']> = {};
      for (const k of ['runtime', 'model', 'effort'] as const) {
        if (typeof v.judge[k] === 'string') j[k] = v.judge[k] as string;
      }
      def.judge = j;
    }
    if (typeof v.sample === 'number') def.sample = v.sample;
    def.blind = v.blind !== false;
  }
  return { id, file: opts.file, def, problems };
}

/**
 * The share of subjects a rubric scorer judges on this machine: the store's `sample` (default 1),
 * lowered to the machine's `swarmupd.scorers.<id>.sample` when that is lower; a machine never
 * raises it.
 */
export function effectiveSample(git: number | undefined, machine: number | undefined): number {
  const base = git ?? 1;
  return machine === undefined ? base : Math.min(base, machine);
}
