// swarmupd's own state on this PC: `state.db` in the state folder, for runs and merge attempts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateDb } from '../src/index.js';

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
    expect(first.version).toBe(1);
    first.saveRun(
      { id: 'R1', agent: 'claude:engineer', status: 'ended', started_at: '2026-11-19T00:00:00Z' },
      { id: 'R1', agent: 'claude:engineer' },
    );
    const second = open(d);
    expect(second.version).toBe(1);
    expect(second.runCount()).toBe(1);
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
