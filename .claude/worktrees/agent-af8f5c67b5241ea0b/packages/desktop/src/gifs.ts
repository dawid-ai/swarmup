// GIF recordings from Replay. Kept separate from the Electron main process so validation and
// collision-safe writes are covered without opening a window.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freeName } from './images.js';

export const MAX_GIF_BYTES = 200 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}\.gif$/;
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

export interface GifFile {
  name: string;
  data: Uint8Array;
}

export function gifFile(name: unknown, data: unknown): GifFile {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('bad GIF name');
  if (!(data instanceof Uint8Array) || data.length < 14 || data.length > MAX_GIF_BYTES) {
    throw new Error(`${name}: GIF data missing or over 200 MB`);
  }
  const header = (signature: number[]): boolean => signature.every((b, i) => data[i] === b);
  if (!header(GIF87) && !header(GIF89)) throw new Error(`${name}: not a GIF`);
  if (data.at(-1) !== 0x3b) throw new Error(`${name}: unfinished GIF`);
  return { name, data };
}

export function writeGif(dir: string, file: GifFile): string {
  const name = freeName(file.name, (n) => existsSync(join(dir, n)));
  writeFileSync(join(dir, name), file.data, { flag: 'wx' });
  return name;
}
