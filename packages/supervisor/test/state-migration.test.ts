// AO-0200: swarmupd's state folder moves once from ~/.agent-ops/opsd to ~/.swarmup/swarmupd.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATION_LOG } from '@swarmup/core';
import { isAlive, migrateStateDir, pickStateDir, RunStore } from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

/** A home folder with an old state folder holding one run, and an env whose log goes there. */
function oldState() {
  const home = mkdtempSync(join(tmpdir(), 'swarmup-state-mig-'));
  dirs.push(home);
  const from = join(home, '.agent-ops', 'opsd');
  const to = join(home, '.swarmup', 'swarmupd');
  const old = new RunStore(from);
  old.save({
    id: '01RUN',
    agent: 'claude:engineer',
    command: 'claude',
    cwd: home,
    log: old.logPath('01RUN'),
    started_at: '2026-11-01T00:00:00.000Z',
    status: 'ended',
    budget_minutes: 60,
  } as Parameters<RunStore['save']>[0]);
  writeFileSync(old.logPath('01RUN'), 'run output\n');
  writeFileSync(join(from, 'usage.json'), '{"claude":1}\n');
  const env = { SWARMUP_CONFIG: join(home, 'cfg', 'config.yml') } as NodeJS.ProcessEnv;
  return { home, from, to, env };
}

describe('swarmupd state folder', () => {
  it('uses the old folder until it moves, then the new one', () => {
    const { from, to } = oldState();
    expect(pickStateDir(to, from)).toBe(from);
    mkdirSync(to, { recursive: true });
    expect(pickStateDir(to, from)).toBe(to);
  });

  it('moves the folder once, keeps runs, usage and logs readable, and logs the move', async () => {
    const { from, to, env, home } = oldState();
    const lines: string[] = [];
    const did = await migrateStateDir(env, { from, to, log: (l) => lines.push(l) });
    expect(did).toBe(`moved ${from} to ${to}`);
    expect(existsSync(from)).toBe(false);
    expect(readFileSync(join(to, 'usage.json'), 'utf8')).toBe('{"claude":1}\n');
    const run = new RunStore(to).get('01RUN')!;
    // The record names its log at the old path; it is read at the new one.
    expect(run.log).toBe(join(to, 'logs', '01RUN.log'));
    expect(readFileSync(run.log, 'utf8')).toBe('run output\n');
    expect(readFileSync(join(home, 'cfg', MIGRATION_LOG), 'utf8')).toMatch(/swarmupd state: moved/);
    expect(lines).toEqual([`swarmupd: moved ${from} to ${to}`]);
    // Already moved: nothing happens, even when an old folder shows up again.
    mkdirSync(from, { recursive: true });
    expect(await migrateStateDir(env, { from, to })).toBeNull();
    expect(existsSync(join(to, 'usage.json'))).toBe(true);
  });

  it('does nothing without an old folder, or when SWARMUP_STATE_DIR names one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarmup-state-mig-'));
    dirs.push(home);
    const to = join(home, 'new');
    expect(await migrateStateDir({}, { from: join(home, 'old'), to })).toBeNull();
    expect(existsSync(to)).toBe(false);
    expect(await migrateStateDir({ SWARMUP_STATE_DIR: home })).toBeNull();
  });

  it('stops a swarmupd still running on the old folder through its own opsd.json', async () => {
    const { from, to, env } = oldState();
    // The old swarmupd: a process of this test, and an API that ends it on shutdown.
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    let asked = '';
    const server = createServer((req, res) => {
      asked = `${req.method} ${req.url} ${req.headers.authorization}`;
      proc.kill();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(from, 'opsd.json'),
        JSON.stringify({ pid: proc.pid, port, token: 'old-token', started_at: '', version: '' }),
      );
      expect(isAlive(proc.pid!)).toBe(true);
      const did = await migrateStateDir(env, { from, to, stopWaitMs: 10_000 });
      expect(asked).toBe('POST /api/shutdown Bearer old-token');
      expect(isAlive(proc.pid!)).toBe(false);
      expect(did).toBe(`moved ${from} to ${to}`);
      expect(readFileSync(join(env.SWARMUP_CONFIG!, '..', MIGRATION_LOG), 'utf8')).toMatch(
        new RegExp(`stopped the swarmupd on .* \\(pid ${proc.pid}, from its opsd.json\\)`),
      );
    } finally {
      server.close();
      if (isAlive(proc.pid!)) proc.kill();
    }
  });
});
