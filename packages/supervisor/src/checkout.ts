import { execFileSync } from 'node:child_process';
import { execOffThread, ROOT_DIR_NAMES } from '@swarmup/core';
import { mkdtempSync, readdirSync, rmdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * `git worktree list` per main checkout, with the modification time of its `.git/worktrees`
 * folder when it was read. Adding, removing or pruning a worktree changes that folder, so the
 * list is read again only then. With ~90 worktrees it took ~70 ms of swarmupd's event loop on every
 * launch and wrap-up (AO-0171).
 */
const worktreeLists = new Map<string, { mtimeMs: number; list: string }>();

/** One git command a step needs run, with its extra environment and standard input. */
interface GitCall {
  args: string[];
  env?: Record<string, string>;
  input?: string;
}

/**
 * Git work written once, as a generator that yields each command it needs and gets its output
 * back: `runSync` runs the commands with `execFileSync`, `runAsync` from a worker thread. A failed
 * command is thrown into the generator, as `execFileSync` throws it.
 */
type Steps<T> = Generator<GitCall, T, string>;

/**
 * Git work on a code checkout that runs write in: whether it has changes, and committing what a
 * run left to a branch of its own. Task stores never take part: their files are not changes of
 * the checkout and never go into a run's commit.
 */
export class Checkout {
  /** The task stores inside the checkout, relative to its top, with `/`. */
  private readonly stores: string[];
  /** The checkout is itself a task store: swarmupd leaves it alone. */
  readonly isStore: boolean;

  /**
   * @param top The top of the checkout's git work tree.
   * @param stores The task store folders swarmupd knows (each root's folder).
   * @param env The environment git runs with: swarmupd's, so commits carry its git identity.
   */
  constructor(
    readonly top: string,
    stores: string[] = [],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.stores = [];
    let isStore = false;
    for (const dir of stores) {
      const rel = relative(resolve(top), resolve(dir));
      if (rel === '' || rel.startsWith('..') || rel.includes(':')) {
        // The store holds the checkout, or the checkout is the store.
        if (rel === '' || isInside(top, dir)) isStore = true;
        continue;
      }
      this.stores.push(rel.split(sep).join('/'));
    }
    this.isStore = isStore;
  }

  /** The commit checked out, or null in a repo without one. */
  head(): string | null {
    return this.runSync(this.ref('HEAD'));
  }

  /** The commit `rev` names, or null when it names none. */
  private *ref(rev: string): Steps<string | null> {
    try {
      return (yield { args: ['rev-parse', '--verify', '-q', `${rev}^{commit}`] }).trim() || null;
    } catch {
      return null;
    }
  }

  /** The branch checked out, or null on a detached HEAD. */
  branch(): string | null {
    return this.runSync(this.branchSteps());
  }

  /** {@link branch}, with git off the event loop. */
  branchAsync(): Promise<string | null> {
    return this.runAsync(this.branchSteps());
  }

  private *branchSteps(): Steps<string | null> {
    try {
      return (yield { args: ['symbolic-ref', '-q', '--short', 'HEAD'] }).trim() || null;
    } catch {
      return null;
    }
  }

  /** The repo's worktrees, this one too: each one's folder and branch (null when detached). */
  worktrees(): Array<{ path: string; branch: string | null }> {
    const out: Array<{ path: string; branch: string | null }> = [];
    let cur: { path: string; branch: string | null } | undefined;
    for (const field of this.git(['worktree', 'list', '--porcelain', '-z']).split('\0')) {
      if (field.startsWith('worktree ')) {
        cur = { path: field.slice('worktree '.length), branch: null };
        out.push(cur);
      } else if (cur && field.startsWith('branch ')) {
        cur.branch = field.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
    }
    return out;
  }

  /**
   * The pathspecs that leave out task stores and the repo's linked worktrees inside this
   * checkout. A run makes its code branch in a worktree such as `out/wt-<ID>` (AO-0135); a repo
   * that does not ignore that folder would otherwise show it as an untracked change, and
   * `git add -A` would stage it as an embedded repo.
   *
   * A folder the repo ignores, such as `out/` in a repo that ignores `out`, gets no pathspec:
   * git never lists or stages it anyway, and `git add` exits 1 when a pathspec, an exclude one
   * too, names an ignored path, so the whole wrap-up commit failed (AO-0197).
   */
  private *pathExcludes(): Steps<string[]> {
    const paths = [...this.stores];
    try {
      const list = yield* this.worktreeList();
      for (const field of list.split('\0')) {
        if (!field.startsWith('worktree ')) continue;
        const rel = relative(resolve(this.top), resolve(field.slice('worktree '.length)));
        if (rel === '' || rel.startsWith('..') || rel.includes(':')) continue;
        paths.push(rel.split(sep).join('/'));
      }
    } catch {
      // No worktree list: the task stores alone.
    }
    const ignored = yield* this.ignored(paths);
    return [
      ...ROOT_DIR_NAMES.map((n) => `:(exclude,glob)**/${n}/**`),
      ...paths.filter((p) => !ignored.has(p)).map((p) => `:(exclude,literal)${p}`),
    ];
  }

  /** Which of `paths`, relative to the top, the repo ignores; none when git cannot tell. */
  private *ignored(paths: string[]): Steps<Set<string>> {
    if (paths.length === 0) return new Set();
    try {
      const out = yield {
        args: ['check-ignore', '-z', '--stdin'],
        // check-ignore refuses literal pathspecs; it matches each path as given anyway.
        env: { GIT_LITERAL_PATHSPECS: '0' },
        input: paths.join('\0'),
      };
      return new Set(this.names(out));
    } catch {
      // Exit 1: none of them is ignored. Any other failure keeps every exclude, as before.
      return new Set();
    }
  }

  /** `git worktree list --porcelain -z`, read again only when the repo's worktrees changed. */
  private *worktreeList(): Steps<string> {
    let mtimeMs: number | null = null;
    try {
      // A main checkout only: a linked worktree's `.git` is a file, and it is read each time.
      const dir = join(this.top, '.git');
      if (statSync(dir).isDirectory()) {
        try {
          mtimeMs = statSync(join(dir, 'worktrees')).mtimeMs;
        } catch {
          mtimeMs = 0; // No linked worktree yet.
        }
      }
    } catch {
      mtimeMs = null;
    }
    const key = resolve(this.top);
    const known = worktreeLists.get(key);
    if (mtimeMs !== null && known?.mtimeMs === mtimeMs) return known.list;
    const list = yield { args: ['worktree', 'list', '--porcelain', '-z'] };
    if (mtimeMs !== null) worktreeLists.set(key, { mtimeMs, list });
    return list;
  }

  /** Changed tracked files and untracked files, outside task stores; ignored files never count. */
  changes(): string[] {
    return this.runSync(this.changeSteps());
  }

  /**
   * {@link changes}, or the error git gave, and {@link head}, with git off the event loop. opsd
   * reads these before a tick launches runs, so a launch runs no git (AO-0215).
   */
  stateAsync(): Promise<CheckoutState> {
    return this.runAsync(this.stateSteps());
  }

  private *stateSteps(): Steps<CheckoutState> {
    let changes: string[] | Error;
    try {
      changes = yield* this.changeSteps();
    } catch (err) {
      const msg = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      changes = new Error(msg);
    }
    return { changes, head: yield* this.ref('HEAD'), gitDirs: yield* this.gitDirSteps() };
  }

  /**
   * The checkout's git dir and the repo's common dir as git names them, or null when git finds
   * no repo here or refuses it (an unsafe owner, a `.git` that names no git dir).
   */
  gitDirs(): GitDirs | null {
    return this.runSync(this.gitDirSteps());
  }

  private *gitDirSteps(): Steps<GitDirs | null> {
    try {
      const out = yield { args: ['rev-parse', '--git-dir', '--git-common-dir'] };
      const [own, common] = out.trim().split(/\r?\n/);
      if (!own || !common) return null;
      return { own: resolve(this.top, own), common: resolve(this.top, common) };
    } catch {
      return null;
    }
  }

  private *changeSteps(): Steps<string[]> {
    if (this.isStore) return [];
    const excludes = yield* this.pathExcludes();
    const out = yield {
      args: [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--no-renames',
        '--',
        '.',
        ...excludes,
      ],
    };
    return out
      .split('\0')
      .filter((e) => e.length > 3)
      .map((e) => e.slice(3));
  }

  /**
   * Commits every change outside task stores on a new branch `branch` from `base`, the commit
   * the run started on, then restores those files to it. Neither the index nor HEAD's branch
   * take the commit: it is built in a temporary index. A file whose content changed again since
   * the commit, or whose staged version is in neither `base` nor the commit, stays as it is and
   * is listed in `kept`, so nothing is discarded that the commit does not hold. When `branch`
   * already exists on `base` (an earlier call stopped before its restore was over), its commit
   * is taken as is and only the restore runs.
   *
   * Rejects, committing nothing, when changes are left but HEAD is no longer `base` (the run, or
   * someone else, moved it: the changes may belong on another commit) or `base` is null (the
   * start commit was not recorded). Resolves to null when nothing is left or the repo has no
   * commit to branch from.
   *
   * Git runs off the event loop: the commit takes some 20 git commands, which held opsd's API for
   * seconds at the end of each run while they ran synchronously (AO-0205).
   */
  commitLeftovers(
    branch: string,
    message: string,
    base: string | null,
  ): Promise<LeftoverCommit | null> {
    return this.runAsync(this.commitSteps(branch, message, base));
  }

  private *commitSteps(
    branch: string,
    message: string,
    base: string | null,
  ): Steps<LeftoverCommit | null> {
    if (this.isStore) return null;
    const head = yield* this.ref('HEAD');
    if (!head) return null;
    if (head !== base) {
      // A run that committed its work itself and left nothing needs nothing.
      if ((yield* this.changeSteps()).length === 0) return null;
      if (!base) throw new Error(`no start commit recorded; HEAD is ${head.slice(0, 7)}`);
      throw new Error(
        `HEAD moved from ${base.slice(0, 7)} to ${head.slice(0, 7)} during the run; the changes stay for a person`,
      );
    }
    const tmp = mkdtempSync(join(tmpdir(), 'swarmupd-index-'));
    try {
      const excludes = yield* this.pathExcludes();
      let commit = yield* this.ref(`refs/heads/${branch}`);
      if (commit) {
        // An earlier wrap-up stopped after the commit (swarmupd restarted): the branch holds what
        // the run left, and the restore below finishes what that wrap-up started.
        if ((yield* this.ref(`${commit}^`)) !== head) {
          throw new Error(`branch ${branch} exists and does not start from ${head.slice(0, 7)}`);
        }
      } else {
        const tree = yield* this.stage(join(tmp, 'commit'), head, excludes);
        if (tree === (yield { args: ['rev-parse', `${head}^{tree}`] }).trim()) return null;
        commit = (yield { args: ['commit-tree', tree, '-p', head], input: message }).trim();
        // An empty old value: the branch must not exist yet.
        yield { args: ['update-ref', `refs/heads/${branch}`, commit, ''] };
      }

      const changed = this.parseNameStatus(
        yield { args: ['diff-tree', '-r', '-z', '--no-renames', '--name-status', head, commit] },
      );
      const now = yield* this.stage(join(tmp, 'check'), head, excludes);
      const nowChanged = new Set(
        this.names(
          yield { args: ['diff-tree', '-r', '-z', '--no-renames', '--name-only', head, now] },
        ),
      );
      // Files changed again since the commit (helpers still writing, a person at work).
      const movedOn = new Set(
        this.names(
          yield { args: ['diff-tree', '-r', '-z', '--no-renames', '--name-only', commit, now] },
        ),
      );
      // Staged versions in neither HEAD nor the commit.
      const staged = new Set(
        this.names(
          yield { args: ['diff-index', '--cached', '-z', '--name-only', '--no-renames', head] },
        ),
      );
      const stagedOther = new Set(
        this.names(
          yield { args: ['diff-index', '--cached', '-z', '--name-only', '--no-renames', commit] },
        ),
      );
      const kept: string[] = [];
      const restore: string[] = [];
      const added: string[] = [];
      const unstage: string[] = [];
      for (const [status, path] of changed) {
        // As in `head` already: restored before swarmupd restarted, or changed back.
        if (!nowChanged.has(path) && !staged.has(path)) continue;
        if (movedOn.has(path) || (staged.has(path) && stagedOther.has(path))) {
          kept.push(path);
          continue;
        }
        if (status === 'A') {
          added.push(path);
          if (staged.has(path)) unstage.push(path);
        } else restore.push(path);
      }
      const literal = { GIT_LITERAL_PATHSPECS: '1' };
      if (unstage.length > 0) {
        yield {
          args: ['reset', '-q', head, '--pathspec-from-file=-', '--pathspec-file-nul'],
          env: literal,
          input: unstage.join('\0'),
        };
      }
      if (restore.length > 0) {
        yield {
          args: ['checkout', head, '--pathspec-from-file=-', '--pathspec-file-nul'],
          env: literal,
          input: restore.join('\0'),
        };
      }
      for (const path of added) this.removeAdded(path);
      return { commit, branch, base: head, files: changed.map(([, p]) => p), kept };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /**
   * Stages the work tree outside `excludes` ({@link pathExcludes}) over `head` into a fresh index
   * at `index`; returns its tree.
   */
  private *stage(index: string, head: string, excludes: string[]): Steps<string> {
    const env = { GIT_INDEX_FILE: index };
    yield { args: ['read-tree', head], env };
    yield { args: ['add', '-A', '--', '.', ...excludes], env };
    return (yield { args: ['write-tree'], env }).trim();
  }

  /** Deletes a file the run added, and the folders it leaves empty, up to the checkout's top. */
  private removeAdded(path: string): void {
    const abs = join(this.top, ...path.split('/'));
    try {
      unlinkSync(abs);
    } catch {
      return;
    }
    let dir = dirname(abs);
    while (isInside(dir, this.top) && resolve(dir) !== resolve(this.top)) {
      try {
        if (readdirSync(dir).length > 0) return;
        rmdirSync(dir);
      } catch {
        return;
      }
      dir = dirname(dir);
    }
  }

  private names(out: string): string[] {
    return out.split('\0').filter(Boolean);
  }

  private parseNameStatus(out: string): Array<[string, string]> {
    const parts = out.split('\0').filter(Boolean);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) pairs.push([parts[i]![0]!, parts[i + 1]!]);
    return pairs;
  }

  private git(args: string[], opts: { env?: Record<string, string>; input?: string } = {}): string {
    return execFileSync('git', args, {
      cwd: this.top,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      input: opts.input ?? '',
      env: this.gitEnv(opts.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /**
   * {@link git} off the event loop, started from a worker thread (AO-0171); a failure carries
   * `stdout` and `stderr` as well.
   */
  private gitAsync(call: GitCall): Promise<string> {
    return execOffThread('git', call.args, {
      cwd: this.top,
      env: this.gitEnv(call.env),
      input: call.input,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }

  private gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...this.env, GIT_TERMINAL_PROMPT: '0', ...extra };
  }

  private runSync<T>(steps: Steps<T>): T {
    let next = steps.next();
    while (!next.done) {
      let out: string;
      try {
        out = this.git(next.value.args, next.value);
      } catch (err) {
        next = steps.throw(err);
        continue;
      }
      next = steps.next(out);
    }
    return next.value;
  }

  private async runAsync<T>(steps: Steps<T>): Promise<T> {
    let next = steps.next();
    while (!next.done) {
      let out: string;
      try {
        out = await this.gitAsync(next.value);
      } catch (err) {
        next = steps.throw(err);
        continue;
      }
      next = steps.next(out);
    }
    return next.value;
  }
}

/** What opsd reads of a checkout before a writing run starts there. */
export interface CheckoutState {
  /** Changes outside task stores, or the error git gave. */
  changes: string[] | Error;
  /** The commit checked out, or null in a repo without one. */
  head: string | null;
  /** The checkout's git dirs, or null when git names none. */
  gitDirs: GitDirs | null;
}

/** A checkout's own git dir and its repo's common dir; the same folder in a main checkout. */
export interface GitDirs {
  own: string;
  common: string;
}

export interface LeftoverCommit {
  commit: string;
  branch: string;
  /** The commit the branch starts from: the one the run started on, still HEAD at its end. */
  base: string;
  /** Files the commit changes, relative to the checkout's top. */
  files: string[];
  /** Files left in the checkout because they changed again after the commit. */
  kept: string[];
}

/** The branch for what run `run` of `agent` left: `<runtime>/<task>-<run>`, lowercase. */
export function leftoverBranch(runtime: string, run: string, task?: string): string {
  return `${runtime}/${task ?? 'run'}-${run}`.toLowerCase().replace(/[^a-z0-9/._-]/g, '-');
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !rel.includes(':'));
}
