// The Automation routes: the app reads each root's git triggers, merge checks and the inbound
// listener; a person turns triggers on, trusts or revokes, turns the listener on and approves
// direct webhook actions. A run token, or an `as` that is not a person, changes none of it, and
// a trust from the app keeps the same hashes as `swarmup defs trust`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkTriggerText,
  checksHash,
  clearDefinitionsCache,
  initRoot,
  readUserConfig,
  secretsPath,
  triggersHash,
} from '@swarmup/core';
import type { AutomationView, RunRecord } from '../src/index.js';
import { HookListener, HOOKS_LOG, opsdConfig, startApi, Supervisor } from '../src/index.js';

const repoTop = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const dirs: string[] = [];
const sups: Supervisor[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  const shut = closers.splice(0);
  const mine = sups.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const c of shut) await c();
    for (const s of mine) {
      liveMap(s).clear();
      await s.close();
    }
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmupd-automation-'));
  dirs.push(d);
  return d;
}

function liveMap(sup: Supervisor): Map<string, { record: RunRecord }> {
  return (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
}

const DIGEST = 'every: 24h\naction: run\nagent: fake:writer\nprompt: Write it.\n';
const ISSUE =
  'webhook: {verify: hmac, secret: HOOK_KEY}\naction: run\nagent: fake:writer\nruns_on: [desk]\n';
const SWARM = 'swarmup_defs: 1\nchecks:\n  test: { run: pnpm test, paths: ["src/**"] }\n';
const SECRET = 's3cret-value-for-automation-tests';

function trigger(repo: string, name: string, text: string): void {
  const dir = join(repo, '.swarmup', 'triggers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), text);
  clearDefinitionsCache();
}

/** The trigger-set hash `swarmup defs trust` keeps for these files. */
function hashOf(files: Record<string, string>): string {
  const defs = Object.entries(files).map(
    ([name, text]) => checkTriggerText(name, text, { file: `${name}.yaml` }).def!,
  );
  return triggersHash(defs)!;
}

async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  trigger(repo, 'digest', DIGEST);
  trigger(repo, 'issue', ISSUE);
  writeFileSync(join(repo, '.swarmup', 'swarm.yaml'), SWARM);
  clearDefinitionsCache();
  const userConfig = join(temp(), 'config.yml');
  writeFileSync(userConfig, 'me: human:dawid\nmachine: desk\nopsd:\n  sync: false\n');
  const state = temp();
  const env = {
    ...process.env,
    SWARMUP_CONFIG: userConfig,
    SWARMUP_STATE_DIR: state,
  } as NodeJS.ProcessEnv;
  for (const k of ['AGENT', 'ROOTS', 'RUN', 'RUN_TOKEN', 'RUN_STATE_DIR']) {
    delete env[`SWARMUP_${k}`];
    delete env[`OPS_${k}`];
  }
  writeFileSync(secretsPath(env), `HOOK_KEY: ${SECRET}\n`);
  const sup = new Supervisor({
    env,
    cwd: repo,
    user: { me: 'human:dawid', machine: 'desk' },
    freeMem: () => 64 * 2 ** 30,
  });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'full-token', version: 't', build: '1' });
  closers.push(api.close);
  const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, data: JSON.parse(text) as Record<string, unknown> };
  };
  const view = async (): Promise<AutomationView> =>
    (await call('full-token', 'GET', '/api/automation')).data as unknown as AutomationView;
  const machine = () => opsdConfig(readUserConfig(env));
  return { sup, repo, env, state, userConfig, call, view, machine };
}

function registerRun(sup: Supervisor, token: string, id: string): void {
  const record: RunRecord = {
    id,
    agent: 'fake:engineer',
    project: 'test',
    pid: 1,
    image: 'fake',
    command: 'fake',
    cwd: sup.context.cwd,
    log: sup.store.logPath(id),
    started_at: new Date().toISOString(),
    status: 'running',
    budget_minutes: 60,
    tokens: 0,
    token_sha256: createHash('sha256').update(token).digest('hex'),
  };
  sup.store.save(record);
  liveMap(sup).set(record.id, { record });
}

describe('Automation API', () => {
  it('shows triggers, merge checks, webhook secrets by name and the last log lines', async () => {
    const { view, state, call } = await setup();
    writeFileSync(
      join(state, HOOKS_LOG),
      Array.from({ length: 25 }, (_, i) =>
        JSON.stringify({
          at: `2026-11-23T10:${String(i).padStart(2, '0')}:00.000Z`,
          via: 'listener',
          root: 'test',
          trigger: 'issue',
          status: 'refused',
          code: 401,
          reason: `bad signature ${i}`,
        }),
      ).join('\n') + '\nnot json\n',
    );
    const v = await view();
    expect(v.machine).toBe('desk');
    const r = v.roots.find((x) => x.root === 'test')!;
    expect(r).toMatchObject({ on: false, status: 'off', trust: 'untrusted', broken: 0 });
    expect(r.hash).toBe(hashOf({ digest: DIGEST, issue: ISSUE }));
    expect(r.triggers.map((t) => [t.name, t.when, t.target, t.here])).toEqual([
      ['digest', 'every 24h', 'run fake:writer', false],
      ['issue', 'webhook hmac', 'run fake:writer', false],
    ]);
    const issue = r.triggers.find((t) => t.name === 'issue')!;
    expect(issue.webhook).toEqual({
      verify: 'hmac',
      secret: 'HOOK_KEY',
      secret_ok: true,
      direct: false,
    });
    expect(issue.fields).toContainEqual(['webhook.secret', 'HOOK_KEY']);
    expect(issue.fields).toContainEqual(['runs_on', '["desk"]']);
    expect(r.checks).toEqual({
      trust: 'untrusted',
      hash: checksHash({ test: { run: 'pnpm test', paths: ['src/**'] } }),
      checks: [{ name: 'test', run: 'pnpm test', paths: ['src/**'] }],
    });
    expect(v.hooks).toMatchObject({ enabled: false, listener: 'off', restart: false });
    expect(v.hooks.log).toHaveLength(20);
    expect(v.hooks.log.at(-1)!.reason).toBe('bad signature 24');
    // The secret's value never leaves swarmupd.
    expect((await call('full-token', 'GET', '/api/automation')).text).not.toContain(SECRET);
  });

  it('names where the listener listens, and when a restart would apply the config', async () => {
    const { sup, view } = await setup();
    const listener = new HookListener(sup, { port: 0, host: '127.0.0.1' });
    closers.push(() => listener.close());
    const port = await listener.start();
    // Listening while the config says off: a restart turns it off.
    expect((await view()).hooks).toMatchObject({
      enabled: false,
      listener: 'listening',
      at: { host: '127.0.0.1', port },
      restart: true,
    });
    await listener.close();
    expect((await view()).hooks).toMatchObject({ listener: 'off', restart: false });
  });

  it('lets a person turn triggers on, trust, revoke, enable the listener and approve direct', async () => {
    const { call, view, machine } = await setup();
    const me = { as: 'human:dawid' };
    expect(
      (
        await call('full-token', 'POST', '/api/automation/triggers', {
          ...me,
          root: 'test',
          on: true,
        })
      ).status,
    ).toBe(200);
    expect(machine().triggers).toEqual({ test: true });
    let r = (await view()).roots[0]!;
    expect(r.status).toBe('untrusted');

    // A hash the person did not review is refused, and nothing is written.
    const stale = await call('full-token', 'POST', '/api/automation/trust', {
      ...me,
      root: 'test',
      triggers: hashOf({ digest: DIGEST }),
      checks: r.checks!.hash,
    });
    expect(stale.status).toBe(409);
    expect(stale.data.error).toContain('changed since you reviewed them');
    // Leaving out a set the root has is refused too.
    const partial = await call('full-token', 'POST', '/api/automation/trust', {
      ...me,
      root: 'test',
      triggers: r.hash,
    });
    expect(partial.status).toBe(409);
    expect(machine().trusted_defs).toEqual({});

    const trusted = await call('full-token', 'POST', '/api/automation/trust', {
      ...me,
      root: 'test',
      triggers: r.hash,
      checks: r.checks!.hash,
    });
    expect(trusted.status).toBe(200);
    expect(machine().trusted_defs.test).toEqual({
      triggers: hashOf({ digest: DIGEST, issue: ISSUE }),
      checks: checksHash({ test: { run: 'pnpm test', paths: ['src/**'] } }),
    });
    r = (trusted.data as unknown as AutomationView).roots[0]!;
    expect(r.status).toBe('trusted');
    expect(r.checks!.trust).toBe('trusted');

    expect(
      (await call('full-token', 'POST', '/api/automation/hooks', { ...me, enabled: true })).data
        .hooks,
    ).toMatchObject({ enabled: true, listener: 'off', restart: true });
    expect(machine().hooks.enabled).toBe(true);

    const direct = await call('full-token', 'POST', '/api/automation/direct', {
      ...me,
      root: 'test',
      trigger: 'issue',
      on: true,
    });
    expect(direct.status).toBe(200);
    expect(machine().hooks.direct).toEqual({ test: { issue: true } });
    const issue = (direct.data as unknown as AutomationView).roots[0]!.triggers.find(
      (t) => t.name === 'issue',
    )!;
    // Approved; a delivery still files a finding while fake:writer may not wake here.
    expect(issue.webhook!.direct).toBe(true);
    // Direct actions need a webhook trigger.
    const noHook = await call('full-token', 'POST', '/api/automation/direct', {
      ...me,
      root: 'test',
      trigger: 'digest',
      on: true,
    });
    expect(noHook.status).toBe(400);
    await call('full-token', 'POST', '/api/automation/direct', {
      ...me,
      root: 'test',
      trigger: 'issue',
      on: false,
    });
    expect(machine().hooks.direct).toEqual({});

    expect(
      (await call('full-token', 'POST', '/api/automation/revoke', { ...me, root: 'test' })).status,
    ).toBe(200);
    expect(machine().trusted_defs).toEqual({});
    await call('full-token', 'POST', '/api/automation/triggers', {
      ...me,
      root: 'test',
      on: false,
    });
    expect(machine().triggers).toEqual({ test: false });
    expect((await view()).roots[0]!.status).toBe('off');
  });

  it('refuses every write from a run token or an agent, and changes nothing', async () => {
    const { sup, call, view, userConfig } = await setup();
    registerRun(sup, 'run-token', 'RUN-ONE');
    const r = (await view()).roots[0]!;
    const before = readFileSync(userConfig, 'utf8');
    const writes: Array<[string, Record<string, unknown>]> = [
      ['triggers', { root: 'test', on: true }],
      ['trust', { root: 'test', triggers: r.hash, checks: r.checks!.hash }],
      ['revoke', { root: 'test' }],
      ['hooks', { enabled: true }],
      ['direct', { root: 'test', trigger: 'issue', on: true }],
    ];
    for (const [route, body] of writes) {
      // A run's token acts as its agent whatever `as` says.
      const run = await call('run-token', 'POST', `/api/automation/${route}`, {
        as: 'human:dawid',
        ...body,
      });
      expect(run.status, route).toBe(403);
      expect(run.data.error).toContain('run RUN-ONE cannot do it');
      // The full token acting as an agent is refused too.
      const agent = await call('full-token', 'POST', `/api/automation/${route}`, {
        as: 'claude:engineer',
        ...body,
      });
      expect(agent.status, route).toBe(403);
      expect(agent.data.error).toContain('only a person');
    }
    expect(readFileSync(userConfig, 'utf8')).toBe(before);
    // The settings route cannot set them either.
    for (const key of ['triggers', 'trusted_defs', 'hooks']) {
      const res = await call('full-token', 'POST', '/api/settings', {
        as: 'human:dawid',
        patch: { opsd: { [key]: { test: true } } },
      });
      expect(res.status, key).toBe(400);
    }
    expect(readFileSync(userConfig, 'utf8')).toBe(before);
    // Reads stay open to runs.
    expect((await call('run-token', 'GET', '/api/automation')).status).toBe(200);
  });

  it('keeps the same hashes as swarmup defs trust', async () => {
    const { sup, call, view, machine, repo, env } = await setup();
    const cli = join(repoTop, 'packages', 'cli', 'dist', 'main.js');
    execFileSync(process.execPath, [cli, 'defs', 'trust', '--root', 'test'], {
      cwd: repo,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    // The CLI has a running swarmupd read the config again; here no swarmupd answers it.
    sup.reloadConfig();
    const fromCli = machine().trusted_defs.test;
    expect(fromCli?.triggers).toMatch(/^t:[0-9a-f]{64}$/);
    expect(fromCli?.checks).toMatch(/^c:[0-9a-f]{64}$/);
    const shown = (await view()).roots[0]!;
    expect(shown.trust).toBe('trusted');
    expect(shown.checks!.trust).toBe('trusted');
    await call('full-token', 'POST', '/api/automation/revoke', { as: 'human:dawid', root: 'test' });
    expect(machine().trusted_defs.test).toBeUndefined();
    await call('full-token', 'POST', '/api/automation/trust', {
      as: 'human:dawid',
      root: 'test',
      triggers: shown.hash,
      checks: shown.checks!.hash,
    });
    expect(machine().trusted_defs.test).toEqual(fromCli);
  });
});
