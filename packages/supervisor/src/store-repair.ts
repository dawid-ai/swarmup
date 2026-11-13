// Repairs what a Codex sandbox session leaves in a task store on Windows (AO-0287).
//
// A sandboxed Codex run works as the user `CodexSandboxOffline` under a token restricted to SIDs
// of its own session. Codex adds those SIDs to the store folder for each session, and Windows
// passes them down to the files and folders the caller may change the ACL of: the ones the
// signed-in user owns. A file or folder the sandbox user made keeps the ACL it was made with,
// so a later session may read it but not replace it, delete it, or add a file to it. The
// signed-in user is not its owner and cannot change that ACL either, but may delete and rename
// it. So swarmupd, which runs as that user, makes each such file and folder again under the same
// name: the copy belongs to the user and takes the ACL of where it is made, and Codex's next
// session can extend it like the rest of the store.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { execOffThread, lockIsStale, OpsError, type Root, ulid, withLock } from '@swarmup/core';

/**
 * Something in a store that the sandbox user owns: a file, a folder, or `leftover`, the new
 * folder of a rebuild that was cut off (see {@link REBUILD_NAME}).
 */
export interface SandboxOwned {
  path: string;
  kind: 'file' | 'dir' | 'leftover';
}

/** Lists what the sandbox user owns under each folder; never follows a link or enters `.git`. */
export type SandboxLister = (dirs: string[], env: NodeJS.ProcessEnv) => Promise<SandboxOwned[]>;

/** What one repair of one root did. */
export interface StoreRepair {
  /** Files made again. */
  files: number;
  /** Folders made again. */
  dirs: number;
  /** Stale lock files removed. */
  locks: number;
  /** What could not be repaired, and why; the next repair tries again. */
  failed: { path: string; why: string }[];
}

/** How long one listing may take; a store of 11,000 entries takes 1 s. */
const LIST_TIMEOUT_MS = 120_000;
/** A temp file of a write is renamed or removed within milliseconds; after this long it is stale. */
export const STALE_TEMP_MS = 3_600_000;
/** How long a repair waits for a task's lock before it leaves that task for the next repair. */
const TASK_LOCK_MS = 1_000;

/**
 * The folder a rebuild fills before it takes the place of `<name>`: `.<name>.<ulid>.repair` next
 * to it. No reader of a store takes that name for a task, a note or an event.
 */
const REBUILD_NAME = /^\.(.+)\.[0-9A-HJKMNP-TV-Z]{26}\.repair$/;

// Reads only each entry's owner, which costs a fifth of `Get-Acl`. An owner counts when its
// account name starts with `CodexSandbox`: files of other accounts, such as an administrator's,
// are not swarmupd's to make again. The folders arrive in the environment, so no path is quoted.
const LIST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sidType = [Security.Principal.SecurityIdentifier]
$ownerOnly = [Security.AccessControl.AccessControlSections]::Owner
$known = @{}
$out = New-Object System.Text.StringBuilder
$stack = New-Object 'System.Collections.Generic.Stack[string]'
foreach ($d in ($env:SWARMUP_REPAIR_DIRS -split '\\|')) { if ($d) { $stack.Push($d) } }
while ($stack.Count -gt 0) {
  $dir = $stack.Pop()
  try { $entries = [IO.Directory]::GetFileSystemEntries($dir) } catch { continue }
  foreach ($p in $entries) {
    try {
      $attr = [IO.File]::GetAttributes($p)
      if ($attr -band [IO.FileAttributes]::ReparsePoint) { continue }
      $isDir = [bool]($attr -band [IO.FileAttributes]::Directory)
      $kind = 'F'
      if ($isDir) {
        $name = [IO.Path]::GetFileName($p)
        if ($name -eq '.git') { continue }
        if ($name -cmatch '^\\..+\\.[0-9A-HJKMNP-TV-Z]{26}\\.repair$') {
          [void]$out.Append('R').Append([char]9).AppendLine($p)
          continue
        }
        $stack.Push($p)
        $kind = 'D'
        $sec = New-Object Security.AccessControl.DirectorySecurity($p, $ownerOnly)
      } else {
        $sec = New-Object Security.AccessControl.FileSecurity($p, $ownerOnly)
      }
      $sid = $sec.GetOwner($sidType)
      if ($sid.Value -eq $me) { continue }
      if (-not $known.ContainsKey($sid.Value)) {
        $account = ''
        try { $account = $sid.Translate([Security.Principal.NTAccount]).Value } catch { }
        $known[$sid.Value] = ($account -replace '^.*\\\\', '') -like 'CodexSandbox*'
      }
      if ($known[$sid.Value]) { [void]$out.Append($kind).Append([char]9).AppendLine($p) }
    } catch { continue }
  }
}
[Console]::Out.Write($out.ToString())
`;

/** `powershell.exe -EncodedCommand` takes the script as base64 of UTF-16LE. */
const LIST_SCRIPT_ARG = Buffer.from(LIST_SCRIPT, 'utf16le').toString('base64');

/** Reads the lines the listing prints: a kind letter, a tab, a path. */
export function parseSandboxOwned(out: string): SandboxOwned[] {
  const kinds = { F: 'file', D: 'dir', R: 'leftover' } as const;
  const found: SandboxOwned[] = [];
  for (const line of out.split(/\r?\n/)) {
    const kind = kinds[line[0] as keyof typeof kinds];
    if (kind && line[1] === '\t' && line.length > 2) found.push({ path: line.slice(2), kind });
  }
  return found;
}

/**
 * The files and folders under `dirs` that a Codex sandbox user owns, and the folders a cut-off
 * rebuild left. Only Windows has such owners: elsewhere the answer is empty and nothing starts.
 * One PowerShell process reads them all, off the event loop.
 */
export const listSandboxOwned: SandboxLister = async (dirs, env) => {
  if (process.platform !== 'win32' || dirs.length === 0) return [];
  const out = await execOffThread(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', LIST_SCRIPT_ARG],
    // No Windows path holds `|`.
    {
      env: { ...env, SWARMUP_REPAIR_DIRS: dirs.join('|') },
      timeoutMs: LIST_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return parseSandboxOwned(out);
};

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** The path inside the root, with `/` between its parts. */
function inRoot(root: Root, path: string): string {
  return relative(root.dir, path).split(sep).join('/');
}

/** The task whose folder holds the path, when it is a task's file or folder. */
function taskOf(rel: string): string | undefined {
  return /^(?:archive\/)?tasks\/([^/]+)(?:\/|$)/.exec(rel)?.[1];
}

/**
 * Runs `fn` under the lock of the task the path belongs to, so no `swarmup` command writes the
 * task meanwhile. A path outside the tasks needs no lock: its writers replace whole files.
 */
function underTaskLock(root: Root, rel: string, busy: Set<string>, fn: () => void): void {
  const task = taskOf(rel);
  if (!task) return fn();
  // One wait per task and repair: the wait holds the event loop.
  if (busy.has(task)) throw new OpsError(`the lock of ${task} is held`);
  let held = false;
  try {
    withLock(
      join(root.opsDir, 'locks', `task-${task}.lock`),
      () => {
        held = true;
        fn();
      },
      TASK_LOCK_MS,
    );
  } catch (err) {
    if (!held) busy.add(task);
    throw err;
  }
}

/**
 * Makes a file again under its own name: copies it to a temp file, which the user then owns, and
 * renames that over it. The copy keeps the file's times, so caches keyed by them stay valid.
 * Returns false, and changes nothing, when the file is gone or changed while it was copied.
 */
export function remakeFile(root: Root, path: string): boolean {
  let before;
  try {
    before = statSync(path);
  } catch {
    return false;
  }
  if (!before.isFile()) return false;
  const tmpDir = join(root.opsDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${ulid()}.tmp`);
  try {
    copyFileSync(path, tmp);
    utimesSync(tmp, before.atime, before.mtime);
    const now = statSync(path);
    if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
      rmSync(tmp, { force: true });
      return false;
    }
    renameSync(tmp, path);
    return true;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The first error is the one to report.
    }
    throw err;
  }
}

/**
 * Moves each entry of `from` into `to`. A file replaces one of its name there, unless `keep`
 * says the one in `to` is the newer: then it stays, and so does the entry in `from`.
 */
function moveEntries(from: string, to: string, keep = false): void {
  for (const name of readdirSync(from)) {
    if (keep && existsSync(join(to, name))) continue;
    renameSync(join(from, name), join(to, name));
  }
}

/**
 * Moves what `dir` holds into `fresh` and renames `fresh` to `dir`. Between the removal of the
 * emptied `dir` and that rename, two system calls, the folder does not exist. A writer that
 * adds a file before the removal has it moved too; one that makes `dir` again in the gap keeps
 * its folder, and what was moved goes back into it.
 */
function swapDir(dir: string, fresh: string): void {
  for (let round = 0; existsSync(dir); round++) {
    moveEntries(dir, fresh);
    try {
      rmdirSync(dir);
    } catch (err) {
      const code = errorCode(err);
      if (round < 5 && (code === 'ENOTEMPTY' || code === 'EEXIST')) continue;
      throw err;
    }
  }
  try {
    renameSync(fresh, dir);
  } catch (err) {
    if (!existsSync(dir)) throw err;
    moveEntries(fresh, dir, true);
    rmdirSync(fresh);
  }
}

/**
 * Makes a folder again under its own name: a new folder next to it, which the user owns and
 * which takes the parent's ACL, gets everything the old one holds and then its name. What it
 * holds moves as it is; the files the sandbox user owns in it are made again one by one.
 *
 * When a step fails, as for a file another program holds open, everything moves back. If that
 * fails too, the new folder stays, the listing reports it as `leftover`, and
 * {@link finishRebuild} ends the move on the next repair.
 */
export function remakeDir(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const fresh = join(dirname(dir), `.${basename(dir)}.${ulid()}.repair`);
  mkdirSync(fresh);
  try {
    swapDir(dir, fresh);
    return true;
  } catch (err) {
    try {
      if (existsSync(dir)) {
        moveEntries(fresh, dir, true);
        rmdirSync(fresh);
      } else {
        renameSync(fresh, dir);
      }
    } catch {
      // The next repair finishes it; the first error is the one to report.
    }
    throw err;
  }
}

/** Ends a rebuild that was cut off: `fresh` is the folder it left. */
export function finishRebuild(fresh: string): boolean {
  const name = REBUILD_NAME.exec(basename(fresh))?.[1];
  if (!name || !existsSync(fresh)) return false;
  swapDir(join(dirname(fresh), name), fresh);
  return true;
}

/**
 * Repairs one root from a listing of what the sandbox user owns in it: ends the rebuilds that
 * were cut off, makes each folder again, parents first, then each file, and removes each lock
 * file that is stale by the lock's own rule. A sandbox session that crashed leaves such a lock,
 * and a later session cannot remove it. Temp files in `.ops/tmp` are left alone; see
 * {@link staleTempFiles}. The caller holds the root's `git` lock, so no sync commits a half-moved
 * folder.
 *
 * `.ops/locks` itself is never made again: a lock that moves while it is held could be taken
 * twice. swarmupd makes that folder before any run starts, so the user owns it.
 */
export async function repairRoot(root: Root, owned: SandboxOwned[]): Promise<StoreRepair> {
  const res: StoreRepair = { files: 0, dirs: 0, locks: 0, failed: [] };
  const rank = { leftover: 0, dir: 1, file: 2 };
  const todo = owned
    .map((o) => ({ ...o, rel: inRoot(root, o.path) }))
    .filter((o) => o.rel !== '' && !o.rel.startsWith('..'))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.rel.length - b.rel.length);
  const busy = new Set<string>();
  let n = 0;
  for (const o of todo) {
    // The event loop gets a turn between batches: the first repair of a store has many files.
    if (++n % 25 === 0) await new Promise((r) => setImmediate(r));
    try {
      if (o.rel === '.ops/locks') {
        res.failed.push({ path: o.path, why: 'the sandbox user owns the lock folder' });
      } else if (o.rel.startsWith('.ops/locks/')) {
        if (o.kind === 'file' && lockIsStale(o.path)) {
          rmSync(o.path, { force: true });
          res.locks += 1;
        }
      } else if (o.rel.startsWith('.ops/tmp/')) {
        // A temp file: of a write under way, or stale.
      } else if (o.kind === 'file') {
        underTaskLock(root, o.rel, busy, () => {
          if (remakeFile(root, o.path)) res.files += 1;
        });
      } else {
        underTaskLock(root, o.rel, busy, () => {
          const made = o.kind === 'dir' ? remakeDir(o.path) : finishRebuild(o.path);
          if (made) res.dirs += 1;
        });
      }
    } catch (err) {
      res.failed.push({ path: o.path, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return res;
}

/**
 * The temp files in the root's `.ops/tmp` that no write can still be using: older than
 * {@link STALE_TEMP_MS}. A write that could not rename its temp file, or a process that died
 * mid-write, leaves one, and nothing reads it.
 */
export function staleTempFiles(root: Root, now: number): string[] {
  const dir = join(root.opsDir, 'tmp');
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const stale: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile() && now - st.mtimeMs > STALE_TEMP_MS) stale.push(path);
    } catch {
      // Gone since the listing.
    }
  }
  return stale;
}
