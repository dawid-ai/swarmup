import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** A repo with a data root, and `swarmup` run in it as an actor, with `stdin` as its input. */
function store() {
  const cwd = temp('swarmup-brief-');
  execFileSync('git', ['init', '-q'], { cwd, windowsHide: true });
  const state = temp('swarmup-brief-state-');
  return async (actor: string, argv: string[], stdin = '') => {
    const out: string[] = [];
    const err: string[] = [];
    const env = {
      SWARMUP_CONFIG: join(cwd, 'none.yml'),
      SWARMUP_AGENT: actor,
      SWARMUP_STATE_DIR: state,
    } as NodeJS.ProcessEnv;
    const code = await run(argv, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env,
      cwd,
      readStdin: () => stdin,
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
}

describe('swarmup brief', () => {
  it('writes a brief from stdin, prints the newest, and exits 3 without one', async () => {
    const swarmup = store();
    await swarmup('human:dawid', ['init', '--name', 'demo', '--human', 'human:dawid']);
    await swarmup('human:dawid', ['new', 'Parent goal']);
    const none = await swarmup('claude:pm', ['brief', '1']);
    expect(none.code).toBe(3);
    expect(none.err).toContain('has no brief');
    const brief = '## Outcome\r\nOne queue.\r\n\r\n## Next\r\nThe parser.\r\n';
    const wrote = await swarmup('claude:pm', ['brief', '1', '--body-file', '-'], brief);
    expect(wrote.code).toBe(0);
    await swarmup('claude:pm', ['brief', '1', '-m', '## Outcome\nTwo queues.']);
    const shown = await swarmup('claude:engineer', ['brief', '1']);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('claude:pm');
    expect(shown.out).toContain('## Outcome\nTwo queues.');
    expect(shown.out).not.toContain('One queue.');
    const json = await swarmup('claude:engineer', ['brief', '1', '--json']);
    expect(JSON.parse(json.out)).toMatchObject({
      actor: 'claude:pm',
      body: '## Outcome\nTwo queues.',
    });
  });

  it('refuses an empty brief', async () => {
    const swarmup = store();
    await swarmup('human:dawid', ['init', '--name', 'demo', '--human', 'human:dawid']);
    await swarmup('human:dawid', ['new', 'Parent goal']);
    const res = await swarmup('claude:pm', ['brief', '1', '--body-file', '-'], '  \n');
    expect(res.code).toBe(2);
  });
});
