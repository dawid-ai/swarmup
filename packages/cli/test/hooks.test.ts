import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run, sandboxSyncFailure } from '../src/cli.js';
import {
  installClaudeHooks,
  mergeClaudeHooks,
  OLD_SYNC_HOOK_COMMAND,
  SYNC_HOOK_COMMAND,
  SYNC_HOOK_TIMEOUT,
} from '../src/hooks.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-hooks-'));
  dirs.push(d);
  return d;
}

describe('Claude Code hooks', () => {
  it('replaces the hook written before the rename with the swarmup one (AO-0199)', () => {
    const old = { type: 'command', command: OLD_SYNC_HOOK_COMMAND, timeout: 30 };
    const res = mergeClaudeHooks({ hooks: { SessionEnd: [{ hooks: [old] }] } });
    expect(res.added).toEqual(['SessionEnd', 'PreCompact']);
    expect(res.settings.hooks?.SessionEnd).toEqual([
      { hooks: [{ type: 'command', command: SYNC_HOOK_COMMAND, timeout: 30 }] },
    ]);
    expect(JSON.stringify(res.settings)).not.toContain(OLD_SYNC_HOOK_COMMAND);
  });

  it('adds SessionEnd and PreCompact once and keeps other settings', () => {
    const start = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
    };
    const first = mergeClaudeHooks(start);
    expect(first.added).toEqual(['SessionEnd', 'PreCompact']);
    expect(first.settings.permissions).toEqual(start.permissions);
    expect(first.settings.hooks?.SessionEnd).toHaveLength(2);
    const second = mergeClaudeHooks(first.settings);
    expect(second.added).toEqual([]);
    expect(second.settings).toEqual(first.settings);
  });

  it('writes .claude/settings.json and refuses a broken file', () => {
    const d = temp();
    const res = installClaudeHooks(d);
    expect(res.added).toHaveLength(2);
    const saved = JSON.parse(readFileSync(res.file, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(saved.hooks.PreCompact![0]!.hooks[0]!.command).toBe(SYNC_HOOK_COMMAND);
    // SessionEnd hooks get 1.5 s unless they set a timeout; sync needs more.
    expect(saved.hooks.SessionEnd![0]!.hooks[0]).toMatchObject({ timeout: SYNC_HOOK_TIMEOUT });
    expect(installClaudeHooks(d).added).toEqual([]);

    const broken = temp();
    mkdirSync(join(broken, '.claude'));
    writeFileSync(join(broken, '.claude', 'settings.json'), '{oops');
    expect(() => installClaudeHooks(broken)).toThrow(/not valid JSON/);
    expect(readFileSync(join(broken, '.claude', 'settings.json'), 'utf8')).toBe('{oops');
  });
});

describe('hook upgrade', () => {
  it('adds the timeout to a sync hook written without one', () => {
    const old = {
      hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: SYNC_HOOK_COMMAND }] }] },
    };
    const res = mergeClaudeHooks(old);
    expect(res.added).toEqual(['SessionEnd', 'PreCompact']);
    const end = (res.settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).SessionEnd!;
    expect(end).toHaveLength(1);
    expect(end[0]!.hooks[0]).toEqual({
      type: 'command',
      command: SYNC_HOOK_COMMAND,
      timeout: SYNC_HOOK_TIMEOUT,
    });
  });
});

describe('sync from a hook', () => {
  it('exits 0 where there is no data root', () => {
    const d = temp();
    const out: string[] = [];
    const env = { SWARMUP_CONFIG: join(d, 'none.yml') } as NodeJS.ProcessEnv;
    const io = { out: (l: string) => out.push(l), err: () => {}, env, cwd: d };
    expect(run(['sync', '--session-end'], io)).toBe(0);
    expect(out).toEqual(['no data root here; nothing to sync']);
    expect(run(['sync'], io)).toBe(2);
  });

  it('tells a sandbox failure from one the run should hear of (AO-0296)', () => {
    for (const refused of [
      "git add -A -- .swarmup: fatal: Unable to create 'C:/dev/store/.git/index.lock': Permission denied",
      "EPERM: operation not permitted, open 'C:\\dev\\store\\.swarmup\\.ops\\locks\\git.lock'",
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      'fatal: Could not read from remote repository.',
    ]) {
      expect(sandboxSyncFailure(refused)).toBe(true);
    }
    for (const real of [
      'leak check failed; nothing was committed:\n  tasks/T-0001/task.md:3 (github-token)',
      '! [rejected] main -> main (fetch first)',
      'CONFLICT (content): Merge conflict in .swarmup/config.yml',
    ]) {
      expect(sandboxSyncFailure(real)).toBe(false);
    }
  });

  it('leaves the closing sync to swarmupd in a supervised run that cannot push (AO-0296)', () => {
    const d = temp();
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: d, windowsHide: true, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    const remote = join(temp(), 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', remote], { windowsHide: true });
    const state = temp();
    const base = {
      SWARMUP_CONFIG: join(d, 'none.yml'),
      SWARMUP_AGENT: 'human:dawid',
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const call = (env: NodeJS.ProcessEnv, ...argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env, cwd: d };
      return { code: run(argv, io), out: out.join('\n'), err: err.join('\n') };
    };
    expect(call(base, 'init', '--name', 'demo', '--human', 'human:dawid').code).toBe(0);
    git('add', '-A');
    git('commit', '-qm', 'start');
    git('remote', 'add', 'origin', remote);
    git('push', '-q', '-u', 'origin', 'HEAD');
    // The remote is out of reach from here on, as a sandbox without network has it.
    git('remote', 'set-url', 'origin', join(d, 'no-such-remote.git'));
    expect(call(base, 'new', 'Write docs').code).toBe(0);
    // Outside a supervised run the failure stays a failure.
    const alone = call(base, 'sync', '--session-end');
    expect(alone.code).toBe(1);
    expect(alone.err).toContain('remote');
    // A run id without a run record of this state folder is no supervised run either.
    const inRun = { ...base, SWARMUP_RUN: 'r1', SWARMUP_RUN_STATE_DIR: state };
    expect(call(inRun, 'sync', '--session-end').code).toBe(1);
    mkdirSync(join(state, 'runs'));
    writeFileSync(join(state, 'runs', 'r1.json'), '{}');
    const deferred = call(inRun, 'sync', '--session-end');
    expect(deferred.code).toBe(0);
    expect(deferred.out).toMatch(/^not synced from this run: /);
    expect(deferred.out).toContain('swarmupd commits and pushes the task store when this run ends');
    // Only the closing sync is left to swarmupd: a sync the run asks for by itself still fails.
    expect(call(inRun, 'sync', '--push').code).toBe(1);
  });
});
