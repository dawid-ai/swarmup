// @vitest-environment happy-dom
// The Map view (W2), rendered: Create map without a map; with one, the root summary, nodes by
// kind and as a tree, search by words or file, a node with its covers and links, the check with
// its health badge, Rebuild index and the graph. Plus the view's pure helpers.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../ui/src/App';
import {
  byKind,
  graphLayout,
  healthOf,
  isPathQuery,
  localDay,
  reviewDue,
  treeRows,
} from '../ui/src/lib/map';
import type { MapCheck, MapNodeBrief, MapNodeView, MapView } from '../ui/src/types';
import { ProjectMap } from '../ui/src/views/Map';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const answers = new Map<string, unknown>();
const gets: string[] = [];
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
const postAnswers = new Map<string, unknown>();

let root: Root | undefined;
let box: HTMLDivElement;

const settings = {
  rootList: [
    { name: 'shop', dir: 'C:/shop/.swarmup', mirror: false, isMirror: false, isMaster: false },
    { name: 'web', dir: 'C:/web/.swarmup', mirror: false, isMirror: false, isMaster: false },
  ],
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  answers.clear();
  postAnswers.clear();
  gets.length = 0;
  posts.length = 0;
  answers.set('/api/settings', settings);
  const off = (): (() => void) => () => {};
  window.swarmup = {
    call: (method: string, path: string, body?: Record<string, unknown>) => {
      if (method !== 'GET') {
        posts.push({ path, body: body ?? {} });
        return Promise.resolve({ ok: true, data: postAnswers.get(path) ?? {} });
      }
      gets.push(path);
      if (!answers.has(path)) return Promise.resolve({ ok: false, error: `no answer for ${path}` });
      return Promise.resolve({ ok: true, data: answers.get(path) });
    },
    info: () => Promise.resolve({ me: 'human:dawid', pid: 1, roots: [] }),
    onService: off,
    onEvent: off,
    onStatus: off,
    onNavigate: off,
  } as unknown as NonNullable<Window['swarmup']>;
  box = document.createElement('div');
  document.body.append(box);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
  document.body.innerHTML = '';
  delete window.swarmup;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const nav = (): Nav => ({ me: 'human:dawid', openTask: vi.fn(), go: vi.fn() });

async function mount(selected?: string): Promise<void> {
  root = createRoot(box);
  await act(async () => root!.render(createElement(ProjectMap, { nav: nav(), selected })));
  await settle();
}

function button(label: string | RegExp): HTMLButtonElement {
  const b = [...document.body.querySelectorAll('button')].find((x) => {
    const t = x.textContent?.trim() ?? '';
    return typeof label === 'string' ? t === label : label.test(t);
  });
  if (!b) throw new Error(`no button '${String(label)}'`);
  return b;
}

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function type(el: HTMLInputElement, text: string): Promise<void> {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

const brief = (over: Partial<MapNodeBrief> & { id: string }): MapNodeBrief => ({
  file: `.swarmup/map/${over.id}.md`,
  kind: 'module',
  summary: `About ${over.id}`,
  covers: [],
  links: [],
  broken: [],
  size: 3,
  problems: [],
  ...over,
});

const nodes: MapNodeBrief[] = [
  brief({ id: 'index', kind: 'root', summary: 'A demo shop', links: ['core', 'docs'] }),
  brief({ id: 'core', summary: 'The cart and prices', covers: ['src/cart.ts'], links: ['docs'] }),
  brief({ id: 'core/tax', summary: 'Tax rules', covers: ['src/tax.ts'] }),
  brief({
    id: 'docs',
    kind: 'area',
    summary: 'User guides',
    covers: ['docs', 'https://example.com/help'],
    review_after: '2020-01-01',
  }),
];

const view: MapView = {
  root: 'shop',
  top: 'C:/shop',
  dir: 'C:/shop/.swarmup/map',
  exists: true,
  type: 'code',
  summary: 'A demo shop',
  kinds: ['area', 'module', 'root'],
  nodes,
};

const detail = (id: string, over: Partial<MapNodeView> = {}): MapNodeView => ({
  ...nodes.find((n) => n.id === id)!,
  body: `# ${id}\n\nThe **${id}** body.\n`,
  linksTo: [],
  linkedFrom: [],
  ...over,
});

const check: MapCheck = {
  ok: false,
  hasMap: true,
  errors: [
    { code: 'missing-link', node: 'core', message: '.swarmup/map/core.md: links to `gone`' },
    { code: 'uncovered', path: 'src/new.ts', message: 'src/new.ts changed but no node covers it' },
  ],
  warnings: [{ code: 'review-due', node: 'docs', message: 'past its review_after date' }],
  base: { ref: 'main', commit: '0123456789abcdef' },
  changed: 2,
  nodes: 4,
};

function withMap(): void {
  answers.set('/api/map?root=shop', view);
  answers.set('/api/map/node?root=shop&id=index', detail('index', { linksTo: [nodes[1]!] }));
  answers.set(
    '/api/map/node?root=shop&id=core',
    detail('core', { broken: ['gone'], linksTo: [nodes[3]!], linkedFrom: [nodes[0]!] }),
  );
  answers.set('/api/map/node?root=shop&id=docs', detail('docs'));
  postAnswers.set('/api/map/check', check);
  postAnswers.set('/api/map/index', { file: 'x', nodes: 4 });
}

describe('Map view without a map', () => {
  it('explains the map and creates one of the detected type', async () => {
    answers.set('/api/map?root=shop', {
      ...view,
      exists: false,
      dir: null,
      type: null,
      detected: 'website',
      summary: '',
      kinds: [],
      nodes: [],
    } satisfies MapView);
    postAnswers.set('/api/map/init', { type: 'website' });
    await mount();
    expect(box.textContent).toContain('No project map yet');
    expect(box.textContent).toContain('.swarmup/map/');
    expect(box.querySelector('[data-map-health]')).toBeNull();
    expect(posts).toEqual([]);
    // Next to the project picker, the type picker preselects the detected type.
    const typeSelect = [...box.querySelectorAll('select')].find((s) =>
      [...s.options].some((o) => o.value === 'website'),
    )!;
    expect(typeSelect.value).toBe('website');
    expect([...typeSelect.options].find((o) => o.value === 'website')!.textContent).toBe(
      'Website (detected)',
    );
    await click(button('Create map'));
    expect(posts).toEqual([{ path: '/api/map/init', body: { root: 'shop', type: 'website' } }]);
    expect(gets.filter((g) => g === '/api/map?root=shop')).toHaveLength(2);
  });
});

describe('Map view with a map', () => {
  it('shows the root summary, nodes by kind and the root node, and checks on open', async () => {
    withMap();
    await mount();
    expect(box.textContent).toContain('A demo shop');
    expect(box.textContent).toContain('C:/shop/.swarmup/map');
    const kinds = [...box.querySelectorAll('.label-caps')].map((e) => e.textContent);
    expect(kinds.slice(0, 3)).toEqual(['root1', 'area1', 'module2']);
    expect(box.querySelector('[data-map-detail]')?.getAttribute('data-map-detail')).toBe('index');
    // The check ran by itself and its result is the header's badge; the list stays hidden.
    expect(posts).toEqual([{ path: '/api/map/check', body: { root: 'shop' } }]);
    const badge = box.querySelector('[data-map-health]')!;
    expect(badge.getAttribute('data-map-health')).toBe('errors');
    expect(badge.textContent).toBe('2 errors');
    expect(box.querySelector('[data-map-check]')).toBeNull();
    // A node past its review date carries the marker in the list.
    expect(box.querySelector('[title="Review due"]')).not.toBeNull();
  });

  it('opens a node with its body, covers, links and back links, and follows a link chip', async () => {
    withMap();
    await mount();
    await click(button(/^coremoduleThe cart and prices$/));
    expect(gets).toContain('/api/map/node?root=shop&id=core');
    const pane = box.querySelector('[data-map-detail="core"]')!;
    expect(pane.querySelector('.md strong')?.textContent).toBe('core');
    expect(pane.textContent).toContain('src/cart.ts');
    expect(pane.textContent).toContain('Linked from');
    expect(pane.querySelector('[title="No node has this id"]')?.textContent).toBe('gone');
    await click([...pane.querySelectorAll('button')].find((b) => b.textContent === 'docs')!);
    const docs = box.querySelector('[data-map-detail="docs"]')!;
    expect(docs.textContent).toContain('Review due');
    const link = docs.querySelector<HTMLAnchorElement>('a[href="https://example.com/help"]');
    expect(link?.target).toBe('_blank');
  });

  it('lists the nodes as a tree by id path', async () => {
    withMap();
    await mount();
    await click(button('Tree'));
    const rows = [...box.querySelectorAll('[data-map-row]')].map(
      (b) => b.querySelector('.font-mono')?.textContent,
    );
    expect(rows).toEqual(['index (root)', 'core', 'tax', 'docs']);
  });

  it('searches by words, and by a file path for the nodes that cover it', async () => {
    withMap();
    answers.set('/api/map/search?root=shop&q=cart', [{ ...nodes[1]!, score: 6 }]);
    answers.set('/api/map/search?root=shop&file=src%2Ftax.ts', [nodes[2]]);
    answers.set('/api/map/search?root=shop&q=nothing', []);
    await mount();
    const input = box.querySelector<HTMLInputElement>(
      'input[placeholder="Words, or a file path"]',
    )!;
    await type(input, 'cart');
    expect(box.textContent).toContain('Nodes that match any word');
    let rows = [...box.querySelectorAll('[data-map-row]')];
    expect(rows.map((r) => r.querySelector('.font-mono')?.textContent)).toEqual(['core']);
    await type(input, 'src/tax.ts');
    expect(box.textContent).toContain('Nodes that cover this file');
    rows = [...box.querySelectorAll('[data-map-row]')];
    expect(rows.map((r) => r.querySelector('.font-mono')?.textContent)).toEqual(['core/tax']);
    await type(input, 'nothing');
    expect(box.textContent).toContain('No node matches these words.');
  });

  it('shows the check with the offending node or path, and opens the node', async () => {
    withMap();
    await mount();
    await click(button('Check'));
    const panel = box.querySelector('[data-map-check]')!;
    expect(panel.textContent).toContain('2 errors, 1 warning; 2 changed paths against main');
    expect(panel.querySelectorAll('[data-map-problem="error"]')).toHaveLength(2);
    expect(panel.querySelectorAll('[data-map-problem="warning"]')).toHaveLength(1);
    expect(panel.textContent).toContain('src/new.ts');
    // A base typed in the panel goes with the next run.
    await type(panel.querySelector<HTMLInputElement>('input')!, 'int/next');
    await click(button('Run again'));
    expect(posts.at(-1)).toEqual({
      path: '/api/map/check',
      body: { root: 'shop', base: 'int/next' },
    });
    await click([...panel.querySelectorAll('button')].find((b) => b.textContent === 'core')!);
    expect(box.querySelector('[data-map-detail="core"]')).not.toBeNull();
  });

  it('says the map is fine when the check finds nothing', async () => {
    withMap();
    postAnswers.set('/api/map/check', { ...check, ok: true, errors: [], warnings: [] });
    await mount();
    const badge = box.querySelector('[data-map-health]')!;
    expect(badge.getAttribute('data-map-health')).toBe('ok');
    await click(badge);
    expect(box.querySelector('[data-map-check]')?.textContent).toContain('No errors or warnings.');
  });

  it('rebuilds the index and checks again', async () => {
    withMap();
    await mount();
    posts.length = 0;
    await click(button('Rebuild index'));
    expect(posts.map((p) => p.path)).toEqual(['/api/map/index', '/api/map/check']);
    expect(posts[0]!.body).toEqual({ root: 'shop' });
  });

  it('draws the graph and opens a node from it', async () => {
    withMap();
    await mount();
    await click(button('Graph'));
    const svg = box.querySelector('svg[role="img"]')!;
    expect(svg.getAttribute('aria-label')).toBe('Map graph: 4 nodes, 3 links');
    await click(svg.querySelector('[data-map-node="docs"]')!);
    expect(box.querySelector('[data-map-detail="docs"]')).not.toBeNull();
  });

  it('reads the project the view was opened on, with a node', async () => {
    answers.set('/api/map?root=web', { ...view, root: 'web' });
    answers.set('/api/map/node?root=web&id=core', detail('core'));
    postAnswers.set('/api/map/check', check);
    await mount('web#core');
    expect(gets).toContain('/api/map?root=web');
    expect(box.querySelector('[data-map-detail="core"]')).not.toBeNull();
    expect(posts[0]).toEqual({ path: '/api/map/check', body: { root: 'web' } });
  });

  it('opens on the check list or the graph when the link asks for it', async () => {
    withMap();
    await mount('check:shop');
    expect(box.querySelector('[data-map-check]')?.textContent).toContain('2 errors, 1 warning');
    act(() => root?.unmount());
    root = undefined;
    await mount('graph:shop#docs');
    expect(box.querySelector('svg [data-map-node="docs"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

describe('map view helpers', () => {
  it('tells a file path from words and node ids', () => {
    expect(isPathQuery('src/cart.ts')).toBe(true);
    expect(isPathQuery('src\\cart')).toBe(true);
    expect(isPathQuery('package.json')).toBe(true);
    expect(isPathQuery('core/fold')).toBe(false);
    expect(isPathQuery('parser crash')).toBe(false);
    expect(isPathQuery('')).toBe(false);
  });

  it('marks a review due after its date, in local time', () => {
    expect(localDay(new Date(2026, 10, 3))).toBe('2026-11-03');
    expect(reviewDue({ review_after: '2026-11-02' }, '2026-11-03')).toBe(true);
    expect(reviewDue({ review_after: '2026-11-03' }, '2026-11-03')).toBe(false);
    expect(reviewDue({}, '2026-11-03')).toBe(false);
  });

  it('groups by kind with the root first and lays out a tree', () => {
    expect(byKind(nodes).map(([k, l]) => [k, l.length])).toEqual([
      ['root', 1],
      ['area', 1],
      ['module', 2],
    ]);
    expect(treeRows(nodes).map((r) => [r.label, r.depth])).toEqual([
      ['index', 0],
      ['core', 0],
      ['tax', 1],
      ['docs', 0],
    ]);
  });

  it('turns a check into a badge, errors first', () => {
    expect(healthOf(check)).toEqual({ health: 'errors', label: '2 errors' });
    expect(healthOf({ errors: [], warnings: check.warnings })).toEqual({
      health: 'warnings',
      label: '1 warning',
    });
    expect(healthOf({ errors: [], warnings: [] })).toEqual({ health: 'ok', label: 'Map OK' });
  });

  it('places the root in the middle and every node once', () => {
    const points = graphLayout(nodes, 600);
    expect(points.find((p) => p.id === 'index')).toEqual({ id: 'index', x: 300, y: 300 });
    expect(points.map((p) => p.id).sort()).toEqual(nodes.map((n) => n.id).sort());
  });
});
