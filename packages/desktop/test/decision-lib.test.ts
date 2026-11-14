// AO-0315: the rules behind the Decision toggle and the decision log in the app.
import { describe, expect, it } from 'vitest';
import {
  contradicted,
  DECISION_TEXT_MAX,
  decisionLength,
  firstSentence,
  logNotes,
  logOrigin,
  markFields,
  markProblem,
  scopeText,
} from '../ui/src/lib/decision';
import type { MarkValue } from '../ui/src/lib/decision';

const mark = (over: Partial<MarkValue> = {}): MarkValue => ({
  on: true,
  line: 'Ship the tray app first',
  projectWide: false,
  treeOnly: false,
  ...over,
});

describe('firstSentence', () => {
  it('takes the first sentence and drops its period', () => {
    expect(firstSentence('Ship the tray app first. The window follows in 0.4.')).toBe(
      'Ship the tray app first',
    );
    expect(firstSentence('Do we merge now? Yes.')).toBe('Do we merge now?');
  });

  it('keeps a version number and a one-line message whole', () => {
    expect(firstSentence('Release 0.3.0 goes out on Friday')).toBe(
      'Release 0.3.0 goes out on Friday',
    );
  });

  it('skips empty lines and Markdown markers, images and link targets', () => {
    expect(firstSentence('\n\n## **EU** region\n\nBecause it is cheaper.')).toBe('EU region');
    expect(firstSentence('- Use `main` for [releases](https://example.com). Always.')).toBe(
      'Use main for releases',
    );
    expect(firstSentence('![shot](swarmup-att://file/x.png)\nApprove it.')).toBe('Approve it');
  });

  it('is empty for an empty message', () => {
    expect(firstSentence('  \n ')).toBe('');
  });
});

describe('contradicted', () => {
  it('reads the decision an ask names', () => {
    expect(contradicted('AO-0110: contradiction with D-0007: the task merges by itself')).toBe(
      'D-0007',
    );
    expect(contradicted('Contradiction with d-12 in the plan')).toBe('D-0012');
  });

  it('is null for any other ask', () => {
    expect(contradicted('Which region, EU or US?')).toBeNull();
    expect(contradicted(undefined)).toBeNull();
  });
});

describe('the mark a form sends', () => {
  it('sends nothing while it is off', () => {
    expect(markFields(mark({ on: false }))).toEqual({});
    expect(markProblem(mark({ on: false, line: '' }))).toBeNull();
  });

  it('sends the line and the tree scope, or the project scope with Project-wide', () => {
    expect(markFields(mark({ line: ' Ship the tray app first ' }))).toEqual({
      decision: 'Ship the tray app first',
      scope: 'tree',
    });
    expect(markFields(mark({ projectWide: true }))).toMatchObject({ scope: 'project' });
  });

  it('supersedes without a scope, so the record takes the old one; narrows for the tree', () => {
    expect(markFields(mark({ replaces: 'D-0007' }))).toEqual({
      decision: 'Ship the tray app first',
      supersedes: ['D-0007'],
    });
    expect(markFields(mark({ replaces: 'D-0007', treeOnly: true }))).toEqual({
      decision: 'Ship the tray app first',
      scope: 'tree',
      narrows: ['D-0007'],
    });
  });

  it('holds the form back for an empty line and for more than 200 characters', () => {
    expect(markProblem(mark({ line: '  ' }))).toMatch(/one line/);
    expect(markProblem(mark({ line: 'x'.repeat(DECISION_TEXT_MAX) }))).toBeNull();
    expect(markProblem(mark({ line: 'x'.repeat(DECISION_TEXT_MAX + 1) }))).toBe(
      'A decision is one line of 200 characters at most; this one has 201',
    );
  });

  it('counts characters as core does: code points, trimmed', () => {
    expect(decisionLength(' a😀b ')).toBe(3);
  });
});

describe('a log entry in words', () => {
  it('prints the scope as the CLI does', () => {
    expect(scopeText({ scope: 'tree', task: 'AO-0051' })).toBe('tree AO-0051');
    expect(scopeText({ scope: 'project', project: 'v2' })).toBe('project v2');
    expect(scopeText({ scope: 'project' })).toBe('root');
  });

  it('says where the words are', () => {
    const base = { scope: 'project' as const };
    expect(
      logOrigin({ ...base, kind: 'record', source: 'AO-0107#01M6GN0000000000000000000A' }),
    ).toEqual({ kind: 'event', task: 'AO-0107', ref: 'AO-0107#01M6GN0000000000000000000A' });
    expect(logOrigin({ ...base, kind: 'record', source: 'chat:01M7B2' })).toEqual({
      kind: 'chat',
    });
    expect(logOrigin({ ...base, kind: 'vote' })).toEqual({ kind: 'vote' });
    expect(logOrigin({ ...base, kind: 'record', source: 'kb/decisions/x.md' })).toEqual({
      kind: 'file',
      file: 'kb/decisions/x.md',
    });
  });

  it('notes how it was replaced and where it still holds', () => {
    expect(
      logNotes({
        state: 'superseded',
        replaced: [{ by: 'D-0055', how: 'superseded', where: 'in project v2' }],
      }),
    ).toEqual(['superseded by D-0055']);
    expect(
      logNotes({
        state: 'recorded',
        replaced: [{ by: 'D-0055', how: 'narrowed', where: 'under AO-0110' }],
        in_force_for: ['AO-0063'],
      }),
    ).toEqual(['narrowed under AO-0110 by D-0055', 'in force for AO-0063']);
  });
});
