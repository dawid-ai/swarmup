// @vitest-environment happy-dom
// GIF export: web-sized frames, one palette, ordered dithering, changed-box frames with
// transparency, unchanged-frame merging, and valid bytes.
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  GIF_FPS,
  GIF_WIDTH,
  changedBox,
  deltaPixels,
  ditherToPalette,
  gifFileName,
  gifStage,
  recordGifScene,
} from '../ui/src/lib/gif';
import type { Rasterizer } from '../ui/src/lib/png';
import { paintBreaks } from '../ui/src/lib/yield';
import { aspectById } from '../ui/src/lib/record';
import { sceneById } from '../ui/src/replay/scenes';
import { fixture } from './replay-fixture';

function gifInfo(bytes: Uint8Array): { frames: number; delayMs: number } {
  let frames = 0;
  let delayMs = 0;
  for (let i = 0; i < bytes.length - 7; i++) {
    if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 4) {
      delayMs += (bytes[i + 4]! | (bytes[i + 5]! << 8)) * 10;
    }
    if (bytes[i] === 0x2c) frames++;
  }
  return { frames, delayMs };
}

function fakeRasterizer(width: number, height: number, colors: number[][]): Rasterizer {
  let draw = 0;
  return {
    draw: async (_frame: ReactElement) => {
      const color = colors[draw++ % colors.length]!;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = color[0]!;
        data[i + 1] = color[1]!;
        data[i + 2] = color[2]!;
        data[i + 3] = 255;
      }
      return {
        getContext: () => ({ getImageData: () => ({ data }) }),
      } as unknown as HTMLCanvasElement;
    },
    close: () => {},
  };
}

describe('GIF export', () => {
  it('uses 15 fps, 960 px and scoped names by default', () => {
    expect(GIF_FPS).toBe(15);
    expect(GIF_WIDTH).toBe(960);
    expect(gifStage(aspectById('16x9'))).toEqual({ width: 960, height: 540 });
    expect(gifStage(aspectById('9x16'))).toEqual({ width: 960, height: 1707 });
    expect(gifFileName('events', 'agent-ops-docs', 960, 15, 30_000)).toBe(
      'replay-events-agent-ops-docs-960w-15fps-30s.gif',
    );
  });

  it('dithers pixels into the supplied palette', () => {
    const pixels = new Uint8ClampedArray([
      90, 90, 90, 255, 170, 170, 170, 255, 90, 90, 90, 255, 170, 170, 170, 255,
    ]);
    const indexed = ditherToPalette(pixels, 2, 2, [
      [0, 0, 0],
      [255, 255, 255],
    ]);
    expect(indexed).toHaveLength(4);
    expect(new Set(indexed)).toEqual(new Set([0, 1]));
  });

  // AO-0375: the bar stayed at 0 because the export never returned to the event loop.
  it('reports progress from the first palette frame, and lets the page paint while it runs', async () => {
    const timeline = fixture();
    timeline.time.playbackMs = 200;
    const calls: Array<[number, number]> = [];
    let ticks = 0;
    // A timer the page queues: it runs only if the export yields a macrotask.
    const timer = setInterval(() => ticks++, 0);
    const slow = (width: number, height: number): Rasterizer => {
      const fake = fakeRasterizer(width, height, [[220, 30, 30]]);
      return {
        ...fake,
        draw: async (frame) => {
          // 60 ms of busy work per frame, more than one paint break.
          const until = performance.now() + 60;
          while (performance.now() < until);
          return fake.draw(frame);
        },
      };
    };
    try {
      await recordGifScene({
        scene: sceneById('events'),
        timeline,
        aspect: aspectById('16x9'),
        durationMs: 200,
        width: 8,
        rasterizer: slow,
        onProgress: (done, total) => calls.push([done, total]),
      });
    } finally {
      clearInterval(timer);
    }
    // 3 palette sample frames, then 3 encoded frames.
    expect(calls).toEqual([1, 2, 3, 4, 5, 6].map((d) => [d, 6]));
    expect(ticks).toBeGreaterThan(0);
  });

  it('pauses for a macrotask only after the given time has passed', async () => {
    let now = 0;
    const pause = paintBreaks(50, () => now);
    let ran = false;
    setTimeout(() => (ran = true), 0);
    now = 49;
    await pause();
    expect(ran).toBe(false);
    now = 50;
    await pause();
    expect(ran).toBe(true);
  });

  it('writes a browser GIF and merges unchanged adjacent frames into their delay', async () => {
    const timeline = fixture();
    timeline.time.playbackMs = 200;
    const bytes = await recordGifScene({
      scene: sceneById('events'),
      timeline,
      aspect: aspectById('16x9'),
      durationMs: 200,
      width: 8,
      rasterizer: (width, height) =>
        // Three palette frames, then the same three encoded frames: red, red, blue.
        fakeRasterizer(width, height, [
          [220, 30, 30],
          [220, 30, 30],
          [30, 80, 220],
        ]),
    });
    expect(new TextDecoder().decode(bytes.subarray(0, 6))).toBe('GIF89a');
    expect(bytes.at(-1)).toBe(0x3b);
    expect(gifInfo(bytes)).toEqual({ frames: 2, delayMs: 200 });
    expect(bytes.length).toBeLessThan(8 * 5 * 4 * 3);
  });

  it('keeps an unchanged pixel on the same index whatever its neighbors do', () => {
    const palette = [
      [0, 0, 0],
      [128, 128, 128],
      [255, 255, 255],
    ];
    // 64 sits halfway between two palette colors, so the dither mixes them.
    const a = new Uint8ClampedArray(4 * 4 * 4).fill(64);
    const b = a.slice();
    // Frame b changes only the first row; error diffusion would shift the rows after it.
    for (let i = 0; i < 16; i++) b[i] = 250;
    const ia = ditherToPalette(a, 4, 4, palette);
    const ib = ditherToPalette(b, 4, 4, palette);
    expect(ib.subarray(4)).toEqual(ia.subarray(4));
  });

  it('finds the box of changed pixels and makes unchanged pixels inside it transparent', () => {
    const a = new Uint8Array(5 * 4);
    const b = a.slice();
    b[1 * 5 + 1] = 3;
    b[2 * 5 + 3] = 4;
    expect(changedBox(a, a, 5, 4)).toBeNull();
    const box = changedBox(a, b, 5, 4)!;
    expect(box).toEqual({ x: 1, y: 1, width: 3, height: 2 });
    expect([...deltaPixels(a, b, 5, box, 255)]).toEqual([3, 255, 255, 255, 255, 4]);
  });

  it('writes later frames as the changed box only, at its position', async () => {
    const width = 40;
    const height = 20;
    let draw = 0;
    const rasterizer = (): Rasterizer => ({
      draw: async () => {
        // Palette sampling draws 3 frames, then encoding draws the same 3. Frame 2 lights a
        // 4 x 3 box at 10, 5.
        const lit = draw++ % 3 === 2;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const on = lit && x >= 10 && x < 14 && y >= 5 && y < 8;
            data[i] = on ? 240 : 20;
            data[i + 1] = on ? 200 : 20;
            data[i + 2] = on ? 40 : 30;
            data[i + 3] = 255;
          }
        }
        return {
          getContext: () => ({ getImageData: () => ({ data }) }),
        } as unknown as HTMLCanvasElement;
      },
      close: () => {},
    });
    const timeline = fixture();
    timeline.time.playbackMs = 200;
    const bytes = await recordGifScene({
      scene: sceneById('events'),
      timeline,
      aspect: { ...aspectById('16x9'), stage: { width: 2, height: 1 } },
      durationMs: 200,
      width,
      rasterizer,
    });
    const frames = imageDescriptors(bytes);
    expect(frames).toEqual([
      { x: 0, y: 0, width: 40, height: 20 },
      { x: 10, y: 5, width: 4, height: 3 },
    ]);
    expect(gifInfo(bytes).delayMs).toBe(200);
  });
});

/** Position and size of each frame, read by walking the GIF's blocks. */
function imageDescriptors(
  bytes: Uint8Array,
): { x: number; y: number; width: number; height: number }[] {
  const u16 = (at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
  const out = [];
  let at = 13;
  if (bytes[10]! & 0x80) at += 3 * 2 ** ((bytes[10]! & 7) + 1);
  const blocks = (): void => {
    for (let n = bytes[at++]!; n; n = bytes[at++]!) at += n;
  };
  while (at < bytes.length) {
    const kind = bytes[at++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      at++;
      blocks();
    } else if (kind === 0x2c) {
      out.push({ x: u16(at), y: u16(at + 2), width: u16(at + 4), height: u16(at + 6) });
      at += 8;
      const packed = bytes[at++]!;
      if (packed & 0x80) at += 3 * 2 ** ((packed & 7) + 1);
      at++;
      blocks();
    } else throw new Error(`unknown GIF block ${kind}`);
  }
  return out;
}
