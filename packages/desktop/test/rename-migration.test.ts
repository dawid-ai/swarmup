// AO-0200: an Agent Ops install that updates to SwarmUp keeps its views, window state and
// sign-in folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateUserData } from '../src/migrate';
import { cwdFromCommand, loginArgs } from '../src/service';
import { boardShowsIdeas, loadViews, OLD_IDEAS_KEY, OLD_VIEWS_KEY } from '../ui/src/lib/filters';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `%APPDATA%` with an Agent Ops user data folder in it. */
function appData(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-userdata-'));
  dirs.push(d);
  const old = join(d, 'Agent Ops');
  mkdirSync(join(old, 'Local Storage', 'leveldb'), { recursive: true });
  writeFileSync(join(old, 'Local Storage', 'leveldb', '000003.log'), 'saved views');
  writeFileSync(join(old, 'Preferences'), '{"zoom":1}');
  writeFileSync(join(old, 'relaunch.json'), '{"background":true}');
  writeFileSync(join(old, 'Local State'), '{}');
  mkdirSync(join(old, 'Code Cache'));
  writeFileSync(join(old, 'Code Cache', 'big'), 'cache');
  return d;
}

describe('desktop user data', () => {
  it('copies the Agent Ops folder once, without caches, and keeps the old one', () => {
    const d = appData();
    const lines: string[] = [];
    expect(migrateUserData(d, (l) => lines.push(l))).toBe(join(d, 'SwarmUp'));
    const to = join(d, 'SwarmUp');
    expect(readFileSync(join(to, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe(
      'saved views',
    );
    expect(readFileSync(join(to, 'Preferences'), 'utf8')).toBe('{"zoom":1}');
    expect(existsSync(join(to, 'relaunch.json'))).toBe(true);
    expect(existsSync(join(to, 'Code Cache'))).toBe(false);
    expect(existsSync(join(d, 'Agent Ops', 'Preferences'))).toBe(true);
    expect(lines).toHaveLength(1);
    // Already migrated: a later change in the old folder is not copied again.
    writeFileSync(join(d, 'Agent Ops', 'Preferences'), '{"zoom":2}');
    expect(migrateUserData(d, (l) => lines.push(l))).toBe(to);
    expect(readFileSync(join(to, 'Preferences'), 'utf8')).toBe('{"zoom":1}');
    expect(lines).toHaveLength(1);
  });

  it('copies into a SwarmUp folder that holds only the user config (one folder on Windows)', () => {
    const d = appData();
    mkdirSync(join(d, 'SwarmUp'));
    writeFileSync(join(d, 'SwarmUp', 'config.yml'), 'me: human:dawid\n');
    migrateUserData(d);
    expect(readFileSync(join(d, 'SwarmUp', 'config.yml'), 'utf8')).toBe('me: human:dawid\n');
    expect(existsSync(join(d, 'SwarmUp', 'Local State'))).toBe(true);
  });

  it('starts fresh without an Agent Ops folder', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarmup-userdata-'));
    dirs.push(d);
    expect(migrateUserData(d)).toBe(join(d, 'SwarmUp'));
    expect(existsSync(join(d, 'SwarmUp'))).toBe(false);
  });
});

describe('sign-in entry', () => {
  it('reads the swarmupd folder back from an Agent Ops entry', () => {
    const plain = loginArgs({ packaged: true, appPath: '', cwd: 'C:\\dev\\agent-ops' });
    expect(cwdFromCommand(['"C:\\A\\Agent Ops.exe"', ...plain].join(' '))).toBe(
      'C:\\dev\\agent-ops',
    );
    const spaced = loginArgs({ packaged: true, appPath: '', cwd: 'C:\\My work\\repo' });
    expect(cwdFromCommand(['"C:\\A\\Agent Ops.exe"', ...spaced].join(' '))).toBe(
      'C:\\My work\\repo',
    );
    expect(cwdFromCommand('"C:\\A\\Agent Ops.exe" --background')).toBeUndefined();
  });
});

describe('saved views and board ideas', () => {
  it('reads the Agent Ops keys until the SwarmUp ones are written', () => {
    const views = JSON.stringify([{ name: 'Mine', view: 'board', filter: { mine: true } }]);
    const old = new Map([
      [OLD_VIEWS_KEY, views],
      [OLD_IDEAS_KEY, 'on'],
    ]);
    const storage = { getItem: (k: string) => old.get(k) ?? null };
    expect(loadViews(storage).map((v) => v.name)).toEqual(['Mine']);
    expect(boardShowsIdeas(storage)).toBe(true);
    // A newer value under the new key wins.
    old.set('swarmup.board-ideas', 'off');
    old.set('swarmup.saved-views', '[]');
    expect(boardShowsIdeas(storage)).toBe(false);
    expect(loadViews(storage)).toEqual([]);
  });
});
