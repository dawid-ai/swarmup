// @vitest-environment happy-dom
// The diff view in the task panel (AO-0106): the files of the commits a review names, each
// file's changes side by side or unified, with syntax colors. Read-only.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { highlight, languageOf, parsePatch, splitRows } from '../ui/src/lib/diff';
import type { TaskDiff } from '../ui/src/types';
import { DiffDialog, diffTitle } from '../ui/src/ui/diff';

const net = vi.hoisted(() => ({
  answer: undefined as unknown,
  fail: null as string | null,
  calls: [] as string[],
}));

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  api: async <T>(method: string, path: string): Promise<T> => {
    net.calls.push(`${method} ${path}`);
    if (net.fail) throw new Error(net.fail);
    return net.answer as T;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PATCH = [
  '@@ -1,4 +1,5 @@ export function f() {',
  ' const a = 1;',
  '-const b = "two";',
  '-const c = 3;',
  '+const b = "three"; // changed',
  ' return a;',
  '+// end',
  '\\ No newline at end of file',
  '',
].join('\n');

const DIFF: TaskDiff = {
  source: { commit: 'abc1234', branch: 'claude/work' },
  base: 'main',
  from: '1111111aaaaaaa',
  to: 'abc1234bbbbbbb',
  merged: false,
  commits: [
    { sha: 'abc1234bbbbbbb', subject: 'Change b', author: 'Dawid', at: new Date().toISOString() },
  ],
  files: [
    { path: 'src/a.ts', status: 'modified', added: 2, deleted: 2, patch: PATCH },
    { path: 'img/new.png', status: 'added', added: 0, deleted: 0, binary: true },
    { path: 'docs/b.md', old: 'docs/a.md', status: 'renamed', added: 0, deleted: 0 },
    { path: 'big.json', status: 'modified', added: 9000, deleted: 1, omitted: 'file' },
  ],
};

let root: Root | undefined;
let box: HTMLDivElement;
let onClose: () => void;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  net.answer = DIFF;
  net.fail = null;
  net.calls = [];
  window.localStorage.clear();
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

async function mount(): Promise<void> {
  onClose = vi.fn();
  root = createRoot(box);
  await act(async () => {
    root!.render(createElement(DiffDialog, { task: 'swarmup/AO-0106', onClose }));
  });
}

const click = (el: Element): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

const button = (text: string): HTMLButtonElement =>
  [...box.querySelectorAll('button')].find((b) => b.textContent!.includes(text))!;

describe('patch parsing', () => {
  it('numbers the lines of both files and marks a missing last line break', () => {
    const [hunk] = parsePatch(PATCH);
    expect(hunk!.header).toBe('@@ -1,4 +1,5 @@ export function f() {');
    expect(hunk!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, undefined],
      ['del', 3, undefined],
      ['add', undefined, 2],
      ['ctx', 4, 3],
      ['add', undefined, 4],
    ]);
    expect(hunk!.lines[5]!.noEol).toBe(true);
    expect(hunk!.lines[1]!.text).toBe('const b = "two";');
  });

  it('pairs deleted lines with the added lines after them, side by side', () => {
    const rows = splitRows(parsePatch(PATCH)[0]!.lines);
    expect(rows.map((r) => [r.left?.old, r.right?.new])).toEqual([
      [1, 1],
      [2, 2],
      [3, undefined],
      [4, 3],
      [undefined, 4],
    ]);
  });
});

describe('syntax colors', () => {
  const kinds = (text: string, path: string): string[] =>
    highlight(text, languageOf(path)).map((t) => `${t.kind}:${t.text}`);

  it('colors keywords, strings, numbers and comments by the file type', () => {
    expect(kinds('const b = "two"; // x', 'a.ts')).toEqual([
      'keyword:const',
      'plain: b = ',
      'string:"two"',
      'plain:; ',
      'comment:// x',
    ]);
    expect(kinds('  * part of a block comment', 'a.ts')).toEqual([
      'comment:  * part of a block comment',
    ]);
    expect(kinds('x = 0x1f + 2.5  # why', 'a.py')).toEqual([
      'plain:x = ',
      'number:0x1f',
      'plain: + ',
      'number:2.5',
      'plain:  ',
      'comment:# why',
    ]);
    // A `#` inside a word starts no comment, and a string holds a comment mark.
    expect(kinds('echo "$# // no" a#b', 'run.sh')).toEqual([
      'plain:echo ',
      'string:"$# // no"',
      'plain: a#b',
    ]);
    expect(kinds('SELECT 1 -- one', 'q.sql')[0]).toBe('keyword:SELECT');
  });

  it('leaves a file of an unknown type in one color', () => {
    expect(languageOf('LICENSE')).toBeNull();
    expect(kinds('const a = 1', 'notes.txt')).toEqual(['plain:const a = 1']);
  });
});

describe('diff dialog', () => {
  it('reads the task diff once and lists the files with their counts', async () => {
    await mount();
    expect(net.calls).toEqual(['GET /api/tasks/swarmup%2FAO-0106/diff']);
    expect(box.querySelector('[data-testid="diff-range"]')!.textContent).toBe(
      'claude/work at abc1234, against main',
    );
    const files = [...box.querySelectorAll('nav button')].map((b) =>
      b.textContent!.replace(/‎/g, ''),
    );
    expect(files).toEqual([
      'Msrc/a.ts+2 −2',
      'Aimg/new.png+0 −0',
      'Rdocs/b.md+0 −0',
      'Mbig.json+9000 −1',
    ]);
    const text = box.textContent!;
    expect(text).toContain('4 files');
    expect(text).toContain('+9002 −3');
    expect(text).toContain('Binary file: no text to compare.');
    expect(text).toContain('docs/a.md → docs/b.md');
    expect(text).toContain('No change in its text.');
    expect(text).toContain('too large to show here');
  });

  it('shows a file side by side by default, with colors, and unified on request', async () => {
    await mount();
    const table = (): HTMLTableElement => box.querySelector('table.diff')!;
    expect(table().classList.contains('diff-split')).toBe(true);
    const row = table().querySelectorAll('tbody tr')[2]!;
    expect([...row.children].map((c) => c.textContent)).toEqual([
      '2',
      'const b = "two";',
      '2',
      'const b = "three"; // changed',
    ]);
    expect(row.children[1]!.className).toContain('diff-del');
    expect(row.children[3]!.className).toContain('diff-add');
    expect(row.querySelector('.tok-keyword')!.textContent).toBe('const');
    expect(row.querySelector('.tok-comment')!.textContent).toBe('// changed');

    click(button('Unified'));
    expect(table().classList.contains('diff-split')).toBe(false);
    const lines = [...table().querySelectorAll('tbody tr')].map((r) => r.className);
    expect(lines).toEqual([
      'diff-hunk',
      'diff-ctx',
      'diff-del',
      'diff-del',
      'diff-add',
      'diff-ctx',
      'diff-add',
    ]);
    // The layout is remembered for the next diff.
    expect(window.localStorage.getItem('swarmup.diff.mode')).toBe('unified');
  });

  it('folds a file, lists the commits, and closes on Escape without passing the key on', async () => {
    await mount();
    click(button('src/a.ts+2')); // The file list entry scrolls; the file header folds.
    const header = [...box.querySelectorAll('section > button')][0]!;
    click(header);
    expect(box.querySelector('table.diff')).toBeNull();
    click(button('1 commit'));
    expect(box.textContent).toContain('Change b');

    const below = vi.fn();
    window.addEventListener('keydown', below);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    window.removeEventListener('keydown', below);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(below).not.toHaveBeenCalled();
  });

  it('says why a task has no diff', async () => {
    net.fail = 'No review request names a commit or a branch of this repo.';
    await mount();
    expect(box.textContent).toContain('No review request names a commit or a branch');
    expect(box.querySelector('table.diff')).toBeNull();
  });

  it('names merged work by the commit the base got', () => {
    expect(diffTitle({ ...DIFF, merged: true })).toBe('claude/work, merged into main as abc1234');
  });
});
