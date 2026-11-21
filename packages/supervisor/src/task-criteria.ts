// What the desktop app's task panel needs beyond `swarmup show`: a task's goal brief with its
// children, and `swarmup criteria check` run by swarmupd in the background, so the app can show
// each criterion's result as it lands.
import type { Brief, CommandOutcome, CriteriaResults, Criterion, OpsEvent } from '@swarmup/core';
import { foldBrief, MILESTONE_TYPE, redactSecrets, runCriteria, RUN_KINDS } from '@swarmup/core';

/** One child of a parent task, as the panel lists it. */
export interface BriefChild {
  id: string;
  title: string;
  status: string;
  updatedAt: string;
}

/**
 * The children closed since the brief, oldest close first: `done` children whose last event
 * (`updatedAt`, so a merge after the close counts) is newer than the brief. Without a brief,
 * every closed child of a milestone, and none of another parent, which needs no brief until
 * someone writes one. The PM's inbox run lists the same ones (`briefsToRefresh`).
 */
export function closedSinceBrief(
  type: string,
  brief: Pick<Brief, 'at'> | null,
  children: ReadonlyArray<Pick<BriefChild, 'id' | 'status' | 'updatedAt'>>,
): string[] {
  if (!brief && type !== MILESTONE_TYPE) return [];
  const after = brief ? Date.parse(brief.at) : -Infinity;
  return children
    .filter((k) => k.status === 'done' && Date.parse(k.updatedAt) > after)
    .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .map((k) => k.id);
}

/**
 * The brief part of a task's detail: the current brief, the children and those closed since
 * the brief. Empty for a task that is no milestone and has neither children nor a brief.
 */
export function briefDetail(
  type: string,
  events: readonly OpsEvent[],
  children: readonly BriefChild[],
): { brief?: Brief; children?: BriefChild[]; closedSinceBrief?: string[] } {
  const brief = foldBrief(events);
  if (!brief && children.length === 0 && type !== MILESTONE_TYPE) return {};
  const closed = closedSinceBrief(type, brief, children);
  return {
    ...(brief ? { brief } : {}),
    children: [...children],
    ...(closed.length > 0 ? { closedSinceBrief: closed } : {}),
  };
}

/** A check run on one task: what runs, what has a result, and where. */
export interface CriteriaCheckJob {
  /** `root/id`. */
  task: string;
  /** Who asked for it; the `criteria-check` event is theirs. */
  by: string;
  /** The folder the checks run in: the task's worktree, else the root's code checkout. */
  cwd: string;
  startedAt: string;
  endedAt?: string;
  /** The ids of the criteria it runs, in order. */
  ids: string[];
  /** The criterion running now. */
  current?: string;
  /** The results so far, by id. */
  results: CriteriaResults;
  /** Why it stopped without recording, such as a refused write. */
  error?: string;
  /** The `criteria-check` event it recorded. */
  event?: string;
}

export interface CriteriaCheckDeps {
  /** Runs one command criterion in `cwd`. */
  runCommand: (command: string, cwd: string) => Promise<CommandOutcome>;
  /** Records the results as a `criteria-check` event; returns its id. */
  record: (task: string, by: string, results: CriteriaResults, message: string) => string;
  now?: () => number;
}

/**
 * `swarmup criteria check` for the app: runs a task's `command` and `check` criteria one by one
 * in the background, keeps each result as it lands, and records them all in one
 * `criteria-check` event at the end, as the CLI does. One run per task at a time; the last one
 * stays readable until the next starts.
 */
export class CriteriaChecks {
  private readonly jobs = new Map<string, CriteriaCheckJob>();
  private readonly now: () => number;

  constructor(private readonly deps: CriteriaCheckDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The task's running or last check run, or null. */
  get(task: string): CriteriaCheckJob | null {
    return this.jobs.get(task) ?? null;
  }

  /**
   * Starts a check run of the `command` and `check` criteria of `criteria` in `cwd`. Throws when
   * one runs for the task already, or when it has none to run. `done` resolves when it ends.
   */
  start(
    task: string,
    by: string,
    cwd: string,
    criteria: readonly Criterion[],
  ): { job: CriteriaCheckJob; done: Promise<void> } {
    const running = this.jobs.get(task);
    if (running && !running.endedAt) throw new Error(`the checks of ${task} are running already`);
    const runs = criteria.filter((c) => RUN_KINDS.has(c.kind));
    if (runs.length === 0) throw new Error(`${task} has no command or check criteria to run`);
    const job: CriteriaCheckJob = {
      task,
      by,
      cwd,
      startedAt: new Date(this.now()).toISOString(),
      ids: runs.map((c) => c.id),
      results: {},
    };
    this.jobs.set(task, job);
    const done = this.run(job, runs);
    return { job, done };
  }

  private async run(job: CriteriaCheckJob, runs: readonly Criterion[]): Promise<void> {
    try {
      for (const c of runs) {
        job.current = c.id;
        const r = await runCriteria([c], {
          cwd: job.cwd,
          runCommand: async (command, cwd) => {
            const out = await this.deps.runCommand(command, cwd);
            return { ...out, output: redactSecrets(out.output) };
          },
        });
        Object.assign(job.results, r);
      }
      job.current = undefined;
      const failed = job.ids.filter((id) => job.results[id]?.result === 'fail');
      const summary = failed.length > 0 ? `failed: ${failed.join(', ')}` : 'all passed';
      job.event = this.deps.record(
        job.task,
        job.by,
        job.results,
        `Checked ${job.ids.length} criteria in ${job.cwd}: ${summary}.`,
      );
    } catch (err) {
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.current = undefined;
      job.endedAt = new Date(this.now()).toISOString();
    }
  }
}
