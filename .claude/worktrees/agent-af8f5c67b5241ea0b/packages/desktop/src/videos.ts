// Videos the page records (Replay's Record). Kept apart from main.ts so it can be tested without
// Electron. The person picks the folder before the recording starts; the page then sends one MP4
// with a name it chose, so the name is checked strictly and nothing in the folder is overwritten.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freeName } from './images.js';

/** About 13 minutes at 1080p and 10 Mbit/s; far above the 60 s the player offers. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const NAME = /^[a-z0-9][a-z0-9-]{0,79}\.mp4$/;
const FTYP = [0x66, 0x74, 0x79, 0x70];

export interface VideoFile {
  name: string;
  data: Uint8Array;
}

/** The video from the page, checked: a plain lowercase `.mp4` name and MP4 bytes. Throws otherwise. */
export function videoFile(name: unknown, data: unknown): VideoFile {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('bad video name');
  if (!(data instanceof Uint8Array) || data.length < 8 || data.length > MAX_VIDEO_BYTES) {
    throw new Error(`${name}: video data missing or over 1 GB`);
  }
  // Every MP4 starts with an `ftyp` box: a 4-byte size, then the type.
  if (!FTYP.every((b, i) => data[4 + i] === b)) throw new Error(`${name}: not an MP4`);
  return { name, data };
}

/** Writes `file` into `dir` under a free name; returns the name used. */
export function writeVideo(dir: string, file: VideoFile): string {
  const name = freeName(file.name, (n) => existsSync(join(dir, n)));
  writeFileSync(join(dir, name), file.data, { flag: 'wx' });
  return name;
}
