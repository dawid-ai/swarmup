import { patternRegExp } from './test-changes.js';

/**
 * One entry of `swarmupd.merge.<root>.checks` (AO-0382): a command that runs on every merge, or a
 * command with the paths it checks, which runs only when the merge changes one of them. A copy,
 * content or design change then pays for none of the code checks it cannot affect.
 */
export type MergeCheck = string | { run: string; paths: string[] };

/** The command of a check entry. */
export function checkCommand(c: MergeCheck): string {
  return typeof c === 'string' ? c : c.run;
}

/**
 * Whether a path is one of `patterns`: the syntax of `test_changes` (a pattern without `/` matches
 * the file name in any folder; `*` and `?` stay inside one segment, `**` crosses folders), where a
 * pattern that starts with `!` takes paths out again. The last pattern that matches decides, as in
 * `.gitignore`: `['**', '!**\/*.md']` is every file but Markdown.
 */
export function pathSelector(patterns: string[]): (path: string) => boolean {
  const rules = patterns.map((p) => {
    const not = p.startsWith('!');
    return { not, re: patternRegExp(not ? p.slice(1) : p) };
  });
  return (path) => {
    let on = false;
    for (const r of rules) if (r.re.test(path)) on = !r.not;
    return on;
  };
}

/**
 * The commands of `checks` that a merge changing `files` runs, in their order, and the ones it
 * leaves out because it changes none of their paths.
 */
export function checksFor(
  checks: MergeCheck[],
  files: string[],
): { run: string[]; skipped: string[] } {
  const run: string[] = [];
  const skipped: string[] = [];
  for (const c of checks) {
    if (typeof c === 'string') run.push(c);
    else if (files.some(pathSelector(c.paths))) run.push(c.run);
    else skipped.push(c.run);
  }
  return { run, skipped };
}
