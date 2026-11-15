// GIF export uses gifenc (MIT): it is a tiny, fast, pure-JS encoder that bundles with the page,
// so the app needs neither a network request nor ffmpeg at run time. We add Floyd-Steinberg
// dithering here, use one palette sampled across the clip, and merge identical adjacent frames.
import { GIFEncoder, quantize } from 'gifenc';
import type { GifPalette } from 'gifenc';
import type { FrameOverlay, Scene, Stage } from '../replay/scene';
import { renderFrame } from '../replay/scene';
import type { Timeline } from '../types';
import { createRasterizer } from './png';
import type { Rasterizer } from './png';
import { frameCount, frameTime } from './record';
import type { Aspect } from './record';

/** Web-friendly defaults: enough motion for UI animation without 1080p/60 fps GIF sizes. */
export const GIF_FPS = 15;
export const GIF_WIDTH = 960;
const PALETTE_FRAMES = 12;
const PALETTE_PIXELS = 160_000;

export interface GifOptions extends FrameOverlay {
  scene: Scene<unknown>;
  timeline: Timeline;
  aspect: Aspect;
  choice?: string;
  durationMs: number;
  fps?: number;
  width?: number;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
  rasterizer?(width: number, height: number): Rasterizer;
}

export class GifCancelled extends Error {
  constructor() {
    super('GIF export cancelled');
    this.name = 'GifCancelled';
  }
}

/** GIF stage with the selected aspect and a file-size-conscious width. */
export function gifStage(aspect: Aspect, width = GIF_WIDTH): Stage {
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round((width * aspect.stage.height) / aspect.stage.width)),
  };
}

/** A scoped GIF name, such as `replay-events-agent-ops-docs-960w-15fps-30s.gif`. */
export function gifFileName(
  scene: string,
  project: string,
  width: number,
  fps: number,
  durationMs: number,
): string {
  const seconds = Math.round(Math.max(0, durationMs) / 1000);
  const base = `replay-${scene}-${project || 'all-projects'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 56);
  return `${base}-${width}w-${fps}fps-${seconds}s.gif`;
}

function sameFrame(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function closest(palette: GifPalette, r: number, g: number, b: number): number {
  let best = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i]!;
    const dr = r - p[0]!;
    const dg = g - p[1]!;
    const db = b - p[2]!;
    const d = dr * dr + dg * dg + db * db;
    if (d < distance) {
      distance = d;
      best = i;
    }
  }
  return best;
}

/** Maps RGBA pixels to one palette with Floyd-Steinberg error diffusion. */
export function ditherToPalette(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: GifPalette,
): Uint8Array {
  const out = new Uint8Array(width * height);
  let current = new Float32Array((width + 2) * 3);
  let next = new Float32Array((width + 2) * 3);
  // Five-bit RGB cache: dithering creates many nearby colors, and a full palette scan per pixel
  // would dominate a 15 fps export.
  const cache = new Int16Array(1 << 15);
  cache.fill(-1);
  const add = (row: Float32Array, x: number, c: number, value: number): void => {
    const i = (x + 1) * 3 + c;
    row[i] = row[i]! + value;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4;
      const error = (x + 1) * 3;
      const r = Math.max(0, Math.min(255, rgba[pixel]! + current[error]!));
      const g = Math.max(0, Math.min(255, rgba[pixel + 1]! + current[error + 1]!));
      const b = Math.max(0, Math.min(255, rgba[pixel + 2]! + current[error + 2]!));
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      let index = cache[key]!;
      if (index < 0) {
        index = closest(palette, r, g, b);
        cache[key] = index;
      }
      out[y * width + x] = index;
      const p = palette[index]!;
      const er = r - p[0]!;
      const eg = g - p[1]!;
      const eb = b - p[2]!;
      for (const [c, e] of [
        [0, er],
        [1, eg],
        [2, eb],
      ] as const) {
        add(current, x + 1, c, (e * 7) / 16);
        add(next, x - 1, c, (e * 3) / 16);
        add(next, x, c, (e * 5) / 16);
        add(next, x + 1, c, e / 16);
      }
    }
    const old = current;
    current = next;
    next = old;
    next.fill(0);
  }
  return out;
}

function sampledFrames(total: number): number[] {
  const count = Math.min(PALETTE_FRAMES, total);
  return [
    ...new Set(
      Array.from({ length: count }, (_, i) =>
        Math.round((i * (total - 1)) / Math.max(1, count - 1)),
      ),
    ),
  ];
}

async function clipPalette(
  raster: Rasterizer,
  opts: GifOptions,
  data: unknown,
  stage: Stage,
  frames: number,
  fps: number,
): Promise<GifPalette> {
  const picks = sampledFrames(frames);
  const every = Math.max(
    1,
    Math.ceil((stage.width * stage.height * picks.length) / PALETTE_PIXELS),
  );
  const sample = new Uint8Array(Math.ceil((stage.width * stage.height) / every) * picks.length * 4);
  let at = 0;
  for (const i of picks) {
    if (opts.signal?.aborted) throw new GifCancelled();
    const canvas = await raster.draw(
      renderFrame(
        opts.scene,
        data,
        {
          ...stage,
          t: frameTime(i, frames, opts.durationMs, fps),
          duration: opts.durationMs,
        },
        opts,
      ),
    );
    const rgba = canvas
      .getContext('2d', { willReadFrequently: true })!
      .getImageData(0, 0, stage.width, stage.height).data;
    for (let p = 0; p < stage.width * stage.height; p += every) {
      const source = p * 4;
      sample[at++] = rgba[source]!;
      sample[at++] = rgba[source + 1]!;
      sample[at++] = rgba[source + 2]!;
      sample[at++] = 255;
    }
  }
  return quantize(sample.subarray(0, at), 256, { format: 'rgb565' });
}

/** Renders and encodes one clip, using a global palette and longer delays for unchanged frames. */
export async function recordGifScene(opts: GifOptions): Promise<Uint8Array> {
  const fps = opts.fps ?? GIF_FPS;
  const stage = gifStage(opts.aspect, opts.width ?? GIF_WIDTH);
  const frames = frameCount(opts.durationMs, fps);
  const data = opts.scene.prepare(opts.timeline, stage, opts.choice);
  const raster = (opts.rasterizer ?? createRasterizer)(stage.width, stage.height);
  try {
    const palette = await clipPalette(raster, opts, data, stage, frames, fps);
    const gif = GIFEncoder();
    let previous: Uint8Array | null = null;
    let delay = 0;
    let first = true;
    const write = (): void => {
      if (!previous) return;
      gif.writeFrame(previous, stage.width, stage.height, {
        ...(first ? { palette } : {}),
        delay,
        repeat: 0,
      });
      first = false;
    };
    for (let i = 0; i < frames; i++) {
      if (opts.signal?.aborted) throw new GifCancelled();
      const canvas = await raster.draw(
        renderFrame(
          opts.scene,
          data,
          {
            ...stage,
            t: frameTime(i, frames, opts.durationMs, fps),
            duration: opts.durationMs,
          },
          opts,
        ),
      );
      const rgba = canvas
        .getContext('2d', { willReadFrequently: true })!
        .getImageData(0, 0, stage.width, stage.height).data;
      const indexed = ditherToPalette(rgba, stage.width, stage.height, palette);
      // GIF delays are centiseconds. Alternating 60/70 ms preserves 15 fps on average.
      const frameDelay = Math.round(((i + 1) * 100) / fps) * 10 - Math.round((i * 100) / fps) * 10;
      if (previous && !sameFrame(previous, indexed)) {
        write();
        previous = indexed;
        delay = frameDelay;
      } else {
        previous ??= indexed;
        delay += frameDelay;
      }
      opts.onProgress?.(i + 1, frames);
    }
    write();
    gif.finish();
    return gif.bytes();
  } finally {
    raster.close();
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
