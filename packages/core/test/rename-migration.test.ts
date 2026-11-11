// AO-0200: data written before the rename to SwarmUp keeps working, and each migration runs once.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRoot,
  discoverRoots,
  findRootUp,
  initRoot,
  migrateUserConfig,
  MIGRATION_LOG,
  moveStore,
  readRootConfig,
  Root,
  rootDirOf,
  samePath,
  STORE_MOVE_MESSAGE,
  storeDirIn,
  syncRoot,
  Workspace,
} from '../src/index.js';
import { git, GIT_TEST_TIMEOUT, gitRepo, tempDir, turn } from './helpers.js';

/** A repo whose store was made before the rename: `.agent-ops/` with `agent_ops: 2`. */
function oldStoreRepo(): string {
  const repo = gitRepo();
  const dir = initRoot(repo, { name: 'legacy', human: 'human:dawid' });
  const old = join(repo, '.agent-ops');
  renameSync(dir, old);
  const cfg = join(old, 'config.yml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('swarmup: 2', 'agent_ops: 2'));
  return repo;
}

describe('store folder', () => {
  it('reads an old .agent-ops/ store with agent_ops: 2 when there is no .swarmup/', () => {
    const repo = oldStoreRepo();
    expect(storeDirIn(repo)).toBe(join(repo, '.agent-ops'));
    expect(readRootConfig(join(repo, '.agent-ops')).name).toBe('legacy');
    expect(samePath(findRootUp(join(repo, 'src'))!, join(repo, '.agent-ops'))).toBe(true);
    expect(checkRoot(repo)).toBe(repo);
    expect(rootDirOf(repo)).toBe(join(repo, '.agent-ops'));
  });

  it('makes new stores as .swarmup/ with swarmup: 2', () => {
    const repo = gitRepo();
    const dir = initRoot(repo, { name: 'fresh' });
    expect(dir).toBe(join(repo, '.swarmup'));
    expect(readFileSync(join(dir, 'config.yml'), 'utf8')).toMatch(/^swarmup: 2$/m);
    expect(() => initRoot(oldStoreRepo())).toThrow(/swarmup migrate/);
  });

  it('refuses a repo with both stores and never merges them', () => {
    const repo = oldStoreRepo();
    mkdirSync(join(repo, '.swarmup'));
    writeFileSync(join(repo, '.swarmup', 'config.yml'), 'swarmup: 2\nname: second\n');
    const before = readFileSync(join(repo, '.agent-ops', 'config.yml'), 'utf8');
    expect(() => storeDirIn(repo)).toThrow(/two task stores/);
    expect(() => findRootUp(repo)).toThrow(/two task stores/);
    expect(() => moveStore(repo)).toThrow(/two task stores/);
    expect(readFileSync(join(repo, '.agent-ops', 'config.yml'), 'utf8')).toBe(before);
    expect(existsSync(join(repo, '.swarmup', 'config.yml'))).toBe(true);
  });
});

describe('swarmup migrate (moveStore)', () => {
  it('moves the store, commits the move as a store commit, and is a no-op the second time', () => {
    const repo = oldStoreRepo();
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    const ws = new Workspace({ cwd: repo, env: {}, actor: 'human:dawid', user: {} });
    const id = ws.addTask({ title: 'Kept across the move' }).meta.id;
    // Local state that is never committed: a claim token and the learned store branch.
    mkdirSync(join(repo, '.agent-ops', '.ops'), { recursive: true });
    writeFileSync(join(repo, '.agent-ops', '.ops', 'marker'), 'local\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'ops: 1 change(s)');
    const logDir = tempDir();
    const env = { SWARMUP_CONFIG: join(logDir, 'config.yml') } as NodeJS.ProcessEnv;

    const moved = moveStore(repo, env)!;
    expect(moved.to).toBe(join(repo, '.swarmup'));
    expect(existsSync(join(repo, '.agent-ops'))).toBe(false);
    expect(readFileSync(join(repo, '.swarmup', '.ops', 'marker'), 'utf8')).toBe('local\n');
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe(STORE_MOVE_MESSAGE);
    expect(git(repo, 'status', '--porcelain').trim()).toBe('');
    expect(git(repo, 'ls-files', '--', '.agent-ops').trim()).toBe('');
    // Every task survives under the new folder, and the old config key still reads.
    const after = new Workspace({ cwd: repo, env: {}, actor: 'human:dawid', user: {} });
    expect(samePath(after.defaultRoot().dir, join(repo, '.swarmup'))).toBe(true);
    expect(after.defaultRoot().readTask(id).meta.title).toBe('Kept across the move');
    expect(readFileSync(join(logDir, MIGRATION_LOG), 'utf8')).toMatch(/store: moved .* in commit/);

    expect(moveStore(repo, env)).toBeNull();
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe(STORE_MOVE_MESSAGE);
  });

  it('refuses while store changes are uncommitted, changing nothing', () => {
    const repo = oldStoreRepo();
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(join(repo, '.agent-ops', 'kb', 'new.md'), 'not committed\n');
    expect(() => moveStore(repo)).toThrow(/uncommitted change/);
    expect(existsSync(join(repo, '.agent-ops', 'config.yml'))).toBe(true);
    expect(existsSync(join(repo, '.swarmup'))).toBe(false);
  });

  it('moves an untracked store without a commit', () => {
    const repo = oldStoreRepo();
    const moved = moveStore(repo, {})!;
    expect(moved.commit).toBeNull();
    expect(existsSync(join(repo, '.swarmup', 'config.yml'))).toBe(true);
  });

  it(
    'lets another clone pull the move, keeping its unpushed events and local state',
    async () => {
      const remote = tempDir();
      git(remote, 'init', '-q', '--bare', '-b', 'main');
      const a = oldStoreRepo();
      git(a, 'add', '-A');
      git(a, 'commit', '-q', '-m', 'init');
      git(a, 'remote', 'add', 'origin', remote);
      git(a, 'push', '-q', '-u', 'origin', 'main');
      const b = tempDir();
      git(b, 'clone', '-q', remote, '.');
      git(b, 'config', 'user.name', 'Test');
      git(b, 'config', 'user.email', 'test@example.invalid');
      const env = { SWARMUP_CONFIG: join(a, 'none.yml') } as NodeJS.ProcessEnv;

      // b files a task and keeps local state, before a's move reaches it.
      const wsB = new Workspace({ cwd: b, env, actor: 'human:dawid', user: { id_block: 1 } });
      const id = wsB.addTask({ title: 'Filed on b before the move' }).meta.id;
      const rb = new Root(join(b, '.agent-ops'));
      await turn();
      syncRoot(rb, {}, { pull: false, push: false });
      mkdirSync(join(b, '.agent-ops', '.ops', 'claims'), { recursive: true });
      writeFileSync(join(b, '.agent-ops', '.ops', 'claims', 'X-1'), 'token\n');

      // a moves the store and pushes the move.
      moveStore(a, env);
      git(a, 'push', '-q');

      // b's sync rebases its event commit onto the move: the files follow the folder.
      await turn();
      const pulled = syncRoot(rb, {}, { pull: true, push: false });
      expect(pulled.notes).toEqual([
        'the store moved to .swarmup/ upstream; moved 1 local file(s) there',
      ]);
      expect(git(b, 'ls-files', '--', '.agent-ops').trim()).toBe('');
      // Until the next command, only b's local state is left in the old folder.
      expect(git(b, 'status', '--porcelain').trim()).toBe('?? .agent-ops/');
      // The next command finds .swarmup/ and takes b's local state along.
      const found = discoverRoots(b, env, {})[0]!;
      expect(git(b, 'status', '--porcelain').trim()).toBe('');
      expect(samePath(found, join(b, '.swarmup'))).toBe(true);
      expect(readFileSync(join(b, '.swarmup', '.ops', 'claims', 'X-1'), 'utf8')).toBe('token\n');
      expect(existsSync(join(b, '.agent-ops'))).toBe(false);
      const after = new Workspace({ cwd: b, env, actor: 'human:dawid', user: { id_block: 1 } });
      expect(after.defaultRoot().readTask(id).meta.title).toBe('Filed on b before the move');
      // And its sync pushes from the new folder.
      await turn();
      const res = syncRoot(after.defaultRoot(), {}, {});
      expect(res.notes).toEqual([]);
      expect(res.pushed).toBe(true);
    },
    GIT_TEST_TIMEOUT,
  );
});

describe('user config', () => {
  it('copies the old config once, keeps the old file, and logs it', () => {
    const d = tempDir();
    const from = join(d, 'agent-ops', 'config.yml');
    const to = join(d, 'swarmup', 'config.yml');
    mkdirSync(join(d, 'agent-ops'));
    writeFileSync(from, 'me: human:dawid\nroots:\n  - C:/dev/x\nmaster: C:/dev/m\n');
    expect(migrateUserConfig(to, from)).toBe(to);
    expect(readFileSync(to, 'utf8')).toBe(readFileSync(from, 'utf8'));
    expect(readFileSync(join(d, 'swarmup', MIGRATION_LOG), 'utf8')).toMatch(/user config: copied/);
    // Already migrated: the new file is never replaced, even when the old one changes later.
    writeFileSync(from, 'me: human:other\n');
    expect(migrateUserConfig(to, from)).toBe(to);
    expect(readFileSync(to, 'utf8')).toMatch(/human:dawid/);
    expect(readFileSync(join(d, 'swarmup', MIGRATION_LOG), 'utf8').match(/copied/g)).toHaveLength(
      1,
    );
  });

  it('does nothing without an old config', () => {
    const d = tempDir();
    const to = join(d, 'swarmup', 'config.yml');
    expect(migrateUserConfig(to, join(d, 'agent-ops', 'config.yml'))).toBe(to);
    expect(existsSync(join(d, 'swarmup'))).toBe(false);
  });

  it('reads the old file when the copy fails', () => {
    const d = tempDir();
    const from = join(d, 'agent-ops', 'config.yml');
    mkdirSync(join(d, 'agent-ops'));
    writeFileSync(from, 'me: human:dawid\n');
    // A file where the new folder should be: the copy cannot make the folder.
    writeFileSync(join(d, 'swarmup'), 'in the way');
    expect(migrateUserConfig(join(d, 'swarmup', 'config.yml'), from)).toBe(from);
  });
});
