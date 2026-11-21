import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MergeRepo } from '../src/merge.js';
import { runPrompt } from '../src/runtimes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
}

function write(top: string, rel: string, text: string): void {
  const file = join(top, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const map = {
  root: 'A demo project',
  nodes: [{ id: 'core/fold', kind: 'module', summary: 'Folds events into task state' }],
};

describe('project map in the run prompt', () => {
  it('lists the root and the matching nodes, and tells a work run to keep them true', () => {
    const p = runPrompt({ agent: 'codex:backend', task: 'T-0001', map });
    expect(p).toContain('Project map (`.swarmup/map/`): A demo project');
    expect(p).toContain('- `core/fold` (module): Folds events into task state');
    expect(p).toContain('update or add the node on the task branch in the same');
    expect(p).toContain('`swarmup map check` before you ask for review');
  });

  it('asks a reviewer whether a node went wrong, with the check warnings', () => {
    const p = runPrompt({
      agent: 'claude:qa',
      task: 'T-0001',
      review: true,
      map: { ...map, warnings: ['.swarmup/map/core/fold.md: src/fold.ts changed'] },
    });
    expect(p).toContain('made any map node wrong');
    expect(p).toContain('- .swarmup/map/core/fold.md: src/fold.ts changed');
    expect(p).not.toContain('before you ask for review');
  });

  it('adds nothing without a map', () => {
    expect(runPrompt({ agent: 'codex:backend', task: 'T-0001' })).not.toContain('Project map');
  });
});

describe('project map files in a merge', () => {
  it('counts .swarmup/map/ as code, not as task store files', async () => {
    const top = mkdtempSync(join(tmpdir(), 'swarmup-map-merge-'));
    dirs.push(top);
    git(top, 'init', '-q', '-b', 'main');
    git(top, 'config', 'user.email', 'test@example.com');
    git(top, 'config', 'user.name', 'Test');
    write(top, 'src/a.ts', 'a\n');
    git(top, 'add', '-A');
    git(top, 'commit', '-q', '-m', 'start');
    const from = git(top, 'rev-parse', 'HEAD').trim();
    write(top, '.swarmup/map/index.md', '---\nkind: root\nsummary: x\n---\n');
    write(top, '.swarmup/tasks/T-1/task.md', 'x\n');
    git(top, 'add', '-A');
    git(top, 'commit', '-q', '-m', 'map');
    const to = git(top, 'rev-parse', 'HEAD').trim();
    const repo = new MergeRepo(top, join(top, 'wt'), [], process.env);
    expect(await repo.changedFiles(from, to)).toEqual(['.swarmup/map/index.md']);
    expect(await repo.touchedFiles(from, to)).toEqual(['.swarmup/map/index.md']);
    expect(await repo.storeFiles(from, to)).toEqual(['.swarmup/tasks/T-1/task.md']);
    expect(await repo.sameCode(from, to)).toBe(false);
  });
});
