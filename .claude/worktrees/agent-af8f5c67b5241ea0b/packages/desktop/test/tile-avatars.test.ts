// @vitest-environment happy-dom
// The four-tile mark and the tile avatars: which tile an id gets, which render each size loads,
// and that an avatar always names who it is.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, createElement } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TILE_COLORS, tileOf } from '../ui/src/lib/identity';
import { Mark, tileImage } from '../ui/src/ui/brand';
import { Avatar, ProviderMark, Who } from '../ui/src/ui/identity';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

// vitest runs from the repo root; under happy-dom, import.meta.url is not a file URL.
const ui = resolve('packages/desktop/ui');

let root: Root | undefined;
let box: HTMLDivElement;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function render(el: ReactElement): HTMLElement {
  root = createRoot(box);
  act(() => root!.render(el));
  return box.firstElementChild as HTMLElement;
}

/** Every source file under `dir`, as text. */
function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(tsx?|css|html|svg)$/.test(e.name))
    .map((e) => {
      const file = join(e.parentPath, e.name);
      return { file, text: readFileSync(file, 'utf8') };
    });
}

describe('tileOf', () => {
  it('gives each known provider its own tile and a person the pink one', () => {
    expect(tileOf('human:dawid')).toEqual({ key: 'you', color: TILE_COLORS.you });
    for (const p of ['claude', 'codex', 'grok', 'gemini', 'jev'] as const) {
      expect(tileOf(`${p}:engineer`)).toEqual({ key: p, color: TILE_COLORS[p] });
      expect(tileOf(p).key).toBe(p);
    }
  });

  it('gives the orchestrator the violet tile, but not a provider in that role', () => {
    expect(tileOf('*:orchestrator').key).toBe('orchestrator');
    expect(tileOf('orchestrator').key).toBe('orchestrator');
    expect(tileOf('claude:orchestrator').key).toBe('claude');
  });

  it('gives a provider without a render a flat tile in its own color', () => {
    expect(tileOf('cursor:engineer')).toEqual({ key: null, color: '#a5a8ff' });
    expect(tileOf('*:engineer').key).toBeNull();
    // A runtime that happens to be called like a tile is not that tile.
    expect(tileOf('you:engineer').key).toBeNull();
  });

  it('keeps the tile colors apart', () => {
    expect(new Set(Object.values(TILE_COLORS)).size).toBe(Object.keys(TILE_COLORS).length);
  });
});

describe('tileImage', () => {
  it('has a file for every tile at every size', () => {
    for (const key of Object.keys(TILE_COLORS) as Array<keyof typeof TILE_COLORS>)
      for (const size of [24, 30, 34, 40, 46, 64, 128, 256]) {
        const { src, srcSet } = tileImage(key, size);
        expect(src).toContain(`swarmup-tile-${key}-front-`);
        expect(srcSet).not.toMatch(/(^|, ) /);
      }
  });

  it('loads the smallest render that covers the size, and twice that for 2x screens', () => {
    expect(tileImage('claude', 30).srcSet).toMatch(/front-32\.png 1x, .*front-64\.png 2x$/);
    expect(tileImage('claude', 34).srcSet).toMatch(/front-64\.png 1x, .*front-128\.png 2x$/);
    expect(tileImage('claude', 46).srcSet).toMatch(/front-64\.png 1x, .*front-128\.png 2x$/);
    expect(tileImage('claude', 200).srcSet).toMatch(/front-256\.png 1x, .*front-256\.png 2x$/);
  });
});

describe('Avatar', () => {
  it('shows the provider tile render with the role icon on it from 24 px', () => {
    const el = render(createElement(Avatar, { id: 'codex:qa', size: 30 }));
    expect(el.dataset.tile).toBe('codex');
    expect(el.querySelector('img')?.getAttribute('src')).toContain('swarmup-tile-codex-front-32');
    expect(el.querySelector('svg.lucide')).not.toBeNull();
    expect(el.querySelector('[data-flat-tile]')).toBeNull();
  });

  it('draws a flat square in the tile color under 24 px', () => {
    const el = render(createElement(Avatar, { id: 'claude:engineer', size: 18 }));
    expect(el.querySelector('img')).toBeNull();
    const flat = el.querySelector<HTMLElement>('[data-flat-tile]');
    expect(flat?.style.background.toLowerCase()).toBe(TILE_COLORS.claude.toLowerCase());
    expect(el.querySelector('svg.lucide')).not.toBeNull();
  });

  it('draws a flat square at any size for a provider without a render', () => {
    const el = render(createElement(Avatar, { id: 'cursor:engineer', size: 40 }));
    expect(el.dataset.tile).toBe('flat');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('[data-flat-tile]')).not.toBeNull();
  });

  it('puts a person on the pink tile', () => {
    const el = render(createElement(Avatar, { id: 'human:dawid', size: 30 }));
    expect(el.dataset.tile).toBe('you');
    expect(el.querySelector('svg.lucide')).not.toBeNull();
  });

  it('names who it is, so color is never the only cue', () => {
    for (const size of [18, 30]) {
      const el = render(createElement(Avatar, { id: 'gemini:docs', size }));
      expect(el.getAttribute('title')).toBe('gemini:docs');
      expect(el.getAttribute('aria-label')).toBe('gemini:docs');
      act(() => root?.unmount());
    }
  });

  it('shows the initial of a bare provider that has no tile', () => {
    const el = render(createElement(Avatar, { id: 'cursor', size: 40 }));
    expect(el.textContent).toBe('C');
  });
});

describe('ProviderMark and Who', () => {
  it('is a flat tile labeled with the provider name', () => {
    const el = render(createElement(ProviderMark, { runtime: 'codex', size: 14 }));
    expect(el.getAttribute('aria-label')).toBe('Codex');
    expect(el.querySelector('title')?.textContent).toBe('Codex');
    expect(el.querySelector('rect')?.getAttribute('fill')).toBe(TILE_COLORS.codex);
    expect(el.querySelector('text')).toBeNull();
  });

  it('carries the initial of a provider without a tile', () => {
    const el = render(createElement(ProviderMark, { runtime: 'cursor' }));
    expect(el.querySelector('text')?.textContent).toBe('C');
  });

  it('writes the id next to the avatar', () => {
    const el = render(createElement(Who, { id: 'claude:engineer' }));
    expect(el.querySelector('[data-tile="claude"]')).not.toBeNull();
    expect(el.textContent).toBe('claude:engineer');
  });
});

describe('Mark', () => {
  it('is the flat four-tile mark under 48 px: pink, orange, cyan, violet', () => {
    const el = render(createElement(Mark, { size: 30 }));
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect([...el.querySelectorAll('rect')].map((r) => r.getAttribute('fill'))).toEqual([
      '#E46FB3',
      '#E8875B',
      '#4FC3D9',
      '#A393FF',
    ]);
  });

  it('is the 3D render from 48 px', () => {
    const el = render(createElement(Mark, { size: 48 }));
    expect(el.tagName.toLowerCase()).toBe('img');
    expect(el.getAttribute('src')).toContain('swarmup-icon-hero-64');
    expect(el.getAttribute('srcset')).toContain('swarmup-icon-hero-128');
  });
});

describe('the UI source', () => {
  it('has no trace of the teal ring logo', () => {
    const hits = sources(ui)
      .filter(
        ({ text }) => text.includes('M16 6.5a9.5 9.5 0 0 1 8.2 4.7') || /url\(#mk\)/.test(text),
      )
      .map(({ file }) => file);
    expect(hits).toEqual([]);
  });

  it('gives the page the tile favicon', () => {
    const html = readFileSync(join(ui, 'index.html'), 'utf8');
    expect(html).toMatch(/<link rel="icon"[^>]*href="\.\/src\/assets\/brand\/logo\.svg"/);
    expect(html).toContain('./src/assets/brand/favicon.ico');
  });
});
