// Auto-update policy for the installed app: pure helpers, tested without Electron.
//
// The installer replaces the app's files, and swarmupd and the `swarmup` command run from them (the
// app's executable as Node), so swarmupd stops first. An update installs on its own only while no run
// is live, since a run's `swarmup` calls fail while the files are replaced; the person can install
// sooner and is asked first.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type UpdateMode = 'manual' | 'auto';

export type UpdateStatus =
  | 'off'
  | 'idle'
  | 'checking'
  | 'none'
  | 'downloading'
  | 'ready'
  | 'waiting'
  | 'installing'
  | 'error';

/** How often the installed app looks for a new release after startup. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000;

/** Schedules the first and recurring update checks. */
export function scheduleUpdateChecks(check: () => void): void {
  setTimeout(check, 20_000).unref();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS).unref();
}

/**
 * Waits before each new download after a file lock broke one. electron-updater downloads to
 * `temp-SwarmUp-Setup.exe` and renames it; it retries that rename only on EBUSY, so an antivirus
 * scan of the fresh exe (EPERM or EACCES on Windows) fails the whole download.
 */
export const LOCKED_DOWNLOAD_RETRY_MS = [15_000, 60_000, 5 * 60_000];

/** True when an updater error is a file lock on the downloaded installer, not a network or feed fault. */
export function isLockedDownload(message: string): boolean {
  return /\b(EPERM|EACCES|EBUSY)\b/.test(message) && /\brename\b|temp-/i.test(message);
}

/**
 * How long to wait before downloading again after `message`, or null when the error isn't a file
 * lock or the retries for this version are used up. `attempt` counts the retries already made.
 */
export function lockedDownloadRetry(message: string, attempt: number): number | null {
  if (!isLockedDownload(message)) return null;
  return LOCKED_DOWNLOAD_RETRY_MS[attempt] ?? null;
}

/** What the Settings card, the banner and the tray show about updates. */
export interface UpdateState {
  status: UpdateStatus;
  mode: UpdateMode;
  /** The running app's version. */
  current: string;
  /** The version found or downloaded. */
  version?: string;
  /** Download progress, 0 to 100. */
  percent?: number;
  /** Live runs Auto is waiting for. */
  live?: number;
  error?: string;
  /** When the last check finished (ISO). */
  checkedAt?: string;
  /** The release notes of the new version, as the feed gives them. */
  notes?: string;
}

export type InstallDecision = 'install' | 'confirm' | 'wait';

/**
 * Whether to install a downloaded update now.
 * - The person asked: install when no run is live; with live runs, ask first (`confirm`).
 * - Nobody asked: install only when no run is live and no window is open (the app sits in the
 *   tray), so nobody's work or reading is cut off; otherwise wait for the next look.
 */
export function installDecision(s: {
  ready: boolean;
  asked: boolean;
  windowOpen: boolean;
  live: number;
}): InstallDecision {
  if (!s.ready) return 'wait';
  if (s.asked) return s.live === 0 ? 'install' : 'confirm';
  return s.live === 0 && !s.windowOpen ? 'install' : 'wait';
}

/** What `installUpdate` needs from the app; main.ts wires them to Electron and swarmupd. */
export interface InstallSteps {
  /** swarmupd's live runs now, and whether they keep going after it stops. */
  state(): Promise<{ live: number; runsOutlive: boolean }>;
  /** Whether the app's window is open and visible. */
  windowOpen(): boolean;
  /** The live-run dialog: true to install now. */
  confirm(live: number, runsOutlive: boolean): Promise<boolean>;
  /**
   * Stops swarmupd if it runs. `ifIdle`: swarmupd stops only when no run is live, checked in one step
   * with refusing new launches; `busy` when it refused because a run is live.
   */
  stop(opts: { ifIdle: boolean; killRuns: boolean }): Promise<'stopped' | 'busy'>;
  /** Leaves the relaunch note and restarts into the installer. */
  install(background: boolean): void;
}

export type InstallOutcome = 'installed' | 'waiting' | 'kept';

/**
 * Installs a downloaded update when `installDecision` allows it. Without the person confirming
 * live runs, swarmupd stops only through its atomic idle check, so a run that starts after the live
 * count was read is never cut off: an unattended install waits, and a clicked one asks first.
 */
export async function installUpdate(asked: boolean, steps: InstallSteps): Promise<InstallOutcome> {
  // A second pass only when a run started between reading the count and stopping swarmupd.
  for (let pass = 0; pass < 2; pass++) {
    const st = await steps.state();
    const windowOpen = steps.windowOpen();
    const decision = installDecision({ ready: true, asked, windowOpen, live: st.live });
    if (decision === 'wait') return 'waiting';
    if (decision === 'confirm') {
      if (!(await steps.confirm(st.live, st.runsOutlive))) return 'kept';
      // Runs that outlive swarmupd keep going and the new swarmupd adopts them; others end with it.
      if ((await steps.stop({ ifIdle: false, killRuns: !st.runsOutlive })) === 'busy') {
        return 'waiting';
      }
      steps.install(!windowOpen);
      return 'installed';
    }
    if ((await steps.stop({ ifIdle: true, killRuns: false })) === 'stopped') {
      steps.install(!windowOpen);
      return 'installed';
    }
    // A run started: unattended, leave the update ready for a later look.
    if (!asked) return 'waiting';
  }
  return 'waiting';
}

export const AUTO_UPDATE_LIMIT_MS = 3 * 60 * 60_000;
export const AUTO_UPDATE_POLL_MS = 15_000;

export interface AutoUpdateSteps {
  /** The pause and live-run state now. */
  state(): Promise<{ paused: boolean; live: number }>;
  /** Pauses new runs, using the same persistent pause as the tray and CLI. */
  pause(): Promise<void>;
  /** A cancellable/testable delay between live-run checks. */
  wait(ms: number): Promise<void>;
  /** Stops swarmupd and enters the installer; `resume` is recorded for the new app. */
  install(resume: boolean): Promise<void>;
  /** Restores service after an error, clearing only a pause Auto made. */
  recover(resume: boolean): Promise<void>;
  /** Leaves a message for the person in the Inbox; `resumed` says Auto cleared its own pause. */
  notice(message: string, resumed: boolean): Promise<void>;
  /** Shows progress in Settings and the tray. */
  status(status: 'waiting' | 'installing' | 'error', live?: number, error?: string): void;
  now(): number;
}

export type AutoUpdateOutcome = 'installing' | 'timed-out' | 'failed';

/**
 * Pauses new work, lets live runs finish, then installs. Cleanup always restores the service and
 * clears only the pause made here; a pause that was already present belongs to the person.
 */
export async function autoUpdate(
  steps: AutoUpdateSteps,
  opts: { limitMs?: number; pollMs?: number } = {},
): Promise<AutoUpdateOutcome> {
  const limit = opts.limitMs ?? AUTO_UPDATE_LIMIT_MS;
  const poll = opts.pollMs ?? AUTO_UPDATE_POLL_MS;
  const started = steps.now();
  let madePause = false;
  let timedOut = false;
  try {
    let state = await steps.state();
    if (!state.paused) {
      // Recovery may safely clear a pause even if this call fails before writing it. Mark ownership
      // first so a partial pause never survives the failure path.
      madePause = true;
      await steps.pause();
      state = await steps.state();
    }
    for (;;) {
      steps.status('waiting', state.live);
      if (state.live === 0) break;
      const left = limit - (steps.now() - started);
      if (left <= 0) {
        timedOut = true;
        throw new Error('live runs did not finish within 3 hours');
      }
      await steps.wait(Math.min(poll, left));
      state = await steps.state();
      if (madePause && !state.paused) {
        throw new Error('automatic update was cancelled because new runs were resumed');
      }
    }
    steps.status('installing');
    await steps.install(madePause);
    return 'installing';
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    try {
      await steps.recover(madePause);
    } catch (recoverErr) {
      const why = recoverErr instanceof Error ? recoverErr.message : String(recoverErr);
      message = `${message}; service recovery failed: ${why}`;
    }
    steps.status('error', undefined, message);
    try {
      await steps.notice(message, madePause);
    } catch {
      // The update state still tells the person; a stopped or unreachable daemon has no Inbox.
    }
    return timedOut ? 'timed-out' : 'failed';
  }
}

/** The confirm dialog's text when the person installs with runs live. */
export function installPrompt(live: number, runsOutlive: boolean): string {
  const runs = live === 1 ? '1 agent run is' : `${live} agent runs are`;
  const wait =
    'Or wait: the update installs on its own once no run is live and the window is closed.';
  return runsOutlive
    ? `${runs} live. Installing stops swarmupd for about a minute: the runs keep going and the new swarmupd picks them up, but their swarmup commands fail until it is back. ${wait}`
    : `${runs} live. Installing stops swarmupd, and its runs end with it; their tasks go back to the queue. ${wait}`;
}

/** Release notes from electron-updater: a string, or one entry per version. */
export function notesText(
  notes: string | Array<{ version: string; note: string | null }> | null | undefined,
): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  return notes
    .map((n) => `${n.version}\n${n.note ?? ''}`.trim())
    .join('\n\n')
    .trim();
}

/** Strips HTML tags from release notes, which GitHub serves as HTML. */
export function plainNotes(notes: string | undefined): string | undefined {
  if (!notes) return undefined;
  return notes
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The note an update leaves for the app it relaunches: start in the tray when the old app had no
 * window open, so an update at night opens no window. Read once, then deleted.
 */
const MARKER = 'relaunch.json';

export interface RelaunchState {
  background: boolean;
  /** Auto made the pause, so the new app clears it. */
  resume: boolean;
  /** The version that was expected to start. */
  version?: string;
}

/** The app version that last installed the user-level skills, so a plain restart leaves them be. */
const SKILLS_MARKER = 'skills-installed.json';

/**
 * Runs `install` once per app version: on the first start after an install or update. A plain
 * restart of the same version skips it, so a person's edits to the user-level SKILL.md survive.
 * The version is recorded only after `install` succeeds, so a failed install retries next start.
 * Returns true when `install` ran.
 */
export function installSkillsOnce(dir: string, version: string, install: () => void): boolean {
  const file = join(dir, SKILLS_MARKER);
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    if (m.version === version) return false;
  } catch {
    // No marker or an unreadable one: install.
  }
  install();
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ version }));
  return true;
}

export function writeRelaunch(
  dir: string,
  background: boolean,
  now = Date.now(),
  resume = false,
  version?: string,
): void {
  writeFileSync(join(dir, MARKER), JSON.stringify({ background, resume, version, at: now }));
}

/** A recent update's one-use relaunch instructions. */
export function takeRelaunch(dir: string, now = Date.now()): RelaunchState | null {
  const file = join(dir, MARKER);
  if (!existsSync(file)) return null;
  let state: RelaunchState | null = null;
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as {
      background?: unknown;
      resume?: unknown;
      version?: unknown;
      at?: unknown;
    };
    // An Auto pause must be cleared whenever the app eventually starts. A stale Manual note only
    // controlled whether the old update should reopen a window, so it may be discarded.
    if (typeof m.at === 'number' && (m.resume === true || now - m.at < 600_000)) {
      state = {
        background: m.background === true && now - m.at < 600_000,
        resume: m.resume === true,
        ...(typeof m.version === 'string' ? { version: m.version } : {}),
      };
    }
  } catch {
    state = null;
  }
  rmSync(file, { force: true });
  return state;
}
