// Rubric files and the LLM judge's prompt and answer (W7).
import { describe, expect, it } from 'vitest';
import type { Rubric } from '../src/index.js';
import {
  capText,
  DIFF_CAP,
  diffPaths,
  extractJudgeJson,
  FILE_CAP,
  judgePrompt,
  matchGlobs,
  normalizeScore,
  parseJudgeAnswer,
  parseRubric,
  weightedTotal,
} from '../src/index.js';

const RUBRIC = `---
id: code-quality
scale: { min: 0, max: 4 }
criteria:
  - id: readability
    weight: 0.25
    describe: Names and control flow are easy to follow.
  - id: design
    weight: 0.25
    describe: Logic lives in the right layer.
  - id: tests
    weight: 0.5
    describe: New behavior has focused tests.
inputs: [diff, task, repo]
---

# Code quality

Score each criterion with the anchors.

- **4:** merge as is.
`;

const rubric = (): Rubric => parseRubric(RUBRIC, 'rubrics/code-quality.md');

describe('parseRubric', () => {
  it('reads the frontmatter and body, and normalizes the weights', () => {
    const r = parseRubric(RUBRIC.replace('weight: 0.5', 'weight: 1.5'), 'x.md');
    expect(r).toMatchObject({
      id: 'code-quality',
      file: 'x.md',
      scale: { min: 0, max: 4 },
      inputs: ['diff', 'task', 'repo'],
      files: [],
    });
    expect(r.criteria.map((c) => c.id)).toEqual(['readability', 'design', 'tests']);
    expect(r.criteria.map((c) => c.weight)).toEqual([0.125, 0.125, 0.75]);
    expect(r.body).toMatch(/^# Code quality/);
  });

  it('defaults weights to 1 and inputs to diff and task', () => {
    const r = parseRubric(
      '---\nid: x\nscale: { min: 1, max: 5 }\ncriteria:\n  - { id: a, describe: A }\n  - { id: b, describe: B }\n---\nbody\n',
    );
    expect(r.criteria.map((c) => c.weight)).toEqual([0.5, 0.5]);
    expect(r.inputs).toEqual(['diff', 'task']);
  });

  it('takes file globs from a files key or an inputs entry', () => {
    const base = '---\nid: x\nscale: { min: 0, max: 1 }\ncriteria: [{ id: a, describe: A }]\n';
    expect(parseRubric(`${base}inputs: [task, { files: ['docs/**/*.md'] }]\n---\n`)).toMatchObject({
      inputs: ['task', 'files'],
      files: ['docs/**/*.md'],
    });
    expect(parseRubric(`${base}files: README.md\n---\n`)).toMatchObject({
      inputs: ['diff', 'task', 'files'],
      files: ['README.md'],
    });
  });

  it.each([
    ['no frontmatter', '# just a body\n', /starts with YAML frontmatter/],
    ['a bad scale', RUBRIC.replace('max: 4', 'max: 0'), /scale.max must be above scale.min/],
    [
      'no criteria',
      RUBRIC.replace(/criteria:[\s\S]*?inputs/, 'criteria: []\ninputs'),
      /at least one/,
    ],
    [
      'a duplicate id',
      RUBRIC.replace('id: design', 'id: readability'),
      /two criteria have the id 'readability'/,
    ],
    ['a zero weight', RUBRIC.replace('weight: 0.5', 'weight: 0'), /criteria\[2\]\.weight/],
    [
      'no describe',
      RUBRIC.replace('    describe: Logic lives in the right layer.\n', ''),
      /criteria\[1\]\.describe/,
    ],
    [
      'an unknown input',
      RUBRIC.replace('[diff, task, repo]', '[diff, screenshots]'),
      /inputs\[1\]/,
    ],
    [
      'files without globs',
      RUBRIC.replace('[diff, task, repo]', '[diff, files]'),
      /needs a files list/,
    ],
  ])('refuses %s with exit 2, naming the file', (_name, text, msg) => {
    try {
      parseRubric(text, 'r.md');
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: number }).code).toBe(2);
      expect((err as Error).message).toMatch(/^r\.md: /);
      expect((err as Error).message).toMatch(msg);
    }
  });

  it('reads the testbed rubric format', () => {
    // The shape of C:/dev/swarmup-testbed/rubrics/code-quality.md: five criteria, weights summing to 1.
    const text = `---
id: code-quality
scale: { min: 0, max: 4 }
criteria:
  - { id: readability, weight: 0.25, describe: Names. }
  - { id: conventions, weight: 0.2, describe: Patterns. }
  - { id: design, weight: 0.25, describe: Layers. }
  - { id: scope, weight: 0.1, describe: Scope. }
  - { id: tests, weight: 0.2, describe: Tests. }
inputs: [diff, task, repo]
---
Body.
`;
    const r = parseRubric(text);
    // The testbed's worked example: (0.25 x 3 + 0.2 x 2 + 0.25 x 2 + 0.1 x 1 + 0.2 x 0) / 4.
    const total = weightedTotal(r, {
      readability: 3,
      conventions: 2,
      design: 2,
      scope: 1,
      tests: 0,
    });
    expect(total).toBeCloseTo(1.75);
    expect(normalizeScore(r, total)).toBeCloseTo(0.4375);
  });
});

describe('normalizeScore', () => {
  it('maps the scale to 0..1 and clamps', () => {
    const r = { scale: { min: 1, max: 5 } };
    expect(normalizeScore(r, 1)).toBe(0);
    expect(normalizeScore(r, 3)).toBe(0.5);
    expect(normalizeScore(r, 5)).toBe(1);
    expect(normalizeScore(r, 9)).toBe(1);
  });
});

describe('judgePrompt', () => {
  it('holds the rubric, the criterion, the inputs it names and the answer format', () => {
    const p = judgePrompt(rubric(), {
      task: '# Add a flag\n\nAdd --payee.',
      diff: 'diff --git a/x.py b/x.py\n+print(1)\n',
      repo: [{ path: 'x.py', text: 'print(1)\n' }],
      files: [{ path: 'never.md', text: 'not asked for' }],
      criterion: { id: 'quality', text: 'The change reads like the codebase.' },
    });
    expect(p).toContain('# Rubric: code-quality');
    expect(p).toContain('Score each criterion from 0 to 4');
    expect(p).toContain('- `tests` (weight 0.5): New behavior has focused tests.');
    expect(p).toContain('Score each criterion with the anchors.');
    expect(p).toContain('The change reads like the codebase.');
    expect(p).toContain('Add --payee.');
    expect(p).toContain('+print(1)');
    expect(p).toContain('## `x.py`');
    // `files` is not among the rubric's inputs.
    expect(p).not.toContain('never.md');
    expect(p).toContain('"readability": "<0 to 4>"');
    expect(p).toContain('no tools');
  });

  it('cuts a long diff and long files with a note', () => {
    const line = `+${'x'.repeat(99)}\n`;
    const diff = line.repeat(Math.ceil((DIFF_CAP * 2) / line.length));
    const big = 'y'.repeat(FILE_CAP * 2);
    const p = judgePrompt(rubric(), {
      task: 't',
      diff,
      repo: [{ path: 'big.txt', text: big }],
    });
    expect(p).toMatch(/\[diff cut: showing \d+ of \d+ characters\]/);
    expect(p).toMatch(/\[file cut: showing \d+ of \d+ characters\]/);
    expect(p.length).toBeLessThan(DIFF_CAP + FILE_CAP + 5000);
  });

  it("shows the run's kept files for the artifacts input: text in full, images by name", () => {
    const r = parseRubric(
      RUBRIC.replace('inputs: [diff, task, repo]', 'inputs: [task, artifacts]'),
      'a.md',
    );
    expect(r.inputs).toEqual(['task', 'artifacts']);
    const p = judgePrompt(r, {
      task: 't',
      diff: '+not asked for',
      artifacts: [
        { name: 'home.png', type: 'image/png', bytes: 2048, label: 'Home page' },
        { name: 'report.txt', type: 'text/plain', bytes: 9, text: 'all green' },
      ],
    });
    expect(p).toContain("# Files the work's run kept (`artifacts`)");
    expect(p).toContain('- `home.png` (image/png, 2048 bytes): Home page');
    expect(p).toContain('(an image: not shown here)');
    expect(p).toContain('all green');
    expect(p).not.toContain('not asked for');
    expect(judgePrompt(r, { task: 't' })).toMatch(/kept \(`artifacts`\)\n\n\(none\)/);
  });

  it('fences a diff that holds backticks with a longer fence', () => {
    const p = judgePrompt(rubric(), { task: 't', diff: '+```js\n+code\n+```\n' });
    expect(p).toContain('````diff\n+```js');
  });

  it('says when the diff is empty', () => {
    expect(judgePrompt(rubric(), { task: 't', diff: '' })).toContain(
      '(no change: the diff is empty)',
    );
  });
});

describe('capText', () => {
  it('leaves short text alone and cuts at a line end', () => {
    expect(capText('abc', 10, 'x')).toBe('abc');
    const out = capText('aaaa\nbbbb\ncccc\n', 11, 'diff');
    expect(out).toBe('aaaa\nbbbb\n[diff cut: showing 9 of 15 characters]');
  });
});

describe('diffPaths and matchGlobs', () => {
  it('lists added and changed files and skips deleted ones', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '+x',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      'diff --git a/new.md b/new.md',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.md',
      '@@ -0,0 +1 @@',
      '+hi',
      'diff --git a/old.txt b/moved.txt',
      'similarity index 100%',
      'rename from old.txt',
      'rename to moved.txt',
      '',
    ].join('\n');
    expect(diffPaths(diff)).toEqual(['src/a.ts', 'new.md', 'moved.txt']);
  });

  it('matches * inside a segment and ** across folders', () => {
    const paths = ['README.md', 'docs/a.md', 'docs/sub/b.md', 'src/x.ts'];
    expect(matchGlobs(paths, ['docs/*.md'])).toEqual(['docs/a.md']);
    expect(matchGlobs(paths, ['docs/**/*.md'])).toEqual(['docs/a.md', 'docs/sub/b.md']);
    expect(matchGlobs(paths, ['**/*.md'])).toEqual(['README.md', 'docs/a.md', 'docs/sub/b.md']);
    expect(matchGlobs(paths, ['./src/x.ts'])).toEqual(['src/x.ts']);
  });
});

describe('extractJudgeJson and parseJudgeAnswer', () => {
  const good = { scores: { readability: 3, design: 2, tests: 4 }, total: 1, reasons: 'Fine.' };

  it('reads a bare answer and works the total out itself', () => {
    const a = parseJudgeAnswer(rubric(), JSON.stringify(good));
    expect(a.scores).toEqual({ readability: 3, design: 2, tests: 4 });
    // 0.25 x 3 + 0.25 x 2 + 0.5 x 4 = 3.25, not the model's 1.
    expect(a.total).toBeCloseTo(3.25);
    expect(a.modelTotal).toBe(1);
    expect(a.score).toBeCloseTo(0.8125);
    expect(a.reasons).toBe('Fine.');
  });

  it('reads an answer in a fence among prose, and takes the last one', () => {
    const out = [
      'Let me think. A draft: {"scores": {"readability": 0, "design": 0, "tests": 0}}',
      '',
      'Final answer:',
      '```json',
      JSON.stringify(good, null, 2),
      '```',
      'Hope that helps {not json}.',
    ].join('\n');
    expect(parseJudgeAnswer(rubric(), out).scores.tests).toBe(4);
  });

  it('copes with braces inside strings and objects around the answer', () => {
    const out = `{"note": "a } brace", "answer": ${JSON.stringify({ ...good, reasons: 'uses {x} and "y"' })}}`;
    const json = extractJudgeJson(out);
    expect(json).toMatchObject({ reasons: 'uses {x} and "y"' });
  });

  it('accepts numbers given as text', () => {
    const a = parseJudgeAnswer(
      rubric(),
      JSON.stringify({ scores: { readability: '3', design: '2.5', tests: 1 }, reasons: '' }),
    );
    expect(a.scores.design).toBe(2.5);
  });

  it('refuses an answer with no JSON, a missing score or a score off the scale', () => {
    expect(() => parseJudgeAnswer(rubric(), 'I think it is good.')).toThrow(/no JSON object/);
    expect(() =>
      parseJudgeAnswer(rubric(), JSON.stringify({ scores: { readability: 3, design: 2 } })),
    ).toThrow(/no score for tests/);
    expect(() =>
      parseJudgeAnswer(
        rubric(),
        JSON.stringify({ scores: { readability: 3, design: 2, tests: 7 } }),
      ),
    ).toThrow(/score of tests is 7, outside the scale 0 to 4/);
    expect(() => parseJudgeAnswer(rubric(), '{"scores": [1, 2, 3]}')).toThrow(/scores must be/);
  });

  it('ignores ids the rubric does not have and cuts long reasons', () => {
    const a = parseJudgeAnswer(
      rubric(),
      JSON.stringify({ scores: { ...good.scores, extra: 99 }, reasons: 'r'.repeat(5000) }),
    );
    expect(a.scores).not.toHaveProperty('extra');
    expect(a.reasons.length).toBeLessThanOrEqual(2001);
  });
});
