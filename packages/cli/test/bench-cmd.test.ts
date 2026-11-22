import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
