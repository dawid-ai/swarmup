import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { initRoot } from '@swarmup/core';
import { run } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): { dir: string; store: string; config: string; state: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmup-trust-cli-'));
  dirs.push(dir);
  const store = initRoot(dir, { name: 'demo', human: 'human:dawid' });
  const config = join(dir, 'user.yml');
  writeFileSync(
    config,
    'me: human:dawid\nmachine: desk\nswarmupd:\n  merge:\n    demo: {base: main}\n',
  );
  return { dir, store, config, state: join(dir, 'state') };
}

async function cli(
  p: { dir: string; config: string; state: string },
  argv: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    SWARMUP_CONFIG: p.config,
    SWARMUP_STATE_DIR: p.state,
    ...env,
  };
  delete e.SWARMUP_ROOTS;
  if (!env.SWARMUP_AGENT) delete e.SWARMUP_AGENT;
  if (!env.SWARMUP_RUN) delete e.SWARMUP_RUN;
  const code = await run(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: e,
    cwd: p.dir,
  });
  return { code, out, err };
}

const CHECKS = [
  'swarmup_defs: 1',
  'checks:',
  '  test: pnpm test',
  '  lint: {run: pnpm lint, paths: ["**/*.ts"], description: Lint the code}',
  '',
].join('\n');

const trusted = (config: string): unknown =>
  (YAML.parse(readFileSync(config, 'utf8')) as { swarmupd?: { trusted_defs?: unknown } }).swarmupd
    ?.trusted_defs;

describe('swarmup defs trust', () => {
  it('keeps the hash of the exact command set, and a change untrusts it', async () => {
    const p = project();
    writeFileSync(join(p.store, 'swarm.yaml'), CHECKS);
    const before = await cli(p, ['validate']);
    expect(before.out.join('\n')).toContain(
      "warning: checks: 2 merge check(s) in demo's swarm.yaml are not trusted on this machine",
    );
    expect((await cli(p, ['defs', 'show'])).out).toContain(
      '  demo: 2 merge check(s), untrusted; skipped until a person runs swarmup defs trust --root demo',
    );
    const res = await cli(p, ['defs', 'trust']);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([
      expect.stringMatching(/^demo: trusts these merge checks \(c:[0-9a-f]{12}\):$/),
      '  pnpm lint  (when it changes **/*.ts)',
      '  pnpm test',
    ]);
    expect(trusted(p.config)).toEqual({
      demo: { checks: expect.stringMatching(/^c:[0-9a-f]{64}$/) },
    });
    expect((await cli(p, ['validate'])).out).toEqual([]);
    expect((await cli(p, ['defs', 'show'])).out).toContain(
      '  demo: 2 merge check(s), trusted; the merge runs them',
    );
    // A description changes nothing; a command does.
    writeFileSync(join(p.store, 'swarm.yaml'), CHECKS.replace('Lint the code', 'Lint'));
    expect((await cli(p, ['validate'])).out).toEqual([]);
    writeFileSync(join(p.store, 'swarm.yaml'), CHECKS.replace('pnpm test', 'pnpm test && curl x'));
    expect((await cli(p, ['validate'])).out.join('\n')).toContain(
      "2 merge check(s) in demo's swarm.yaml changed since this machine trusted them",
    );
    await cli(p, ['defs', 'trust', '--revoke']);
    expect(trusted(p.config)).toEqual({});
  });

  it('refuses an agent and any run', async () => {
    const p = project();
    writeFileSync(join(p.store, 'swarm.yaml'), CHECKS);
    const agent = await cli(p, ['defs', 'trust'], { SWARMUP_AGENT: 'claude:engineer' });
    expect(agent.code).toBe(2);
    expect(agent.err.join('\n')).toContain('only a person trusts git definitions, outside runs');
    const inRun = await cli(p, ['defs', 'trust'], { SWARMUP_RUN: '01AAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(inRun.code).toBe(2);
    expect(trusted(p.config)).toBeUndefined();
  });

  it('says so when a store names no checks', async () => {
    const p = project();
    mkdirSync(p.store, { recursive: true });
    writeFileSync(join(p.store, 'swarm.yaml'), 'swarmup_defs: 1\n');
    expect((await cli(p, ['defs', 'trust'])).out).toEqual([
      'demo: swarm.yaml names no merge checks and the store has no triggers; nothing to trust',
    ]);
  });
});

describe('swarmup defs scorers', () => {
  it('lists built-in and rubric scorers with what this machine uses of them', async () => {
    const p = project();
    writeFileSync(
      p.config,
      'me: human:dawid\nswarmupd:\n  scorers:\n    review-rounds: {pass: 2}\n    copy: {sample: 0.1}\n',
    );
    mkdirSync(join(p.store, 'scorers'), { recursive: true });
    mkdirSync(join(p.store, 'rubrics'), { recursive: true });
    writeFileSync(
      join(p.store, 'rubrics', 'copy.md'),
      '---\nid: copy\nscale: {min: 1, max: 5}\ncriteria:\n  - {id: clear, describe: Reads clearly}\n---\nJudge.\n',
    );
    writeFileSync(
      join(p.store, 'scorers', 'review-rounds.yaml'),
      'kind: builtin\npass: 0\napplies_to: {types: [bug]}\n',
    );
    writeFileSync(
      join(p.store, 'scorers', 'copy.yaml'),
      'kind: rubric\nrubric: copy\nsample: 0.5\njudge: {runtime: claude, model: sonnet}\n',
    );
    expect((await cli(p, ['defs', 'scorers'])).out).toEqual([
      'demo/copy  rubric copy  off on this machine (swarmupd.judge.scorers)  sample 0.1  blind  judge claude sonnet',
      'demo/review-rounds  builtin review-rounds  on  pass 2 (this machine, over 0)  applies to types bug',
    ]);
  });
});

describe('trigger consent', () => {
  const DIGEST = 'every: 24h\naction: run\nagent: claude:pm\nprompt: Write it.\n';
  const write = (store: string, name: string, text: string): void => {
    mkdirSync(join(store, 'triggers'), { recursive: true });
    writeFileSync(join(store, 'triggers', `${name}.yaml`), text);
  };

  it('turns triggers on only for a person, and trusts them only with --trust', async () => {
    const p = project();
    write(p.store, 'digest', DIGEST);
    const agent = await cli(p, ['triggers', 'on', '--root', 'demo'], {
      SWARMUP_AGENT: 'claude:engineer',
    });
    expect(agent.code).toBe(2);
    expect(agent.err.join('\n')).toContain('only a person turns git triggers on, outside runs');
    const on = await cli(p, ['triggers', 'on', '--root', 'demo']);
    expect(on.out).toEqual([
      "demo: this machine runs the git triggers it trusts, from swarmupd's next tick",
      '  digest  every 24h  run claude:pm  prompt "Write it."',
      '  1 trigger(s) in demo are not trusted on this machine; none fires until a person runs `swarmup defs trust --root demo`, or `swarmup triggers on --root demo --trust`',
    ]);
    expect(trusted(p.config)).toBeUndefined();
    expect((await cli(p, ['validate'])).out.join('\n')).toContain(
      '1 trigger(s) in demo are not trusted on this machine',
    );
    expect((await cli(p, ['triggers', 'list'])).out).toContain(
      '  warning: 1 trigger(s) in demo are not trusted on this machine; none fires until a person runs `swarmup defs trust --root demo`',
    );
    await cli(p, ['triggers', 'on', '--root', 'demo', '--trust']);
    expect(trusted(p.config)).toEqual({ demo: { triggers: expect.stringMatching(/^t:/) } });
    expect((await cli(p, ['validate'])).out.join('\n')).not.toContain('trigger(s) in demo');
    // A change to what fires untrusts the set.
    write(p.store, 'digest', DIGEST.replace('Write it.', 'Push it.'));
    expect((await cli(p, ['validate'])).out.join('\n')).toContain(
      '1 trigger(s) in demo changed since this machine trusted them',
    );
  });

  it('trusts triggers with defs trust, listing what fires', async () => {
    const p = project();
    write(p.store, 'digest', DIGEST);
    const res = await cli(p, ['defs', 'trust']);
    expect(res.out).toEqual([
      expect.stringMatching(/^demo: trusts these triggers \(t:[0-9a-f]{12}\):$/),
      '  digest  every 24h  run claude:pm  prompt "Write it."',
    ]);
    expect(trusted(p.config)).toEqual({ demo: { triggers: expect.stringMatching(/^t:/) } });
  });

  it('moves schedules into triggers only for a person, and never onto another store', async () => {
    const p = project();
    writeFileSync(
      p.config,
      'me: human:dawid\nswarmupd:\n  schedules:\n    - {name: digest, every: 24h, agent: claude:pm, task: other/AO-12}\n',
    );
    const agent = await cli(p, ['defs', 'import-schedules', '--apply'], {
      SWARMUP_AGENT: 'claude:engineer',
    });
    expect(agent.err.join('\n')).toContain('only a person moves schedules into triggers');
    const other = await cli(p, ['defs', 'import-schedules']);
    expect(other.err.join('\n')).toContain(
      "schedule 'digest' works on other/AO-12, a task of another store; a trigger of demo cannot",
    );
  });

  it('has a running swarmupd read the user config again after --remove', async () => {
    const p = project();
    writeFileSync(
      p.config,
      'me: human:dawid\nswarmupd:\n  schedules:\n    - {name: digest, every: 24h, agent: claude:pm, prompt: Write it.}\n',
    );
    // A stand-in swarmupd that records the calls it gets.
    const seen: string[] = [];
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (c: Buffer) => parts.push(c));
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${Buffer.concat(parts).toString()}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      mkdirSync(p.state, { recursive: true });
      writeFileSync(
        join(p.state, 'opsd.json'),
        JSON.stringify({ pid: process.pid, port, token: 't', started_at: '', version: '' }),
      );
      const res = await cli(p, ['defs', 'import-schedules', '--apply', '--remove']);
      expect(res.code).toBe(0);
      expect(readFileSync(p.config, 'utf8')).not.toContain('schedules');
      expect(seen).toEqual(['POST /api/settings {"patch":{}}']);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
