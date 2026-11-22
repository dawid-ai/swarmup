import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
import { run } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-propose-cli-'));
  dirs.push(d);
  return d;
};

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const ENGINEER = '---\nid: claude:engineer\nstatus: active\nmodel: opus\n---\n\nWrite the code.\n';

function project() {
  const dir = temp();
  execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
  const store = initRoot(dir, { name: 'demo', prefix: 'DM', human: 'human:dawid' });
  put(store, 'swarm.yaml', 'swarmup_defs: 1\n');
  put(store, 'agents/claude-engineer.md', ENGINEER);
  put(store, 'agents/claude-improver.md', '---\nid: claude:improver\nstatus: active\n---\n');
  const config = join(dir, 'user.yml');
  const cli = async (as: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, SWARMUP_CONFIG: config, SWARMUP_AGENT: as };
    delete env.SWARMUP_ROOTS;
    const code = await run(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env,
      cwd: dir,
    });
    return { code, out, err };
  };
  return { dir, store, cli };
}

describe('swarmup defs propose, variants, promote and reject', () => {
  it('proposes an overlay on a task, lists it, and lets only a person reject it', async () => {
    const { store, cli } = project();
    expect(
      (await cli('human:dawid', 'new', 'Improve claude:engineer', '--to', 'claude:improver')).code,
    ).toBe(0);
    const overlay = temp();
    put(overlay, 'agents/claude-engineer.md', 'Run the tests before you ask for review.\n');
    const proposed = await cli(
      'claude:improver',
      'defs',
      'propose',
      'DM-0001',
      '--dir',
      overlay,
      '--name',
      'tests-first',
      '--scorer',
      'review-rounds',
      '-m',
      'Untested changes come back.',
    );
    expect(proposed.err).toEqual([]);
    expect(proposed.code).toBe(0);
    expect(proposed.out[0]).toMatch(
      /^demo\/tests-first {2}d:[0-9a-f]{12} {2}proposed on demo\/DM-0001/,
    );
    const listed = await cli('human:dawid', 'defs', 'variants');
    expect(listed.out[0]).toMatch(
      /^demo\/tests-first {2}d:[0-9a-f]{12} {2}proposed {2}demo\/DM-0001 {2}claude:engineer$/,
    );
    expect(listed.out[1]).toBe('  changed  agents/claude-engineer.md');
    const valid = await cli('human:dawid', 'validate', '--variant', 'tests-first');
    expect(valid.code).toBe(0);
    const refused = await cli('claude:improver', 'defs', 'reject', 'tests-first', '-m', 'no');
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toMatch(/only a person rejects/);
    const rejected = await cli('human:dawid', 'defs', 'reject', 'tests-first', '-m', 'Too broad.');
    expect(rejected.out).toEqual(['demo/tests-first: rejected, recorded on demo/DM-0001']);
    expect(existsSync(join(store, 'variants', 'tests-first'))).toBe(false);
  });

  it('refuses a frozen path with the policy line', async () => {
    const { cli } = project();
    await cli('human:dawid', 'new', 'Improve', '--to', 'claude:improver');
    const overlay = temp();
    put(overlay, 'swarm.yaml', 'roles: {engineer: {per_project: 9}}\n');
    const res = await cli(
      'claude:improver',
      'defs',
      'propose',
      'DM-0001',
      '--dir',
      overlay,
      '--name',
      'x',
      '-m',
      'y',
    );
    expect(res.code).toBe(1);
    expect(res.err.join('\n')).toContain('swarm.yaml: frozen by the improvement policy');
  });

  it('promotes a variant onto the role file as a person', async () => {
    const { store, cli } = project();
    await cli('human:dawid', 'new', 'Improve', '--to', 'claude:improver');
    const overlay = temp();
    put(overlay, 'agents/claude-engineer.md', '---\neffort: high\n---\n');
    await cli(
      'claude:improver',
      'defs',
      'propose',
      'DM-0001',
      '--dir',
      overlay,
      '--name',
      'high',
      '-m',
      'y',
    );
    const res = await cli('human:dawid', 'defs', 'promote', 'high');
    expect(res.code).toBe(0);
    expect(res.out[0]).toMatch(/^demo\/high: promoted d:[0-9a-f]{12} -> d:[0-9a-f]{12}$/);
    expect(res.out[1]).toBe('  wrote   agents/claude-engineer.md');
    const text = readFileSync(join(store, 'agents', 'claude-engineer.md'), 'utf8');
    expect(text).toContain('effort: high');
    expect(text).toContain('Write the code.');
  });

  it("puts a variant's role file in bench prompts, with its model", async () => {
    const { store, cli, dir } = project();
    put(store, 'variants/tests-first/agents/claude-engineer.md', 'Tests first.\n');
    const set = join(temp(), 'set.yaml');
    const head = execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'base',
      ],
      { cwd: dir, windowsHide: true },
    );
    void head;
    writeFileSync(
      set,
      'id: demo\nentries:\n  - id: E1\n    base: { ref: HEAD }\n    prompt: Add a test.\n    done_when: [Tests pass]\n',
    );
    const res = await cli(
      'human:dawid',
      'bench',
      'run',
      set,
      '--repo',
      dir,
      '--agent',
      'claude:engineer',
      '--variant',
      'tests-first',
      '--root',
      store,
      '--out',
      join(temp(), 'out'),
      '--dry-run',
    );
    expect(res.err.join('\n')).toMatch(
      /role file: claude:engineer from .*, variant tests-first \(d:[0-9a-f]{12}\)/,
    );
    expect(res.err.join('\n')).toMatch(/--model opus/);
    expect(res.code).toBe(0);
  });
});
