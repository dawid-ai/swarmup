import {
  Clapperboard,
  Film,
  ImageDown,
  Images,
  Loader2,
  Pause,
  Play,
  Repeat,
  SkipBack,
  X,
} from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, q, useData } from '../api';
import { Empty, ErrorLine, Section, Select, cx } from '../components';
import { isTyping } from '../lib/keys';
import { frameMarkup, svgToPng } from '../lib/png';
import {
  GIF_FPS,
  GIF_WIDTH,
  GifCancelled,
  formatBytes,
  gifFileName,
  recordGifScene,
} from '../lib/gif';
import type { GifOptions } from '../lib/gif';
import type { Aspect, RecordOptions } from '../lib/record';
import { ASPECTS, RecordCancelled, aspectById, recordScene, videoFileName } from '../lib/record';
import type { Playback } from '../lib/replay';
import { CLIPS, SPEEDS, clock, initialPlayback, seek, tick, togglePlay } from '../lib/replay';
import type { FrameOverlay, Scene } from '../replay/scene';
import { STAGE_16_9, renderFrame, sceneDuration } from '../replay/scene';
import { SCENES, sceneById } from '../replay/scenes';
import type { WrappedData } from '../replay/scenes/wrapped';
import { cardFileName, cardTime } from '../replay/scenes/wrapped';
import type { RootInfo, Settings, Task, Timeline } from '../types';

const RANGES: Array<[number, string]> = [
  [1, 'Day'],
  [7, 'Week'],
  [30, '30 days'],
  [90, '90 days'],
];

/** A choice of the **Project** picker: a root of the sidebar, or one project label inside it. */
export interface ProjectChoice {
  /** The `Select` value: '' for every project. */
  value: string;
  label: string;
  /** The data root; '' for every root. */
  root: string;
  /** The project label inside the root; '' for the whole root. */
  project: string;
}

// Splits a root from a label in a `Select` value: no root or label holds a control character.
const SEP = '\u001f';

/**
 * The picker's options: `All projects`, then each root by name, each followed by its project
 * labels when its tasks carry more than one. Roots come from the app's list (the sidebar's
 * projects, never the Master Repo), since a root may hold no task yet; until that list loads,
 * the roots of the tasks stand in.
 */
export function projectChoices(
  roots: Array<Pick<RootInfo, 'name' | 'isMaster'>> | undefined,
  tasks: Array<Pick<Task, 'root' | 'project'>>,
): ProjectChoice[] {
  const names = roots
    ? roots.filter((r) => !r.isMaster).map((r) => r.name)
    : tasks.flatMap((t) => (t.root ? [t.root] : [])).sort();
  const out: ProjectChoice[] = [{ value: '', label: 'All projects', root: '', project: '' }];
  for (const root of new Set(names)) {
    out.push({ value: root, label: root, root, project: '' });
    const labels = new Set(tasks.flatMap((t) => (t.root === root && t.project ? [t.project] : [])));
    if (labels.size < 2) continue;
    for (const project of [...labels].sort()) {
      out.push({
        value: `${root}${SEP}${project}`,
        label: `${root} / ${project}`,
        root,
        project,
      });
    }
  }
  return out;
}

/**
 * The `/api/timeline` path for a root, a project, a window and a clip length; null until it is
 * complete.
 */
export function timelinePath(opts: {
  /** The data root, such as `swarmup-web`; '' or absent for every root. */
  root?: string;
  project: string;
  days: number;
  custom: boolean;
  from: string;
  to: string;
  clip: number;
  /** The scene's extra query, such as `wrapped=1`. */
  query?: string;
}): string | null {
  const window = opts.custom
    ? opts.from
      ? `from=${q(opts.from)}${opts.to ? `&to=${q(opts.to)}` : ''}`
      : null
    : `days=${opts.days}`;
  if (!window) return null;
  const only = `${opts.root ? `&root=${q(opts.root)}` : ''}${opts.project ? `&project=${q(opts.project)}` : ''}`;
  return `/api/timeline?${window}&clip=${opts.clip}${only}${opts.query ? `&${opts.query}` : ''}`;
}

/** The PNG name for the current frame, such as `replay-counters-swarmup-0m12s.png`. */
export function frameFileName(scene: string, project: string, t: number): string {
  const s = Math.floor(Math.max(0, t) / 1000);
  const slug = `replay-${scene}-${project || 'all-projects'}-${Math.floor(s / 60)}m${s % 60}s`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 76);
  return `${slug}.png`;
}

/** Thrown when Cancel stops a PNG export. */
export class SaveCancelled extends Error {
  constructor() {
    super('Saving cancelled');
    this.name = 'SaveCancelled';
  }
}

/** Rasterizes frames at the given times and saves them through the desktop bridge. */
async function saveFrames(
  scene: Scene<unknown>,
  data: unknown,
  duration: number,
  shots: Array<{ name: string; t: number }>,
  overlay: FrameOverlay,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<string> {
  // Cancel ends the wait at once, even inside a frame that is still rasterizing.
  const cancelled = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new SaveCancelled()), { once: true }),
  );
  cancelled.catch(() => {});
  const files = [];
  for (const s of shots) {
    if (signal.aborted) throw new SaveCancelled();
    onProgress(files.length, shots.length);
    const svg = frameMarkup(renderFrame(scene, data, { ...STAGE_16_9, t: s.t, duration }, overlay));
    const png = svgToPng(svg, STAGE_16_9.width, STAGE_16_9.height);
    files.push({ name: s.name, data: await Promise.race([png, cancelled]) });
  }
  if (signal.aborted) throw new SaveCancelled();
  onProgress(files.length, shots.length);
  const res = await bridge().saveImages(files);
  if (!res.ok || !res.data) {
    if (res.error === 'cancelled') return '';
    throw new Error(res.error ?? 'saving failed');
  }
  const n = res.data.files.length;
  return `Saved ${n} PNG${n === 1 ? '' : 's'} to ${res.data.dir}`;
}

/**
 * Records the clip and saves it: asks for the folder first, so nobody waits through a recording
 * and then cancels the dialog. Resolves the line to show, or '' when the dialog was cancelled.
 */
export async function recordClip(
  opts: RecordOptions & { project: string },
  record: (opts: RecordOptions) => Promise<Uint8Array> = recordScene,
  /** Called once the folder is picked, just before recording starts. */
  onPicked?: () => void,
): Promise<string> {
  const folder = await bridge().videoFolder();
  if (!folder.ok) {
    if (folder.error === 'cancelled') return '';
    throw new Error(folder.error ?? 'no folder');
  }
  if (opts.signal?.aborted) throw new RecordCancelled();
  onPicked?.();
  const bytes = await record(opts);
  const name = videoFileName(opts.scene.id, opts.project, opts.aspect.id, opts.durationMs);
  const res = await bridge().saveVideo(name, bytes);
  if (!res.ok || !res.data) throw new Error(res.error ?? 'saving failed');
  return `Saved ${res.data.file} to ${res.data.dir}`;
}

/** An export that runs, from the click until its file is saved. */
export interface Busy {
  kind: 'png' | 'mp4' | 'gif';
  /** `folder`: the folder dialog is open; `render`: drawing frames; `save`: writing the file. */
  stage: 'folder' | 'render' | 'save';
  /** Frames (or PNGs) done of `total`; `total` is 0 until the first one is counted. */
  done: number;
  total: number;
}

/** The busy line's text, such as `Recording MP4 42% · 756 / 1800 frames`. */
export function busyText(b: Busy): string {
  const what = { png: 'Saving PNG', mp4: 'Recording MP4', gif: 'Encoding GIF' }[b.kind];
  if (b.stage === 'folder') return `${what}: pick a folder`;
  if (b.stage === 'save') return `${what}: saving the file`;
  if (b.total === 0) return `${what}: starting`;
  const pct = Math.floor((b.done / b.total) * 100);
  const unit = b.kind === 'png' ? (b.total === 1 ? 'image' : 'images') : 'frames';
  return `${what} ${pct}% · ${b.done} / ${b.total} ${unit}`;
}

/**
 * The busy line beside the export buttons: a bar (filling with the frames done, or pulsing while
 * the folder dialog is open, the encoder starts or the file is written), its text and Cancel.
 */
function ExportProgress({ busy, onCancel }: { busy: Busy; onCancel: () => void }) {
  const known = busy.stage === 'render' && busy.total > 0;
  const pct = known ? Math.floor((busy.done / busy.total) * 100) : 0;
  const label = { png: 'PNG export', mp4: 'MP4 export', gif: 'GIF export' }[busy.kind];
  const line = useRef<HTMLDivElement>(null);
  // The export row sits under the stage, often at the bottom edge of the window.
  useEffect(() => {
    // Braces: Chromium's scrollIntoView returns a promise, which React would call as cleanup.
    void line.current?.scrollIntoView?.({ block: 'nearest' });
  }, [busy.kind, busy.stage]);
  return (
    <div
      ref={line}
      // Fills the rest of the export row; the bar shrinks first, so the row does not wrap.
      className="flex min-w-[24rem] flex-1 items-center gap-2.5 rounded-lg border border-signal/25 bg-signal/5 py-0.5 pr-0.5 pl-2.5"
      data-testid="replay-busy"
      role="status"
    >
      <Loader2 size={15} className="animate-spin text-signal" />
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={known ? pct : undefined}
        className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={cx('h-full bg-signal transition-[width]', !known && 'animate-pulse')}
          style={{ width: known ? `${pct}%` : '100%', opacity: known ? 1 : 0.4 }}
        />
      </div>
      <span className="font-mono text-xs whitespace-nowrap text-fg-2">{busyText(busy)}</span>
      <button
        type="button"
        onClick={onCancel}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-3 hover:bg-white/6 hover:text-fg"
      >
        <X size={15} />
        Cancel
      </button>
    </div>
  );
}

/** Calls `onFrame` with the wall-clock ms since the last frame while `on` is true. */
function useFrames(on: boolean, onFrame: (dtMs: number) => void): void {
  const cb = useRef(onFrame);
  cb.current = onFrame;
  useEffect(() => {
    if (!on) return;
    let last: number | null = null;
    let id = requestAnimationFrame(function step(now: number) {
      if (last !== null) cb.current(now - last);
      last = now;
      id = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(id);
  }, [on]);
}

export interface ReplayProps {
  /** The recorder; tests pass a fake, since the test DOM has no video encoder. */
  record?: (opts: RecordOptions) => Promise<Uint8Array>;
  /** The GIF encoder; tests pass a fake to avoid rasterizing hundreds of frames. */
  gif?: (opts: GifOptions) => Promise<Uint8Array>;
}

/** Plays the project's history as a scene: pick a project, a window and a scene, then play. */
export function Replay({ record = recordScene, gif = recordGifScene }: ReplayProps) {
  // The picked `ProjectChoice` value. A choice that left the list (a removed root) still filters,
  // so the error from swarmupd shows instead of a silent switch to every project.
  const [pickedProject, setPickedProject] = useState('');
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clip, setClip] = useState<number>(30);
  const [sceneId, setSceneId] = useState(SCENES[0]!.id);
  const [showProject, setShowProject] = useState(true);
  const scene = sceneById(sceneId);
  const [saved, setSaved] = useState<{ text: string; error: boolean } | null>(null);
  const tasks = useData<Task[]>('/api/tasks?all');
  const settings = useData<Settings>('/api/settings');
  const projects = useMemo(
    () => projectChoices(settings.data?.rootList, tasks.data ?? []),
    [settings.data, tasks.data],
  );
  const [pickedRoot = '', pickedLabel = ''] = pickedProject.split(SEP);
  const { root, project } = projects.find((c) => c.value === pickedProject) ?? {
    root: pickedRoot,
    project: pickedLabel,
  };
  const projectName =
    projects.find((c) => c.value === pickedProject)?.label ??
    ([root, project].filter(Boolean).join(' / ') || 'All projects');
  const overlay: FrameOverlay = { projectName, showProject };
  const path = timelinePath({ root, project, days, custom, from, to, clip, query: scene.query });
  const { data: timeline, error } = useData<Timeline>(path);

  // Scenes about one thing, such as the review rally's task, offer a picker; the first choice
  // shows until the person picks another.
  const [picked, setPicked] = useState('');
  const choices = useMemo(
    () => (timeline && scene.pick ? scene.pick.choices(timeline) : []),
    [scene, timeline],
  );
  const choice = choices.some((c) => c.id === picked) ? picked : (choices[0]?.id ?? '');

  const playable = (timeline?.time.playbackMs ?? 0) > 0;
  const duration = timeline && playable ? sceneDuration(scene, timeline) : 0;
  const [p, setP] = useState<Playback>(() => initialPlayback(0));
  // A new window or a new choice starts again from 0; a refresh of the same keeps the playhead.
  const shown = `${path ?? ''}#${choice}`;
  const shownKey = useRef<string | null>(null);
  useEffect(() => {
    if (!timeline) return;
    if (shownKey.current !== shown) {
      shownKey.current = shown;
      setP((old) => initialPlayback(duration, old));
    } else {
      setP((old) => seek({ ...old, duration }, old.t));
    }
  }, [timeline, shown, duration]);
  useFrames(p.playing, (dt) => setP((old) => tick(old, dt)));

  const data = useMemo(
    () => (timeline ? scene.prepare(timeline, STAGE_16_9, choice || undefined) : null),
    [scene, timeline, choice],
  );
  const nothingToPick = scene.pick !== undefined && choices.length === 0;
  const empty = timeline !== undefined && (!playable || nothingToPick);
  // Files of a scene about one thing are named after it, such as the rally's task id.
  // Other files carry the chosen project: the root, then the label when one is picked.
  const subject = choice || [root, project].filter(Boolean).join('-');
  const cards = scene.id === 'wrapped' && timeline?.wrapped ? (data as WrappedData).cards : [];

  const [aspectId, setAspectId] = useState<Aspect['id']>('16x9');
  // The export that runs, shown from the click until its file is saved; null when idle.
  const [busy, setBusy] = useState<Busy | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  /** Starts an export: stops playback, clears the last result and shows the busy state at once. */
  const begin = (kind: Busy['kind'], stage: Busy['stage']): AbortController => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setP((old) => ({ ...old, playing: false }));
    setSaved(null);
    setBusy({ kind, stage, done: 0, total: 0 });
    return ctrl;
  };
  /** Progress for the bar, one update per percent: a re-render per frame would slow it down. */
  const progress = (kind: Busy['kind']) => {
    let shown = -1;
    return (done: number, total: number): void => {
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      if (pct === shown) return;
      shown = pct;
      setBusy({ kind, stage: done >= total ? 'save' : 'render', done, total });
    };
  };
  const end = (): void => {
    abort.current = null;
    setBusy(null);
  };

  const save = (shots: Array<{ name: string; t: number }>): void => {
    if (busy || data === null || shots.length === 0) return;
    const ctrl = begin('png', 'render');
    saveFrames(scene, data, duration, shots, overlay, ctrl.signal, progress('png'))
      .then((text) => setSaved(text ? { text, error: false } : null))
      .catch((err: Error) =>
        setSaved({ text: err.message, error: !(err instanceof SaveCancelled) }),
      )
      .finally(end);
  };
  const saveFrame = (): void => save([{ name: frameFileName(scene.id, subject, p.t), t: p.t }]);

  const startRecording = (): void => {
    if (busy || !timeline || duration <= 0) return;
    const ctrl = begin('mp4', 'folder');
    const onProgress = progress('mp4');
    recordClip(
      {
        scene,
        timeline,
        project: subject,
        ...overlay,
        choice: choice || undefined,
        aspect: aspectById(aspectId),
        durationMs: duration,
        signal: ctrl.signal,
        onProgress,
      },
      record,
      () => setBusy({ kind: 'mp4', stage: 'render', done: 0, total: 0 }),
    )
      .then((text) => setSaved(text ? { text, error: false } : null))
      .catch((err: Error) =>
        setSaved(
          err instanceof RecordCancelled
            ? { text: err.message, error: false }
            : { text: `Recording failed: ${err.message}`, error: true },
        ),
      )
      .finally(end);
  };
  const startGif = (): void => {
    if (busy || !timeline || duration <= 0) return;
    const ctrl = begin('gif', 'folder');
    const onProgress = progress('gif');
    bridge()
      .videoFolder()
      .then(async (folder) => {
        if (!folder.ok) {
          if (folder.error === 'cancelled') return null;
          throw new Error(folder.error ?? 'no folder');
        }
        if (ctrl.signal.aborted) throw new GifCancelled();
        setBusy({ kind: 'gif', stage: 'render', done: 0, total: 0 });
        const bytes = await gif({
          scene,
          timeline,
          aspect: aspectById(aspectId),
          choice: choice || undefined,
          durationMs: duration,
          signal: ctrl.signal,
          ...overlay,
          onProgress,
        });
        const name = gifFileName(scene.id, subject, GIF_WIDTH, GIF_FPS, duration);
        const res = await bridge().saveGif(name, bytes);
        if (!res.ok || !res.data) throw new Error(res.error ?? 'saving failed');
        return `Saved ${res.data.file} (${formatBytes(bytes.length)}) to ${res.data.dir}`;
      })
      .then((text) => setSaved(text ? { text, error: false } : null))
      .catch((err: Error) =>
        setSaved(
          err instanceof GifCancelled
            ? { text: err.message, error: false }
            : { text: `GIF export failed: ${err.message}`, error: true },
        ),
      )
      .finally(end);
  };
  const saveCards = (): void => {
    const w = timeline?.wrapped;
    if (!w) return;
    // The picked root and label, as in the frame and MP4 names: the report's own `project` is
    // the label alone, so `docs` of two roots would save under one name.
    const named = { project: [root, project].filter(Boolean).join('-') || w.project, to: w.to };
    save(
      cards.map((c, i) => ({
        name: cardFileName(named, c, i),
        t: cardTime(i, cards.length, duration),
      })),
    );
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (isTyping(e.target as HTMLElement) || duration <= 0) return;
    if (e.key === ' ') {
      e.preventDefault();
      setP(togglePlay);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const step = e.key === 'ArrowLeft' ? -1000 : 1000;
      setP((old) => seek(old, old.t + step));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setP((old) => seek(old, 0));
    }
  };

  return (
    <Section
      title="Replay"
      icon={Clapperboard}
      subtitle="Play a project's history: claims, reviews, asks and runs on a time axis"
      actions={
        <>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-fg-3">Project</span>
            <Select
              value={pickedProject}
              onChange={setPickedProject}
              options={projects.map((c): [string, string] => [c.value, c.label])}
              className="w-48"
            />
          </label>
          <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Range">
            {RANGES.map(([d, label]) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  setDays(d);
                  setCustom(false);
                }}
                aria-pressed={!custom && days === d}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs transition',
                  !custom && days === d ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                )}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setCustom(true)}
              aria-pressed={custom}
              className={cx(
                'rounded-md px-2.5 py-1 text-xs transition',
                custom ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
              )}
            >
              Custom
            </button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-4 p-6" onKeyDown={onKey}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {scene.clipMs === undefined ? (
            <>
              <span className="text-fg-3">Clip</span>
              <Select
                value={String(clip)}
                onChange={(v) => setClip(Number(v))}
                options={CLIPS.map((c): [string, string] => [String(c), `${c} s`])}
                className="w-24"
              />
              {scene.outroMs !== undefined && (
                <span className="text-fg-3">+ {scene.outroMs / 1000} s card</span>
              )}
            </>
          ) : (
            <span className="text-fg-3">Clip {scene.clipMs / 1000} s</span>
          )}
          {scene.pick && choices.length > 0 && (
            <>
              <span className="ml-2 text-fg-3">{scene.pick.label}</span>
              <Select
                value={choice}
                onChange={setPicked}
                options={choices.map((c): [string, string] => [c.id, c.label])}
                className="w-80"
              />
            </>
          )}
          {custom && (
            <>
              <span className="ml-2 text-fg-3">From</span>
              <input
                type="date"
                aria-label="From"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-fg"
              />
              <span className="text-fg-3">to</span>
              <input
                type="date"
                aria-label="To"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-[34px] rounded-lg border border-white/10 bg-ink-950/60 px-2 text-fg"
              />
            </>
          )}
          <label className="ml-auto flex items-center gap-2 text-xs text-fg-3">
            <input
              type="checkbox"
              role="switch"
              aria-label="Show project name"
              checked={showProject}
              onChange={(e) => setShowProject(e.target.checked)}
              className="accent-[#5ce1e6]"
            />
            Project name
          </label>
          <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Scene">
            {SCENES.map((s) => (
              <button
                key={s.id}
                type="button"
                title={s.description}
                aria-pressed={s.id === scene.id}
                onClick={() => setSceneId(s.id)}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs transition',
                  s.id === scene.id ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <ErrorLine error={error} />
        {custom && !from && (
          <div className="text-xs text-fg-4">Pick a start date; leave the end empty for now.</div>
        )}
        {empty && (
          <Empty
            icon={Clapperboard}
            title={playable && scene.pick ? scene.pick.empty : 'Nothing to replay in this window'}
          >
            Pick a longer window or another project. Replays fill in as agents claim, review and
            close tasks.
          </Empty>
        )}
        {timeline && data !== null && !empty && (
          <>
            <div className="panel overflow-hidden" data-testid="replay-stage">
              {renderFrame(scene, data, { ...STAGE_16_9, t: p.t, duration: p.duration }, overlay)}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                aria-label={p.playing ? 'Pause' : 'Play'}
                title={p.playing ? 'Pause (Space)' : 'Play (Space)'}
                onClick={() => setP(togglePlay)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-signal text-ink-950 hover:bg-[#7debef]"
              >
                {p.playing ? <Pause size={16} /> : <Play size={16} />}
              </button>
              <button
                type="button"
                aria-label="Back to start"
                title="Back to start (Home)"
                onClick={() => setP((old) => seek(old, 0))}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 hover:bg-white/6 hover:text-fg"
              >
                <SkipBack size={15} />
              </button>
              <input
                type="range"
                aria-label="Scrub"
                min={0}
                max={p.duration}
                step="any"
                value={p.t}
                onChange={(e) => setP((old) => seek(old, Number(e.target.value)))}
                className="min-w-48 flex-1 accent-[#5ce1e6]"
              />
              <span className="font-mono text-xs text-fg-3" data-testid="replay-clock">
                {clock(p.t)} / {clock(p.duration)}
              </span>
              <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Speed">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={p.speed === s}
                    onClick={() => setP((old) => ({ ...old, speed: s }))}
                    className={cx(
                      'rounded-md px-2 py-1 font-mono text-xs transition',
                      p.speed === s ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                    )}
                  >
                    {s}×
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-label="Loop"
                aria-pressed={p.loop}
                title="Loop"
                onClick={() => setP((old) => ({ ...old, loop: !old.loop }))}
                className={cx(
                  'flex h-8 w-8 items-center justify-center rounded-lg transition',
                  p.loop ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:bg-white/6 hover:text-fg',
                )}
              >
                <Repeat size={15} />
              </button>
              {cards.length > 0 && (
                <button
                  type="button"
                  onClick={saveCards}
                  disabled={busy !== null}
                  title="Save each Wrapped card as a 1920 x 1080 PNG"
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-signal/15 px-2.5 text-xs text-signal hover:bg-signal/25 disabled:opacity-50"
                >
                  <ImageDown size={15} />
                  Save {cards.length} cards
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3" data-testid="replay-record">
              <span className="text-xs text-fg-3">Export</span>
              <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Format">
                {ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    title={`${a.stage.width} x ${a.stage.height}`}
                    aria-pressed={a.id === aspectId}
                    disabled={busy !== null}
                    onClick={() => setAspectId(a.id)}
                    className={cx(
                      'rounded-md px-2 py-1 font-mono text-xs transition disabled:opacity-50',
                      a.id === aspectId ? 'bg-signal/15 text-signal' : 'text-fg-3 hover:text-fg',
                    )}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1" role="group" aria-label="Exports">
                <button
                  type="button"
                  onClick={saveFrame}
                  disabled={busy !== null}
                  aria-busy={busy?.kind === 'png'}
                  title="Save this frame as a 1920 x 1080 PNG"
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-3 hover:bg-white/6 hover:text-fg disabled:opacity-50"
                >
                  {busy?.kind === 'png' ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <ImageDown size={15} />
                  )}
                  Save frame
                </button>
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={busy !== null}
                  aria-busy={busy?.kind === 'mp4'}
                  title={`Record the whole clip as an MP4 at 60 fps, ${aspectById(aspectId).stage.width} x ${aspectById(aspectId).stage.height}`}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-signal/15 px-2.5 text-xs text-signal hover:bg-signal/25 disabled:opacity-50"
                >
                  {busy?.kind === 'mp4' ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Film size={15} />
                  )}
                  Record MP4
                </button>
                <button
                  type="button"
                  onClick={startGif}
                  disabled={busy !== null}
                  aria-busy={busy?.kind === 'gif'}
                  title={`Save the whole clip as a dithered GIF at ${GIF_FPS} fps and ${GIF_WIDTH} px wide`}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-signal/15 px-2.5 text-xs text-signal hover:bg-signal/25 disabled:opacity-50"
                >
                  {busy?.kind === 'gif' ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <Images size={15} />
                  )}
                  Save as GIF
                </button>
              </div>
              {busy ? (
                <ExportProgress busy={busy} onCancel={() => abort.current?.abort()} />
              ) : (
                <span className="text-xs text-fg-4">
                  GIF: clip-wide palette, dithering, {GIF_FPS} fps, {GIF_WIDTH} px wide
                </span>
              )}
            </div>
            {saved && (
              <div
                className={cx('text-xs', saved.error ? 'text-red-400' : 'text-fg-3')}
                data-testid="replay-saved"
              >
                {saved.text}
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
