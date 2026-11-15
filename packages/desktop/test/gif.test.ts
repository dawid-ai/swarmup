// @vitest-environment happy-dom
// GIF export: web-sized frames, one palette, dithering, unchanged-frame merging, and valid bytes.
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  GIF_FPS,
  GIF_WIDTH,
  ditherToPalette,
  gifFileName,
  gifStage,
  recordGifScene,
} from '../ui/src/lib/gif';
import type { Rasterizer } from '../ui/src/lib/png';
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
});
