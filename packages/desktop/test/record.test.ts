// @vitest-environment happy-dom
// Record (AO-0078): the fixed 60 fps frame clock, the encode loop through the real MP4 muxer with
// a stand-in for WebCodecs, the checks on the saved file, and the Record controls in the view.
// `scripts/record-check.mjs` records a real 30 s clip with Electron's encoder.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freeName } from '../src/images';
import { MAX_VIDEO_BYTES, videoFile, writeVideo } from '../src/videos';
import type { Rasterizer } from '../ui/src/lib/png';
import type { Codecs, EncoderLike, RecordOptions } from '../ui/src/lib/record';
import {
  ASPECTS,
  AVC_CODECS,
  FPS,
  RecordCancelled,
  aspectById,
  bitrateFor,
  encodeClip,
  frameCount,
  frameStamp,
  frameTime,
  recordScene,
  videoFileName,
} from '../ui/src/lib/record';
import type { Frame } from '../ui/src/replay/scene';
import { sceneDuration } from '../ui/src/replay/scene';
import { SCENES, sceneById } from '../ui/src/replay/scenes';
import { Replay, recordClip } from '../ui/src/views/Replay';
import { mp4Info } from './mp4';
import { fixture } from './replay-fixture';

interface FakeFrame {
  timestamp: number;
  duration: number;
  closed: boolean;
  close(): void;
}

/**
 * WebCodecs stand-in: outputs one small chunk per frame a task later, like the real encoder, with
 * the decoder config on the first chunk. `supported` limits the codecs it accepts.
 */
function fakeCodecs(opts: { supported?: string[]; failAt?: number } = {}) {
  const log = {
    configs: [] as VideoEncoderConfig[],
    encoded: [] as Array<{ timestamp: number; duration: number; key: boolean }>,
    frames: [] as FakeFrame[],
    closed: 0,
    maxQueue: 0,
  };
  const codecs: Codecs = {
    isConfigSupported: async (c) => ({
      supported: !opts.supported || opts.supported.includes(c.codec),
    }),
    encoder: (init) => {
      let queue = 0;
      let config: VideoEncoderConfig | undefined;
      const pending: Array<Promise<void>> = [];
      const enc: EncoderLike = {
        get encodeQueueSize() {
          return queue;
        },
        configure(c) {
          config = c;
          log.configs.push(c);
        },
        encode(frame, o) {
          const f = frame as unknown as FakeFrame;
          const n = log.encoded.length;
          const key = o?.keyFrame ?? false;
          log.encoded.push({ timestamp: f.timestamp, duration: f.duration, key });
          queue++;
          log.maxQueue = Math.max(log.maxQueue, queue);
          const { timestamp, duration } = f;
          pending.push(
            new Promise<void>((resolve) =>
              setTimeout(() => {
                queue--;
                if (n === opts.failAt) {
                  init.error(new DOMException('encoder broke', 'EncodingError'));
                  return resolve();
                }
                const data = new Uint8Array([0, 0, 0, 2, key ? 0x65 : 0x41, n & 0xff]);
                const chunk = {
                  type: key ? 'key' : 'delta',
                  timestamp,
                  duration,
                  byteLength: data.length,
                  copyTo: (dest: Uint8Array) => dest.set(data),
                } as unknown as EncodedVideoChunk;
                const meta: EncodedVideoChunkMetadata | undefined =
                  n === 0
                    ? {
                        decoderConfig: {
                          codec: config!.codec,
                          codedWidth: config!.width,
                          codedHeight: config!.height,
                          description: new Uint8Array([1, 0x64, 0, 0x2a, 0xff, 0xe0, 0]),
                        },
                      }
                    : undefined;
                init.output(chunk, meta);
                resolve();
              }, 0),
            ),
          );
        },
        flush: () => Promise.all(pending).then(() => undefined),
        close() {
          log.closed++;
        },
      };
      return enc;
    },
    frame: (_source, init) => {
      const f: FakeFrame = {
        ...init,
        closed: false,
        close() {
          f.closed = true;
        },
      };
      log.frames.push(f);
      return f;
    },
  };
  return { codecs, log };
}

const canvas = {} as CanvasImageSource;

describe('frame clock', () => {
  it('counts 60 frames per second of clip', () => {
    expect(FPS).toBe(60);
    expect(frameCount(30_000)).toBe(1800);
    expect(frameCount(20_000)).toBe(1200);
    expect(frameCount(1_000)).toBe(60);
    expect(frameCount(0)).toBe(1);
    expect(frameCount(-5)).toBe(1);
  });

  it('draws frame i at i / 60 s and the last frame at the end of the clip', () => {
    const n = frameCount(1000);
    expect(frameTime(0, n, 1000)).toBe(0);
    expect(frameTime(1, n, 1000)).toBeCloseTo(16.667, 3);
    expect(frameTime(30, n, 1000)).toBe(500);
    expect(frameTime(n - 1, n, 1000)).toBe(1000);
  });

  it('stamps frames in microseconds that add up to the clip with no gaps', () => {
    expect(frameStamp(0)).toEqual({ timestamp: 0, duration: 16667 });
    let end = 0;
    for (let i = 0; i < 60; i++) {
      const s = frameStamp(i);
      expect(s.timestamp).toBe(end);
      end = s.timestamp + s.duration;
    }
    expect(end).toBe(1_000_000);
  });

  it('offers 16:9, 1:1 and 9:16 at 1080p, and names files after scene, project and format', () => {
    expect(ASPECTS.map((a) => [a.label, a.stage.width, a.stage.height])).toEqual([
      ['16:9', 1920, 1080],
      ['1:1', 1080, 1080],
      ['9:16', 1080, 1920],
    ]);
    expect(aspectById('nope').id).toBe('16x9');
    expect(bitrateFor(aspectById('16x9').stage)).toBe(9_953_280);
    expect(videoFileName('events', 'swarmup', '9x16', 30_000)).toBe(
      'replay-events-swarmup-9x16-30s.mp4',
    );
    expect(videoFileName('counters', '', '1x1', 14_600)).toBe(
      'replay-counters-all-projects-1x1-15s.mp4',
    );
    expect(videoFileName('events', 'Ünïcode Proj!!', '16x9', 20_000)).toMatch(
      /^[a-z0-9][a-z0-9-]*\.mp4$/,
    );
  });
});

describe('encodeClip', () => {
  it('records a 1 s 1080p clip: 60 frames, 1920 x 1080, 1 s, H.264 with fast start', async () => {
    const { codecs, log } = fakeCodecs();
    const progress: number[] = [];
    const drawn: number[] = [];
    const bytes = await encodeClip({
      stage: { width: 1920, height: 1080 },
      frames: 60,
      codecs,
      draw: (i) => {
        drawn.push(i);
        return canvas;
      },
      onProgress: (done, total) => {
        expect(total).toBe(60);
        progress.push(done);
      },
    });
    const info = mp4Info(bytes);
    expect(info).toMatchObject({
      codec: 'avc1',
      width: 1920,
      height: 1080,
      frames: 60,
      keyframes: 1,
      fps: 60,
      fastStart: true,
    });
    expect(info.durationMs).toBeCloseTo(1000, 0);
    expect(drawn).toEqual([...Array(60).keys()]);
    expect(progress.at(-1)).toBe(60);
    expect(progress).toHaveLength(60);
    expect(log.configs[0]).toMatchObject({
      codec: AVC_CODECS[0],
      width: 1920,
      height: 1080,
      framerate: 60,
      avc: { format: 'avc' },
    });
    expect(log.frames.every((f) => f.closed)).toBe(true);
    expect(log.closed).toBe(1);
  });

  it('puts a keyframe every 2 s and keeps the encoder queue short', async () => {
    const { codecs, log } = fakeCodecs();
    const bytes = await encodeClip({
      stage: { width: 1080, height: 1920 },
      frames: 300,
      codecs,
      draw: () => canvas,
    });
    const info = mp4Info(bytes);
    expect(info).toMatchObject({ width: 1080, height: 1920, frames: 300, keyframes: 3 });
    expect(info.durationMs).toBeCloseTo(5000, 0);
    expect(log.encoded.filter((e) => e.key).map((e) => e.timestamp)).toEqual([
      0, 2_000_000, 4_000_000,
    ]);
    expect(log.maxQueue).toBeLessThanOrEqual(9);
  });

  it('falls back to the next H.264 profile, and fails clearly when none fits', async () => {
    const baseline = fakeCodecs({ supported: ['avc1.42E02A'] });
    await encodeClip({
      stage: { width: 1080, height: 1080 },
      frames: 2,
      codecs: baseline.codecs,
      draw: () => canvas,
    });
    expect(baseline.log.configs[0]!.codec).toBe('avc1.42E02A');

    const none = fakeCodecs({ supported: [] });
    await expect(
      encodeClip({
        stage: { width: 1080, height: 1080 },
        frames: 2,
        codecs: none.codecs,
        draw: () => canvas,
      }),
    ).rejects.toThrow('no H.264 encoder for 1080 x 1080');
  });

  it('stops on cancel and closes the encoder', async () => {
    const { codecs, log } = fakeCodecs();
    const ctrl = new AbortController();
    await expect(
      encodeClip({
        stage: { width: 1920, height: 1080 },
        frames: 600,
        codecs,
        signal: ctrl.signal,
        draw: () => canvas,
        onProgress: (done) => {
          if (done === 10) ctrl.abort();
        },
      }),
    ).rejects.toBeInstanceOf(RecordCancelled);
    expect(log.encoded).toHaveLength(10);
    expect(log.closed).toBe(1);
  });

  it('fails when the encoder reports an error', async () => {
    const { codecs, log } = fakeCodecs({ failAt: 3 });
    await expect(
      encodeClip({ stage: { width: 1920, height: 1080 }, frames: 120, codecs, draw: () => canvas }),
    ).rejects.toThrow('encoder broke');
    expect(log.closed).toBe(1);
  });
});

describe('recordScene', () => {
  /** A rasterizer that keeps the frames it was asked to draw. */
  function keep(): {
    frames: Frame[];
    sizes: string[];
    closed: number;
    make: RecordOptions['rasterizer'];
  } {
    const out = {
      frames: [] as Frame[],
      sizes: [] as string[],
      closed: 0,
      make: undefined as RecordOptions['rasterizer'],
    };
    out.make = (width: number, height: number): Rasterizer => {
      out.sizes.push(`${width}x${height}`);
      return {
        draw: async (el: ReactElement) => {
          const props = el.props as { viewBox: string; children: ReactElement[] };
          // The scene's render output is the second child of the frame's <svg>.
          const [, view] = props.children as [unknown, ReactElement];
          expect(props.viewBox).toBe(`0 0 ${width} ${height}`);
          expect(view).toBeTruthy();
          out.frames.push({ width, height, t: out.frames.length, duration: 0 });
          return canvas as HTMLCanvasElement;
        },
        close: () => {
          out.closed++;
        },
      };
    };
    return out;
  }

  it('records the whole clip in each format, one frame per 1/60 s of playback', async () => {
    const timeline = fixture();
    for (const aspect of ASPECTS) {
      const { codecs } = fakeCodecs();
      const r = keep();
      const scene = sceneById('events');
      const prepare = vi.spyOn(scene, 'prepare');
      const bytes = await recordScene({
        scene,
        timeline,
        aspect,
        durationMs: 2000,
        codecs,
        rasterizer: r.make,
      });
      expect(prepare).toHaveBeenCalledWith(timeline, aspect.stage, undefined);
      prepare.mockRestore();
      const info = mp4Info(bytes);
      expect([info.width, info.height]).toEqual([aspect.stage.width, aspect.stage.height]);
      expect(info.frames).toBe(120);
      expect(info.durationMs).toBeCloseTo(2000, 0);
      expect(r.sizes).toEqual([`${aspect.stage.width}x${aspect.stage.height}`]);
      expect(r.frames).toHaveLength(120);
      expect(r.closed).toBe(1);
    }
  });

  it('prepares a scene about one thing with the picked choice', async () => {
    const timeline = fixture();
    const aspect = aspectById('9x16');
    const { codecs } = fakeCodecs();
    const scene = sceneById('rally');
    const prepare = vi.spyOn(scene, 'prepare');
    await recordScene({
      scene,
      timeline,
      aspect,
      choice: 'AO-1',
      durationMs: 100,
      codecs,
      rasterizer: keep().make,
    });
    expect(prepare).toHaveBeenCalledWith(timeline, aspect.stage, 'AO-1');
    prepare.mockRestore();
  });

  it('asks the scene for frame times 0, 1/60 s, ... and the final frame', async () => {
    const times: number[] = [];
    const base = sceneById('counters');
    const scene = {
      ...base,
      render: (data: unknown, frame: Frame) => {
        times.push(frame.t);
        return base.render(data, frame);
      },
    };
    const { codecs } = fakeCodecs();
    const r = keep();
    // `renderFrame` calls `render` while building the element, before the rasterizer runs.
    await recordScene({
      scene,
      timeline: fixture(),
      aspect: aspectById('16x9'),
      durationMs: 500,
      codecs,
      rasterizer: r.make,
    });
    expect(times).toHaveLength(30);
    expect(times[0]).toBe(0);
    expect(times[6]).toBe(100);
    expect(times.at(-1)).toBe(500);
    expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true);
  });

  it('says so when the app has no WebCodecs', async () => {
    await expect(
      recordScene({
        scene: sceneById('events'),
        timeline: fixture(),
        aspect: aspectById('16x9'),
        durationMs: 1000,
      }),
    ).rejects.toThrow('WebCodecs is missing');
  });
});

describe('saving a recording', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'swarmup-record-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const mp4 = (): Uint8Array =>
    new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);

  it('accepts a plain .mp4 name with MP4 bytes only', () => {
    expect(videoFile('replay-events-x-16x9-30s.mp4', mp4()).name).toBe(
      'replay-events-x-16x9-30s.mp4',
    );
    expect(() => videoFile('../evil.mp4', mp4())).toThrow('bad video name');
    expect(() => videoFile('a/b.mp4', mp4())).toThrow('bad video name');
    expect(() => videoFile('clip.exe', mp4())).toThrow('bad video name');
    expect(() => videoFile('Clip.mp4', mp4())).toThrow('bad video name');
    expect(() => videoFile('clip.mp4', 'text')).toThrow('missing');
    expect(() => videoFile('clip.mp4', new Uint8Array(32))).toThrow('not an MP4');
    expect(MAX_VIDEO_BYTES).toBe(1024 ** 3);
  });

  it('never overwrites a file in the folder', () => {
    writeFileSync(join(dir, 'clip.mp4'), 'old');
    expect(writeVideo(dir, { name: 'clip.mp4', data: mp4() })).toBe('clip-2.mp4');
    expect(writeVideo(dir, { name: 'clip.mp4', data: mp4() })).toBe('clip-3.mp4');
    expect(readFileSync(join(dir, 'clip.mp4'), 'utf8')).toBe('old');
    expect(existsSync(join(dir, 'clip-3.mp4'))).toBe(true);
    expect(freeName('a.png', (n) => n === 'a.png')).toBe('a-2.png');
  });
});

// The Record controls, with swarmupd mocked and the recorder replaced: the test DOM has no encoder.
// One timeline object for every render, as `useData` gives; a new one would restart the clip.
const served = vi.hoisted(() => ({ timeline: null as unknown }));
vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>(path: string | null) => {
    served.timeline ??= fixture();
    const data = path?.startsWith('/api/timeline')
      ? served.timeline
      : path === '/api/tasks?all'
        ? [{ id: 'AO-1', project: 'swarmup' }]
        : undefined;
    return { data: data as T, error: null, reload: () => {}, set: () => {} };
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('Record controls', () => {
  let root: Root | undefined;
  let box: HTMLDivElement;
  const saved: Array<{ name: string; data: Uint8Array }> = [];
  let folder: { ok: boolean; data?: { dir: string }; error?: string };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    saved.length = 0;
    folder = { ok: true, data: { dir: 'C:\\clips' } };
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    window.swarmup = {
      videoFolder: async () => folder,
      saveVideo: async (name: string, data: Uint8Array) => {
        saved.push({ name, data });
        return { ok: true, data: { dir: 'C:\\clips', file: name } };
      },
    } as unknown as NonNullable<Window['swarmup']>;
    box = document.createElement('div');
    document.body.append(box);
    root = createRoot(box);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
    box.remove();
    delete window.swarmup;
    vi.unstubAllGlobals();
  });

  function button(text: string): HTMLButtonElement {
    const b = [...box.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`no ${text} button`);
    return b;
  }
  const status = (): string => box.querySelector('[data-testid="replay-saved"]')?.textContent ?? '';

  /** A recorder the test finishes by hand, after reporting progress. */
  function manual() {
    const calls: RecordOptions[] = [];
    let finish: (bytes: Uint8Array) => void = () => {};
    const record = (opts: RecordOptions): Promise<Uint8Array> => {
      calls.push(opts);
      return new Promise<Uint8Array>((resolve, reject) => {
        finish = resolve;
        opts.signal?.addEventListener('abort', () => reject(new RecordCancelled()));
      });
    };
    return { calls, record, finish: (b: Uint8Array) => finish(b) };
  }

  it('records the clip in the chosen format, shows progress, and saves the MP4', async () => {
    const rec = manual();
    act(() => root!.render(createElement(Replay, { record: rec.record })));
    act(() => button('9:16').click());
    expect(button('9:16').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('Record MP4').click());
    expect(rec.calls).toHaveLength(1);
    // The view opens on the first scene in the picker; the clip includes its outro card, if any.
    const first = SCENES[0]!.id;
    const durationMs = sceneDuration(SCENES[0]!, fixture());
    expect(rec.calls[0]).toMatchObject({ aspect: { id: '9x16' }, durationMs, project: '' });
    expect(rec.calls[0]!.scene.id).toBe(first);
    act(() => rec.calls[0]!.onProgress!(900, 1800));
    const bar = box.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    expect(box.textContent).toContain('Recording 50%');
    expect(button('9:16').disabled).toBe(true);
    expect(button('Save frame').disabled).toBe(true);
    const bytes = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
    await act(async () => rec.finish(bytes));
    const name = `replay-${first}-all-projects-9x16-${durationMs / 1000}s.mp4`;
    expect(saved).toEqual([{ name, data: bytes }]);
    expect(status()).toBe(`Saved ${name} to C:\\clips`);
    expect(box.querySelector('[role="progressbar"]')).toBeNull();
    expect(button('Record MP4').disabled).toBe(false);
  });

  it('cancels a recording without saving', async () => {
    const rec = manual();
    act(() => root!.render(createElement(Replay, { record: rec.record })));
    await act(async () => button('Record MP4').click());
    await act(async () => button('Cancel').click());
    expect(saved).toEqual([]);
    expect(status()).toBe('Recording cancelled');
    expect(button('Record MP4')).toBeTruthy();
  });

  it('does not record when the folder dialog is cancelled', async () => {
    folder = { ok: false, error: 'cancelled' };
    const rec = manual();
    act(() => root!.render(createElement(Replay, { record: rec.record })));
    await act(async () => button('Record MP4').click());
    expect(rec.calls).toEqual([]);
    expect(status()).toBe('');
    expect(button('Record MP4')).toBeTruthy();
  });

  it('shows why a recording failed', async () => {
    const record = async (): Promise<Uint8Array> => {
      throw new Error('no H.264 encoder for 1920 x 1080 on this machine');
    };
    act(() => root!.render(createElement(Replay, { record })));
    await act(async () => button('Record MP4').click());
    expect(status()).toBe('Recording failed: no H.264 encoder for 1920 x 1080 on this machine');
  });

  it('recordClip asks for the folder before it records', async () => {
    const order: string[] = [];
    window.swarmup = {
      videoFolder: async () => {
        order.push('folder');
        return { ok: true, data: { dir: 'D:\\v' } };
      },
      saveVideo: async (name: string) => {
        order.push('save');
        return { ok: true, data: { dir: 'D:\\v', file: name } };
      },
    } as unknown as NonNullable<Window['swarmup']>;
    const text = await recordClip(
      {
        scene: sceneById('counters'),
        timeline: fixture(),
        project: 'swarmup',
        aspect: aspectById('1x1'),
        durationMs: 20_000,
      },
      async () => {
        order.push('record');
        return new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]);
      },
    );
    expect(order).toEqual(['folder', 'record', 'save']);
    expect(text).toBe('Saved replay-counters-swarmup-1x1-20s.mp4 to D:\\v');
  });
});
