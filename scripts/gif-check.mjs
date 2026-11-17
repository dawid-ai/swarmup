// Encodes a real Replay GIF and the MP4 of the same clip in Electron (the app's runtime), checks
// the GIF's structure and size against the MP4, then decodes it in Chromium and proves that two
// moments draw different pixels.
//
//   node scripts/gif-check.mjs [--seconds 10] [--keep]
//
// `--keep` leaves the GIF, the MP4 and a PNG of the GIF's middle frame in the printed folder.
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(top, 'packages', 'desktop');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const seconds = Number(arg('--seconds', '10'));
const keep = argv.includes('--keep');
if (!(seconds > 0 && seconds <= 60)) throw new Error('--seconds must be 1 to 60');
const dir = mkdtempSync(join(tmpdir(), 'swarmup-gif-check-'));

const entry = `
  import { GIF_FPS, GIF_WIDTH, recordGifScene } from './ui/src/lib/gif';
  import { aspectById, recordScene } from './ui/src/lib/record';
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

  const clip = (seconds) => {
    const timeline = fixture();
    const durationMs = seconds * 1000;
    timeline.time.playbackMs = durationMs;
    return {
      scene: sceneById('events'),
      timeline,
      aspect: aspectById('16x9'),
      durationMs,
      projectName: 'sample / browser',
      showProject: true,
    };
  };

  window.gifCheck = async (seconds) => {
    const started = performance.now();
    const bytes = await recordGifScene(clip(seconds));
    const encodeMs = Math.round(performance.now() - started);
    const mp4 = await recordScene(clip(seconds));
    return { bytes, mp4, encodeMs, info: gifInfo(bytes), fps: GIF_FPS, width: GIF_WIDTH };
  };
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
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="gif.js"></script>`,
);
writeFileSync(join(dir, 'view.html'), '<!doctype html><img>');

writeFileSync(
  join(dir, 'main.cjs'),
  `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const [dir, seconds] = JSON.parse(process.env.GIF_CHECK);
// Opens the GIF from disk in an <img>, then decodes its first, middle and last frames.
const view = (url) => \`(async () => {
  const img = document.querySelector('img');
  img.src = \${JSON.stringify(url)};
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('Chromium could not open the GIF')); });
  const bytes = new Uint8Array(await (await fetch(img.src)).arrayBuffer());
  const decoder = new ImageDecoder({ data: bytes, type: 'image/gif' });
  await decoder.tracks.ready;
  const n = decoder.tracks.selectedTrack.frameCount;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const grab = async (frameIndex) => {
    const f = await decoder.decode({ frameIndex });
    ctx.drawImage(f.image, 0, 0);
    f.image.close();
    return ctx.getImageData(0, 0, c.width, c.height).data;
  };
  const a = await grab(0);
  const b = await grab(n - 1);
  await grab(Math.floor(n / 2));
  const png = c.toDataURL('image/png');
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) changed++;
  }
  return { width: img.naturalWidth, height: img.naturalHeight, decodedFrames: n, changed: changed / (a.length / 4), png };
})()\`;
app.whenReady().then(async () => {
  const web = { backgroundThrottling: false };
  const rec = new BrowserWindow({ show: false, webPreferences: web });
  await rec.loadFile(join(dir, 'gif.html'));
  const r = await rec.webContents.executeJavaScript(\`window.gifCheck(\${seconds})\`);
  const gif = join(dir, \`replay-events-16x9-\${seconds}s.gif\`);
  writeFileSync(gif, Buffer.from(r.bytes));
  writeFileSync(gif.replace(/\\.gif$/, '.mp4'), Buffer.from(r.mp4));
  const viewer = new BrowserWindow({ show: false, webPreferences: web });
  await viewer.loadFile(join(dir, 'view.html'));
  const browser = await viewer.webContents.executeJavaScript(view(pathToFileURL(gif).href));
  console.log('RESULT ' + JSON.stringify({ gif, bytes: r.bytes.length, mp4: r.mp4.length, encodeMs: r.encodeMs, info: r.info, fps: r.fps, width: r.width, browser }));
  app.exit(0);
}).catch((e) => { console.error('GIF_CHECK_FAILED ' + (e && e.message)); app.exit(1); });
`,
);

const electron = createRequire(join(desktop, 'package.json'))('electron');
const run = spawnSync(electron, [join(dir, 'main.cjs')], {
  env: { ...process.env, GIF_CHECK: JSON.stringify([dir, seconds]) },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15 * 60_000,
});
const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
if (!line) {
  console.error(run.stdout, run.stderr);
  throw new Error(`Electron exited with ${run.status} and no result`);
}
const result = JSON.parse(line.slice('RESULT '.length));
const { info, browser } = result;
const wantHeight = Math.round((result.width * 9) / 16);
const problems = [];
if (info.width !== result.width || info.height !== wantHeight) {
  problems.push(`size ${info.width}x${info.height}`);
}
if (info.frames < 2) problems.push(`only ${info.frames} encoded frame(s)`);
if (Math.abs(info.delayMs - seconds * 1000) > 30) problems.push(`duration ${info.delayMs} ms`);
// A web GIF of this sample stays well under its 1080p/60 fps MP4.
if (result.bytes > result.mp4 * 0.5) {
  problems.push(`GIF is ${((100 * result.bytes) / result.mp4).toFixed(0)}% of the MP4`);
}
if (browser.width !== info.width || browser.height !== info.height) {
  problems.push(`browser shows ${browser.width}x${browser.height}`);
}
if (browser.decodedFrames !== info.frames) {
  problems.push(`browser decoded ${browser.decodedFrames} of ${info.frames} frames`);
}
if (browser.changed < 0.0001) problems.push(`browser animation changed only ${browser.changed}`);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(
  `GIF: ${info.width}x${info.height} at ${result.fps} fps, ${info.frames} encoded frames, ` +
    `${(info.delayMs / 1000).toFixed(2)} s, ${kb(result.bytes)}, encoded in ${(result.encodeMs / 1000).toFixed(1)} s; ` +
    `MP4 of the same clip: ${kb(result.mp4)}; GIF/MP4 ${((100 * result.bytes) / result.mp4).toFixed(1)}%; ` +
    `browser decoded ${browser.decodedFrames} frames and ${(browser.changed * 100).toFixed(2)}% of pixels changed.`,
);
if (keep) {
  writeFileSync(
    result.gif.replace(/\.gif$/, '-middle.png'),
    Buffer.from(browser.png.split(',')[1], 'base64'),
  );
  console.log(`Files kept in ${dir}`);
} else rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
if (problems.length) {
  console.error(`GIF check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('GIF check passed: sample clip is web-sized and animates in Chromium.');
