import type { TestChangesConfig } from './config.js';
import type { Git } from './diff.js';
import { DIFF_ARGS, parseFiles, splitPatch } from './diff.js';

/**
 * Changes to tests and to check configuration in the work a review names (AO-0291). The merge
 * checks run in swarmupd's worktree, but on the branch's own tests and configuration: a branch
 * that deletes or skips a test, or loosens a check, still passes them. swarmupd lists such changes
 * for the reviewer. It flags only and never blocks: many tasks change tests for good reason.
 */
export interface TestChanges {
  /** The branch the work is compared with. */
  base: string;
  /** The commits compared, in full. */
  from: string;
  to: string;
  items: TestChange[];
}

export interface TestChange {
  path: string;
  /** The path before a rename. */
  old?: string;
  kind: 'test' | 'check';
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type';
  added: number;
  deleted: number;
  /** The first line the work adds that skips or narrows tests, such as `it.skip('x', ...)`. */
  skip?: string;
  /** A `package.json` whose `scripts` changed. */
  scripts?: true;
}

/**
 * Test files, where `tests` is unset. A pattern without `/` matches the file name in any folder;
 * `*` and `?` stay inside one path segment, and `**` crosses folders.
 */
export const DEFAULT_TEST_PATTERNS = [
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/e2e/**',
  '*.test.*',
  '*.spec.*',
  '*_test.*',
  'test_*.py',
];

/**
 * Check configuration, where `checks` is unset: test, lint, format and type check config, CI
 * files, git hooks, and `package.json` (flagged only when its `scripts` change).
 */
export const DEFAULT_CHECK_PATTERNS = [
  'package.json',
  'vitest.config.*',
  'vitest.setup.*',
  'vitest.workspace.*',
  'jest.config.*',
  'jest.setup.*',
  'playwright.config.*',
  'cypress.config.*',
  'karma.conf.*',
  '.mocharc*',
  'pytest.ini',
  'tox.ini',
  'conftest.py',
  'eslint.config.*',
  '.eslintrc*',
  '.eslintignore',
  'prettier.config.*',
  '.prettierrc*',
  '.prettierignore',
  'biome.json*',
  'tsconfig*.json',
  'ruff.toml',
  '.ruff.toml',
  '.golangci.*',
  '.github/workflows/**',
  '.gitlab-ci.yml',
  '.circleci/**',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '.husky/**',
  'lefthook.yml',
  '.pre-commit-config.yaml',
];

/** A line that skips a test or narrows a run to some tests, in the common test frameworks. */
const SKIP =
  /\b(?:it|test|describe|suite|context|bench)(?:\.\w+)*\.(?:skip|skipIf|todo|only|fails)\b|(?<![.\w])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)|@(?:unittest\.)?skip(?:If|Unless)?\(|\bt\.Skip(?:f|Now)?\(|@(?:Ignore|Disabled)\b|#\[ignore\]/;

/** How many changes the prompt lists; it counts the rest. */
const MAX_ITEMS = 40;
/** Test files whose added lines are read for skips; a larger change is listed without them. */
const MAX_SKIP_FILES = 200;
const MAX_SKIP_OUTPUT = 16 * 1024 * 1024;
const MAX_SKIP_CHARS = 80;

/** The regular expression of a path pattern (see {@link DEFAULT_TEST_PATTERNS}). */
export function patternRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  if (!p.includes('/')) p = `**/${p}`;
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      i++;
      // `**/` also matches no folder at all, so `**/test/**` covers a top-level `test/`.
      if (p[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matcher(patterns: string[]): (path: string) => boolean {
  const res = patterns.map(patternRegExp);
  return (path) => res.some((r) => r.test(path));
}

/** The first line a file's hunks add that skips or narrows tests. */
export function addedSkip(patch: string): string | undefined {
  for (const raw of patch.split('\n')) {
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    const line = raw.slice(1).trim();
    if (SKIP.test(line)) {
      return line.length > MAX_SKIP_CHARS ? `${line.slice(0, MAX_SKIP_CHARS)}...` : line;
    }
  }
  return undefined;
}

function scriptsOf(text: string | null): string | null {
  if (text === null) return null;
  try {
    const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
    return JSON.stringify(scripts ?? {});
  } catch {
    return null;
  }
}

/**
 * Reads the changes to tests and check configuration between two commits. Read-only.
 *
 * - Test files (`cfg.tests`): changed, deleted, renamed, or with an added line that skips or
 *   narrows tests. New test files are not listed, unless they add such a line.
 * - Check configuration (`cfg.checks`): every change; a `package.json` only when its `scripts`
 *   differ, or when either side is not JSON.
 */
export async function readTestChanges(
  git: Git,
  range: { base: string; from: string; to: string },
  cfg: TestChangesConfig = {},
): Promise<TestChanges> {
  const isTest = matcher(cfg.tests ?? DEFAULT_TEST_PATTERNS);
  const isCheck = matcher(cfg.checks ?? DEFAULT_CHECK_PATTERNS);
  const { from, to } = range;
  const [numstat, names] = await Promise.all([
    git(['diff', ...DIFF_ARGS, '--numstat', '-z', from, to]),
    git(['diff', ...DIFF_ARGS, '--name-status', '-z', from, to]),
  ]);
  const items: TestChange[] = [];
  for (const f of parseFiles(numstat, names)) {
    // A copy leaves its source as it is.
    const before = f.status === 'renamed' ? f.old : undefined;
    const either = (is: (p: string) => boolean): boolean =>
      is(f.path) || (before !== undefined && is(before));
    const kind = either(isCheck) ? 'check' : either(isTest) ? 'test' : null;
    if (!kind) continue;
    items.push({
      path: f.path,
      ...(before !== undefined ? { old: before } : {}),
      kind,
      status: f.status,
      added: f.added,
      deleted: f.deleted,
    });
  }

  const show = async (rev: string, path: string): Promise<string | null> => {
    try {
      return await git(['show', `${rev}:${path}`]);
    } catch {
      return null;
    }
  };
  const kept: TestChange[] = [];
  for (const item of items) {
    const name = item.path.slice(item.path.lastIndexOf('/') + 1);
    if (item.kind === 'check' && name === 'package.json' && item.status === 'modified') {
      const [a, b] = await Promise.all([show(from, item.path), show(to, item.path)]);
      const [sa, sb] = [scriptsOf(a), scriptsOf(b)];
      if (sa !== null && sb !== null && sa === sb) continue;
      if (sa !== null && sb !== null) item.scripts = true;
    }
    kept.push(item);
  }

  const read = kept.filter((i) => i.kind === 'test' && i.status !== 'deleted' && i.added > 0);
  if (read.length > 0 && read.length <= MAX_SKIP_FILES) {
    try {
      const text = await git(
        [
          'diff',
          ...DIFF_ARGS,
          '-U0',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          from,
          to,
          '--',
          ...read.map((i) => `:(literal)${i.path}`),
        ],
        MAX_SKIP_OUTPUT,
      );
      const patches = splitPatch(text);
      for (const item of read) {
        const skip = addedSkip(patches.get(item.path) ?? '');
        if (skip) item.skip = skip;
      }
    } catch {
      // Too much output, or a pathspec git refused: the files are listed without skips.
    }
  }
  // A new test file takes nothing away from the checks, unless it comes skipped.
  const flagged = kept.filter((i) => !(i.kind === 'test' && i.status === 'added' && !i.skip));
  return { ...range, items: flagged };
}

const short = (sha: string): string => sha.slice(0, 7);

function describe(i: TestChange): string {
  const what = i.kind === 'test' ? 'test' : 'check configuration';
  const size =
    i.status === 'deleted' || (i.added === 0 && i.deleted === 0)
      ? ''
      : ` (+${i.added} -${i.deleted})`;
  let text: string;
  if (i.status === 'deleted') text = `deleted ${what}: \`${i.path}\``;
  else if (i.status === 'added') text = `new ${what}: \`${i.path}\``;
  else if (i.old !== undefined) text = `moved ${what}: \`${i.old}\` to \`${i.path}\`${size}`;
  else text = `changed ${what}: \`${i.path}\`${size}`;
  if (i.scripts) text += ', its `scripts` differ';
  if (i.skip) text += `, adds a line that skips or narrows tests: \`${i.skip.replace(/`/g, "'")}\``;
  return text;
}

/**
 * The lines a review run's prompt carries about the changes, or an empty string when there are
 * none. Deleted and skipped tests come first.
 */
export function testChangesNote(c: TestChanges): string {
  if (c.items.length === 0) return '';
  const rank = (i: TestChange): number =>
    i.status === 'deleted' ? 0 : i.skip ? 1 : i.kind === 'check' ? 2 : 3;
  const sorted = c.items
    .map((item, at) => ({ item, at }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.at - b.at)
    .map((e) => e.item);
  const lines = [
    '',
    `This work changes tests or check configuration (${short(c.from)}..${short(c.to)}, compared with`,
    `${c.base}); swarmupd lists it, and holds nothing back for it:`,
    ...sorted.slice(0, MAX_ITEMS).map((i) => `- ${describe(i)}`),
  ];
  if (sorted.length > MAX_ITEMS) lines.push(`- and ${sorted.length - MAX_ITEMS} more such files`);
  lines.push(
    'The merge checks run on the tests and the configuration the branch itself has, so they pass',
    'whatever the branch removed or turned off. Check that the task needs each of these changes,',
    'and say so in your verdict. Many tasks change tests for good reason: ask for changes only for',
    'one the task does not need, or one that hides a failure.',
  );
  return `${lines.join('\n')}\n`;
}
