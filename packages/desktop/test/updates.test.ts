import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trayMenu } from '../src/service';
import type { InstallSteps } from '../src/updates';
import {
  autoUpdate,
  installDecision,
  installPrompt,
  installUpdate,
  notesText,
  plainNotes,
  scheduleUpdateChecks,
  takeRelaunch,
  UPDATE_CHECK_INTERVAL_MS,
  writeRelaunch,
} from '../src/updates';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('update check schedule', () => {
  it('checks after 20 seconds, then every 30 minutes', () => {
    vi.useFakeTimers();
    const check = vi.fn();

    scheduleUpdateChecks(check);
    vi.advanceTimersByTime(19_999);
    expect(check).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(check).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS - 20_000);
    expect(check).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });
});

describe('update install policy', () => {
  it('installs on its own only while no run is live and no window is open', () => {
    const base = { ready: true, asked: false, windowOpen: false, live: 0 };
    expect(installDecision(base)).toBe('install');
    expect(installDecision({ ...base, live: 1 })).toBe('wait');
    expect(installDecision({ ...base, windowOpen: true })).toBe('wait');
    expect(installDecision({ ...base, ready: false })).toBe('wait');
  });

  it('installs when asked, and asks first while runs are live', () => {
    const asked = { ready: true, asked: true, windowOpen: true, live: 0 };
    expect(installDecision(asked)).toBe('install');
    expect(installDecision({ ...asked, live: 2 })).toBe('confirm');
    expect(installDecision({ ...asked, ready: false })).toBe('wait');
  });
});

describe('installing an update', () => {
  /**
   * Fake app and swarmupd. `live` is what the app reads; `liveAtStop` is what swarmupd sees when asked
   * to stop, so a run that starts in between is modelled.
   */
  function steps(o: {
    live?: number[];
    liveAtStop?: number[];
    runsOutlive?: boolean;
    windowOpen?: boolean;
    confirm?: boolean;
  }) {
    const live = [...(o.live ?? [0])];
    const liveAtStop = [...(o.liveAtStop ?? live)];
    const log: string[] = [];
    const s: InstallSteps = {
      state: async () => ({ live: live.shift() ?? 0, runsOutlive: o.runsOutlive ?? true }),
      windowOpen: () => o.windowOpen ?? false,
      confirm: async (n) => {
        log.push(`confirm ${n}`);
        return o.confirm ?? true;
      },
      stop: async ({ ifIdle, killRuns }) => {
        const n = liveAtStop.shift() ?? 0;
        log.push(`stop ifIdle=${ifIdle} killRuns=${killRuns}`);
        // swarmupd's atomic check: with ifIdle it refuses while a run is live.
        return ifIdle && n > 0 ? 'busy' : 'stopped';
      },
      install: (background) => log.push(`install background=${background}`),
    };
    return { s, log };
  }

  it('stops swarmupd only through the idle check when nobody confirmed live runs', async () => {
    const { s, log } = steps({ live: [0] });
    expect(await installUpdate(false, s)).toBe('installed');
    expect(log).toEqual(['stop ifIdle=true killRuns=false', 'install background=true']);
  });

  it('waits, without installing, when a run starts after the count was read', async () => {
    const { s, log } = steps({ live: [0], liveAtStop: [1] });
    expect(await installUpdate(false, s)).toBe('waiting');
    expect(log).toEqual(['stop ifIdle=true killRuns=false']);
  });

  it('asks when a run started after the person clicked Install', async () => {
    const { s, log } = steps({ live: [0, 1], liveAtStop: [1, 1], windowOpen: true });
    expect(await installUpdate(true, s)).toBe('installed');
    expect(log).toEqual([
      'stop ifIdle=true killRuns=false',
      'confirm 1',
      'stop ifIdle=false killRuns=false',
      'install background=false',
    ]);
  });

  it('keeps everything when the person says wait, and ends runs only where they cannot outlive swarmupd', async () => {
    const kept = steps({ live: [2], confirm: false, windowOpen: true });
    expect(await installUpdate(true, kept.s)).toBe('kept');
    expect(kept.log).toEqual(['confirm 2']);

    const ending = steps({ live: [1], runsOutlive: false, windowOpen: true });
    expect(await installUpdate(true, ending.s)).toBe('installed');
    expect(ending.log).toEqual([
      'confirm 1',
      'stop ifIdle=false killRuns=true',
      'install background=false',
    ]);
  });

  it('does nothing unattended while a run is live or the window is open', async () => {
    for (const o of [{ live: [1] }, { live: [0], windowOpen: true }]) {
      const { s, log } = steps(o);
      expect(await installUpdate(false, s)).toBe('waiting');
      expect(log).toEqual([]);
    }
  });
});

describe('automatic updates', () => {
  function automatic(o: {
    states: Array<{ paused: boolean; live: number }>;
    installError?: string;
    limitMs?: number;
  }) {
    const states = [...o.states];
    let current = states.shift() ?? { paused: false, live: 0 };
    let now = 0;
    const log: string[] = [];
    const run = autoUpdate(
      {
        state: async () => {
          const out = current;
          current = states.shift() ?? current;
          log.push(`state paused=${out.paused} live=${out.live}`);
          return out;
        },
        pause: async () => {
          log.push('pause');
        },
        wait: async (ms) => {
          log.push(`wait ${ms}`);
          now += ms;
        },
        install: async (resume) => {
          log.push(`install resume=${resume}`);
          if (o.installError) throw new Error(o.installError);
        },
        recover: async (resume) => {
          log.push(`recover resume=${resume}`);
        },
        notice: async (message, resumed) => {
          log.push(`notice resumed=${resumed} ${message}`);
        },
        status: (status, live) =>
          log.push(`status ${status}${live === undefined ? '' : ` ${live}`}`),
        now: () => now,
      },
      { limitMs: o.limitMs, pollMs: 10 },
    );
    return { run, log };
  }

  it('pauses, waits for live runs, installs, and leaves resume to the new app', async () => {
    const a = automatic({
      states: [
        { paused: false, live: 2 },
        { paused: true, live: 2 },
        { paused: true, live: 1 },
        { paused: true, live: 0 },
      ],
    });
    expect(await a.run).toBe('installing');
    expect(a.log).toEqual([
      'state paused=false live=2',
      'pause',
      'state paused=true live=2',
      'status waiting 2',
      'wait 10',
      'state paused=true live=1',
      'status waiting 1',
      'wait 10',
      'state paused=true live=0',
      'status waiting 0',
      'status installing',
      'install resume=true',
    ]);
  });

  it("keeps a person's existing pause after installing", async () => {
    const a = automatic({ states: [{ paused: true, live: 0 }] });
    expect(await a.run).toBe('installing');
    expect(a.log).toEqual([
      'state paused=true live=0',
      'status waiting 0',
      'status installing',
      'install resume=false',
    ]);
  });

  it('recovers, resumes its own pause and notifies the Inbox after install failure', async () => {
    const a = automatic({
      states: [
        { paused: false, live: 0 },
        { paused: true, live: 0 },
      ],
      installError: 'installer failed',
    });
    expect(await a.run).toBe('failed');
    expect(a.log).toEqual([
      'state paused=false live=0',
      'pause',
      'state paused=true live=0',
      'status waiting 0',
      'status installing',
      'install resume=true',
      'recover resume=true',
      'status error',
      'notice resumed=true installer failed',
    ]);
  });

  it("recovers the service but does not clear a person's pause after failure", async () => {
    const a = automatic({
      states: [{ paused: true, live: 0 }],
      installError: 'installer failed',
    });
    expect(await a.run).toBe('failed');
    expect(a.log).toContain('recover resume=false');
    expect(a.log.at(-1)).toBe('notice resumed=false installer failed');
  });

  it('resumes and reports a timeout instead of leaving new runs paused', async () => {
    const a = automatic({
      states: [
        { paused: false, live: 1 },
        { paused: true, live: 1 },
      ],
      limitMs: 20,
    });
    expect(await a.run).toBe('timed-out');
    expect(a.log.at(-3)).toBe('recover resume=true');
    expect(a.log.at(-2)).toBe('status error');
    expect(a.log.at(-1)).toBe('notice resumed=true live runs did not finish within 3 hours');
  });
});

describe('release notes', () => {
  it('joins per-version notes and strips the HTML GitHub serves', () => {
    expect(notesText(undefined)).toBeUndefined();
    expect(notesText('plain')).toBe('plain');
    expect(
      notesText([
        { version: '0.2.0-beta.2', note: '<p>two</p>' },
        { version: '0.2.0-beta.1', note: null },
      ]),
    ).toBe('0.2.0-beta.2\n<p>two</p>\n\n0.2.0-beta.1');
    expect(
      plainNotes('<ul><li><strong>Search</strong> &amp; more</li><li>Tray</li></ul><p>Done</p>'),
    ).toBe('- Search & more\n- Tray\nDone');
  });
});

describe('relaunch after an update', () => {
  const temp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'swarmup-relaunch-'));
    dirs.push(d);
    return d;
  };

  it('starts in the tray once when the old app had no window, then forgets it', () => {
    const d = temp();
    writeRelaunch(d, true, 1000, true, '0.4.0');
    expect(takeRelaunch(d, 2000)).toEqual({
      background: true,
      resume: true,
      version: '0.4.0',
    });
    expect(existsSync(join(d, 'relaunch.json'))).toBe(false);
    expect(takeRelaunch(d, 3000)).toBeNull();
  });

  it('opens the window when the old one was open, the note is stale, or unreadable', () => {
    const d = temp();
    writeRelaunch(d, false, 1000);
    expect(takeRelaunch(d, 2000)).toEqual({ background: false, resume: false });
    writeRelaunch(d, true, 1000, true, '0.4.0');
    expect(takeRelaunch(d, 1000 + 11 * 60_000)).toEqual({
      background: false,
      resume: true,
      version: '0.4.0',
    });
    writeRelaunch(d, true, 1000);
    expect(takeRelaunch(d, 1000 + 11 * 60_000)).toBeNull();
    writeFileSync(join(d, 'relaunch.json'), '{not json');
    expect(takeRelaunch(d)).toBeNull();
    expect(existsSync(join(d, 'relaunch.json'))).toBe(false);
  });
});

describe('tray menu with an update', () => {
  it('offers to restart into a downloaded update', () => {
    const st = { running: true, paused: false, live: 0, waiting: 0, runsOutlive: false };
    expect(trayMenu(st, true, { status: 'ready', version: '0.2.0-beta.2' })[1]).toEqual({
      label: 'Restart to update to 0.2.0-beta.2',
      command: 'update',
    });
    expect(trayMenu(st, true).some((i) => i.command === 'update')).toBe(false);
  });
});

describe('install prompt', () => {
  it('says runs keep going when they outlive swarmupd, and end when they do not', () => {
    expect(installPrompt(1, true)).toMatch(/^1 agent run is live\. .*keep going/);
    expect(installPrompt(2, false)).toMatch(/^2 agent runs are live\. .*end with it/);
  });
});
