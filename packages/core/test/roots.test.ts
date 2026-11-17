// Archive, label, relocate and remove a project in the user config (AO-0353).
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  addRootToUserConfig,
  archiveRoot,
  discoverRoots,
  initRoot,
  labelRoot,
  listRoots,
  readUserConfig,
  relocateRoot,
  removeRoot,
  Workspace,
} from '../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(): {
  base: string;
  file: string;
  env: NodeJS.ProcessEnv;
  shop: string;
  blog: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'swarmup-roots-'));
  dirs.push(base);
  const file = join(base, 'config.yml');
  writeFileSync(
    file,
    ['# my machine', 'me: human:dawid', 'swarmupd:', '  max_runs: 3 # low', ''].join('\n'),
  );
  const env = { SWARMUP_CONFIG: file };
  const shop = join(base, 'shop');
  const blog = join(base, 'blog');
  initRoot(shop, { name: 'shop', prefix: 'S' });
  initRoot(blog, { name: 'blog', prefix: 'B' });
  addRootToUserConfig(env, shop);
  addRootToUserConfig(env, blog);
  return { base, file, env, shop, blog };
}

/** The root names a reader loads, from a folder outside every root. */
function loaded(env: NodeJS.ProcessEnv, cwd: string): string[] {
  return new Workspace({ env, cwd }).roots.map((r) => r.name);
}

describe('archiveRoot', () => {
  it('keeps an archived root listed but out of every reader, until unarchived', () => {
    const { base, file, env, shop } = setup();
    expect(loaded(env, base)).toEqual(['shop', 'blog']);
    expect(archiveRoot(env, join(shop, '.swarmup'), true)).toMatchObject({
      root: shop,
      name: 'shop',
      archived: true,
    });
    expect(readUserConfig(env).roots).toEqual([shop, join(base, 'blog')]);
    expect(loaded(env, base)).toEqual(['blog']);
    // From inside the archived repo too: swarmupd may run there.
    expect(loaded(env, shop)).toEqual(['blog']);
    // A daemon or manual caller cannot use an inherited SWARMUP_ROOTS to bypass the archive.
    expect(discoverRoots(base, { ...env, SWARMUP_ROOTS: shop })).toHaveLength(0);
    // A supervised run gets its roots in SWARMUP_ROOTS and keeps them until it finishes.
    expect(discoverRoots(base, { ...env, SWARMUP_ROOTS: shop, SWARMUP_RUN: 'run' })).toHaveLength(
      1,
    );
    // Comments and other settings stay.
    expect(readFileSync(file, 'utf8')).toContain('max_runs: 3 # low');

    archiveRoot(env, shop, false);
    expect(loaded(env, base)).toEqual(['shop', 'blog']);
    // Nothing is left behind once the last option goes.
    expect(readFileSync(file, 'utf8')).not.toContain('root_options');
  });

  it('keeps the Master Repo mirror off the board when the archived folder is gone', () => {
    const { base, file, env, shop } = setup();
    const hub = join(base, 'hub');
    initRoot(hub, { name: 'hub', prefix: 'H' });
    // The hub holds a mirror of shop, as a mirrored project's sync leaves it.
    cpSync(join(shop, '.swarmup'), join(hub, '.swarmup', 'mirrors', 'shop'), { recursive: true });
    const user = YAML.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, YAML.stringify({ ...user, master: hub }));

    archiveRoot(env, shop, true);
    expect(readUserConfig(env).root_options?.[shop]).toEqual({ archived: true, name: 'shop' });
    expect(loaded(env, base)).toEqual(['blog', 'hub']);

    // The folder goes missing: the recorded name still hides the mirror and keeps the label.
    rmSync(shop, { recursive: true, force: true });
    expect(loaded(env, base)).toEqual(['blog', 'hub']);
    expect(listRoots(env)[0]).toMatchObject({ root: shop, found: false, name: 'shop' });
    // Archiving again while it is gone keeps the recorded name.
    archiveRoot(env, shop, true);
    expect(loaded(env, base)).toEqual(['blog', 'hub']);

    // Unarchived, the mirror shows the project this machine no longer has.
    archiveRoot(env, shop, false);
    expect(readUserConfig(env).root_options).toBeUndefined();
    expect(discoverRoots(base, env)).toContain(join(hub, '.swarmup', 'mirrors', 'shop'));
  });

  it('refuses a folder the user config does not list', () => {
    const { base, env } = setup();
    expect(() => archiveRoot(env, join(base, 'nope'), true)).toThrow(
      /not in the user config's roots/,
    );
  });
});

describe('labelRoot', () => {
  it('sets and clears the shown name, never the root id', () => {
    const { env, shop } = setup();
    expect(labelRoot(env, shop, '  Web shop ')).toMatchObject({ name: 'shop', label: 'Web shop' });
    expect(readFileSync(join(shop, '.swarmup', 'config.yml'), 'utf8')).toContain('name: shop');
    expect(labelRoot(env, shop, null)).toMatchObject({ label: 'shop' });
    expect(() => labelRoot(env, shop, 'a\nb')).toThrow(/one line/);
  });
});

describe('relocateRoot', () => {
  it('points the entry at another data root, keeping its place and options', () => {
    const { base, env, shop, blog } = setup();
    archiveRoot(env, shop, true);
    labelRoot(env, shop, 'Web shop');
    const moved = join(base, 'shop-moved');
    initRoot(moved, { name: 'shop', prefix: 'S' });
    expect(relocateRoot(env, shop, moved)).toMatchObject({
      root: moved,
      label: 'Web shop',
      archived: true,
    });
    expect(readUserConfig(env).roots).toEqual([moved, blog]);
    expect(listRoots(env).map((r) => r.root)).toEqual([moved, blog]);
    // The old folder is untouched.
    expect(existsSync(join(shop, '.swarmup', 'config.yml'))).toBe(true);
  });

  it('refuses a folder without a data root, or one listed already', () => {
    const { base, file, env, shop, blog } = setup();
    const before = readFileSync(file, 'utf8');
    expect(() => relocateRoot(env, shop, base)).toThrow(/is not a data root/);
    expect(() => relocateRoot(env, shop, blog)).toThrow(/in the user config's roots already/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fixes an entry whose folder is gone', () => {
    const { base, env, shop } = setup();
    const moved = join(base, 'elsewhere');
    initRoot(moved, { name: 'shop', prefix: 'S' });
    rmSync(shop, { recursive: true, force: true });
    expect(listRoots(env)[0]).toMatchObject({ root: shop, found: false, name: null });
    expect(relocateRoot(env, shop, moved)).toMatchObject({ found: true, name: 'shop' });
  });
});

describe('removeRoot', () => {
  it('drops only the entry; the folder and its files stay on disk', () => {
    const { env, shop, blog } = setup();
    archiveRoot(env, shop, true);
    const ws = new Workspace({ env, cwd: blog, actor: 'human:dawid' });
    ws.newTask(
      { title: 'Keep me' },
      ws.roots.find((r) => r.name === 'blog'),
    );
    const filesBefore = readdirSync(join(blog, '.swarmup'), { recursive: true }).sort();
    expect(removeRoot(env, blog).map((r) => r.root)).toEqual([shop]);
    expect(removeRoot(env, shop)).toEqual([]);
    const user = YAML.parse(readFileSync(env.SWARMUP_CONFIG!, 'utf8')) as Record<string, unknown>;
    expect(user.roots).toEqual([]);
    expect(user.root_options).toBeUndefined();
    expect(readdirSync(join(blog, '.swarmup'), { recursive: true }).sort()).toEqual(filesBefore);
    expect(existsSync(join(shop, '.swarmup', 'config.yml'))).toBe(true);
  });
});
