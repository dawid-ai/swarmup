import { isKeyFile, redactSecrets, secretKind } from '@swarmup/core';
import { gitAsync } from './git.js';

/** What one round of pushing task branches looks at and skips. */
export interface BranchPushOptions {
  /** Branch name prefixes of task branches, such as `claude/`; each ends with a slash. */
  prefixes: string[];
  /**
   * Branches work goes into, such as `v2`. They are never pushed here, and a task branch with
   * nothing beyond them is not either.
   */
  bases: string[];
  /** Per branch, the approved commit swarmupd merged; a tip at or behind it has nothing new. */
  merged: Record<string, string>;
  /** Per branch, the `<tip> <remote tip>` an earlier round decided to leave alone. */
  seen: Record<string, string>;
}

export interface BranchPushRound {
  /** The remote branches go to; null when the repo has none. */
  remote: string | null;
  pushed: { branch: string; tip: string }[];
  /** Branches left alone for a reason a person may want to know, such as a diverged remote. */
  held: { branch: string; why: string }[];
  /** `seen` for the next round: what this round left alone and why it need not look again. */
  seen: Record<string, string>;
  /** Why the round stopped early, such as an unreachable remote. */
  error?: string;
}

/** Pushes rejected because the remote moved; anything else (network, sign-in) ends the round. */
const REJECTED = /rejected|non-fast-forward|fetch first|stale info|\[remote rejected\]/i;

/**
 * Pushes task branches with new commits to the repo's remote, so work that is not merged yet is
 * not only on this machine. Never forces, never pushes a base branch, and deletes a remote branch
 * only while it still holds what was approved.
 */
export class BranchPusher {
  /**
   * @param top The repo's checkout.
   * @param env The environment git runs with: swarmupd's own, with the machine's git sign-in.
   * @param timeoutMs How long one git command may take before it counts as failed.
   */
  constructor(
    readonly top: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly timeoutMs = 120_000,
  ) {}

  /** The remote of the checked-out branch, else `origin`, else the only remote; null without one. */
  async remote(): Promise<string | null> {
    const remotes = lines(await this.git(['remote'], { allowFail: true }));
    if (remotes.length === 0) return null;
    const head = (
      await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })
    ).trim();
    if (head) {
      const r = (
        await this.git(['config', '--get', `branch.${head}.remote`], { allowFail: true })
      ).trim();
      if (r && remotes.includes(r)) return r;
    }
    if (remotes.includes('origin')) return 'origin';
    return remotes.length === 1 ? remotes[0]! : null;
  }

  /** The branch checked out in the checkout, or null on a detached HEAD. */
  async headBranch(): Promise<string | null> {
    return (
      (await this.git(['symbolic-ref', '-q', '--short', 'HEAD'], { allowFail: true })).trim() ||
      null
    );
  }

  /**
   * Pushes each task branch whose tip has commits that neither the bases nor its remote branch
   * hold, when the remote branch is missing or behind it. A branch whose remote branch has
   * commits this clone lacks, or whose new commits add something that looks like a secret, is
   * held back and named in the result.
   */
  async pushNew(opts: BranchPushOptions): Promise<BranchPushRound> {
    const round: BranchPushRound = { remote: await this.remote(), pushed: [], held: [], seen: {} };
    const remote = round.remote;
    if (!remote) return round;
    const heads = await this.tips(opts.prefixes.map((p) => `refs/heads/${p.replace(/\/+$/, '')}`));
    if (heads.size === 0) return round;
    const tracking = await this.tips([`refs/remotes/${remote}`]);
    const bases = await this.baseCommits(remote, opts.bases, tracking);
    for (const [ref, tip] of heads) {
      const branch = ref.slice('refs/heads/'.length);
      if (opts.bases.includes(branch)) continue;
      const approved = opts.merged[branch];
      if (approved && (approved === tip || (await this.isAncestor(tip, approved)))) continue;
      const theirs = tracking.get(`refs/remotes/${remote}/${branch}`);
      if (theirs === tip) continue;
      const key = `${tip} ${theirs ?? '-'}`;
      if (opts.seen[branch] === key) {
        round.seen[branch] = key;
        continue;
      }
      const leave = (why?: string): void => {
        round.seen[branch] = key;
        if (why) round.held.push({ branch, why });
      };
      if (theirs && !(await this.isAncestor(theirs, tip))) {
        // The remote is ahead (pushed from another clone): nothing to push.
        if (await this.isAncestor(tip, theirs)) leave();
        else
          leave(`${remote}/${branch} has commits this clone lacks; swarmupd never forces a push`);
        continue;
      }
      const not = theirs ? [...bases, theirs] : bases;
      if (!(await this.hasNewWork(tip, not, bases))) {
        leave();
        continue;
      }
      const leak = await this.leak(tip, not);
      if (leak) {
        leave(`a commit on it adds ${leak}; not pushed`);
        continue;
      }
      try {
        await this.git(['push', '-q', remote, `refs/heads/${branch}:refs/heads/${branch}`]);
        round.pushed.push({ branch, tip });
      } catch (err) {
        const msg = gitError(err);
        if (!REJECTED.test(msg)) {
          round.error = `push of ${branch} to ${remote} failed: ${msg}`;
          // The rest waits for the next round; nothing was decided about them.
          for (const [b, k] of Object.entries(opts.seen)) round.seen[b] ??= k;
          return round;
        }
        leave(`${remote} refused it (${msg}); swarmupd never forces a push`);
      }
    }
    return round;
  }

  /** The commit `branch` points at on `remote`, asked of the remote itself; null when it is gone. */
  async remoteTip(remote: string, branch: string): Promise<string | null> {
    const out = (await this.git(['ls-remote', remote, `refs/heads/${branch}`])).trim();
    const line = lines(out).find((l) => l.endsWith(`\trefs/heads/${branch}`));
    return line ? line.split('\t')[0]! : null;
  }

  /**
   * Deletes `branch` on `remote` when it holds nothing beyond `approved`. The delete carries a
   * lease on the tip it checked, so a push that lands in between keeps the branch.
   */
  async deleteRemote(
    remote: string,
    branch: string,
    approved: string,
  ): Promise<'deleted' | 'absent' | string> {
    const theirs = await this.remoteTip(remote, branch);
    if (!theirs) return 'absent';
    if (theirs !== approved && !(await this.isAncestor(theirs, approved))) {
      return `kept ${remote}/${branch}: it has commits the approval did not cover`;
    }
    await this.git([
      'push',
      '-q',
      `--force-with-lease=refs/heads/${branch}:${theirs}`,
      remote,
      `:refs/heads/${branch}`,
    ]);
    return 'deleted';
  }

  /** Whether commit `a` is `b` or an ancestor of it; false when either is unknown. */
  async isAncestor(a: string, b: string): Promise<boolean> {
    try {
      await this.git(['merge-base', '--is-ancestor', a, b]);
      return true;
    } catch {
      return false;
    }
  }

  /** Refs under the patterns, such as `refs/heads`, with their commits; one git call. */
  async tips(patterns: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const raw = await this.git(['for-each-ref', '--format=%(refname) %(objectname)', ...patterns]);
    for (const l of lines(raw)) {
      const at = l.lastIndexOf(' ');
      out.set(l.slice(0, at), l.slice(at + 1));
    }
    return out;
  }

  /** The commits of the bases, here and on the remote, and the remote's default branch. */
  private async baseCommits(
    remote: string,
    bases: string[],
    tracking: Map<string, string>,
  ): Promise<string[]> {
    const out = new Set<string>();
    for (const b of bases) {
      const local = (
        await this.git(['rev-parse', '-q', '--verify', `refs/heads/${b}^{commit}`], {
          allowFail: true,
        })
      ).trim();
      if (local) out.add(local);
      const theirs = tracking.get(`refs/remotes/${remote}/${b}`);
      if (theirs) out.add(theirs);
    }
    const def = (
      await this.git(['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`], {
        allowFail: true,
      })
    ).trim();
    const defTip = def ? tracking.get(def) : undefined;
    if (defTip) out.add(defTip);
    return [...out];
  }

  /**
   * Whether `tip` has commits outside `not` whose changes no base holds either: a branch merged
   * by rebase or cherry-pick has commits outside the base, but none with new changes. A merge
   * commit counts when its result differs from every parent somewhere (a conflict resolution or
   * an edit made in the merge); `git cherry` cannot match merges, so such a merge always counts.
   */
  private async hasNewWork(tip: string, not: string[], bases: string[]): Promise<boolean> {
    for (const m of lines(await this.git(['rev-list', '--merges', tip, '--not', ...not]))) {
      const own = await this.git([
        ...PLAIN_PATHS,
        'diff-tree',
        '--cc',
        '--no-commit-id',
        '--no-color',
        '--no-ext-diff',
        '--no-renames',
        m,
      ]);
      if (own.trim()) return true;
    }
    const fresh = lines(await this.git(['rev-list', '--no-merges', tip, '--not', ...not]));
    if (fresh.length === 0) return false;
    let left = new Set(fresh);
    for (const base of bases) {
      // `+` marks a commit whose change the base lacks.
      const plus = lines(await this.git(['cherry', base, tip]))
        .filter((l) => l.startsWith('+ '))
        .map((l) => l.slice(2).trim());
      left = new Set(plus.filter((c) => left.has(c)));
      if (left.size === 0) return false;
    }
    return true;
  }

  /**
   * What the first secret-looking line or key file the new commits add looks like, or null.
   * Merge commits are shown as dense combined diffs (`--cc`): the hunks where the merge result
   * differs from every parent, so a line added while resolving a conflict is scanned too.
   */
  private async leak(tip: string, not: string[]): Promise<string | null> {
    const out = await this.git([
      ...PLAIN_PATHS,
      'log',
      '-p',
      '--cc',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--format=',
      tip,
      '--not',
      ...not,
    ]);
    let file = '';
    // Marker columns of the current hunk: 1 in a plain diff, one per parent in a combined one;
    // 0 while in a file's header.
    let cols = 0;
    for (const l of out.split('\n')) {
      if (l.startsWith('diff ')) {
        cols = 0;
        continue;
      }
      const hunk = /^(@@+) /.exec(l);
      if (hunk) {
        cols = hunk[1]!.length - 1;
        continue;
      }
      if (cols === 0) {
        const path =
          /^\+\+\+ (.+)$/.exec(l)?.[1] ?? /^Binary files .* and (.+) differ$/.exec(l)?.[1];
        if (path && path !== '/dev/null') {
          file = diffPath(path);
          if (isKeyFile(file)) return `a key file (${file})`;
        }
        continue;
      }
      // A line in the result: `+` against some parent, `-` against none.
      const mark = l.slice(0, cols);
      if (!mark.includes('+') || mark.includes('-')) continue;
      const kind = secretKind(l.slice(cols));
      if (kind) return `what looks like a ${kind} in ${file}`;
    }
    return null;
  }

  private async git(args: string[], opts: { allowFail?: boolean } = {}): Promise<string> {
    try {
      return await gitAsync(this.top, args, {
        env: { ...this.env, GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  }
}

/** Git options that keep non-ASCII paths readable in diff output. */
const PLAIN_PATHS = ['-c', 'core.quotePath=false'];

/** A path from a diff header without its quotes and `a/` or `b/` prefix. */
function diffPath(raw: string): string {
  const unquoted = /^".*"$/.test(raw) ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^[ab]\//, '');
}

function lines(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The line of a failed git command that says why, safe to log: URLs (which can carry a sign-in)
 * become `<url>`, a `user:password@` sign-in anywhere else goes, and lines that look like a
 * secret are left out.
 */
export function gitError(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string; code?: string };
  if (e.code === 'ETIMEDOUT') return 'timed out';
  const raw = `${e.stderr ?? ''}\n${e.stdout ?? ''}`.trim() || (e.message ?? '');
  const text = redactSecrets(raw)
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>')
    // Git may print a URL without its scheme; a sign-in in it goes too.
    .replace(/\/\/[^\s'"/@]+@/g, '//')
    .replace(/[^\s'"/@]+:[^\s'"/@]*@/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    text.find((l) => /rejected|fatal|error|denied|could not/i.test(l)) ?? text[0] ?? 'git failed'
  );
}
