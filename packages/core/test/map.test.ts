import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkMap,
  checkMapAsync,
  coverMatcher,
  detectMapType,
  detectMapTypeAsync,
  findNode,
  ignoreMatcher,
  initMap,
  MAP_DEFAULT_IGNORE,
  mapIndexText,
  mapNodesFor,
  mapPromptLines,
  mapPromptOf,
  mapReviewWarnings,
  nodeIdOf,
  nodeNeighbours,
  nodesCovering,
  parseKinds,
  parseNode,
  pathInProject,
  readMap,
  searchMap,
  writeMapIndex,
} from '../src/index.js';
import { git, tempDir } from './helpers.js';

function write(top: string, rel: string, text: string): void {
  const file = join(top, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function node(fm: Record<string, string | string[]>, body = 'Purpose.\n'): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}:`, ...v.map((x) => `  - '${x}'`));
    else lines.push(`${k}: '${v}'`);
  }
  return `${lines.join('\n')}\n---\n\n${body}`;
}

/** A small project with a map: a root, a module node and a folder node with a child. */
function project(): string {
  const top = tempDir();
  write(top, 'src/a.ts', 'export const a = 1;\n');
  write(top, 'src/b/c.ts', 'export const c = 1;\n');
  write(top, 'docs/guide.md', '# Guide\n');
  write(top, '.swarmup/map/index.md', node({ kind: 'root', summary: 'A demo project' }));
  write(
    top,
    '.swarmup/map/core.md',
    node({ kind: 'module', summary: 'The core parser', covers: ['src/a.ts'], links: ['docs'] }),
  );
  write(
    top,
    '.swarmup/map/docs/index.md',
    node({ kind: 'area', summary: 'User guides', covers: ['docs/**/*.md'], links: ['/core'] }),
  );
  write(
    top,
    '.swarmup/map/docs/b.md',
    node({ kind: 'module', summary: 'Folder b code', covers: ['src/b'], links: ['../core'] }),
  );
  return top;
}

function repo(top: string): void {
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 'test@example.com');
  git(top, 'config', 'user.name', 'Test');
  git(top, 'config', 'core.autocrlf', 'false');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'start');
}

describe('map nodes', () => {
  it('reads frontmatter, ids and body lines', () => {
    const n = parseNode(
      'core/index.md',
      node({ kind: 'module', summary: 'S', covers: ['a#top'], links: ['x'] }, 'one\ntwo\n\n'),
    );
    expect(n).toMatchObject({ id: 'core', kind: 'module', summary: 'S', covers: ['a#top'] });
    expect(n.bodyLines).toBe(2);
    expect(n.problems).toEqual([]);
    expect(nodeIdOf('index.md')).toBe('index');
    expect(nodeIdOf('a\\b.md')).toBe('a/b');
  });

  it('reports missing fields, wrong types and bad dates', () => {
    const n = parseNode('x.md', '---\ncovers: 3\nreview_after: soon\n---\nbody\n');
    expect(n.problems).toEqual([
      'no `kind`',
      'no `summary`',
      '`review_after` must be a date such as 2026-12-01',
      '`covers` must be a list of strings',
    ]);
  });

  it('reads extra kinds as a list or a map', () => {
    expect(parseKinds('- press\n- event\n')).toEqual(['press', 'event']);
    expect(parseKinds('press: coverage\nevent: talks\n')).toEqual(['press', 'event']);
  });
});

describe('covers and ignore patterns', () => {
  it('matches files, folders, globs and anchors with either separator', () => {
    expect(coverMatcher('src/a.ts')('src/a.ts')).toBe(true);
    expect(coverMatcher('src/a.ts#parse')('src\\a.ts')).toBe(true);
    expect(coverMatcher('src/b')('src/b/c.ts')).toBe(true);
    expect(coverMatcher('src/b/')('src\\b\\c.ts')).toBe(true);
    expect(coverMatcher('src/b')('src/bc.ts')).toBe(false);
    expect(coverMatcher('./src/*.ts')('src/a.ts')).toBe(true);
    expect(coverMatcher('src/*.ts')('src/b/c.ts')).toBe(false);
    expect(coverMatcher('src/**/*.ts')('src/b/c.ts')).toBe(true);
    expect(coverMatcher('src/**/*.ts')('src/a.ts')).toBe(true);
    expect(coverMatcher('packages/*/test')('packages/core/test/x.test.ts')).toBe(true);
    expect(coverMatcher('src\\b\\*.ts')('src/b/c.ts')).toBe(true);
    expect(coverMatcher('https://example.com/a')('https://example.com/a')).toBe(false);
  });

  it('ignores like gitignore: names anywhere, anchored paths, negation', () => {
    const ignored = ignoreMatcher([...MAP_DEFAULT_IGNORE, '/notes/', '*.log', '!keep.log']);
    expect(ignored('pnpm-lock.yaml')).toBe(true);
    expect(ignored('packages/x/dist/a.js')).toBe(true);
    expect(ignored('a\\node_modules\\b.js')).toBe(true);
    expect(ignored('.swarmup/tasks/T-1/task.md')).toBe(true);
    expect(ignored('notes/a.md')).toBe(true);
    expect(ignored('src/notes/a.md')).toBe(false);
    expect(ignored('src/x.log')).toBe(true);
    expect(ignored('src/keep.log')).toBe(false);
    expect(ignored('src/a.ts')).toBe(false);
  });
});

describe('readMap, links and search', () => {
  it('lists nodes root first and resolves links relative, from the top and up', () => {
    const map = readMap(project())!;
    expect(map.nodes.map((n) => n.id)).toEqual(['index', 'core', 'docs', 'docs/b']);
    const docs = findNode(map, 'docs');
    expect(nodeNeighbours(map, docs).links.map((n) => n.id)).toEqual(['core']);
    expect(nodeNeighbours(map, findNode(map, 'core')).from.map((n) => n.id)).toEqual([
      'docs',
      'docs/b',
    ]);
    expect(findNode(map, 'b').id).toBe('docs/b');
    expect(findNode(map, '.swarmup/map/docs/b.md').id).toBe('docs/b');
    expect(() => findNode(map, 'nope')).toThrow(/no map node/);
  });

  it('finds the nodes that cover a file', () => {
    const top = project();
    const map = readMap(top)!;
    expect(nodesCovering(map, 'src/b/c.ts').map((n) => n.id)).toEqual(['docs/b']);
    const abs = join(top, 'docs', 'guide.md');
    expect(pathInProject(top, join(top, 'src'), abs)).toBe('docs/guide.md');
    expect(pathInProject(top, join(top, 'src'), '..\\docs\\guide.md')).toBe('docs/guide.md');
  });

  it('ranks search hits by id, then summary, covers and body', () => {
    const map = readMap(project())!;
    expect(searchMap(map, ['core']).map((h) => h.node.id)).toEqual(['core']);
    // An id hit outranks a summary hit, which outranks a kind or covers hit.
    expect(searchMap(map, ['docs', 'folder']).map((h) => h.node.id)).toEqual(['docs/b', 'docs']);
    expect(searchMap(map, ['module']).map((h) => h.node.id)).toEqual(['core', 'docs/b']);
    expect(searchMap(map, ['guides']).map((h) => h.node.id)).toEqual(['docs']);
    expect(searchMap(map, ['zzz'])).toEqual([]);
    expect(searchMap(map, [])).toHaveLength(4);
  });
});

describe('_INDEX.md', () => {
  it('has one line per node and goes stale when a node changes', () => {
    const top = project();
    const map = readMap(top)!;
    expect(mapIndexText(map)).toContain('- `core` — module — The core parser\n');
    expect(mapIndexText(map)).toMatch(/Generated by `swarmup map index`/);
    writeMapIndex(map);
    expect(checkMap(top, { changes: [] }).errors).toEqual([]);
    // A formatter's CRLF and trailing blanks do not make it stale.
    const file = join(top, '.swarmup', 'map', '_INDEX.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\n/g, '  \r\n'));
    expect(checkMap(top, { changes: [] }).errors).toEqual([]);
    write(
      top,
      '.swarmup/map/core.md',
      node({ kind: 'module', summary: 'Changed', covers: ['src/a.ts'] }),
    );
    expect(checkMap(top, { changes: [] }).errors.map((e) => e.code)).toEqual(['stale-index']);
  });
});

describe('checkMap', () => {
  it('says the project has no map when it has none', () => {
    expect(checkMap(tempDir())).toMatchObject({ hasMap: false, errors: [] });
  });

  it('finds broken links, empty covers, size limits, unknown kinds and URL nodes', () => {
    const top = project();
    write(
      top,
      '.swarmup/map/bad.md',
      node(
        {
          kind: 'widget',
          summary: 'x'.repeat(121),
          covers: ['src/missing.ts', 'lib/**/*.py', 'https://example.com/pricing'],
          links: ['nowhere'],
        },
        'line\n'.repeat(61),
      ),
    );
    write(
      top,
      '.swarmup/map/web.md',
      node({
        kind: 'page',
        summary: 'Pricing',
        covers: ['https://example.com'],
        review_after: '2026-01-01',
      }),
    );
    writeMapIndex(readMap(top)!);
    const res = checkMap(top, { changes: [], today: '2026-11-21' });
    expect(res.errors.map((e) => e.code).sort()).toEqual([
      'covers-nothing',
      'covers-nothing',
      'missing-link',
      'no-review-after',
      'too-long',
      'too-long',
      'unknown-kind',
    ]);
    expect(res.warnings.map((w) => w.code)).toEqual(['review-due']);
    write(top, '.swarmup/map/kinds.yml', '- widget\n');
    expect(checkMap(top, { changes: [] }).errors.map((e) => e.code)).not.toContain('unknown-kind');
  });

  it('limits the root body to 40 lines', () => {
    const top = project();
    write(
      top,
      '.swarmup/map/index.md',
      node({ kind: 'root', summary: 'A demo project' }, 'x\n'.repeat(41)),
    );
    writeMapIndex(readMap(top)!);
    expect(checkMap(top, { changes: [] }).errors.map((e) => e.message)).toEqual([
      '.swarmup/map/index.md: body has 41 lines, over 40; split it into linked nodes',
    ]);
  });

  it('checks a git change: uncovered paths fail, covered ones warn until the node changes', () => {
    const top = project();
    write(top, '.swarmup/map/ignore', '# generated\nsrc/gen/\n');
    writeMapIndex(readMap(top)!);
    repo(top);
    git(top, 'checkout', '-q', '-b', 'work');
    write(top, 'src/a.ts', 'export const a = 2;\n');
    write(top, 'src/new.ts', 'x\n');
    write(top, 'src/gen/out.ts', 'x\n');
    write(top, 'pnpm-lock.yaml', 'x\n');
    git(top, 'add', '-A');
    git(top, 'commit', '-q', '-m', 'work');
    write(top, 'src/b/c.ts', 'export const c = 2;\n'); // uncommitted
    const res = checkMap(top);
    expect(res.base?.ref).toBe('main');
    expect(res.errors.map((e) => e.path)).toEqual(['src/new.ts']);
    expect(res.warnings.map((w) => w.node).sort()).toEqual(['core', 'docs/b']);

    write(
      top,
      '.swarmup/map/core.md',
      node({
        kind: 'module',
        summary: 'The core parser',
        covers: ['src/a.ts', 'src/new.ts'],
        links: ['docs'],
      }),
    );
    writeMapIndex(readMap(top)!);
    const after = checkMap(top, { base: 'main' });
    expect(after.errors).toEqual([]);
    expect(after.warnings.map((w) => w.node)).toEqual(['docs/b']);
    expect(() => checkMap(top, { base: 'no-such-branch' })).toThrow(/no merge base/);
  });

  it('checks the same with git off the event loop', async () => {
    const top = project();
    writeMapIndex(readMap(top)!);
    repo(top);
    git(top, 'checkout', '-q', '-b', 'work');
    write(top, 'src/a.ts', 'export const a = 2;\n');
    write(top, 'src/new.ts', 'x\n');
    const res = await checkMapAsync(top);
    expect(res).toEqual(checkMap(top));
    expect(res.base?.ref).toBe('main');
    expect(res.errors.map((e) => e.path)).toEqual(['src/new.ts']);
    expect(res.warnings.map((w) => w.node)).toEqual(['core']);
    await expect(checkMapAsync(top, { base: 'no-such-branch' })).rejects.toThrow(/no merge base/);
    expect(await detectMapTypeAsync(top)).toBe(detectMapType(top));
    expect((await checkMapAsync(tempDir())).hasMap).toBe(false);
  });

  it('warns on a reviewed commit against the checkout map', () => {
    const top = project();
    writeMapIndex(readMap(top)!);
    repo(top);
    git(top, 'checkout', '-q', '-b', 'work');
    write(top, 'src/a.ts', 'export const a = 3;\n');
    git(top, 'commit', '-q', '-am', 'work');
    const commit = git(top, 'rev-parse', 'HEAD').trim();
    git(top, 'checkout', '-q', 'main');
    expect(mapReviewWarnings(top, commit, 'main')).toEqual([
      '.swarmup/map/core.md: src/a.ts changed but the node did not; is it still true?',
    ]);
    expect(mapReviewWarnings(top, 'no-such-commit', 'main')).toEqual([]);
  });
});

describe('run prompt block', () => {
  it('picks nodes by files first, then by task title words', () => {
    const map = readMap(project())!;
    expect(mapNodesFor(map, { title: 'Fix the parser crash' }).map((n) => n.id)).toEqual(['core']);
    expect(mapNodesFor(map, { title: 'Reword', files: ['src/b/c.ts'] }).map((n) => n.id)).toEqual([
      'docs/b',
    ]);
    expect(mapNodesFor(map, { title: 'Unrelated words here' })).toEqual([]);
  });

  it('writes a work, review and read block', () => {
    const top = project();
    const m = mapPromptOf(top, { title: 'Parser speed' })!;
    expect(m.root).toBe('A demo project');
    const work = mapPromptLines(m).join('\n');
    expect(work).toContain('Project map (`.swarmup/map/`): A demo project');
    expect(work).toContain('- `core` (module): The core parser');
    expect(work).toContain(
      'run `swarmup map index` and `swarmup map check` before you ask for review',
    );
    const review = mapPromptLines({ ...m, warnings: ['w1'] }, 'review').join('\n');
    expect(review).toContain('made any map node wrong');
    expect(review).toContain('- w1');
    expect(review).not.toContain('before you ask for review');
    expect(mapPromptLines(m, 'read').join('\n')).not.toMatch(/Keep them true|map node wrong/);
    expect(mapPromptOf(tempDir(), { title: 'x' })).toBeNull();
  });
});

describe('initMap', () => {
  it('scaffolds the root, ignore, README and INDEX, and refuses a second time', () => {
    const top = tempDir();
    write(top, 'package.json', '{}');
    write(top, 'src/main.ts', 'x\n');
    const res = initMap(top);
    expect(res.type).toBe('code');
    const map = readMap(top)!;
    expect(map.nodes.map((n) => [n.id, n.kind, n.type])).toEqual([['index', 'root', 'code']]);
    expect(checkMap(top, { changes: [] }).errors).toEqual([]);
    expect(() => initMap(top)).toThrow(/exists already/);
  });

  it('detects websites and content folders', () => {
    const site = tempDir();
    write(site, 'index.html', '<p>x</p>');
    write(site, 'about.html', '<p>x</p>');
    expect(detectMapType(site)).toBe('website');
    expect(detectMapType(tempDir(), { stacks: ['node'], frameworks: ['astro'] })).toBe('website');
    const content = tempDir();
    write(content, 'brief.md', '# Brief\n');
    expect(detectMapType(content)).toBe('campaign');
  });
});
