// Learn-note promotion (W6): candidates that keep mattering, and archiving notes a role file now
// states.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KbNote, KbRead, KbShown } from '../src/index.js';
import { parseDoc, promotionCandidates, Root, writeRead, writeShown } from '../src/index.js';
import { setup } from './helpers.js';

const day = (d: number): number => Date.parse(`2026-11-${String(d).padStart(2, '0')}T12:00:00Z`);
const iso = (d: number): string => new Date(day(d)).toISOString();

function note(ref: string, title: string, author = 'claude:engineer'): KbNote {
  const [topic, slug] = ref.split('/') as [string, string];
  return {
    title,
    topic,
    author,
    created_at: iso(1),
    root: 'test',
    slug,
    ref,
    file: `${ref}.md`,
    body: 'Body.',
  };
}

const shownAt = (actor: string, refs: string[], d: number): KbShown => ({
  root: 'test',
  id: `S${d}`,
  actor,
  at: iso(d),
  refs,
});
const readAt = (actor: string, ref: string, d: number): KbRead => ({
  root: 'test',
  id: `R${d}`,
  actor,
  at: iso(d),
  ref,
});

describe('promotion candidates (W6)', () => {
  it('picks notes shown often, read often or learned again, and says why and for whom', () => {
    const notes = [
      note('git/rebase', 'Rebase onto main before review'),
      note('git/stash', 'Stash before switching'),
      note('ui/grid', 'Grid gaps in cards'),
      note('ui/grid-again', 'Grid gaps in the cards', 'codex:engineer'),
      note('ops/quiet', 'Quiet note'),
    ];
    const shown = [
      ...[20, 21, 22, 23].map((d) => shownAt('claude:engineer', ['git/rebase'], d)),
      shownAt('codex:qa', ['git/rebase', 'ops/quiet'], 24),
      // Outside the window, and a person's record: neither counts.
      shownAt('claude:engineer', ['ops/quiet'], 2),
      ...[20, 21, 22, 23, 24].map((d) => shownAt('human:dawid', ['ops/quiet'], d)),
    ];
    const reads = [20, 21, 22].map((d) => readAt('codex:engineer', 'git/stash', d));
    const out = promotionCandidates(notes, reads, shown, { now: day(30), days: 14 });
    expect(out.map((c) => [c.note.ref, c.why, c.for])).toEqual([
      ['git/rebase', ['shown in 5 run prompts in 14 days'], ['claude:engineer']],
      ['git/stash', ['read 3 times in 14 days'], ['codex:engineer']],
      // Learned again with no use in the window: for the agents that wrote it.
      ['ui/grid', ['learned again as ui/grid-again'], ['claude:engineer', 'codex:engineer']],
      ['ui/grid-again', ['learned again as ui/grid'], ['claude:engineer', 'codex:engineer']],
    ]);
    expect(out[0]!.agents).toEqual([
      { agent: 'claude:engineer', shown: 4, reads: 0 },
      { agent: 'codex:qa', shown: 1, reads: 0 },
    ]);
    // The same ref in another root is a copy, not a lesson learned again.
    const copy = { ...notes[1]!, root: 'mirror' };
    expect(
      promotionCandidates([notes[1]!, copy], [], [], { now: day(30) }).map((c) => c.note.ref),
    ).toEqual([]);
    // Lower thresholds pick more.
    const loose = promotionCandidates(notes, reads, shown, {
      now: day(30),
      days: 14,
      minShown: 1,
    });
    expect(loose.map((c) => c.note.ref)).toContain('ops/quiet');
  });
});

describe('kb promote and archive (W6)', () => {
  function world() {
    const w = setup();
    const root = new Root(w.rootDir);
    let now = day(1);
    const opts = { now: () => now };
    const agent = w.as('claude:engineer', opts);
    agent.learn({ topic: 'git', title: 'Rebase onto main', body: 'Rebase before review.' });
    agent.learn({ topic: 'ui', title: 'Grid gaps', body: 'Use gap.' });
    for (const d of [20, 21, 22, 23, 24]) {
      writeShown(root, { actor: 'claude:engineer', refs: ['git/rebase-onto-main'] }, day(d));
    }
    writeRead(root, { actor: 'codex:qa', ref: 'ui/grid-gaps' }, day(25));
    now = day(30);
    return { ...w, root, opts, agent, person: w.as('human:dawid', opts) };
  }

  it('lists candidates, narrowed by agent and topic', () => {
    const w = world();
    const res = w.person.kbPromote();
    expect(res.days).toBe(30);
    expect(res.candidates.map((c) => [c.ref, c.for])).toEqual([
      ['git/rebase-onto-main', ['claude:engineer']],
    ]);
    expect(w.person.kbPromote({ minReads: 1 }).candidates.map((c) => c.ref)).toEqual([
      'git/rebase-onto-main',
      'ui/grid-gaps',
    ]);
    expect(w.person.kbPromote({ minReads: 1, agent: 'codex:qa' }).candidates).toHaveLength(1);
    expect(w.person.kbPromote({ minReads: 1, topic: 'ui' }).candidates[0]!.ref).toBe(
      'ui/grid-gaps',
    );
    expect(() => w.person.kbPromote({ minShown: 0 })).toThrow(/bad --shown/);
  });

  it('moves a note to kb/.archive with who, when and why, out of search, prompts and usage', () => {
    const w = world();
    const [done] = w.person.kbArchive(['git/rebase-onto-main'], 'Folded into the role file.');
    expect(done).toMatchObject({
      ref: 'git/rebase-onto-main',
      path: 'kb/.archive/git/rebase-onto-main.md',
      by: 'human:dawid',
      at: iso(30),
      why: 'Folded into the role file.',
    });
    expect(existsSync(join(w.rootDir, 'kb', 'git', 'rebase-onto-main.md'))).toBe(false);
    const doc = parseDoc<Record<string, string>>(readFileSync(done!.file, 'utf8'));
    expect(doc.data).toMatchObject({
      title: 'Rebase onto main',
      author: 'claude:engineer',
      archived_by: 'human:dawid',
      archived_why: 'Folded into the role file.',
    });
    expect(doc.body.trim()).toBe('Rebase before review.');
    expect(w.person.kb().map((h) => h.note.ref)).toEqual(['ui/grid-gaps']);
    expect(w.person.kbUsage().notes.map((u) => u.note.ref)).toEqual(['ui/grid-gaps']);
    expect(w.person.kbPromote().candidates).toEqual([]);
    expect(w.person.search('rebase in:notes')).toEqual([]);
    expect(() => w.person.kbNote('git/rebase-onto-main')).toThrow(/no note/);
    const t = w.person.newTask({ title: 'Rebase onto main again', type: 'task' });
    expect(w.person.taskNotes(t.id)).toEqual([]);
    // Archiving a note of the same name again keeps both.
    w.agent.learn({ topic: 'git', title: 'Rebase onto main', body: 'Again.' });
    expect(w.person.kbArchive(['git/rebase-onto-main'], 'Again.')[0]!.path).toBe(
      'kb/.archive/git/rebase-onto-main-2.md',
    );
    expect(readdirSync(join(w.rootDir, 'kb', '.archive', 'git')).sort()).toEqual([
      'rebase-onto-main-2.md',
      'rebase-onto-main.md',
    ]);
  });

  it('refuses agents, runs, no reason and unknown notes, moving nothing', () => {
    const w = world();
    const file = join(w.rootDir, 'kb', 'ui', 'grid-gaps.md');
    expect(() => w.agent.kbArchive(['ui/grid-gaps'], 'why')).toThrow(/only a person archives/);
    expect(() =>
      w.as('human:dawid', { ...w.opts, run: 'R1' }).kbArchive(['ui/grid-gaps'], 'why'),
    ).toThrow(/a run cannot archive/);
    expect(() => w.person.kbArchive(['ui/grid-gaps'], ' ')).toThrow(/say why/);
    expect(() => w.person.kbArchive(['ui/grid-gaps', 'ui/nope'], 'why')).toThrow(/no note/);
    expect(existsSync(file)).toBe(true);
  });
});
