// The task panel's criteria and brief routes: a `criteria` change, a forced approval, a brief
// with the children closed since it, and **Run checks** (`criteria check` in swarmupd).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
import { closedSinceBrief, startApi, Supervisor } from '../src/index.js';

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
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-criteria-'));
  dirs.push(d);
  return d;
}

async function setup() {
  const dir = temp();
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  initRoot(dir, { name: 'site', prefix: 'SITE', human: 'human:dawid' });
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
    cwd: dir,
    user: { me: 'human:dawid', roots: [] },
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'crit-token', version: 't', build: '1' });
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: 'Bearer crit-token', 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  return { sup, call, dir };
}

const T1 = '/api/tasks/site%2FSITE-0001';

describe('criteria through the task panel routes', () => {
  it('changes the criteria with an event, under the CLI permission rules', async () => {
    const { call } = await setup();
    const made = await call('POST', '/api/tasks', { title: 'Write the post', to: 'claude:writer' });
    expect(made.status).toBe(201);
    expect(made.data.notes).toEqual([expect.stringContaining('no checkable criterion')]);
    const set = await call('POST', `${T1}/criteria`, {
      as: 'human:dawid',
      done_when: ['the intro names the price', { id: 'tests', kind: 'command', run: 'npm test' }],
    });
    expect(set.status).toBe(200);
    expect((set.data.events as Array<{ type: string }>)[0]!.type).toBe('criteria');
    const detail = await call('GET', T1);
    expect(detail.data.criteria).toEqual([
      { id: 'c1', kind: 'prose', text: 'the intro names the price' },
      { id: 'tests', kind: 'command', run: 'npm test' },
    ]);
    // Not the creator, a person, the orchestrator or a PM: refused with the CLI's message.
    const agent = await call('POST', `${T1}/criteria`, {
      as: 'claude:writer',
      done_when: ['anything'],
    });
    expect(agent.status).toBe(409);
    expect(agent.data.error).toContain('changes its criteria');
    const bad = await call('POST', `${T1}/criteria`, {
      as: 'human:dawid',
      done_when: [{ kind: 'vibe' }],
    });
    expect(bad.status).toBe(400);
  });

  it('approves with a failed criterion only with force, and the event says so', async () => {
    const { sup, call } = await setup();
    await call('POST', '/api/tasks', {
      title: 'Write the post',
      to: 'claude:writer',
      done_when: ['the intro names the price'],
    });
    const writer = sup.ws('claude:writer');
    writer.start('SITE-0001', 'draft');
    writer.review('SITE-0001', 'SITE-0001: draft in `post.md`', 'human:dawid');
    const verdict = { as: 'human:dawid', verdict: 'approve', message: 'fine' };
    const refused = await call('POST', `${T1}/verdict`, {
      ...verdict,
      criteria: { c1: { result: 'fail', note: 'no price' } },
    });
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain('approve marks c1 fail');
    const forced = await call('POST', `${T1}/verdict`, {
      ...verdict,
      criteria: { c1: { result: 'fail', note: 'no price' } },
      force: true,
    });
    expect(forced.status).toBe(200);
    const ev = (forced.data.events as Array<{ type: string; forced?: boolean }>).at(-1)!;
    expect(ev).toMatchObject({ type: 'verdict', forced: true });
  });
});

describe('goal briefs through the task panel routes', () => {
  it('writes a brief and lists the children closed since it', async () => {
    const { sup, call } = await setup();
    await call('POST', '/api/tasks', { title: 'Ship the site', to: 'claude:pm' });
    await call('POST', '/api/tasks', { title: 'Header', parent: 'SITE-0001' });
    await call('POST', '/api/tasks', { title: 'Footer', parent: 'SITE-0001' });
    const plain = await call('GET', T1);
    expect(plain.data.children).toHaveLength(2);
    expect(plain.data.brief).toBeUndefined();
    const wrote = await call('POST', `${T1}/brief`, {
      as: 'human:dawid',
      message: '## Outcome\n\nThe site ships.',
    });
    expect(wrote.status).toBe(200);
    const me = sup.ws('human:dawid');
    me.done('SITE-0002', 'done');
    const detail = await call('GET', T1);
    expect(detail.data.brief).toMatchObject({
      actor: 'human:dawid',
      body: '## Outcome\n\nThe site ships.',
    });
    expect(detail.data.closedSinceBrief).toEqual(['SITE-0002']);
    const empty = await call('POST', `${T1}/brief`, { as: 'human:dawid', message: ' ' });
    expect(empty.status).toBe(400);
  });

  it('counts closed children of a milestone without a brief, and of other parents only after one', () => {
    const kids = [
      { id: 'A', status: 'done', updatedAt: '2026-11-20T10:00:00Z' },
      { id: 'B', status: 'todo', updatedAt: '2026-11-20T11:00:00Z' },
      { id: 'C', status: 'done', updatedAt: '2026-11-19T10:00:00Z' },
    ];
    expect(closedSinceBrief('milestone', null, kids)).toEqual(['C', 'A']);
    expect(closedSinceBrief('task', null, kids)).toEqual([]);
    expect(closedSinceBrief('task', { at: '2026-11-19T12:00:00Z' }, kids)).toEqual(['A']);
  });
});

describe('Run checks', () => {
  it('runs the command and check criteria in the background and records the results', async () => {
    const { call, dir } = await setup();
    writeFileSync(join(dir, 'post.md'), 'one two three\n');
    await call('POST', '/api/tasks', {
      title: 'Write the post',
      to: 'claude:writer',
      done_when: [
        'reads well',
        { id: 'file', kind: 'check', check: 'file-exists', args: { path: 'post.md' } },
        { id: 'words', kind: 'check', check: 'word-count', args: { path: 'post.md', min: 10 } },
        { id: 'node', kind: 'command', run: 'node -e "console.log(42)"' },
      ],
    });
    const before = await call('GET', `${T1}/criteria-check`);
    expect(before.data.job).toBeNull();
    const started = await call('POST', `${T1}/criteria-check`, { as: 'human:dawid' });
    expect(started.status).toBe(202);
    expect((started.data.job as { ids: string[] }).ids).toEqual(['file', 'words', 'node']);
    const again = await call('POST', `${T1}/criteria-check`, { as: 'human:dawid' });
    expect(again.status).toBe(409);
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 200 && !job.endedAt; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await call('GET', `${T1}/criteria-check`)).data.job as Record<string, unknown>;
    }
    expect(job.error).toBeUndefined();
    expect(job.results).toMatchObject({
      file: { result: 'pass' },
      words: { result: 'fail' },
      node: { result: 'pass' },
    });
    expect(job.event).toEqual(expect.any(String));
    const detail = await call('GET', T1);
    expect(detail.data.criteriaResults).toMatchObject({
      file: { result: 'pass', type: 'criteria-check', actor: 'human:dawid' },
      words: { result: 'fail', type: 'criteria-check' },
    });
  }, 60_000);

  it('refuses a task with nothing to run', async () => {
    const { call } = await setup();
    await call('POST', '/api/tasks', { title: 'Prose only', done_when: ['reads well'] });
    const res = await call('POST', `${T1}/criteria-check`, { as: 'human:dawid' });
    expect(res.status).toBe(409);
    expect(res.data.error).toContain('no command or check criteria');
  });
});
