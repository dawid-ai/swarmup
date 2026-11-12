// The tray icon and the background-service settings: pure helpers, tested without Electron.

/** What the tray shows about swarmupd on this PC. */
export interface ServiceState {
  running: boolean;
  /** Paused: no new runs or schedules start. Read from the config, so it is known while stopped. */
  paused: boolean;
  live: number;
  /** Asks, reviews and votes waiting for the human. */
  waiting: number;
  /**
   * Whether live runs keep going after swarmupd stops, from swarmupd's `runs_outlive`. True on every
   * system today (`RUNS_OUTLIVE_OPSD`); a swarmupd that reports false ends its runs when it stops.
   */
  runsOutlive: boolean;
  /** Which swarmupd runs, while one does. */
  opsd?: OpsdIdentity;
}

/** Which swarmupd process runs and which build of the code it loaded. */
export interface OpsdIdentity {
  pid: number;
  /** When it started, ISO. */
  startedAt: string;
  version: string;
  /** Its build stamp (`buildStamp()` when it started): the newest code file's time, in ms. */
  build?: string;
  /** The installed app's build stamp now. */
  installed?: string;
}

/** Whether the running swarmupd loaded another build than the app has installed now. */
export function buildDiffers(o: OpsdIdentity | undefined): boolean {
  return Boolean(o?.build && o.installed && o.build !== o.installed);
}

/** A time as `2026-11-05 14:23`, in local time. */
export function localTime(at: string | number | Date): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A build stamp as the time of its newest file, or as it is when it is no number. */
export function buildText(stamp: string | undefined): string {
  if (!stamp) return 'unknown';
  return /^\d+$/.test(stamp) ? localTime(Number(stamp)) : stamp;
}

/** swarmupd's pid, start time, version and build on one line, for the tray and Settings. */
export function opsdLine(o: OpsdIdentity): string {
  return `pid ${o.pid} · since ${localTime(o.startedAt)} · ${o.version} · build ${buildText(o.build)}`;
}

/** Windows shows at most this many characters of a tray tooltip. */
export const TOOLTIP_MAX = 127;

/**
 * The tray tooltip: the state, which swarmupd runs, and a flag when its build is not the app's.
 * Times leave out the year, so all of it fits in `TOOLTIP_MAX`.
 */
export function trayTooltip(s: ServiceState): string {
  const lines = [`SwarmUp: ${serviceLine(s)}`];
  const o = s.running ? s.opsd : undefined;
  if (o) {
    const short = (t: string): string => t.slice(5);
    lines.push(`pid ${o.pid} since ${short(localTime(o.startedAt))} · ${o.version}`);
    const build = o.build && /^\d+$/.test(o.build) ? short(buildText(o.build)) : buildText(o.build);
    lines.push(`build ${build}${buildDiffers(o) ? ' (older than app)' : ''}`);
  }
  let text = lines.join('\n');
  // swarmupd already names the app, so the prefix goes first when the text is too long.
  if (text.length > TOOLTIP_MAX) text = text.slice('SwarmUp: '.length);
  return text.length > TOOLTIP_MAX ? `${text.slice(0, TOOLTIP_MAX - 1)}…` : text;
}

/**
 * What a restart did, from the swarmupd before and after it. Throws when the same process still runs,
 * so a restart that did not happen never reads as done.
 */
export function restartNote(before: OpsdIdentity | undefined, after: OpsdIdentity): string {
  if (before && before.pid === after.pid && before.startedAt === after.startedAt) {
    throw new Error(`swarmupd did not restart: pid ${after.pid} still runs`);
  }
  const from = before ? `pid ${before.pid} → ` : '';
  const differs = buildDiffers(after) ? '; it still runs an older build than this app' : '';
  return `swarmupd restarted: ${from}pid ${after.pid}, started ${localTime(after.startedAt)}${differs}`;
}

/** The error for a restart that stopped short, with the reason. */
export function restartFailed(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith('swarmupd did not restart') ? msg : `swarmupd did not restart: ${msg}`;
}

/**
 * Whether a stop or restart now ends live runs, so it needs the person's confirmation. Only an
 * swarmupd whose runs cannot outlive it: otherwise the next swarmupd adopts them.
 */
export function stopEndsRuns(s: ServiceState): boolean {
  return s.running && s.live > 0 && !s.runsOutlive;
}

function runsText(live: number): string {
  return live === 1 ? '1 live run' : `${live} live runs`;
}

/** The system dialog for a stop or restart that ends live runs (a swarmupd they cannot outlive). */
export function endRunsPrompt(
  action: 'stop' | 'restart',
  live: number,
): { message: string; detail: string; confirm: string } {
  const verb = action === 'stop' ? 'Stop' : 'Restart';
  return {
    message: `${verb} swarmupd and end ${runsText(live)}?`,
    detail:
      'This swarmupd ends its runs when it stops. Ending a run releases its claim, ' +
      'and the task goes back to the queue. To let runs finish first, cancel, pause new runs ' +
      'and stop swarmupd when none are live.',
    confirm: `End runs and ${action}`,
  };
}

/** The error for a cancelled stop or restart that would end runs. */
export function keptRunsMessage(live: number): string {
  return `swarmupd keeps running: ${runsText(live)} would have ended. Pause new runs to let them finish.`;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'pause' | 'resume';

export const SERVICE_ACTIONS: ServiceAction[] = ['start', 'stop', 'restart', 'pause', 'resume'];

/** One line for the tray tooltip and the top of its menu. */
export function serviceLine(s: ServiceState): string {
  if (!s.running) return s.paused ? 'swarmupd stopped (starts paused)' : 'swarmupd stopped';
  const runs = runsText(s.live);
  if (!s.paused) return `swarmupd running · ${runs}`;
  return s.live === 0 ? 'swarmupd paused · no live runs' : `swarmupd paused · ${runs} finishing`;
}

export type TrayCommand =
  ServiceAction | 'open' | 'inbox' | 'notify' | 'update' | 'quit' | 'quit-stop';

export interface TrayItem {
  label?: string;
  command?: TrayCommand;
  enabled?: boolean;
  checked?: boolean;
  separator?: true;
}

/** The tray's right-click menu for a state; main.ts turns it into an Electron menu. */
export function trayMenu(s: ServiceState, notify: boolean, update?: string): TrayItem[] {
  const items: TrayItem[] = [{ label: serviceLine(s), enabled: false }];
  if (s.running && s.opsd) {
    items.push({ label: opsdLine(s.opsd), enabled: false });
    if (buildDiffers(s.opsd)) {
      items.push({
        label: 'swarmupd runs an older build than this app: restart it',
        enabled: false,
      });
    }
  }
  if (update) items.push({ label: `Restart to update to ${update}`, command: 'update' });
  if (s.waiting > 0) {
    items.push({
      label: s.waiting === 1 ? '1 item needs you' : `${s.waiting} items need you`,
      command: 'inbox',
    });
  }
  // A stop that ends runs says so, and asks in a dialog before it does.
  const ends = stopEndsRuns(s) ? ` (ends ${runsText(s.live)})…` : '';
  items.push(
    { separator: true },
    { label: 'Open SwarmUp', command: 'open' },
    { separator: true },
    s.running
      ? { label: `Stop swarmupd${ends}`, command: 'stop' }
      : { label: 'Start swarmupd', command: 'start' },
    s.paused
      ? { label: 'Resume new runs', command: 'resume' }
      : { label: 'Pause new runs', command: 'pause' },
    { label: `Restart swarmupd${ends}`, command: 'restart', enabled: s.running },
    { separator: true },
    { label: 'Notify me when I am needed', command: 'notify', checked: notify },
  );
  // Quit closes only the app; swarmupd is a process of its own and keeps running agents.
  if (s.running) {
    items.push(
      { label: 'Quit SwarmUp (swarmupd keeps running)', command: 'quit' },
      { label: `Quit and stop swarmupd${ends}`, command: 'quit-stop' },
    );
  } else {
    items.push({ label: 'Quit SwarmUp', command: 'quit' });
  }
  return items;
}

export type Rgb = [number, number, number];

/**
 * The four tiles of the SwarmUp mark in reading order (top left, top right, bottom left, bottom
 * right): pink, orange, cyan and violet, the fills of the logo.
 */
export const TILE_COLORS: Rgb[] = [
  [0xe4, 0x6f, 0xb3],
  [0xe8, 0x87, 0x5b],
  [0x4f, 0xc3, 0xd9],
  [0xa3, 0x93, 0xff],
];

/** The outline of the tiles while swarmupd is stopped, and the dot while something waits. */
export const TRAY_STOPPED: Rgb = [139, 148, 158];
export const TRAY_WAITING: Rgb = [0x7d, 0xa8, 0xff];

/**
 * The muted version of a tile colour, as the brand's status animations dim a tile: mostly grey, a
 * little of the hue, darker.
 */
export function dimmed([r, g, b]: Rgb): Rgb {
  const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r, g, b].map((c) => Math.round((0.25 * c + 0.75 * gray) * 0.55)) as Rgb;
}

/** How the tray draws the tiles: filled in colour, filled but dimmed, or grey outlines. */
export type TrayLook = 'running' | 'paused' | 'stopped';

/** A stopped swarmupd reads as stopped whether or not it starts paused. */
export function trayLook(s: ServiceState): TrayLook {
  if (!s.running) return 'stopped';
  return s.paused ? 'paused' : 'running';
}

/**
 * The tray icon as a `size`-pixel square BGRA bitmap for `nativeImage.createFromBitmap`: the four
 * tiles of the mark as flat squares. Running fills them in their colours, paused fills them
 * dimmed, and stopped leaves grey outlines. A blue dot at the top right, with a clear rim, shows
 * while something waits for the human.
 */
export function trayBitmap(s: ServiceState, size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const look = trayLook(s);
  // The logo's proportions (tiles of 10 with a gap of 2) on whole pixels, so edges stay sharp.
  const tile = Math.round((size * 10) / 22);
  const far = size - tile;
  const line = Math.max(1, Math.round(size / 16));
  const dot = { x: size * 0.8, y: size * 0.2, r: size * 0.2 };
  const rim = size / 16;
  const put = (i: number, rgb: Rgb, a: number): void => {
    buf[i] = rgb[2];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[0];
    buf[i + 3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const col = x < tile ? 0 : x >= far ? 1 : -1;
      const row = y < tile ? 0 : y >= far ? 1 : -1;
      let rgb: Rgb | null = null;
      if (col >= 0 && row >= 0) {
        const color = TILE_COLORS[row * 2 + col]!;
        if (look === 'stopped') {
          const tx = x - col * far;
          const ty = y - row * far;
          const edge = Math.min(tx, ty, tile - 1 - tx, tile - 1 - ty);
          if (edge < line) rgb = TRAY_STOPPED;
        } else {
          rgb = look === 'paused' ? dimmed(color) : color;
        }
      }
      // Pixel centres, so the dot has a one-pixel soft edge.
      const dd = s.waiting > 0 ? Math.hypot(x + 0.5 - dot.x, y + 0.5 - dot.y) : Infinity;
      const inDot = Math.min(dot.r - dd + 0.5, 1);
      if (inDot > 0) {
        // The dot's edge fades into the clear rim, never into a tile.
        put(i, TRAY_WAITING, inDot);
      } else if (rgb) {
        // The rim: tiles fade out toward the dot, so it reads on every tile colour.
        put(i, rgb, Math.min(dd - (dot.r + rim) + 0.5, 1));
      }
    }
  }
  return buf;
}

/**
 * The sign-in entry's arguments. A packaged app starts itself; a development build starts
 * Electron with the app folder. `--ops-cwd` keeps the folder swarmupd starts in, since Windows starts
 * sign-in apps in another one.
 */
export function loginArgs(opts: { packaged: boolean; appPath: string; cwd: string }): string[] {
  const args = opts.packaged ? [] : [opts.appPath];
  // Electron joins the arguments with spaces, so one with a space needs its own quotes.
  return [...args, '--background', `--ops-cwd=${opts.cwd}`].map((a) =>
    /\s/.test(a) ? `"${a}"` : a,
  );
}

/** Where Windows keeps sign-in apps, and where Task Manager turns them off. */
export const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const APPROVED_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

/** One value from the output of `reg query KEY /v NAME`, or null when it is not there. */
export function regValue(out: string | null, name: string): { type: string; data: string } | null {
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    // Value names are case-insensitive in the registry.
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) {
      return { type: m[2]!, data: (m[3] ?? '').trim() };
    }
  }
  return null;
}

/** The app's sign-in entry, read by its name wherever the app was when it made the entry. */
export interface LoginEntry {
  /** The command line Windows runs at sign-in, or null when there is no entry. */
  command: string | null;
  /** Turned off in Task Manager > Startup apps: the entry stays but Windows skips it. */
  off: boolean;
  /** Whether the command starts this app, from this folder, with these arguments. */
  current: boolean;
}

/** Compares command lines without quotes, case or extra spaces, as Windows paths compare. */
function sameCommand(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/"/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The entry from `reg query` output for the Run key and the StartupApproved key. A
 * StartupApproved value whose first byte is odd (`03…`) is an entry turned off in Task Manager.
 */
export function loginEntry(
  runOut: string | null,
  approvedOut: string | null,
  name: string,
  item: { path: string; args: string[] },
): LoginEntry {
  const run = regValue(runOut, name);
  if (!run || !run.data) return { command: null, off: false, current: false };
  const approved = regValue(approvedOut, name);
  const first = approved ? parseInt(approved.data.slice(0, 2), 16) : 2;
  return {
    command: run.data,
    off: Number.isFinite(first) && (first & 1) === 1,
    current: sameCommand(run.data, [item.path, ...item.args].join(' ')),
  };
}

/**
 * The `--ops-cwd` folder in a sign-in entry's command line, as `loginArgs` writes it: quoted as a
 * whole when the folder has a space (`"--ops-cwd=C:\My dir"`), bare otherwise.
 */
export function cwdFromCommand(command: string): string | undefined {
  const m = /"--ops-cwd=([^"]*)"|--ops-cwd=(\S*)/.exec(command);
  return (m?.[1] ?? m?.[2]) || undefined;
}

/** `--ops-cwd=DIR` from the command line, if given. */
export function cwdArg(argv: string[]): string | undefined {
  const a = argv.find((x) => x.startsWith('--ops-cwd='));
  return a ? a.slice('--ops-cwd='.length) || undefined : undefined;
}

/** The desktop's own settings in the user config, under `desktop:`. */
export interface DesktopSettings {
  /** Windows notifications for asks, reviews and votes that wait for the human. */
  notify: boolean;
}

export function desktopSettings(user: unknown): DesktopSettings {
  const d = (user as { desktop?: { notify?: unknown } } | null)?.desktop;
  return { notify: d?.notify !== false };
}
