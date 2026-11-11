// Images the page asks to save (Wrapped cards, replay frames). Kept apart from main.ts so it can
// be tested without Electron. The page names the files, so names are checked strictly: a plain
// `.png` file name, no folders, and nothing in the folder is ever overwritten.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_IMAGES = 20;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}\.png$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface ImageFile {
  name: string;
  data: Uint8Array;
}

/** The files from the page, checked: 1 to 20 PNGs with plain lowercase names. Throws otherwise. */
export function imageFiles(input: unknown): ImageFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_IMAGES) {
    throw new Error(`give 1 to ${MAX_IMAGES} images`);
  }
  return input.map((f: unknown) => {
    const { name, data } = (f ?? {}) as { name?: unknown; data?: unknown };
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error('bad image name');
    if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_IMAGE_BYTES) {
      throw new Error(`${name}: image data missing or over 20 MB`);
    }
    if (!PNG_MAGIC.every((b, i) => data[i] === b)) throw new Error(`${name}: not a PNG`);
    return { name, data };
  });
}

/** `name`, or `name-2.png`, `name-3.png` and so on: the first that `taken` says is free. */
export function freeName(name: string, taken: (name: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const next = `${base}-${i}${ext}`;
    if (!taken(next)) return next;
  }
}

/** Writes `files` into `dir` under free names; returns the names used. */
export function writeImages(dir: string, files: ImageFile[]): string[] {
  const used = new Set<string>();
  return files.map((f) => {
    const name = freeName(f.name, (n) => used.has(n) || existsSync(join(dir, n)));
    writeFileSync(join(dir, name), f.data, { flag: 'wx' });
    used.add(name);
    return name;
  });
}
