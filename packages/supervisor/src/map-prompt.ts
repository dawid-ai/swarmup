import { resolve } from 'node:path';
import type { MapPrompt, Workspace } from '@swarmup/core';
import { mapPromptOf, mapReviewWarnings } from '@swarmup/core';

/** Most map nodes a task run's prompt lists; the agent finds more with `swarmup map`. */
export const TASK_MAP_NODES = 5;

/**
 * The project map block of a task run's prompt: from the first of `tops` (the run's checkout,
 * then the code checkout of the task's root) that has a map, with the nodes that match the task.
 * A review run also gets the `map check` warnings of the reviewed commit against `base`. Null
 * when no checkout has a map or the task cannot be read: a map never stops a run.
 */
export function taskMapPrompt(
  ws: Workspace,
  ref: string,
  tops: Array<string | null | undefined>,
  opts: { review?: boolean; base?: string } = {},
): MapPrompt | undefined {
  try {
    const shown = ws.showEvents(ref);
    const seen = new Set<string>();
    for (const t of tops) {
      if (!t) continue;
      const top = resolve(t);
      if (seen.has(top.toLowerCase())) continue;
      seen.add(top.toLowerCase());
      const map = mapPromptOf(top, { title: shown.meta.title, body: shown.body }, TASK_MAP_NODES);
      if (!map) continue;
      if (opts.review) {
        const request = [...shown.events].reverse().find((e) => e.type === 'review');
        const commit = request?.commit ?? request?.branch;
        if (commit) map.warnings = mapReviewWarnings(top, commit, opts.base);
      }
      return map;
    }
  } catch {
    // The prompt goes without the map.
  }
  return undefined;
}
