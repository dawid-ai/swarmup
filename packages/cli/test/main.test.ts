import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPS_ALIAS_NOTICE } from '../src/alias.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoTop = join(here, '..', '..', '..');
// Resolved like any import, so a worktree without its own node_modules finds the tsc of the
// checkout that holds it.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const mainJs = join(repoTop, 'packages', 'cli', 'dist', 'main.js');
const opsJs = join(repoTop, 'packages', 'cli', 'dist', 'ops.js');
let cwd = '';

beforeAll(() => {
  // Build incrementally, so the test never runs a stale main.js.
  execFileSync(process.execPath, [tsc, '-b', 'packages/cli'], { cwd: repoTop, windowsHide: true });
  cwd = mkdtempSync(join(tmpdir(), 'swarmup-main-'));
}, 120_000);

afterAll(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
});

describe('swarmup main', () => {
  it('exits cleanly when the reader closes stdout early', async () => {
    const env = {
      ...process.env,
      SWARMUP_CONFIG: join(cwd, 'none.yml'),
      SWARMUP_AGENT: 'human:dawid',
    };
    const { code, err } = await new Promise<{ code: number | null; err: string }>(
      (resolve, reject) => {
        const p = spawn(process.execPath, [mainJs, 'help'], { cwd, env, windowsHide: true });
        // Close the read end before swarmup writes anything, like `swarmup help | head -0`.
        p.stdout.destroy();
        let err = '';
        p.stderr.on('data', (c: Buffer) => (err += c.toString()));
        p.on('error', reject);
        p.on('close', (code) => resolve({ code, err }));
      },
    );
    expect(err).not.toMatch(/EPIPE|Unhandled/);
    expect(code).toBe(0);
  });
});

describe('old names until 0.4 (AO-0199)', () => {
  /** The environment without any SwarmUp or old variable, plus `vars`. */
  const cleanEnv = (vars: Record<string, string>): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of Object.keys(env)) if (/^(SWARMUP|OPS)_/i.test(k)) delete env[k];
    return { ...env, ...vars };
  };
  const run = (entry: string, env: NodeJS.ProcessEnv) => {
    const r = spawnSync(process.execPath, [entry, 'whoami'], {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('runs `ops` as an alias of `swarmup`, with the notice on stderr only', () => {
    const env = cleanEnv({ SWARMUP_CONFIG: join(cwd, 'none.yml'), SWARMUP_AGENT: 'claude:qa' });
    const alias = run(opsJs, env);
    expect(alias.code).toBe(0);
    expect(alias.out).toBe('claude:qa\n');
    expect(alias.err).toBe(`${OPS_ALIAS_NOTICE}\n`);
    const plain = run(mainJs, env);
    expect(plain).toEqual({ code: 0, out: 'claude:qa\n', err: '' });
  });

  it('reads an OPS_* variable when the SWARMUP_* one is unset, and prefers the new one', () => {
    const config = join(cwd, 'none.yml');
    expect(run(mainJs, cleanEnv({ OPS_CONFIG: config, OPS_AGENT: 'codex:qa' })).out).toBe(
      'codex:qa\n',
    );
    const both = cleanEnv({ SWARMUP_CONFIG: config, SWARMUP_AGENT: 'claude:qa', OPS_AGENT: 'x:y' });
    expect(run(mainJs, both).out).toBe('claude:qa\n');
  });
});
