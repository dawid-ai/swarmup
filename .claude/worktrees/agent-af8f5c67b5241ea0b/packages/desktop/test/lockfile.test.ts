import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const at = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const text = (path: string): string => readFileSync(at(path), 'utf8');
const json = (path: string): Record<string, unknown> =>
  JSON.parse(text(path)) as Record<string, unknown>;

// The repo installs with pnpm from one lockfile, so that task worktrees share the packages in
// pnpm's store (AO-0299). A second lockfile, or a workspace package pinned by version, sends an
// install to the registry for a package that only exists here.
describe('the pnpm workspace', () => {
  it('has pnpm-lock.yaml as its only lockfile', () => {
    expect(existsSync(at('pnpm-lock.yaml'))).toBe(true);
    expect(existsSync(at('package-lock.json'))).toBe(false);
    expect(existsSync(at('npm-shrinkwrap.json'))).toBe(false);
  });

  it('names pnpm as the package manager and lists every package as a workspace', () => {
    expect(json('package.json').packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(json('package.json').workspaces).toBeUndefined();
    const workspace = text('pnpm-workspace.yaml');
    for (const name of ['core', 'cli', 'supervisor', 'desktop']) {
      expect(workspace).toContain(`- packages/${name}\n`);
    }
  });

  it('links the workspace packages to each other with workspace:*', () => {
    for (const name of ['core', 'cli', 'supervisor', 'desktop']) {
      const manifest = json(`packages/${name}/package.json`);
      for (const field of ['dependencies', 'devDependencies']) {
        const deps = (manifest[field] ?? {}) as Record<string, string>;
        for (const [dep, range] of Object.entries(deps)) {
          if (dep.startsWith('@swarmup/')) expect(range, `${name}: ${dep}`).toBe('workspace:*');
        }
      }
    }
  });

  // A flat node_modules without links between packages: the scripts at the top find `electron`
  // and `esbuild` there, and a worktree holds no link farm (AGENTS.md).
  it('installs a flat node_modules', () => {
    expect(text('.npmrc')).toMatch(/^node-linker=hoisted$/m);
  });

  // The lockfile lists the platform packages of the CSS and JS compilers for Windows; the npm
  // lockfile lost them more than once (AO-0229, AO-0254).
  it('locks the Windows platform packages of lightningcss and esbuild', () => {
    const lock = text('pnpm-lock.yaml');
    expect(lock).toMatch(/^ {2}lightningcss-win32-x64-msvc@\d/m);
    expect(lock).toMatch(/^ {2}'@esbuild\/win32-x64@\d/m);
  });
});
