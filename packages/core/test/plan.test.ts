import { describe, expect, it } from 'vitest';
import {
  checkPlan,
  estimateMinutes,
  OpsError,
  parsePlan,
  planBody,
  planMinutes,
  readPlanBody,
} from '../src/index.js';
import type { EffectivePlanItem, PlanKind, PlanState } from '../src/index.js';

/** The plan of the design (AO-0110, "The plan"). */
const SAMPLE = `
notes: >
  Signing needs an Apple Developer account: item 'apple' asks Dawid first.
items:
  - key: apple
    title: Apple Developer account and signing certificate
    owner: human:dawid
    estimate: 1h
  - key: ci
    title: Build and sign the .dmg in CI
    owner: '*:engineer'
    after: [apple]
    estimate: 4h
    done_when: The release workflow uploads a signed .dmg; codesign --verify passes in CI.
    review: codex:qa
  - key: smoke
    title: Smoke check on a clean Mac
    owner: '*:qa'
    after: [ci]
    estimate: 1h
    done_when: docs/desktop.md smoke check passes; screenshots attached.
`;

/** A plan file of one-line items: `key owner estimate [field=value ...]`. */
function file(...rows: string[]): string {
  const items = rows.map((row) => {
    const [key, owner, estimate, ...rest] = row.split(' ');
    const extra = rest.map((f) => {
      const at = f.indexOf('=');
      const name = f.slice(0, at);
      const value = f.slice(at + 1);
      return name === 'after' ? `    after: [${value}]` : `    ${name}: '${value}'`;
    });
    return [
      `  - key: ${key}`,
      `    title: Item ${key}`,
      `    owner: '${owner}'`,
      `    estimate: ${estimate}`,
      ...extra,
    ].join('\n');
  });
  return `items:\n${items.join('\n')}\n`;
}

function item(key: string, extra: Partial<EffectivePlanItem> = {}): EffectivePlanItem {
  return {
    key,
    title: `Item ${key}`,
    owner: '*:engineer',
    estimate: '1h',
    origin: 'approve',
    ...extra,
  };
}

/** A milestone's plan with an approval: `items` effective, `gone` used by removed items. */
function approved(items: EffectivePlanItem[], gone: string[] = []): PlanState {
  return {
    items,
    approval: 'A1',
    head: 'A1',
    planner: 'claude:pm',
    pending: null,
    usedKeys: [...items.map((i) => i.key), ...gone],
    diff: [],
    skipped: [],
    failedChecks: [],
  };
}

/** The exit code and message `checkPlan` refuses with, or null when it accepts. */
function refusal(
  source: string,
  kind: PlanKind = 'proposal',
  plan: PlanState | null = null,
): { code: number; message: string } | null {
  try {
    checkPlan(source, kind, plan);
    return null;
  } catch (err) {
    if (!(err instanceof OpsError)) throw err;
    return { code: err.code, message: err.message };
  }
}

describe('a plan file (AO-0110)', () => {
  it('reads the items and the notes', () => {
    const doc = checkPlan(SAMPLE, 'proposal', null);
    expect(doc.notes).toContain('Apple Developer account');
    expect(doc.items.map((i) => i.key)).toEqual(['apple', 'ci', 'smoke']);
    expect(doc.items[1]).toEqual({
      key: 'ci',
      title: 'Build and sign the .dmg in CI',
      owner: '*:engineer',
      after: ['apple'],
      estimate: '4h',
      done_when: 'The release workflow uploads a signed .dmg; codesign --verify passes in CI.',
      review: 'codex:qa',
    });
    expect(planMinutes(doc.items)).toBe(6 * 60);
  });

  it('reads an estimate in minutes, hours and working days', () => {
    expect(estimateMinutes('30m')).toBe(30);
    expect(estimateMinutes('2h')).toBe(120);
    expect(estimateMinutes('1d')).toBe(8 * 60);
  });

  it.each(['2x', '0h', '1.5h', 'soon', '-1h', '2 h', '90'])('refuses the estimate %s', (e) => {
    expect(() => estimateMinutes(e)).toThrow(/bad estimate/);
  });

  it('refuses an estimate it cannot parse with exit 2', () => {
    expect(refusal(file('a *:engineer 2x'))).toMatchObject({ code: 2, message: /bad estimate/ });
  });

  it.each(['key', 'title', 'owner', 'estimate'])('refuses an item without %s', (field) => {
    const lines = ['items:', '  - key: a', '    title: A', "    owner: '*:qa'", '    estimate: 1h'];
    const source = lines.filter((l) => !l.includes(`${field}:`)).join('\n');
    // Without `key`, the first remaining field carries the list dash.
    const fixed = field === 'key' ? source.replace('    title', '  - title') : source;
    expect(refusal(fixed)).toMatchObject({ code: 2, message: new RegExp(`has no ${field}`) });
  });

  it('refuses a plan without items, or one that is not YAML', () => {
    expect(refusal('notes: nothing')).toMatchObject({ code: 2, message: /at least one item/ });
    expect(refusal('items: []')).toMatchObject({ code: 2 });
    expect(refusal('items: [')).toMatchObject({ code: 2, message: /not valid YAML/ });
    expect(refusal('- a\n- b')).toMatchObject({ code: 2 });
  });

  it('refuses a key that is not lowercase', () => {
    expect(refusal(file('CI *:engineer 1h'))).toMatchObject({ code: 2, message: /bad key 'CI'/ });
    expect(refusal(file('a#b *:engineer 1h'))).toMatchObject({ code: 2, message: /bad key/ });
  });

  it('refuses an owner that is no agent, wildcard or person', () => {
    expect(refusal(file('a engineer 1h'))).toMatchObject({ code: 2, message: /bad owner/ });
  });

  it('refuses a duplicate key', () => {
    expect(refusal(file('a *:engineer 1h', 'a *:qa 1h'))).toMatchObject({
      code: 2,
      message: /duplicate key 'a'/,
    });
  });

  it('refuses an after that names no key', () => {
    expect(refusal(file('a *:engineer 1h after=b'))).toMatchObject({
      code: 2,
      message: /after names no key 'b'/,
    });
  });

  it('refuses a cycle, and an item that waits for itself', () => {
    const cycle = file('a *:engineer 1h after=c', 'b *:engineer 1h after=a', 'c *:qa 1h after=b');
    expect(refusal(cycle)).toMatchObject({ code: 2, message: /cycle: a -> c -> b -> a/ });
    expect(refusal(file('a *:engineer 1h after=a'))).toMatchObject({
      code: 2,
      message: /waits for itself/,
    });
  });

  it('accepts 25 items and refuses 26', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `k${i} *:engineer 1h`);
    expect(refusal(file(...rows(25)))).toBeNull();
    expect(refusal(file(...rows(26)))).toMatchObject({ code: 2, message: /25 at most/ });
  });

  it('accepts the types task, bug and docs, and refuses a nested milestone', () => {
    expect(refusal(file('a *:engineer 1h type=bug', 'b *:engineer 1h type=docs'))).toBeNull();
    expect(refusal(file('a *:engineer 1h type=milestone'))).toMatchObject({
      code: 2,
      message: /plans do not nest/,
    });
    expect(refusal(file('a *:engineer 1h type=idea'))).toMatchObject({
      code: 2,
      message: /bad type 'idea'/,
    });
  });

  it('refuses a priority that is none of p0 to p3', () => {
    expect(parsePlan(file('a *:engineer 1h priority=p1')).items[0]!.priority).toBe('p1');
    expect(refusal(file('a *:engineer 1h priority=high'))).toMatchObject({
      code: 2,
      message: /bad priority/,
    });
  });

  it('refuses a done_when of more than one line', () => {
    const source = `${file('a *:engineer 1h')}    done_when: |\n      one\n      two\n`;
    expect(refusal(source)).toMatchObject({ code: 2, message: /done_when must be one line/ });
  });
});

describe('the reviewer of a plan item (AO-0110, "Reviewers")', () => {
  it('refuses a wildcard: it names no provider', () => {
    for (const review of ['*:qa', 'codex:*']) {
      expect(refusal(file(`a claude:engineer 1h review=${review}`))).toMatchObject({
        code: 2,
        message: /bad reviewer/,
      });
    }
  });

  it('refuses an agent of the same provider as a concrete owner', () => {
    expect(refusal(file('a codex:engineer 1h review=codex:qa'))).toMatchObject({
      code: 2,
      message: /another provider than the owner codex:engineer/,
    });
    // A runtime wildcard names its provider too.
    expect(refusal(file('a codex:* 1h review=codex:qa'))).toMatchObject({ code: 2 });
  });

  it('accepts another provider, a person, and any agent for a role wildcard owner', () => {
    expect(refusal(file('a claude:engineer 1h review=codex:qa'))).toBeNull();
    expect(refusal(file('a codex:engineer 1h review=human:dawid'))).toBeNull();
    // The provider of `*:engineer` is unknown until a run claims the task.
    expect(refusal(file('a *:engineer 1h review=codex:qa'))).toBeNull();
  });
});

describe('`for` and used keys (AO-0110, "Used keys")', () => {
  const plan = approved(
    [item('ci'), item('smoke', { after: ['ci'] }), item('lint', { origin: 'subtask', for: 'ci' })],
    ['apple'],
  );

  it('refuses `for` in a proposal: it belongs to amendments', () => {
    expect(refusal(file('a *:engineer 1h', 'b *:engineer 1h for=a'))).toMatchObject({
      code: 2,
      message: /`for` belongs to amendments/,
    });
  });

  it('keeps the `for` of an amended item in a change, and refuses any other', () => {
    const rows = ['ci *:engineer 1h', 'smoke *:engineer 1h after=ci'];
    expect(refusal(file(...rows, 'lint *:engineer 1h for=ci'), 'change', plan)).toBeNull();
    expect(refusal(file(...rows, 'lint *:engineer 1h for=smoke'), 'change', plan)).toMatchObject({
      code: 2,
    });
    expect(refusal(file(...rows, 'new *:engineer 1h for=ci'), 'change', plan)).toMatchObject({
      code: 2,
    });
  });

  it('accepts a used key in a proposal or a change only while its item is in the plan', () => {
    expect(refusal(file('ci *:engineer 1h', 'docs *:engineer 1h'), 'change', plan)).toBeNull();
    for (const kind of ['proposal', 'change'] as const) {
      expect(refusal(file('ci *:engineer 1h', 'apple *:engineer 1h'), kind, plan)).toMatchObject({
        code: 2,
        message: /key 'apple' was used by an item that is no longer in the plan/,
      });
    }
  });

  it('keeps the keys of a proposal that was sent back: they are not used', () => {
    const none: PlanState = { ...approved([]), approval: null, head: null, usedKeys: [] };
    expect(refusal(file('ci *:engineer 1h'), 'proposal', none)).toBeNull();
  });

  it('refuses an amendment before any approval', () => {
    for (const kind of ['subtask', 'fix'] as const) {
      expect(refusal(file('a *:engineer 1h for=ci'), kind, null)).toMatchObject({
        code: 2,
        message: /needs an approved plan/,
      });
    }
  });

  it('refuses a used key in an amendment with exit 1: use --kind change', () => {
    for (const key of ['ci', 'apple', 'lint']) {
      for (const kind of ['subtask', 'fix'] as const) {
        expect(refusal(file(`${key} *:engineer 1h for=ci`), kind, plan)).toMatchObject({
          code: 1,
          message: /use --kind change/,
        });
      }
    }
  });

  it('requires `for` in a subtask amendment and leaves it optional in a fix', () => {
    expect(refusal(file('more *:engineer 1h'), 'subtask', plan)).toMatchObject({
      code: 1,
      message: /names no `for`.*use --kind change/,
    });
    expect(refusal(file('more *:engineer 1h'), 'fix', plan)).toBeNull();
    expect(refusal(file('more *:engineer 1h for=ci'), 'subtask', plan)).toBeNull();
    expect(refusal(file('more *:engineer 1h for=smoke'), 'fix', plan)).toBeNull();
  });

  it('refuses a `for` that names no key of the effective plan', () => {
    for (const target of ['nope', 'apple', 'other']) {
      const source = file('other *:engineer 1h for=ci', `more *:engineer 1h for=${target}`);
      expect(refusal(source, 'subtask', plan)).toMatchObject({
        code: 2,
        message: /for names no key/,
      });
    }
  });

  it('refuses a `for` that names an amended item: the chain is one level deep', () => {
    for (const kind of ['subtask', 'fix'] as const) {
      expect(refusal(file('more *:engineer 1h for=lint'), kind, plan)).toMatchObject({
        code: 2,
        message: /which an amendment added/,
      });
    }
    // A fix without `for` is an amended item too.
    const fixed = approved([item('ci'), item('patch', { origin: 'fix' })]);
    expect(refusal(file('more *:engineer 1h for=patch'), 'subtask', fixed)).toMatchObject({
      code: 2,
    });
  });

  it('lets a new item of an amendment wait for existing keys and for new ones', () => {
    const source = file('a *:engineer 1h for=ci after=smoke', 'b *:engineer 1h for=ci after=a');
    expect(refusal(source, 'subtask', plan)).toBeNull();
    expect(refusal(file('a *:engineer 1h for=ci after=apple'), 'subtask', plan)).toMatchObject({
      code: 2,
      message: /after names no key 'apple'/,
    });
    // A full plan names its own keys only.
    expect(refusal(file('new *:engineer 1h after=smoke'), 'change', plan)).toMatchObject({
      code: 2,
    });
  });
});

describe('the body of a plan event', () => {
  it('holds the plan as YAML in a fenced block and reads it back', () => {
    const doc = parsePlan(SAMPLE);
    const body = planBody(doc, 'Plan for AO-0120: 3 items, 6 h');
    expect(body).toMatch(/^Plan for AO-0120: 3 items, 6 h\n\n```yaml\n/);
    expect(readPlanBody(body)).toEqual(doc);
    expect(readPlanBody(planBody(doc))).toEqual(doc);
  });

  it('keeps a code block inside an item body', () => {
    const doc = parsePlan(file('a *:engineer 1h'));
    doc.items[0]!.body = 'Run:\n\n```bash\nnpm test\n```\n\nthen check.';
    const body = planBody(doc);
    expect(body.startsWith('````yaml\n')).toBe(true);
    expect(readPlanBody(body)).toEqual(doc);
  });

  it('reads nothing from a body without a plan', () => {
    expect(readPlanBody('no plan here')).toBeNull();
    expect(readPlanBody('```yaml\nitems: nope\n```\n')).toBeNull();
    expect(readPlanBody('```yaml\nitems:\n  - key: a\n```\n')).toBeNull();
  });
});
