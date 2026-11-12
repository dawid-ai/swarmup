// Child processes started from a worker thread (AO-0171): the same output and failures as
// `execFile`, and nothing started on the calling thread, whose event loop opsd's API runs on.
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { ExecFailure } from '../src/index.js';
import { execOffThread } from '../src/index.js';
import { gitAsync } from '../src/git-steps.js';

const node = process.execPath;

describe('execOffThread', () => {
  it('returns standard output, with the input, environment and folder it was given', async () => {
    const script =
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(s+"|"+process.env.EXEC_T+"|"+process.cwd()))';
    const out = await execOffThread(node, ['-e', script], {
      input: 'typed',
      env: { ...process.env, EXEC_T: 'set' },
      cwd: process.cwd(),
    });
    expect(out).toBe(`typed|set|${process.cwd()}`);
  });

  it('fails the way execFile does: exit code, stdout and stderr', async () => {
    const err = (await execOffThread(node, [
      '-e',
      'process.stdout.write("o");process.stderr.write("e");process.exit(3)',
    ]).catch((e: unknown) => e)) as ExecFailure;
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 3, stdout: 'o', stderr: 'e' });
  });

  it('stops a command at its timeout and says it was killed', async () => {
    const err = (await execOffThread(node, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 300,
    }).catch((e: unknown) => e)) as ExecFailure;
    expect(err.killed).toBe(true);
  });

  it('names the stream that printed too much and keeps each stream up to the limit', async () => {
    const run = (script: string): Promise<ExecFailure> =>
      execOffThread(node, ['-e', script], { maxBuffer: 10 }).catch(
        (e: unknown) => e,
      ) as Promise<ExecFailure>;
    const code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

    const out = await run('process.stdout.write("o".repeat(25));process.stderr.write("e")');
    expect(out.message).toBe('stdout maxBuffer length exceeded');
    expect(out).toMatchObject({ code, stdout: 'o'.repeat(10), stderr: 'e' });

    const err = await run('process.stdout.write("o");process.stderr.write("e".repeat(25))');
    expect(err.message).toBe('stderr maxBuffer length exceeded');
    expect(err).toMatchObject({ code, stdout: 'o', stderr: 'e'.repeat(10) });

    const both = await run(
      'process.stdout.write("o".repeat(25));process.stderr.write("e".repeat(25))',
    );
    expect(both.message).toBe('stdout maxBuffer length exceeded');
    expect(both).toMatchObject({ code, stdout: 'o'.repeat(10), stderr: 'e'.repeat(10) });
  });

  it('answers while the calling thread starts long-lived processes at the same time', async () => {
    // On Windows, a process started on the calling thread while the worker starts one can inherit
    // the worker's child pipes; a pipe held open by a long-lived run never reports its end.
    const runs: ChildProcess[] = [];
    const calls: Array<Promise<string>> = [];
    try {
      for (let i = 0; i < 30; i++) {
        calls.push(execOffThread(node, ['-e', 'process.stdout.write("ok")']));
        runs.push(
          spawn(node, ['-e', 'setInterval(() => {}, 1000)'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          }),
        );
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<string>((res) => {
        timer = setTimeout(() => res('late'), 20_000);
      });
      const outs = await Promise.race([Promise.all(calls), late]);
      clearTimeout(timer);
      expect(outs).toEqual(calls.map(() => 'ok'));
    } finally {
      for (const r of runs) r.kill();
    }
  }, 60_000);

  it('starts nothing on the calling thread', async () => {
    const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
    const names = ['spawn', 'execFile', 'spawnSync', 'execFileSync'];
    const orig = Object.fromEntries(names.map((n) => [n, cp[n]]));
    const calls: string[] = [];
    for (const n of names) {
      cp[n] = (...a: unknown[]) => {
        calls.push(n);
        return (orig[n] as (...x: unknown[]) => unknown)(...a);
      };
    }
    syncBuiltinESMExports();
    try {
      expect((await gitAsync(process.cwd(), ['--version'])).startsWith('git version')).toBe(true);
      await execOffThread(node, ['-e', '0']);
    } finally {
      for (const n of names) cp[n] = orig[n];
      syncBuiltinESMExports();
    }
    expect(calls).toEqual([]);
  });
});
