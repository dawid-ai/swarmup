// The Replay player's clock and the real-to-playback time map. Pure functions: the view feeds
// them frame deltas, scenes read only the playback time `t` they produce, and tests drive them
// without a browser.
import type { TimeMap } from '../types';

/** Playback speeds the player offers, as multiples of real playback time. */
export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

/** Clip lengths in seconds the player offers; the server scales playback to this length. */
export const CLIPS = [15, 30, 60] as const;

/** The player's state. Times are playback ms from 0. */
export interface Playback {
  t: number;
  duration: number;
  playing: boolean;
  speed: number;
  loop: boolean;
}

export function initialPlayback(duration: number, keep?: Partial<Playback>): Playback {
  return {
    t: 0,
    duration: Math.max(0, duration),
    playing: false,
    speed: keep?.speed ?? 1,
    loop: keep?.loop ?? false,
  };
}

/**
 * Advances a playing clock by `dtMs` of wall time. At the end it wraps when looping; otherwise it
 * stops on the last frame and pauses.
 */
export function tick(p: Playback, dtMs: number): Playback {
  if (!p.playing || p.duration <= 0 || !(dtMs > 0)) return p;
  const t = p.t + dtMs * p.speed;
  if (t < p.duration) return { ...p, t };
  if (p.loop) return { ...p, t: t % p.duration };
  return { ...p, t: p.duration, playing: false };
}

/** Moves the playhead to `t`, clamped to the clip. */
export function seek(p: Playback, t: number): Playback {
  const clamped = Number.isFinite(t) ? Math.min(Math.max(0, t), p.duration) : 0;
  return { ...p, t: clamped };
}

/** Play or pause. Play on the last frame starts again from 0. */
export function togglePlay(p: Playback): Playback {
  if (p.playing) return { ...p, playing: false };
  if (p.duration <= 0) return p;
  return { ...p, playing: true, t: p.t >= p.duration ? 0 : p.t };
}

/** `m:ss.d` for playback ms. */
export function clock(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);
  const m = Math.floor(tenths / 600);
  const s = Math.floor((tenths % 600) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${tenths % 10}`;
}

/**
 * The playback time of real time `ms`, clamped to the map's ends. A copy of `playbackAt` in
 * `packages/core/src/timeline.ts`, which the page cannot import.
 */
export function playbackAt(map: TimeMap, ms: number): number {
  const segs = map.segments;
  if (segs.length === 0) return 0;
  if (ms <= segs[0]!.start) return 0;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.end < ms) lo = mid + 1;
    else hi = mid;
  }
  const s = segs[lo]!;
  if (ms >= s.end) return s.playEnd;
  return s.playStart + ((ms - s.start) / (s.end - s.start)) * (s.playEnd - s.playStart);
}

/** The playback time of an ISO timestamp. */
export function playbackOf(map: TimeMap, iso: string): number {
  return playbackAt(map, Date.parse(iso));
}

/** The real time (ms since the epoch) at playback time `t`: the inverse of `playbackAt`. */
export function realAt(map: TimeMap, t: number): number {
  const segs = map.segments;
  if (segs.length === 0) return 0;
  if (t <= segs[0]!.playStart) return segs[0]!.start;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.playEnd < t) lo = mid + 1;
    else hi = mid;
  }
  const s = segs[lo]!;
  if (t >= s.playEnd) return s.end;
  if (s.playEnd === s.playStart) return s.start;
  return s.start + ((t - s.playStart) / (s.playEnd - s.playStart)) * (s.end - s.start);
}

/** Real time as `YYYY-MM-DD HH:MM UTC`: the same text on every machine, unlike locale formats. */
export function utcStamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * A seeded random number generator (mulberry32) for scenes that want jitter or layout noise:
 * the same seed gives the same sequence, so a frame renders the same every time.
 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit seed for a string, such as a task id, for `seeded`. */
export function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
