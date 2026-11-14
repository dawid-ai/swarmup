import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doneWhenLines, evidenceNotes } from '../src/index.js';
import { fakeToken, setup } from './helpers.js';

// AO-0290: a task carries its checks in `done_when`, and a review request on such a task names
// the commands run and their output.

describe('doneWhenLines', () => {
  it('reads a list, one text value, or text with one check per line', () => {
    expect(doneWhenLines(['npm test passes', ' eslint is clean '])).toEqual([
      'npm test passes',
      'eslint is clean',
    ]);
    expect(doneWhenLines('npm test passes')).toEqual(['npm test passes']);
    expect(doneWhenLines('- npm test passes\r\n\n2. the page loads\n* no warnings')).toEqual([
      'npm test passes',
      'the page loads',
      'no warnings',
    ]);
  });

  it('is undefined when nothing is left', () => {
    for (const empty of [undefined, null, '', '  \n ', [], ['', ' ']]) {
      expect(doneWhenLines(empty)).toBeUndefined();
    }
  });
});

describe('done_when on a task', () => {
  it('round-trips from newTask through task.md to the view', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const meta = h.newTask({
      title: 'Add the field',
      doneWhen: ['`npm test` passes', 'show prints: the list, with commas'],
    });
    expect(meta.done_when).toEqual(['`npm test` passes', 'show prints: the list, with commas']);
    const file = readFileSync(join(rootDir, 'tasks', meta.id, 'task.md'), 'utf8');
    expect(file).toContain('done_when:\n  - "`npm test` passes"\n');
    // A fresh workspace reads the file, not what newTask returned.
    expect(as('claude:engineer').view(meta.id).meta.done_when).toEqual(meta.done_when);
  });

  it('leaves a task without it as before, and reads a hand-written text value as one line', () => {
    const { as, rootDir } = setup();
    const h = as('human:dawid');
    const old = h.newTask({ title: 'Filed before the field', doneWhen: [' '] });
    expect(old.done_when).toBeUndefined();
    const file = join(rootDir, 'tasks', old.id, 'task.md');
    expect(readFileSync(file, 'utf8')).not.toContain('done_when');
    const view = as('human:dawid').view(old.id);
    expect(view.meta).not.toHaveProperty('done_when');
    expect(view.status).toBe('todo');

    const second = h.newTask({ title: 'Edited by hand' });
    const path = join(rootDir, 'tasks', second.id, 'task.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('\n---\n', '\ndone_when: npm test passes\n---\n'),
    );
    expect(as('human:dawid').view(second.id).meta.done_when).toEqual(['npm test passes']);
  });

  it('keeps the list on a proposal an agent files, and refuses a secret in it', () => {
    const { as } = setup();
    const { meta, proposed } = as('claude:pm').addTask({
      title: 'Rewrite the sync',
      doneWhen: ['two clones converge'],
    });
    expect(proposed).toBeDefined();
    expect(meta.type).toBe('finding');
    expect(meta.done_when).toEqual(['two clones converge']);
    expect(() =>
      as('human:dawid').newTask({ title: 'Leaky', doneWhen: [`curl -H ${fakeToken()}`] }),
    ).toThrow();
  });
});

describe('evidenceNotes', () => {
  const lines = ['npm test passes'];

  it('is empty for a task without done_when', () => {
    expect(evidenceNotes('done', undefined)).toEqual([]);
    expect(evidenceNotes('done', [])).toEqual([]);
  });

  it('names what the request lacks: a command, a result, or both', () => {
    const [both] = evidenceNotes('abc1234 on branch a-b: the field and its docs', lines);
    expect(both).toMatch(/1 done-when line and the request names no command .* and no result/);
    const [command] = evidenceNotes('all the tests pass', ['a', 'b']);
    expect(command).toMatch(/2 done-when lines and the request names no command/);
    expect(command).not.toMatch(/no result/);
    const [result] = evidenceNotes('I ran `npm test` and `npm run lint`', lines);
    expect(result).toMatch(/names no result/);
    expect(result).not.toMatch(/no command/);
  });

  it('does not take a branch, commit, path or identifier in code font for a command', () => {
    for (const bare of [
      '8f41216 on branch `main`: tests pass',
      '`8f41216` on branch `claude/ao-0290`: all tests pass',
      'Changed `packages/core/src/ids.ts` and `evidenceNotes`; the tests pass',
      '`done_when` is in `TaskMeta`, set by `--done-when CHECK` and `POST /api/tasks`; all green',
      // Prose in code font, such as a quoted test name, is not a command either.
      '`has identical copies`; tests pass',
      'The test `reads old tasks without the field` is green, and so is `round trip of a list`',
      'Fixed `the note text` and `evidence notes for a review`; all tests pass',
      '`./docs/protocol.md` describes it; tests pass',
      // A program whose name is also an English word needs arguments that fit it.
      '`make sure it works`; tests pass',
      '`go to the page`; tests pass',
      '`make changes` and `make progress`; tests pass',
      '`go run the tests` passed',
      '`go ahead`; tests pass',
      '`just works`; tests pass',
      '`just the tests` passed',
      '`cat the file`; tests pass',
      '`diff is clean`; tests pass',
      '`cargo cult`; tests pass',
      '`bundle of fixes`; tests pass',
    ]) {
      const [note] = evidenceNotes(bare, lines);
      expect(note, bare).toMatch(/names no command/);
      expect(note, bare).not.toMatch(/no result/);
    }
  });

  it('takes a program with arguments, or one that runs alone, for a command', () => {
    for (const ok of [
      '`pytest`: 12 passed',
      '`./scripts/check.sh --all` prints ok',
      '`$ node packages/cli/dist/main.js show AO-1` shows the list',
      'on branch `main`; `npm run typecheck` printed no errors',
      '`./check.sh` exits 0',
      '`scripts/check.ps1 all` printed ok',
      '`CI=1 npx vitest run packages/core` printed 40 passed',
      '`mytool --check` printed ok',
      '`node_modules/.bin/vitest run` printed 40 passed',
      '`make` printed ok',
      '`make test` printed ok',
      '`make -j4 build-all CC=gcc` printed ok',
      '`make test lint` printed ok',
      '`go test ./...` printed ok',
      '`go vet ./...` printed no errors',
      '`go build` exits 0',
      '`go.exe test -race ./...` printed ok',
      '`just lint` printed ok',
      '`cargo test --workspace` printed 12 passed',
      '`cargo +nightly fmt --check` exits 0',
      '`bundle exec rspec` printed 12 passed',
      '`cat out/report.txt` shows the list',
      '`diff -u a.txt b.txt` printed nothing; ok',
      '`ls dist/` shows the bundle',
    ]) {
      expect(evidenceNotes(ok, lines), ok).toEqual([]);
    }
  });

  it('is empty when the request names a command and a result', () => {
    for (const ok of [
      '`npm test`: 412 passed',
      '`npm run lint` exits 0',
      'Ran the suite:\n```\n$ npm test\nTests  12\n```',
      '`curl localhost:4000/health` returns 200',
    ]) {
      expect(evidenceNotes(ok, lines), ok).toEqual([]);
    }
  });
});

describe('swarmup review on a task with done_when', () => {
  function started(doneWhen?: string[]) {
    const { as } = setup();
    as('human:dawid').newTask({ title: 'Add the field', owner: 'claude:engineer', doneWhen });
    const eng = as('claude:engineer');
    eng.start('1', 'core first');
    return eng;
  }

  it('prints a note, and still sends the request, when it names no evidence', () => {
    const res = started(['npm test passes']).review('1', 'T-0001: tests pass, abc1234 on main');
    expect(res.view.status).toBe('needs-review');
    expect(res.notes?.join('\n')).toMatch(/done-when line and the request names no command/);
  });

  it('prints no such note with evidence, or on a task without done_when', () => {
    const withEvidence = started(['npm test passes']).review('1', 'T-0001: `npm test`: 9 passed');
    expect(withEvidence.notes?.join('\n') ?? '').not.toMatch(/done-when/);
    const old = started().review('1', 'T-0001: tests pass');
    expect(old.notes?.join('\n') ?? '').not.toMatch(/done-when/);
  });
});
