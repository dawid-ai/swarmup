- An LLM judge scores `rubric` criteria against their rubric file (frontmatter `id`, `scale`,
  weighted `criteria`, `inputs`; a body with the judge's instructions). The judge is one
  read-only model call with no tools and everything in the prompt; it answers with JSON, and the
  weighted total, normalized to 0 to 1, passes at the criterion's `pass`. Configure it in
  `swarmupd.judge` (`runtime`, `model`, `effort`, `budget_min`; default Claude, `sonnet`, `low`,
  5 minutes).
- `swarmup bench run ... --judge` judges each attempt's rubric criteria, and
  `swarmup bench judge RUN-DIR` judges a finished run's pending ones. Judged rubric criteria count
  in the pass rate; the summary gains a **Judged** column and the judge's cost.
- `swarmup criteria judge ID` judges a task's rubric criteria against its branch diff and records
  the results in a `criteria-check` event with `by: judge`. The desktop app's task panel has a
  **Judge** button next to **Run checks**, and shows each judged score and its reasons.
- With `swarmupd.judge.at_merge: true`, swarmupd judges rubric criteria at merge after the
  `command` and `check` criteria pass, and sends the task back when one scores below its `pass`.
  Off by default: each judgment spends tokens.
