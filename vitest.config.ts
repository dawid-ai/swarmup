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
    // Every file spawns git and node processes, so one worker per core starves them: in a merge
    // check the 1-test mirror files took 60-90 s and the old supervisor.test.ts 810 s. Half the
    // cores keeps those processes fed. The slowest file sets the wall time, so keep each git-heavy
    // file under about 8 minutes of tests: supervisor.test.ts and merge.test.ts each ran 25-28
    // minutes in merge checks and were split into supervisor-*.test.ts and merge-*.test.ts (AO-0397).
    maxWorkers: '50%',
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
