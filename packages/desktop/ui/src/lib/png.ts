// Turns a replay frame into PNG bytes: the frame's SVG markup is loaded as an image from a data URL
// (allowed by the page's `img-src data:`) and drawn on a canvas of the stage size. The frame is
// plain SVG with no foreignObject or outside resources, so the canvas stays readable.
import type { ReactElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

/**
 * The markup of a frame from `renderFrame`, as a standalone SVG document. It renders into a
 * detached element with the client renderer the page already ships, rather than adding
 * `react-dom/server` to the bundle.
 */
export function frameMarkup(frame: ReactElement): string {
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    flushSync(() => root.render(frame));
    return host.innerHTML;
  } finally {
    root.unmount();
  }
}

/** The SVG as a data URL an `<img>` can load. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Draws frames one after another onto one canvas, for Record. */
export interface Rasterizer {
  /** Draws `frame` (from `renderFrame`) on the canvas and returns the canvas. */
  draw(frame: ReactElement): Promise<HTMLCanvasElement>;
  close(): void;
}

/**
 * A rasterizer for `width` x `height` frames. It keeps one React root and one canvas for the whole
 * clip, since a recording draws thousands of frames.
 */
export function createRasterizer(width: number, height: number): Rasterizer {
  const host = document.createElement('div');
  const root = createRoot(host);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  return {
    async draw(frame) {
      flushSync(() => root.render(frame));
      const img = new Image(width, height);
      img.src = svgDataUrl(host.innerHTML);
      await img.decode().catch(() => {
        throw new Error('the frame did not load as an image');
      });
      ctx.drawImage(img, 0, 0, width, height);
      return canvas;
    },
    close() {
      root.unmount();
    },
  };
}

/** Rasterizes `svg` at `width` x `height` and returns the PNG bytes. */
export async function svgToPng(svg: string, width: number, height: number): Promise<Uint8Array> {
  const img = new Image(width, height);
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('the frame did not load as an image'));
    img.src = svgDataUrl(svg);
  });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas');
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the canvas gave no PNG');
  return new Uint8Array(await blob.arrayBuffer());
}
