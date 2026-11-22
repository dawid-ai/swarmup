---
kind: flow
summary: 'The LLM judge of rubric criteria: rubric files, the blind no-tools prompt, the JSON answer, and where it runs'
covers:
  - packages/core/src/rubric.ts
  - packages/supervisor/src/judge.ts
  - packages/core/test/rubric.test.ts
  - packages/supervisor/test/judge.test.ts
  - packages/supervisor/test/judge-fake.ts
  - packages/supervisor/test/bench-judge.test.ts
  - packages/supervisor/test/merge-judge.test.ts
links: [core/fold, bench, supervisor/merge, supervisor, cli, desktop/ui, docs]
---

# Rubric judge

## Purpose

Scores `rubric` criteria, which a model judges against a rubric file, so benchmarks and tasks get
a result for them instead of `pending` or a reviewer's guess.

## How it works

- `core/src/rubric.ts` reads a rubric file (frontmatter `id`, `scale`, weighted `criteria`,
  `inputs`; the body is the judge's instructions), builds the judge's prompt from the rubric, the
  criterion, the task, the diff and files (capped with a note), and parses the answer: the last
  JSON object with `scores` in the output, every score within the scale, the weighted total
  worked out here and normalized to 0..1.
- `supervisor/src/judge.ts` runs one judgment: `claude -p --output-format json --tools ""` (or
  `codex exec --sandbox read-only`) in an empty temp folder with the prompt on stdin, the time
  budget of `swarmupd.judge` (`checkJudge` in `config.ts`) and a kill on timeout. `judgeTask`
  judges a task's rubric criteria against its diff from the merge base; `CriteriaJudges` is the
  app's **Judge**; `judgeVerdict` turns a judgment into a criterion result (score, reasons as
  note, scores as evidence).
- Callers: `bench.ts` (`--judge`, `judgeBenchRun` for `swarmup bench judge`), `cli.ts`
  (`swarmup criteria judge`), `api.ts` (`/api/tasks/:id/criteria-judge`) and `merger.ts`
  (`mergeJudge`, with `swarmupd.judge.at_merge`).

## Invariants

- The judge gets no tools and never learns which agent or model did the work.
- The rubric is read from the base (git at the merge base or the bench entry's base, or beside
  the set file), never from the tree under judgment, which the work may have changed.
- A judgment that gives no score never fails silently: bench leaves the criterion `pending` with
  why, the merge records `na` and goes on, `criteria judge` records nothing and exits 1.
- The runner is injectable (`JudgeRunner`, `Supervisor` option `judgeRunner`), so tests spend no
  tokens.
