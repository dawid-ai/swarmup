// Built-in scorer settings kept in git (W5 phase 4): each root's `scorers/*.yaml`, read for
// `ScoreOptions.stores`. `scores.ts` stays pure; this file reads the stores.
import type { Workspace } from '@swarmup/core';
import { loadDefinitions } from '@swarmup/core';
import type { GitScorer } from './scores.js';

/**
 * The built-in scorer settings of each root's `scorers/*.yaml` (W5 phase 4), for
 * `ScoreOptions.stores`. A file with an error, and a rubric scorer, give none.
 */
export function gitScorers(ws: Workspace): GitScorer[] {
  const out: GitScorer[] = [];
  for (const root of ws.roots) {
    if (root.isMirror) continue;
    let scorers;
    try {
      scorers = loadDefinitions(root.dir).scorers;
    } catch {
      continue;
    }
    for (const sc of scorers) {
      const d = sc.def;
      if (!d || d.kind !== 'builtin' || !d.scorer) continue;
      out.push({
        root: root.name,
        id: d.id,
        scorer: d.scorer,
        ...(d.pass !== undefined ? { pass: d.pass } : {}),
        ...(d.applies_to ? { applies_to: d.applies_to } : {}),
        ...(d.enabled === false ? { enabled: false } : {}),
      });
    }
  }
  return out;
}
