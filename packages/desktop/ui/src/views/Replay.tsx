import { Clapperboard, Film, ImageDown, Pause, Play, Repeat, SkipBack, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, q, useData } from '../api';
import { Empty, ErrorLine, Section, Select, cx } from '../components';
import { isTyping } from '../lib/keys';
import { frameMarkup, svgToPng } from '../lib/png';
import type { Aspect, RecordOptions } from '../lib/record';
import { ASPECTS, RecordCancelled, aspectById, recordScene, videoFileName } from '../lib/record';
import type { Playback } from '../lib/replay';
import { CLIPS, SPEEDS, clock, initialPlayback, seek, tick, togglePlay } from '../lib/replay';
import type { Scene } from '../replay/scene';
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

/** Rasterizes frames at the given times and saves them through the desktop bridge. */
async function saveFrames(
  scene: Scene<unknown>,
  data: unknown,
  duration: number,
  shots: Array<{ name: string; t: number }>,
): Promise<string> {
  const files = [];
  for (const s of shots) {
    const svg = frameMarkup(renderFrame(scene, data, { ...STAGE_16_9, t: s.t, duration }));
    files.push({ name: s.name, data: await svgToPng(svg, STAGE_16_9.width, STAGE_16_9.height) });
  }
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
): Promise<string> {
  const folder = await bridge().videoFolder();
  if (!folder.ok) {
    if (folder.error === 'cancelled') return '';
    throw new Error(folder.error ?? 'no folder');
  }
  const bytes = await record(opts);
  const name = videoFileName(opts.scene.id, opts.project, opts.aspect.id, opts.durationMs);
  const res = await bridge().saveVideo(name, bytes);
  if (!res.ok || !res.data) throw new Error(res.error ?? 'saving failed');
  return `Saved ${res.data.file} to ${res.data.dir}`;
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
}

/** Plays the project's history as a scene: pick a project, a window and a scene, then play. */
export function Replay({ record = recordScene }: ReplayProps) {
  // The picked `ProjectChoice` value. A choice that left the list (a removed root) still filters,
  // so the error from swarmupd shows instead of a silent switch to every project.
  const [pickedProject, setPickedProject] = useState('');
  const [days, setDays] = useState(7);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [clip, setClip] = useState<number>(30);
  const [sceneId, setSceneId] = useState(SCENES[0]!.id);
  const scene = sceneById(sceneId);
  const [saving, setSaving] = useState(false);
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

  const save = (shots: Array<{ name: string; t: number }>): void => {
    if (saving || data === null || shots.length === 0) return;
    setSaving(true);
    setSaved(null);
    saveFrames(scene, data, duration, shots)
      .then((text) => setSaved(text ? { text, error: false } : null))
      .catch((err: Error) => setSaved({ text: err.message, error: true }))
      .finally(() => setSaving(false));
  };
  const saveFrame = (): void => save([{ name: frameFileName(scene.id, subject, p.t), t: p.t }]);

  const [aspectId, setAspectId] = useState<Aspect['id']>('16x9');
  // Whole percent done while recording; null when idle.
  const [recording, setRecording] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const startRecording = (): void => {
    if (recording !== null || saving || !timeline || duration <= 0) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setP((old) => ({ ...old, playing: false }));
    setSaved(null);
    setRecording(0);
    let shown = 0;
    recordClip(
      {
        scene,
        timeline,
        project: subject,
        choice: choice || undefined,
        aspect: aspectById(aspectId),
        durationMs: duration,
        signal: ctrl.signal,
        // One update per percent: a re-render per frame would slow the recording down.
        onProgress: (done, total) => {
          const pct = Math.floor((done / total) * 100);
          if (pct !== shown) setRecording((shown = pct));
        },
      },
      record,
    )
      .then((text) => setSaved(text ? { text, error: false } : null))
      .catch((err: Error) =>
        setSaved(
          err instanceof RecordCancelled
            ? { text: err.message, error: false }
            : { text: `Recording failed: ${err.message}`, error: true },
        ),
      )
      .finally(() => {
        abort.current = null;
        setRecording(null);
      });
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
          <div className="ml-auto flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Scene">
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
              {renderFrame(scene, data, { ...STAGE_16_9, t: p.t, duration: p.duration })}
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
              <button
                type="button"
                onClick={saveFrame}
                disabled={saving || recording !== null}
                title="Save this frame as a 1920 x 1080 PNG"
                className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-3 hover:bg-white/6 hover:text-fg disabled:opacity-50"
              >
                <ImageDown size={15} />
                Save frame
              </button>
              {cards.length > 0 && (
                <button
                  type="button"
                  onClick={saveCards}
                  disabled={saving || recording !== null}
                  title="Save each Wrapped card as a 1920 x 1080 PNG"
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-signal/15 px-2.5 text-xs text-signal hover:bg-signal/25 disabled:opacity-50"
                >
                  <ImageDown size={15} />
                  Save {cards.length} cards
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3" data-testid="replay-record">
              <span className="text-xs text-fg-3">Video</span>
              <div className="flex rounded-lg bg-white/5 p-0.5" role="group" aria-label="Format">
                {ASPECTS.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    title={`${a.stage.width} x ${a.stage.height}`}
                    aria-pressed={a.id === aspectId}
                    disabled={recording !== null}
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
              {recording === null ? (
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={saving || recording !== null}
                  title={`Record the whole clip as an MP4 at 60 fps, ${aspectById(aspectId).stage.width} x ${aspectById(aspectId).stage.height}`}
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-signal/15 px-2.5 text-xs text-signal hover:bg-signal/25 disabled:opacity-50"
                >
                  <Film size={15} />
                  Record MP4
                </button>
              ) : (
                <>
                  <div
                    role="progressbar"
                    aria-label="Recording"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={recording}
                    className="h-2 w-48 overflow-hidden rounded-full bg-white/10"
                  >
                    <div className="h-full bg-signal" style={{ width: `${recording}%` }} />
                  </div>
                  <span className="font-mono text-xs text-fg-3">Recording {recording}%</span>
                  <button
                    type="button"
                    onClick={() => abort.current?.abort()}
                    className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-fg-3 hover:bg-white/6 hover:text-fg"
                  >
                    <X size={15} />
                    Cancel
                  </button>
                </>
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
