// Run artifacts through the CLI (W4): `swarmup run artifact` from inside a run, `swarmup review`
// from a run attaching what the run kept, `swarmup artifact` printing one, and `swarmup runs show`.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot } from '@swarmup/core';
import type { RunRecord } from '@swarmup/supervisor';
import { opsdConfig, startApi, Supervisor } from '@swarmup/supervisor';
import { run } from '../src/cli.js';

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  const shut = closers.splice(0);
  const gone = dirs.splice(0);
  try {
    for (const c of shut) await c();
  } finally {
    for (const d of gone) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}, 90_000);

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'swarmup-runart-cli-'));
  dirs.push(d);
  return d;
}

const RUN = '01RUNARTIFACTSCLI000000000';
const TOKEN = 'the-run-token';

/** A swarmupd with its API, a task repo, and one live run of `fake:engineer` in it. */
async function world() {
  const repo = temp();
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: repo,
      windowsHide: true,
    });
  git('init', '-q');
  initRoot(repo, { name: 'test', human: 'human:dawid' });
  git('add', '-A');
  git('commit', '-qm', 'base');
  const state = temp();
  const config = join(temp(), 'config.yml');
  writeFileSync(config, `me: human:dawid\nroots:\n  - ${JSON.stringify(repo)}\n`);
  const env = {
    ...process.env,
    SWARMUP_CONFIG: config,
    SWARMUP_STATE_DIR: state,
  } as NodeJS.ProcessEnv;
  for (const k of ['SWARMUP_AGENT', 'SWARMUP_ROOTS', 'SWARMUP_RUN', 'SWARMUP_RUN_TOKEN'])
    delete env[k];
  delete env.SWARMUP_RUN_STATE_DIR;
  const sup = new Supervisor({
    env,
    cwd: repo,
    user: {},
    config: opsdConfig({ swarmupd: { sync: false } } as never),
    freeMem: () => 64 * 2 ** 30,
  });
  const api = await startApi(sup, { port: 0, token: 'full-token', version: 't', build: '1' });
  const live = (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
  closers.push(async () => {
    await api.close();
    live.clear();
    await sup.close();
  });
  writeFileSync(
    join(state, 'opsd.json'),
    JSON.stringify({ pid: process.pid, port: api.port, token: 'full-token' }),
  );
  const scratch = join(state, 'scratch', RUN);
  mkdirSync(join(scratch, 'artifacts'), { recursive: true });
  const record: RunRecord = {
    id: RUN,
    agent: 'fake:engineer',
    project: 'test',
    pid: 1,
    image: 'fake',
    command: 'fake',
    cwd: repo,
    log: sup.store.logPath(RUN),
    started_at: new Date().toISOString(),
    status: 'running',
    budget_minutes: 60,
    tokens: 0,
    scratch,
    token_sha256: createHash('sha256').update(TOKEN).digest('hex'),
  };
  sup.store.save(record);
  live.set(RUN, { record });
  /** The environment of a command inside the run, and of one the person types. */
  const inRun = {
    ...env,
    SWARMUP_AGENT: 'fake:engineer',
    SWARMUP_RUN: RUN,
    SWARMUP_RUN_TOKEN: TOKEN,
    SWARMUP_RUN_STATE_DIR: state,
    SWARMUP_SCRATCH: scratch,
  } as NodeJS.ProcessEnv;
  const person = { ...env, SWARMUP_AGENT: 'human:dawid' } as NodeJS.ProcessEnv;
  const swarmup = async (e: NodeJS.ProcessEnv, argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: e,
      cwd: repo,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  return { repo, state, scratch, sup, inRun, person, swarmup };
}

describe('swarmup run artifact', () => {
  it('keeps a file of the run, refuses one outside it, and works only inside a run', async () => {
    const { repo, inRun, person, swarmup, sup } = await world();
    writeFileSync(join(repo, 'shot.png'), 'png!');
    const kept = await swarmup(inRun, ['run', 'artifact', 'shot.png', '--label', 'Home page']);
    expect(kept.err).toBe('');
    expect(kept.out).toBe(`kept shot.png (4 B, image/png); run ${RUN} keeps 1 artifact(s)`);
    expect(sup.run(RUN).artifacts).toEqual([
      { name: 'shot.png', label: 'Home page', bytes: 4, type: 'image/png' },
    ]);
    const outside = join(temp(), 'secret.txt');
    writeFileSync(outside, 'x');
    const refused = await swarmup(inRun, ['run', 'artifact', outside]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("outside the run's scratch folder and worktree");
    const notInRun = await swarmup(person, ['run', 'artifact', 'shot.png']);
    expect(notInRun.code).toBe(2);
    expect(notInRun.err).toContain('works only inside a supervised run');
  });

  it('attaches what the run kept to its review, and prints it with swarmup artifact', async () => {
    const { scratch, inRun, person, swarmup } = await world();
    const made = await swarmup(person, ['new', 'check the page', '--to', 'fake:engineer']);
    expect(made.code).toBe(0);
    expect((await swarmup(inRun, ['start', 'T-0001', 'plan'])).code).toBe(0);
    writeFileSync(join(scratch, 'artifacts', 'report.txt'), 'all green');
    const review = await swarmup(inRun, ['review', 'T-0001', 'the page renders', '--force']);
    expect(review.err).not.toContain('not attached');
    expect(review.code).toBe(0);
    const listed = await swarmup(person, ['artifact', 'T-0001', '--json']);
    const items = (JSON.parse(listed.out) as { artifacts?: unknown[] }).artifacts ?? [
      JSON.parse(listed.out),
    ];
    expect(items).toContainEqual(
      expect.objectContaining({ kind: 'run', ref: 'report.txt', run: RUN, bytes: 9 }),
    );
    const n = items.findIndex((a) => (a as { ref: string }).ref === 'report.txt') + 1;
    const printed = await swarmup(person, ['artifact', 'T-0001', String(n)]);
    expect(printed.out).toBe('all green');

    const shown = await swarmup(person, ['runs', 'show', RUN.slice(-8)]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain(`${RUN} fake:engineer`);
    expect(shown.out).toMatch(/artifacts \(1\) in .*/);
    expect(shown.out).toMatch(/report\.txt\s+9 B\s+text\/plain/);
    expect(
      readFileSync(join(inRun.SWARMUP_RUN_STATE_DIR!, 'artifacts', RUN, 'report.txt'), 'utf8'),
    ).toBe('all green');
  });
});
