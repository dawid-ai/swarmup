// swarmupd's merge pipeline: approved work into its base, one merge or one batch at a time.
// Moved out of supervisor.ts, which keeps a `merger` and delegates its public merge calls here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskView } from '@swarmup/core';
import {
  formatMinutes,
  redactSecrets,
  runtimeOf,
  ulid,
  Workspace,
  MERGE_ACTOR,
} from '@swarmup/core';
import { Checkout, leftoverBranch } from './checkout.js';
import { StoredMap, StoredSet } from './state-db.js';
import type { MergeAttempt, MergeCount, MergeOutcome } from './state-db.js';
import { MERGE_CONFLICT } from './merge-conflict.js';
import { checksFor } from './merge-checks.js';
import type { MergeConfig } from './config.js';
import type { CommandResult, CommandStep, MergeSource } from './merge.js';
import {
  CommandRunner,
  GitTimeout,
  insideDir,
  installSteps,
  isEngineRepo,
  lockfileDirs,
  MergeRepo,
  notLiveNotice,
  opsdCodeChanges,
  pickMergeSource,
  reviewCommits,
} from './merge.js';
import { reviewSourcesOf, storeReview, type ReviewText } from '@swarmup/core';
import { gitError } from './push.js';
import type { WorktreeEntry } from './worktree.js';
import { parseWorktreeList, taskIdOfWorktree } from './worktree.js';
import type { Supervisor } from './supervisor.js';
import {
  sleep,
  DIRTY_CHANNEL,
  MERGE_ATTEMPTS,
  MERGE_LOOKS,
  MERGE_RETRY_MS,
  MERGE_HOLD_POLL_MS,
  MergeJob,
  BatchItem,
  PendingBuild,
  MergeStep,
  MergeStatus,
  committedRunSource,
  uncommittedRun,
  short,
  mergeTimeout,
  mergeBatchSize,
  elapsed,
  firstLines,
  lastLines,
  samePath,
} from './supervisor.js';

/**
 * Merges approved work into its base for a {@link Supervisor}: plans which task goes next, runs
 * the merge in swarmupd's worktree, builds the base, and records how each attempt ended. It reads
 * swarmupd's config, workspace and runs through `sup`.
 */
export class Merger {
  constructor(readonly sup: Supervisor) {
    this.mergeTimedOut = new StoredSet(sup.state, 'timed-out');
    this.mergeLooks = new StoredMap(sup.state, 'looks', { encode: String, decode: Number });
  }

  /**
   * Tasks whose merge check timed out once: the next try runs with the machine to itself (AO-0172,
   * AO-0385). Kept in `state.db`, so a restart between the two keeps the retry.
   */
  readonly mergeTimedOut: StoredSet;
  /** The open merge attempt of each task, by `state.db` id. */
  readonly attempts = new Map<string, number>();
  /**
   * The task whose merge checks run again after they timed out once: no new run starts beside
   * them, so the second try has the machine to itself (AO-0385).
   */
  mergeQuiet: string | null = null;
  /** Per task, the merges in a row that could not read the task's worktrees (AO-0300); in `state.db`. */
  readonly mergeLooks: StoredMap<number>;
  /**
   * The merge under way, if any. While `holds` is set, its checkout takes no new writing run:
   * from the fast-forward of the base until the build is over. The rebase and the checks run in
   * swarmupd's own worktree and hold nothing (AO-0160).
   */
  merging: {
    ref: string;
    top: string;
    base: string;
    what: string;
    runner: CommandRunner;
    done: Promise<void>;
    holds: boolean;
    step: MergeStep;
    startedAt: number;
    command: { text: string; index: number; count: number; startedAt: number } | null;
    timeoutMs: number;
  } | null = null;
  /** The look for the next task to merge, while git answers it. */
  mergePlan: Promise<void> | null = null;
  /**
   * Per task, the last event already looked at for a merge, so unchanged tasks are not read again.
   * Kept in memory only: a restart or an update looks at every approved task again, which retries
   * one whose merge failed for a cause the update may have fixed.
   */
  readonly mergeSeen = new Map<string, string>();
  /** Approved tasks swarmupd found nothing to merge for, by the last event they had then. */
  readonly mergeNone = new Map<string, string>();

  // ---- Merging approved work ------------------------------------------------------------------

  /**
   * Starts merging one approved task of a root with `swarmupd.merge` set, when no merge runs and no
   * writing run is live in the checkout the base is built in. A task qualifies when its last
   * verdict approves it, came after swarmupd first saw the root's merge setting, has nothing from
   * swarmupd after it, and the review it approved names a branch. Planning asks git which branches
   * and commits exist, off the event loop (AO-0169); a tick that comes meanwhile shares it.
   */
  mergeTick(): Promise<void> {
    if (this.mergePlan) return this.mergePlan;
    const plan = this.planMerge()
      .catch((err: unknown) => {
        this.sup.emit('warn', `merge: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.mergePlan === plan) this.mergePlan = null;
      });
    this.mergePlan = plan;
    return plan;
  }

  /** Whether merge planning stops: swarmupd stops, or a merge or a leftover cleanup is under way. */
  mergeHalted(): boolean {
    return !!(this.merging || this.sup.stopping || this.sup.mergeClearing);
  }

  async planMerge(): Promise<void> {
    if (this.mergeHalted()) return;
    // Paused: no new merge starts either, so a person can work on the base undisturbed; a merge
    // under way finishes.
    if (this.sup.config.paused) return;
    // Review checks use the machine now; a merge's checks beside them make both time out.
    if (this.sup.reviewChecking) return;
    // What an earlier merge command left running goes first, so nothing races it.
    if (this.sup.mergeLeftovers().length > 0) {
      this.sup.clearMergeLeftovers();
      return;
    }
    const merge = this.sup.config.merge;
    // A build an earlier swarmupd stopped after moving a base goes first.
    for (const p of Object.values(this.pendingBuilds())) {
      const cfg = merge[p.root];
      if (!cfg || cfg.base !== p.base) {
        this.dropPendingBuild(p.ref);
        continue;
      }
      if (!this.sup.writerIn(p.top)) {
        this.sup.emit(
          'warn',
          `merge of ${p.ref}: building ${p.base} again; the earlier build did not finish`,
        );
        this.startMerge(
          { ref: p.ref, top: p.top, base: p.base, what: p.what, human: p.human, cfg, holds: true },
          (runner) => this.buildMerged(p, cfg, runner),
        );
      }
      return;
    }
    if (Object.keys(merge).length === 0) return;
    const ws = this.sup.ws();
    const since = this.mergeSince(ws.roots.filter((r) => merge[r.name]).map((r) => r.name));
    const views = ws.views();
    this.freeMergeWaiters(ws, views, since);
    const done = views
      .filter((v) => v.status === 'done' && merge[v.root] && v.updatedAt >= since[v.root]!)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    // The first task ready to merge, and the later ones of the same root that wait with it: they
    // merge together, with one run of the checks (AO-0381).
    const batch: { ref: string; job: MergeJob; last: string | null }[] = [];
    for (const v of done) {
      const ref = `${v.root}/${v.meta.id}`;
      if (v.lastEvent && this.mergeSeen.get(ref) === v.lastEvent) continue;
      const first = batch[0];
      if (first && v.root !== first.job.root) continue;
      const job = await this.mergeJob(ws, ref, merge[v.root]!, since[v.root]!);
      // A stop, or a merge another way started, while git answered.
      if (this.mergeHalted()) return;
      // A reopen or a newer verdict that came while git answered makes the job stale; the next
      // tick reads the task again.
      const now = this.sup.ws().view(ref);
      if (now.status !== 'done' || now.lastEvent !== v.lastEvent) continue;
      if (!job) {
        if (v.lastEvent) {
          this.mergeSeen.set(ref, v.lastEvent);
          this.mergeNone.set(ref, v.lastEvent);
        }
        continue;
      }
      if (first && !samePath(job.top, first.job.top)) continue;
      // The checkout's writing run finishes first; this task waits for the next tick.
      if (this.sup.writerIn(job.top)) continue;
      batch.push({ ref, job, last: v.lastEvent });
      if (batch.length >= mergeBatchSize(job.cfg)) break;
    }
    // A task reopened while git answered for a later one waits for the next tick.
    const ready = batch.filter((b) => {
      const now = this.sup.ws().view(b.ref);
      return now.status === 'done' && now.lastEvent === b.last;
    });
    const lead = ready[0];
    if (!lead || this.sup.writerIn(lead.job.top)) return;
    const { job } = lead;
    const at = { top: job.top, base: job.cfg.base, human: job.human, cfg: job.cfg };
    if (ready.length === 1) {
      this.startMerge({ ...at, ref: lead.ref, what: job.what }, (runner) =>
        this.mergeOne(lead.ref, job, runner),
      );
      return;
    }
    const ids = ready.map((b) => this.sup.ws().resolve(b.ref).id);
    this.startMerge(
      { ...at, ref: lead.ref, what: `${ready.length} approved tasks (${ids.join(', ')})` },
      (runner) => this.mergeBatch(ready, runner),
    );
  }

  /**
   * Notes on approved tasks that other tasks wait on, and that swarmupd merges nothing for, that
   * no merge comes: a task blocked on approved work waits for the merge event (AO-0228), and
   * without the note it would wait for good with nobody told. An approval from before the root's
   * merge setting (by the time of the verdict, whatever came after it), and reviews whose only `branch <word>` is prose, have nothing to merge: the
   * note frees the waiters. Reviews that name `<commit> on branch <name>` the repo lacks (found
   * by an earlier tick's `mergeJob`) are work that is missing from the base: the waiters stay
   * blocked, and the note tells the human. Once per approval: nothing follows a note, or the
   * note of a merge that failed.
   */
  freeMergeWaiters(ws: Workspace, views: TaskView[], since: Record<string, string>): void {
    const waited = new Set(ws.mergeWaited());
    if (waited.size === 0) return;
    for (const v of views) {
      const ref = `${v.root}/${v.meta.id}`;
      if (!waited.has(ref) || v.status !== 'done' || !v.awaitsMerge) continue;
      const from = since[v.root];
      if (!from) continue;
      const approval = this.sup.afterApproval(ws, ref);
      // swarmupd wrote about this approval already, say that its merge failed.
      if (approval?.wrote.length !== 0) continue;
      // The approval's own time, as `mergeJob` reads it: a later comment moves `updatedAt`
      // past the merge setting, and the approval is still one swarmupd never merges.
      const before = approval.at < from;
      if (!before && !(v.lastEvent && this.mergeNone.get(ref) === v.lastEvent)) continue;
      const id = v.meta.id;
      const named =
        !before &&
        ws.showEvents(ref).events.some((e) => e.type === 'review' && !!reviewSourcesOf(e).named);
      if (named) {
        this.mergeNote(
          ref,
          `swarmupd cannot merge ${id}: its review requests name a commit and a branch, and the repo has neither. The tasks blocked on ${id} stay blocked: reopen ${id} to get the work merged, or free each of them with \`swarmup unblock\`.`,
          ws.roots.find((r) => r.name === v.root)?.config.human,
        );
        continue;
      }
      const why = before
        ? `it was approved before swarmupd merged approved work of ${v.root}`
        : 'no review request names a branch or commit';
      this.mergeNothing(
        ref,
        `swarmupd merges nothing for ${id}: ${why}. The tasks blocked on it go on.`,
      );
    }
  }

  /**
   * Runs `work` as the merge under way in the checkout `top`; `holds` says whether it holds the
   * checkout from the start, as a build does (see `holdCheckout`).
   */
  startMerge(
    job: {
      ref: string;
      top: string;
      base: string;
      what: string;
      human: string | undefined;
      cfg: MergeConfig;
      holds?: boolean;
    },
    work: (runner: CommandRunner) => Promise<void | 'again'>,
  ): void {
    const { ref, top, base, what, human } = job;
    const holds = job.holds ?? false;
    const runner = new CommandRunner(this.sup.commandEnv(), {
      watch: this.sup.mergeWatch(),
      now: this.sup.now,
    });
    const startedAt = this.sup.now();
    this.merging = {
      ref,
      top,
      base,
      what,
      runner,
      done: Promise.resolve(),
      holds,
      // A build that holds from the start is all there is of it.
      step: holds ? 'build' : 'rebase',
      startedAt,
      command: null,
      timeoutMs: mergeTimeout(job.cfg),
    };
    const merging = this.merging;
    this.mergeLine(
      ref,
      holds
        ? `builds ${base} again in ${top}; holds it from new writing runs`
        : `starts: ${what} into ${base}, built in ${top}`,
    );
    this.mergeChanged();
    let again = false;
    // The task the merge ends on: the one it was at when it failed. In a batch that is the task
    // being merged then, not the first one (AO-0381); the others got nothing and go on next tick.
    let at = ref;
    merging.done = work(runner)
      .then((r) => {
        again = r === 'again';
      })
      .catch((err) => {
        at = merging.ref;
        const failed = at === ref ? what : merging.what;
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        this.sup.emit('warn', `merge of ${at}: ${msg}`);
        if (err instanceof GitTimeout) {
          // The step it hung in and what it printed last, so the human sees why (AO-0172).
          const output = redactSecrets(err.output);
          const out = lastLines(output);
          const log = this.mergeLog(at, output);
          const parts = [
            `swarmupd could not merge ${failed}: ${firstLines(msg)} (stage: ${err.stage ?? merging.step}).`,
            out ? `Last output:\n\n\`\`\`\n${out}\n\`\`\`` : 'It printed nothing.',
          ];
          if (log) parts.push(`Full output: ${log}`);
          this.mergeNote(at, parts.join('\n\n'), human);
          return;
        }
        this.mergeNote(at, `swarmupd could not merge ${failed}: ${firstLines(msg)}`, human);
      })
      .finally(() => {
        // A task of the job with no outcome goes round again at a later tick, or the merge
        // stopped with swarmupd.
        for (const open of [...this.attempts.keys()]) {
          this.attemptEnd(open, this.sup.stopping ? 'stopped' : 'again');
        }
        // The one more merge after a check timed out is for this merge only (AO-0172).
        if (!again) this.mergeTimedOut.delete(at);
        // A merge that wrote nothing is not tried again until the task changes; one stopped
        // with swarmupd is, by the next swarmupd, and one the PC's sleep broke, by the next tick.
        this.sup.safe(() => {
          const last = this.sup.ws().view(at).lastEvent;
          if (last && !this.sup.stopping && !again) this.mergeSeen.set(at, last);
        });
        this.mergeLine(ref, `ends after ${elapsed(this.sup.now() - startedAt)}`);
        this.merging = null;
        this.mergeChanged();
      });
  }

  /** The merge under way, if any, with its step, its command and their times (AO-0161). */
  mergeStatus(): MergeStatus | null {
    const m = this.merging;
    if (!m) return null;
    const iso = (ms: number): string => new Date(ms).toISOString();
    return {
      task: m.ref,
      what: m.what,
      base: m.base,
      top: m.top,
      step: m.step,
      holds: m.holds,
      started_at: iso(m.startedAt),
      ...(m.command
        ? {
            command: {
              text: m.command.text,
              index: m.command.index,
              count: m.command.count,
              started_at: iso(m.command.startedAt),
            },
          }
        : {}),
      timeout_minutes: Math.round(m.timeoutMs / 60_000),
    };
  }

  /** Why a writing run in the checkout `top` waits for the merge under way. */
  mergeHold(top: string): string {
    return `${this.mergeHoldStart()}${top}; it holds the checkout until its build ends`;
  }

  /** The start of `mergeHold`'s text, which `waits` looks for to mark the work it holds. */
  mergeHoldStart(): string {
    const m = this.merging;
    return m ? `swarmupd merges ${m.ref} into ${m.base} in ` : '\0';
  }

  /** Moves the merge under way to `step`, and logs it unless it stays the same. */
  mergeStep(step: MergeStep, line?: string): void {
    const m = this.merging;
    if (!m) return;
    if (m.step !== step && line) this.mergeLine(m.ref, line);
    m.step = step;
    m.command = null;
    this.mergeChanged();
  }

  /**
   * Tells listeners (the API's event stream, so open app windows) that the merge under way
   * started, moved on or ended: `merge-status` carries `mergeStatus()`, null once it ended.
   */
  mergeChanged(): void {
    this.sup.emit('merge-status', this.mergeStatus());
  }

  /** A line in opsd.log on the merge of `ref` (AO-0161). */
  mergeLine(ref: string, text: string): void {
    this.sup.emit('merge', `${ref}: ${text}`);
  }

  /**
   * Follows the check or build command of the merge under way: keeps it for `mergeStatus` and
   * logs its start and its result.
   */
  mergeCommand(kind: 'check' | 'build', s: CommandStep): void {
    const m = this.merging;
    if (!m) return;
    const label = `${kind} ${s.index + 1}/${s.count} \`${s.command}\``;
    if (!s.result) {
      m.command = { text: s.command, index: s.index, count: s.count, startedAt: this.sup.now() };
      const where = kind === 'check' ? "swarmupd's worktree" : m.top;
      const mins = Math.round(m.timeoutMs / 60_000);
      this.mergeLine(m.ref, `${label} starts in ${where}, timeout ${mins} min`);
      this.mergeChanged();
      return;
    }
    const took = m.command ? elapsed(this.sup.now() - m.command.startedAt) : '?';
    const how = s.result.ok ? 'passed' : `failed (${s.result.why ?? 'exit ?'})`;
    this.mergeLine(m.ref, `${label} ${how} after ${took}`);
    m.command = null;
    this.mergeChanged();
  }

  /**
   * Holds the merge's checkout `top` from new writing runs, then waits for any writing run that
   * started there during the checks to end, so the base never moves under it. Returns 'stopped'
   * when swarmupd stops first, 'waited' after a wait, else 'free'.
   */
  async holdCheckout(ref: string, top: string): Promise<'free' | 'waited' | 'stopped'> {
    if (this.merging && !this.merging.holds) {
      this.merging.holds = true;
      this.mergeLine(ref, `holds ${top} from new writing runs until the build ends`);
      this.mergeChanged();
    }
    let waited = false;
    while (this.sup.writerIn(top)) {
      if (this.sup.stopping) return 'stopped';
      if (!waited) {
        this.mergeStep('waiting');
        this.sup.emit('warn', `merge of ${ref}: waits for the writing run in ${top} to end`);
      }
      waited = true;
      await sleep(MERGE_HOLD_POLL_MS);
    }
    if (this.sup.stopping) return 'stopped';
    return waited ? 'waited' : 'free';
  }

  /**
   * Resolves once the merge under way, if any, is over; and first, a look at what earlier merge
   * commands left running, with the merge it lets start.
   */
  async mergeSettled(): Promise<void> {
    await this.sup.mergeClearing;
    await this.mergePlan;
    await this.merging?.done;
  }

  /** When swarmupd first saw each root's merge setting; only verdicts after it are merged. */
  mergeSince(roots: string[]): Record<string, string> {
    const since = this.sup.store.readJson<Record<string, string>>('merge.json', {});
    let changed = false;
    for (const r of roots) {
      if (since[r]) continue;
      since[r] = new Date(this.sup.now()).toISOString();
      changed = true;
    }
    if (changed) this.sup.store.writeJson('merge.json', since);
    return since;
  }

  /**
   * True when the planner looked at `ref` as it is now (`lastEvent`) and found nothing for
   * swarmupd to merge: the work is on the base already, or the approval names nothing it can merge.
   */
  nothingToMerge(ref: string, lastEvent: string | null): boolean {
    return lastEvent !== null && this.mergeNone.get(ref) === lastEvent;
  }

  /** What merging `ref` takes, or null when the task has nothing for swarmupd to merge. */
  async mergeJob(
    ws: Workspace,
    ref: string,
    cfg: MergeConfig,
    since: string,
  ): Promise<MergeJob | null> {
    const { events } = ws.showEvents(ref);
    let at = events.length - 1;
    while (at >= 0 && events[at]!.type !== 'verdict') at--;
    const verdict = events[at];
    if (!verdict || verdict.verdict !== 'approve' || verdict.actor === MERGE_ACTOR) return null;
    if (verdict.at < since) return null;
    if (events.slice(at + 1).some((e) => e.actor === MERGE_ACTOR)) return null;
    const reviews = events
      .slice(0, at)
      .reverse()
      .filter((e) => e.type === 'review');
    const review = reviews[0];
    if (!review) return null;
    const { root, id } = ws.resolve(ref);
    // A run may ask for review before it ends, then leave files that its sandbox could not
    // commit. Wrap-up commits those files on a run-suffixed branch and records that source after
    // the review. The approval covers the review plus that note, so it is the source to merge;
    // the branch named by the earlier review lacks the files (AO-0356).
    const committed = committedRunSource(events);
    // A review sent from the task store's own repo is store work (AO-0384): `swarmup sync` has
    // pushed it, and the code repo has nothing of it, so nothing is merged and no finding says
    // that the work is missing from the base. The tasks blocked on it go on.
    if (!committed && storeReview(review)) {
      const storeAt = review.commit ? ` (store commit ${short(review.commit)})` : '';
      this.mergeNothing(
        ref,
        `swarmupd merges nothing for ${id}: nothing to merge: store work, synced. ` +
          `Its approved review was sent from the task store's repo${storeAt}, which \`swarmup sync\` ` +
          'pushes. The tasks blocked on it go on.',
      );
      return null;
    }
    const top = cfg.checkout ? resolve(cfg.checkout) : this.sup.codeTopOf(root);
    if (!top) return null;
    const repo = new MergeRepo(top, '', [], this.sup.commandEnv());
    const src = committed ?? (await this.pickSource(repo, reviews, () => this.mergeHalted()));
    if (!src || src === 'halted') return null;
    const what = src.commit
      ? `${src.commit} on branch ${src.branch}`
      : `branch ${src.branch ?? '?'}`;
    const v = ws.view(ref);
    const author = v.owner && !v.owner.includes('*') ? v.owner : review.actor;
    return {
      cfg,
      top,
      src,
      what,
      author,
      human: root.config.human,
      root: root.name,
      store: root.dir,
      review: review.body,
      named: !!reviewSourcesOf(review).named,
    };
  }

  /**
   * Picks what a task's review requests name (`pickMergeSource`), newest first in `texts`. A
   * first pass that finds nothing lists every commit the pick may ask about; git answers them off
   * the event loop, and the second pass picks from the answers. Each git answer may come after a
   * stop: `halted` ends the pick there, not after every probe.
   */
  async pickSource(
    repo: MergeRepo,
    texts: (string | ReviewText)[],
    halted: () => boolean,
  ): Promise<MergeSource | null | 'halted'> {
    const commits = new Set<string>();
    pickMergeSource(texts, {
      branch: () => false,
      commit: (sha) => {
        commits.add(sha);
        return false;
      },
    });
    const branches = await repo.branches();
    if (halted()) return 'halted';
    const found = new Set<string>();
    for (const sha of commits) {
      if (await repo.hasCommit(sha)) found.add(sha);
      if (halted()) return 'halted';
    }
    return pickMergeSource(texts, {
      branch: (name) => branches.has(name),
      commit: (sha) => found.has(sha),
    });
  }

  /**
   * Looks, before a merge, at the worktrees that hold the task's work: the one with the review's
   * branch checked out (the repo's own checkout too, when a run worked there) and the task's own
   * (`out/wt-<id>`). An approval covers what the review
   * describes, and a run that could not commit leaves part of that as files there (AO-0300).
   *
   * - Clean, or no such worktree: null, and the merge takes the commit the review names.
   * - Changes there, the run that asked for the approved review ended with swarmupd unable to commit
   *   what it left ({@link uncommittedRun}), and the worktree is on the commit to merge: swarmupd
   *   commits them on a branch of their own on top of it, and the merge takes that commit.
   *   When a file changed again during that commit (`kept`), the commit is not all of what the
   *   run left: `held` too, and nothing is merged. The worktree is read again after the commit,
   *   and after a commit that found nothing to commit: changes still there mean `held` as well.
   * - Any other changes: the task goes back to its author, who finds out whose they are (`held`).
   * - A run still works there: `again`, so the next tick looks once more.
   * - Git cannot list the worktrees, read one, or read the branch of an earlier attempt, or the
   *   folder of a listed worktree cannot be looked at (only one that is gone is skipped): it
   *   throws. An unread worktree is never taken for a clean one; {@link mergeOne} looks again.
   *
   * The commit leaves the worktree clean, and a merge can start again after it (the PC slept, a
   * check timed out, swarmupd restarted). So with nothing to commit, the branch of an earlier
   * attempt is looked up by its name and taken when it sits on the commit to merge.
   */
  async worktreeLeftovers(
    ref: string,
    job: MergeJob,
    source: string,
    repo: MergeRepo,
  ): Promise<{ commit: string; branch: string; what: string } | 'held' | 'again' | null> {
    const ws = this.sup.ws();
    const id = ws.resolve(ref).id;
    let list: WorktreeEntry[];
    try {
      list = parseWorktreeList(await repo.worktreeList());
    } catch (err) {
      if (err instanceof GitTimeout) throw err;
      throw new Error(`cannot list the worktrees of ${job.top}: ${gitError(err)}`);
    }
    const mine: WorktreeEntry[] = [];
    for (const w of list) {
      // The repo's own checkout counts too when it has the review's branch checked out: a run
      // without a task worktree (`task_worktrees: false`, an agent's own `cwd`) works there.
      // Only the base of this merge is left out: the base of another root is a branch like any
      // other here, and a review may name it.
      if (
        !(w.branch !== null && w.branch === job.src.branch && w.branch !== job.cfg.base) &&
        taskIdOfWorktree(job.top, w.path)?.toLowerCase() !== id.toLowerCase()
      ) {
        continue;
      }
      // Git also lists a worktree whose folder was deleted, and that one holds no files. A
      // folder swarmupd cannot look at (no access, a busy drive) is not a deleted one.
      let gone: boolean;
      try {
        gone = repo.worktreeGone(w.path);
      } catch (err) {
        throw new Error(`cannot read the worktree ${resolve(w.path)}: ${gitError(err)}`);
      }
      if (!gone) mine.push(w);
    }
    let taken: { commit: string; branch: string; what: string } | null = null;
    for (const w of mine) {
      const path = resolve(w.path);
      if (this.sup.runsIn(path)) {
        this.sup.emit('warn', `merge of ${ref}: waits for the run in ${path} to end`);
        return 'again';
      }
      const { changes } = await this.sup.checkout(path).stateAsync();
      // An unread worktree may hold part of the approved work: it never counts as a clean one.
      if (changes instanceof Error) {
        throw new Error(`cannot read the worktree ${path}: ${changes.message}`);
      }
      if (changes.length === 0) continue;
      const run = uncommittedRun(ws.showEvents(ref).events);
      let why =
        'no run-end of the run that asked for this review says that swarmupd could not commit them';
      let left = changes;
      if (run && taken) {
        why = 'swarmupd committed the changes of another worktree of the task already';
      } else if (run && w.head !== source) {
        why = `the worktree is on ${short(w.head)}, not on the commit to merge (${short(source)})`;
      } else if (run) {
        let c: Awaited<ReturnType<Checkout['commitLeftovers']>> | undefined;
        try {
          c = await this.sup
            .checkout(path)
            .commitLeftovers(
              leftoverBranch(runtimeOf(run.agent), `${run.id}-merge`, id),
              `${ws.view(ref).meta.title}\n\nChanges run ${run.id} (${run.agent}) left uncommitted in ${path}; committed before the merge.\n`,
              source,
            );
        } catch (err) {
          why = `swarmupd could not commit them: ${firstLines(err instanceof Error ? err.message : String(err))}`;
        }
        if (c !== undefined) {
          // Neither answer of the commit says that the worktree is clean now: null also comes
          // when its tree equals the commit to merge while git still reports changes (a staged
          // version of a file that was changed back, a change inside a submodule). So the
          // worktree is read again, and only a clean one lets the merge go on.
          const after = (await this.sup.checkout(path).stateAsync()).changes;
          if (after instanceof Error) {
            throw new Error(`cannot read the worktree ${path}: ${after.message}`);
          }
          // A kept file changed after the commit's snapshot, or has a staged version the commit
          // lacks: the commit is not all of what the run left, so it is never merged.
          if (c && (c.kept.length > 0 || after.length > 0)) {
            const { commit, branch } = c;
            const still = [...new Set([...c.kept, ...after])];
            const names = still.slice(0, 5).map((f) => `\`${f}\``);
            const rest = still.length > 5 ? ` and ${still.length - 5} more` : '';
            const how =
              c.kept.length > 0
                ? 'changed again or have a staged version the commit lacks'
                : 'still show as changed after the commit';
            this.sup.safe(() =>
              this.sup
                .ws(MERGE_ACTOR)
                .sendBack(
                  ref,
                  `swarmupd did not merge ${job.what}: while it committed what run ${run.id} left uncommitted in ${path}, ${still.length} file(s) there ${how} (${names.join(', ')}${rest}). ` +
                    `They stay in the worktree as they are; the other files the run left are in ${short(commit)} on branch \`${branch}\`, on top of ${short(source)}. ` +
                    'Put that commit and what belongs to the task of the files in the worktree on the task branch, then ask for review again. Delete nothing you did not make: ' +
                    "for changes that are not the task's, ask who made them (`swarmup ask`).",
                  job.author,
                ),
            );
            return 'held';
          }
          if (c) {
            taken = {
              commit: c.commit,
              branch: c.branch,
              what: `${short(c.commit)} on branch ${c.branch} (${job.what}, and the ${c.files.length} file(s) run ${run.id} left uncommitted in ${path})`,
            };
            this.mergeLine(
              ref,
              `committed ${c.files.length} file(s) run ${run.id} left in ${path} as ${short(c.commit)} on branch ${c.branch}`,
            );
            continue;
          }
          // Nothing to commit and nothing left: the changes went away in between.
          if (after.length === 0) continue;
          left = after;
          why =
            'swarmupd found nothing in them to commit: the files there equal the commit to merge ' +
            '(a staged version of a file that was changed back, or a change inside a submodule)';
        }
      }
      const shown = left.slice(0, 5).map((f) => `\`${f}\``);
      const more = left.length > 5 ? ` and ${left.length - 5} more` : '';
      this.sup.safe(() =>
        this.sup
          .ws(MERGE_ACTOR)
          .sendBack(
            ref,
            `swarmupd did not merge ${job.what}: the worktree ${path} has ${left.length} uncommitted change(s) (${shown.join(', ')}${more}) that the commit lacks, and ${why}. ` +
              'Commit what belongs to the task on the branch and ask for review again. Delete nothing you did not make: ' +
              "for changes that are not the task's, ask who made them (`swarmup ask`).",
            job.author,
          ),
      );
      return 'held';
    }
    if (taken) return taken;
    const run = uncommittedRun(ws.showEvents(ref).events);
    if (!run) return null;
    const branch = leftoverBranch(runtimeOf(run.agent), `${run.id}-merge`, id);
    const commit = await repo.branchOn(branch, source);
    if (!commit) return null;
    return {
      commit,
      branch,
      what: `${short(commit)} on branch ${branch} (${job.what}, and what run ${run.id} left uncommitted, committed by an earlier start of this merge)`,
    };
  }

  /**
   * Reads the task worktrees without ever turning an unread one into an empty one. A transient
   * failure makes this merge start again; after repeated failures {@link startMerge} tells the
   * human and leaves the approval waiting, as before AO-0330's second look at the no-merge path.
   */
  async checkedWorktreeLeftovers(
    ref: string,
    job: MergeJob,
    source: string,
    repo: MergeRepo,
  ): Promise<
    { commit: string; branch: string; what: string } | 'held' | 'again' | 'look-again' | null
  > {
    try {
      return await this.worktreeLeftovers(ref, job, source, repo);
    } catch (err) {
      const looks = (this.mergeLooks.get(ref) ?? 0) + 1;
      if (looks >= MERGE_LOOKS) {
        this.mergeLooks.delete(ref);
        if (err instanceof GitTimeout) throw err;
        const m = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${firstLines(m)} (${MERGE_LOOKS} times in a row). Nothing is merged: swarmupd cannot tell whether the task's worktree holds changes the commit lacks. Check that git works there`,
        );
      }
      this.mergeLooks.set(ref, looks);
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      this.sup.emit('warn', `merge of ${ref}: ${firstLines(msg)}; nothing merged, looks again`);
      return 'look-again';
    }
  }

  /**
   * Rebases the approved commit onto the base in swarmupd's worktree, runs the checks there, moves
   * the base forward, and builds it in its checkout. A conflict or a failed check sends the
   * task back to its author; nothing is ever forced. When the base moved in the meantime (a
   * task store sync, say), the rebase runs again, and the checks too unless only task store
   * files changed.
   */
  async mergeOne(ref: string, planned: MergeJob, runner: CommandRunner): Promise<void | 'again'> {
    let job = planned;
    const { cfg, top } = job;
    this.attemptStart(ref, job);
    let src = job.src;
    const repo = this.mergeRepoOf(job);
    let source = src.commit
      ? await repo.commit(src.commit)
      : src.branch
        ? ((await repo.commit(`refs/heads/${src.branch}`)) ?? (await repo.commit(src.branch)))
        : null;
    if (!source) {
      const store = src.commit ? await repo.storeWith(src.commit, job.store) : null;
      if (store) {
        this.mergeStoreOnly(ref, top, [src.commit!]);
        return;
      }
      const missing = src.commit ? `commit ${src.commit}` : `branch ${src.branch}`;
      this.mergeNote(
        ref,
        `swarmupd cannot merge ${job.what}: ${missing} is not in ${top}`,
        job.human,
      );
      return;
    }
    if (!(await repo.commit(`refs/heads/${cfg.base}`))) {
      this.mergeNote(
        ref,
        `swarmupd cannot merge ${job.what}: no branch ${cfg.base} in ${top}`,
        job.human,
      );
      return;
    }
    // What a run left uncommitted in the task's worktree is part of the approved work (AO-0300).
    // A look that fails says nothing about what is there, so the merge waits and looks again;
    // after MERGE_LOOKS failed looks in a row the human hears of it and nothing is merged.
    const left = await this.checkedWorktreeLeftovers(ref, job, source, repo);
    if (left === 'look-again') return 'again';
    if (left === 'held') {
      this.mergeLooks.delete(ref);
      return;
    }
    if (left === 'again') {
      this.mergeLooks.delete(ref);
      return 'again';
    }
    if (left) {
      source = left.commit;
      src = { commit: left.commit, branch: left.branch };
      job = { ...job, src, what: left.what };
      if (this.merging) this.merging.what = left.what;
    }
    const approved = source;
    const timeout = mergeTimeout(cfg);
    let checked: string | null = null;
    let checks: CommandResult[] = [];
    let skipped: string[] = [];
    let merged: { head: string; onto: string } | null = null;
    let refused = '';
    let waited = false;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS && !merged; attempt++) {
      if (attempt > 0) await sleep(MERGE_RETRY_MS);
      if (this.sup.stopping) return;
      const onto = (await repo.commit(`refs/heads/${cfg.base}`))!;
      this.mergeStep('rebase', `rebases onto ${cfg.base} (${short(onto)}) again`);
      await repo.ensureWorktree(onto);
      let r: { head: string } | { conflict: string } = await repo.rebase(approved, onto);
      if ('conflict' in r) {
        // A rebase replays every commit, so a branch that merged the base to resolve a conflict
        // hits it again; a merge commit compares only the two tips. History stays linear when
        // the rebase works.
        const m = await repo.mergeInto(approved, onto, `Merge ${job.what} into ${cfg.base}`);
        if ('conflict' in m) {
          this.mergeLooks.delete(ref);
          this.mergeConflictBack(ref, job.what, job.author, cfg.base, onto, m.files, m.conflict);
          return;
        }
        this.mergeStep('rebase', `merges into ${cfg.base} (${short(onto)}) with a merge commit`);
        r = m;
      }
      if (r.head === onto) {
        // The task worktree may have changed after the look at the start of this merge (a run's
        // wrap-up can finish while git prepares swarmupd's worktree). Look at it at the exact
        // point that would otherwise record "already in main": staged or unstaged files must be
        // committed under AO-0300's rules or send the task back, never be hidden by no_merge.
        const late = await this.checkedWorktreeLeftovers(ref, job, approved, repo);
        if (late === 'look-again') return 'again';
        if (late === 'held') {
          this.mergeLooks.delete(ref);
          return;
        }
        if (late === 'again') return 'again';
        this.mergeLooks.delete(ref);
        if (late) return 'again';
        // A named commit of a task store apart from the code is store-only work (AO-0377).
        const named = await this.unmergedNamed(repo, job, approved, onto);
        const inStore = new Set<string>();
        for (const sha of named) {
          const store = await repo.storeWith(sha, job.store);
          if (store) inStore.add(sha);
        }
        const lacks = named.filter((sha) => !inStore.has(sha));
        if (lacks.length > 0) {
          this.mergeLacks(ref, job, lacks, onto);
          return;
        }
        if (inStore.size > 0) {
          this.mergeStoreOnly(ref, top, inStore);
          return;
        }
        this.mergeRecord(
          { ref, base: cfg.base, branch: src.branch, commit: onto },
          `${job.what} is already in ${cfg.base}; nothing to merge.`,
        );
        if (src.branch) {
          const { branch } = src;
          this.sup.safe(() =>
            this.sup.branchMerged(ref, job.root, branch, approved, cfg.base, onto),
          );
        }
        return;
      }
      this.mergeLooks.delete(ref);
      // Task store files on a branch would overwrite the live store in the checkout.
      const store = await repo.storeFiles(onto, r.head);
      if (store.length > 0) {
        const more = store.length > 3 ? ` and ${store.length - 3} more` : '';
        this.mergeBack(
          ref,
          job.what,
          job.author,
          `it changes task store files (${store.slice(0, 3).join(', ')}${more}); take them out of the branch`,
          '',
        );
        return;
      }
      if (!checked || !(await repo.sameCode(checked, r.head))) {
        // The checks run in swarmupd's worktree: writing runs in the checkout go on meanwhile.
        if (this.merging) this.merging.holds = false;
        this.mergeStep('checks');
        // The checks timed out once: this time no new run starts beside them, and they get twice
        // the time (AO-0385). A machine busy with agents' own test runs is what usually slows them.
        const retry = this.mergeTimedOut.has(ref);
        if (retry) this.mergeQuiet = ref;
        // Only the checks whose paths the work changes run, both sides of a rename (AO-0382).
        const picked = checksFor(cfg.checks ?? [], await repo.touchedFiles(onto, r.head));
        skipped = picked.skipped;
        if (skipped.length > 0) {
          this.mergeLine(
            ref,
            `skips checks for paths it does not change: ${skipped.map((c) => `\`${c}\``).join(', ')}`,
          );
        }
        try {
          checks = await runner.runAll(
            picked.run,
            repo.worktree,
            retry ? timeout * 2 : timeout,
            (s) => this.mergeCommand('check', s),
            this.sup.electronEnv(this.sup.commandEnv(), repo.worktree, top),
          );
        } finally {
          if (retry && this.mergeQuiet === ref) this.mergeQuiet = null;
        }
        this.sup.shareElectron(repo.worktree);
        const failed = checks.find((c) => !c.ok);
        // Stopped with swarmupd: the next swarmupd merges it from the start.
        if (failed?.why === 'stopped') return;
        // The PC slept during the checks: the next tick merges it from the start (AO-0151).
        if (failed?.interrupted) {
          this.sup.emit(
            'warn',
            `merge of ${ref}: \`${failed.command}\` failed (${failed.why}) after the PC slept or swarmupd stopped responding; merging again`,
          );
          return 'again';
        }
        // A check that hangs may be the machine, not the code: merged again once (AO-0172). One
        // that printed a failed test before the timeout is the code, so it goes back (AO-0385).
        if (failed?.timedOut && !failed.failedTest && !this.mergeTimedOut.has(ref)) {
          this.mergeTimedOut.add(ref);
          this.sup.emit(
            'warn',
            `merge of ${ref}: \`${failed.command}\` ${failed.why}; swarmupd stopped it and merges once more`,
          );
          return 'again';
        }
        // Timed out again, with the machine to itself: a slow suite or a busy PC, which the author
        // cannot change, so the work stays approved and the human hears of it (AO-0385).
        if (failed?.timedOut && !failed.failedTest) {
          this.mergeTimeoutNote(ref, job, failed.command, failed.output, timeout * 2);
          return;
        }
        if (failed) {
          this.mergeBack(
            ref,
            job.what,
            job.author,
            `\`${failed.command}\` failed (${failed.why}${failed.failedTest ? ', after a failed test' : ''}) on it rebased onto ${cfg.base} (${short(onto)})`,
            failed.output,
          );
          return;
        }
        checked = r.head;
      }
      // Moving the base changes the checkout: from here until the build is over, it is held.
      const hold = await this.holdCheckout(ref, top);
      if (hold === 'stopped') return;
      if (hold === 'waited' && !waited) {
        // The base likely moved during the wait (task store syncs): rebase onto it again, without
        // counting the wait as a failed attempt. New writing runs wait now, so this happens once.
        waited = true;
        if ((await repo.commit(`refs/heads/${cfg.base}`)) !== onto) {
          attempt--;
          continue;
        }
      }
      // Recorded before the base moves, so no task store sync sees the merged commits unapproved.
      this.sup.approveCommits(top, cfg.base, await repo.patchKeys(onto, r.head));
      try {
        if ((await repo.fastForward(cfg.base, onto, r.head)) === 'done')
          merged = { head: r.head, onto };
        else refused = `${cfg.base} kept moving`;
      } catch (err) {
        // A hung git is not tried again while the checkout stays held (AO-0172).
        if (err instanceof GitTimeout) {
          err.stage = 'fast-forward';
          throw err;
        }
        // Local changes in the way, or a lock another git command holds: tried again shortly.
        refused = firstLines(err instanceof Error ? err.message : String(err));
      }
    }
    if (!merged) {
      const why = `${cfg.base} did not move: ${refused}`;
      this.mergeNote(ref, `swarmupd could not merge ${job.what}; ${why}`, job.human);
      return;
    }
    if (src.branch) {
      const { branch } = src;
      const { head } = merged;
      this.sup.safe(() => this.sup.branchMerged(ref, job.root, branch, approved, cfg.base, head));
    }
    // A code checkout with no task store (`swarmupd.code`) has no store sync to push its base, so the
    // merged commit is pushed here (AO-0252). A `merge.checkout` without `swarmupd.code` is left as
    // it was: nothing pushed its base before.
    if (
      this.sup.config.code[job.root] &&
      !this.sup.holdsStore(top) &&
      this.sup.config.push_branches[job.root] !== false
    ) {
      const head = merged.head;
      void this.sup.syncWork(() => this.sup.pushBase(ref, top, cfg.base, head));
    }
    const changed = await repo.changedFiles(merged.onto, merged.head);
    const files = changed.length;
    const installDirs = lockfileDirs(changed);
    const opsdCode = isEngineRepo(top) ? opsdCodeChanges(changed) : [];
    const passed =
      (checks.length > 0
        ? ` Checks passed: ${checks.map((c) => `\`${c.command}\``).join(', ')}.`
        : '') +
      (skipped.length > 0
        ? ` Not run, the work changes none of their paths: ${skipped.map((c) => `\`${c}\``).join(', ')}.`
        : '');
    // Saved before the build, so a swarmupd that stops during it leaves the build to the next one.
    const pending: PendingBuild = {
      ref,
      root: job.root,
      top,
      base: cfg.base,
      branch: src.branch,
      commit: merged.head,
      what: job.what,
      author: job.author,
      human: job.human,
      ...(opsdCode.length > 0 ? { opsdCode } : {}),
      ...(installDirs.length > 0 ? { install: installDirs } : {}),
      text: `Merged ${job.what} into ${cfg.base} as ${short(merged.head)}, rebased onto ${short(merged.onto)} (${files} file(s)).${passed}`,
    };
    this.savePendingBuild(pending);
    await this.buildMerged(pending, cfg, runner);
  }

  /**
   * Merges approved tasks of one root together (AO-0381). Each task's commit and what a run left
   * in its worktree are read as {@link mergeOne} reads them. A task that cannot go on now (a run
   * still works in its worktree, git cannot read it) stays for a later tick; one whose commit is
   * missing merges alone, which tells the human. The rest go to {@link mergeGroup}.
   *
   * Each task keeps its own retry state: one that got no terminal result is read again by the next
   * tick, while one that got a merge event, send-back or final note is marked seen now.
   */
  async mergeBatch(
    items: { ref: string; job: MergeJob }[],
    runner: CommandRunner,
  ): Promise<void | 'again'> {
    const lead = items[0]!.job;
    const repo = this.mergeRepoOf(lead);
    const ready: BatchItem[] = [];
    const alone: BatchItem[] = [];
    const retry = new Set(items.map((item) => item.ref));
    const terminal = (ref: string): void => {
      retry.delete(ref);
      this.sup.safe(() => {
        const last = this.sup.ws().view(ref).lastEvent;
        if (last && !this.sup.stopping) this.mergeSeen.set(ref, last);
      });
    };
    for (const { ref, job } of items) {
      if (this.sup.stopping) return 'again';
      const { src } = job;
      // A git that hangs on one task's commit or worktree is that task's: it leaves the batch
      // and merges alone, where a timeout ends the merge and tells the human about it.
      const timedOut = (err: unknown): boolean => {
        if (!(err instanceof GitTimeout)) return false;
        this.mergeLine(ref, `git timed out reading it; merges alone after the batch`);
        alone.push({ ref, planned: job, job, approved: '' });
        return true;
      };
      let source: string | null;
      try {
        source = src.commit
          ? await repo.commit(src.commit)
          : src.branch
            ? ((await repo.commit(`refs/heads/${src.branch}`)) ?? (await repo.commit(src.branch)))
            : null;
      } catch (err) {
        if (timedOut(err)) continue;
        throw err;
      }
      if (!source) {
        alone.push({ ref, planned: job, job, approved: '' });
        continue;
      }
      let left: Awaited<ReturnType<Merger['checkedWorktreeLeftovers']>>;
      try {
        left = await this.checkedWorktreeLeftovers(ref, job, source, repo);
      } catch (err) {
        if (timedOut(err)) continue;
        // What `startMerge` tells for a merge of this task alone; the others go on.
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        this.sup.emit('warn', `merge of ${ref}: ${msg}`);
        this.mergeNote(ref, `swarmupd could not merge ${job.what}: ${firstLines(msg)}`, job.human);
        terminal(ref);
        continue;
      }
      if (left === 'again' || left === 'look-again') continue;
      this.mergeLooks.delete(ref);
      if (left === 'held') {
        terminal(ref);
        continue;
      }
      if (!left) {
        ready.push({ ref, planned: job, job, approved: source });
        continue;
      }
      const taken = { ...job, src: { commit: left.commit, branch: left.branch }, what: left.what };
      ready.push({ ref, planned: job, job: taken, approved: left.commit });
    }
    if (!(await repo.commit(`refs/heads/${lead.cfg.base}`))) {
      // Each merge alone tells the human that the base is missing.
      alone.unshift(...ready.splice(0));
    }
    await this.mergeGroup(ready, repo, runner, terminal);
    for (const item of alone) await this.mergeAlone(item, runner, terminal);
    return retry.size > 0 ? 'again' : undefined;
  }

  /**
   * Merges `items` with one run of the checks on all of them rebased in turn (see
   * {@link mergeCandidate}). When the checks fail, the group splits in two halves, each merged
   * the same way, so only the task that breaks the checks goes back, merged alone as
   * {@link mergeOne} merges it. A task that does not rebase onto the ones before it, adds nothing
   * to them or changes task store files leaves the group and merges alone after it.
   */
  async mergeGroup(
    items: BatchItem[],
    repo: MergeRepo,
    runner: CommandRunner,
    terminal: (ref: string) => void,
  ): Promise<void> {
    if (this.sup.stopping || items.length === 0) return;
    if (items.length === 1) {
      await this.mergeAlone(items[0]!, runner, terminal);
      return;
    }
    const r = await this.mergeCandidate(items, repo, runner, terminal);
    if (r === 'done' || r === 'again') return;
    if (r === 'failed') {
      const half = Math.ceil(items.length / 2);
      const ids = (list: BatchItem[]): string => this.batchIds(list).join(', ');
      this.mergeLine(
        items[0]!.ref,
        `splits the batch: checks ${ids(items.slice(0, half))}, then ${ids(items.slice(half))}`,
      );
      await this.mergeGroup(items.slice(0, half), repo, runner, terminal);
      await this.mergeGroup(items.slice(half), repo, runner, terminal);
      return;
    }
    await this.mergeGroup(
      items.filter((i) => !r.includes(i)),
      repo,
      runner,
      terminal,
    );
    for (const item of r) await this.mergeAlone(item, runner, terminal);
  }

  /** Merges one task of a batch as a merge of it alone does (`mergeOne`). */
  async mergeAlone(
    item: BatchItem,
    runner: CommandRunner,
    terminal: (ref: string) => void,
  ): Promise<void> {
    if (this.sup.stopping) return;
    if (this.merging) {
      this.merging.ref = item.ref;
      this.merging.what = item.planned.what;
      this.mergeChanged();
    }
    const r = await this.mergeOne(item.ref, item.planned, runner);
    // The one more merge after a check timed out is for this merge only (AO-0172).
    if (r !== 'again') {
      this.mergeTimedOut.delete(item.ref);
      if (!this.sup.stopping) terminal(item.ref);
    }
  }

  /**
   * Rebases `items` in turn onto the base in swarmupd's worktree, runs the checks once on the
   * last commit, moves the base there and builds it. Each task gets its own merge event with the
   * commit that holds it; the last one carries the build's result. Returns the tasks that left
   * the group (see {@link mergeGroup}), `failed` when the checks failed on the group, else
   * `again` when stopping or the PC's sleep left every task retryable, or `done` after a merge or
   * a final note for every task.
   */
  async mergeCandidate(
    items: BatchItem[],
    repo: MergeRepo,
    runner: CommandRunner,
    terminal: (ref: string) => void,
  ): Promise<BatchItem[] | 'failed' | 'again' | 'done'> {
    const { cfg, top, root, human } = items[0]!.job;
    for (const item of items) this.attemptStart(item.ref, item.job);
    const lead = items[0]!.ref;
    const ids = this.batchIds(items);
    const named = ids.join(', ');
    if (this.merging) {
      this.merging.ref = lead;
      this.merging.what = `${items.length} approved tasks (${named})`;
      this.mergeChanged();
    }
    const timeout = mergeTimeout(cfg);
    let checked: string | null = null;
    let checks: CommandResult[] = [];
    let skipped: string[] = [];
    let refused = '';
    let waited = false;
    let merged: { onto: string; head: string; heads: string[] } | null = null;
    for (let attempt = 0; attempt < MERGE_ATTEMPTS && !merged; attempt++) {
      if (attempt > 0) await sleep(MERGE_RETRY_MS);
      if (this.sup.stopping) return 'again';
      const onto = await repo.commit(`refs/heads/${cfg.base}`);
      // Each merge alone tells the human that the base is gone.
      if (!onto) return items;
      this.mergeStep('rebase');
      this.mergeLine(lead, `rebases ${named} in turn onto ${cfg.base} (${short(onto)})`);
      await repo.ensureWorktree(onto);
      let head = onto;
      const heads: string[] = [];
      const out: BatchItem[] = [];
      for (const item of items) {
        let r: Awaited<ReturnType<MergeRepo['rebase']>>;
        let stored: string[] = [];
        try {
          r = await repo.rebase(item.approved, head);
          if (!('conflict' in r) && r.head !== head) stored = await repo.storeFiles(head, r.head);
        } catch (err) {
          if (!(err instanceof GitTimeout)) throw err;
          // A git that hangs on one task is that task's: it merges alone, where a timeout ends
          // the merge and tells the human. The rest rebase again from a clean worktree.
          out.push(item);
          this.mergeLine(item.ref, `git timed out rebasing it; merges alone after the batch`);
          break;
        }
        let why = '';
        if ('conflict' in r) why = 'does not rebase onto the tasks before it in the batch';
        else if (r.head === head) why = 'adds nothing to the base and the tasks before it';
        else if (stored.length > 0) why = 'changes task store files';
        if (why || 'conflict' in r) {
          out.push(item);
          this.mergeLine(item.ref, `${why}; merges alone after the batch`);
          continue;
        }
        head = r.head;
        heads.push(head);
      }
      if (out.length > 0) return out;
      if (!checked || !(await repo.sameCode(checked, head))) {
        // The checks run in swarmupd's worktree: writing runs in the checkout go on meanwhile.
        if (this.merging) this.merging.holds = false;
        this.mergeStep('checks');
        this.mergeLine(
          lead,
          `checks the batch of ${items.length} (${named}) once, as ${short(head)}`,
        );
        // Only the checks whose paths a task of the batch changes run, both sides of a rename
        // (AO-0382).
        const picked = checksFor(cfg.checks ?? [], await repo.touchedFiles(onto, head));
        skipped = picked.skipped;
        if (skipped.length > 0) {
          this.mergeLine(
            lead,
            `skips checks for paths the batch does not change: ${skipped.map((c) => `\`${c}\``).join(', ')}`,
          );
        }
        checks = await runner.runAll(
          picked.run,
          repo.worktree,
          timeout,
          (s) => this.mergeCommand('check', s),
          this.sup.electronEnv(this.sup.commandEnv(), repo.worktree, top),
        );
        this.sup.shareElectron(repo.worktree);
        const failed = checks.find((c) => !c.ok);
        if (failed?.why === 'stopped') return 'again';
        if (failed?.interrupted) {
          this.sup.emit(
            'warn',
            `merge of ${named}: \`${failed.command}\` failed (${failed.why}) after the PC slept or swarmupd stopped responding; merging again`,
          );
          return 'again';
        }
        if (failed) {
          // A timeout too: the halves run again, and a task alone keeps its one retry (AO-0172).
          this.mergeLine(
            lead,
            `\`${failed.command}\` failed (${failed.why}) on the batch (${named})`,
          );
          return 'failed';
        }
        checked = head;
      }
      const hold = await this.holdCheckout(lead, top);
      if (hold === 'stopped') return 'again';
      if (hold === 'waited' && !waited) {
        waited = true;
        if ((await repo.commit(`refs/heads/${cfg.base}`)) !== onto) {
          attempt--;
          continue;
        }
      }
      // Recorded before the base moves, so no task store sync sees the merged commits unapproved.
      this.sup.approveCommits(top, cfg.base, await repo.patchKeys(onto, head));
      try {
        if ((await repo.fastForward(cfg.base, onto, head)) === 'done') {
          merged = { onto, head, heads };
        } else refused = `${cfg.base} kept moving`;
      } catch (err) {
        if (err instanceof GitTimeout) {
          err.stage = 'fast-forward';
          throw err;
        }
        refused = firstLines(err instanceof Error ? err.message : String(err));
      }
    }
    if (!merged) {
      for (const item of items) {
        this.mergeNote(
          item.ref,
          `swarmupd could not merge ${item.job.what} in a batch with ${ids.length - 1} other task(s); ${cfg.base} did not move: ${refused}`,
          human,
        );
        terminal(item.ref);
      }
      return 'done';
    }
    const { onto, head, heads } = merged;
    this.mergeLine(
      lead,
      `moved ${cfg.base} to ${short(head)} with ${named} after one run of the checks`,
    );
    for (const [n, item] of items.entries()) {
      this.mergeLooks.delete(item.ref);
      this.mergeTimedOut.delete(item.ref);
      const { branch } = item.job.src;
      if (branch) {
        const at = heads[n]!;
        this.sup.safe(() =>
          this.sup.branchMerged(item.ref, root, branch, item.approved, cfg.base, at),
        );
      }
    }
    const last = items.at(-1)!;
    // As in `mergeOne`: a code checkout with no task store pushes its base here (AO-0252).
    if (
      this.sup.config.code[root] &&
      !this.sup.holdsStore(top) &&
      this.sup.config.push_branches[root] !== false
    ) {
      void this.sup.syncWork(() => this.sup.pushBase(last.ref, top, cfg.base, head));
    }
    const changed = await repo.changedFiles(onto, head);
    const installDirs = lockfileDirs(changed);
    const opsdCode = isEngineRepo(top) ? opsdCodeChanges(changed) : [];
    const passed =
      (checks.length > 0
        ? ` Checks passed once for the batch: ${checks.map((c) => `\`${c.command}\``).join(', ')}.`
        : '') +
      (skipped.length > 0
        ? ` Not run, the batch changes none of their paths: ${skipped.map((c) => `\`${c}\``).join(', ')}.`
        : '');
    const lastId = ids.at(-1)!;
    const others = (n: number): string => ids.filter((_, i) => i !== n).join(', ');
    const batch = `${cfg.base} moved from ${short(onto)} to ${short(head)} (${changed.length} file(s))`;
    for (const [n, item] of items.slice(0, -1).entries()) {
      this.mergeRecord(
        { ref: item.ref, base: cfg.base, branch: item.job.src.branch, commit: heads[n]! },
        `Merged ${item.job.what} into ${cfg.base} as ${short(heads[n]!)}, in one batch with ${others(n)}: ${batch}.${passed} The build's result is on the merge event of ${lastId}.`,
      );
      terminal(item.ref);
    }
    const pending: PendingBuild = {
      ref: last.ref,
      root,
      top,
      base: cfg.base,
      branch: last.job.src.branch,
      commit: head,
      what: last.job.what,
      author: last.job.author,
      human: last.job.human,
      ...(opsdCode.length > 0 ? { opsdCode } : {}),
      ...(installDirs.length > 0 ? { install: installDirs } : {}),
      text: `Merged ${last.job.what} into ${cfg.base} as ${short(head)}, in one batch with ${others(items.length - 1)}: ${batch}.${passed}`,
    };
    this.savePendingBuild(pending);
    await this.buildMerged(pending, cfg, runner);
    if (!this.sup.stopping) terminal(last.ref);
    return 'done';
  }

  /** The task ids of `items`, for lines and events. */
  batchIds(items: BatchItem[]): string[] {
    const ws = this.sup.ws();
    return items.map((i) => ws.resolve(i.ref).id);
  }

  /** The repo of a merge, with swarmupd's worktree for its rebases and checks. */
  mergeRepoOf(job: MergeJob): MergeRepo {
    return new MergeRepo(
      job.top,
      join(this.sup.store.dir, 'merge', job.root.replace(/[^A-Za-z0-9._-]/g, '-')),
      this.sup.ws().roots.map((r) => r.dir),
      this.sup.commandEnv(),
      this.sup.mergeGitTimeoutMs,
    );
  }

  /**
   * Runs the build of a base swarmupd moved forward, in its checkout, and records the merge with the
   * build's result. A failed build sends the task back. A build stopped with swarmupd stays pending:
   * the merge is recorded now, and the next swarmupd runs the build again and comments on the result.
   */
  async buildMerged(p: PendingBuild, cfg: MergeConfig, runner: CommandRunner): Promise<void> {
    const timeout = mergeTimeout(cfg);
    this.mergeStep('build', `moved ${p.base} to ${short(p.commit)}; builds it in ${p.top}`);
    // The checks installed new dependencies in swarmupd's worktree only; the checkout gets them here.
    const steps = cfg.build ?? [];
    const dirs = p.install === true ? ['.'] : (p.install ?? []);
    const install = steps.length > 0 ? installSteps(cfg.install, p.top, dirs) : [];
    // The installs run without an inherited `NODE_ENV` or dependency-type setting, which would
    // make the next plain install in the checkout purge `node_modules` (AO-0391).
    let build = await runner.runAll(
      [...install, ...steps],
      p.top,
      timeout,
      (s) => this.mergeCommand('build', s),
      undefined,
      install.length,
    );
    let installs = install.length;
    // An install step with nothing to do leaves no result (AO-0229), so a result's place in the
    // list it came from, not in `build`, tells an install from a build step.
    const isInstall = (c: CommandResult): boolean => (c.entry ?? build.indexOf(c)) < installs;
    let broke = build.find((c) => !c.ok);
    // A build step that fails in a checkout swarmupd did not install in may only miss its
    // dependencies: `node_modules` gone, behind a lockfile another commit changed, or in the
    // middle of someone's install. The checks passed on this code, so the checkout gets one
    // install and the build one more try before anyone hears of it (AO-0232).
    let first: CommandResult | null = null;
    const again = dirs.includes('.') ? [] : installSteps(cfg.install, p.top, ['.']);
    if (
      broke &&
      !isInstall(broke) &&
      broke.why !== 'stopped' &&
      !broke.interrupted &&
      again.length > 0
    ) {
      first = broke;
      this.sup.emit(
        'warn',
        `merge of ${p.ref}: build \`${broke.command}\` failed (${broke.why}) in ${p.top}; swarmupd installs the dependencies there and builds once more`,
      );
      build = await runner.runAll(
        [...again, ...steps],
        p.top,
        timeout,
        (s) => this.mergeCommand('build', s),
        undefined,
        again.length,
      );
      installs = again.length;
      broke = build.find((c) => !c.ok);
    }
    // Stopped with swarmupd, or broken by the PC's sleep: the build stays pending, and the next swarmupd,
    // or for a sleep the next tick, runs it again.
    if (broke?.why === 'stopped' || broke?.interrupted) {
      const why =
        broke.why === 'stopped'
          ? 'was stopped with swarmupd; the next swarmupd runs the build again'
          : `failed (${broke.why}) after the PC slept or swarmupd stopped responding; swarmupd runs the build again`;
      if (p.text !== null) {
        this.mergeRecord(p, `${p.text} Build: \`${broke.command}\` ${why}.`);
        this.savePendingBuild({ ...p, text: null });
      } else if (broke.interrupted) {
        this.sup.emit('warn', `merge of ${p.ref}: build \`${broke.command}\` ${why}`);
      }
      return;
    }
    const commands = build.map((c) => `\`${c.command}\``).join(', ');
    if (p.text !== null) {
      const built =
        build.length === 0
          ? ''
          : broke
            ? ` Build: \`${broke.command}\` failed (${broke.why}).`
            : first
              ? ` Built with ${commands}, after \`${first.command}\` failed (${first.why}) before the install.`
              : ` Built with ${commands}.`;
      this.mergeRecord(p, `${p.text}${built}`);
    } else if (!broke && build.length > 0) {
      this.mergeNote(
        p.ref,
        `Built ${p.base} with ${commands} after the earlier build did not finish (${short(p.commit)}).`,
      );
    }
    this.dropPendingBuild(p.ref);
    // Once per merge: a build stopped with swarmupd returned above, and the next swarmupd tells.
    this.tellNotLive(p, build.length > 0 && !broke);
    if (!broke) return;
    // A failed install says nothing about the merged code: the human hears of it, and the task
    // stays closed (AO-0232).
    if (isInstall(broke)) {
      this.mergeEnvFailure(p, broke);
      return;
    }
    const retried = first ? ', also after swarmupd installed the dependencies there' : '';
    this.mergeBack(
      p.ref,
      p.what,
      p.author,
      `${p.base} has it as ${short(p.commit)}, but \`${broke.command}\` failed (${broke.why}) in ${p.top}${retried}; fix it in a new commit`,
      broke.output,
    );
  }

  /**
   * Tells the human that the checkout of a merged base could not get its dependencies, so its
   * build did not run. The merge stands and the task keeps its state: the author has nothing to
   * fix. The output goes to a log file, without lines that look like secrets.
   */
  mergeEnvFailure(p: PendingBuild, broke: CommandResult): void {
    this.sup.safe(() => {
      const ws = this.sup.ws(MERGE_ACTOR);
      const human = this.sup.user.me ?? p.human ?? ws.roots[0]?.config.human;
      const safe = redactSecrets(broke.output);
      const log = this.mergeLog(p.ref, safe);
      const out = lastLines(safe);
      const head =
        `${ws.resolve(p.ref).id}: swarmupd merged ${p.what} into \`${p.base}\` as ${short(p.commit)}, ` +
        `but could not install the dependencies in \`${p.top}\`: \`${broke.command}\` failed ` +
        `(${broke.why}), so the build there did not run. This is the checkout, not the merged ` +
        'code: the task stays as it is.';
      const tail =
        `Action: once no other install runs in \`${p.top}\`, install the dependencies and run ` +
        `the build there.${log ? ` Full output: ${log}` : ''}`;
      const fence = '```';
      ws.comment(
        p.ref,
        out ? `${head}\n\n${fence}\n${out}\n${fence}\n\n${tail}` : `${head} ${tail}`,
        human,
      );
    });
  }

  /** Builds an earlier swarmupd left pending, by task. */
  pendingBuilds(): Record<string, PendingBuild> {
    return this.sup.store.readJson<Record<string, PendingBuild>>('merge-builds.json', {});
  }

  savePendingBuild(p: PendingBuild): void {
    this.sup.store.writeJson('merge-builds.json', { ...this.pendingBuilds(), [p.ref]: p });
  }

  dropPendingBuild(ref: string): void {
    const all = this.pendingBuilds();
    if (!(ref in all)) return;
    delete all[ref];
    this.sup.store.writeJson('merge-builds.json', all);
  }

  /**
   * The commits the approved review request mentions that the base lacks, when the merge took
   * something else than that request's own `<commit> on branch <name>`: a branch the request
   * names loosely, or what an earlier request names. Such a source can be an empty branch while
   * the approved commit never reached the repo (AO-0325, after AO-0290: its commit sat in a
   * bundle, and the earlier request's branch pointed at the base). A commit counts as in the
   * base when it is an ancestor of it, or of the source, whose changes the rebase found there.
   */
  async unmergedNamed(
    repo: MergeRepo,
    job: MergeJob,
    source: string,
    onto: string,
  ): Promise<string[]> {
    if (job.named) return [];
    const lacks: string[] = [];
    for (const sha of reviewCommits(job.review)) {
      const commit = await repo.commit(sha);
      const there =
        !!commit &&
        ((await repo.isAncestor(commit, onto)) || (await repo.isAncestor(commit, source)));
      if (!there) lacks.push(sha);
    }
    return lacks;
  }

  /**
   * Files a finding, linked from the task, that its approved work is not in the base. No merge
   * event: the task keeps waiting for its merge, and so do the tasks blocked on it (AO-0325).
   */
  mergeLacks(ref: string, job: MergeJob, lacks: string[], onto: string): void {
    const { base } = job.cfg;
    const ws = this.sup.ws(MERGE_ACTOR);
    const id = ws.resolve(ref).id;
    const names = lacks.map((c) => `\`${c}\``).join(', ');
    const title = `${id} is approved, but its work is not in ${base}: swarmupd found nothing to merge`;
    const body = [
      `swarmupd merged nothing for ${id}. Its approved review request names ${names}, and ` +
        `${base} (${short(onto)}) does not have ${lacks.length === 1 ? 'it' : 'them'}. That ` +
        `request has no \`<commit> on branch <name>\`, so swarmupd took ${job.what} from a looser ` +
        `or earlier mention, and that is already in ${base}.`,
      `${id} stays approved and waits for its merge; the tasks blocked on it stay blocked.`,
      `Triage: get the named commit into \`${job.top}\` (fetch its branch or bundle), then reopen ` +
        `${id} with a review request that says \`<commit> on branch <name>\`. If the work is in ` +
        `${base} after all, free each blocked task with \`swarmup unblock\`.`,
    ].join('\n\n');
    try {
      ws.finding({ title, body, owner: this.sup.pmFor(ws), priority: 'p1', task: ref });
    } catch (err) {
      // The note alone keeps the merge from being taken for done.
      this.sup.emit('warn', `merge of ${ref}: cannot file a finding: ${String(err)}`);
      this.mergeNote(ref, `${title}.\n\n${body}`, job.human);
    }
  }

  /** The merge event, with the commit the base moved to. */
  /** Records in `state.db` that a merge of `ref` starts, unless one is open already. */
  attemptStart(ref: string, job: MergeJob): void {
    if (!this.sup.state || this.attempts.has(ref)) return;
    this.sup.safe(() => {
      const id = this.sup.state!.mergeStarted({
        ref,
        root: job.root,
        what: job.what,
        commit: job.src.commit,
        branch: job.src.branch,
        at: new Date(this.sup.now()).toISOString(),
      });
      this.attempts.set(ref, id);
    });
  }

  /**
   * Records how the open merge attempt of `ref` ended; the first outcome wins. An outcome with no
   * open attempt, such as a note from planning, gets an attempt of its own.
   */
  attemptEnd(ref: string, outcome: MergeOutcome, reason?: string, head?: string): void {
    if (!this.sup.state) return;
    this.sup.safe(() => {
      const at = new Date(this.sup.now()).toISOString();
      let id = this.attempts.get(ref);
      if (id === undefined) {
        id = this.sup.state!.mergeStarted({ ref, root: ref.split('/')[0]!, what: '', at });
      }
      this.sup.state!.mergeEnded(id, outcome, at, reason, head);
      this.attempts.delete(ref);
    });
  }

  /** The merge attempts of `ref`, or of every task, newest first. */
  mergeAttempts(ref?: string, limit?: number): MergeAttempt[] {
    return this.sup.state?.mergeAttempts(ref, limit) ?? [];
  }

  /** How many merge attempts since `since` ended in each outcome. */
  mergeCounts(since?: string): MergeCount[] {
    return this.sup.state?.mergeCounts(since) ?? [];
  }

  mergeRecord(
    p: { ref: string; base: string; branch?: string; commit: string },
    text: string,
  ): void {
    const nothing = /nothing to merge/.test(text);
    this.attemptEnd(p.ref, nothing ? 'nothing' : 'merged', firstLines(text), p.commit);
    this.sup
      .ws(MERGE_ACTOR)
      .recordMerge(p.ref, { commit: p.commit, into: p.base, branch: p.branch }, text);
  }

  /**
   * Sends the task back to its author with what failed and the end of its output. Lines that look
   * like secrets are taken out of the output before it is kept anywhere, log file included.
   */
  /**
   * Sends approved work back whose merge conflicts with the base. The author merges the base into
   * the branch instead of rebasing, so the approved commits stay as they are; wake starts that run
   * ahead of other work and past the project's run limit, and the review that follows covers only
   * the merge commit's resolution (see {@link MERGE_CONFLICT}).
   */
  mergeConflictBack(
    ref: string,
    what: string,
    author: string,
    base: string,
    onto: string,
    files: string[],
    output: string,
  ): void {
    this.attemptEnd(ref, 'conflict', files.join(', ') || firstLines(output));
    const safe = redactSecrets(output);
    const log = this.mergeLog(ref, safe);
    const where = files.length > 0 ? ` in ${files.map((f) => `\`${f}\``).join(', ')}` : '';
    const text = [
      `swarmupd did not merge ${what}: ${MERGE_CONFLICT} ${base} (${short(onto)})${where}.`,
      '',
      `- Merge \`${base}\` into the branch in the task's worktree: \`git merge ${base}\`. Don't rebase: the approved commits stay as they are.`,
      '- Resolve each conflict so both changes still work, run the tests of the files you touched, and commit the merge.',
      '- Ask for review again with `swarmup review`, naming the merge commit and the branch. The review covers only how you resolved the conflicts.',
      ...(log ? ['', `Full output: ${log}`] : []),
    ].join('\n');
    this.sup.ws(MERGE_ACTOR).sendBack(ref, text, author);
  }

  mergeBack(ref: string, what: string, author: string, why: string, output: string): void {
    this.attemptEnd(ref, /^`[^`]+` failed \(/.test(why) ? 'check-failed' : 'sent-back', why);
    const safe = redactSecrets(output);
    const log = this.mergeLog(ref, safe);
    const head = `swarmupd did not merge ${what}: ${why}.`;
    const tail = `Fix it on the branch and ask for review again.${log ? ` Full output: ${log}` : ''}`;
    const out = lastLines(safe);
    this.sup
      .ws(MERGE_ACTOR)
      .sendBack(
        ref,
        out ? `${head}\n\n\`\`\`\n${out}\n\`\`\`\n\n${tail}` : `${head} ${tail}`,
        author,
      );
  }

  /**
   * Tells the human once, after a merge into the engine repo changed swarmupd's own code, that this
   * swarmupd does not run it yet and what makes it live: a restart when swarmupd runs from the checkout
   * that was just built, a build first when it was not, or a new build of the app when swarmupd runs
   * the installed app (AO-0156).
   */
  tellNotLive(p: PendingBuild, built: boolean): void {
    if (!p.opsdCode?.length) return;
    this.sup.safe(() => {
      const ws = this.sup.ws(MERGE_ACTOR);
      const human = this.sup.user.me ?? p.human ?? ws.roots[0]?.config.human;
      if (!human) return;
      const self = this.sup.self;
      const runs = !self ? 'unknown' : insideDir(p.top, self.dir) ? 'checkout' : 'installed';
      let fresh = false;
      if (runs === 'checkout' && built) {
        try {
          fresh = self!.stamp() !== this.sup.build;
        } catch {
          // Unreadable: the notice says to build first, which is never wrong.
        }
      }
      const text = notLiveNotice({
        task: ws.resolve(p.ref).id,
        what: p.what,
        base: p.base,
        commit: p.commit,
        files: p.opsdCode!,
        top: p.top,
        runs,
        built: fresh,
        pid: process.pid,
        version: this.sup.version,
      });
      ws.post(DIRTY_CHANNEL, text, { to: [human], task: p.ref });
    });
  }

  /**
   * A comment from swarmupd on a merge it did not do, for a person. The work is still not in the
   * base, so the tasks blocked on `ref` keep waiting (AO-0228).
   */
  /**
   * Tells the human that a merge check timed out twice, the second time with no new run beside it
   * and twice the time. The work is not sent back: the author cannot make the machine faster.
   */
  mergeTimeoutNote(
    ref: string,
    job: MergeJob,
    command: string,
    output: string,
    limitMs: number,
  ): void {
    this.attemptEnd(ref, 'timeout', `\`${command}\` timed out twice`);
    const log = this.mergeLog(ref, redactSecrets(output));
    const text = [
      `swarmupd did not merge ${job.what}: \`${command}\` timed out twice, the second time after ${formatMinutes(Math.round(limitMs / 60_000))} with no new run beside it.`,
      '',
      "The work stays approved and was not sent back: a slow suite or a busy PC is not the author's to fix.",
      `- To merge it, raise \`swarmupd.merge.${job.root}.timeout_minutes\` in the config, or make the checks faster, then comment on this task: swarmupd tries again when the task changes.`,
      ...(log ? ['', `Full output: ${log}`] : []),
    ].join('\n');
    this.mergeNote(ref, text, job.human);
  }

  mergeNote(ref: string, text: string, to?: string): void {
    this.attemptEnd(ref, 'note', firstLines(text));
    this.sup.safe(() => this.sup.ws(MERGE_ACTOR).comment(ref, text, to));
  }

  /**
   * Records that the approved work is task store commits, so there is no code merge: `swarmup
   * sync` shares them. Tasks blocked on `ref` go on (AO-0377).
   */
  private mergeStoreOnly(ref: string, top: string, commits: Iterable<string>): void {
    const names = [...commits].map((c) => `\`${c}\``);
    const one = names.length === 1;
    this.mergeNothing(
      ref,
      `Nothing to merge into \`${top}\`: the approved work ${names.join(', ')} ` +
        `${one ? 'is a commit' : 'are commits'} of the task store for this task, which \`swarmup sync\` shares.`,
    );
  }

  /** A comment from swarmupd that it has nothing to merge for `ref`; tasks blocked on it go on. */
  mergeNothing(ref: string, text: string): void {
    this.attemptEnd(ref, 'nothing', firstLines(text));
    this.sup.safe(() => this.sup.ws(MERGE_ACTOR).noMerge(ref, text));
  }

  /** Keeps a merge's whole output, already without secrets, in swarmupd's state folder; returns the file, or null. */
  mergeLog(ref: string, output: string): string | null {
    if (!output) return null;
    try {
      const dir = join(this.sup.store.dir, 'merge', 'logs');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${ref.replace(/[^A-Za-z0-9._-]/g, '-')}-${ulid(this.sup.now())}.log`);
      writeFileSync(file, output);
      return file;
    } catch {
      return null;
    }
  }
}
