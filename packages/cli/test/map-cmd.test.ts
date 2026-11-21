import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function folder(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-map-cli-'));
  dirs.push(d);
  return d;
}

function write(top: string, rel: string, text: string): void {
  const file = join(top, ...rel.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function cli(cwd: string, ...argv: string[]): { code: number; out: string } {
  const out: string[] = [];
  const code = run(argv, {
    out: (l) => out.push(l),
    err: (l) => out.push(l),
    env: { ...process.env, SWARMUP_CONFIG: join(cwd, 'none.yml') },
    cwd,
  });
  if (typeof code !== 'number') throw new Error('map commands are synchronous');
  return { code, out: out.join('\n') };
}

describe('swarmup map', () => {
  it('says a folder has no map and checks nothing', () => {
    const dir = folder();
    expect(cli(dir, 'map')).toMatchObject({
      code: 0,
      out: expect.stringMatching(/no project map/),
    });
    expect(cli(dir, 'map', 'check')).toMatchObject({ code: 0 });
  });

  it('starts a map, then searches, shows, indexes and checks it', () => {
    const dir = folder();
    write(dir, 'brief.md', '# Brief\n');
    const init = cli(dir, 'map', 'init');
    expect(init.code).toBe(0);
    expect(init.out).toMatch(/\(campaign, detected\)/);
    expect(existsSync(join(dir, '.swarmup', 'map', '_INDEX.md'))).toBe(true);
    expect(cli(dir, 'map', 'init').code).toBe(1);

    write(
      dir,
      '.swarmup/map/launch.md',
      "---\nkind: campaign\nsummary: 'Spring launch'\ncovers: [brief.md]\nlinks: ['/']\n---\n\nGoal.\n",
    );
    expect(cli(dir, 'map', 'check').out).toMatch(/_INDEX.md is out of date/);
    expect(cli(dir, 'map', 'index').out).toMatch(/2 nodes/);
    expect(cli(dir, 'map', 'check')).toMatchObject({ code: 0 });
    expect(cli(dir, 'map', 'spring').out).toBe('`launch` — campaign — Spring launch');
    expect(cli(dir, 'map', '--file', 'brief.md').out).toBe('`launch` — campaign — Spring launch');
    const show = cli(dir, 'map', 'show', 'launch');
    expect(show.out).toContain('.swarmup/map/launch.md');
    expect(show.out).toMatch(/Links:\n- `index` — root/);
    const json = JSON.parse(cli(dir, 'map', 'check', '--json').out) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(cli(dir, 'map', 'init', '--cwd', folder(), '--type', 'blog').code).toBe(2);
  });
});
