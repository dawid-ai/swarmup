import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, Workspace } from '@swarmup/core';
import { opsdConfig, Supervisor } from '../src/index.js';
import { type Exec, readReleases, releasesNote, type ReleaseSnapshot } from '../src/releases.js';
import { until, WAIT_MS } from './until.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    for (const d of gone) {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-releases-'));
  dirs.push(d);
  return d;
}

const ID = {
  GIT_AUTHOR_NAME: 'Swarmupd Test',
  GIT_AUTHOR_EMAIL: 'swarmupd@example.com',
  GIT_COMMITTER_NAME: 'Swarmupd Test',
  GIT_COMMITTER_EMAIL: 'swarmupd@example.com',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...ID },
  }).trim();

const GH_LIST = JSON.stringify([
  {
    tagName: 'v0.3.0-beta.5',
    name: 'v0.3.0-beta.5',
    isLatest: false,
    isPrerelease: true,
    isDraft: false,
    publishedAt: '2026-11-15T10:00:00Z',
  },
  {
    tagName: 'v0.3.0-beta.6',
    name: 'next',
    isLatest: false,
    isPrerelease: true,
    isDraft: true,
    publishedAt: '',
  },
  {
    tagName: 'v0.3.0-beta.4',
    name: 'v0.3.0-beta.4',
    isLatest: false,
    isPrerelease: true,
    isDraft: false,
    publishedAt: '2026-11-10T10:00:00Z',
  },
]);

describe('releases for Codex PM runs (AO-0350)', () => {
  it('reads GitHub releases and local tags, and names the newest release that is no draft', async () => {
    const calls: string[] = [];
    const exec: Exec = (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      return Promise.resolve(file === 'gh' ? GH_LIST : 'v0.3.0-beta.5\nv0.3.0-beta.4\n');
    };
    const snap = await readReleases('/repo', { exec, now: () => Date.UTC(2026, 10, 15, 12) });
    expect(calls[0]).toContain('gh release list --limit 5 --json tagName');
    expect(snap.releases?.map((r) => r.tagName)).toEqual([
      'v0.3.0-beta.5',
      'v0.3.0-beta.6',
      'v0.3.0-beta.4',
    ]);
    expect(snap.tags).toEqual(['v0.3.0-beta.5', 'v0.3.0-beta.4']);
    const note = releasesNote([snap]);
    // The draft is listed newer, but the newest release is the published one.
    expect(note).toContain('newest release: `v0.3.0-beta.5`');
    expect(note).toContain('- `v0.3.0-beta.6` "next" (pre-release, draft)');
    expect(note).toContain('- /repo (read 2026-11-15 12:00 UTC):');
    expect(note).toContain('your sandbox has no network');
  });

  it('falls back to local tags when gh fails, and writes nothing with neither', async () => {
    const failing: Exec = (file) =>
      file === 'gh'
        ? Promise.reject(
            Object.assign(new Error('Command failed: gh'), { stderr: 'gh: not logged in\n' }),
          )
        : Promise.resolve('v1.2.0\n');
    const snap = await readReleases('C:\\repo', { exec: failing, now: () => 0 });
    expect(snap.releases).toBeUndefined();
    const note = releasesNote([snap]);
    expect(note).toContain('GitHub releases: not read (gh: not logged in)');
    expect(note).toContain('local tags, newest first: `v1.2.0`');
    expect(note).toContain('- C:/repo (read');
    const empty: ReleaseSnapshot = { top: '/x', at: 0, releases: [], tags: [] };
    expect(releasesNote([empty])).toBe('');
  });

  it(
    'gives a codex:pm run the releases in its prompt, and a codex:engineer run none',
    async () => {
      const repo = temp();
      git(repo, 'init', '-q', '-b', 'main');
      initRoot(repo, { name: 'test', human: 'human:dawid' });
      git(repo, 'add', '-A');
      git(repo, 'commit', '-qm', 'start');
      const call = join(temp(), 'call.txt');
      const recorder = join(temp(), 'codex.mjs');
      writeFileSync(
        recorder,
        `import { writeFileSync } from 'node:fs';\nlet p = '';\nfor await (const c of process.stdin) p += c;\nwriteFileSync(process.env.PROMPT_FILE, p);\n`,
      );
      const env = {
        ...process.env,
        ...ID,
        SWARMUP_CONFIG: join(repo, 'none.yml'),
        SWARMUP_STATE_DIR: temp(),
        PROMPT_FILE: call,
      } as NodeJS.ProcessEnv;
      delete env.SWARMUP_AGENT;
      delete env.SWARMUP_ROOTS;
      const h = new Workspace({ cwd: repo, env, actor: 'human:dawid', user: {} });
      h.saveRole({ id: 'codex:pm', status: 'active' }, { create: true });
      h.saveRole({ id: 'codex:engineer', status: 'active' }, { create: true });
      const config = opsdConfig({
        opsd: {
          sync: false,
          task_worktrees: false,
          runtimes: { codex: { command: process.execPath, args: [recorder] } },
        },
      });
      const read: string[] = [];
      const sup = new Supervisor({
        env,
        cwd: repo,
        user: {},
        config,
        freeMem: () => 64 * 2 ** 30,
        readReleases: (top) => {
          read.push(top);
          return readReleases(top, {
            exec: (file) => Promise.resolve(file === 'gh' ? GH_LIST : ''),
          });
        },
      });
      sups.push(sup);
      const promptOf = async (agent: string): Promise<string> => {
        rmSync(call, { force: true });
        const run = await sup.launchFresh({ agent, prompt: 'What is the latest release?' });
        await until(() => sup.run(run.id).status === 'ended');
        return readFileSync(call, 'utf8');
      };
      const pm = await promptOf('codex:pm');
      expect(pm).toContain('What is the latest release?');
      expect(pm).toContain('newest release: `v0.3.0-beta.5`');
      expect(read).toHaveLength(1);
      const engineer = await promptOf('codex:engineer');
      expect(engineer).not.toContain('Releases and tags');
      // A second PM run within the TTL reuses the read.
      await promptOf('codex:pm');
      expect(read).toHaveLength(1);
    },
    WAIT_MS * 3,
  );
});
