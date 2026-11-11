import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
const tsc = join(repoTop, 'node_modules', 'typescript', 'bin', 'tsc');
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
    expect(build()).not.toBe(0);
    const kept = readFileSync(out, 'utf8');
    expect(kept).toContain('works');
    expect(kept).not.toContain('not-installed');
  }, 120_000);
});
