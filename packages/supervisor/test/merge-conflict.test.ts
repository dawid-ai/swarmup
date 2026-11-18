// A merge conflict sent back as a merge of the base into the branch, and the review that follows,
// which covers only the resolution.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MERGE_ACTOR } from '@swarmup/core';
import { gitIn, isMergeConflictBack, resolutionNote } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true }).trim();
}

function commit(repo: string, file: string, text: string, message: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/**
 * A repo whose `feature` commit was approved but conflicts with `main`, and whose branch then
 * merged `main` and resolved the conflict.
 */
function resolvedRepo(): { repo: string; approved: string; resolved: string } {
  const repo = mkdtempSync(join(tmpdir(), 'swarmup-conflict-'));
  dirs.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'code.txt', 'one\n', 'start');
  git(repo, 'checkout', '-q', '-b', 'feature');
  const approved = commit(repo, 'code.txt', 'two\n', 'Change the code');
  git(repo, 'checkout', '-q', 'main');
  commit(repo, 'code.txt', 'three\n', 'Change it on main');
  git(repo, 'checkout', '-q', 'feature');
  try {
    git(repo, 'merge', '-q', 'main');
  } catch {
    // The conflict.
  }
  writeFileSync(join(repo, 'code.txt'), 'two and three\n');
  git(repo, 'add', 'code.txt');
  git(repo, 'commit', '-q', '--no-edit');
  return { repo, approved, resolved: git(repo, 'rev-parse', 'HEAD') };
}

const sentBack = (approved: string) => ({
  type: 'verdict',
  verdict: 'changes',
  actor: MERGE_ACTOR,
  body: `swarmupd did not merge ${approved.slice(0, 7)} on branch feature: it conflicts with main (abc1234) in \`code.txt\`.`,
});

describe('merge conflict send-backs', () => {
  it("knows swarmupd's conflict send-back from other change requests", () => {
    expect(isMergeConflictBack(sentBack('1234567'))).toBe(true);
    expect(isMergeConflictBack({ ...sentBack('1234567'), actor: 'claude:reviewer' })).toBe(false);
    expect(
      isMergeConflictBack({
        ...sentBack('1234567'),
        body: 'swarmupd did not merge 1234567: `npm test` failed (exit 1)',
      }),
    ).toBe(false);
    expect(isMergeConflictBack({ ...sentBack('1234567'), verdict: 'approve' })).toBe(false);
  });

  it('asks the reviewer to check only the resolution when the branch adds only a merge', async () => {
    const { repo, approved, resolved } = resolvedRepo();
    const events = [{ type: 'review', body: 'x' }, sentBack(approved), { type: 'review' }];
    const note = await resolutionNote(gitIn(repo, ENV), events, resolved, 'main');
    expect(note).toContain(`${approved.slice(0, 7)} was approved, but it conflicted with`);
    expect(note).toContain(`git show --remerge-diff ${resolved.slice(0, 7)}`);
    expect(note).toContain('Approve unless the resolution drops or breaks either side.');
    expect(note).not.toContain('besides the merge');
  });

  it('names commits besides the merge for a full review', async () => {
    const { repo, approved } = resolvedRepo();
    const more = commit(repo, 'other.txt', 'more\n', 'More work');
    const note = await resolutionNote(gitIn(repo, ENV), [sentBack(approved)], more, 'main');
    expect(note).toContain(`The branch also has 1 commit(s) since ${approved.slice(0, 7)}`);
  });

  it('adds nothing when the newest verdict is not the send-back or the work dropped the approved commit', async () => {
    const { repo, approved, resolved } = resolvedRepo();
    const git_ = gitIn(repo, ENV);
    const later = { type: 'verdict', verdict: 'changes', actor: 'claude:reviewer', body: 'redo' };
    expect(await resolutionNote(git_, [sentBack(approved), later], resolved, 'main')).toBe('');
    // A rebased branch no longer holds the approved commit: it gets a full review.
    git(repo, 'checkout', '-q', '-b', 'fresh', 'main');
    const fresh = commit(repo, 'code.txt', 'two and three\n', 'Change the code again');
    expect(await resolutionNote(git_, [sentBack(approved)], fresh, 'main')).toBe('');
  });
});
