// Renders PNG stills of a Replay scene at 16:9, 1:1 and 9:16 (1920 x 1080, 1080 x 1080 and
// 1080 x 1920), for reviewing a scene's layout before Record exists for every aspect.
//
// The scene code is the desktop page's own (`packages/desktop/ui/src/replay`), bundled with
// esbuild for Node; each frame is server-rendered SVG, rasterized offscreen by Electron.
//
//   node scripts/replay-stills.mjs --fixture                                # the demo day
//   node scripts/replay-stills.mjs --store C:/dev/agent-ops --project swarmup --days 7
//   --scene swimlanes   --at 0.35,0.7,1   --clip 30   --out DIR
//
// `--at` takes fractions of the clip, outro card included. Files are named
// `<scene>-<source>-<aspect>-<pct>.png`. With `--store`, a scene that asks for `wrapped=1` gets the
// Wrapped figures from the report of the same window, as in the app. `--to` ends the window
// (default now). Needs `npm ci` and, for `--store`, `npm run build`.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { URLSearchParams, fileURLToPath, pathToFileURL } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(top, 'packages', 'desktop');
const require = createRequire(join(desktop, 'package.json'));
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);

const sceneId = opt('--scene', 'swimlanes');
const clipMs = Number(opt('--clip', '30')) * 1000;
const at = opt('--at', '0.35,0.7,1').split(',').map(Number);
const out = resolve(opt('--out', join(top, 'out', 'replay-stills')));
const fixture = argv.includes('--fixture');
const store = opt('--store', '');
if (!fixture && !store) {
  console.error('Pass --fixture or --store DIR.');
  process.exit(2);
}

const STAGES = [
  ['16x9', 1920, 1080],
  ['1x1', 1080, 1080],
  ['9x16', 1080, 1920],
];

const scratch = mkdtempSync(join(tmpdir(), 'replay-stills-'));
try {
  // The scene renderer, bundled from the page sources with React for Node.
  const esbuild = require('esbuild');
  const entry = `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { renderFrame, sceneDuration } from ${JSON.stringify(join(desktop, 'ui/src/replay/scene.tsx'))};
    import { sceneById } from ${JSON.stringify(join(desktop, 'ui/src/replay/scenes.ts'))};
    import { demoTimeline } from ${JSON.stringify(join(desktop, 'test/fixtures/replay-demo.ts'))};
    export { demoTimeline };
    export { loopCard } from ${JSON.stringify(join(desktop, 'ui/src/replay/scenes/loop-card.tsx'))};
    function find(id) {
      const scene = sceneById(id);
      if (scene.id !== id) throw new Error('no scene ' + id);
      return scene;
    }
    export const query = (id) => find(id).query ?? '';
    export const duration = (timeline, id) => sceneDuration(find(id), timeline);
    export function svg(timeline, id, width, height, t) {
      const scene = find(id);
      const data = scene.prepare(timeline, { width, height });
      const frame = { width, height, t, duration: sceneDuration(scene, timeline) };
      return renderToStaticMarkup(renderFrame(scene, data, frame));
    }`;
  const bundle = join(scratch, 'render.cjs');
  esbuild.buildSync({
    stdin: { contents: entry, resolveDir: desktop, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    outfile: bundle,
    logLevel: 'warning',
  });
  const render = createRequire(bundle)(bundle);

  let timeline;
  let source;
  if (fixture) {
    timeline = render.demoTimeline(clipMs);
    source = 'fixture';
  } else {
    const core = await import(pathToFileURL(join(top, 'packages/core/dist/index.js')).href);
    const ws = new core.Workspace({
      cwd: resolve(store),
      env: { ...process.env, SWARMUP_AGENT: '' },
    });
    const days = Number(opt('--days', '7'));
    const to = opt('--to', '') ? Date.parse(opt('--to', '')) : Date.now();
    const from = opt('--from', '') ? Date.parse(opt('--from', '')) : to - days * 86_400_000;
    const project = opt('--project', undefined);
    const query = new URLSearchParams(render.query(sceneId));
    timeline = ws.timeline({ project, from, to, clipMs, graph: query.get('graph') === '1' });
    // As `/api/timeline?wrapped=1` does: the Wrapped figures from the report of the same window.
    if (query.get('wrapped') === '1') {
      const sup = await import(pathToFileURL(join(top, 'packages/supervisor/dist/index.js')).href);
      const runs = new sup.RunStore(sup.stateDir(process.env)).list();
      const report = sup.buildReport(ws, runs, from, to, { project });
      timeline.wrapped = sup.buildWrapped(report, timeline);
      // The report's figures next to the stat card's, to check they match.
      console.log(sup.reportText(report).split('\n')[0]);
      console.log(`Card: ${JSON.stringify(render.loopCard(timeline))}`);
    }
    source = opt('--project', 'store');
  }

  mkdirSync(out, { recursive: true });
  const jobs = [];
  for (const [aspect, width, height] of STAGES) {
    for (const f of at) {
      const t = Math.min(1, Math.max(0, f)) * render.duration(timeline, sceneId);
      const name = `${sceneId}-${source}-${aspect}-${String(Math.round(f * 100)).padStart(3, '0')}`;
      const file = join(scratch, `${name}.svg`);
      writeFileSync(file, render.svg(timeline, sceneId, width, height, t));
      jobs.push({ svg: file, png: join(out, `${name}.png`), width, height });
    }
  }
  const list = join(scratch, 'jobs.json');
  writeFileSync(list, JSON.stringify(jobs));
  const electron = require('electron');
  const res = spawnSync(electron, [join(top, 'scripts', 'replay-stills-main.mjs'), list], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (res.status !== 0) throw new Error(`electron exited with ${res.status}`);
  for (const j of jobs) console.log(j.png);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
