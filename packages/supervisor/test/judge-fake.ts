// A fake judge for tests: Claude's result line and a runner that answers from the prompt.
import type { JudgeProcess, JudgeRunner } from '@swarmup/supervisor';

/** A rubric with two equal criteria on a 0 to 4 scale that asks for the diff, task and repo. */
export const RUBRIC_TEXT = `---
id: quality
scale: { min: 0, max: 4 }
criteria:
  - { id: readability, weight: 0.5, describe: Easy to follow. }
  - { id: tests, weight: 0.5, describe: Has tests. }
inputs: [diff, task, repo]
---
Judge the change.
`;

/** Claude's `--output-format json` result with `answer` as its text. */
export function claudeResult(answer: unknown, cost = 0.0123): string {
  return `${JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: typeof answer === 'string' ? answer : JSON.stringify(answer),
    total_cost_usd: cost,
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 100 } },
  })}\n`;
}

/** A fake runner that answers with `answer(prompt)` and keeps every process it was given. */
export function fakeRunner(answer: (p: JudgeProcess) => string): {
  runner: JudgeRunner;
  calls: JudgeProcess[];
} {
  const calls: JudgeProcess[] = [];
  return {
    calls,
    runner: async (p) => {
      calls.push(p);
      return { exitCode: 0, timedOut: false, stdout: answer(p), stderr: '' };
    },
  };
}
