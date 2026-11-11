// The website build (swarmup-web/build.mjs) on scratch repos, with a releases fixture instead of
// the GitHub API.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const BASE: Record<string, string> = {
  'package.json': '{"repository":"github:me/proj"}',
  'README.md': '# Proj\n\nSee [the protocol](docs/protocol.md).\n',
  'docs/protocol.md': '# Protocol\n\n## Statuses\n',
  'docs/media/shot.png': 'png',
  'UPDATES.md':
    '# Updates\n\n## v1.1.0 (2026-11-01)\n\n- New things. Every change: [CHANGELOG.md](CHANGELOG.md).\n',
  'CHANGELOG.md': '# Changelog\n',
  'swarmup-web/pages/home.html':
    '<h1>Proj</h1>\n<a href="download.html">Get it</a> <a href="docs/index.html">Docs</a>\n<img src="media/shot.png" alt="">\n',
  'swarmup-web/pages/install.md':
    '# Install\n\nGet it from the [download page](download.html), then read ' +
    '[statuses](../../docs/protocol.md#statuses), [the overview](../../README.md) and ' +
    '[the license](../../LICENSE).\n\n## macOS and Linux\n',
  LICENSE: 'MIT\n',
};

function repo(files: Record<string, string> = {}) {
  const d = mkdtempSync(join(tmpdir(), 'ops-site-'));
  dirs.push(d);
  for (const [name, body] of Object.entries({ ...BASE, ...files })) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), body);
  }
  return d;
}

function node(script: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GITHUB_ACTIONS: '' },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

const asset = (name: string, tag: string) => ({
  name,
  size: 3 * 1048576,
  browser_download_url: `https://github.com/me/proj/releases/download/${tag}/${name}`,
});
const RELEASES = [
  { tag_name: 'v1.2.0', draft: true, assets: [asset('Proj-Setup.exe', 'v1.2.0')] },
  { tag_name: 'v1.1.1', draft: false, assets: [asset('promo.mp4', 'v1.1.1')] },
  {
    tag_name: 'v1.1.0',
    draft: false,
    prerelease: false,
    html_url: 'https://github.com/me/proj/releases/tag/v1.1.0',
    published_at: '2026-11-01T10:00:00Z',
    assets: [
      asset('Proj-Setup.exe', 'v1.1.0'),
      asset('Proj-Setup.exe.blockmap', 'v1.1.0'),
      asset('latest.yml', 'v1.1.0'),
    ],
  },
];

const page = (d: string, p: string) => readFileSync(join(d, 'dist', 'site', p), 'utf8');

describe('website', () => {
  it('builds every page, names the newest release with an installer, and passes the link check', () => {
    const d = repo();
    const fixture = join(d, 'releases.json');
    writeFileSync(fixture, JSON.stringify(RELEASES));
    const r = node('../swarmup-web/build.mjs', '--root', d, '--releases', fixture);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/download v1\.1\.0/);

    // Drafts and releases without an installer are skipped; update metadata is not listed.
    const download = page(d, 'download.html');
    expect(download).toContain(
      'href="https://github.com/me/proj/releases/download/v1.1.0/Proj-Setup.exe"',
    );
    expect(download).toContain('<strong>v1.1.0</strong> (stable, 2026-11-01)');
    expect(download).not.toContain('v1.2.0/');
    expect(download).not.toContain('blockmap</a>');
    expect(download).not.toContain('latest.yml</a>');
    // The browser check for a newer release knows which one the build showed.
    expect(download).toContain('var shown = "v1.1.0"');
    expect(download).toContain('https://api.github.com/repos/me/proj/releases');

    const install = page(d, 'install.html');
    expect(install).toContain('href="download.html"');
    expect(install).toContain('href="docs/protocol.html#statuses"');
    expect(install).toContain('href="docs/index.html"');
    expect(install).toContain('href="https://github.com/me/proj/blob/main/LICENSE"');
    expect(install).toContain('id="macos-and-linux"');

    expect(page(d, 'changelog.html')).toContain(
      'href="https://github.com/me/proj/blob/main/CHANGELOG.md"',
    );
    expect(page(d, 'index.html')).toContain('<h1>Proj</h1>');
    expect(existsSync(join(d, 'dist', 'site', 'media', 'shot.png'))).toBe(true);
    expect(page(d, 'CNAME')).toBe('swarmup.tech\n');
    expect(page(d, 'docs/protocol.html')).toContain('href="../index.html"');
    expect(page(d, '404.html')).toContain('"protocol.html"');
    expect(page(d, '404.html')).toContain('href="/site.css"');

    const check = node('check-docs-links.mjs', join(d, 'dist', 'site'));
    expect(check.code, check.out).toBe(0);
  });

  it('links the releases page when no release is known', () => {
    const d = repo();
    const r = node(
      '../swarmup-web/build.mjs',
      '--root',
      d,
      '--offline',
      '--domain',
      'example.tech',
    );
    expect(r.code, r.out).toBe(0);
    expect(page(d, 'download.html')).toContain('href="https://github.com/me/proj/releases"');
    expect(page(d, 'download.html')).toContain('var shown = null');
    expect(page(d, 'CNAME')).toBe('example.tech\n');
  });

  it('marks a hyphenated tag as a pre-release even when GitHub does not', () => {
    const d = repo();
    const fixture = join(d, 'releases.json');
    const beta = { ...RELEASES[2], tag_name: 'v2.0.0-beta.1' };
    writeFileSync(fixture, JSON.stringify([beta]));
    expect(node('../swarmup-web/build.mjs', '--root', d, '--releases', fixture).code).toBe(0);
    expect(page(d, 'download.html')).toContain('(pre-release, 2026-11-01)');
  });

  it('fails on a broken link in a site page and writes nothing', () => {
    const d = repo({
      'swarmup-web/pages/install.md': '# Install\n\n[gone](../docs/gone.md)\n',
      'swarmup-web/pages/home.html': '<a href="nowhere.html">x</a>',
    });
    const r = node('../swarmup-web/build.mjs', '--root', d, '--offline');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/swarmup-web\/pages\/install\.md: broken link \.\.\/docs\/gone\.md/);
    expect(r.out).toMatch(/swarmup-web\/pages\/home\.html: broken link nowhere\.html/);
    expect(existsSync(join(d, 'dist', 'site'))).toBe(false);
  });

  it('refuses an output folder that holds a source', () => {
    const d = repo();
    const r = node('../swarmup-web/build.mjs', '--root', d, '--out', d, '--offline');
    expect(r.code).toBe(2);
    expect(existsSync(join(d, 'README.md'))).toBe(true);
  });

  it('lays the home page out full width and writes the script, stylesheet and icon it links (AO-0216)', () => {
    const d = repo({
      'swarmup-web/pages/home.html':
        '<h1>Proj</h1>\n<a href="download.html">Get it</a>\n<script src="site.js" defer></script>\n',
    });
    const r = node('../swarmup-web/build.mjs', '--root', d, '--offline');
    expect(r.code, r.out).toBe(0);
    expect(page(d, 'index.html')).toContain('<main class="wide">');
    expect(page(d, 'install.html')).toContain('<main class="prose">');
    expect(page(d, 'index.html')).toContain('<link rel="icon" href="favicon.svg"');
    expect(page(d, 'install.html')).toContain('href="site.css"');
    expect(page(d, 'site.js')).toContain("querySelector('[data-net] svg.net')");
    expect(page(d, 'favicon.svg')).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(page(d, '404.html')).toContain('href="/favicon.svg"');
    const check = node('check-docs-links.mjs', join(d, 'dist', 'site'));
    expect(check.code, check.out).toBe(0);
  });

  it('puts the docs pages in the site header, footer and stylesheet (AO-0216)', () => {
    const d = repo({
      'docs/guides/setup.md': '# Setup $1\n\nBack to [the protocol](../protocol.md).\n',
    });
    const r = node('../swarmup-web/build.mjs', '--root', d, '--offline');
    expect(r.code, r.out).toBe(0);
    const top = page(d, 'docs/protocol.html');
    expect(top).toContain('<title>Protocol · SwarmUp</title>');
    expect(top).toContain('<header class="top">');
    expect(top).toContain('<main class="docs">');
    expect(top).toContain('<article class="prose">');
    expect(top).toContain('href="../site.css"');
    expect(top).toContain('<a href="../docs/index.html" aria-current="page">Docs</a>');
    expect(top).toContain('<footer class="bottom">');
    expect(top).not.toContain('{{');
    expect(page(d, 'docs/index.html')).toContain('<title>Docs · SwarmUp</title>');
    // A page one folder down reaches the site root two levels up; a $ in a title stays as is.
    const nested = page(d, 'docs/guides/setup.html');
    expect(nested).toContain('href="../../site.css"');
    expect(nested).toContain('<title>Setup $1 · SwarmUp</title>');
    expect(nested).toContain('href="../protocol.html"');
    // The old GitHub-style docs stylesheet is gone; the site's has the docs rules.
    expect(existsSync(join(d, 'dist', 'site', 'docs', 'style.css'))).toBe(false);
    expect(page(d, 'site.css')).toContain('main.docs');
    const check = node('check-docs-links.mjs', join(d, 'dist', 'site'));
    expect(check.code, check.out).toBe(0);
  });

  it('stops the SVG packet animation under reduced motion (AO-0216)', () => {
    const d = repo();
    expect(node('../swarmup-web/build.mjs', '--root', d, '--offline').code).toBe(0);
    const css = page(d, 'site.css');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.net \.packet\s*\{\s*display: none !important;\s*\}/);
    expect(page(d, 'site.js')).toContain('svg.pauseAnimations()');
  });

  it('builds the real home page: four steps, each with its schematic lines (AO-0216)', () => {
    const real = fileURLToPath(new URL('../../../', import.meta.url));
    const out = mkdtempSync(join(tmpdir(), 'ops-site-real-'));
    dirs.push(out);
    const r = node('../swarmup-web/build.mjs', '--root', real, '--out', out, '--offline');
    expect(r.code, r.out).toBe(0);
    const home = readFileSync(join(out, 'index.html'), 'utf8');
    // Without JavaScript all four steps show as text and the schematic stays on the first stage.
    expect(home.match(/data-tab\b/g)).toHaveLength(4);
    expect(home).not.toMatch(/<button[^>]*data-tab[^>]*hidden/);
    expect(home).toContain('<svg class="net" data-stage="0"');
    for (const s of [0, 1, 2, 3]) expect(home).toContain(`class="e s${s}"`);
    expect(readFileSync(join(out, 'site.js'), 'utf8')).toContain("querySelectorAll('[data-tab]')");
    for (const shot of ['task.png', 'chat.png', 'runs.png', 'inbox.png']) {
      expect(existsSync(join(out, 'media', shot))).toBe(true);
    }
    // No page names the product's former brand, and no internal document is built.
    const built = (dir: string): string[] =>
      readdirSync(join(out, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? built(join(dir, e.name))
          : e.name.endsWith('.html')
            ? [join(dir, e.name)]
            : [],
      );
    for (const file of built('.')) {
      expect(readFileSync(join(out, file), 'utf8'), file).not.toMatch(/agent ?ops/i);
    }
    for (const internal of ['proposals', 'launch', 'research']) {
      expect(existsSync(join(out, 'docs', internal))).toBe(false);
    }
    expect(existsSync(join(out, 'docs', 'swarmup-rename.html'))).toBe(false);
  });

  it('leaves documents marked export-ignore out of the docs', () => {
    const d = repo({
      '.gitattributes': 'docs/internal/** export-ignore\ndocs/notes.md export-ignore\n',
      'docs/internal/plan.md': '# Internal plan\n',
      'docs/notes.md': '# Working notes\n',
    });
    // The attributes are read through git, so the scratch folder becomes a repository.
    expect(spawnSync('git', ['init', '-q'], { cwd: d, windowsHide: true }).status).toBe(0);
    const r = node('../swarmup-web/build.mjs', '--root', d, '--offline');
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(d, 'dist', 'site', 'docs', 'protocol.html'))).toBe(true);
    expect(existsSync(join(d, 'dist', 'site', 'docs', 'internal', 'plan.html'))).toBe(false);
    expect(existsSync(join(d, 'dist', 'site', 'docs', 'notes.html'))).toBe(false);
    expect(page(d, 'docs/protocol.html')).not.toMatch(/Internal plan|Working notes/);
    const check = node('check-docs-links.mjs', join(d, 'dist', 'site'));
    expect(check.code, check.out).toBe(0);
  });
});

describe('home page schematic', () => {
  it('matches the lists in swarmup-web/schematic.mjs (AO-0226)', () => {
    const r = spawnSync(
      process.execPath,
      [join(scripts, '..', 'swarmup-web', 'schematic.mjs'), '--check'],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});
