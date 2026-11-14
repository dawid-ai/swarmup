// POST /api/tasks with `root` (AO-0323): the task goes to the named data root, not the default one.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
import { startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

// As in attachments-api.test.ts: take this test's supervisors and folders before awaiting.
afterEach(async () => {
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const s of mine) {
      s.stop({ killRuns: true });
      await s.close();
    }
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-tasks-'));
  dirs.push(d);
  return d;
}

function repo(name: string, prefix: string): string {
  const dir = temp();
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  initRoot(dir, { name, prefix, human: 'human:dawid' });
  return dir;
}

async function setup() {
  const site = repo('site', 'SITE');
  const web = repo('web', 'WEB');
  const config = join(temp(), 'config.yml');
  writeFileSync(config, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = {
    ...process.env,
    SWARMUP_CONFIG: config,
    SWARMUP_STATE_DIR: temp(),
  } as NodeJS.ProcessEnv;
  delete env.SWARMUP_AGENT;
  delete env.SWARMUP_ROOTS;
  const sup = new Supervisor({
    env,
    cwd: site,
    user: { me: 'human:dawid', roots: [web] },
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'tasks-token', version: 't', build: '1' });
  const post = async (body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}/api/tasks`, {
      method: 'POST',
      headers: { authorization: 'Bearer tasks-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { sup, post };
}

describe('POST /api/tasks', () => {
  it('creates the task in the root it names, and in the default root without one', async () => {
    const { sup, post } = await setup();
    const there = await post({ title: 'Fix the header', root: 'web' });
    expect(there.status).toBe(201);
    expect(there.data).toMatchObject({ id: 'WEB-0001', root: 'web', project: 'web' });

    const here = await post({ title: 'Fix the footer' });
    expect(here.status).toBe(201);
    expect(here.data).toMatchObject({ id: 'SITE-0001', root: 'site', project: 'site' });

    const ws = sup.ws('human:dawid');
    expect(
      ws
        .list({ all: true })
        .map((v) => `${v.root}/${v.meta.id}`)
        .sort(),
    ).toEqual(['site/SITE-0001', 'web/WEB-0001']);
  });

  it('refuses a root that is not loaded, with the names of those that are', async () => {
    const { sup, post } = await setup();
    const res = await post({ title: 'Fix the header', root: 'shop' });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe("no root named 'shop': use one of site, web");
    expect(sup.ws('human:dawid').list({ all: true })).toEqual([]);
  });
});
