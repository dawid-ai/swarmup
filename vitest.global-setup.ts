import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Builds packages/core once, before any test file starts. Fake agents and other child processes in
// the tests import the built core; the supervisor-*.test.ts files share one setup, and five of them
// running `tsc -b packages/core` at once could each rewrite a file another one's agent was reading
// (AO-0397). Files that still build core in their own hooks find it up to date.
export default function setup(): void {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const repoTop = fileURLToPath(new URL('.', import.meta.url));
  execFileSync(process.execPath, [tsc, '-b', 'packages/core'], { cwd: repoTop, windowsHide: true });
}
