import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(trusted(p.config)).toEqual({ demo: expect.stringMatching(/^c:[0-9a-f]{64}$/) });
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
    expect(agent.err.join('\n')).toContain('only a person trusts merge checks, outside runs');
    const inRun = await cli(p, ['defs', 'trust'], { SWARMUP_RUN: '01AAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(inRun.code).toBe(2);
    expect(trusted(p.config)).toBeUndefined();
  });

  it('says so when a store names no checks', async () => {
    const p = project();
    mkdirSync(p.store, { recursive: true });
    writeFileSync(join(p.store, 'swarm.yaml'), 'swarmup_defs: 1\n');
    expect((await cli(p, ['defs', 'trust'])).out).toEqual([
      'demo: swarm.yaml names no merge checks; nothing to trust',
    ]);
  });
});
