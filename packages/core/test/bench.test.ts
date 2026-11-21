import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { benchPrompt, parseBenchSet, readBenchSet } from '@swarmup/core';

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'E-1',
  base: { ref: 'main' },
  prompt: 'Fix the bug.',
  done_when: [{ id: 'tests', kind: 'command', run: 'npm test' }],
  ...over,
});

const set = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'demo',
  entries: [entry()],
  ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseBenchSet', () => {
  it('applies the defaults and keeps per-entry overrides', () => {
    const s = parseBenchSet(
      set({
        description: 'Two entries',
        defaults: { agent: 'claude:engineer', budget: 20, repeat: 3 },
        entries: [entry(), entry({ id: 'E-2', agent: 'codex:engineer', budget: 5, repeat: 1 })],
      }),
      'C:/sets/benchmarks/demo.yaml',
    );
    expect(s.id).toBe('demo');
    expect(s.description).toBe('Two entries');
    expect(s.hiddenTo).toBe('hidden');
    expect(s.entries[0]).toMatchObject({ agent: 'claude:engineer', budget: 20, repeat: 3 });
    expect(s.entries[1]).toMatchObject({ agent: 'codex:engineer', budget: 5, repeat: 1 });
  });

  it('reads base ref, snapshot and empty, and refuses two at once', () => {
    const base = (b: unknown) =>
      parseBenchSet(set({ entries: [entry({ base: b })] }), 'x.yaml').entries[0]!.base;
    expect(base({ ref: 'abc123' })).toEqual({ ref: 'abc123' });
    expect(base({ snapshot: 'site' })).toEqual({ snapshot: 'site' });
    expect(base({ empty: true })).toEqual({ empty: true });
    expect(() => base({ ref: 'a', snapshot: 'b' })).toThrow(/exactly one of ref, snapshot/);
    expect(() => base('main')).toThrow(/must be a mapping/);
  });

  it('marks hidden command criteria and numbers criteria as a task does', () => {
    const s = parseBenchSet(
      set({
        entries: [
          entry({
            done_when: [
              { id: 'tests', kind: 'command', run: 'python -m unittest' },
              { id: 'hidden', kind: 'command', run: 'python -m unittest hidden.t', hidden: true },
              { kind: 'rubric', rubric: 'rubrics/q.md', pass: 0.8 },
              'A reviewer reads this.',
            ],
          }),
        ],
      }),
      'x.yaml',
    );
    const c = s.entries[0]!.criteria;
    expect(c.map((x) => [x.id, x.kind, x.hidden ?? false])).toEqual([
      ['tests', 'command', false],
      ['hidden', 'command', true],
      ['c3', 'rubric', false],
      ['c4', 'prose', false],
    ]);
  });

  it('refuses a hidden criterion that is not a command', () => {
    expect(() =>
      parseBenchSet(
        set({
          entries: [
            entry({
              done_when: [
                {
                  kind: 'check',
                  check: 'file-exists',
                  args: { path: 'a' },
                  hidden: true,
                },
              ],
            }),
          ],
        }),
        'x.yaml',
      ),
    ).toThrow(/only a command criterion can be hidden/);
  });

  it('refuses bad sets with the key that is wrong', () => {
    const bad = (s: unknown) => () => parseBenchSet(s, 'x.yaml');
    expect(bad(set({ entries: [] }))).toThrow(/at least one entry/);
    expect(bad(set({ extra: 1 }))).toThrow(/unknown key 'extra'/);
    expect(bad(set({ entries: [entry(), entry()] }))).toThrow(/two entries have the id 'E-1'/);
    expect(bad(set({ entries: [entry({ task: { title: 't', body: 'b' } })] }))).toThrow(
      /exactly one of task and prompt/,
    );
    expect(bad(set({ entries: [entry({ agent: 'claude' })] }))).toThrow(/<runtime>:<role>/);
    expect(bad(set({ entries: [entry({ repeat: 0 })] }))).toThrow(/whole number from 1/);
    expect(bad(set({ entries: [entry({ budget: -1 })] }))).toThrow(/minutes/);
    expect(bad(set({ entries: [entry({ done_when: [] })] }))).toThrow(/at least one criterion/);
    expect(
      bad(
        set({
          entries: [
            entry({
              done_when: [{ kind: 'check', check: 'regex', args: { path: 'a', pattern: '(?i)x' } }],
            }),
          ],
        }),
      ),
    ).toThrow(/E-1\)\.done_when\[0\]: bad pattern/);
    expect(bad(set({ hidden_to: '../out' }))).toThrow(/inside the worktree/);
  });

  it('reads a set file and resolves hidden_dir next to it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-set-'));
    dirs.push(dir);
    const file = join(dir, 'demo.yaml');
    writeFileSync(
      file,
      [
        'id: demo',
        'hidden_dir: ../hidden',
        'defaults: { agent: none }',
        'entries:',
        '  - id: E-1',
        '    base: { ref: main }',
        '    task: { type: bug, title: Fix it, body: "It is broken." }',
        '    done_when:',
        '      - { id: t, kind: command, run: "git diff --quiet {{base}}" }',
      ].join('\n'),
    );
    const s = readBenchSet(file);
    expect(s.hiddenDir).toBe(join(dir, '..', 'hidden'));
    expect(s.entries[0]!.criteria[0]!.run).toBe('git diff --quiet {{base}}');
    expect(benchPrompt(s.entries[0]!)).toBe('# Fix it\n\nIt is broken.');
    expect(benchPrompt({ prompt: 'Do it.' })).toBe('Do it.');
  });
});
