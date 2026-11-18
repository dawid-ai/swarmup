// Records real replay clips with Electron's own H.264 encoder and checks them: frame count, size
// and duration from the MP4 boxes, then playback to the end in Chromium's <video> player, and
// ffprobe's view when ffprobe is on PATH. The unit tests use a stand-in encoder; this is the check
// that the app's encoder and muxer produce a file a standard player plays.
//
//   node scripts/record-check.mjs [--seconds 30] [--aspects 16x9,1x1,9x16] [--software] [--keep]
//
// `--software` turns the GPU off, as on a machine without hardware encoding. `--keep` leaves the
// clips in the printed folder; otherwise they are deleted at the end.
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
const seconds = Number(arg('--seconds', '30'));
const aspects = arg('--aspects', '16x9,1x1,9x16').split(',');
const software = argv.includes('--software');
const keep = argv.includes('--keep');
if (!(seconds > 0 && seconds <= 60)) throw new Error('--seconds must be 1 to 60');

const dir = mkdtempSync(join(tmpdir(), 'swarmup-record-check-'));

// The page: the app's recorder, scenes and fixture timeline, under the app's own CSP.
const entry = `
  import { aspectById, frameCount, recordScene } from './ui/src/lib/record';
  import { sceneById } from './ui/src/replay/scenes';
  import { fixture } from './test/replay-fixture';
  import { mp4Info } from './test/mp4';
  window.recordCheck = async (aspectId, seconds, sceneId) => {
    const timeline = fixture();
    const durationMs = seconds * 1000;
    timeline.time.playbackMs = durationMs;
    const started = performance.now();
    const bytes = await recordScene({
      scene: sceneById(sceneId),
      timeline,
      aspect: aspectById(aspectId),
      durationMs,
    });
    return {
      bytes,
      info: mp4Info(bytes),
      expectedFrames: frameCount(durationMs),
      encodeMs: Math.round(performance.now() - started),
    };
  };
`;
await build({
  stdin: { contents: entry, resolveDir: desktop, loader: 'ts' },
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: join(dir, 'record.js'),
  logLevel: 'error',
});
const csp = readFileSync(join(desktop, 'ui', 'index.html'), 'utf8').match(
  /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
)?.[1];
if (!csp) throw new Error('no CSP in ui/index.html');
writeFileSync(
  join(dir, 'record.html'),
  `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="record.js"></script>`,
);
writeFileSync(join(dir, 'play.html'), '<!doctype html><video muted></video>');

writeFileSync(
  join(dir, 'main.cjs'),
  `
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const [dir, seconds, aspects, software] = JSON.parse(process.env.RECORD_CHECK);
if (software) app.disableHardwareAcceleration();
const play = (url) => \`(async () => {
  const v = document.querySelector('video');
  let frames = 0;
  const count = () => { frames++; v.requestVideoFrameCallback(count); };
  v.requestVideoFrameCallback(count);
  v.src = \${JSON.stringify(url)};
  await new Promise((ok, bad) => { v.onloadedmetadata = ok; v.onerror = () => bad(new Error('the player could not open the file: ' + (v.error && v.error.message))); });
  const meta = { duration: v.duration, width: v.videoWidth, height: v.videoHeight };
  v.playbackRate = 4;
  await v.play();
  await new Promise((ok, bad) => { v.onended = ok; v.onerror = () => bad(new Error('playback failed: ' + (v.error && v.error.message))); });
  const q = v.getVideoPlaybackQuality();
  const ended = v.ended;
  // Frames at 10% and 50%, scaled down: the share of pixels that are not the backdrop, how many
  // pixels changed between them (the clip moves), and a PNG of the middle one.
  const c = document.createElement('canvas');
  c.width = 480;
  c.height = Math.round((480 * v.videoHeight) / v.videoWidth);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const grab = async (at) => {
    const shown = new Promise((ok) => v.requestVideoFrameCallback(ok));
    v.currentTime = at;
    await new Promise((ok) => { v.onseeked = ok; });
    await shown;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  };
  const early = await grab(v.duration * 0.1);
  const px = await grab(v.duration * 0.5);
  let drawn = 0;
  let changed = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (Math.abs(px[i] - 0x0b) + Math.abs(px[i + 1] - 0x0f) + Math.abs(px[i + 2] - 0x14) > 24) drawn++;
    if (Math.abs(px[i] - early[i]) + Math.abs(px[i + 1] - early[i + 1]) + Math.abs(px[i + 2] - early[i + 2]) > 24) changed++;
  }
  const n = px.length / 4;
  return { ...meta, ended, presented: frames, decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames, drawn: drawn / n, changed: changed / n, png: c.toDataURL('image/png') };
})()\`;
app.whenReady().then(async () => {
  const web = { backgroundThrottling: false };
  const rec = new BrowserWindow({ show: false, webPreferences: web });
  await rec.loadFile(join(dir, 'record.html'));
  const player = new BrowserWindow({ show: false, webPreferences: web });
  await player.loadFile(join(dir, 'play.html'));
  const out = [];
  for (const aspect of aspects) {
    const r = await rec.webContents.executeJavaScript(\`window.recordCheck('\${aspect}', \${seconds}, 'events')\`);
    const file = join(dir, \`replay-events-\${aspect}-\${seconds}s.mp4\`);
    writeFileSync(file, Buffer.from(r.bytes));
    const p = await player.webContents.executeJavaScript(play(pathToFileURL(file).href));
    out.push({ aspect, file, bytes: r.bytes.length, encodeMs: r.encodeMs, expectedFrames: r.expectedFrames, info: r.info, player: p });
  }
  console.log('RESULT ' + JSON.stringify(out));
  app.exit(0);
}).catch((e) => { console.error('RECORD_CHECK_FAILED ' + (e && e.message)); app.exit(1); });
`,
);

const electron = createRequire(join(desktop, 'package.json'))('electron');
const run = spawnSync(electron, [join(dir, 'main.cjs')], {
  env: { ...process.env, RECORD_CHECK: JSON.stringify([dir, seconds, aspects, software]) },
  encoding: 'utf8',
  windowsHide: true,
  timeout: 15 * 60_000,
});
const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
if (!line) {
  console.error(run.stdout, run.stderr);
  throw new Error(`Electron exited with ${run.status} and no result`);
}

const problems = [];
const results = JSON.parse(line.slice('RESULT '.length));
const ffprobe = spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
for (const r of results) {
  const want = { '16x9': [1920, 1080], '1x1': [1080, 1080], '9x16': [1080, 1920] }[r.aspect];
  const { info, player } = r;
  const say = (ok, what) => {
    if (!ok) problems.push(`${r.aspect}: ${what}`);
  };
  say(info.codec === 'avc1', `codec ${info.codec}, not avc1`);
  say(info.width === want[0] && info.height === want[1], `size ${info.width} x ${info.height}`);
  say(info.frames === r.expectedFrames, `${info.frames} frames, not ${r.expectedFrames}`);
  say(Math.abs(info.durationMs - seconds * 1000) < 20, `duration ${info.durationMs} ms`);
  say(info.fps === 60, `${info.fps} fps`);
  say(info.fastStart, 'moov after mdat');
  say(player.ended, 'the player did not reach the end');
  say(Math.abs(player.duration - seconds) < 0.05, `the player says ${player.duration} s`);
  say(
    player.width === want[0] && player.height === want[1],
    `the player shows ${player.width} x ${player.height}`,
  );
  say(player.decoded >= r.expectedFrames * 0.95, `the player decoded ${player.decoded} frames`);
  say(player.drawn > 0.005, `the middle frame is blank (${player.drawn})`);
  say(player.changed > 0.0005, `the frames at 10% and 50% are the same (${player.changed})`);
  if (keep) {
    writeFileSync(
      r.file.replace(/\.mp4$/, '-middle.png'),
      Buffer.from(player.png.split(',')[1], 'base64'),
    );
  }
  let probe = '';
  if (ffprobe) {
    const p = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-count_frames',
        '-show_entries',
        'stream=codec_name,profile,width,height,r_frame_rate,nb_read_frames,duration',
        '-of',
        'json',
        r.file,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    say(p.status === 0, `ffprobe failed: ${p.stderr}`);
    if (p.status === 0) {
      const s = JSON.parse(p.stdout).streams[0];
      say(Number(s.nb_read_frames) === r.expectedFrames, `ffprobe read ${s.nb_read_frames} frames`);
      probe = ` | ffprobe: ${s.codec_name} ${s.profile} ${s.width}x${s.height} ${s.r_frame_rate} ${s.nb_read_frames} frames ${s.duration} s`;
    }
  }
  console.log(
    `${r.aspect}: ${info.codec} ${info.width}x${info.height}, ${info.frames} frames (${info.keyframes} key), ` +
      `${(info.durationMs / 1000).toFixed(3)} s, ${info.fps} fps, ${(r.bytes / 1e6).toFixed(1)} MB, ` +
      `encoded in ${(r.encodeMs / 1000).toFixed(1)} s | player: ${player.width}x${player.height}, ` +
      `${player.duration.toFixed(3)} s, ended=${player.ended}, decoded ${player.decoded}, ` +
      `${(player.drawn * 100).toFixed(1)}% of the middle frame drawn, ` +
      `${(player.changed * 100).toFixed(2)}% changed since 10%${probe}`,
  );
}
console.log(ffprobe ? 'ffprobe checked the files too.' : 'ffprobe is not on PATH; skipped it.');
if (keep) console.log(`Clips kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
if (problems.length) {
  console.error(`record check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `record check passed: ${results.length} clip(s) of ${seconds} s, ${software ? 'software' : 'default'} encoder.`,
);
