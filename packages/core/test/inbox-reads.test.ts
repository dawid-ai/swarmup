// One inbox read checks the store once (AO-0278): the stranded list and the dependency lookups
// reuse the tasks the inbox has just read, and channel messages are parsed once per file. Every
// new read still sees what was written since the last one.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Root } from '../src/index.js';
import { readChannel } from '../src/channels.js';
import { setup } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A store where `claude:engineer` is the only defined agent, so other agent ids strand work. */
function withAgent(): ReturnType<typeof setup> {
  const s = setup();
  writeFileSync(join(s.rootDir, 'agents', 'claude-engineer.md'), '---\nid: claude:engineer\n---\n');
  return s;
}

describe('one inbox read (AO-0278)', () => {
  it('reads the tasks once, stranded work included', () => {
    const { as } = withAgent();
    const h = as('human:dawid', { force: true });
    h.newTask({ title: 'fine', owner: 'claude:engineer' });
    h.newTask({ title: 'nobody takes this', owner: 'codex:ghost' });
    const states = vi.spyOn(Root.prototype, 'states');
    const inbox = as('human:dawid').inbox();
    expect(states).toHaveBeenCalledTimes(1);
    expect(inbox.filter((i) => i.kind === 'stranded').map((i) => i.task)).toEqual(['T-0002']);
  });

  it('lists the same stranded tasks from given views as from a fresh read', () => {
    const { as } = withAgent();
    const h = as('human:dawid', { force: true });
    h.newTask({ title: 'fine', owner: 'claude:engineer' });
    h.newTask({ title: 'nobody takes this', owner: 'codex:ghost' });
    h.newTask({ title: 'nor this', owner: 'codex:other' });
    const ws = as('human:dawid');
    const fresh = ws.stranded();
    expect(fresh.map((s) => s.view.meta.id)).toEqual(['T-0002', 'T-0003']);
    expect(ws.stranded(ws.snapshot())).toEqual(fresh);
    // Archived tasks in the given views strand nothing.
    expect(ws.stranded(ws.snapshot().map((v) => ({ ...v, archived: true })))).toEqual([]);
  });

  it('sees a task written after the last read', () => {
    const { as } = withAgent();
    const h = as('human:dawid', { force: true });
    h.newTask({ title: 'fine', owner: 'claude:engineer' });
    const reader = as('human:dawid');
    expect(reader.inbox().filter((i) => i.kind === 'stranded')).toEqual([]);
    h.newTask({ title: 'nobody takes this', owner: 'codex:ghost' });
    as('claude:engineer').comment('1', 'a question for you', 'human:dawid');
    // The same workspace, read again: nothing is kept between two inbox calls.
    const next = reader.inbox();
    expect(next.filter((i) => i.kind === 'stranded').map((i) => i.task)).toEqual(['T-0002']);
    expect(next.filter((i) => i.kind === 'message').map((i) => i.task)).toEqual(['T-0001']);
  });
});

describe('dependencies of tasks just read (AO-0278)', () => {
  it('resolves them without looking at the disk, with the same result', () => {
    const { as } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'first', owner: 'claude:engineer' });
    h.newTask({ title: 'second', owner: 'claude:engineer' });
    h.newTask({ title: 'child', owner: 'claude:engineer', parent: '1' });
    const eng = as('claude:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'waits for the first', { on: ['1'] });
    const hasTask = vi.spyOn(Root.prototype, 'hasTask');
    const views = as('human:dawid').snapshot();
    const blocked = views.find((v) => v.meta.id === 'T-0002')!;
    expect(blocked.status).toBe('blocked');
    expect(blocked.unblocked).toBeFalsy();
    expect(hasTask).not.toHaveBeenCalled();
    hasTask.mockRestore();
    // The tasks that wait on T-0001: the blocked one and the open child.
    expect(as('human:dawid').blocks('1').direct.sort()).toEqual(['T-0002', 'T-0003']);
    // Closing the dependency shows on the next read.
    eng.start('1', 'plan');
    eng.done('1', 'done');
    const after = as('human:dawid')
      .snapshot()
      .find((v) => v.meta.id === 'T-0002')!;
    expect(after.unblocked).toBe(true);
  });

  it('still finds no task for a dependency whose folder is gone', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    h.newTask({ title: 'first', owner: 'claude:engineer' });
    h.newTask({ title: 'second', owner: 'claude:engineer' });
    const eng = as('claude:engineer');
    eng.start('2', 'plan');
    eng.block('2', 'waits for the first', { on: ['1'] });
    const root = new Root(rootDir);
    root.renameRetry(root.liveDir('T-0001'), join(rootDir, 'gone'));
    const views = as('human:dawid').snapshot();
    expect(views.map((v) => v.meta.id)).toEqual(['T-0002']);
    // A dependency with no task never closes, so the task stays blocked, as before this change.
    expect(views[0]!.status).toBe('blocked');
    expect(views[0]!.unblocked).toBe(false);
  });
});

describe('channel messages read twice (AO-0278)', () => {
  it('gives equal messages, a new copy each time, and sees new posts', () => {
    const { as, rootDir } = setup();
    const eng = as('claude:engineer');
    eng.post('dev', 'Ready for a look, @human:dawid');
    const root = new Root(rootDir);
    const first = readChannel(root, 'dev');
    expect(first).toHaveLength(1);
    // A caller that changes its copy does not change what the next read gives.
    first[0]!.body = 'changed by the caller';
    first[0]!.mentions?.push('codex:qa');
    const second = readChannel(root, 'dev');
    expect(second[0]!.body).toBe('Ready for a look, @human:dawid');
    expect(second[0]!.mentions).toEqual(['human:dawid']);

    const reader = as('human:dawid');
    const mentions = (): string[] =>
      reader
        .inbox()
        .filter((i) => i.kind === 'mention')
        .map((i) => i.summary);
    expect(mentions()).toEqual(['Ready for a look, @human:dawid']);
    eng.post('dev', 'One more thing, @human:dawid');
    expect(mentions()).toEqual(['Ready for a look, @human:dawid', 'One more thing, @human:dawid']);
  });
});
