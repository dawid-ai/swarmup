import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkDefinitionText,
  checkTriggerText,
  clearDefinitionsCache,
  cronMatches,
  formatProblem,
  loadDefinitions,
  nextCron,
  nextTriggerFire,
  parseCron,
  scheduleTriggerText,
  triggerDue,
  triggerRunsOn,
  triggersHash,
  triggerWhen,
} from '../src/index.js';
import { tempDir } from './helpers.js';

const templates = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** Local time, so the tests hold in any time zone (none of these dates is a DST change). */
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo - 1, d, h, mi).getTime();

const sorted = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);

describe('cron parser', () => {
  it('reads values, ranges, steps, lists and stars', () => {
    const c = parseCron('*/15 9-17/4 1,15 * *');
    expect(sorted(c.minutes)).toEqual([0, 15, 30, 45]);
    expect(sorted(c.hours)).toEqual([9, 13, 17]);
    expect(sorted(c.days)).toEqual([1, 15]);
    expect(c.months.size).toBe(12);
    expect(c.weekdays.size).toBe(7);
    expect(sorted(parseCron('5/20 0 * * *').minutes)).toEqual([5, 25, 45]);
    expect(sorted(parseCron('0 0 * * 1,3-5').weekdays)).toEqual([1, 3, 4, 5]);
  });

  it('reads day and month names, and 7 or a range ending in sun as Sunday', () => {
    expect(sorted(parseCron('0 9 * * mon-fri').weekdays)).toEqual([1, 2, 3, 4, 5]);
    expect(sorted(parseCron('0 9 * * FRI-SUN').weekdays)).toEqual([0, 5, 6]);
    expect(sorted(parseCron('0 9 * * 7').weekdays)).toEqual([0]);
    expect(sorted(parseCron('0 9 * jan,jun-aug *').months)).toEqual([1, 6, 7, 8]);
  });

  it('refuses bad expressions and names the field', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/five fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/minute: 60 is outside 0-59/);
    expect(() => parseCron('0 24 * * *')).toThrow(/hour: 24 is outside 0-23/);
    expect(() => parseCron('0 0 0 * *')).toThrow(/day of month: 0 is outside 1-31/);
    expect(() => parseCron('0 0 * * fri-mon')).toThrow(
      /day of week: the range 'fri-mon' runs backwards/,
    );
    expect(() => parseCron('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCron('0 9 * * funday')).toThrow(/'funday' is no number or name/);
    expect(() => parseCron('0,,5 * * * *')).toThrow(/empty list entry/);
  });

  it('computes the next fire time in local time', () => {
    // 2026-11-23 is a Monday.
    const c = parseCron('0 9 * * mon-fri');
    expect(nextCron(c, at(2026, 11, 23, 8, 59))).toBe(at(2026, 11, 23, 9, 0));
    expect(nextCron(c, at(2026, 11, 23, 9, 0))).toBe(at(2026, 11, 24, 9, 0));
    expect(nextCron(c, at(2026, 11, 27, 10, 0))).toBe(at(2026, 11, 30, 9, 0));
    expect(nextCron(parseCron('*/15 * * * *'), at(2026, 11, 23, 9, 7))).toBe(
      at(2026, 11, 23, 9, 15),
    );
    expect(nextCron(parseCron('30 2 1 jan *'), at(2026, 11, 23))).toBe(at(2027, 1, 1, 2, 30));
    expect(nextCron(parseCron('0 0 29 2 *'), at(2026, 3, 1))).toBe(at(2028, 2, 29));
    expect(nextCron(parseCron('0 0 30 2 *'), at(2026, 3, 1))).toBeNull();
  });

  it('matches either day field when both are restricted, as Vixie cron does', () => {
    // The 1st of the month, or any Friday.
    const c = parseCron('0 12 1 * fri');
    expect(nextCron(c, at(2026, 11, 23))).toBe(at(2026, 11, 27, 12, 0));
    expect(nextCron(c, at(2026, 11, 28))).toBe(at(2026, 12, 1, 12, 0));
    // A star day of month leaves the weekday alone to decide.
    expect(cronMatches(parseCron('0 12 */2 * mon'), at(2026, 11, 23, 12, 0))).toBe(true);
    expect(cronMatches(parseCron('0 12 * * mon'), at(2026, 11, 24, 12, 0))).toBe(false);
  });
});

describe('trigger files', () => {
  const check = (text: string, name = 'nightly') =>
    checkTriggerText(name, text, { file: `triggers/${name}.yaml` });

  it('reads a run, a workflow and a repeat trigger', () => {
    const run = check(
      'cron: "0 9 * * mon-fri"\naction: run\nagent: claude:pm\nprompt: Plan the day\n',
    );
    expect(run.problems).toEqual([]);
    expect(run.def).toEqual({
      name: 'nightly',
      action: 'run',
      enabled: true,
      cron: '0 9 * * mon-fri',
      agent: 'claude:pm',
      prompt: 'Plan the day',
    });
    const wf = check(
      'at: "07:30"\naction: workflow\nworkflow: newsletter\nparams: {issue: 12, draft: true}\nruns_on: [desk]\n',
    );
    expect(wf.def).toMatchObject({
      at: '07:30',
      workflow: 'newsletter',
      params: { issue: '12', draft: 'true' },
      runs_on: ['desk'],
    });
    expect(
      check('every: 1d\naction: repeat\nrepeat: weekly-report\nruns_on: [desk]\nenabled: false\n')
        .def,
    ).toMatchObject({ every: '1d', repeat: 'weekly-report', enabled: false });
  });

  it('needs exactly one time rule and the target of its action', () => {
    const lines = (text: string) => check(text).problems.map(formatProblem);
    expect(lines('action: run\nagent: claude:pm\n')).toEqual([
      'triggers/nightly.yaml:1:1: error: (top): set when it fires: every, at or cron',
    ]);
    expect(lines('every: 1h\nat: "09:00"\naction: run\nagent: claude:pm\n')).toEqual([
      'triggers/nightly.yaml:2:1: error: at: set one of every, at and cron; got every and at',
    ]);
    expect(lines('every: 1h\naction: workflow\nruns_on: [desk]\n')).toEqual([
      'triggers/nightly.yaml:2:1: error: action: action workflow needs workflow',
    ]);
    // One machine starts a workflow or repeat, or each consenting machine would.
    expect(lines('every: 1h\naction: repeat\nrepeat: weekly\n')).toEqual([
      'triggers/nightly.yaml:2:1: error: action: action repeat needs runs_on: name the one machine that starts it, or each machine would',
    ]);
    expect(lines('cron: "0 0 30 2 *"\naction: run\nagent: claude:pm\n')).toEqual([
      "triggers/nightly.yaml:1:1: error: cron: '0 0 30 2 *' never fires: no such date comes",
    ]);
    expect(lines('every: 1h\naction: run\nagent: claude:pm\ntask: other/AO-12\n')[0]).toContain(
      "error: task: name a task of this store such as AO-0012; a trigger never starts another store's task",
    );
    expect(lines('cron: "0 25 * * *"\naction: run\nagent: claude:pm\n')).toEqual([
      "triggers/nightly.yaml:1:1: error: cron: bad cron '0 25 * * *': hour: 25 is outside 0-23",
    ]);
    expect(lines('every: soon\naction: run\nagent: claude:pm\n')).toEqual([
      "triggers/nightly.yaml:1:8: error: every: use a duration such as 30m, 2h or 1d; got 'soon'",
    ]);
    expect(lines('every: 1h\naction: run\nagent: claude:pm\nworkflow: bugfix\n')).toEqual([
      'triggers/nightly.yaml:4:1: warning: workflow: workflow is for action workflow; action run does not read it',
    ]);
  });

  it('takes a webhook section that names its secret, and never fires it on a schedule', () => {
    const t = check(
      'webhook: {verify: linear, secret: LINEAR_HOOK, rate: 10}\naction: run\nagent: claude:pm\n',
    );
    expect(t.problems).toEqual([]);
    expect(t.def?.webhook).toEqual({ verify: 'linear', secret: 'LINEAR_HOOK', rate: 10 });
    expect(triggerWhen(t.def!)).toBe('webhook linear');
    expect(triggerDue(t.def!, undefined, at(2026, 11, 23))).toBe('wait');
    expect(nextTriggerFire(t.def!, undefined, at(2026, 11, 23))).toBeNull();
    const both = check('every: 1d\nwebhook: {verify: slack, secret: S}\naction: run\nagent: a:b\n');
    expect(triggerWhen(both.def!)).toBe('every 1d, webhook slack');
  });

  it('checks the webhook secret reference, never a secret in the file', () => {
    const msgs = (text: string): string[] =>
      check(`${text}\naction: run\nagent: claude:pm\n`).problems.map(
        (p) => `${p.severity}: ${p.path}: ${p.message}`,
      );
    expect(msgs('webhook: {verify: hmac}')).toEqual(["error: webhook: missing key 'secret'"]);
    expect(msgs('webhook: {verify: hmac, secret: "my secret!"}')[0]).toMatch(
      /^error: webhook\.secret: name a value of secrets\.yml/,
    );
    expect(msgs('webhook: {verify: gpg, secret: K}')[0]).toMatch(/^error: webhook\.verify/);
    expect(msgs('webhook: {verify: hmac, secret: xoxb_abc}')).toEqual([
      "warning: webhook: webhook.secret 'xoxb_abc' names a secrets.yml value; write names in capitals, such as LINEAR_WEBHOOK_SECRET, and never the secret itself",
    ]);
    expect(msgs('webhook: {verify: slack, secret: K, header: X-Sig}')).toEqual([
      'warning: webhook: webhook.header is for verify hmac; slack does not read it',
    ]);
    expect(msgs('webhook: {verify: hmac, secret: K, rate: 0}')[0]).toMatch(/^error: webhook\.rate/);
  });

  it('untrusts the set when the webhook section changes, and keeps older hashes', () => {
    const hash = (text: string): string =>
      triggersHash([check(`${text}action: run\nagent: claude:pm\n`).def!])!;
    const plain = hash('every: 1h\n');
    expect(plain).toBe(hash('every: 1h\n'));
    const hooked = hash('every: 1h\nwebhook: {verify: hmac, secret: A}\n');
    expect(hooked).not.toBe(plain);
    expect(hash('every: 1h\nwebhook: {verify: hmac, secret: B}\n')).not.toBe(hooked);
    expect(hash('every: 1h\nwebhook: {verify: bearer, secret: A}\n')).not.toBe(hooked);
  });

  it('is checked as a trigger by its path', () => {
    const problems = checkDefinitionText('store/triggers/x.yaml', 'action: run\n');
    expect(problems.map((p) => p.message)).toContain('set when it fires: every, at or cron');
  });
});

describe('trigger timing', () => {
  const now = at(2026, 11, 23, 10, 0);

  it('fires an every trigger at once, then after each interval', () => {
    const def = { every: '30m' };
    expect(triggerDue(def, undefined, now)).toBe('fire');
    expect(triggerDue(def, now - 29 * 60_000, now)).toBe('wait');
    expect(triggerDue(def, now - 30 * 60_000, now)).toBe('fire');
    expect(nextTriggerFire(def, now - 10 * 60_000, now)).toBe(now + 20 * 60_000);
  });

  it('starts an at or cron trigger at its next time after it is first seen', () => {
    const def = { at: '09:00' };
    expect(triggerDue(def, undefined, now)).toBe('baseline');
    expect(nextTriggerFire(def, undefined, now)).toBe(at(2026, 11, 24, 9, 0));
    // Seen at 10:00 yesterday: today's 09:00 is due.
    expect(triggerDue(def, at(2026, 11, 22, 10, 0), now)).toBe('fire');
    // Fired at 09:00:20 today: nothing more until tomorrow.
    expect(triggerDue(def, at(2026, 11, 23, 9, 0) + 20_000, now)).toBe('wait');
  });

  it('fires once for missed times, however many passed', () => {
    const def = { cron: '0 * * * *' };
    // Down for five hours: one fire now, recorded at now, so the next is 11:00.
    expect(triggerDue(def, at(2026, 11, 23, 5, 0), now)).toBe('fire');
    expect(nextTriggerFire(def, now, now)).toBe(at(2026, 11, 23, 11, 0));
  });

  it('runs on every machine without runs_on, else on the named ones only', () => {
    expect(triggerRunsOn({}, undefined)).toBe(true);
    expect(triggerRunsOn({ runs_on: ['Desk'] }, 'desk')).toBe(true);
    expect(triggerRunsOn({ runs_on: ['desk'] }, 'laptop')).toBe(false);
    expect(triggerRunsOn({ runs_on: ['desk'] }, undefined)).toBe(false);
  });

  it('writes a machine schedule as a trigger file that checks', () => {
    const text = scheduleTriggerText({
      every: '24h',
      agent: 'claude:pm',
      prompt: 'Review the board',
      task: 'AO-0012',
      machine: 'desk',
      paused: true,
    });
    const t = checkTriggerText('daily', text, { file: 'triggers/daily.yaml' });
    expect(t.problems).toEqual([]);
    expect(t.def).toMatchObject({
      every: '24h',
      agent: 'claude:pm',
      prompt: 'Review the board',
      task: 'AO-0012',
      runs_on: ['desk'],
      enabled: false,
    });
  });
});

describe('triggers in a store', () => {
  function store(): string {
    const dir = join(tempDir(), '.swarmup');
    mkdirSync(join(dir, 'triggers'), { recursive: true });
    mkdirSync(join(dir, 'workflows'), { recursive: true });
    mkdirSync(join(dir, 'repeats'), { recursive: true });
    writeFileSync(join(dir, 'swarm.yaml'), 'swarmup_defs: 1\n');
    copyFileSync(
      join(templates, 'workflows', 'bugfix.yaml'),
      join(dir, 'workflows', 'bugfix.yaml'),
    );
    writeFileSync(join(dir, 'repeats', 'weekly.md'), '---\ntitle: Weekly\n---\n');
    return dir;
  }

  it('lists them, checks their targets, and hashes them', () => {
    const dir = store();
    const before = loadDefinitions(dir).hash;
    writeFileSync(
      join(dir, 'triggers', 'good.yaml'),
      'every: 1h\naction: workflow\nworkflow: bugfix\nruns_on: [desk]\n',
    );
    writeFileSync(
      join(dir, 'triggers', 'week.yaml'),
      'every: 1h\naction: repeat\nrepeat: weekly\nruns_on: [desk]\n',
    );
    writeFileSync(
      join(dir, 'triggers', 'lost.yaml'),
      'every: 1h\naction: workflow\nworkflow: nope\nruns_on: [desk]\n',
    );
    writeFileSync(
      join(dir, 'triggers', 'gone.yaml'),
      'every: 1h\naction: repeat\nrepeat: nope\nruns_on: [desk]\n',
    );
    writeFileSync(
      join(dir, 'triggers', 'who.yaml'),
      'every: 1h\naction: run\nagent: claude:ghost\n',
    );
    clearDefinitionsCache();
    const set = loadDefinitions(dir, { machineAgents: [] });
    expect(set.hash).not.toBe(before);
    expect(set.files.map((f) => f.path)).toContain('triggers/good.yaml');
    const defs = Object.fromEntries(set.triggers.map((t) => [t.name, t.def !== null]));
    expect(defs).toEqual({ gone: false, good: true, lost: false, week: true, who: true });
    // Each problem across files points at the key that names the missing target.
    const messages = set.problems.map(
      (p) => `${basename(p.file)}:${p.line}:${p.col}: ${p.severity}: ${p.path}: ${p.message}`,
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        'gone.yaml:3:1: error: repeat: no repeats/nope.md in this store',
        'lost.yaml:3:1: error: workflow: no workflows/nope.yaml in this store',
        "who.yaml:3:1: warning: agent: claude:ghost has no agent file in this store and is not in this machine's swarmupd.agents",
      ]),
    );
  });
});

describe('trigger trust', () => {
  const def = (text: string, name = 'digest') =>
    checkTriggerText(name, text, { file: `triggers/${name}.yaml` }).def!;
  const base = 'every: 1d\naction: run\nagent: claude:pm\nprompt: Write it.\n';

  it('hashes what fires, not what describes it', () => {
    const hash = triggersHash([def(base)]);
    expect(hash).toMatch(/^t:[0-9a-f]{64}$/);
    expect(triggersHash([def(`${base}description: Daily digest\n`)])).toBe(hash);
    expect(triggersHash([def(base.replace('Write it.', 'Push it.'))])).not.toBe(hash);
    expect(triggersHash([def(`${base}runs_on: [desk]\n`)])).not.toBe(hash);
    expect(triggersHash([def(`${base}enabled: false\n`)])).not.toBe(hash);
    expect(triggersHash([def(base), def(base, 'other')])).not.toBe(hash);
    expect(triggersHash([])).toBeNull();
  });
});

describe('cron across a daylight saving change', () => {
  it('fires a time the spring-forward gap skips at the first minute after it', () => {
    const saved = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // 2027-03-14: 02:00 becomes 03:00 in New York.
      const after = new Date(2027, 2, 14, 1, 0).getTime();
      const next = nextCron(parseCron('30 2 * * *'), after)!;
      expect(new Date(next).getHours()).toBe(3);
      expect(new Date(next).getMinutes()).toBe(0);
      expect(new Date(next).getDate()).toBe(14);
      // The next day runs at 02:30 again.
      const day2 = nextCron(parseCron('30 2 * * *'), next)!;
      expect([new Date(day2).getDate(), new Date(day2).getHours()]).toEqual([15, 2]);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
