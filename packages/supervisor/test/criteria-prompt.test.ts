import { describe, expect, it } from 'vitest';
import type { Criterion } from '@swarmup/core';
import { runPrompt } from '../src/index.js';

// Work and review prompts list a task's typed criteria by id and kind, and say who judges which.

const criteria: Criterion[] = [
  { id: 'c1', kind: 'prose', text: 'the intro names the price' },
  { id: 'tests', kind: 'command', run: 'pnpm test -- --changed main' },
  { id: 'voice', kind: 'rubric', rubric: 'rubrics/brand-voice.md', pass: 0.8 },
  { id: 'angle', kind: 'human', ask: 'Is the pricing change clear?' },
];

describe('criteria in run prompts', () => {
  it('lists the criteria in a review prompt and asks for a result per criterion', () => {
    const review = runPrompt({ agent: 'codex:reviewer', task: 'T-0001', review: true, criteria });
    expect(review).toContain('  - `c1` (prose): the intro names the price');
    expect(review).toContain('  - `tests` (command): `pnpm test -- --changed main`');
    expect(review).toContain('  - `voice` (rubric): rubrics/brand-voice.md, passes at 0.8');
    expect(review).toContain('  - `angle` (human): Is the pricing change clear?');
    expect(review).toContain('Leave `command`, `check` and `map` criteria out: the');
    expect(review).toContain('swarmup verdict T-0001 changes "what to fix" --criteria-file -');
    expect(review).toContain('`--pass ID` and `--fail ID:"note"`');
    // Reviewers still run no tests or builds (2026-11-18).
    expect(review).toContain('Do not run tests, lint, typecheck, builds or installs');
  });

  it('lists the criteria in a work prompt and asks for evidence per criterion', () => {
    const work = runPrompt({ agent: 'claude:writer', task: 'T-0001', criteria });
    expect(work).toContain('Its criteria, by id:\n  - `c1` (prose): the intro names the price');
    expect(work).toContain('name the evidence for each criterion by id');
    expect(work).toContain('swarmupd runs the `command` and `check` criteria again');
    const prose = runPrompt({ agent: 'claude:writer', task: 'T-0001', criteria: [criteria[0]!] });
    expect(prose).not.toContain('swarmupd runs the `command`');
  });

  it('adds nothing for a task without criteria', () => {
    const work = runPrompt({ agent: 'claude:writer', task: 'T-0001' });
    const review = runPrompt({ agent: 'codex:reviewer', task: 'T-0001', review: true });
    expect(work).not.toContain('Its criteria');
    expect(review).not.toContain('--criteria-file');
  });
});
