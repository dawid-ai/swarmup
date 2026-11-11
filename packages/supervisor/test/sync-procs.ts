// Records child processes that opsd's sources run synchronously, such as git or PowerShell. Each
// blocks opsd's event loop, and so every API request, while it runs (AO-0171, AO-0205). Tests
// run git themselves too; only calls made from a package's `src` count.
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const cp = require('node:child_process') as Record<string, (...a: unknown[]) => unknown>;

export interface SyncProc {
  /** The command and its arguments. */
  command: string;
  ms: number;
  /** The first stack frame in a package's `src`. */
  at: string;
}

const SRC = /[\\/]packages[\\/][a-z]+[\\/]src[\\/]/;
const NAMES = ['execFileSync', 'spawnSync', 'execSync'] as const;

/**
 * Starts recording. `node:child_process` named imports are live bindings of the built-in
 * module, so `syncBuiltinESMExports` makes the sources call the wrappers.
 */
export function spySyncProcs(): { calls: SyncProc[]; restore: () => void } {
  const calls: SyncProc[] = [];
  const orig = Object.fromEntries(NAMES.map((n) => [n, cp[n]!])) as Record<
    (typeof NAMES)[number],
    (...a: unknown[]) => unknown
  >;
  for (const n of NAMES) {
    cp[n] = function (this: unknown, file: unknown, args: unknown, ...rest: unknown[]) {
      const t0 = performance.now();
      try {
        return orig[n].call(this, file, args, ...rest);
      } finally {
        const frame = (new Error().stack ?? '').split('\n').find((l) => SRC.test(l));
        if (frame) {
          calls.push({
            command: [String(file), ...(Array.isArray(args) ? (args as string[]) : [])].join(' '),
            ms: performance.now() - t0,
            at: frame.trim(),
          });
        }
      }
    };
  }
  syncBuiltinESMExports();
  return {
    calls,
    restore: () => {
      for (const n of NAMES) cp[n] = orig[n];
      syncBuiltinESMExports();
    },
  };
}
