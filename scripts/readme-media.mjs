// Renders the README showcase media: screenshots of the desktop app and a short animation of agents
// moving tasks across the board. Everything runs against scratch data roots in the temp folder,
// with a scratch swarmupd whose "claude" and "codex" runtimes are a scripted stand-in (fake-agent.mjs,
// written into the scratch folder), so no real agent starts and no user config or app data is
// touched. The screenshots also cover the closed loop: workflows with a gate, triggers and merge
// checks, a benchmark that a stand-in `codex` (first on PATH for that one command) runs, a score
// breakdown, a proposed change to an agent, and the project map. The app shows the scratch
// folder's path as `~`.
//
//   node scripts/readme-media.mjs                 # screenshots and animation into docs/media/
//   node scripts/readme-media.mjs --only shots    # or --only anim
//   node scripts/readme-media.mjs --keep          # keep the scratch folders and raw frames
//   node scripts/readme-media.mjs --size 1600x960 # window size (default 1600x960)
//
// Needs `pnpm run build` and `pnpm run build:desktop`, and ffmpeg on PATH for the animation.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(top, 'packages', 'cli', 'dist', 'main.js');
const out = join(top, 'docs', 'media');
const argv = process.argv.slice(2);
const opt = (name, def) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : def);
const only = opt('--only', null);
const keep = argv.includes('--keep');
// At the app's default 1360 px the board's fifth column is cut off, so the window is resized.
const size = opt('--size', '1600x960').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ME = 'human:you';
const CE = 'claude:engineer';
const XE = 'codex:engineer';
const QA = 'codex:qa';
const RV = 'claude:reviewer';
const PM = 'claude:pm';

/**
 * The stand-in runtime swarmupd starts for every run: it reads the prompt, finds the task id, runs the
 * `swarmup` steps planned for that task in plan.json with pauses between them, and prints Claude
 * `stream-json` or Codex `--json` lines with token usage, so runs show tokens like real ones.
 */
const FAKE_AGENT = `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const CLI = process.argv[2];
const PLAN = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = process.env.SWARMUP_AGENT ?? process.env.OPS_AGENT ?? '';
const codex = agent.startsWith('codex:');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
await new Promise((r) => { process.stdin.on('end', r); setTimeout(r, 3000); });
const task = (prompt.match(/\\b(?:SHOP|DOCS)-\\d{4}\\b/) ?? [])[0];
const plan = (task && JSON.parse(readFileSync(PLAN, 'utf8'))[task]) || { steps: [], hold: 1000 };
const say = (o) => console.log(JSON.stringify(o));
const total = { input_tokens: 0, output_tokens: 0 };
const usage = () => {
  const u = { input_tokens: 9000 + Math.floor(Math.random() * 21000), output_tokens: 600 + Math.floor(Math.random() * 2400) };
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  return u;
};
say(codex ? { type: 'turn.started' } : { type: 'system', subtype: 'init', model: 'demo' });
let n = 0;
for (const [wait, ...args] of plan.steps) {
  await sleep(wait);
  const text = 'swarmup ' + args.join(' ');
  if (codex) {
    say({ type: 'item.completed', item: { type: 'command_execution', command: text } });
    say({ type: 'turn.completed', usage: { ...usage(), cached_input_tokens: 0 } });
  }
  else say({ type: 'assistant', message: { id: 'msg_' + ++n, usage: usage(), content: [{ type: 'text', text }] } });
  const r = spawnSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf8', windowsHide: true });
  console.log((r.stdout || '') + (r.stderr || ''));
}
await sleep(plan.hold ?? 1500);
if (!codex) say({ type: 'result', subtype: 'success', usage: total, result: 'Done.' });
`;

/**
 * The stand-in `codex` the benchmark runs, from a folder put first on PATH for that one command:
 * it reads the prompt, makes the entry's change in the worktree on some attempts only, so repeats
 * differ, and prints Codex `--json` lines with token usage, so the run gets an estimated cost.
 */
const FAKE_CODEX = `import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const cwd = argv[argv.indexOf('-C') + 1] || process.cwd();
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
await new Promise((r) => { process.stdin.on('end', r); setTimeout(r, 3000); });
const say = (o) => console.log(JSON.stringify(o));
const edit = (rel, add) => {
  const f = join(cwd, rel);
  mkdirSync(dirname(f), { recursive: true });
  let text = '';
  try { text = readFileSync(f, 'utf8'); } catch {}
  writeFileSync(f, text + add + '\\n');
  say({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: rel, kind: 'update' }] } });
};
const usage = () => ({
  input_tokens: 40000 + Math.floor(Math.random() * 60000),
  cached_input_tokens: 20000,
  output_tokens: 2000 + Math.floor(Math.random() * 6000),
});
say({ type: 'thread.started', thread_id: 'demo' });
say({ type: 'turn.started' });
for (const c of ['ls src', 'cat src/' + (prompt.match(/\\b(cart|search|coupon)\\b/i)?.[1] ?? 'cart').toLowerCase() + '.js']) {
  say({ type: 'item.completed', item: { type: 'command_execution', command: c, exit_code: 0 } });
}
// Which attempts of an entry make each change, so every render shows the same spread.
const attempt = (key) => {
  const f = join(dirname(process.argv[1]), 'attempts-' + key);
  let n = 0;
  try { n = Number(readFileSync(f, 'utf8')); } catch {}
  writeFileSync(f, String(n + 1));
  return n;
};
if (/badge/i.test(prompt)) {
  attempt('cart');
  edit('src/cart.js', 'export const afterRemove = (q) => q.invalidate("cart");');
} else if (/out-of-stock/i.test(prompt)) {
  if (attempt('search') !== 1) edit('src/search.js', 'export const rank = (a, b) => Number(b.inStock) - Number(a.inStock);');
} else if (/expired/i.test(prompt)) {
  const n = attempt('coupon');
  if (n === 0) edit('src/coupon.js', 'export const valid = (c, now) => !c.expires || c.expires > now;');
  if (n < 2) edit('test/coupon.test.js', 'test("expired codes are refused", () => {});');
}
say({ type: 'turn.completed', usage: usage() });
`;

/** A fresh scratch workspace: two project repos, a user config, a state dir, a scratch swarmupd. */
function workspace(tag) {
  const base = mkdtempSync(join(tmpdir(), `swarmup-readme-${tag}-`));
  const shop = join(base, 'storefront');
  const docs = join(base, 'docs-site');
  const state = join(base, 'state');
  const work = join(base, 'work');
  for (const d of [shop, docs, state, join(work, 'claude'), join(work, 'codex')]) {
    mkdirSync(d, { recursive: true });
  }
  for (const d of [shop, docs]) {
    execFileSync('git', ['init', '-q'], { cwd: d, stdio: 'ignore', windowsHide: true });
  }
  const fwd = (p) => p.replace(/\\/g, '/');
  const agentJs = join(base, 'fake-agent.mjs');
  const plan = join(base, 'plan.json');
  writeFileSync(agentJs, FAKE_AGENT);
  writeFileSync(plan, '{}');
  const runtime = `{ command: '${fwd(process.execPath)}', args: ['${fwd(agentJs)}', '${fwd(cli)}', '${fwd(plan)}'] }`;
  const config = join(base, 'config.yml');
  writeFileSync(
    config,
    [
      `me: ${ME}`,
      'roots:',
      `  - '${fwd(docs)}'`,
      'swarmupd:',
      '  port: 0',
      '  sync: false',
      '  max_runs: 6',
      '  min_free_gb: 0',
      '  review_backlog: 50',
      '  seeded: 1',
      '  runtimes:',
      `    claude: ${runtime}`,
      `    codex: ${runtime}`,
      '  roles:',
      '    engineer: { per_project: 4 }',
      // Each engineer works in a folder of its own, so their runs do not wait for one checkout.
      '  agents:',
      `    claude:engineer: { cwd: '${fwd(join(work, 'claude'))}', model: opus }`,
      `    codex:engineer: { cwd: '${fwd(join(work, 'codex'))}' }`,
      '    codex:qa: {}',
      '    claude:reviewer: {}',
      '    claude:pm: {}',
      '    claude:improver: {}',
      '  chat:',
      '    agent: claude:pm',
      '    mentions: false',
      '  schedules:',
      '    - name: standup',
      "      at: '09:00'",
      '      agent: claude:pm',
      '      prompt: Write the daily standup from open tasks and post it to the general channel.',
      '      paused: true',
      '    - name: triage',
      '      every: 2h',
      '      agent: codex:qa',
      '      prompt: Triage new findings and propose priorities.',
      '      paused: true',
      '',
    ].join('\n'),
  );
  const env = {
    ...process.env,
    SWARMUP_CONFIG: config,
    SWARMUP_STATE_DIR: state,
    SWARMUP_CWD: shop,
  };
  // Both prefixes: the old OPS_* names are still read when the new ones are unset.
  for (const k of ['AGENT', 'RUN', 'ROOTS', 'RUN_TOKEN', 'RUN_STATE_DIR']) {
    delete env['SWARMUP_' + k];
    delete env['OPS_' + k];
  }
  const envAs = (actor) => (actor ? { ...env, SWARMUP_AGENT: actor } : env);
  const swarmup = (actor, ...args) =>
    execFileSync(process.execPath, [cli, ...args], {
      cwd: shop,
      env: envAs(actor),
      encoding: 'utf8',
      windowsHide: true,
    });
  // Fire and forget, for the animation: one slow `swarmup` must not hold the next step.
  const swarmupAsync = (actor, ...args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [cli, ...args], {
        cwd: shop,
        env: envAs(actor),
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => {
        // A refused launch is retried by the caller, so only other failures are printed.
        if (code !== 0 && args[0] !== 'launch') {
          console.error(`  swarmup ${args.slice(0, 2).join(' ')}: ${err.trim()}`);
        }
        resolve(code);
      });
    });
  const plans = {};
  const setPlan = (task, steps, hold = 1500) => {
    plans[task] = { steps, hold };
    writeFileSync(plan, JSON.stringify(plans, null, 2));
  };
  const status = (task) => {
    try {
      return JSON.parse(swarmup(ME, 'show', task, '--json')).task.status;
    } catch {
      return null;
    }
  };
  const waitStatus = async (task, want, ms = 60_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (want.includes(status(task))) return true;
      await sleep(400);
    }
    console.error(`  ${task} did not reach ${want.join('|')} (is ${status(task)})`);
    return false;
  };
  return {
    base,
    shop,
    docs,
    state,
    config,
    env,
    swarmup,
    swarmupAsync,
    setPlan,
    status,
    waitStatus,
  };
}

const id = (s) => s.match(/[A-Z]+-\d{4}/)[0];

/** The demo: a web shop and its docs site. Tasks first, worked directly where no run is needed. */
function seed(w) {
  const { swarmup } = w;
  swarmup(ME, 'init', '--name', 'storefront', '--prefix', 'SHOP', '--human', ME);
  execFileSync(
    process.execPath,
    [cli, 'init', w.docs, '--name', 'docs-site', '--prefix', 'DOCS', '--human', ME],
    { cwd: w.docs, env: { ...w.env, SWARMUP_AGENT: ME }, stdio: 'ignore', windowsHide: true },
  );
  const task = (title, ...o) => id(swarmup(ME, 'new', title, ...o));
  const T = {};
  T.checkout = task(
    'Checkout total ignores discount codes on mobile Safari',
    '--type',
    'bug',
    '--priority',
    'p0',
    '--label',
    'checkout',
    '--to',
    CE,
    '-m',
    'Repro: add any item, apply `WELCOME10` on iOS 18 Safari, the total does not change.',
  );
  T.pricing = task(
    'Redesign the pricing page with a monthly/annual toggle',
    '--priority',
    'p1',
    '--label',
    'pricing',
    '--label',
    'ui',
    '--to',
    XE,
    '-m',
    'Three plans, annual saves 20 %. Keep the comparison table below the fold.',
    '--done-when',
    'Annual prices show 20 % off on the plan cards and in the table',
    '--done-when',
    '{ kind: check, check: regex, args: { path: src/pricing/toggle.tsx, pattern: aria-pressed } }',
    '--done-when',
    'The toggle works with the keyboard',
  );
  T.images = task(
    'Serve responsive product images (srcset, AVIF)',
    '--priority',
    'p1',
    '--label',
    'perf',
    '--to',
    CE,
    '-m',
    'The product grid ships 2400 px JPEGs to phones. Generate 400, 800 and 1200 px widths in AVIF and WebP.',
  );
  T.a11y = task(
    'Accessibility pass on the checkout form',
    '--priority',
    'p1',
    '--label',
    'a11y',
    '--to',
    XE,
    '-m',
    'Labels, error messages tied to inputs, focus order, 4.5:1 contrast.',
  );
  T.dark = task(
    'Dark mode for the storefront theme',
    '--priority',
    'p2',
    '--label',
    'ui',
    '--to',
    '*:engineer',
  );
  T.cart = task(
    'Cart badge count is stale after removing an item',
    '--type',
    'bug',
    '--priority',
    'p2',
    '--label',
    'cart',
    '--to',
    '*:engineer',
  );
  T.webhook = task(
    'Retry failed payment webhooks with backoff',
    '--priority',
    'p1',
    '--label',
    'payments',
    '--to',
    XE,
  );
  T.search = task(
    'Search ranks out-of-stock products first',
    '--type',
    'bug',
    '--priority',
    'p2',
    '--label',
    'search',
    '--to',
    '*:engineer',
  );
  T.e2e = task(
    'End-to-end tests for guest checkout',
    '--priority',
    'p1',
    '--label',
    'tests',
    '--to',
    QA,
  );
  T.reviews = task(
    'Lazy-load the reviews widget below the fold',
    '--priority',
    'p3',
    '--label',
    'perf',
    '--to',
    CE,
  );
  T.shipping = task(
    'Shipping estimate times out for international addresses',
    '--type',
    'bug',
    '--priority',
    'p1',
    '--label',
    'checkout',
    '--to',
    CE,
  );
  T.gift = task('Gift card balance page', '--priority', 'p3', '--label', 'payments');
  T.sale = task(
    'Holiday sale launch',
    '--priority',
    'p1',
    '--label',
    'marketing',
    '--to',
    PM,
    '-m',
    'Site-wide 25 % off from Black Friday to Cyber Monday: banner, countdown, sale badges.',
  );
  T.wish = task('Shareable wishlists', '--type', 'idea', '--label', 'growth');

  // Working: images (Claude) and the e2e suite (QA).
  swarmup(CE, 'start', T.images, 'sharp at build time, <picture> with AVIF and WebP fallbacks');
  swarmup(
    CE,
    'progress',
    T.images,
    'The build emits 3 widths in 2 formats; the grid uses srcset now.',
  );
  swarmup(QA, 'start', T.e2e, 'Playwright: guest checkout with card, PayPal and a declined card');
  swarmup(
    QA,
    'progress',
    T.e2e,
    '7 of 11 scenarios pass; the declined-card flow needs a test key.',
  );

  // Blocked: the webhook retries wait for the human, shipping waits on the webhook work.
  swarmup(XE, 'start', T.webhook, 'Queue failed events, exponential backoff');
  swarmup(
    XE,
    'ask',
    T.webhook,
    'How long should we retry a failed webhook before we alert: 24 h or 72 h?',
    // To the person, with a pick: without --human the question goes to the PM agent, and the
    // Inbox screenshot shows nothing.
    '--human',
    '--recommend',
    '72 h. Card networks retry for up to three days.',
  );
  swarmup(CE, 'start', T.shipping, 'Profile the carrier API call');
  swarmup(
    CE,
    'block',
    T.shipping,
    `The carrier fallback needs the retry queue from ${T.webhook}.`,
    '--on',
    T.webhook,
  );

  // Findings from QA and the reviewer.
  swarmup(
    QA,
    'finding',
    'Product images have no width/height: layout shift on the grid',
    '--task',
    T.images,
    '--priority',
    'p2',
    '-m',
    'CLS 0.21 on the category page (mobile).',
  );
  swarmup(
    RV,
    'finding',
    'Coupon field accepts expired codes',
    '--task',
    T.checkout,
    '--priority',
    'p1',
    '-m',
    '`SUMMER24` still applies. The expiry check runs only server-side.',
  );

  // The PM breaks the sale into subtasks (the chat transcript shows the turn).
  swarmup(PM, 'start', T.sale, 'Break the launch into tasks');
  T.prices = id(
    swarmup(
      PM,
      'new',
      'Schedule the 25 % price rule for Nov 27 to Dec 1',
      '--parent',
      T.sale,
      '--priority',
      'p1',
      '--label',
      'pricing',
      '--to',
      XE,
    ),
  );
  T.banner = id(
    swarmup(
      PM,
      'new',
      'Sale banner with countdown on every page',
      '--parent',
      T.sale,
      '--priority',
      'p1',
      '--label',
      'marketing',
      '--to',
      '*:engineer',
    ),
  );
  T.badges = id(
    swarmup(
      PM,
      'new',
      'Sale price badges on product cards',
      '--parent',
      T.sale,
      '--priority',
      'p2',
      '--label',
      'ui',
      '--to',
      '*:engineer',
    ),
  );
  swarmup(PM, 'progress', T.sale, `Filed ${T.prices}, ${T.banner} and ${T.badges}.`);

  // Knowledge, channels, a vote.
  swarmup(
    CE,
    'learn',
    'safari',
    'Promo inputs: listen to input, not change',
    '-m',
    'iOS Safari fires `change` on blur only. Recompute totals on `input`.',
    '--task',
    T.checkout,
  );
  swarmup(
    CE,
    'learn',
    'images',
    'AVIF with a WebP fallback in <picture>',
    '-m',
    'Order the sources AVIF, WebP, then the JPEG `img`. Always set width and height.',
  );
  swarmup(
    QA,
    'learn',
    'testing',
    'Stripe test cards for declined payments',
    '-m',
    'Use 4000 0000 0000 0002 for a generic decline in Playwright runs.',
  );
  swarmup(
    PM,
    'channel',
    'post',
    'general',
    `The holiday sale is split into ${T.prices}, ${T.banner} and ${T.badges}. @codex:engineer the price rule is yours.`,
  );
  swarmup(
    XE,
    'channel',
    'post',
    'general',
    `On it after ${T.a11y}. @claude:reviewer the pricing page is ready for you.`,
  );
  swarmup(
    QA,
    'channel',
    'post',
    'qa',
    'Guest checkout suite: 7/11 green. The declined-card flow is next.',
  );
  swarmup(
    PM,
    'propose',
    'Which image CDN should we use for product photos?',
    '--option',
    'Cloudflare Images',
    '--option',
    'imgix',
    '--option',
    'Self-hosted (sharp + S3)',
    '--voters',
    `${CE},${XE},${RV}`,
    '--deadline',
    '+48h',
    '--task',
    T.images,
    '-m',
    `${T.images} needs a CDN that serves AVIF. Cost and cache purge speed matter most.`,
  );

  swarmup(CE, 'vote', 'D-0001', '1', 'Serves AVIF on the fly and purges in seconds.');
  swarmup(XE, 'vote', 'D-0001', '3', 'Cheapest at our volume; we already resize with sharp.');

  // docs-site
  const dtask = (title, ...o) => id(swarmup(ME, 'new', title, ...o, '--root', 'docs-site'));
  const D = {};
  D.start = dtask('Getting started guide', '--priority', 'p1', '--label', 'docs', '--to', CE);
  D.links = dtask(
    'Fix broken links in the API reference',
    '--type',
    'bug',
    '--priority',
    'p2',
    '--label',
    'docs',
    '--to',
    XE,
  );
  D.search = dtask('Add search to the docs site', '--priority', 'p2', '--label', 'docs');
  D.versions = dtask('Versioned docs for API v2', '--priority', 'p3', '--label', 'docs');
  swarmup(XE, 'start', D.links, 'Link checker in CI first', '--root', 'docs-site');
  return { T, D };
}

/** Finished work, done through swarmupd runs so Runs, Reports and the task history show real runs. */
async function history(w, T, D) {
  const { swarmup, setPlan, waitStatus } = w;
  setPlan(T.checkout, [
    [300, 'start', T.checkout, 'Reproduce in WebKit, then fix applyDiscount()'],
    [
      800,
      'progress',
      T.checkout,
      'Found it: Safari fires `change` on the promo input only on blur.',
    ],
    [
      800,
      'review',
      T.checkout,
      'The total is recomputed on `input` now; added a WebKit test.',
      '--to',
      QA,
    ],
  ]);
  setPlan(T.pricing, [
    [300, 'start', T.pricing, 'Toggle component first, then plan cards and the table'],
    [800, 'progress', T.pricing, 'Toggle and plan cards done; prices come from the plans API.'],
    [
      800,
      'review',
      T.pricing,
      'Ready: toggle, three plan cards, annual badge, mobile layout.',
      '--to',
      RV,
    ],
  ]);
  setPlan(T.reviews, [
    [300, 'start', T.reviews, 'IntersectionObserver around the widget'],
    [
      800,
      'review',
      T.reviews,
      'The widget loads 200 px before it scrolls into view. LCP -0.4 s.',
      '--to',
      XE,
    ],
  ]);
  setPlan(T.a11y, [
    [300, 'start', T.a11y, 'axe-core audit first'],
    [
      800,
      'review',
      T.a11y,
      'Labels and aria-describedby on every field; axe is clean.',
      '--to',
      RV,
    ],
  ]);
  setPlan(D.start, [
    [300, 'start', D.start, 'Install, first order, webhooks', '--root', 'docs-site'],
    [
      800,
      'review',
      D.start,
      'The guide is live on the preview site.',
      '--to',
      XE,
      '--root',
      'docs-site',
    ],
  ]);
  // swarmupd refuses a launch while its sign-in check at start still runs, and Codex launches
  // while it repairs what Codex sessions left, so the launch is tried again until both are done.
  const launch = async (agent, task) => {
    for (let tries = 0; ; tries++) {
      try {
        return swarmup(ME, 'launch', agent, '--task', task);
      } catch (err) {
        if (tries >= 60 || !/checks whether|runs start after that/.test(String(err.stderr))) {
          throw err;
        }
        await sleep(1000);
      }
    }
  };
  const run = async (agent, task, verdict) => {
    await launch(agent, task);
    await waitStatus(task, ['needs-review']);
    // The run ends shortly after its review; the next run of the agent needs its folder free.
    await sleep(2500);
    if (verdict) swarmup(...verdict);
  };
  await Promise.all([
    (async () => {
      await run(CE, T.checkout, [
        QA,
        'verdict',
        T.checkout,
        'approve',
        'Verified on iOS 18 Safari and desktop Chrome.',
      ]);
      await run(CE, T.reviews, [
        XE,
        'verdict',
        T.reviews,
        'approve',
        'Looks good, no layout shift.',
      ]);
      await run(CE, D.start, [
        XE,
        'verdict',
        D.start,
        'approve',
        'Clear and short.',
        '--root',
        'docs-site',
      ]);
    })(),
    (async () => {
      await run(XE, T.pricing, null);
      swarmup(
        RV,
        'comment',
        T.pricing,
        'Annual prices round to .99 on the cards but not in the table.',
        '--to',
        XE,
      );
      swarmup(
        XE,
        'comment',
        T.pricing,
        'Fixed: the table uses the same price formatter as the cards now.',
        '--to',
        RV,
      );
      await run(XE, T.a11y, [
        RV,
        'verdict',
        T.a11y,
        'changes',
        'Focus still jumps to the top after a failed submit. Move it to the first invalid field.',
      ]);
    })(),
  ]);
}

/** The chat view: the human asks the PM to split an idea into tasks. */
function writeChat(w, T) {
  const t0 = Date.now() - 6 * 60_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const created = (task, title) => ({
    kind: 'task',
    type: 'created',
    root: 'storefront',
    task,
    title,
    summary: '',
  });
  writeFileSync(
    join(w.state, 'chat.json'),
    JSON.stringify({
      markers: {},
      messages: [
        {
          id: '01README0CHAT00000000000001',
          role: 'user',
          at: at(0),
          text: `Break ${T.sale} into tasks we can start this week. Prices go live Nov 27.`,
          from: ME,
          status: 'sent',
        },
        {
          id: '01README0CHAT00000000000002',
          role: 'assistant',
          at: at(1),
          text: [
            `I split ${T.sale} into three tasks under it:`,
            '',
            `- ${T.prices}: p1, assigned to \`codex:engineer\``,
            `- ${T.banner}: p1, open to any engineer`,
            `- ${T.badges}: p2, open to any engineer`,
            '',
            'The price rule should merge first, so the badges read real sale prices. Banner and badges can run in parallel.',
          ].join('\n'),
          actions: [
            created(T.prices, 'Schedule the 25 % price rule for Nov 27 to Dec 1'),
            created(T.banner, 'Sale banner with countdown on every page'),
            created(T.badges, 'Sale price badges on product cards'),
            {
              kind: 'channel',
              type: 'post',
              root: 'storefront',
              channel: 'general',
              summary: 'Holiday sale plan posted',
            },
          ],
        },
        {
          id: '01README0CHAT00000000000003',
          role: 'user',
          at: at(3),
          text: `Good. Who is free to take ${T.banner}?`,
          from: ME,
          status: 'sent',
        },
        {
          id: '01README0CHAT00000000000004',
          role: 'assistant',
          at: at(4),
          text: `\`claude:engineer\` is close to done with ${T.images}, and \`codex:engineer\` is fixing review notes on ${T.a11y}. The banner stays open to \`*:engineer\`, so whoever frees up first claims it.`,
          actions: [],
        },
      ],
    }),
  );
}

/** Writes `rel` under the storefront's task store (`.swarmup/`), making its folders. */
function storeFile(w, rel, lines) {
  const f = join(w.shop, '.swarmup', ...rel.split('/'));
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, Array.isArray(lines) ? lines.join('\n') + '\n' : lines);
}

/**
 * The closed loop around the queue, for the newer views: workflows with gates, triggers and merge
 * checks in git, a project map, a finished benchmark with repeats and an estimated cost, and a
 * proposed change to an agent. Runs after the run history, so the runs above stay as they are.
 */
function closedLoop(w, T) {
  const { swarmup } = w;
  const templates = join(top, 'packages', 'core', 'templates');
  const commit = (...a) =>
    execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], {
      cwd: w.shop,
      stdio: 'ignore',
      windowsHide: true,
    });
  // Definitions as code: the team settings, merge checks, workflows, a rubric and triggers.
  storeFile(w, 'swarm.yaml', [
    'swarmup_defs: 1',
    'runtimes:',
    '  claude: { model: opus }',
    '  codex: { model: gpt-5.6-terra, effort: medium }',
    'checks:',
    '  test: npm test',
    '  lint:',
    '    run: npm run lint',
    "    paths: ['src/**', '!docs/**']",
    '    description: Lint the code',
    'improvement:',
    '  agent: claude:improver',
  ]);
  for (const wf of ['feature', 'bugfix', 'campaign-launch']) {
    storeFile(w, `workflows/${wf}.yaml`, readFileSync(join(templates, 'workflows', `${wf}.yaml`)));
  }
  storeFile(w, 'rubrics/brand-voice.md', [
    '---',
    'id: brand-voice',
    'scale: { min: 0, max: 4 }',
    'criteria:',
    '  - id: voice',
    '    describe: Sounds like the brand guide, plain and specific.',
    '  - id: claims',
    '    describe: Every claim about price or delivery matches the offer.',
    'inputs: [task, diff]',
    '---',
    '',
    '# Brand voice',
    '',
    'Score each criterion from 0 (off brand) to 4 (could ship as is).',
  ]);
  storeFile(w, 'triggers/standup.yaml', [
    "cron: '0 9 * * mon-fri'",
    'action: run',
    'agent: claude:pm',
    'prompt: Post the standup in the general channel.',
  ]);
  storeFile(w, 'triggers/nightly-e2e.yaml', [
    "at: '02:00'",
    'action: run',
    'agent: codex:qa',
    'prompt: Run the guest checkout suite and file a finding for each failure.',
  ]);
  storeFile(w, 'triggers/github-issues.yaml', [
    'webhook:',
    '  verify: hmac',
    '  secret: GITHUB_WEBHOOK_SECRET',
    'action: run',
    'agent: claude:pm',
    'prompt: Triage the GitHub issue in the payload.',
  ]);
  swarmup(null, 'triggers', 'on', '--root', 'storefront', '--trust');
  swarmup(null, 'defs', 'trust', '--root', 'storefront');
  // A stand-in value, so the webhook card shows the secret as set; the listener stays off.
  writeFileSync(
    join(w.base, 'secrets.yml'),
    'GITHUB_WEBHOOK_SECRET: demo-only-not-a-real-value-0000\n',
  );

  // A feature workflow started and approved, its spec done: the gate waits in the Inbox.
  const started = swarmup(
    ME,
    'workflow',
    'start',
    'feature',
    '--param',
    'feature=Saved carts across devices',
  );
  const milestone = id(started);
  const made = swarmup(ME, 'plan', 'approve', milestone);
  const spec = [...made.matchAll(/[A-Z]+-\d{4}/g)].map((m) => m[0]).find((t) => t !== milestone);
  if (spec) {
    swarmup(CE, 'start', spec, 'Read the cart store first, then write the spec');
    swarmup(CE, 'done', spec, 'Spec in the thread: merge on sign-in, newest quantity wins.');
  }

  // A project map: what each part of the shop is for, where it lives, and how parts link. The
  // files the nodes cover exist, so the map check passes.
  const node = (rel, front, body = []) =>
    storeFile(w, `map/${rel}`, ['---', ...front, '---', '', ...body]);
  for (const f of [
    'cart.js',
    'search.js',
    'coupon.js',
    'checkout/index.js',
    'catalog/index.js',
    'images/index.js',
    'payments/webhooks.js',
  ]) {
    mkdirSync(dirname(join(w.shop, 'src', f)), { recursive: true });
    writeFileSync(join(w.shop, 'src', f), `// ${f}\n`);
  }
  // A review refuses a checkout with uncommitted code, so the shop's code is committed.
  commit('add', 'src');
  commit('commit', '-q', '-m', 'Shop code');
  swarmup(null, 'map', 'init', '--type', 'code');
  node('index.md', [
    'kind: root',
    'type: code',
    'summary: A web shop with checkout, search, a pricing page and payment webhooks',
    'links: [checkout, cart, search, catalog, payments]',
  ]);
  node(
    'checkout.md',
    [
      'kind: flow',
      'summary: Guest and signed-in checkout, from cart to paid order',
      'covers: [src/checkout/]',
      'links: [cart, payments, coupons]',
    ],
    ['# Checkout', '', 'Totals are recomputed on every `input` event; Safari fires `change` late.'],
  );
  node('coupons.md', [
    'kind: module',
    "summary: 'Discount codes: validation, expiry, stacking rules'",
    'covers: [src/coupon.js]',
    'links: [checkout]',
  ]);
  node('cart.md', [
    'kind: module',
    'summary: The cart store, the badge count and saved carts',
    'covers: [src/cart.js]',
    'links: [catalog]',
  ]);
  node('search.md', [
    'kind: module',
    'summary: Product search and ranking; in-stock items rank first',
    'covers: [src/search.js]',
    'links: [catalog]',
  ]);
  node('catalog.md', [
    'kind: module',
    'summary: Products, prices, stock and responsive images',
    'covers: [src/catalog/, src/images/]',
  ]);
  node('payments.md', [
    'kind: module',
    'summary: Payment provider calls and webhook retries with backoff',
    'covers: [src/payments/]',
    'links: [checkout]',
  ]);
  swarmup(null, 'map', 'index');

  // A benchmark: three real bugs replayed three times by a stand-in Codex in a small app repo.
  const app = join(w.base, 'shop-app');
  mkdirSync(join(app, 'src'), { recursive: true });
  for (const f of ['cart.js', 'search.js', 'coupon.js']) {
    writeFileSync(join(app, 'src', f), `// ${f}\n`);
  }
  writeFileSync(join(app, 'package.json'), '{ "name": "shop-app", "private": true }\n');
  const git = (...a) =>
    execFileSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.com', ...a], {
      cwd: app,
      stdio: 'ignore',
      windowsHide: true,
    });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'Shop app');
  const set = (title, body, checks) => [
    `  - id: ${title[0]}`,
    '    base: { ref: HEAD }',
    '    task:',
    '      type: bug',
    `      title: ${title[1]}`,
    `      body: ${body}`,
    '    done_when:',
    ...checks.map((c) => `      - ${c}`),
  ];
  storeFile(w, 'benchmarks/storefront-bugs.yaml', [
    'id: storefront-bugs',
    'description: Bugs from the storefront queue, replayed against their base commit',
    'defaults:',
    '  agent: codex:engineer',
    '  repeat: 3',
    'entries:',
    ...set(
      ['CART-12', 'Cart badge count is stale after removing an item'],
      'The badge reads a cached count. Refresh it after a remove.',
      ['{ kind: check, check: regex, args: { path: src/cart.js, pattern: invalidate } }'],
    ),
    ...set(
      ['SRCH-7', 'Search ranks out-of-stock products first'],
      'Rank in-stock products before out-of-stock ones.',
      ['{ kind: check, check: regex, args: { path: src/search.js, pattern: inStock } }'],
    ),
    ...set(
      ['CPN-3', 'Coupon field accepts expired codes'],
      'SUMMER24 still applies. Refuse expired codes in the browser too, with a test.',
      [
        '{ kind: check, check: regex, args: { path: src/coupon.js, pattern: expires } }',
        '{ kind: check, check: file-exists, args: { path: test/coupon.test.js } }',
      ],
    ),
  ]);
  const bin = join(w.base, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'fake-codex.mjs'), FAKE_CODEX);
  writeFileSync(
    join(bin, 'codex.cmd'),
    `@"${process.execPath}" "${join(bin, 'fake-codex.mjs')}" %*\r\n`,
  );
  writeFileSync(
    join(bin, 'codex'),
    `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-codex.mjs')}" "$@"\n`,
    { mode: 0o755 },
  );
  // Only this command sees the stand-in first on PATH; the real codex is never started.
  const benchEnv = Object.fromEntries(
    Object.entries(w.env).filter(([k]) => k.toUpperCase() !== 'PATH'),
  );
  benchEnv.PATH = [bin, process.env.PATH ?? process.env.Path ?? ''].join(
    process.platform === 'win32' ? ';' : ':',
  );
  const benchId = 'storefront-bugs-codex';
  execFileSync(
    process.execPath,
    [
      cli,
      'bench',
      'run',
      join(w.shop, '.swarmup', 'benchmarks', 'storefront-bugs.yaml'),
      '--repo',
      app,
      '--agent',
      XE,
      '--model',
      'gpt-5.6-terra',
      '--repeat',
      '3',
      '--max-usd',
      '5',
      '--out',
      join(w.state, 'bench', benchId),
    ],
    { cwd: w.shop, env: benchEnv, stdio: 'ignore', windowsHide: true, timeout: 300_000 },
  );

  // Review rounds for codex:engineer: the accessibility pass goes through on its second review,
  // dark mode on its third, so its score breakdown has a pass and a fail.
  swarmup(XE, 'start', T.a11y, 'Move focus to the first invalid field');
  swarmup(XE, 'review', T.a11y, 'Focus moves to the first invalid field after submit.', '--to', RV);
  swarmup(RV, 'verdict', T.a11y, 'approve', 'Keyboard and VoiceOver pass.');
  swarmup(XE, 'start', T.dark, 'CSS variables for the theme, then a toggle in the header');
  swarmup(XE, 'review', T.dark, 'Dark theme and toggle in the header.', '--to', RV);
  swarmup(RV, 'verdict', T.dark, 'changes', 'Sale badges are unreadable on dark: 2.1:1 contrast.');
  swarmup(XE, 'start', T.dark, 'Dark palette for the sale badges');
  swarmup(XE, 'review', T.dark, 'Badges use the dark palette now.', '--to', RV);
  swarmup(RV, 'verdict', T.dark, 'changes', 'The toggle has no label for screen readers.');
  swarmup(XE, 'start', T.dark, 'Label the toggle');
  swarmup(XE, 'review', T.dark, 'The toggle has an aria-label and a focus ring.', '--to', RV);
  swarmup(RV, 'verdict', T.dark, 'approve', 'Contrast and focus check out.');

  // A proposed change to codex:engineer, from the improver, after its UI work kept bouncing.
  storeFile(w, 'agents/codex-engineer.md', [
    '---',
    'id: codex:engineer',
    'name: Engineer',
    'description: Features and fixes in the storefront, delivered as reviewed branches',
    'status: active',
    '---',
    '',
    '# Engineer',
    '',
    '## Definition of done',
    '',
    'Tests pass, then `swarmup review <ID>` to a reviewer from another provider.',
  ]);
  const improve = id(
    swarmup(
      ME,
      'new',
      'Improve codex:engineer: UI work bounces on accessibility',
      '--label',
      'improve',
      '--to',
      'claude:improver',
      '-m',
      `Scorers: review-rounds\nEvidence: ${T.a11y} and ${T.dark} went back for focus, labels and contrast.`,
    ),
  );
  const overlay = join(w.base, 'overlay');
  mkdirSync(join(overlay, 'agents'), { recursive: true });
  writeFileSync(
    join(overlay, 'agents', 'codex-engineer.md'),
    [
      '---',
      'id: codex:engineer',
      'name: Engineer',
      'description: Features and fixes in the storefront, delivered as reviewed branches',
      'status: active',
      '---',
      '',
      '# Engineer',
      '',
      '## Definition of done',
      '',
      'Tests pass, then `swarmup review <ID>` to a reviewer from another provider.',
      '',
      'On a task labeled `ui` or `a11y`, before review: run axe on the changed pages, tab through',
      'every form you touched, and check where focus lands after a failed submit. Say what you',
      'checked in the review message.',
      '',
    ].join('\n'),
  );
  swarmup(
    'claude:improver',
    'defs',
    'propose',
    improve,
    '--dir',
    overlay,
    '--name',
    'engineer-a11y-pass',
    '--agent',
    XE,
    '--scorer',
    'review-rounds',
    '-m',
    'Reviews send UI work back for keyboard and focus problems: check them before review.',
  );
  // The definitions are committed, so run stamps name a commit instead of "dirty".
  commit('add', '-A');
  commit('commit', '-q', '-m', 'Storefront');
  return { benchId };
}

/**
 * What the screenshot run does on a view after it opens, for views that need a click or a scroll
 * first: the page script waits for its element, acts, then gives the result time to load.
 */
/** Views that read more before they show: the screenshot run waits longer on them. */
const SLOW_VIEWS = ['bench', 'map', 'workflows', 'automation', 'reports', 'agents'];

const ACTIONS = {
  'reports:breakdown': `
    const want = ['codex:engineer/review-rounds', 'codex:engineer/criteria-pass-rate'];
    for (let i = 0; i < 60; i++) {
      const cells = [...document.querySelectorAll('[data-score-cell]')];
      const cell = want.map((w) => cells.find((c) => c.dataset.scoreCell === w)).find(Boolean)
        ?? cells.find((c) => c.dataset.scoreCell.startsWith('codex:engineer/')) ?? cells[0];
      if (cell) { cell.click(); break; }
      await new Promise((r) => setTimeout(r, 100));
    }`,
  'agents:proposals': `
    for (let i = 0; i < 60; i++) {
      const el = document.querySelector('[data-testid="proposals"]');
      if (el && el.querySelector('[data-testid^="proposal-"]')) {
        el.scrollIntoView({ block: 'start' });
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }`,
};

/**
 * A page script that shows the scratch folder's path as `~` wherever the app prints it (the map
 * folder, run folders), in text and in tooltips, now and as views change.
 */
function scrubScript(base) {
  const forms = [...new Set([base, base.replace(/\\/g, '/')])];
  return `(() => {
    const forms = ${JSON.stringify(forms)};
    const fix = (s) => forms.reduce((t, f) => t.split(f).join('~'), s);
    const walk = (root) => {
      const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = it.nextNode(); n; n = it.nextNode()) {
        if (forms.some((f) => n.nodeValue.includes(f))) n.nodeValue = fix(n.nodeValue);
      }
      for (const el of root.querySelectorAll('[title]')) {
        const t = el.getAttribute('title');
        if (forms.some((f) => t.includes(f))) el.setAttribute('title', fix(t));
      }
    };
    walk(document.body);
    new MutationObserver(() => walk(document.body)).observe(document.body, {
      subtree: true, childList: true, characterData: true,
    });
  })()`;
}

/**
 * A wrapper app in the scratch folder that resizes the window and turns off the card rise
 * animation, then imports the real main process (packages/desktop/dist/main.js), so the build
 * itself is not changed.
 */
function wrapper(w) {
  const dir = join(w.base, 'app');
  mkdirSync(dir, { recursive: true });
  const main = pathToFileURL(join(top, 'packages', 'desktop', 'dist', 'main.js')).href;
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'swarmup-readme', type: 'module', main: 'main.mjs' }),
  );
  writeFileSync(
    join(dir, 'main.mjs'),
    [
      "import { app } from 'electron';",
      `const ACTIONS = ${JSON.stringify(ACTIONS)};`,
      `const SLOW = ${JSON.stringify(SLOW_VIEWS)};`,
      // The app waits 1.2 s on each view before it keeps the frame. A view that loads more, or
      // that an action clicks through, gets longer: the next 1.2 s wait after its navigate.
      'const realTimeout = globalThis.setTimeout;',
      'let longer = 0;',
      'globalThis.setTimeout = (fn, ms, ...rest) => {',
      '  if (longer && ms === 1200) { ms = longer; longer = 0; }',
      '  return realTimeout(fn, ms, ...rest);',
      '};',
      "app.on('browser-window-created', (_e, win) => {",
      `  win.setSize(${size[0]}, ${size[1]});`,
      // Cards rise in over 0.32 s when they change column; a frame taken then shows a gap.
      "  win.webContents.on('dom-ready', () => win.webContents.insertCSS('.animate-rise, .animate-fade { animation: none !important; }'));",
      // The scratch folder's path would name the user's profile: show it as ~ instead.
      `  const scrub = ${JSON.stringify(scrubScript(w.base))};`,
      "  win.webContents.on('dom-ready', () => win.webContents.executeJavaScript(scrub).catch(() => {}));",
      '  const send = win.webContents.send.bind(win.webContents);',
      '  win.webContents.send = (channel, msg, ...rest) => {',
      '    send(channel, msg, ...rest);',
      "    if (channel !== 'swarmup:navigate' || !msg) return;",
      "    const key = msg.id === undefined ? msg.view : msg.view + ':' + msg.id;",
      '    const js = ACTIONS[key];',
      '    if (js || SLOW.includes(msg.view)) longer = js ? 5000 : 3500;',
      '    if (js) realTimeout(() => win.webContents.executeJavaScript(`(async () => {${js}})()`).catch(() => {}), 300);',
      '  };',
      '});',
      `await import('${main}');`,
      '',
    ].join('\n'),
  );
  return dir;
}

/** Starts the app in screenshot mode for `views`; resolves with its exit code. */
function launchApp(w, shots, views) {
  const electron = createRequire(import.meta.url)('electron');
  const child = spawn(electron, [wrapper(w), `--user-data-dir=${join(w.base, 'userdata')}`], {
    env: { ...w.env, SWARMUP_SCREENSHOTS: shots, SWARMUP_VIEWS: views.join(',') },
    // No pipes: the scratch swarmupd would hold them open past the app's exit.
    stdio: 'ignore',
    windowsHide: true,
  });
  console.log(`  app pid ${child.pid}`);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error('  app timed out; stopping it');
      child.kill();
    }, 300_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

function startDaemon(w) {
  execFileSync(process.execPath, [cli, 'daemon', 'start'], {
    cwd: w.shop,
    env: w.env,
    stdio: 'ignore',
    windowsHide: true,
    timeout: 120_000,
  });
}

/** Stops the scratch swarmupd and every run it still has. */
function stopDaemon(w) {
  if (w.stopped) return;
  w.stopped = true;
  const ok =
    spawnSync(process.execPath, [cli, 'daemon', 'stop', '--kill-runs'], {
      cwd: w.shop,
      env: w.env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 60_000,
    }).status === 0;
  if (!ok) console.error(`  could not stop the scratch opsd: see ${join(w.state, 'opsd.json')}`);
}

function problemsOf(shots) {
  const f = join(shots, 'problems.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : ['no problems.json'];
}

/** Seeds a workspace with tasks and run history; swarmupd keeps running for the app. */
async function prepare(tag) {
  console.log(`${tag}: seeding`);
  const w = workspace(tag);
  live.push(w);
  const { T, D } = seed(w);
  writeChat(w, T);
  startDaemon(w);
  console.log(`${tag}: runs for finished work`);
  await history(w, T, D);
  return { w, T, D };
}

// The screenshots kept in docs/media, by raw view file; every view is rendered and checked.
const SHOTS = {
  board: 'board.png',
  task: 'task.png',
  inbox: 'inbox.png',
  chat: 'chat.png',
  runs: 'runs.png',
  activity: 'activity.png',
  workflows: 'workflows.png',
  automation: 'automation.png',
  bench: 'benchmark.png',
  'reports-breakdown': 'breakdown.png',
  'agents-proposals': 'proposals.png',
  map: 'map.png',
};

async function screenshots() {
  const { w, T } = await prepare('shots');
  console.log('shots: workflows, triggers, map, benchmark, proposal');
  const { benchId } = closedLoop(w, T);
  // Two live runs while the app looks: Claude on the images, QA on the e2e suite.
  w.setPlan(
    T.images,
    [[500, 'progress', T.images, 'Product detail page done; checking LCP on a throttled profile.']],
    240_000,
  );
  w.setPlan(
    T.e2e,
    [[500, 'progress', T.e2e, '9 of 11 scenarios pass; PayPal sandbox next.']],
    240_000,
  );
  const run = w.swarmup(ME, 'launch', CE, '--task', T.images).trim().split(' ')[0];
  w.swarmup(ME, 'launch', QA, '--task', T.e2e);
  await sleep(3000);
  const shots = join(w.base, 'shots');
  const views = [
    'board',
    `task:${T.pricing}`,
    'board:lanes:agent',
    'inbox',
    'list',
    'findings',
    'activity',
    'agents',
    `runs:${run}`,
    'decisions',
    'chat',
    'channels',
    'knowledge',
    'schedules',
    'reports',
    'workflows',
    'automation',
    `bench:${benchId}`,
    'reports:breakdown',
    'agents:proposals',
    'map:graph:storefront',
    'map:storefront#checkout',
  ];
  console.log('shots: rendering');
  const code = await launchApp(w, shots, views);
  stopDaemon(w);
  const problems = problemsOf(shots);
  console.log(`  exit ${code}, problems: ${problems.length ? problems.join(' | ') : 'none'}`);
  mkdirSync(out, { recursive: true });
  for (const [raw, name] of Object.entries(SHOTS)) {
    const file =
      {
        task: `task-${T.pricing}`,
        runs: `runs-${run}`,
        bench: `bench-${benchId}`,
        map: 'map-graph-storefront',
      }[raw] ?? raw;
    const from = join(shots, `${file}.png`);
    if (existsSync(from)) copyFileSync(from, join(out, name));
  }
  console.log(`  raw screenshots in ${shots}`);
  return w;
}

/**
 * The animation: the app captures the board once per view step (about 1.2 s) while this process
 * starts runs and gives verdicts, each step fired once the frame it follows is on disk.
 */
async function animation() {
  const { w, T } = await prepare('anim');
  const { swarmup, swarmupAsync, setPlan, waitStatus } = w;
  // The e2e suite keeps running through the whole clip.
  setPlan(
    T.e2e,
    [[500, 'progress', T.e2e, '9 of 11 scenarios pass; PayPal sandbox next.']],
    240_000,
  );
  swarmup(ME, 'launch', QA, '--task', T.e2e);
  setPlan(T.a11y, [
    [300, 'start', T.a11y, 'Move focus to the first invalid field after submit'],
    [2200, 'progress', T.a11y, 'Focus handling done; rerunning axe and VoiceOver.'],
    [2200, 'review', T.a11y, 'Focus moves to the first invalid field; axe is clean.', '--to', RV],
  ]);
  setPlan(T.cart, [
    [300, 'start', T.cart, 'Invalidate the cart query after a remove'],
    [2500, 'progress', T.cart, 'Root cause: the badge reads a cached count.'],
    [2500, 'review', T.cart, 'The badge updates on remove; added a unit test.', '--to', QA],
  ]);
  setPlan(T.webhook, [
    [300, 'start', T.webhook, 'Backoff 1 m, 5 m, 30 m, then hourly up to 72 h'],
    [2000, 'progress', T.webhook, 'Retry queue and alert after the third failure.'],
    [
      2000,
      'review',
      T.webhook,
      'Retries with backoff for 72 h; alert after 3 failures.',
      '--to',
      RV,
    ],
  ]);
  setPlan(
    T.search,
    [
      [300, 'start', T.search, 'Sort by stock, then relevance'],
      [3000, 'progress', T.search, 'In-stock items rank first; tuning the boost.'],
    ],
    240_000,
  );
  const launch = async (agent, task) => {
    for (let i = 0; i < 10; i++) {
      if ((await swarmupAsync(ME, 'launch', agent, '--task', task)) === 0) return;
      await sleep(700);
    }
    console.error(`  could not launch ${agent} on ${task}`);
  };
  const after =
    (task, want, ...cmd) =>
    async () => {
      if (await waitStatus(task, want, 30_000)) await swarmupAsync(...cmd);
    };
  // [frame, step]: each step starts right after that frame is written.
  const steps = [
    [
      1,
      () =>
        swarmupAsync(
          RV,
          'verdict',
          T.pricing,
          'approve',
          'Toggle, cards and table match. Ship it.',
        ),
    ],
    [2, () => launch(XE, T.a11y)],
    [3, () => launch(CE, T.cart)],
    [
      4,
      () => swarmupAsync(ME, 'answer', T.webhook, 'Retry for 72 h, alert after the third failure.'),
    ],
    [
      5,
      () =>
        swarmupAsync(
          CE,
          'review',
          T.images,
          'srcset and AVIF on the grid and product pages. LCP 2.9 s -> 1.6 s.',
          '--to',
          QA,
        ),
    ],
    [
      7,
      () => swarmupAsync(QA, 'verdict', T.images, 'approve', 'Checked on a throttled 3G profile.'),
    ],
    [
      8,
      after(
        T.a11y,
        ['needs-review'],
        RV,
        'verdict',
        T.a11y,
        'approve',
        'Keyboard and VoiceOver pass.',
      ),
    ],
    [
      9,
      () =>
        swarmupAsync(
          QA,
          'finding',
          'Cart drawer does not return focus to the cart button',
          '--task',
          T.cart,
          '--priority',
          'p2',
        ),
    ],
    [10, () => launch(XE, T.webhook)],
    [
      11,
      after(
        T.cart,
        ['needs-review'],
        QA,
        'verdict',
        T.cart,
        'approve',
        'Verified on desktop and mobile.',
      ),
    ],
    [13, () => launch(CE, T.search)],
    [
      15,
      after(
        T.webhook,
        ['needs-review'],
        RV,
        'verdict',
        T.webhook,
        'approve',
        'Good coverage of the retry paths.',
      ),
    ],
  ];
  const frames = 19;
  const views = Array.from({ length: frames }, (_, i) => `board:f${String(i).padStart(2, '0')}`);
  views.push(`task:${T.webhook}`);
  const shots = join(w.base, 'frames');
  console.log(`anim: recording ${views.length} frames`);
  let finished = false;
  const done = launchApp(w, shots, views).then((c) => {
    finished = true;
    return c;
  });
  const pending = [];
  for (const [frame, step] of steps) {
    const file = join(shots, `board-f${String(frame).padStart(2, '0')}.png`);
    while (!existsSync(file) && !finished) await sleep(50);
    if (finished) break;
    pending.push(step());
  }
  const code = await done;
  await Promise.all(pending);
  stopDaemon(w);
  const problems = problemsOf(shots);
  console.log(`  exit ${code}, problems: ${problems.length ? problems.join(' | ') : 'none'}`);
  console.log(`  raw frames in ${shots}`);
  return { w, shots, views };
}

/** Builds demo.mp4 and demo.gif from the frames: each frame held, with a short crossfade. */
function encode(shots, views) {
  const files = views.map((v) => join(shots, `${v.replace(/[:/]/g, '-')}.png`));
  const hold = 0.9;
  const fade = 0.3;
  const inputs = [];
  files.forEach((f, i) => {
    const last = i === files.length - 1;
    inputs.push('-loop', '1', '-t', String(last ? hold + 2 : hold + fade), '-i', f);
  });
  let chain = '';
  let prev = '[0:v]';
  let offset = 0;
  for (let i = 1; i < files.length; i++) {
    offset += hold;
    const label = `[x${i}]`;
    chain += `${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(2)}${label};`;
    prev = label;
  }
  mkdirSync(out, { recursive: true });
  const mp4 = join(out, 'demo.mp4');
  const gif = join(out, 'demo.gif');
  const ff = (...args) =>
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], {
      stdio: 'inherit',
      windowsHide: true,
    });
  ff(
    ...inputs,
    '-filter_complex',
    `${chain}${prev}fps=30,format=yuv420p[v]`,
    '-map',
    '[v]',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '20',
    '-movflags',
    '+faststart',
    mp4,
  );
  ff(
    '-i',
    mp4,
    '-filter_complex',
    'fps=10,scale=1280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop',
    '0',
    gif,
  );
  for (const f of [mp4, gif]) console.log(`  ${f}: ${(statSync(f).size / 1e6).toFixed(2)} MB`);
}

const scratch = [];
/** Workspaces whose swarmupd may still run, stopped on the way out whatever happens. */
const live = [];
try {
  if (only !== 'anim') scratch.push((await screenshots()).base);
  if (only !== 'shots') {
    const { w, shots, views } = await animation();
    scratch.push(w.base);
    encode(shots, views);
  }
} finally {
  for (const w of live) stopDaemon(w);
  if (!keep) for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}
