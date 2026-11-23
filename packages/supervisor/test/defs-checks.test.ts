// W5 phase 4: merge checks in `swarm.yaml` run only where a person trusted the exact set, and a
// machine's own `swarmupd.merge.<root>.checks` wins over them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SwarmDefs } from '@swarmup/core';
import { checksHash, clearDefinitionsCache, swarmDefs } from '@swarmup/core';
import { DefsState, opsdConfig, withDefinitions } from '../src/index.js';
import { temp } from './supervisor-setup.js';

const CHECKS: SwarmDefs = {
  swarmup_defs: 1,
  checks: { test: { run: 'pnpm test' }, lint: { run: 'pnpm lint', paths: ['**/*.ts'] } },
};
const HASH = checksHash(CHECKS.checks!);

const machine = (raw: Record<string, unknown>) =>
  opsdConfig({
    swarmupd: { seeded: 1, runtimes: { claude: { command: 'claude' } }, ...raw },
  } as never);

describe('merge checks in git', () => {
  it('read from swarm.yaml in name order, a command or one with paths', () => {
    const defs = swarmDefs({
      swarmup_defs: 1,
      checks: { b: 'pnpm b', a: { run: 'pnpm a', paths: ['src/**'], description: 'A' } },
    });
    expect(defs.checks).toEqual({
      a: { run: 'pnpm a', paths: ['src/**'], description: 'A' },
      b: { run: 'pnpm b' },
    });
  });

  it('go under merge.<root>.checks only when trusted here', () => {
    const untrusted = withDefinitions(machine({ merge: { a: { base: 'main' } } }), [
      { root: 'a', swarm: CHECKS },
    ]);
    expect(untrusted.config.merge.a!.checks).toBeUndefined();
    expect(untrusted.checks).toEqual([
      { root: 'a', count: 2, hash: HASH, trust: 'untrusted', use: 'skipped' },
    ]);
    const trusted = withDefinitions(
      machine({ merge: { a: { base: 'main' } }, trusted_defs: { a: { checks: HASH } } }),
      [{ root: 'a', swarm: CHECKS }],
    );
    expect(trusted.config.merge.a).toEqual({
      base: 'main',
      checks: [{ run: 'pnpm lint', paths: ['**/*.ts'] }, 'pnpm test'],
    });
    expect(trusted.applied).toEqual([{ key: 'merge.a.checks', root: 'a' }]);
  });

  it('untrust on any change to a command or its paths', () => {
    const changed: SwarmDefs = {
      swarmup_defs: 1,
      checks: { ...CHECKS.checks, lint: { run: 'pnpm lint', paths: ['**'] } },
    };
    const m = withDefinitions(
      machine({ merge: { a: { base: 'main' } }, trusted_defs: { a: { checks: HASH } } }),
      [{ root: 'a', swarm: changed }],
    );
    expect(m.config.merge.a!.checks).toBeUndefined();
    expect(m.checks[0]).toMatchObject({ trust: 'changed', use: 'skipped' });
  });

  it("lose to the machine's own checks, and do nothing where the machine does not merge", () => {
    const own = withDefinitions(
      machine({
        merge: { a: { base: 'main', checks: ['npm test'] } },
        trusted_defs: { a: { checks: HASH } },
      }),
      [{ root: 'a', swarm: CHECKS }],
    );
    expect(own.config.merge.a!.checks).toEqual(['npm test']);
    expect(own.overrides.map((o) => o.key)).toEqual(['merge.a.checks']);
    expect(own.checks[0]!.use).toBe('machine');
    const none = withDefinitions(machine({ trusted_defs: { a: { checks: HASH } } }), [
      { root: 'a', swarm: CHECKS },
    ]);
    expect(none.config.merge).toEqual({});
    expect(none.checks[0]!.use).toBe('no-merge');
  });

  it('warn once per check set that is not trusted', () => {
    const dir = join(temp(), '.swarmup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'swarm.yaml'), 'swarmup_defs: 1\nchecks:\n  test: pnpm test\n');
    clearDefinitionsCache();
    const warnings: string[] = [];
    const state = new DefsState({ state: null, now: Date.now, warn: (m) => warnings.push(m) });
    const cfg = machine({ merge: { a: { base: 'main' } } });
    state.apply(cfg, [{ name: 'a', dir }]);
    state.apply(cfg, [{ name: 'a', dir }]);
    expect(warnings).toEqual([
      "1 merge check(s) in a's swarm.yaml are not trusted on this machine; merges skip them until a person runs `swarmup defs trust --root a`",
    ]);
    expect(state.checks('a')).toMatchObject({ trust: 'untrusted', use: 'skipped' });
  });

  it('refuse a trusted hash that is not one defs trust writes', () => {
    expect(() => machine({ trusted_defs: { a: 'yes' } })).toThrow(
      /swarmupd.trusted_defs.a: use what swarmup defs trust writes/,
    );
  });
});
