// Encodes a real Replay GIF in headless Chrome, checks its structure and file size, then displays
// it in an <img> and proves that two moments draw different pixels.
//
//   node scripts/gif-check.mjs [--seconds 2]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(top, 'packages', 'desktop');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const seconds = Number(arg('--seconds', '2'));
if (!(seconds > 0 && seconds <= 10)) throw new Error('--seconds must be 1 to 10');
const dir = mkdtempSync(join(tmpdir(), 'swarmup-gif-check-'));

const entry = `
  import { recordGifScene } from './ui/src/lib/gif';
  import { aspectById } from './ui/src/lib/record';
  import { sceneById } from './ui/src/replay/scenes';
  import { fixture } from './test/replay-fixture';

  const gifInfo = (bytes) => {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    let at = 13;
    if (bytes[10] & 0x80) at += 3 * 2 ** ((bytes[10] & 7) + 1);
    let frames = 0;
    let delayMs = 0;
    const blocks = () => {
      while (true) {
        const n = bytes[at++];
        if (!n) return;
        at += n;
      }
    };
    while (at < bytes.length) {
      const kind = bytes[at++];
      if (kind === 0x3b) break;
      if (kind === 0x21) {
        const label = bytes[at++];
        if (label === 0xf9) {
          at += 2;
          delayMs += (bytes[at] | (bytes[at + 1] << 8)) * 10;
          at += 4;
        } else blocks();
      } else if (kind === 0x2c) {
        frames++;
        at += 8;
        const packed = bytes[at++];
        if (packed & 0x80) at += 3 * 2 ** ((packed & 7) + 1);
        at++;
        blocks();
      } else throw new Error('unknown GIF block 0x' + kind.toString(16));
    }
    return { width, height, frames, delayMs };
  };

  (async () => {
    const timeline = fixture();
    const durationMs = ${seconds} * 1000;
    timeline.time.playbackMs = durationMs;
    const started = performance.now();
    const bytes = await recordGifScene({
      scene: sceneById('events'),
      timeline,
      aspect: aspectById('16x9'),
      durationMs,
      projectName: 'sample / browser',
      showProject: true,
    });
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const img = document.querySelector('img');
    img.src = 'data:image/gif;base64,' + btoa(binary);
    await new Promise((ok, bad) => {
      img.onload = ok;
      img.onerror = () => bad(new Error('Chrome could not open GIF'));
    });
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
    await decoder.tracks.ready;
    const decodedFrames = decoder.tracks.selectedTrack.frameCount;
    const first = await decoder.decode({ frameIndex: 0 });
    const last = await decoder.decode({ frameIndex: decodedFrames - 1 });
    ctx.drawImage(first.image, 0, 0, 480, 270);
    const a = ctx.getImageData(0, 0, 480, 270).data;
    ctx.drawImage(last.image, 0, 0, 480, 270);
    const b = ctx.getImageData(0, 0, 480, 270).data;
    first.image.close();
    last.image.close();
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
    }
    const result = {
      bytes: bytes.length,
      encodeMs: Math.round(performance.now() - started),
      info: gifInfo(bytes),
      browser: {
        width: img.naturalWidth,
        height: img.naturalHeight,
        decodedFrames,
        changed: changed / (a.length / 4),
      },
    };
    document.querySelector('pre').textContent = 'GIF_RESULT ' + JSON.stringify(result);
  })().catch((error) => {
    document.querySelector('pre').textContent = 'GIF_ERROR ' + error.message;
  });
`;

await build({
  stdin: { contents: entry, resolveDir: desktop, loader: 'ts' },
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: join(dir, 'gif.js'),
  logLevel: 'error',
});
const csp = readFileSync(join(desktop, 'ui', 'index.html'), 'utf8').match(
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
)?.[1];
if (!csp) throw new Error('no CSP in ui/index.html');
writeFileSync(
  join(dir, 'gif.html'),
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><img><pre>waiting</pre><script src="gif.js"></script>`,
);

const chrome = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!chrome) throw new Error('Chrome or Edge is required for the GIF browser check');
const run = spawnSync(
  chrome,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--user-data-dir=${join(dir, 'profile')}`,
    '--dump-dom',
    '--virtual-time-budget=120000',
    pathToFileURL(join(dir, 'gif.html')).href,
  ],
  { encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000 },
);
const match = run.stdout?.match(/GIF_RESULT ([^<]+)/);
if (!match) {
  console.error(run.stdout, run.stderr);
  throw new Error(`browser GIF check failed (exit ${run.status})`);
}
const result = JSON.parse(match[1]);
const { info, browser } = result;
const problems = [];
if (info.width !== 960 || info.height !== 540) problems.push(`size ${info.width}x${info.height}`);
if (info.frames < 2) problems.push(`only ${info.frames} encoded frame(s)`);
if (Math.abs(info.delayMs - seconds * 1000) > 30) problems.push(`duration ${info.delayMs} ms`);
if (result.bytes > 10 * 1024 * 1024)
  problems.push(`file is ${(result.bytes / 1024 / 1024).toFixed(1)} MB`);
if (browser.width !== 960 || browser.height !== 540) {
  problems.push(`browser shows ${browser.width}x${browser.height}`);
}
if (browser.decodedFrames !== info.frames) {
  problems.push(`browser decoded ${browser.decodedFrames} of ${info.frames} frames`);
}
if (browser.changed < 0.0001) problems.push(`browser animation changed only ${browser.changed}`);
console.log(
  `GIF: ${info.width}x${info.height}, ${info.frames} encoded frames, ${(info.delayMs / 1000).toFixed(2)} s, ` +
    `${(result.bytes / 1024).toFixed(1)} KB, encoded in ${(result.encodeMs / 1000).toFixed(1)} s; ` +
    `browser opened it and ${(browser.changed * 100).toFixed(2)}% of pixels changed.`,
);
rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
if (problems.length) {
  console.error(`GIF check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('GIF check passed: sample clip is web-sized and animates in Chrome.');
