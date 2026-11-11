import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../src/runs.js';
import { RunStore } from '../src/runs.js';

const record = (id: string, status: RunRecord['status']): RunRecord => ({
  id,
  agent: 'claude:engineer',
  pid: 1,
  image: 'node.exe',
  status,
  command: 'claude',
  cwd: tmpdir(),
  started_at: '2026-11-09T10:00:00.000Z',
  budget_minutes: 60,
  tokens: 0,
  log: join('logs', `${id}.log`),
});

describe('run store list cache', () => {
  it('serves ended runs from memory and keeps them current through save', () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), 'runs-cache-')));
    store.save(record('01A', 'ended'));
    store.save(record('01B', 'running'));
    expect(store.list().map((r) => [r.id, r.status])).toEqual([
      ['01B', 'running'],
      ['01A', 'ended'],
    ]);
    // A caller that changes a listed record changes nothing for the next caller.
    store.list()[1]!.agent = 'changed';
    expect(store.list()[1]!.agent).toBe('claude:engineer');
    // A save after the end replaces the cached copy.
    store.save({ ...record('01A', 'ended'), tokens: 42 });
    expect(store.list()[1]).toMatchObject({ id: '01A', tokens: 42 });
  });

  it('reads a running record from disk each time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runs-cache-'));
    const store = new RunStore(dir);
    store.save(record('01C', 'running'));
    expect(store.list()[0]!.status).toBe('running');
    // Another writer ends it on disk: the next list shows that.
    writeFileSync(join(dir, 'runs', '01C.json'), JSON.stringify(record('01C', 'ended')));
    expect(store.list()[0]!.status).toBe('ended');
  });
});
