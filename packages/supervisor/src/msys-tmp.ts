import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * Runs a program and resolves its stdout, or null when it fails. Injected in tests.
 */
export type RunFile = (file: string, args: string[]) => Promise<string | null>;

const runFile: RunFile = (file, args) =>
  new Promise((done) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000, encoding: 'utf8' }, (err, stdout) =>
      done(err ? null : stdout),
    );
  });

/**
 * The Windows folder Git Bash mounts as `/tmp`, or null when there is no Git Bash or it cannot
 * tell. Git for Windows mounts `/tmp` on the `TEMP` of the first MSYS process of a session, and
 * keeps that mount while any MSYS process lives. A run's bash starts with `TEMP` set to the run's
 * scratch folder, so that folder can stay `/tmp` for every later Git Bash on the machine for days.
 * Once scratch cleanup removes it, each bash warns "could not find /tmp" and git hooks write the
 * warning to stderr.
 */
export async function msysTmpDir(run: RunFile = runFile): Promise<string | null> {
  if (process.platform !== 'win32' && run === runFile) return null;
  const exec = (await run('git', ['--exec-path']))?.trim();
  if (!exec) return null;
  // `<git>/mingw64/libexec/git-core` -> `<git>/usr/bin/cygpath.exe`
  const cygpath = join(resolve(exec, '..', '..', '..'), 'usr', 'bin', 'cygpath.exe');
  const tmp = (await run(cygpath, ['-w', '/tmp']))?.trim();
  return tmp ? resolve(tmp) : null;
}
