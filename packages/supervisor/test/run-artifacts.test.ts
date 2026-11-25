// Run artifacts (W4): swarmupd keeps what a run declares or writes into `<scratch>/artifacts/` in
// `<state>/artifacts/<run>/` with a manifest, within limits, refuses paths that leave the run's
// folders, prunes old folders, and serves them over the API.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OpsEvent } from '@swarmup/core';
import type { RunRecord } from '../src/index.js';
import {
  ArtifactRefused,
  artifactHeaders,
  DEFAULT_ARTIFACT_LIMITS,
  judgeArtifactsOf,
  keepRunArtifacts,
  opsdConfig,
  pruneRunArtifacts,
  NoRunArtifact,
  readManifest,
  readRunArtifact,
  runReviewArtifacts,
  safeName,
  startApi,
} from '../src/index.js';
import { ended, setup, temp } from './supervisor-setup.js';

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** A state folder and a run's scratch folder and worktree, with files in them. */
function folders() {
  const state = temp();
  const scratch = join(temp(), 'scratch', 'RUN1');
  const worktree = temp();
  mkdirSync(join(scratch, 'artifacts'), { recursive: true });
  return { state, scratch, worktree };
}

describe('keepRunArtifacts', () => {
  it('copies declared files and the artifacts folder with a manifest', async () => {
    const { state, scratch, worktree } = folders();
    writeFileSync(join(worktree, 'report.pdf'), '%PDF-1.4 fake');
    mkdirSync(join(scratch, 'artifacts', 'shots'));
    writeFileSync(join(scratch, 'artifacts', 'shots', 'home.png'), 'png-bytes');
    writeFileSync(join(scratch, 'artifacts', 'out.log'), 'line\n');
    const m = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [worktree],
      limits: DEFAULT_ARTIFACT_LIMITS,
      declare: { path: join(worktree, 'report.pdf'), label: 'The report' },
    });
    expect(m.artifacts.map((a) => [a.name, a.type, a.bytes, a.label, a.declared])).toEqual([
      ['report.pdf', 'application/pdf', 13, 'The report', true],
      // The folder's files in name order: `out.log` before `shots/`.
      ['out.log', 'text/plain', 5, undefined, undefined],
      ['home.png', 'image/png', 9, undefined, undefined],
    ]);
    expect(m.artifacts[2]!.sha256).toBe(sha('png-bytes'));
    const kept = join(state, 'artifacts', 'RUN1');
    expect(readFileSync(join(kept, 'home.png'), 'utf8')).toBe('png-bytes');
    expect((await readManifest(state, 'RUN1'))?.artifacts).toHaveLength(3);

    // A later keep takes the newest bytes, keeps names, and drops a file gone since.
    writeFileSync(join(worktree, 'report.pdf'), '%PDF-1.4 newer');
    writeFileSync(join(scratch, 'artifacts', 'out.log'), '');
    const again = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [worktree],
      limits: DEFAULT_ARTIFACT_LIMITS,
    });
    expect(again.artifacts.find((a) => a.name === 'report.pdf')!.sha256).toBe(
      sha('%PDF-1.4 newer'),
    );
    expect(again.artifacts.find((a) => a.name === 'out.log')!.bytes).toBe(0);
  });

  it('keeps distinct names for files of the same name and makes odd names safe', async () => {
    const { state, scratch } = folders();
    mkdirSync(join(scratch, 'artifacts', 'a'));
    mkdirSync(join(scratch, 'artifacts', 'b'));
    writeFileSync(join(scratch, 'artifacts', 'a', 'shot.png'), '1');
    writeFileSync(join(scratch, 'artifacts', 'b', 'shot.png'), '2');
    const m = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [],
      limits: DEFAULT_ARTIFACT_LIMITS,
    });
    expect(m.artifacts.map((a) => a.name)).toEqual(['shot.png', 'shot-2.png']);
    expect(safeName('../we ird:na*me?.txt')).toBe('we ird_na_me_.txt');
    expect(safeName('CON.txt')).toBe('_CON.txt');
    expect(safeName('...')).toBe('file');
  });

  it('keeps max_files files and max_mb megabytes, and names what it left out', async () => {
    const { state, scratch } = folders();
    for (const n of [1, 2, 3])
      writeFileSync(join(scratch, 'artifacts', `f${n}.txt`), 'x'.repeat(600));
    const byCount = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [],
      limits: { max_files: 2, max_mb: 25, keep_days: 30 },
    });
    expect(byCount.artifacts.map((a) => a.name)).toEqual(['f1.txt', 'f2.txt']);
    expect(byCount.skipped).toEqual([
      { path: join(scratch, 'artifacts', 'f3.txt'), why: 'over max_files (2)' },
    ]);
    // 0.001 MB is 1,049 bytes: one 600-byte file fits, the second does not.
    const bySize = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [],
      limits: { max_files: 20, max_mb: 0.001, keep_days: 30 },
    });
    expect(bySize.artifacts.map((a) => a.name)).toEqual(['f1.txt']);
    expect(bySize.skipped?.map((s) => s.why)).toEqual([
      'over max_mb (0.001 MB)',
      'over max_mb (0.001 MB)',
    ]);
    // The files kept before and left out now are gone from the kept folder.
    expect(existsSync(join(state, 'artifacts', 'RUN1', 'f2.txt'))).toBe(false);
    await expect(
      keepRunArtifacts({
        stateDir: state,
        run: 'RUN1',
        scratch,
        roots: [],
        limits: { max_files: 20, max_mb: 0.0001, keep_days: 30 },
        declare: { path: join(scratch, 'artifacts', 'f1.txt') },
      }),
    ).rejects.toThrow(/a run keeps 0.0001 MB at most/);
  });

  it('refuses paths outside the run folders, through .. or a junction, and never follows links', async () => {
    const { state, scratch, worktree } = folders();
    const outside = temp();
    writeFileSync(join(outside, 'secret.txt'), 'not yours');
    // A junction needs no admin rights on Windows; elsewhere it is a symlink to a folder.
    symlinkSync(outside, join(scratch, 'artifacts', 'escape'), 'junction');
    symlinkSync(outside, join(worktree, 'linked'), 'junction');
    const job = (path: string) =>
      keepRunArtifacts({
        stateDir: state,
        run: 'RUN1',
        scratch,
        roots: [worktree],
        limits: DEFAULT_ARTIFACT_LIMITS,
        declare: { path },
      });
    await expect(job(join(outside, 'secret.txt'))).rejects.toThrow(ArtifactRefused);
    await expect(job(join(worktree, '..', 'secret.txt'))).rejects.toThrow(/no such file|outside/);
    await expect(job(join(worktree, 'linked', 'secret.txt'))).rejects.toThrow(
      /outside the run's scratch folder and worktree/,
    );
    await expect(job(join(worktree, 'missing.png'))).rejects.toThrow(/no such file/);
    await expect(job(worktree)).rejects.toThrow(/is not a file/);
    // The sweep of the artifacts folder skips the junction.
    const m = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [worktree],
      limits: DEFAULT_ARTIFACT_LIMITS,
    });
    expect(m.artifacts).toEqual([]);
    expect(existsSync(join(state, 'artifacts', 'RUN1', 'secret.txt'))).toBe(false);
  });

  it('writes nothing for a run that kept nothing', async () => {
    const { state, scratch } = folders();
    const m = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [],
      limits: DEFAULT_ARTIFACT_LIMITS,
    });
    expect(m.artifacts).toEqual([]);
    expect(existsSync(join(state, 'artifacts', 'RUN1'))).toBe(false);
  });

  it('serves only one-segment names, even from a manifest edited by hand', async () => {
    const { state, scratch } = folders();
    writeFileSync(join(scratch, 'artifacts', 'report.pdf'), '%PDF');
    await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [],
      limits: DEFAULT_ARTIFACT_LIMITS,
    });
    expect((await readRunArtifact(state, 'RUN1', 'report.pdf')).data.toString()).toBe('%PDF');
    writeFileSync(join(state, 'secret.txt'), 'secret');
    const file = join(state, 'artifacts', 'RUN1', 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8'));
    for (const name of ['../../secret.txt', '..\\..\\secret.txt', '..']) {
      m.artifacts = [{ ...m.artifacts[0], name }];
      writeFileSync(file, JSON.stringify(m));
      await expect(readRunArtifact(state, 'RUN1', name)).rejects.toBeInstanceOf(NoRunArtifact);
    }
  });
});

describe('judgeArtifactsOf', () => {
  it("gives a rubric's artifacts input the files the latest review names, text with its text", async () => {
    const { state, scratch } = folders();
    writeFileSync(join(scratch, 'artifacts', 'home.png'), 'png');
    writeFileSync(join(scratch, 'artifacts', 'report.txt'), 'all green');
    const m = await keepRunArtifacts({
      stateDir: state,
      run: 'RUN1',
      scratch,
      roots: [],
      limits: DEFAULT_ARTIFACT_LIMITS,
    });
    const review = {
      id: 'E1',
      type: 'review',
      at: new Date().toISOString(),
      actor: 'fake:engineer',
      artifacts: [
        ...runReviewArtifacts('RUN1', m.artifacts),
        { kind: 'run', ref: 'gone.txt', run: 'RUN1' },
        { kind: 'file', ref: 'src/a.ts' },
      ],
    } as unknown as OpsEvent;
    expect(await judgeArtifactsOf(state, [review])).toEqual([
      { name: 'home.png', type: 'image/png', bytes: 3 },
      { name: 'report.txt', type: 'text/plain', bytes: 9, text: 'all green' },
    ]);
  });
});

describe('pruneRunArtifacts', () => {
  it('removes the kept folders of runs that ended more than keep_days ago', async () => {
    const state = temp();
    const day = 24 * 3_600_000;
    const now = Date.now();
    for (const id of ['OLD', 'NEW', 'LIVE', 'GONE']) {
      mkdirSync(join(state, 'artifacts', id), { recursive: true });
      writeFileSync(join(state, 'artifacts', id, 'a.txt'), 'x');
    }
    // A run swarmupd has no record of counts from the folder's last change.
    const old = new Date(now - 40 * day);
    utimesSync(join(state, 'artifacts', 'GONE'), old, old);
    const ends: Record<string, number | 'running'> = {
      OLD: now - 31 * day,
      NEW: now - 29 * day,
      LIVE: 'running',
    };
    const removed = await pruneRunArtifacts(state, 30, now, (id) => ends[id]);
    expect(removed).toBe(2);
    expect(existsSync(join(state, 'artifacts', 'OLD'))).toBe(false);
    expect(existsSync(join(state, 'artifacts', 'GONE'))).toBe(false);
    expect(existsSync(join(state, 'artifacts', 'NEW'))).toBe(true);
    expect(existsSync(join(state, 'artifacts', 'LIVE'))).toBe(true);
  });
});

describe('swarmupd.artifacts', () => {
  it('defaults to 20 files, 25 MB and 30 days, and refuses bad values', () => {
    expect(opsdConfig({ opsd: {} }).artifacts).toEqual({
      max_files: 20,
      max_mb: 25,
      keep_days: 30,
    });
    expect(opsdConfig({ opsd: { artifacts: { max_files: 5 } } } as never).artifacts).toEqual({
      max_files: 5,
      max_mb: 25,
      keep_days: 30,
    });
    expect(() => opsdConfig({ opsd: { artifacts: { max_mb: -1 } } } as never)).toThrow(
      /artifacts.max_mb/,
    );
    expect(() => opsdConfig({ opsd: { artifacts: { files: 1 } } } as never)).toThrow(
      /unknown key files/,
    );
  });
});

describe('artifactHeaders', () => {
  it('serves plain images inline and everything else as a download nobody sniffs', () => {
    expect(artifactHeaders({ name: 'a.png', type: 'image/png' }, 3)).toMatchObject({
      'content-type': 'image/png',
      'content-disposition': 'inline; filename="a.png"',
      'x-content-type-options': 'nosniff',
    });
    for (const [name, type] of [
      ['x.svg', 'image/svg+xml'],
      ['r.html', 'text/html'],
      ['tool.exe', 'application/octet-stream'],
    ]) {
      expect(artifactHeaders({ name: name!, type: type! }, 3)).toMatchObject({
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
      });
    }
  });
});

describe('run artifacts in swarmupd', () => {
  it('keeps what a run wrote into its artifacts folder when it ends', async () => {
    const promptFile = join(temp(), 'prompt.txt');
    let now = Date.now();
    const { sup, as, state } = setup({
      mode: 'artifacts',
      now: () => now,
      env: { FAKE_PROMPT: promptFile },
    });
    as('human:dawid').newTask({ title: 'a', owner: 'fake:engineer' });
    const run = sup.launch({ agent: 'fake:engineer', task: '1' });
    const r = await ended(sup, run.id);
    expect(readFileSync(promptFile, 'utf8')).toContain('$SWARMUP_SCRATCH/artifacts/');
    expect(sup.store.get(r.id)?.artifacts).toEqual([
      { name: 'report.txt', bytes: 9, type: 'text/plain' },
      { name: 'home.png', bytes: 7, type: 'image/png' },
    ]);
    const m = await readManifest(state, r.id);
    expect(m?.artifacts.map((a) => a.sha256)).toEqual([
      sha('all green'),
      sha(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])),
    ]);
    expect(readFileSync(join(state, 'artifacts', r.id, 'report.txt'), 'utf8')).toBe('all green');
    // Housekeeping removes them `keep_days` (30) after the run ended.
    await sup.housekeep();
    expect(existsSync(join(state, 'artifacts', r.id))).toBe(true);
    now += 31 * 24 * 3_600_000;
    await sup.housekeep();
    expect(existsSync(join(state, 'artifacts', r.id))).toBe(false);
  });

  it('declares and serves run artifacts over the API: the run declares, anyone reads', async () => {
    const { sup, repo } = setup();
    const api = await startApi(sup, {
      port: 0,
      token: 'full-token',
      version: 't',
      build: '1',
      onShutdown: () => {},
    });
    try {
      const scratch = join(sup.store.dir, 'scratch', 'RUNAAAAAAAAA');
      mkdirSync(join(scratch, 'artifacts'), { recursive: true });
      writeFileSync(join(repo, 'shot.png'), 'png!');
      writeFileSync(join(scratch, 'artifacts', 'notes.md'), '# Notes');
      const live = (sup as unknown as { live: Map<string, { record: RunRecord }> }).live;
      const register = (id: string, token: string): RunRecord => {
        const record: RunRecord = {
          id,
          agent: 'fake:engineer',
          pid: 1,
          image: 'fake',
          command: 'fake',
          cwd: repo,
          log: sup.store.logPath(id),
          started_at: new Date().toISOString(),
          status: 'running',
          budget_minutes: 60,
          tokens: 0,
          scratch: join(sup.store.dir, 'scratch', id),
          token_sha256: sha(token),
        };
        sup.store.save(record);
        live.set(id, { record });
        return record;
      };
      register('RUNAAAAAAAAA', 'token-a');
      register('RUNBBBBBBBBB', 'token-b');
      const call = async (token: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${api.port}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const type = res.headers.get('content-type') ?? '';
        return {
          status: res.status,
          headers: res.headers,
          data: type.includes('json')
            ? ((await res.json()) as Record<string, unknown>)
            : await res.text(),
        };
      };
      const path = '/api/runs/RUNAAAAAAAAA/artifacts';
      // The person's token and another run's token may not declare for the run.
      expect(
        (await call('full-token', 'POST', path, { path: join(repo, 'shot.png') })).status,
      ).toBe(403);
      expect((await call('token-b', 'POST', path, { path: join(repo, 'shot.png') })).status).toBe(
        403,
      );
      // Outside the run's folders: refused with 400.
      const outside = join(temp(), 'x.txt');
      writeFileSync(outside, 'x');
      const refused = await call('token-a', 'POST', path, { path: outside });
      expect(refused.status).toBe(400);
      const ok = await call('token-a', 'POST', path, {
        path: join(repo, 'shot.png'),
        label: 'Home',
      });
      expect(ok.status).toBe(200);
      expect((ok.data as { artifacts: unknown[] }).artifacts).toEqual([
        expect.objectContaining({ name: 'shot.png', label: 'Home', declared: true }),
        expect.objectContaining({ name: 'notes.md', type: 'text/markdown' }),
      ]);
      expect(sup.run('RUNAAAAAAAAA').artifacts?.map((a) => a.name)).toEqual([
        'shot.png',
        'notes.md',
      ]);
      // Anyone reads: the person, the run, and another run such as a reviewer.
      for (const token of ['full-token', 'token-a', 'token-b']) {
        const list = await call(token, 'GET', path);
        expect(list.status).toBe(200);
        expect((list.data as { artifacts: unknown[] }).artifacts).toHaveLength(2);
      }
      const raw = await call('token-b', 'GET', `${path}/shot.png`);
      expect(raw.status).toBe(200);
      expect(raw.headers.get('content-type')).toBe('image/png');
      expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
      const md = await call('full-token', 'GET', `${path}/notes.md`);
      expect(md.headers.get('content-type')).toBe('application/octet-stream');
      expect(md.headers.get('content-disposition')).toContain('attachment');
      const view = await call('full-token', 'GET', `${path}/notes.md?view=1`);
      expect(view.data).toMatchObject({ kind: 'text', text: '# Notes', type: 'text/markdown' });
      const image = await call('full-token', 'GET', `${path}/shot.png?view=1`);
      expect(image.data).toMatchObject({
        kind: 'image',
        data: `data:image/png;base64,${Buffer.from('png!').toString('base64')}`,
      });
      expect((await call('full-token', 'GET', `${path}/missing.txt`)).status).toBe(404);
      expect((await call('full-token', 'GET', `${path}/..%2Fmanifest.json`)).status).toBe(404);
      // An ended run declares nothing more.
      live.delete('RUNAAAAAAAAA');
      sup.store.save({ ...sup.store.get('RUNAAAAAAAAA')!, status: 'ended' });
      expect((await call('full-token', 'GET', path)).status).toBe(200);
      await expect(
        sup.keepArtifacts('RUNAAAAAAAAA', { path: join(repo, 'shot.png') }),
      ).rejects.toThrow(/has ended/);
    } finally {
      await api.close();
    }
  });
});
