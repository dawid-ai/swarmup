import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKTREE_INSTALL, worktreeInstallCommand } from '../src/worktree.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// AO-0380: a task worktree had no `node_modules`, so type-checks in it failed.
describe('worktree install', () => {
  it('installs only a pnpm repo that has no node_modules yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-install-'));
    dirs.push(dir);
    expect(worktreeInstallCommand(dir)).toBeNull();
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    expect(worktreeInstallCommand(dir)).toBeNull();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    expect(worktreeInstallCommand(dir)).toBe(WORKTREE_INSTALL);
    expect(WORKTREE_INSTALL).toBe('pnpm install --frozen-lockfile --prefer-offline');
    mkdirSync(join(dir, 'node_modules'));
    expect(worktreeInstallCommand(dir)).toBeNull();
  });
});
