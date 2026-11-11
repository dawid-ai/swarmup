import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReads, readShown, Root, writeRead, writeShown } from '../src/index.js';
import { setup } from './helpers.js';

describe('learn-note reads (AO-0186)', () => {
  it('writes one file per read in a month folder and reads them back, oldest first', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const t1 = Date.parse('2026-10-31T23:00:00Z');
    const t2 = Date.parse('2026-11-01T01:00:00Z');
    writeRead(root, { actor: 'codex:engineer', ref: 'git/rebase', task: 'T-0002' }, t2);
    const first = writeRead(root, { actor: 'claude:engineer', ref: 'git/rebase' }, t1);
    expect(readdirSync(join(rootDir, 'kb-reads')).sort()).toEqual(['2026-10', '2026-11']);
    const [name] = readdirSync(join(rootDir, 'kb-reads', '2026-10'));
    expect(name).toBe(`${first.id}-claude-engineer.json`);
    expect(JSON.parse(readFileSync(join(rootDir, 'kb-reads', '2026-10', name!), 'utf8'))).toEqual({
      actor: 'claude:engineer',
      at: '2026-10-31T23:00:00.000Z',
      ref: 'git/rebase',
    });
    expect(readReads(root).map((r) => [r.actor, r.task])).toEqual([
      ['claude:engineer', undefined],
      ['codex:engineer', 'T-0002'],
    ]);
    // A window skips month folders wholly outside it.
    expect(readReads(root, { from: t2 }).map((r) => r.actor)).toEqual(['codex:engineer']);
    expect(readReads(root, { to: t1 }).map((r) => r.actor)).toEqual(['claude:engineer']);
  });

  it('counts reads per note and marks notes unread in the window as stale (AO-0152)', () => {
    const { rootDir, as } = setup();
    const root = new Root(rootDir);
    const day = (d: number) => Date.parse(`2026-11-${String(d).padStart(2, '0')}T12:00:00Z`);
    let now = day(1);
    const ws = as('codex:engineer', { now: () => now });
    ws.learn({ topic: 'git', title: 'Rebase', body: 'Rebase onto v2.' });
    ws.learn({ topic: 'git', title: 'Never read', body: 'Nobody reads this.' });
    ws.learn({ topic: 'ui', title: 'Grid gaps', body: 'Use gap.' });
    now = day(20);
    ws.learn({ topic: 'ui', title: 'New note', body: 'Too new to prune.' });
    writeRead(root, { actor: 'claude:engineer', ref: 'git/rebase' }, day(2));
    writeRead(root, { actor: 'claude:engineer', ref: 'git/rebase' }, day(25));
    writeRead(root, { actor: 'codex:engineer', ref: 'ui/grid-gaps' }, day(3));
    // A read of a deleted note counts for nothing.
    writeRead(root, { actor: 'codex:engineer', ref: 'ui/gone' }, day(26));
    now = day(30);

    const res = ws.kbUsage({ days: 14 });
    expect(res.since).toBe(new Date(day(16)).toISOString());
    expect(res.trackedSince).toBe(new Date(day(2)).toISOString());
    const rows = Object.fromEntries(
      res.notes.map((u) => [u.note.ref, [u.reads, u.recent, u.lastRead?.slice(0, 10), u.stale]]),
    );
    expect(rows).toEqual({
      'git/rebase': [2, 1, '2026-11-25', false],
      'git/never-read': [0, 0, undefined, true],
      'ui/grid-gaps': [1, 0, '2026-11-03', true],
      'ui/new-note': [0, 0, undefined, false],
    });
    expect(
      ws
        .kbUsage({ days: 14, topic: 'ui' })
        .notes.map((u) => u.note.ref)
        .sort(),
    ).toEqual(['ui/grid-gaps', 'ui/new-note']);
    // A window of 0 days makes every unread-today note stale, the new one included.
    expect(
      ws
        .kbUsage({ days: 0 })
        .notes.filter((u) => u.stale)
        .map((u) => u.note.ref),
    ).toHaveLength(4);
    expect(() => ws.kbUsage({ days: -1 })).toThrow(/bad --days/);
  });

  it('counts notes shown in run prompts and keeps them off the stale list (AO-0152)', () => {
    const { rootDir, as } = setup();
    const root = new Root(rootDir);
    const day = (d: number) => Date.parse(`2026-11-${String(d).padStart(2, '0')}T12:00:00Z`);
    let now = day(1);
    const ws = as('codex:engineer', { now: () => now });
    const task = as('human:dawid').newTask({ title: 'Port the board' });
    ws.learn({ topic: 'git', title: 'Rebase', body: 'Rebase onto v2.' });
    ws.learn({ topic: 'git', title: 'Shown only', body: 'Listed in prompts, never opened.' });
    ws.learn({ topic: 'git', title: 'Shown long ago', body: 'Listed once, early.' });
    ws.learn({ topic: 'git', title: 'Unused', body: 'Nobody sees this.' });
    const note = (ref: string) => ws.kbNote(ref);

    now = day(3);
    const [first] = ws.recordNotesShown([note('git/shown-long-ago'), note('git/rebase')], {
      actor: 'claude:engineer',
      task: task.id,
      run: 'RUN1',
    });
    expect(first).toMatchObject({
      root: root.name,
      actor: 'claude:engineer',
      at: new Date(day(3)).toISOString(),
      refs: ['git/shown-long-ago', 'git/rebase'],
      task: task.id,
      run: 'RUN1',
    });
    expect(first).not.toHaveProperty('task_root');
    now = day(24);
    // A note listed twice in one prompt counts once.
    ws.recordNotesShown([note('git/shown-only'), note('git/shown-only')], {
      actor: 'claude:engineer',
    });
    now = day(26);
    ws.recordNotesShown([note('git/shown-only')], { actor: 'codex:qa' });
    // A listing of a deleted note counts for nothing.
    writeShown(root, { actor: 'codex:qa', refs: ['git/gone'] }, day(27));
    writeRead(root, { actor: 'claude:engineer', ref: 'git/rebase' }, day(25));
    expect(ws.recordNotesShown([], { actor: 'codex:qa' })).toEqual([]);
    expect(() => writeShown(root, { actor: 'codex:qa', refs: [] }, day(27))).toThrow(/at least/);

    // One file per prompt, in a month folder, outside kb-reads/.
    const files = readdirSync(join(rootDir, 'kb-shown', '2026-11'));
    expect(files).toHaveLength(4);
    expect(files).toContain(`${first!.id}-claude-engineer.json`);
    expect(readdirSync(join(rootDir, 'kb-reads', '2026-11'))).toHaveLength(1);
    expect(readShown(root).map((s) => s.refs.join(','))).toEqual([
      'git/shown-long-ago,git/rebase',
      'git/shown-only',
      'git/shown-only',
      'git/gone',
    ]);

    now = day(30);
    const res = ws.kbUsage({ days: 14 });
    expect(res.trackedSince).toBe(new Date(day(25)).toISOString());
    expect(res.shownSince).toBe(new Date(day(3)).toISOString());
    const rows = Object.fromEntries(
      res.notes.map((u) => [
        u.note.ref,
        [u.reads, u.shown, u.recentShown, u.lastShown?.slice(8, 10), u.lastUsed?.slice(8, 10)],
      ]),
    );
    expect(rows).toEqual({
      'git/rebase': [1, 1, 0, '03', '25'],
      'git/shown-only': [0, 2, 2, '26', '26'],
      'git/shown-long-ago': [0, 1, 0, '03', '03'],
      'git/unused': [0, 0, 0, undefined, undefined],
    });
    // Shown in the window is enough to stay; shown only before it is not.
    expect(
      res.notes
        .filter((u) => u.stale)
        .map((u) => u.note.ref)
        .sort(),
    ).toEqual(['git/shown-long-ago', 'git/unused']);
  });

  it('skips damaged shown records', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const good = writeShown(
      root,
      { actor: 'claude:engineer', refs: ['a/b'] },
      Date.parse('2026-11-02T00:00Z'),
    );
    const dir = join(rootDir, 'kb-shown', '2026-11');
    writeFileSync(join(dir, '01M6ZZZZZZZZZZZZZZZZZZZZZZ-claude-engineer.json'), '{not json');
    writeFileSync(
      join(dir, '01M6ZZZZZZZZZZZZZZZZZZZZZY-claude-engineer.json'),
      '{"actor":"x","at":"2026-11-02T00:00:00Z","refs":[]}',
    );
    writeFileSync(
      join(dir, '01M6ZZZZZZZZZZZZZZZZZZZZZX-claude-engineer.json'),
      '{"actor":"x","at":"2026-11-02T00:00:00Z","refs":"a/b"}',
    );
    expect(readShown(root).map((s) => s.id)).toEqual([good.id]);
  });

  it('reports no tracking start before the first read', () => {
    const { as } = setup();
    const ws = as('codex:engineer');
    ws.learn({ topic: 'git', title: 'Rebase', body: 'Rebase onto v2.' });
    const res = ws.kbUsage();
    expect(res.trackedSince).toBeUndefined();
    expect(res.notes.map((u) => [u.note.ref, u.reads, u.stale])).toEqual([
      ['git/rebase', 0, false],
    ]);
  });

  it('skips damaged files and names it did not write', () => {
    const { rootDir } = setup();
    const root = new Root(rootDir);
    const good = writeRead(
      root,
      { actor: 'claude:engineer', ref: 'a/b' },
      Date.parse('2026-11-02T00:00Z'),
    );
    const dir = join(rootDir, 'kb-reads', '2026-11');
    writeFileSync(join(dir, '01M6ZZZZZZZZZZZZZZZZZZZZZZ-claude-engineer.json'), '{not json');
    writeFileSync(join(dir, '01M6ZZZZZZZZZZZZZZZZZZZZZY-claude-engineer.json'), '{"actor":"x"}');
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    mkdirSync(join(rootDir, 'kb-reads', 'misc'));
    writeFileSync(
      join(rootDir, 'kb-reads', 'misc', `${good.id}-x.json`),
      readFileSync(join(dir, `${good.id}-claude-engineer.json`)),
    );
    expect(readReads(root).map((r) => r.id)).toEqual([good.id]);
  });
});
