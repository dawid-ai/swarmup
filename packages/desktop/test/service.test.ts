import { describe, expect, it } from 'vitest';
import {
  buildDiffers,
  buildText,
  cwdArg,
  desktopSettings,
  endRunsPrompt,
  keptRunsMessage,
  localTime,
  loginArgs,
  loginEntry,
  opsdLine,
  regValue,
  restartFailed,
  restartNote,
  serviceLine,
  stopEndsRuns,
  TOOLTIP_MAX,
  trayBitmap,
  trayColor,
  trayMenu,
  trayTooltip,
} from '../src/service';

const base = { running: true, paused: false, live: 0, waiting: 0, runsOutlive: true };

describe('tray', () => {
  it('describes swarmupd running, paused and stopped', () => {
    expect(serviceLine({ ...base, live: 2 })).toBe('swarmupd running · 2 live runs');
    expect(serviceLine({ ...base, live: 1, paused: true })).toBe(
      'swarmupd paused · 1 live run finishing',
    );
    expect(serviceLine({ ...base, paused: true })).toBe('swarmupd paused · no live runs');
    expect(serviceLine({ ...base, running: false })).toBe('swarmupd stopped');
    expect(serviceLine({ ...base, running: false, paused: true })).toBe(
      'swarmupd stopped (starts paused)',
    );
  });

  it('offers start or stop, pause or resume, and restart only while running', () => {
    const labels = (s: typeof base) =>
      trayMenu(s, true)
        .filter((i) => i.command)
        .map((i) => `${i.command}${i.enabled === false ? '(off)' : ''}`);
    expect(labels(base)).toEqual([
      'open',
      'stop',
      'pause',
      'restart',
      'notify',
      'quit',
      'quit-stop',
    ]);
    expect(labels({ ...base, running: false, paused: true })).toEqual([
      'open',
      'start',
      'resume',
      'restart(off)',
      'notify',
      'quit',
    ]);
    const waiting = trayMenu({ ...base, waiting: 3 }, false);
    expect(waiting[1]).toMatchObject({ label: '3 items need you', command: 'inbox' });
    expect(waiting.find((i) => i.command === 'notify')?.checked).toBe(false);
  });

  it('asks before a stop or restart ends live runs, only where runs end with swarmupd', () => {
    const win = { ...base, runsOutlive: false };
    expect(stopEndsRuns({ ...base, live: 2 })).toBe(false);
    expect(stopEndsRuns(win)).toBe(false);
    expect(stopEndsRuns({ ...win, live: 2, running: false })).toBe(false);
    expect(stopEndsRuns({ ...win, live: 2 })).toBe(true);
    const label = (s: typeof base, cmd: string) =>
      trayMenu(s, true).find((i) => i.command === cmd)?.label;
    expect(label({ ...base, live: 2 }, 'stop')).toBe('Stop swarmupd');
    expect(label({ ...win, live: 2 }, 'stop')).toBe('Stop swarmupd (ends 2 live runs)…');
    expect(label({ ...win, live: 1 }, 'restart')).toBe('Restart swarmupd (ends 1 live run)…');
    expect(endRunsPrompt('restart', 2)).toMatchObject({
      message: 'Restart swarmupd and end 2 live runs?',
      confirm: 'End runs and restart',
    });
    expect(keptRunsMessage(1)).toMatch(/^swarmupd keeps running: 1 live run would have ended/);
  });

  it('says plainly whether Quit leaves swarmupd running, and offers Quit and stop (AO-0156)', () => {
    const label = (s: typeof base, cmd: string) =>
      trayMenu(s, true).find((i) => i.command === cmd)?.label;
    expect(label(base, 'quit')).toBe('Quit SwarmUp (swarmupd keeps running)');
    expect(label(base, 'quit-stop')).toBe('Quit and stop swarmupd');
    // Where runs end with swarmupd, the stop says so and asks first, as Stop does.
    expect(label({ ...base, runsOutlive: false, live: 1 }, 'quit-stop')).toBe(
      'Quit and stop swarmupd (ends 1 live run)…',
    );
    // Nothing to stop: a plain Quit.
    expect(label({ ...base, running: false }, 'quit')).toBe('Quit SwarmUp');
    expect(label({ ...base, running: false }, 'quit-stop')).toBeUndefined();
  });

  const opsd = {
    pid: 1992,
    startedAt: new Date(2026, 10, 5, 14, 23).toISOString(),
    version: '0.2.0-beta.2',
    build: String(new Date(2026, 10, 5, 14, 20).getTime()),
    installed: String(new Date(2026, 10, 5, 14, 20).getTime()),
  };

  it("shows swarmupd's pid, start, version and build in the tooltip and menu (AO-0156)", () => {
    expect(localTime(opsd.startedAt)).toBe('2026-11-05 14:23');
    expect(buildText(opsd.build)).toBe('2026-11-05 14:20');
    expect(buildText('dev')).toBe('dev');
    expect(opsdLine(opsd)).toBe(
      'pid 1992 · since 2026-11-05 14:23 · 0.2.0-beta.2 · build 2026-11-05 14:20',
    );
    const s = { ...base, live: 2, opsd };
    expect(trayTooltip(s)).toBe(
      'SwarmUp: swarmupd running · 2 live runs\npid 1992 since 11-05 14:23 · 0.2.0-beta.2\nbuild 11-05 14:20',
    );
    expect(trayMenu(s, true)[1]).toMatchObject({ label: opsdLine(opsd), enabled: false });
    // An older swarmupd than the installed app is flagged in both, within Windows' tooltip limit.
    const old = { ...s, opsd: { ...opsd, pid: 123456, installed: String(Date.now()) } };
    expect(buildDiffers(old.opsd)).toBe(true);
    expect(buildDiffers(opsd)).toBe(false);
    expect(buildDiffers({ ...opsd, installed: undefined })).toBe(false);
    const tip = trayTooltip({ ...old, paused: true, live: 12 });
    expect(tip).toMatch(/\nbuild 11-05 14:20 \(older than app\)$/);
    expect(tip.length).toBeLessThanOrEqual(TOOLTIP_MAX);
    expect(trayMenu(old, true)[2]).toMatchObject({
      label: 'swarmupd runs an older build than this app: restart it',
      enabled: false,
    });
    // A stopped swarmupd shows no process.
    expect(trayTooltip({ ...base, running: false, opsd })).toBe('SwarmUp: swarmupd stopped');
  });

  it('confirms a restart by the new pid and start time, or says why it did not happen', () => {
    const after = { ...opsd, pid: 5120, startedAt: new Date(2026, 10, 7, 9, 14).toISOString() };
    expect(restartNote(opsd, after)).toBe(
      'swarmupd restarted: pid 1992 → pid 5120, started 2026-11-07 09:14',
    );
    expect(restartNote(opsd, { ...after, installed: '1' })).toMatch(
      /; it still runs an older build than this app$/,
    );
    expect(() => restartNote(opsd, opsd)).toThrow('swarmupd did not restart: pid 1992 still runs');
    expect(restartFailed(new Error('swarmupd pid 1992 did not stop in time; see x'))).toBe(
      'swarmupd did not restart: swarmupd pid 1992 did not stop in time; see x',
    );
    expect(restartFailed(new Error(keptRunsMessage(2)))).toMatch(
      /^swarmupd did not restart: swarmupd keeps running: 2 live runs would have ended/,
    );
    expect(restartFailed(new Error('swarmupd did not restart: pid 1 still runs'))).toBe(
      'swarmupd did not restart: pid 1 still runs',
    );
  });

  it('draws a status light in the state colour, with a dot when something waits', () => {
    expect(trayColor(base)).toEqual([63, 185, 80]);
    expect(trayColor({ ...base, paused: true })).toEqual([210, 153, 34]);
    expect(trayColor({ ...base, running: false })).toEqual([139, 148, 158]);
    const size = 32;
    const px = (buf: Buffer, x: number, y: number) => {
      const i = (y * size + x) * 4;
      return [buf[i + 2], buf[i + 1], buf[i], buf[i + 3]];
    };
    const plain = trayBitmap(base, size);
    expect(plain.length).toBe(size * size * 4);
    // A corner is transparent; the ring is opaque green.
    expect(px(plain, 0, 0)[3]).toBe(0);
    expect(px(plain, 16, 3)).toEqual([63, 185, 80, 255]);
    // The top-right dot shows only while something waits.
    expect(px(plain, 29, 3)[3]).toBe(0);
    expect(px(trayBitmap({ ...base, waiting: 1 }, size), 29, 3)).toEqual([88, 166, 255, 255]);
  });
});

describe('start at sign-in', () => {
  it('starts the app folder in development and the app itself when packaged', () => {
    expect(loginArgs({ packaged: false, appPath: 'C:/dev/app', cwd: 'C:/dev/agent-ops' })).toEqual([
      'C:/dev/app',
      '--background',
      '--ops-cwd=C:/dev/agent-ops',
    ]);
    expect(loginArgs({ packaged: true, appPath: 'x', cwd: 'C:/work' })).toEqual([
      '--background',
      '--ops-cwd=C:/work',
    ]);
  });

  it('quotes an argument with a space, since Electron joins them with spaces', () => {
    expect(loginArgs({ packaged: false, appPath: 'C:/My Apps/app', cwd: 'D:/work dir' })).toEqual([
      '"C:/My Apps/app"',
      '--background',
      '"--ops-cwd=D:/work dir"',
    ]);
  });

  it('reads the folder back from the command line', () => {
    expect(cwdArg(['electron', '.', '--background', '--ops-cwd=C:/dev/agent-ops'])).toBe(
      'C:/dev/agent-ops',
    );
    expect(cwdArg(['electron', '.'])).toBeUndefined();
    expect(cwdArg(['--ops-cwd='])).toBeUndefined();
  });

  describe('the sign-in entry, read by name', () => {
    const RUN = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
    // A stand-in registry with Electron's behaviour: on writes the value under the name, off
    // deletes the value by name, wherever it points.
    function registry() {
      const run = new Map<string, string>();
      const approved = new Map<string, string>();
      const out = (key: string, m: Map<string, string>, type: string, name: string) =>
        m.has(name) ? `\r\n${key}\r\n    ${name}    ${type}    ${m.get(name)}\r\n\r\n` : null;
      return {
        run,
        approved,
        set(name: string, item: { path: string; args: string[] }, on: boolean) {
          if (on) {
            run.set(name, [`"${item.path}"`, ...item.args].join(' '));
            approved.delete(name);
          } else {
            run.delete(name);
            approved.delete(name);
          }
        },
        read(name: string, item: { path: string; args: string[] }) {
          return loginEntry(
            out(RUN, run, 'REG_SZ', name),
            out(`${RUN}\\StartupApproved`, approved, 'REG_BINARY', name),
            name,
            item,
          );
        },
      };
    }
    const at = (exe: string, cwd: string) => ({
      path: exe,
      args: loginArgs({ packaged: false, appPath: `${exe}/../app`, cwd }),
    });

    it('parses one value from reg query output, by a case-insensitive name', () => {
      const out = `\r\n${RUN}\r\n    Other    REG_SZ    x\r\n    SwarmUp    REG_SZ    "C:\\a b\\e.exe" --background\r\n`;
      expect(regValue(out, 'swarmup')).toEqual({
        type: 'REG_SZ',
        data: '"C:\\a b\\e.exe" --background',
      });
      expect(regValue(out, 'Missing')).toBeNull();
      expect(regValue(null, 'SwarmUp')).toBeNull();
    });

    it('turns on, reads back and turns off from the same place', () => {
      const reg = registry();
      const here = at('C:\\dev\\agent-ops\\electron.exe', 'C:\\dev\\agent-ops');
      expect(reg.read('SwarmUp', here)).toEqual({ command: null, off: false, current: false });
      reg.set('SwarmUp', here, true);
      expect(reg.read('SwarmUp', here)).toMatchObject({ off: false, current: true });
      reg.set('SwarmUp', here, false);
      expect(reg.read('SwarmUp', here).command).toBeNull();
    });

    it('still finds the entry after the app moved or its folder changed, and turns it off', () => {
      const reg = registry();
      const old = at('C:\\old\\swarmup\\electron.exe', 'C:\\old\\swarmup');
      reg.set('SwarmUp', old, true);
      const moved = at('D:\\swarmup\\electron.exe', 'D:\\swarmup');
      const seen = reg.read('SwarmUp', moved);
      // On, but pointing elsewhere: the app shows it and can remove or repoint it.
      expect(seen.command).toContain('C:\\old\\swarmup\\electron.exe');
      expect(seen).toMatchObject({ off: false, current: false });
      // Same executable, other folder for swarmupd: also not this app's entry.
      const otherCwd = at('C:\\old\\swarmup\\electron.exe', 'C:\\elsewhere');
      expect(reg.read('SwarmUp', otherCwd).current).toBe(false);
      // Removal goes by name, so it works from the moved app.
      reg.set('SwarmUp', moved, false);
      expect(reg.read('SwarmUp', moved).command).toBeNull();
      expect(reg.read('SwarmUp', old).command).toBeNull();
      // Repointing from the moved app makes it current there.
      reg.set('SwarmUp', old, true);
      reg.set('SwarmUp', moved, true);
      expect(reg.read('SwarmUp', moved).current).toBe(true);
      expect(reg.read('SwarmUp', old).current).toBe(false);
    });

    it('sees an entry turned off in Task Manager, and matches paths regardless of case', () => {
      const reg = registry();
      const here = at('C:\\dev\\agent-ops\\electron.exe', 'C:\\dev\\agent-ops');
      reg.set('SwarmUp', here, true);
      reg.approved.set('SwarmUp', '030000000000000000000000');
      expect(reg.read('SwarmUp', here)).toMatchObject({ off: true, current: true });
      reg.approved.set('SwarmUp', '020000000000000000000000');
      expect(reg.read('SwarmUp', here).off).toBe(false);
      const upper = at('C:\\DEV\\AGENT-OPS\\electron.exe', 'C:\\DEV\\AGENT-OPS');
      expect(reg.read('SwarmUp', upper).current).toBe(true);
    });
  });

  it('keeps notifications on unless the config turns them off', () => {
    expect(desktopSettings({})).toEqual({ notify: true });
    expect(desktopSettings(null)).toEqual({ notify: true });
    expect(desktopSettings({ desktop: { notify: false } })).toEqual({ notify: false });
    expect(desktopSettings({ desktop: { notify: 'no' } })).toEqual({ notify: true });
  });
});
