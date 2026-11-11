#!/usr/bin/env node
// Builds the product website (swarmup.tech) into one folder that GitHub Pages serves:
//
//   index.html      home page, from swarmup-web/pages/home.html
//   download.html   the newest release with an installer, read from the GitHub API at build time
//   install.html    install guide, from swarmup-web/pages/install.md
//   changelog.html  release notes, from UPDATES.md (the same text each GitHub Release carries)
//   docs/           the docs site, built by scripts/build-docs.mjs from README.md and docs/
//   404.html        sends old docs addresses (/protocol.html) to their new place under /docs/
//   CNAME           the custom domain
//   site.css, site.js, favicon.svg   copied from swarmup-web/assets/
//
// The download page never names a fixed version. It shows the release the build found, and a
// small script asks the GitHub API again in the browser, so a release published after the build
// shows without a redeploy. Without a release (offline, API error) the page links the releases
// page instead. Relative links in the Markdown pages point at the built pages or at the file on
// GitHub; a link to a missing file fails the build.
//
// Usage: node swarmup-web/build.mjs [--root DIR] [--out DIR] [--domain NAME]
//          [--releases FILE | --offline]
//   Default out: <root>/dist/site; default domain: swarmup.tech. --releases reads a JSON array in
//   the shape of GET /repos/{owner}/{repo}/releases instead of calling the API. In Actions, the
//   GITHUB_TOKEN environment variable, when set, authenticates the API call.
/* global fetch, AbortSignal */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = resolve(opt('--root', process.cwd()));
const out = resolve(opt('--out', join(root, 'dist', 'site')));
const domain = opt('--domain', 'swarmup.tech');
const releasesFile = opt('--releases', '');
const offline = args.includes('--offline');
const ci = process.env.GITHUB_ACTIONS === 'true';
// This script lives in swarmup-web/; the shared tools it runs live in the repo's scripts/.
const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', 'scripts');

const PRODUCT = 'SwarmUp';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const repo = repoSlug(pkg.repository);
const repoUrl = repo ? `https://github.com/${repo}` : '';
const branch = 'main';

/** `github:owner/name`, `owner/name` or a GitHub URL -> `owner/name`. */
function repoSlug(repository) {
  const raw = typeof repository === 'string' ? repository : (repository?.url ?? '');
  const m = /(?:github:|github\.com[/:])?([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(raw);
  return m ? m[1] : '';
}

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function warn(msg) {
  console.warn(ci ? `::warning title=Site::${msg}` : `warning: ${msg}`);
}

// ---- Releases -----------------------------------------------------------------------------
// pickRelease and releaseHtml also run in the browser (their source goes into download.html), so
// they use nothing from outside their own body.

/** The newest published release with a Windows installer, or null. Input: API order, newest first. */
function pickRelease(list) {
  const SHOW = /\.(exe|msi|dmg|pkg|appimage|deb|rpm)$/i;
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || r.draft) continue;
    const assets = (r.assets || [])
      .filter((a) => a && SHOW.test(a.name) && a.browser_download_url)
      .map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size || 0 }));
    const installer = assets.find((a) => /\.exe$/i.test(a.name));
    if (!installer) continue;
    return {
      tag: r.tag_name,
      url: r.html_url,
      date: (r.published_at || r.created_at || '').slice(0, 10),
      prerelease: !!r.prerelease,
      installer,
      assets,
    };
  }
  return null;
}

/** The release block of the download page. `rel` is pickRelease's result. */
function releaseHtml(rel, releasesUrl) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  // The attribute is split ('href' + '=') so the link check, which reads this function's source
  // inside download.html, does not take the concatenation for a link.
  const a = (url, text, cls) =>
    '<a' + (cls ? ' class="' + cls + '"' : '') + ' href' + '="' + esc(url) + '">' + text + '</a>';
  if (!rel) {
    return (
      '<p>The installer is on the ' +
      a(releasesUrl, 'releases page') +
      ': open the newest release and download the <code>.exe</code> file.</p>'
    );
  }
  const mb = (n) => (n ? ' (' + (n / 1048576).toFixed(0) + ' MB)' : '');
  // Betas are tagged v0.2.0-beta.5 but not always marked as pre-releases on GitHub.
  const kind = rel.prerelease || String(rel.tag).indexOf('-') >= 0 ? 'pre-release' : 'stable';
  const rows = rel.assets
    .map((f) => '<li>' + a(f.url, esc(f.name)) + mb(f.size) + '</li>')
    .join('');
  return (
    '<p class="version">Latest release: <strong>' +
    esc(rel.tag) +
    '</strong> (' +
    kind +
    (rel.date ? ', ' + esc(rel.date) : '') +
    ')</p>' +
    '<p>' +
    a(rel.installer.url, 'Download for Windows', 'button') +
    '</p>' +
    '<p class="files">Files in this release:</p><ul>' +
    rows +
    '</ul>' +
    '<p>' +
    a(rel.url, 'Release notes on GitHub') +
    '</p>'
  );
}

async function loadReleases() {
  if (releasesFile) return JSON.parse(readFileSync(releasesFile, 'utf8'));
  if (offline || !repo) return null;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'swarmup-site-build' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      warn(`GitHub releases API answered ${res.status}; the download page links the releases page`);
      return null;
    }
    return await res.json();
  } catch (err) {
    warn(
      `GitHub releases API failed (${err.cause?.code ?? err.name}); the download page links the releases page`,
    );
    return null;
  }
}

// ---- Markdown pages -----------------------------------------------------------------------

// Repo files that are pages of this site, and where they are built to.
const SITE_PAGES = {
  'swarmup-web/pages/install.md': 'install.html',
  'UPDATES.md': 'changelog.html',
  'README.md': 'docs/index.html',
};
// Pages the build writes without a Markdown source; pages in swarmup-web/ link them by name.
const GENERATED = ['download.html'];
const errors = [];

/** Points a relative link of a Markdown page at the built page or at the file on GitHub. */
function rewrite(src, outFile, href) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href[0] === '#') {
    return href;
  }
  const i = href.indexOf('#');
  const path = i < 0 ? href : href.slice(0, i);
  const suffix = i < 0 ? '' : href.slice(i);
  const target = posix.normalize(posix.join(posix.dirname(src), decodeURI(path)));
  // A page the build generates, such as download.html, linked from a page in swarmup-web/.
  if (src.startsWith('swarmup-web/') && GENERATED.includes(path)) {
    return posix.relative(posix.dirname(outFile), path) + suffix;
  }
  const builtTo =
    SITE_PAGES[target] ??
    (target.startsWith('docs/') && target.endsWith('.md')
      ? target.replace(/\.md$/, '.html')
      : null);
  const abs = join(root, target);
  if (target.startsWith('..') || !existsSync(abs)) {
    errors.push(`${src}: broken link ${href} (no file ${target})`);
    return href;
  }
  if (builtTo) return posix.relative(posix.dirname(outFile), builtTo) + suffix;
  const kind = statSync(abs).isDirectory() ? 'tree' : 'blob';
  return `${repoUrl}/${kind}/${branch}/${encodeURI(target)}${suffix}`;
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Markdown file -> { title, html } with rewritten links and GitHub heading ids. */
function markdownPage(src, outFile) {
  const md = readFileSync(join(root, src), 'utf8');
  const seen = new Map();
  let title = '';
  const marked = new Marked({
    gfm: true,
    walkTokens: (token) => {
      if (token.type === 'link' || token.type === 'image') {
        token.href = rewrite(src, outFile, token.href);
      }
    },
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const text = inner.replace(/<[^>]*>/g, '');
        const base = slug(text);
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (depth === 1 && !title) title = text;
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
    },
  });
  const html = marked.parse(md);
  return { title: title || src, html };
}

// ---- Layout -------------------------------------------------------------------------------

const NAV = [
  ['index.html', 'Home'],
  ['download.html', 'Download'],
  ['install.html', 'Install'],
  ['docs/index.html', 'Docs'],
  ['changelog.html', 'Changelog'],
];

// The site's own files: the mark (four squares, one per kind of worker: you, two AI providers, the
// orchestrator), the stylesheet, the schematic's stage script and the favicon. They are read from
// the root being built, so a publish ships the committed versions.
// A root without its own assets (a scratch repo in the tests) uses this folder's.
const assets = existsSync(join(root, 'swarmup-web', 'assets'))
  ? join(root, 'swarmup-web', 'assets')
  : join(here, 'assets');
const asset = (name) => readFileSync(join(assets, name), 'utf8');
const LOGO = asset('logo.svg').trim();
const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap';

/**
 * One page of the site. `main`: `prose` is a text column, `wide` a page that lays out its own
 * full-width sections (the home page), `docs` a docs page with its sidebar. `current`: the nav
 * entry to mark. `up`: the path from the page to the site root, when `file` cannot tell it (the
 * docs frame, which every docs page shares whatever its folder).
 */
function layout({
  file,
  title,
  body,
  description = '',
  script = '',
  main = 'prose',
  current = file,
  up,
}) {
  up ??= posix.relative(posix.dirname(file), '.') || '.';
  const href = (p) => (up === '.' ? p : `${up}/${p}`);
  const links = NAV.map(([p, label]) => {
    const cur = p === current ? ' aria-current="page"' : '';
    return `<a href="${href(p)}"${cur}>${label}</a>`;
  }).join('\n');
  const github = repoUrl ? `<a href="${repoUrl}">GitHub</a>` : '';
  const full = title ? `${title} · ${PRODUCT}` : PRODUCT;
  const meta = description
    ? `<meta name="description" content="${escapeHtml(description)}">\n`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0E1015">
<title>${escapeHtml(full)}</title>
${meta}<link rel="icon" href="${href('favicon.svg')}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${href('site.css')}">
</head>
<body>
<header class="top">
<a class="brand" href="${href('index.html')}">${LOGO}${PRODUCT}</a>
<nav>
${links}
${github}
</nav>
<a class="button small" href="${href('download.html')}">Download</a>
</header>
<main class="${main}">
${body}
</main>
<footer class="bottom">
<span>${PRODUCT} · MIT licensed · made in the open</span>
${github}
</footer>
${script}</body>
</html>
`;
}

// The home page's schematic: the four steps under it light up one stage at a time, on their own
// until the reader clicks one. Without it all four steps show and the schematic stays on Plan.

// The site theme: a dark, flat ground with hairline rules, IBM Plex, and color only where it
// means something: who did the work (you, Claude, Codex, opsd). No gradients, no glows.

// ---- Build --------------------------------------------------------------------------------

const inside = (dir, file) => {
  const r = relative(resolve(dir), resolve(file));
  return !r.startsWith('..') && !isAbsolute(r);
};
for (const src of ['package.json', 'swarmup-web', 'docs', 'README.md', 'UPDATES.md']) {
  if (existsSync(join(root, src)) && inside(out, join(root, src))) {
    console.error(`site: refusing to write into ${out}: it holds ${src}`);
    process.exit(2);
  }
}
for (const src of [
  'swarmup-web/pages/home.html',
  'swarmup-web/pages/install.md',
  'UPDATES.md',
  'README.md',
]) {
  if (!existsSync(join(root, src))) {
    console.error(`site: ${src} is missing`);
    process.exit(2);
  }
}

const install = markdownPage('swarmup-web/pages/install.md', 'install.html');
const changelog = markdownPage('UPDATES.md', 'changelog.html');
const home = readFileSync(join(root, 'swarmup-web', 'pages', 'home.html'), 'utf8');
// Files the build writes next to the pages, which the home page may link.
const ASSETS = ['site.js', 'site.css', 'favicon.svg'];
// The home page links pages of the site and images under media/, which are the docs' own
// screenshots (docs/media/), copied at build time so they never drift apart.
const media = new Set();
for (const m of home.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
  const link = m[1].split('#')[0];
  if (!link || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) continue;
  const known = [...NAV.map(([p]) => p), ...Object.values(SITE_PAGES), ...ASSETS];
  if (known.includes(link)) continue;
  if (link.startsWith('media/') && existsSync(join(root, 'docs', link))) media.add(link);
  else errors.push(`swarmup-web/pages/home.html: broken link ${m[1]}`);
}
if (errors.length) {
  for (const e of errors) console.error(e);
  console.error(`site: ${errors.length} broken link(s); nothing written`);
  process.exit(1);
}

const releases = await loadReleases();
const release = pickRelease(releases);
if (releases && !release) warn('no published release has a Windows installer yet');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// The docs: README.md and docs/ under docs/, inside this site's header, footer and stylesheet.
// build-docs fills the frame's {{title}}, {{body}} and {{root}} (the path to the site root).
const frameDir = mkdtempSync(join(tmpdir(), 'swarmup-site-'));
try {
  const frame = join(frameDir, 'frame.html');
  writeFileSync(
    frame,
    layout({
      file: 'docs/index.html',
      title: '{{title}}',
      body: '{{body}}',
      main: 'docs',
      current: 'docs/index.html',
      up: '{{root}}',
    }),
  );
  execFileSync(
    process.execPath,
    [join(scripts, 'build-docs.mjs'), '--root', root, '--out', join(out, 'docs'), '--frame', frame],
    { stdio: 'inherit', windowsHide: true },
  );
} finally {
  rmSync(frameDir, { recursive: true, force: true });
}

const write = (file, html) => {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), html);
};

write(
  'index.html',
  layout({
    file: 'index.html',
    title: '',
    description:
      'SwarmUp runs a team of AI coding agents and one human on one task queue, with tasks as files in git.',
    body: home,
    main: 'wide',
  }),
);

write('install.html', layout({ file: 'install.html', title: install.title, body: install.html }));
write(
  'changelog.html',
  layout({ file: 'changelog.html', title: 'Changelog', body: changelog.html }),
);

const releasesUrl = repoUrl ? `${repoUrl}/releases` : '#';
const refresh = repo
  ? `<script>
(function () {
  var pickRelease = ${pickRelease.toString()};
  var releaseHtml = ${releaseHtml.toString()};
  var shown = ${JSON.stringify(release ? release.tag : null)};
  fetch('https://api.github.com/repos/${repo}/releases?per_page=20', {
    headers: { accept: 'application/vnd.github+json' }
  }).then(function (res) { return res.ok ? res.json() : null; }).then(function (list) {
    var rel = list && pickRelease(list);
    if (rel && rel.tag !== shown) {
      document.getElementById('release').innerHTML = releaseHtml(rel, ${JSON.stringify(releasesUrl)});
    }
  }).catch(function () {});
})();
</script>
`
  : '';
write(
  'download.html',
  layout({
    file: 'download.html',
    title: 'Download',
    body: `<h1>Download ${PRODUCT}</h1>
<p class="lead">One installer sets up the desktop app, the orchestrator that runs your agents in the background, and the command-line tool. It installs for your user only and updates itself.</p>
<div id="release">
${releaseHtml(release, releasesUrl)}
</div>
<h2>Before you install</h2>
<ul>
<li>Windows 10 or 11. The desktop app ships for Windows today; on macOS and Linux, run the command-line tool and the orchestrator from source (see the <a href="install.html#macos-and-linux">install guide</a>).</li>
<li>Git, and at least one coding agent from your AI provider, signed in: today <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code</a> or <a href="https://github.com/openai/codex">Codex</a>.</li>
<li>The installer is not code-signed yet, so Windows SmartScreen asks first: choose <strong>More info</strong>, then <strong>Run anyway</strong>.</li>
</ul>
<p>Next: the <a href="install.html">install guide</a> walks you from the installer to your first agent task. Every release, with its notes, is on <a href="${escapeHtml(releasesUrl)}">GitHub Releases</a>.</p>`,
    script: refresh,
  }),
);

// A docs address without /docs/ (swarmup.tech/protocol.html, or the same under the repository
// name on github.io) is a known docs page at another path: the 404 page sends it there.
const docPages = readdirSync(join(out, 'docs'), { recursive: true })
  .map((p) => String(p).split('\\').join('/'))
  .filter((p) => p.endsWith('.html'));
write(
  '404.html',
  layout({
    file: '404.html',
    title: 'Page not found',
    body: `<h1>Page not found</h1>
<p>This page does not exist. The <a href="/docs/index.html">docs</a> and the <a href="/install.html">install guide</a> may have what you were looking for.</p>`,
    script: `<script>
(function () {
  var docs = ${JSON.stringify(docPages)};
  var path = location.pathname.replace(/^\\/swarmup\\//, '/').replace(/^\\//, '');
  if (path && docs.indexOf(path) >= 0) location.replace('/docs/' + path + location.hash);
})();
</script>
`,
  }).replace(
    /href="(?:\.\/)?(site\.css|favicon\.svg|index\.html|download\.html|install\.html|changelog\.html|docs\/index\.html)"/g,
    'href="/$1"',
  ),
);

for (const name of ASSETS) copyFileSync(join(assets, name), join(out, name));
for (const file of media) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  copyFileSync(join(root, 'docs', file), join(out, file));
}
// GitHub Pages takes the custom domain from the repository settings when Actions deploys the
// site; the file records it next to the site and serves other hosts that read it.
writeFileSync(join(out, 'CNAME'), `${domain}\n`);

const what = release ? `download ${release.tag}` : 'download links the releases page';
console.log(`site: ${NAV.length + 1} page(s) and the docs written to ${out} (${what})`);
