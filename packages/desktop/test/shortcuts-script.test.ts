// AO-0282: runs build/shortcuts.ps1 against scratch folders that stand in for the Start menu and
// the desktop of this user and of all users, so it never touches the real ones. Windows only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const build = fileURLToPath(new URL('../build/', import.meta.url));
const script = join(build, 'shortcuts.ps1');
const windir = process.env.SystemRoot ?? 'C:\\Windows';
const POWERSHELL = join(windir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** The PowerShell a 32-bit program such as the installer gets. */
const POWERSHELL_32 = join(windir, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Four folders: Start menu and desktop, for this user and for all users. */
function folders(): { root: string; all: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'swarmup-shortcuts-'));
  dirs.push(root);
  const all = ['user-menu', 'user-desktop', 'all-menu', 'all-desktop'].map((n) => join(root, n));
  for (const d of all) mkdirSync(d);
  return { root, all };
}

/** Writes real .lnk files: [link, target] pairs. */
function link(...pairs: [string, string][]): void {
  const lines = pairs.map(
    ([at, target]) => `$l=$s.CreateShortcut(${lit(at)}); $l.TargetPath=${lit(target)}; $l.Save()`,
  );
  execFileSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      ['$s=New-Object -ComObject WScript.Shell', ...lines].join('; '),
    ],
    { windowsHide: true },
  );
}

function run(folderList: string[], extra: string[] = [], exe = POWERSHELL): void {
  execFileSync(
    exe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Dirs',
      folderList.join('|'),
      ...extra,
    ],
    { windowsHide: true },
  );
}

describe.runIf(process.platform === 'win32')('shortcuts.ps1', { timeout: 60_000 }, () => {
  it('deletes the dead Agent Ops shortcut in every folder, for this user and all users', () => {
    const { root, all } = folders();
    const gone = join(root, 'Agent Ops', 'Agent Ops.exe');
    link(...all.map((d): [string, string] => [join(d, 'Agent Ops.lnk'), gone]));
    for (const d of all) expect(existsSync(join(d, 'Agent Ops.lnk'))).toBe(true);
    run(all);
    for (const d of all) expect(existsSync(join(d, 'Agent Ops.lnk'))).toBe(false);
  });

  it('keeps a shortcut that works, one that belongs to something else, and the new one', () => {
    const { root, all } = folders();
    const [menu, desktop, allMenu, allDesktop] = all as [string, string, string, string];
    const live = join(root, 'Agent Ops', 'Agent Ops.exe');
    mkdirSync(dirname(live));
    writeFileSync(live, '');
    writeFileSync(join(allDesktop, 'Agent Ops.lnk'), 'not a shortcut');
    mkdirSync(join(allMenu, 'Folder'));
    link(
      // The old app is still installed.
      [join(menu, 'Agent Ops.lnk'), live],
      // Same name, another program's missing file.
      [join(desktop, 'Agent Ops.lnk'), join(root, 'Other', 'ops.exe')],
      // The new shortcut, even when its target is missing.
      [join(menu, 'SwarmUp.lnk'), join(root, 'gone', 'SwarmUp.exe')],
      // The old target under another shortcut name, and the old name in a subfolder.
      [join(allMenu, 'My tool.lnk'), join(root, 'gone', 'Agent Ops.exe')],
      [join(allMenu, 'Folder', 'Agent Ops.lnk'), join(root, 'gone', 'Agent Ops.exe')],
    );
    // A folder that does not exist and an empty entry are skipped.
    run([join(root, 'missing'), '', ...all]);
    expect(existsSync(join(menu, 'Agent Ops.lnk'))).toBe(true);
    expect(existsSync(join(desktop, 'Agent Ops.lnk'))).toBe(true);
    expect(existsSync(join(menu, 'SwarmUp.lnk'))).toBe(true);
    expect(existsSync(join(allMenu, 'My tool.lnk'))).toBe(true);
    expect(existsSync(join(allMenu, 'Folder', 'Agent Ops.lnk'))).toBe(true);
    expect(readFileSync(join(allDesktop, 'Agent Ops.lnk'), 'utf8')).toBe('not a shortcut');
  });

  // The installer is 32-bit, and 32-bit Windows code reads a target under "Program Files" as
  // under "Program Files (x86)". Node stands in for the old app: a program in "Program Files"
  // that exists.
  const programFiles = process.env.ProgramW6432;
  const x86 = process.env['ProgramFiles(x86)'];
  const node = process.execPath;
  const canCheck32 =
    process.platform === 'win32' &&
    existsSync(POWERSHELL_32) &&
    programFiles !== undefined &&
    x86 !== undefined &&
    node.toLowerCase().startsWith(`${programFiles.toLowerCase()}\\`) &&
    !existsSync(x86 + node.slice(programFiles.length));
  it.runIf(canCheck32)('keeps a working shortcut into Program Files in 32-bit PowerShell', () => {
    const { all } = folders();
    const name = basename(node, '.exe');
    const at = join(all[0] as string, `${name}.lnk`);
    link([at, node]);
    run(all, ['-Name', name], POWERSHELL_32);
    expect(existsSync(at)).toBe(true);
  });
});

describe('installer.nsh', () => {
  it('runs shortcuts.ps1 with the folders of both shell contexts, and ships the script', () => {
    const nsh = readFileSync(join(build, 'installer.nsh'), 'utf8');
    const install = nsh.slice(
      nsh.indexOf('!macro customInstall'),
      nsh.indexOf('!macro customUnInstall'),
    );
    const lines = install.split(/\r?\n/).map((l) => l.trim());
    const current = lines.indexOf('SetShellVarContext current');
    const allUsers = lines.indexOf('SetShellVarContext all');
    const call = lines.findIndex((l) => l.includes('shortcuts.ps1" -Dirs "$1"'));
    expect(current).toBeGreaterThan(-1);
    expect(lines[current + 1]).toBe('StrCpy $1 "$SMPROGRAMS|$DESKTOP"');
    expect(allUsers).toBeGreaterThan(current);
    expect(lines[allUsers + 1]).toBe('StrCpy $1 "$1|$SMPROGRAMS|$DESKTOP"');
    expect(call).toBeGreaterThan(allUsers);
    // Not inside the block that updates skip.
    expect(lines.slice(0, call).filter((l) => l.startsWith('${If')).length).toBe(
      lines.slice(0, call).filter((l) => l === '${EndIf}').length,
    );
    const yml = readFileSync(join(build, '..', 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/- from: build\/shortcuts\.ps1\r?\n\s+to: shortcuts\.ps1/);
  });
});
