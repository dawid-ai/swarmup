import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { initRoot, loadDefinitions, schemaFiles } from '@swarmup/core';
import { run } from '../src/cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A folder with a task store, and a user config file next to it (none written yet). */
function project(): { dir: string; store: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmup-defs-cli-'));
  dirs.push(dir);
  const store = initRoot(dir, { name: 'demo', human: 'human:dawid' });
  return { dir, store, config: join(dir, 'user.yml') };
}

function cli(
  dir: string,
  config: string,
  ...argv: string[]
): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, SWARMUP_CONFIG: config };
  delete env.SWARMUP_ROOTS;
  delete env.SWARMUP_AGENT;
  const code = run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: dir });
  if (typeof code !== 'number') throw new Error('defs commands are synchronous');
  return { code, out, err };
}

/** {@link cli} for a command that may tell swarmupd to reload, which is asynchronous. */
async function acli(
  dir: string,
  config: string,
  ...argv: string[]
): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, SWARMUP_CONFIG: config };
  delete env.SWARMUP_ROOTS;
  delete env.SWARMUP_AGENT;
  const code = await run(argv, { out: (l) => out.push(l), err: (l) => err.push(l), env, cwd: dir });
  return { code, out, err };
}

const BAD = [
  'swarmup_defs: 1',
  'runtimes:',
  '  claude: {model: opus, effrt: high}',
  'roles:',
  '  qa: {per_project: many}',
  '',
].join('\n');

describe('swarmup validate', () => {
  it('passes a store without swarm.yaml and one with a valid file', () => {
    const { dir, store, config } = project();
    expect(cli(dir, config, 'validate')).toMatchObject({ code: 0, out: [] });
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\nroles: {qa: {burst: 4}}\n');
    const ok = cli(dir, config, 'validate');
    expect(ok).toMatchObject({ code: 0, out: [] });
    expect(ok.err).toEqual(['0 errors, 0 warnings in 2 files']);
  });

  it('prints file:line:col: severity: path: message and exits 1 on errors', () => {
    const { dir, store, config } = project();
    writeFileSync(join(store, 'swarm.yaml'), BAD);
    const res = cli(dir, config, 'validate');
    expect(res.code).toBe(1);
    expect(res.out).toEqual([
      `${join('.swarmup', 'swarm.yaml')}:3:25: warning: runtimes.claude.effrt: unknown key 'effrt'; did you mean 'effort'?`,
      `${join('.swarmup', 'swarm.yaml')}:5:21: error: roles.qa.per_project: use a whole number of at least 0; got text`,
    ]);
    expect(res.err).toEqual(['1 error, 1 warning in 2 files']);
  });

  it('exits 0 on warnings, and 1 on warnings with --strict', () => {
    const { dir, store, config } = project();
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\nvariants: {x: {}}\n');

    expect(cli(dir, config, 'validate').code).toBe(0);
    expect(cli(dir, config, 'validate', '--strict').code).toBe(1);
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\nextra: 1\n');
    const strict = cli(dir, config, 'validate', '--strict');
    expect(strict.code).toBe(1);
    expect(strict.out[0]).toContain(": error: extra: unknown key 'extra'");
  });

  it('checks loose files, reports JSON, and refuses a path that is not there with 2', () => {
    const { dir, config } = project();
    const loose = join(dir, 'team.yaml');
    writeFileSync(loose, BAD);
    expect(cli(dir, config, 'validate', 'team.yaml').out).toHaveLength(2);
    const agent = join(dir, 'claude-x.md');
    writeFileSync(agent, '---\nstatus: on\n---\nBody\n');
    expect(cli(dir, config, 'validate', 'claude-x.md').out).toEqual([
      "claude-x.md:2:9: error: status: use one of active, paused, proposed; got 'on'",
    ]);
    const json = cli(dir, config, 'validate', 'team.yaml', '--json');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({
      ok: false,
      errors: 1,
      warnings: 1,
      problems: [
        { line: 3, col: 25, severity: 'warning' },
        { line: 5, severity: 'error' },
      ],
    });
    const missing = cli(dir, config, 'validate', 'nope.yaml');
    expect(missing.code).toBe(2);
    expect(missing.err[0]).toMatch(/nope\.yaml: no such file or folder/);
    expect(cli(dir, config, 'validate', '--root', 'other').code).toBe(2);
  });

  it('writes the JSON Schemas into the store for editors', () => {
    const { dir, store, config } = project();
    expect(cli(dir, config, 'validate', '--write-schemas').code).toBe(0);
    for (const [name, text] of Object.entries(schemaFiles())) {
      expect(readFileSync(join(store, '.schemas', name), 'utf8')).toBe(text);
    }
  });
});

describe('swarmup defs', () => {
  it('prints the hash and shows what swarm.yaml sets under the machine config', () => {
    const { dir, store, config } = project();
    writeFileSync(
      join(store, 'swarm.yaml'),
      'swarmup_defs: 1\nruntimes: {claude: {model: opus, effort: low}}\n',
    );
    writeFileSync(
      config,
      YAML.stringify({
        swarmupd: { seeded: 1, runtimes: { claude: { command: 'claude', effort: 'high' } } },
      }),
    );
    const hash = loadDefinitions(store).hash;
    expect(cli(dir, config, 'defs', 'hash').out).toEqual([`demo  ${hash}`]);
    const shown = cli(dir, config, 'defs', 'show');
    expect(shown.code).toBe(0);
    expect(shown.out).toEqual([
      `demo  ${hash.slice(0, 14)}  0 agent file(s)  ok`,
      '  runtimes.claude.model = "opus" (from demo)',
      '  runtimes.claude.effort = "high" (this machine, over "low" from demo)',
    ]);
    expect(cli(dir, config, 'defs', 'nope').code).toBe(2);
  });

  it('lists what changed against a git ref', () => {
    const { dir, store, config } = project();
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
        cwd: dir,
        windowsHide: true,
      });
    git('init', '-q');
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\r\n');
    git('add', '-A');
    git('commit', '-qm', 'start');
    // Line ends alone change no hash.
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\n');
    const same = cli(dir, config, 'defs', 'diff');
    expect(same.out[1]).toBe('  no change');
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\nroles: {qa: {burst: 2}}\n');
    writeFileSync(join(store, 'agents', 'claude-qa.md'), '---\nid: claude:qa\n---\n');
    const res = cli(dir, config, 'defs', 'diff', 'HEAD');
    expect(res.code).toBe(0);
    expect(res.out.slice(1)).toEqual(['  added    agents/claude-qa.md', '  changed  swarm.yaml']);
    expect(res.out[0]).toMatch(/^demo: HEAD d:[0-9a-f]{12} -> working files d:[0-9a-f]{12}$/);
    expect(cli(dir, config, 'defs', 'diff', 'no-such-ref').code).toBe(2);
  });

  it('imports runtime models and roles from the user config, and removes them only with --remove', async () => {
    const { dir, store, config } = project();
    writeFileSync(
      config,
      YAML.stringify({
        me: 'human:dawid',
        swarmupd: {
          seeded: 1,
          runtimes: { claude: { command: 'claude', model: 'opus' }, codex: { command: 'codex' } },
          roles: { reviewer: { providers: ['codex', 'claude'], max_live: 2 } },
        },
      }),
    );
    writeFileSync(join(store, 'swarm.yaml'), '# Team settings\nswarmup_defs: 1\n');
    const res = await acli(dir, config, 'defs', 'import-config');
    expect(res.code).toBe(0);
    expect(res.out).toContain('+runtimes:');
    const text = readFileSync(join(store, 'swarm.yaml'), 'utf8');
    expect(text).toContain('# Team settings');
    expect(YAML.parse(text)).toEqual({
      swarmup_defs: 1,
      runtimes: { claude: { model: 'opus' } },
      roles: { reviewer: { providers: ['codex', 'claude'] } },
    });
    // The user config is left as it was.
    expect(YAML.parse(readFileSync(config, 'utf8')).swarmupd.runtimes.claude.model).toBe('opus');
    expect((await acli(dir, config, 'defs', 'import-config')).out[0]).toMatch(/already up to date/);

    expect((await acli(dir, config, 'defs', 'import-config', '--remove')).code).toBe(0);
    const user = YAML.parse(readFileSync(config, 'utf8'));
    expect(user.swarmupd.runtimes.claude).toEqual({ command: 'claude' });
    // A machine-only key stays, and keeps the role.
    expect(user.swarmupd.roles).toEqual({ reviewer: { max_live: 2 } });
    expect(cli(dir, config, 'validate').code).toBe(0);
  });

  it('says when there is nothing to import, and writes no file', async () => {
    const { dir, store, config } = project();
    expect((await acli(dir, config, 'defs', 'import-config')).out[0]).toMatch(/nothing to import/);
    expect(existsSync(join(store, 'swarm.yaml'))).toBe(false);
  });
});

describe('swarmup agents', () => {
  it('shows definition problems of a root with swarm.yaml', () => {
    const { dir, store, config } = project();
    writeFileSync(join(store, 'agents', 'claude-qa.md'), '---\nid: claude:qa\nmodel: --x\n---\n');
    expect(cli(dir, config, 'agents').err).toEqual([]);
    writeFileSync(join(store, 'swarm.yaml'), 'swarmup_defs: 1\n');
    const res = cli(dir, config, 'agents');
    expect(res.out[0]).toMatch(/^claude:qa/);
    expect(res.err).toEqual([
      expect.stringMatching(/claude-qa\.md:3:8: error: model: name a model such as opus/),
    ]);
  });
});
