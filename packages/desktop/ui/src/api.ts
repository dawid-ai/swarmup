import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesktopView,
  Info,
  ProjectAdded,
  ProjectCreated,
  ProjectPlan,
  ProjectProposal,
  ServiceAction,
  ServiceState,
  UpdateState,
  VoiceView,
} from './types';

export interface SetupStatus {
  needed: boolean;
  /** A config file exists without `me`: setup adds only `me` and keeps its roots. */
  exists: boolean;
  path: string;
  defaults: { me: string; roots: string[] };
}

interface Bridge {
  info: () => Promise<Info>;
  setupStatus: () => Promise<SetupStatus>;
  /** Restarts swarmupd while no run is live, so it loads the installed build and config. */
  restart: () => Promise<{ ok: boolean; data?: { pid: number; port: number }; error?: string }>;
  /**
   * Adds or replaces a provider runtime, or removes it with `null`, after the person confirms the
   * command in a system dialog. Resolves `{ ok: false, error: 'cancelled' }` when they decline.
   */
  runtime: (
    name: string,
    input: { command: string; args?: string[]; unset_env?: string[] } | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Starts, stops, restarts, pauses or resumes swarmupd; stop and restart never stop a run. */
  service: (action: ServiceAction) => Promise<{ ok: boolean; data?: ServiceState; error?: string }>;
  desktop: () => Promise<{ ok: boolean; data?: DesktopView; error?: string }>;
  /** `login` adds the app to the Windows sign-in apps or removes it. */
  desktopSet: (patch: {
    notify?: boolean;
    login?: boolean;
  }) => Promise<{ ok: boolean; data?: DesktopView; error?: string }>;
  onService: (fn: (m: unknown) => void) => () => void;
  voice: () => Promise<{ ok: boolean; data?: VoiceView; error?: string }>;
  /** Choosing `cloud` asks in a system dialog first; resolves `cancelled` when declined. */
  voiceSet: (patch: {
    engine?: VoiceView['engine'];
    language?: string;
  }) => Promise<{ ok: boolean; data?: VoiceView; error?: string }>;
  /** Picks whisper.cpp's program or model file in a system dialog. */
  voiceBrowse: (
    kind: 'program' | 'model',
  ) => Promise<{ ok: boolean; data?: VoiceView; error?: string }>;
  /** Turns a 16 kHz mono WAV recording into text with the chosen engine. */
  transcribe: (
    wav: Uint8Array,
  ) => Promise<{ ok: boolean; data?: { text: string }; error?: string }>;
  /** The update state; `check` looks now, `install` installs a downloaded update (asks first while runs are live). */
  update: (
    action?: 'check' | 'install',
  ) => Promise<{ ok: boolean; data?: UpdateState; error?: string }>;
  onUpdate: (fn: (m: unknown) => void) => () => void;
  /**
   * Saves PNG images to a folder the person picks in a system dialog; a name already taken gets
   * a `-2`, `-3` suffix. Resolves `cancelled` when they close the dialog.
   */
  saveImages: (
    files: Array<{ name: string; data: Uint8Array }>,
  ) => Promise<{ ok: boolean; data?: { dir: string; files: string[] }; error?: string }>;
  /** Asks the person where the next recording goes. Resolves `cancelled` when they close the dialog. */
  videoFolder: () => Promise<{ ok: boolean; data?: { dir: string }; error?: string }>;
  /** Writes an MP4 into the folder from `videoFolder`; a name already taken gets a `-2` suffix. */
  saveVideo: (
    name: string,
    data: Uint8Array,
  ) => Promise<{ ok: boolean; data?: { dir: string; file: string }; error?: string }>;
  setup: (
    me: string,
    roots: string[],
  ) => Promise<{ ok: boolean; data?: { path: string; restart: boolean }; error?: string }>;
  /**
   * Add project: asks for the repo's folder in a system dialog and surveys it. A folder that has
   * a data root is added to `roots` at once (`kind: 'added'`); any other answers with the
   * proposal and writes nothing. Resolves `cancelled` when the person closes the dialog.
   */
  projectPick: () => Promise<{
    ok: boolean;
    data?: ProjectProposal | ProjectAdded;
    error?: string;
  }>;
  /** The proposal's roles and first tasks for another project name. */
  projectPlan: (name: string) => Promise<{ ok: boolean; data?: ProjectPlan; error?: string }>;
  /** Asks for the folder the tasks live in, apart from the repo. */
  projectStore: () => Promise<{ ok: boolean; data?: { dir: string }; error?: string }>;
  /** Creates the root for the picked repo; `tasks` are indexes into the proposal's tasks. */
  projectCreate: (input: {
    name: string;
    prefix: string;
    tasks: number[];
    where: 'repo' | 'store';
  }) => Promise<{ ok: boolean; data?: ProjectCreated; error?: string }>;
  call: (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  onEvent: (fn: (m: unknown) => void) => () => void;
  onStatus: (fn: (m: unknown) => void) => () => void;
  onNavigate: (fn: (m: unknown) => void) => () => void;
}

declare global {
  interface Window {
    swarmup?: Bridge;
  }
}

/** The update state, kept current by the main process. */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    const b = window.swarmup;
    if (!b?.update) return;
    void b.update().then((res) => live && res.ok && res.data && setState(res.data));
    const off = b.onUpdate((m) => live && setState(m as UpdateState));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

export function bridge(): Bridge {
  if (!window.swarmup) throw new Error('SwarmUp runs inside the desktop app only');
  return window.swarmup;
}

/** The `warnings` a swarmupd response carries (a write that went through but reaches no agent). */
export function warningsOf(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const w = (data as { warnings?: unknown }).warnings;
  return Array.isArray(w) ? w.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

type WarnFn = (warnings: string[]) => void;
const warnListeners = new Set<WarnFn>();

/** Calls `fn` with the warnings of every write response; returns the unsubscribe function. */
export function onWarnings(fn: WarnFn): () => void {
  warnListeners.add(fn);
  return () => {
    warnListeners.delete(fn);
  };
}

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await bridge().call(method, path, body);
  if (!res.ok) throw new Error(res.error ?? 'request failed');
  // Every write passes through here, so no view can drop a warning by ignoring the response.
  const warnings = method === 'POST' ? warningsOf(res.data) : [];
  if (warnings.length > 0) for (const fn of warnListeners) fn(warnings);
  return res.data as T;
}

// One shared refresh signal: swarmupd events (tasks changed, a run changed) bump it, and every view
// that reads data refetches.
type Fn = () => void;
const listeners = new Set<Fn>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Counts refresh signals; a GET started before the latest one is not shared after it. */
let generation = 0;

export function refreshSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    generation++;
    for (const fn of listeners) fn();
  }, 250);
}

/** GETs in flight per path, with the refresh generation they started in. */
const inflight = new Map<string, { gen: number; p: Promise<unknown> }>();

/**
 * GETs `path`, sharing one request among every caller that asks for it in the same refresh
 * generation: the app shell and the open view read several paths both (AO-0164).
 */
export function getShared<T>(path: string): Promise<T> {
  const cur = inflight.get(path);
  if (cur && cur.gen === generation) return cur.p as Promise<T>;
  const entry: { gen: number; p: Promise<unknown> } = { gen: generation, p: Promise.resolve() };
  entry.p = api<T>('GET', path).finally(() => {
    if (inflight.get(path) === entry) inflight.delete(path);
  });
  inflight.set(path, entry);
  return entry.p as Promise<T>;
}

export function useRefresh(fn: Fn): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = (): void => ref.current();
    listeners.add(h);
    return () => {
      listeners.delete(h);
    };
  }, []);
}

/**
 * GETs `path` now, again on every refresh signal, and when `path` changes. At most one request
 * per path is in flight: a refresh while it is out asks once more when it is back. Without this,
 * every swarmupd event sent a new round of requests while the last were still queued, and a busy
 * swarmupd fell further behind with each one (AO-0164).
 */
export function useData<T>(path: string | null): {
  data: T | undefined;
  error: string | null;
  reload: () => void;
  set: (d: T) => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  // Every request gets a number; only the newest one may set state, so a slow answer for an
  // earlier path never shows up under a later one.
  const seq = useRef(0);
  /** The request that is out (its path and number), and whether a refresh came in meanwhile. */
  const busy = useRef<{ path: string; seq: number } | null>(null);
  const again = useRef(false);
  const latest = useRef<() => void>(() => {});
  /** `fresh` starts a new request even if one is out, and makes the one that is out stale. */
  const load = useCallback(
    (fresh = false) => {
      if (!path) return;
      if (!fresh && busy.current?.path === path) {
        again.current = true;
        return;
      }
      if (fresh) again.current = false;
      const mine = ++seq.current;
      busy.current = { path, seq: mine };
      getShared<T>(path)
        .then(
          (d) => {
            if (mine !== seq.current) return;
            setData(d);
            setError(null);
          },
          (e: Error) => {
            if (mine === seq.current) setError(e.message);
          },
        )
        .finally(() => {
          if (busy.current?.seq !== mine) return;
          busy.current = null;
          if (again.current) {
            again.current = false;
            latest.current();
          }
        });
    },
    [path],
  );
  latest.current = load;
  useEffect(() => {
    setData(undefined);
    setError(null);
    again.current = false;
    load();
  }, [load]);
  useRefresh(load);
  // An explicit reload follows a write: it must not join or wait for a GET that started before
  // the write, and that GET's answer must not land after it.
  const reload = useCallback(() => {
    generation++;
    load(true);
  }, [load]);
  // A write that answers with the new state shows it at once; a GET that started before the
  // write must not land after it (AO-0171).
  const set = useCallback((d: T) => {
    generation++;
    seq.current++;
    busy.current = null;
    again.current = false;
    setData(d);
    setError(null);
  }, []);
  return { data, error, reload, set };
}

export function q(s: string): string {
  return encodeURIComponent(s);
}
