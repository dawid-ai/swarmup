import { ESLint } from 'eslint';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFileInfo } from 'prettier';
import { describe, expect, it } from 'vitest';

const top = fileURLToPath(new URL('../../..', import.meta.url));

describe('lint configuration', () => {
  const generated = join(
    top,
    'out',
    'wt-AO-0001',
    'packages',
    'desktop',
    'release',
    'app',
    'generated.js',
  );

  it('keeps ESLint out of task worktrees (AO-0379)', async () => {
    const eslint = new ESLint({ cwd: top });

    await expect(eslint.isPathIgnored(generated)).resolves.toBe(true);
    await expect(
      eslint.isPathIgnored(join(top, 'packages', 'core', 'src', 'model.ts')),
    ).resolves.toBe(false);
  });

  it('keeps Prettier out of task worktrees (AO-0379)', async () => {
    await expect(
      getFileInfo(generated, { ignorePath: join(top, '.prettierignore') }),
    ).resolves.toMatchObject({ ignored: true });
  });
});
