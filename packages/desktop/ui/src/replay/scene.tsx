// The contract every Replay scene follows. A scene is one module: `prepare` turns a timeline into
// whatever it draws from, once per timeline and stage, and `render` draws one frame as SVG.
//
// Both are pure. A frame depends only on the prepared data and `frame.t`: no `Date.now()`,
// `performance.now()`, no `Math.random()` (use `seeded` from `lib/replay.ts`), no state, no
// effects, and no locale or time zone formatting (use `utcStamp`). That is what lets Record
// render the same frames offscreen at a fixed frame rate and get what the screen showed.
import type { ReactElement } from 'react';
import type { Timeline } from '../types';

/** The drawing area in SVG units. 1920 x 1080 for 16:9; Record adds 1:1 and 9:16. */
export interface Stage {
  width: number;
  height: number;
}

export const STAGE_16_9: Stage = { width: 1920, height: 1080 };

/** One frame to draw: playback time `t` in ms on a clip of `duration` ms. */
export interface Frame extends Stage {
  t: number;
  duration: number;
}

/** One thing a scene can be about, such as a task, for the view's picker. */
export interface Choice {
  id: string;
  label: string;
}

/** For scenes about one thing in the timeline: what the view's picker offers. */
export interface ScenePick {
  /** The picker's label, such as `Task`. */
  label: string;
  /** What the view says when the window has nothing to pick. */
  empty: string;
  /** The choices, best first; the view picks the first until the person picks another. */
  choices(timeline: Timeline): Choice[];
}

export interface Scene<D = unknown> {
  /** Stable key, used in the URL of a recording and in tests. */
  id: string;
  label: string;
  /** One line for the scene picker's tooltip. */
  description: string;
  /** Extra `/api/timeline` query the scene reads, such as `wrapped=1`. */
  query?: string;
  /** Set for scenes about one thing, such as one task; the view shows a picker. */
  pick?: ScenePick;
  /**
   * A fixed clip length in ms, for scenes that don't follow the timeline's time axis. The player
   * and Record use it instead of the timeline's playback length.
   */
  clipMs?: number;
  /**
   * Ms the clip runs past the end of the timeline, for a closing card such as the Human loop
   * stat card. `render` gets `frame.t` up to the timeline's playback length plus this.
   */
  outroMs?: number;
  /**
   * Builds the scene's data from the timeline. Called once per timeline, stage and choice.
   * `choice` is the id picked from `pick.choices`; without one, the scene takes the first.
   */
  prepare(timeline: Timeline, stage: Stage, choice?: string): D;
  /** Draws frame `frame.t` as SVG children of a `0 0 width height` view box. */
  render(data: D, frame: Frame): ReactElement;
}

/**
 * The clip length of `scene` on `timeline` in ms: its fixed `clipMs`, or the timeline's playback
 * length plus the scene's outro. 0 when the timeline has nothing to play.
 */
export function sceneDuration(scene: Scene<unknown>, timeline: Timeline): number {
  if (!(timeline.time.playbackMs > 0)) return 0;
  return scene.clipMs ?? timeline.time.playbackMs + (scene.outroMs ?? 0);
}

/** The background every scene draws on, so recordings never come out transparent. */
export const BACKDROP = '#0b0f14';

/** One frame as a complete SVG element, for the player and for Record. */
export function renderFrame<D>(scene: Scene<D>, data: D, frame: Frame): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      width={frame.width}
      height={frame.height}
      data-scene={scene.id}
      role="img"
      aria-label={`${scene.label} replay`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
      <rect width={frame.width} height={frame.height} fill={BACKDROP} />
      {scene.render(data, frame)}
    </svg>
  );
}
