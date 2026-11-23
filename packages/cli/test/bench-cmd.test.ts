import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateDb } from '@swarmup/supervisor';
import { run } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-bench-cli-'));
  dirs.push(d);
  return d;
};

/** A repo with one commit, a set with one entry, and a user config holding `config`. */
function setup(config: string) {
  const dir = temp();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: dir,
      windowsHide: true,
    });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const work = temp();
  const set = join(work, 'set.yaml');
  writeFileSync(
    set,
    'id: demo\nentries:\n  - id: E1\n    base: { ref: main }\n    prompt: Add a test.\n    done_when: [Tests pass]\n',
  );
  const userConfig = join(work, 'user.yml');
  writeFileSync(userConfig, config);
  const cli = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SWARMUP_CONFIG: userConfig,
      CODEX_HOME: join(work, 'codex-home'),
    };
    delete env.SWARMUP_ROOTS;
    const code = await run(
      ['bench', 'run', set, '--repo', dir, '--out', join(work, 'out'), ...argv],
      { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: work },
    );
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { cli };
}

describe('swarmup bench run --max-usd and prices', () => {
  it('prints the cap and the price from swarmupd.bench.prices in a dry run', async () => {
    const { cli } = setup(
      'swarmupd:\n  bench:\n    prices:\n      gpt-x: { input: 1, cached_input: 0.1, output: 8 }\n',
    );
    const res = await cli(
      '--agent',
      'codex:engineer',
      '--model',
      'gpt-x',
      '--max-usd',
      '2.5',
      '--dry-run',
    );
    expect(res.code).toBe(0);
    expect(res.err).toContain('cost cap: $2.50 of agent and judge cost, estimates included');
    expect(res.err).toContain(
      "cost: estimated from tokens at gpt-x's price per million tokens: input $1, cached input $0.1, output $8",
    );
    const unknown = await cli('--agent', 'codex:engineer', '--dry-run');
    expect(unknown.err).toContain(
      'cost: no price for an unknown model, so codex attempts will have no cost',
    );
  });

  it('refuses a cap that is not above 0 and a bad price table', async () => {
    const { cli } = setup(
      'swarmupd:\n  bench:\n    prices:\n      gpt-x: { input: 1, output: 8 }\n',
    );
    const zero = await cli('--agent', 'codex:engineer', '--max-usd', '0', '--dry-run');
    expect(zero.code).toBe(2);
    expect(zero.err).toContain('--max-usd must be a number above 0');
    const bad = await cli('--agent', 'codex:engineer', '--max-usd', '1', '--dry-run');
    expect(bad.code).toBe(2);
    expect(bad.err).toContain(
      'swarmupd.bench.prices.gpt-x.cached_input: use a number of 0 or more',
    );
  });
});

describe('swarmup bench history', () => {
  const history = async (state: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, SWARMUP_STATE_DIR: state };
    const code = await run(['bench', 'history', ...argv], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env,
      cwd: state,
    });
    return { code, out, err };
  };

  it('lists the attempts swarmupd kept, newest first, filtered by set, agent and variant', async () => {
    const state = temp();
    const none = await history(state);
    expect(none.out).toEqual([
      'no bench results: swarmupd keeps the attempts of the runs it starts or lists',
    ]);
    const row = {
      run: 'demo-20261123-100000',
      set: 'demo',
      entry: 'E1',
      attempt: 1,
      mode: 'agent',
      agent: 'claude:engineer',
      model: 'opus',
      variant: null,
      defs_hash: 'd:abc',
      defs_ref: null,
      pass_rate: 0.5,
      hidden_total: 2,
      hidden_passed: 1,
      cost_usd: 0.25,
      cost_estimated: false,
      wall_ms: 125_000,
      started_at: '2026-11-23T10:00:00.000Z',
      summary_at: '2026-11-23T10:05:00.000Z',
    };
    new StateDb(state).saveBenchResults([
      row,
      {
        ...row,
        run: 'demo-20261123-110000',
        variant: 'tests-first',
        pass_rate: 1,
        cost_usd: 0.3,
        cost_estimated: true,
        started_at: '2026-11-23T11:00:00.000Z',
      },
    ]);
    const all = await history(state, '--set', 'demo');
    expect(all.code).toBe(0);
    expect(all.out).toEqual([
      '2026-11-23 11:00  demo/E1 #1  claude:engineer (opus)  variant tests-first  pass 100%  hidden 1/2  $0.30~  2m05s  demo-20261123-110000',
      '2026-11-23 10:00  demo/E1 #1  claude:engineer (opus)  base  pass 50%  hidden 1/2  $0.25  2m05s  demo-20261123-100000',
    ]);
    expect((await history(state, '--variant', 'tests-first')).out).toHaveLength(1);
    expect((await history(state, '--agent', 'codex:engineer')).out[0]).toMatch(/^no bench/);
    const json = await history(state, '--json', '--limit', '1');
    expect(JSON.parse(json.out.join('\n'))).toHaveLength(1);
  });
});
