import { describe, expect, it } from 'vitest';
import { checkCommand, checksFor, opsdConfig, pathSelector } from '../src/index.js';

describe('merge checks by path (AO-0382)', () => {
  it('selects paths with the last matching pattern, where ! takes them out', () => {
    const code = pathSelector(['**', '!**/*.md', '!assets/**', 'assets/*.svg']);
    expect(code('packages/core/src/sync.ts')).toBe(true);
    expect(code('package.json')).toBe(true);
    expect(code('README.md')).toBe(false);
    expect(code('docs/supervisor.md')).toBe(false);
    expect(code('assets/logo.png')).toBe(false);
    // A later pattern takes a path back in.
    expect(code('assets/logo.svg')).toBe(true);
    // Only exclusions select nothing.
    expect(pathSelector(['!**/*.md'])('code.ts')).toBe(false);
  });

  it('runs bare commands always and path-scoped ones only for a change they reach', () => {
    const checks = [
      'node leaks.mjs',
      { run: 'pnpm run typecheck', paths: ['**/*.ts', 'tsconfig*.json'] },
      { run: 'pnpm run lint', paths: ['**', '!changelog.d/**'] },
      { run: 'node links.mjs', paths: ['*.md'] },
    ];
    expect(checksFor(checks, ['docs/guide.md', 'changelog.d/x.fixed.md'])).toEqual({
      run: ['node leaks.mjs', 'pnpm run lint', 'node links.mjs'],
      skipped: ['pnpm run typecheck'],
    });
    expect(checksFor(checks, ['changelog.d/x.fixed.md'])).toEqual({
      run: ['node leaks.mjs', 'node links.mjs'],
      skipped: ['pnpm run typecheck', 'pnpm run lint'],
    });
    expect(checksFor(checks, ['packages/core/src/a.ts'])).toEqual({
      run: ['node leaks.mjs', 'pnpm run typecheck', 'pnpm run lint'],
      skipped: ['node links.mjs'],
    });
    // No changed file: no path-scoped check runs.
    expect(checksFor(checks, []).run).toEqual(['node leaks.mjs']);
    expect(checks.map(checkCommand)).toEqual([
      'node leaks.mjs',
      'pnpm run typecheck',
      'pnpm run lint',
      'node links.mjs',
    ]);
  });

  it('reads checks as commands or { run, paths } and refuses other shapes', () => {
    const merge = (checks: unknown) =>
      opsdConfig({ opsd: { merge: { x: { base: 'main', checks: checks as string[] } } } }).merge.x!
        .checks;
    expect(merge(['npm test'])).toEqual(['npm test']);
    expect(merge(['npm ci', { run: 'npm test', paths: ['**', '!**/*.md'] }])).toEqual([
      'npm ci',
      { run: 'npm test', paths: ['**', '!**/*.md'] },
    ]);
    expect(merge(undefined)).toBeUndefined();
    const usage = 'swarmupd.merge.x.checks: use a list of commands';
    expect(() => merge('npm test')).toThrow(usage);
    expect(() => merge([''])).toThrow(usage);
    expect(() => merge([{ run: 'npm test' }])).toThrow(usage);
    expect(() => merge([{ run: 'npm test', paths: [] }])).toThrow(usage);
    expect(() => merge([{ run: 'npm test', paths: ['!'] }])).toThrow(usage);
    expect(() => merge([{ run: '', paths: ['**'] }])).toThrow(usage);
    expect(() => merge([{ run: 'npm test', paths: ['**'], when: 'x' }])).toThrow(
      'swarmupd.merge.x.checks: unknown key when; use run and paths',
    );
  });
});
