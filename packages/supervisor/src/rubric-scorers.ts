// Rubric scorers in git (W5 phase 5): each store's `scorers/<id>.yaml` with `kind: rubric` has the
// LLM judge (`judge.ts`) score a deterministic sample of the closed tasks it applies to. It runs
// only on the one machine that judges a store (`swarmupd.judge.scorers`, `scoring.runs_on`), under
// a daily token cap, and keeps each judgment in `state.db` `rubric_judgments`; the score keeper
// adds the score rows they gave to the built-in scorers' rows.
import type { Root, Rubric, ScorerDef, Workspace } from '@swarmup/core';
import {
  DEFAULT_DAILY_JUDGE_TOKENS,
  DEFAULT_RUBRIC_PASS,
  effectiveSample,
  judgePrompt,
  loadDefinitions,
  parseRubric,
  shareFraction,
  triggerRunsOn,
} from '@swarmup/core';
import type { JudgeConfig, RuntimeConfig } from './config.js';
import { gitAsync } from './git.js';
import type { JudgeOutcome, JudgeRunner } from './judge.js';
import { judgeFailed, judgeInputs, runJudge } from './judge.js';
import type { RunRecord } from './runs.js';
import type { ScoreResult, ScoreTask, ScorerSetting } from './scores.js';
import { appliesToTask, taskFacts, taskSide } from './scores.js';
import type { RubricJudgmentRow, StateDb } from './state-db.js';

/** What the rubric scorers need of swarmupd. */
export interface RubricScorerHost {
  now(): number;
  ws(): Workspace;
  runs(): RunRecord[];
  /** The machine's `swarmupd.judge`. */
  judge(): JudgeConfig;
  runtimes(): Record<string, RuntimeConfig>;
  /** The roots this machine merges (`swarmupd.merge.<root>`). */
  merging(): string[];
  /** This machine's name (`machine` in the user config). */
  machine(): string | undefined;
  /** `swarmupd.scorers` of the user config. */
  settings(): Record<string, ScorerSetting>;
  db: Pick<StateDb, 'saveJudgment' | 'judgedPairs' | 'judgeTokensSince'> | null;
  /** The git folders a root's work may be in: its code repo, then the store's own. */
  repos(root: Root): string[];
  env(): NodeJS.ProcessEnv;
  /** Why the runtime may not start a judge now (a usage pause, signed out), or null. */
  held(runtime: string): string | null;
  runner?: JudgeRunner;
  signal?: AbortSignal;
  warn(message: string): void;
}

/** Tokens a judge's answer and its runtime's own prompt take, over the rubric prompt. */
const ANSWER_TOKENS = 2000;

/** Hours before a judgment that gave no score is tried again. */
export const JUDGE_RETRY_HOURS = 6;

/**
 * A judgment's tokens, estimated on the high side before it runs: the prompt at 3 characters a
 * token and room for the answer. The cap is checked with it; the tokens the runtime then reports
 * are what counts, so a day can end at most one judgment over the cap.
 */
export function estimateJudgeTokens(prompt: string): number {
  return Math.ceil(prompt.length / 3) + ANSWER_TOKENS;
}

/**
 * Whether this machine judges root `root`: `scorers` is `true` and the machine merges the root,
 * or a list that names it; and the store's `scoring.runs_on`, when set, names this machine. One
 * machine judges a store, so the store's daily cap and each task are spent once.
 */
export function judgesRoot(
  scorers: boolean | readonly string[],
  root: string,
  merging: readonly string[],
  runsOn: readonly string[] | undefined,
  machine: string | undefined,
): boolean {
  if (scorers === false) return false;
  const mine = scorers === true ? merging.includes(root) : scorers.includes(root);
  return mine && triggerRunsOn({ runs_on: runsOn ? [...runsOn] : undefined }, machine);
}

/** The start of the UTC day of `now`, as ISO. */
function dayStart(now: number): string {
  return `${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Whether rubric scorer `id` judges task `ref`: `sha256('rubric-sample:' + id + ref)` as a
 * fraction under `sample`.
 */
export function sampled(id: string, ref: string, sample: number): boolean {
  return shareFraction('rubric-sample', id, ref) < sample;
}

/**
 * The task text a judge reads: its title and body. Blind, every agent id of the machine's runtimes
 * (`claude:engineer`), its slug (`claude-engineer`) and each runtime's name as a word, in any
 * case, are replaced in the text and the diff, so the judge cannot tell who did the work;
 * otherwise the text names the agent.
 */
export function judgeTexts(
  task: { title: string; body: string },
  diff: string,
  agent: string,
  opts: { blind: boolean; runtimes: readonly string[] },
): { task: string; diff: string } {
  const text = `# ${task.title}\n\n${task.body}`.trim();
  if (!opts.blind) return { task: `${text}\n\nDone by: ${agent}`, diff };
  const names = [...new Set([...opts.runtimes, agent.slice(0, agent.indexOf(':'))])]
    .filter(Boolean)
    .map((n) => n.replace(/[^a-z0-9]/g, ''));
  const alt = names.join('|');
  const ids = new RegExp(`\\b(?:${alt})[:-][a-z][a-z0-9-]*`, 'gi');
  const bare = new RegExp(`\\b(?:${alt})\\b`, 'gi');
  const hide = (s: string): string =>
    s.split(agent).join('an agent').replace(ids, 'an agent').replace(bare, 'a runtime');
  return { task: hide(text), diff: hide(diff) };
}

/**
 * The diff of a closed task's work, from its git history: from the commit its first writing run
 * started at to the commit its last review named, else a merge commit's first parent to the
 * merge. Tries each folder in turn; null when none has both commits.
 */
export async function taskWorkDiff(
  dirs: readonly string[],
  task: ScoreTask,
  runs: readonly RunRecord[],
): Promise<string | null> {
  const last = (type: string): string | undefined =>
    [...task.events].reverse().find((e) => e.type === type && e.commit)?.commit;
  const review = last('review');
  const merge = last('merge');
  const first = runs
    .filter((r) => r.task === task.id && (!r.root || r.root === task.root) && !r.review && r.base)
    .sort((a, b) => (a.started_at < b.started_at ? -1 : 1))[0];
  for (const dir of dirs) {
    const pairs: Array<[string, string]> = [];
    if (review && first?.base) pairs.push([first.base, review]);
    if (merge) {
      try {
        const parents = (await gitAsync(dir, ['rev-list', '--parents', '-n', '1', merge]))
          .trim()
          .split(/\s+/);
        if (parents.length > 2) pairs.push([`${merge}^1`, merge]);
      } catch {
        // Not in this folder.
      }
    }
    for (const [from, to] of pairs) {
      try {
        const diff = await gitAsync(dir, ['diff', from, to]);
        if (diff.trim()) return diff;
      } catch {
        // One of the commits is not in this folder.
      }
    }
  }
  return null;
}

/** One closed task a rubric scorer is to judge. */
interface Pending {
  root: Root;
  def: ScorerDef;
  rubric: Rubric;
  pass: number;
  task: ScoreTask;
  body: string;
  author: string;
}

/**
 * Judges the closed tasks the rubric scorers of each store take and have not judged, at most
 * `max` per call, one at a time. Stops for a store at its daily token cap, and for all at the
 * machine's, and while the judge's runtime is held. Returns how many judgments it recorded.
 */
export async function runRubricScorers(
  host: RubricScorerHost,
  opts: { max?: number } = {},
): Promise<number> {
  const judge = host.judge();
  const db = host.db;
  if (!judge.scorers || !db) return 0;
  const max = opts.max ?? 5;
  const now = host.now();
  const since = dayStart(now);
  const ws = host.ws();
  const runs = host.runs();
  const settings = host.settings();
  const judged = db.judgedPairs(new Date(now - JUDGE_RETRY_HOURS * 3_600_000).toISOString());
  const machineCap = judge.daily_tokens;
  let machineSpent = db.judgeTokensSince(since);
  let done = 0;
  for (const root of ws.roots) {
    if (root.isMirror) continue;
    let set;
    try {
      set = loadDefinitions(root.dir);
    } catch {
      continue;
    }
    const scoring = set.swarm?.scoring;
    if (!judgesRoot(judge.scorers, root.name, host.merging(), scoring?.runs_on, host.machine())) {
      continue;
    }
    const defs = set.scorers.flatMap((sc) => {
      const d = sc.def;
      if (!d || d.kind !== 'rubric' || !d.enabled || !d.rubric) return [];
      if (settings[d.id]?.enabled === false) return [];
      if (scoring?.scorers && !scoring.scorers.includes(d.id)) return [];
      return [d];
    });
    if (defs.length === 0) continue;
    const cap = Math.min(
      scoring?.daily_judge_tokens ?? DEFAULT_DAILY_JUDGE_TOKENS,
      machineCap ?? Number.POSITIVE_INFINITY,
    );
    let spent = db.judgeTokensSince(since, root.name);
    const closed = ws
      .list({ all: true })
      .filter((t) => t.root === root.name && t.status === 'done');
    for (const def of defs) {
      let rubric: Rubric;
      try {
        rubric = parseRubric(
          set.texts[`rubrics/${def.rubric}.md`] ?? '',
          `rubrics/${def.rubric}.md`,
        );
      } catch {
        continue;
      }
      const sample = effectiveSample(def.sample ?? scoring?.sample, settings[def.id]?.sample);
      const pass = def.pass ?? DEFAULT_RUBRIC_PASS;
      for (const view of closed) {
        const ref = `${root.name}/${view.meta.id}`;
        if (judged.has(`${def.id}\0${ref}`) || !sampled(def.id, ref, sample)) continue;
        const a = def.applies_to;
        if (a?.types && !a.types.includes(view.meta.type)) continue;
        if (a?.labels && !(view.meta.labels ?? []).some((l) => a.labels!.includes(l))) continue;
        let shown;
        try {
          shown = ws.showEvents(ref);
        } catch {
          continue;
        }
        const task: ScoreTask = {
          root: root.name,
          id: view.meta.id,
          title: view.meta.title,
          meta: view.meta,
          status: view.status,
          events: shown.events,
        };
        const author = taskFacts(task).author;
        const parentWorkflow = view.meta.parent
          ? (() => {
              try {
                return ws.showEvents(`${root.name}/${view.meta.parent}`).meta.workflow;
              } catch {
                return undefined;
              }
            })()
          : undefined;
        if (!author || !appliesToTask(a, task, author, view.meta.workflow ?? parentWorkflow)) {
          continue;
        }
        const p: Pending = { root, def, rubric, pass, task, body: shown.body, author };
        const config: JudgeConfig = {
          ...judge,
          ...(def.judge?.runtime ? { runtime: def.judge.runtime } : {}),
          ...(def.judge?.model ? { model: def.judge.model } : {}),
          ...(def.judge?.effort ? { effort: def.judge.effort } : {}),
        };
        const held = host.held(config.runtime);
        if (held) return done;
        const row = await judgeOne(host, p, config, runs, {
          fits: (tokens) =>
            spent + tokens <= cap &&
            (machineCap === undefined || machineSpent + tokens <= machineCap),
        });
        if (row === 'cap') break;
        if (row === 'aborted') return done;
        db.saveJudgment(row);
        judged.add(`${def.id}\0${ref}`);
        spent += row.tokens;
        machineSpent += row.tokens;
        if (++done >= max) return done;
      }
    }
  }
  return done;
}

/** Judges one task, or `cap` when its estimated tokens would pass the cap. */
async function judgeOne(
  host: RubricScorerHost,
  p: Pending,
  config: JudgeConfig,
  runs: readonly RunRecord[],
  cap: { fits: (tokens: number) => boolean },
): Promise<RubricJudgmentRow | 'cap' | 'aborted'> {
  const ref = `${p.task.root}/${p.task.id}`;
  const at = (): string => new Date(host.now()).toISOString();
  const base = { scorer: p.def.id, root: p.root.name, subject: ref, agent: p.author };
  const diff = await taskWorkDiff(host.repos(p.root), p.task, runs);
  if (diff === null) {
    return {
      ...base,
      judged_at: at(),
      tokens: 0,
      cost_usd: null,
      result: null,
      error: 'no diff of the work found in git',
    };
  }
  const texts = judgeTexts({ title: p.task.title, body: p.body }, diff, p.author, {
    blind: p.def.blind !== false,
    runtimes: Object.keys(host.runtimes()),
  });
  const inputs = await judgeInputs(p.rubric, { diff: texts.diff, task: texts.task });
  const estimate = estimateJudgeTokens(judgePrompt(p.rubric, inputs));
  if (!cap.fits(estimate)) return 'cap';
  const outcome: JudgeOutcome = await runJudge(p.rubric, inputs, p.pass, {
    config,
    env: host.env(),
    runtimes: host.runtimes(),
    ...(host.runner ? { runner: host.runner } : {}),
    ...(host.signal ? { signal: host.signal } : {}),
  });
  // A judgment stopped by swarmupd's shutdown or update is no failure of the task: nothing is kept.
  if (judgeFailed(outcome) && host.signal?.aborted) return 'aborted';
  const tokens = outcome.tokens ?? estimate;
  if (judgeFailed(outcome)) {
    return {
      ...base,
      judged_at: at(),
      tokens,
      cost_usd: outcome.costUsd,
      result: null,
      error: outcome.error,
    };
  }
  const closed = [...p.task.events]
    .reverse()
    .find((e) => e.type === 'done' || e.type === 'verdict');
  const result: ScoreResult = {
    scorer: p.def.id,
    level: 'task',
    subject: ref,
    agent: p.author,
    value: Math.round(outcome.score * 1000) / 1000,
    unit: 'ratio',
    pass: outcome.result === 'pass',
    n: 1,
    evidence: closed ? [closed.id] : [],
    at: closed?.at ?? at(),
    extra: outcome.scores,
    note: outcome.reasons,
    rubric: { id: p.rubric.id, pass: p.pass },
    ...taskSide(p.task, p.author),
  };
  return { ...base, judged_at: at(), tokens, cost_usd: outcome.costUsd, result, error: null };
}
