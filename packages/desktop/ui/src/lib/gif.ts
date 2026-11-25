// GIF export uses gifenc (MIT): it is a tiny, fast, pure-JS encoder that bundles with the page,
// so the app needs neither a network request nor ffmpeg at run time. We add ordered dithering
// here, use one palette sampled across the clip, write only the changed box of each frame with
// unchanged pixels transparent, and merge identical adjacent frames.
import { GIFEncoder, quantize } from 'gifenc';
import type { GifPalette } from 'gifenc';
import type { FrameOverlay, Scene, Stage } from '../replay/scene';
import { renderFrame } from '../replay/scene';
import type { Timeline } from '../types';
import { createRasterizer } from './png';
import type { Rasterizer } from './png';
import { frameCount, frameTime } from './record';
import type { Aspect } from './record';
import { paintBreaks } from './yield';

/** Web-friendly defaults: enough motion for UI animation without 1080p/60 fps GIF sizes. */
export const GIF_FPS = 15;
export const GIF_WIDTH = 960;
const PALETTE_FRAMES = 12;
const PALETTE_PIXELS = 160_000;
/** Most colors a palette may hold: 256 minus the transparent slot. */
const MAX_COLORS = 255;
/** Peak-to-peak strength of the ordered dither, in 8-bit channel steps. */
const DITHER = 16;

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

/** A scoped GIF name, such as `replay-events-acme-docs-960w-15fps-30s.gif`. */
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

/**
 * Moves the frame written at byte `start` to `box.x`, `box.y`. gifenc always writes frames at
 * 0, 0; its frame starts with an 8-byte Graphic Control Extension, then the Image Descriptor:
 * 0x2c, left, top, width, height (16-bit little-endian each).
 */
function placeFrame(bytes: Uint8Array, start: number, box: Box): void {
  const at = start + 8;
  if (bytes[start] !== 0x21 || bytes[start + 1] !== 0xf9 || bytes[at] !== 0x2c) {
    throw new Error('unexpected GIF frame layout from gifenc');
  }
  bytes[at + 1] = box.x & 0xff;
  bytes[at + 2] = box.x >> 8;
  bytes[at + 3] = box.y & 0xff;
  bytes[at + 4] = box.y >> 8;
}

/** The box of pixels that differ between two indexed frames, or null when they are the same. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function changedBox(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
): Box | null {
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 0;
    while (x < width && a[row + x] === b[row + x]) x++;
    if (x === width) continue;
    if (top < 0) top = y;
    bottom = y;
    if (x < left) left = x;
    let end = width - 1;
    while (end > right && a[row + end] === b[row + end]) end--;
    if (end > right) right = end;
  }
  if (top < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * The pixels of `box` in `next`, with every pixel that `shown` already displays replaced by
 * `transparent`: the viewer keeps the previous frame there, and long runs of one index compress
 * to almost nothing.
 */
export function deltaPixels(
  shown: Uint8Array,
  next: Uint8Array,
  width: number,
  box: Box,
  transparent: number,
): Uint8Array {
  const out = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y++) {
    const from = (box.y + y) * width + box.x;
    const to = y * box.width;
    for (let x = 0; x < box.width; x++) {
      const v = next[from + x]!;
      out[to + x] = v === shown[from + x] ? transparent : v;
    }
  }
  return out;
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

// 4x4 Bayer matrix, scaled to offsets of about +-DITHER / 2 per channel.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
  (m) => ((m + 0.5) / 16 - 0.5) * DITHER,
);

/**
 * Maps RGBA pixels to one palette with ordered (Bayer) dithering. Unlike error diffusion, a pixel's
 * index depends only on its own color and position, so pixels that do not change between frames
 * keep their index and the encoder can skip them.
 */
export function ditherToPalette(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  palette: GifPalette,
  cache: Int16Array = new Int16Array(1 << 18).fill(-1),
): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (y & 3) * 4;
    for (let x = 0; x < width; x++) {
      const pixel = (y * width + x) * 4;
      const offset = BAYER[row + (x & 3)]!;
      const r = Math.max(0, Math.min(255, Math.round(rgba[pixel]! + offset)));
      const g = Math.max(0, Math.min(255, Math.round(rgba[pixel + 1]! + offset)));
      const b = Math.max(0, Math.min(255, Math.round(rgba[pixel + 2]! + offset)));
      // Six-bit RGB cache: a full palette scan per pixel would dominate the export.
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let index = cache[key]!;
      if (index < 0) {
        index = closest(palette, r, g, b);
        cache[key] = index;
      }
      out[y * width + x] = index;
    }
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
  step: () => Promise<void>,
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
    await step();
  }
  // One slot stays free for the transparent index.
  return quantize(sample.subarray(0, at), MAX_COLORS, { format: 'rgb565' });
}

interface PendingFrame {
  pixels: Uint8Array;
  box: Box;
  transparent: boolean;
}

/**
 * Renders and encodes one clip. Every frame after the first holds only the box that changed, with
 * unchanged pixels inside it transparent; frames with no change extend the previous frame's delay.
 */
export async function recordGifScene(opts: GifOptions): Promise<Uint8Array> {
  const fps = opts.fps ?? GIF_FPS;
  const stage = gifStage(opts.aspect, opts.width ?? GIF_WIDTH);
  const frames = frameCount(opts.durationMs, fps);
  const data = opts.scene.prepare(opts.timeline, stage, opts.choice);
  const raster = (opts.rasterizer ?? createRasterizer)(stage.width, stage.height);
  // Progress counts the palette's sample frames too, so the bar moves from the first frame drawn.
  const total = sampledFrames(frames).length + frames;
  let done = 0;
  const pause = paintBreaks();
  const step = async (): Promise<void> => {
    opts.onProgress?.(++done, total);
    await pause();
  };
  try {
    const colors = (await clipPalette(raster, opts, data, stage, frames, fps, step)).slice(
      0,
      MAX_COLORS,
    );
    // GIF color tables hold a power of two entries. Pad to the next one above the colors and make
    // the last entry the transparent index; dithering picks only from `colors`, never that slot.
    let size = 2;
    while (size < colors.length + 1) size *= 2;
    const transparentIndex = size - 1;
    const palette = [...colors, ...Array.from({ length: size - colors.length }, () => [0, 0, 0])];
    const cache = new Int16Array(1 << 18).fill(-1);
    const gif = GIFEncoder();
    let shown: Uint8Array | null = null;
    let pending: PendingFrame | null = null;
    let delay = 0;
    let first = true;
    const write = (): void => {
      if (!pending) return;
      const { pixels, box, transparent } = pending;
      const start = gif.bytesView().length;
      gif.writeFrame(pixels, box.width, box.height, {
        ...(first ? { palette } : {}),
        delay,
        repeat: 0,
        // 1: leave this frame in place; the next one draws only its changes over it.
        dispose: 1,
        ...(transparent ? { transparent: true, transparentIndex } : {}),
      });
      if (box.x || box.y) placeFrame(gif.bytesView(), start, box);
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
      const indexed = ditherToPalette(rgba, stage.width, stage.height, colors, cache);
      // GIF delays are centiseconds; rounding the running total keeps the clip's length exact.
      const frameDelay = Math.round(((i + 1) * 100) / fps) * 10 - Math.round((i * 100) / fps) * 10;
      if (!shown) {
        pending = {
          pixels: indexed,
          box: { x: 0, y: 0, width: stage.width, height: stage.height },
          transparent: false,
        };
        shown = indexed;
        delay = frameDelay;
      } else {
        const box = changedBox(shown, indexed, stage.width, stage.height);
        if (box) {
          write();
          pending = {
            pixels: deltaPixels(shown, indexed, stage.width, box, transparentIndex),
            box,
            transparent: true,
          };
          shown = indexed;
          delay = frameDelay;
        } else {
          delay += frameDelay;
        }
      }
      await step();
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
