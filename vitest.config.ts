import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against the package sources, so they need no build first.
    alias: {
      '@swarmup/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      '@swarmup/supervisor': fileURLToPath(
        new URL('./packages/supervisor/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // A hang guard, not a speed limit: the git-heavy tests (mirror, sync, push, merge, supervisor)
    // take ~10-20 s each alone on Windows, and went past 60 s under full-suite load in the opsd
    // merge checks (AO-0183, AO-0189). Hooks clean up git repos and stop daemons, so they get the
    // old test limit instead of vitest's 10 s.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    // Every file spawns git and node processes, and on the Windows dev machine process creation is
    // the bottleneck: `git --version` from 4 concurrent loops gives 2.3 spawns/s, from 12 loops
    // 2.5/s, but each spawn then waits 4.8 s instead of 1.75 s (AO-0394). With 12 workers (half
    // of 24 cores) a git-heavy test of ~80 spawns took 360 s and passed its 180 s limit in a merge
    // check, for no gain in wall time. So at most 4 workers, and half the cores on smaller machines.
    // `--maxWorkers=N` on the command line still overrides it.
    // The slowest file sets the wall time, so keep each git-heavy file under about 8 minutes of
    // tests: supervisor.test.ts and merge.test.ts each ran 25-28 minutes in merge checks and were
    // split into supervisor-*.test.ts and merge-*.test.ts (AO-0397).
    maxWorkers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    // Builds packages/core once before the workers start, so split files don't race on `tsc -b`.
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
