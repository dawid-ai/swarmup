import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
// Resolved like any import, so a worktree without its own node_modules finds the tsc of the
// checkout that holds it.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const dir = mkdtempSync(join(tmpdir(), 'swarmup-build-config-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function build(): number | null {
  return spawnSync(process.execPath, [tsc, '-b', dir], { cwd: dir, windowsHide: true }).status;
}

describe('the shared build config', () => {
  // The global `swarmup` command runs `packages/cli/dist` of the checkout swarmupd builds after a
  // merge. A build that fails there must leave the last working one in place (AO-0218).
  it('keeps the earlier output when a build fails', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(repoTop, 'tsconfig.base.json'),
        compilerOptions: { rootDir: 'src', outDir: 'dist', types: [] },
        include: ['src'],
      }),
    );
    mkdirSync(join(dir, 'src'));
    const src = join(dir, 'src', 'a.ts');
    const out = join(dir, 'dist', 'a.js');
    writeFileSync(src, "export const a = 'works';\n");
    expect(build()).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('works');

    // What the stale install after AO-0199 looked like: an import that does not resolve.
    writeFileSync(src, "import { b } from '@swarmup/not-installed';\nexport const a = b;\n");
    // `tsc -b` compares file times: a rewrite in the same clock tick as the first build's output
    // counts as up to date and builds nothing. Date the source after that output (AO-0253).
    const later = new Date(Date.now() + 60_000);
    utimesSync(src, later, later);
    expect(build()).not.toBe(0);
    const kept = readFileSync(out, 'utf8');
    expect(kept).toContain('works');
    expect(kept).not.toContain('not-installed');
  }, 120_000);
});
