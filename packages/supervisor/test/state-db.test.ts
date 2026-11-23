// swarmupd's own state on this PC: `state.db` in the state folder, for runs and merge attempts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateDb, StoredMap, StoredSet } from '../src/index.js';

const dirs: string[] = [];
const dbs: StateDb[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function open(dir?: string): StateDb {
  const d = dir ?? mkdtempSync(join(tmpdir(), 'swarmup-state-'));
  if (!dir) dirs.push(d);
  const db = new StateDb(d);
  dbs.push(db);
  return db;
}

describe('state.db', () => {
  it('makes its tables once, and a second open of the same file changes nothing', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarmup-state-'));
    dirs.push(d);
    const first = open(d);
    expect(first.version).toBe(5);
    first.saveRun(
      { id: 'R1', agent: 'claude:engineer', status: 'ended', started_at: '2026-11-19T00:00:00Z' },
      { id: 'R1', agent: 'claude:engineer' },
    );
    const second = open(d);
    expect(second.version).toBe(5);
    expect(second.runCount()).toBe(1);
  });

  it('keeps one definition snapshot per hash and the hash of each run (W5)', () => {
    const db = open();
    const snap = {
      hash: 'd:abc',
      root: 'demo',
      commit: null,
      created_at: '2026-11-21T00:00:00Z',
      files: [{ path: 'swarm.yaml', sha256: 'f00', text: 'swarmup_defs: 1\n' }],
    };
    expect(db.saveDefinitions(snap)).toBe(true);
    // The first sight of a hash wins: a later save with a commit changes nothing.
    expect(db.saveDefinitions({ ...snap, commit: 'c1', files: [] })).toBe(false);
    expect(db.definitions('d:abc')).toEqual(snap);
    expect(db.definitions('d:none')).toBeUndefined();
    db.saveRunDefs('R1', 'demo', 'd:abc');
    db.saveRunDefs('R2', 'demo', 'd:abc');
    db.saveRunDefs('R2', 'demo', 'd:abc');
    expect(db.runsWithDefs('d:abc')).toEqual(['R1', 'R2']);
  });

  it('keeps bench attempts, one row per run, entry and attempt (W5)', () => {
    const db = open();
    const row = {
      run: 'demo-20261123-100000',
      set: 'demo',
      entry: 'E-1',
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
      wall_ms: 60_000,
      started_at: '2026-11-23T10:00:00.000Z',
      summary_at: '2026-11-23T10:05:00.000Z',
    };
    const variant = {
      ...row,
      run: 'demo-20261123-110000',
      variant: 'tests-first',
      pass_rate: 1,
      cost_estimated: true,
      started_at: '2026-11-23T11:00:00.000Z',
    };
    db.saveBenchResults([row, variant]);
    // A judged-again summary replaces the run's rows.
    db.saveBenchResults([{ ...row, pass_rate: 0.75, summary_at: '2026-11-23T12:00:00.000Z' }]);
    expect(db.benchResults().map((r) => [r.run, r.pass_rate, r.cost_estimated])).toEqual([
      ['demo-20261123-110000', 1, true],
      ['demo-20261123-100000', 0.75, false],
    ]);
    expect(db.benchResults({ variant: 'tests-first' })).toEqual([variant]);
    expect(db.benchResults({ set: 'other' })).toEqual([]);
    expect(db.benchResults({ agent: 'claude:engineer', limit: 1 })).toHaveLength(1);
    expect(db.benchRecorded()).toEqual(
      new Map([
        ['demo-20261123-100000', '2026-11-23T12:00:00.000Z'],
        ['demo-20261123-110000', '2026-11-23T10:05:00.000Z'],
      ]),
    );
  });

  it('keeps run records, replaces one by its id, and imports the run files it lacks once', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarmup-state-'));
    dirs.push(d);
    mkdirSync(join(d, 'runs'));
    const rec = (id: string, status: string) => ({
      id,
      agent: 'codex:engineer',
      task: 'T-0001',
      root: 'demo',
      status,
      started_at: `2026-11-19T00:00:0${id.slice(-1)}Z`,
    });
    writeFileSync(join(d, 'runs', 'R1.json'), JSON.stringify(rec('R1', 'ended')));
    writeFileSync(join(d, 'runs', 'R2.json'), JSON.stringify(rec('R2', 'running')));
    writeFileSync(join(d, 'runs', 'bad.json'), '{ not json');
    const db = open(d);
    const toRow = (r: unknown) => r as ReturnType<typeof rec>;
    expect(db.importRunFiles(toRow)).toBe(2);
    expect(db.importRunFiles(toRow)).toBe(0);
    db.saveRun(rec('R2', 'ended'), { ...rec('R2', 'ended'), exit: 0 });
    expect(db.runCount()).toBe(2);
    expect(db.run('R2')).toMatchObject({ status: 'ended', exit: 0 });
    expect(db.run('R9')).toBeUndefined();
  });

  it('keeps merge state across a reopen, and works as a plain map without a state.db', () => {
    const d = mkdtempSync(join(tmpdir(), 'swarmup-state-'));
    dirs.push(d);
    const num = { encode: String, decode: Number };
    const looks = new StoredMap(open(d), 'looks', num);
    looks.set('demo/T-0001', 2).set('demo/T-0002', 1);
    looks.delete('demo/T-0002');
    const timedOut = new StoredSet(open(d), 'timed-out');
    timedOut.add('demo/T-0003');

    const again = new StoredMap(open(d), 'looks', num);
    expect(again.get('demo/T-0001')).toBe(2);
    expect(again.has('demo/T-0002')).toBe(false);
    expect(new StoredSet(open(d), 'timed-out').has('demo/T-0003')).toBe(true);
    // Kinds do not mix.
    expect(new StoredSet(open(d), 'looks').has('demo/T-0003')).toBe(false);

    const plain = new StoredMap<number>(null, 'looks', num);
    plain.set('x', 1);
    expect(plain.get('x')).toBe(1);
  });

  it('records merge attempts, ends each once, and counts them by outcome', () => {
    const db = open();
    const a = db.mergeStarted({
      ref: 'demo/T-0001',
      root: 'demo',
      what: 'abc1234 on branch x',
      commit: 'abc1234',
      branch: 'x',
      at: '2026-11-19T10:00:00Z',
    });
    db.mergeEnded(a, 'conflict', '2026-11-19T10:01:00Z', 'code.txt');
    // An attempt ends once: a later outcome does not overwrite it.
    db.mergeEnded(a, 'merged', '2026-11-19T10:02:00Z');
    const b = db.mergeStarted({
      ref: 'demo/T-0001',
      root: 'demo',
      what: 'w',
      at: '2026-11-19T11:00:00Z',
    });
    db.mergeEnded(b, 'merged', '2026-11-19T11:05:00Z', 'Merged', 'def5678');
    db.mergeStarted({ ref: 'demo/T-0002', root: 'demo', what: 'w', at: '2026-11-19T12:00:00Z' });

    const one = db.mergeAttempts('demo/T-0001');
    expect(one.map((x) => x.outcome)).toEqual(['merged', 'conflict']);
    expect(one[1]).toMatchObject({ commit: 'abc1234', branch: 'x', reason: 'code.txt' });
    expect(one[0]).toMatchObject({ head: 'def5678' });
    expect(db.mergeAttempts()).toHaveLength(3);
    expect(db.mergeCounts()).toEqual(
      expect.arrayContaining([
        { outcome: 'merged', count: 1 },
        { outcome: 'conflict', count: 1 },
        { outcome: 'running', count: 1 },
      ]),
    );
    expect(db.mergeCounts('2026-11-19T11:30:00Z')).toEqual([{ outcome: 'running', count: 1 }]);
  });
});
