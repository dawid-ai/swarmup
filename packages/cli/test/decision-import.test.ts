import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringifyDoc } from '@swarmup/core';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store() {
  const cwd = mkdtempSync(join(tmpdir(), 'swarmup-decision-import-'));
  dirs.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
  const env = {
    SWARMUP_CONFIG: join(cwd, 'none.yml'),
    SWARMUP_AGENT: 'codex:engineer',
  } as NodeJS.ProcessEnv;
  const swarmup = async (actor: string, ...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: { ...env, SWARMUP_AGENT: actor },
      cwd,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const decisions = () => {
    const dir = join(cwd, '.swarmup', 'decisions');
    try {
      return readdirSync(dir).filter((name) => /^D-\d+$/.test(name));
    } catch {
      return [];
    }
  };
  return { cwd, swarmup, decisions };
}

const HUMAN = 'human:dawid';

describe('decision imports', () => {
  it('previews and imports a historical table once, and skips a row without a date', async () => {
    const { cwd, swarmup, decisions } = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    const dated = join(cwd, 'history.md');
    writeFileSync(
      dated,
      [
        '# History',
        '',
        '## 2026-10-31',
        '',
        '### Decisions made while building',
        '',
        '| Topic | Decision | Why |',
        '| --- | --- | --- |',
        '| Index | JSON cache, not SQLite | Meets the target |',
        '',
      ].join('\n'),
    );

    const preview = await swarmup(
      'codex:engineer',
      'decision',
      '--import',
      dated,
      '--project',
      'agent-ops',
      '--dry-run',
    );
    expect(preview).toMatchObject({ code: 0, err: '' });
    expect(preview.out).toContain('would import');
    expect(preview.out).toContain('date: 2026-10-31');
    expect(preview.out).toContain('**Topic:** Index');
    expect(decisions()).toEqual([]);

    const imported = await swarmup(
      'codex:engineer',
      'decision',
      '--import',
      dated,
      '--project',
      'agent-ops',
    );
    expect(imported.out).toContain('imported D-0001');
    expect(decisions()).toEqual(['D-0001']);
    const record = readFileSync(
      join(cwd, '.swarmup', 'decisions', 'D-0001', 'decision.md'),
      'utf8',
    );
    expect(record).toContain('created_by: human:dawid');
    expect(record).toContain('imported_by: codex:engineer');
    expect(record).toContain('**Why:** Meets the target');

    const again = await swarmup(
      'codex:engineer',
      'decision',
      '--import',
      dated,
      '--project',
      'agent-ops',
    );
    expect(again.out).toContain('skip');
    expect(again.out).toContain('already imported as D-0001');
    expect(decisions()).toEqual(['D-0001']);

    const undated = join(cwd, 'undated.md');
    writeFileSync(
      undated,
      ['# Decisions', '', '| What | Owner |', '| --- | --- |', '| No date here | Dawid |', ''].join(
        '\n',
      ),
    );
    const skipped = await swarmup(
      'codex:engineer',
      'decision',
      '--import',
      undated,
      '--project',
      'agent-ops',
    );
    expect(skipped.out).toContain('no date in the row or its headings');
    expect(decisions()).toEqual(['D-0001']);
  });

  it('imports selected notes with mappings only after every mapping validates', async () => {
    const { cwd, swarmup, decisions } = store();
    await swarmup(HUMAN, 'init', '--name', 'demo', '--human', HUMAN);
    await swarmup(HUMAN, 'new', 'tree top', '--project', 'p');
    await swarmup(HUMAN, 'new', 'cross-project child', '--parent', 'T-0001', '--project', 'q');
    await swarmup(HUMAN, 'decision', 'Old tree rule', '--task', 'T-0001');
    await swarmup(HUMAN, 'decision', 'Old root rule');

    const notes = join(cwd, '.swarmup', 'kb', 'decisions');
    mkdirSync(notes, { recursive: true });
    const note = (slug: string, title: string, body: string) =>
      writeFileSync(
        join(notes, `${slug}.md`),
        stringifyDoc(
          {
            title,
            topic: 'decisions',
            author: 'claude:engineer',
            created_at: '2026-11-03T12:00:00.000Z',
          },
          body,
        ),
      );
    note('replace-tree', 'New project rule', 'Dawid replaced the old tree rule.');
    note('narrow-root', 'Project exception', 'Dawid made an exception for this project.');
    note('lesson', 'How to decide', 'An agent lesson, not a decision.');
    note('too-long', 'x'.repeat(201), 'Needs a shorter title.');

    const invalid = await swarmup(
      'codex:engineer',
      'decision',
      '--import-notes',
      '--project',
      'p',
      '--except',
      'lesson',
      '--supersedes-note',
      'replace-tree=D-0001',
      '--narrows-note',
      'narrow-root=D-0999',
    );
    expect(invalid.code).toBe(2);
    expect(invalid.err).toContain('no decision D-0999');
    expect(decisions()).toEqual(['D-0001', 'D-0002']);

    const args = [
      'decision',
      '--import-notes',
      '--project',
      'p',
      '--except',
      'lesson',
      '--supersedes-note',
      'replace-tree=D-0001',
      '--narrows-note',
      'narrow-root=D-0002',
    ];
    const preview = await swarmup('codex:engineer', ...args, '--dry-run');
    expect(preview).toMatchObject({ code: 0, err: '' });
    expect(preview.out).toContain('would import replace-tree: New project rule');
    expect(preview.out).toContain('supersedes: D-0001');
    expect(preview.out).toContain('narrows: D-0002');
    expect(preview.out).toContain('still in force outside project p');
    expect(preview.out).toContain('skip lesson: excluded by --except');
    expect(preview.out).toContain('skip too-long: too long (201 characters; maximum 200)');
    expect(decisions()).toEqual(['D-0001', 'D-0002']);

    const imported = await swarmup('codex:engineer', ...args);
    expect(imported.out).toContain('imported D-0003');
    expect(imported.out).toContain('imported D-0004');
    expect(decisions()).toEqual(['D-0001', 'D-0002', 'D-0003', 'D-0004']);
    const invalidRepeat = await swarmup(
      'codex:engineer',
      'decision',
      '--import-notes',
      '--project',
      'p',
      '--except',
      'lesson',
      '--supersedes-note',
      'replace-tree=D-0999',
    );
    expect(invalidRepeat.code).toBe(2);
    expect(invalidRepeat.err).toContain('no decision D-0999');
    expect(decisions()).toHaveLength(4);
    const again = await swarmup('codex:engineer', ...args);
    expect(again.out).toContain('already imported as D-0003');
    expect(again.out).toContain('already imported as D-0004');
    expect(decisions()).toHaveLength(4);
  });
});
