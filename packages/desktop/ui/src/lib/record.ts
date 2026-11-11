// Record: turns a replay scene into an MP4. Frames are drawn offscreen at a fixed 60 fps from
// playback time alone, so the speed of the machine or the display never changes the video. Each
// frame goes through Chromium's WebCodecs H.264 encoder and into an MP4 with mp4-muxer (MIT); no
// ffmpeg ships with the app.
//
// The encoder and the frame constructor are passed in, so tests drive the whole loop and the real
// muxer without a browser encoder.
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import type { Scene, Stage } from '../replay/scene';
import { renderFrame } from '../replay/scene';
import type { Timeline } from '../types';
import type { Rasterizer } from './png';
import { createRasterizer } from './png';

/** Frames per second of every recording. */
export const FPS = 60;

export interface Aspect {
  id: '16x9' | '1x1' | '9x16';
  label: string;
  stage: Stage;
}

/** The formats Record exports: landscape for X and LinkedIn posts, square, and vertical. */
export const ASPECTS: Aspect[] = [
  { id: '16x9', label: '16:9', stage: { width: 1920, height: 1080 } },
  { id: '1x1', label: '1:1', stage: { width: 1080, height: 1080 } },
  { id: '9x16', label: '9:16', stage: { width: 1080, height: 1920 } },
];

export function aspectById(id: string): Aspect {
  return ASPECTS.find((a) => a.id === id) ?? ASPECTS[0]!;
}

/**
 * H.264 profiles to try, best first, all at level 4.2: enough for 1920 x 1080 and 1080 x 1920 at
 * 60 fps. High is what X and LinkedIn recommend; Main and Baseline are fallbacks for encoders
 * that lack it.
 */
export const AVC_CODECS = ['avc1.64002A', 'avc1.4D402A', 'avc1.42E02A'] as const;

/** A keyframe every 2 s, so players and upload pipelines can seek and cut cleanly. */
export const KEYFRAME_EVERY = 2 * FPS;

/** Frames the encoder may hold before the loop waits; keeps memory flat on long clips. */
const MAX_QUEUE = 8;

/** The number of frames for a clip of `durationMs`; at least 1. */
export function frameCount(durationMs: number, fps = FPS): number {
  return Math.max(1, Math.round((Math.max(0, durationMs) * fps) / 1000));
}

/**
 * Playback time of frame `i` of `n`: frame i shows `i / fps` seconds in, and the last frame shows
 * the clip's final state, so a recording ends where the player does.
 */
export function frameTime(i: number, n: number, durationMs: number, fps = FPS): number {
  if (i >= n - 1) return Math.max(0, durationMs);
  return Math.min(durationMs, (i * 1000) / fps);
}

/** Frame `i`'s presentation time and length in microseconds, as WebCodecs and MP4 use them. */
export function frameStamp(i: number, fps = FPS): { timestamp: number; duration: number } {
  const timestamp = Math.round((i * 1_000_000) / fps);
  return { timestamp, duration: Math.round(((i + 1) * 1_000_000) / fps) - timestamp };
}

/** Bits per second: about 10 Mbit/s at 1920 x 1080, scaled by pixel count. */
export function bitrateFor(stage: Stage, fps = FPS): number {
  return Math.round(stage.width * stage.height * fps * 0.08);
}

/** The MP4 name, such as `replay-events-swarmup-16x9-30s.mp4`. */
export function videoFileName(
  scene: string,
  project: string,
  aspect: Aspect['id'],
  durationMs: number,
): string {
  const s = Math.round(Math.max(0, durationMs) / 1000);
  const base = `replay-${scene}-${project || 'all-projects'}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${base}-${aspect}-${s}s.mp4`;
}

/** Thrown when the person cancels a recording. */
export class RecordCancelled extends Error {
  constructor() {
    super('Recording cancelled');
    this.name = 'RecordCancelled';
  }
}

/** The parts of `VideoEncoder` the loop uses. */
export interface EncoderLike {
  readonly encodeQueueSize: number;
  configure(config: VideoEncoderConfig): void;
  encode(frame: FrameLike, options?: VideoEncoderEncodeOptions): void;
  flush(): Promise<void>;
  close(): void;
}

/** The parts of `VideoFrame` the loop uses. */
export interface FrameLike {
  close(): void;
}

/** What the loop needs from WebCodecs; `browserCodecs()` gives the real ones. */
export interface Codecs {
  isConfigSupported(config: VideoEncoderConfig): Promise<{ supported?: boolean }>;
  encoder(init: VideoEncoderInit): EncoderLike;
  frame(source: CanvasImageSource, init: { timestamp: number; duration: number }): FrameLike;
}

/** Chromium's WebCodecs, or null when the page has none (not a secure context, old engine). */
export function browserCodecs(): Codecs | null {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  return {
    isConfigSupported: (config) => VideoEncoder.isConfigSupported(config),
    encoder: (init) => new VideoEncoder(init) as unknown as EncoderLike,
    frame: (source, init) => new VideoFrame(source as CanvasImageSource & VideoFrame, init),
  };
}

/** The first H.264 config this machine's encoder accepts for `stage`; throws when none fits. */
export async function pickConfig(
  codecs: Codecs,
  stage: Stage,
  fps = FPS,
): Promise<VideoEncoderConfig> {
  for (const codec of AVC_CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width: stage.width,
      height: stage.height,
      bitrate: bitrateFor(stage, fps),
      framerate: fps,
      latencyMode: 'quality',
      avc: { format: 'avc' },
    };
    const res = await codecs.isConfigSupported(config).catch(() => ({ supported: false }));
    if (res.supported) return config;
  }
  throw new Error(`no H.264 encoder for ${stage.width} x ${stage.height} on this machine`);
}

export interface EncodeOptions {
  stage: Stage;
  frames: number;
  fps?: number;
  /** Draws frame `i` and returns what to encode, sized to the stage. */
  draw(i: number): Promise<CanvasImageSource> | CanvasImageSource;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
  codecs: Codecs;
}

/**
 * Resolves when the encoder takes the next frame off its queue. A real `VideoEncoder` fires
 * `dequeue`, which a minimized window does not throttle the way it throttles timers; the timer is
 * the fallback for encoders without it.
 */
function dequeued(encoder: EncoderLike): Promise<void> {
  return new Promise((resolve) => {
    const target = encoder as Partial<EventTarget>;
    const timer = setTimeout(done, target.addEventListener ? 100 : 0);
    function done(): void {
      clearTimeout(timer);
      target.removeEventListener?.('dequeue', done);
      resolve();
    }
    target.addEventListener?.('dequeue', done);
  });
}

/** Encodes `frames` frames into an MP4 (H.264, fast start) and returns its bytes. */
export async function encodeClip(opts: EncodeOptions): Promise<Uint8Array> {
  const fps = opts.fps ?? FPS;
  const { stage, codecs, signal } = opts;
  if (signal?.aborted) throw new RecordCancelled();
  const config = await pickConfig(codecs, stage, fps);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: stage.width, height: stage.height, frameRate: fps },
    fastStart: 'in-memory',
  });
  let failed: Error | null = null;
  const encoder = codecs.encoder({
    output: (chunk, meta) => {
      try {
        // What `addVideoChunk` does, without its `instanceof EncodedVideoChunk` check.
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const duration = chunk.duration ?? Math.round(1_000_000 / fps);
        muxer.addVideoChunkRaw(data, chunk.type, chunk.timestamp, duration, meta);
      } catch (err) {
        failed ??= err as Error;
      }
    },
    error: (err) => {
      failed ??= err;
    },
  });
  try {
    encoder.configure(config);
    for (let i = 0; i < opts.frames; i++) {
      if (signal?.aborted) throw new RecordCancelled();
      if (failed) throw failed;
      const source = await opts.draw(i);
      const frame = codecs.frame(source, frameStamp(i, fps));
      try {
        encoder.encode(frame, { keyFrame: i % KEYFRAME_EVERY === 0 });
      } finally {
        frame.close();
      }
      while (encoder.encodeQueueSize > MAX_QUEUE && !failed) await dequeued(encoder);
      opts.onProgress?.(i + 1, opts.frames);
    }
    await encoder.flush();
    if (failed) throw failed;
    muxer.finalize();
    return new Uint8Array(target.buffer);
  } finally {
    try {
      encoder.close();
    } catch {
      // Already closed after an encoder error.
    }
  }
}

export interface RecordOptions {
  scene: Scene<unknown>;
  timeline: Timeline;
  aspect: Aspect;
  /** The id picked from the scene's `pick.choices`, such as a task id. */
  choice?: string;
  /** Clip length in playback ms. */
  durationMs: number;
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
  /** Defaults to `browserCodecs()`. */
  codecs?: Codecs;
  /** Defaults to `createRasterizer`. */
  rasterizer?(width: number, height: number): Rasterizer;
}

/**
 * Records `scene` over the whole clip in `aspect`: the scene is prepared for that stage, and frame
 * i is drawn at `frameTime(i)`, so the video matches the player frame for frame.
 */
export async function recordScene(opts: RecordOptions): Promise<Uint8Array> {
  const codecs = opts.codecs ?? browserCodecs();
  if (!codecs) throw new Error('this app has no video encoder (WebCodecs is missing)');
  const { stage } = opts.aspect;
  const data = opts.scene.prepare(opts.timeline, stage, opts.choice);
  const frames = frameCount(opts.durationMs);
  const raster = (opts.rasterizer ?? createRasterizer)(stage.width, stage.height);
  try {
    return await encodeClip({
      stage,
      frames,
      codecs,
      signal: opts.signal,
      onProgress: opts.onProgress,
      draw: (i) =>
        raster.draw(
          renderFrame(opts.scene, data, {
            ...stage,
            t: frameTime(i, frames, opts.durationMs),
            duration: opts.durationMs,
          }),
        ),
    });
  } finally {
    raster.close();
  }
}
