import type { ParseArgsConfig } from 'node:util';
import type { Workspace } from '@swarmup/core';
import {
  daemonKeyIn,
  editUserConfig,
  loadDefinitions,
  localTime,
  OpsError,
  readUserConfig,
  triggersHash,
  triggersTrust,
  untrustedTriggersText,
} from '@swarmup/core';
import { opsdConfig, RunStore, stateDir, TRIGGERS_STATE, triggersView } from '@swarmup/supervisor';
import { notifyDaemon, recordTrust, requirePerson, triggerLines } from './trust.js';

/** What `swarmup triggers` needs of the CLI's context. */
interface TriggersCtx {
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    env: NodeJS.ProcessEnv;
  };
  args: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
  ws: () => Workspace;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The roots a command acts on: the one `--root` names, else every root that is no mirror. */
function rootsOf(ctx: TriggersCtx): Array<{ name: string; dir: string }> {
  const ws = ctx.ws();
  const name = str(ctx.opts.root);
  const roots = ws.roots.filter((r) => !r.isMirror);
  if (!name) return roots.map((r) => ({ name: r.name, dir: r.dir }));
  const r = roots.find((x) => x.name === name);
  if (!r) throw new OpsError(`no root named '${name}'`, 2);
  return [{ name: r.name, dir: r.dir }];
}

export const triggersCommand = {
  usage: 'triggers list [--root NAME] [--json] | triggers on|off [--root NAME] [--trust]',
  summary:
    "the git triggers of each root (triggers/*.yaml): when each fires, what it starts, and whether and when it fires next on this machine; on and off turn a root's triggers on or off for this machine (swarmupd.triggers.<root>; a person, outside runs); on lists what would fire, and --trust also trusts that exact trigger set (else swarmup defs trust does)",
  options: { trust: { type: 'boolean' } } satisfies NonNullable<ParseArgsConfig['options']>,
  run: async (ctx: TriggersCtx): Promise<number> => {
    const [sub = 'list', ...rest] = ctx.args;
    if (rest.length > 0) throw new OpsError(`usage: swarmup ${triggersCommand.usage}`, 2);
    if (sub === 'list') return list(ctx);
    if (sub === 'on' || sub === 'off') return await turn(ctx, sub === 'on');
    throw new OpsError(`usage: swarmup ${triggersCommand.usage}`, 2);
  },
};

function list(ctx: TriggersCtx): number {
  const ws = ctx.ws();
  const cfg = opsdConfig(ws.user);
  const state = new RunStore(stateDir(ctx.io.env)).readJson<Record<string, number>>(
    TRIGGERS_STATE,
    {},
  );
  const roots = rootsOf(ctx);
  const views = triggersView(roots, cfg, ws.user.machine, state, Date.now());
  if (ctx.opts.json) {
    ctx.io.out(JSON.stringify(views, null, 2));
    return 0;
  }
  for (const r of roots) {
    const mine = views.filter((v) => v.root === r.name);
    const on = cfg.triggers[r.name] === true;
    ctx.io.out(
      `${r.name}: ${mine.length} trigger(s), ${on ? 'turned on' : 'off'} here` +
        (on ? '' : ` (swarmup triggers on --root ${r.name})`),
    );
    const trust = mine[0]?.trust;
    if (on && (trust === 'untrusted' || trust === 'changed')) {
      const count = mine.filter((v) => v.when).length;
      ctx.io.out(`  warning: ${untrustedTriggersText(r.name, trust, count)}`);
    }
    for (const v of mine) {
      const where = v.runs_on ? ` runs_on ${v.runs_on.join(', ')}` : '';
      const head = v.when ? `${v.when}  ${v.target}${where}` : 'has errors';
      const hook = v.hook
        ? `each delivery ${v.hook === 'direct' ? 'runs the action' : 'files a finding'}`
        : '';
      const time = v.next_fire
        ? `next ${localTime(Date.parse(v.next_fire))}`
        : hook
          ? ''
          : 'next never';
      const next = v.here
        ? [time, hook].filter(Boolean).join('; ')
        : [`not here: ${v.why}`, hook].filter(Boolean).join('; ');
      const last = v.last_fire ? `, last ${localTime(Date.parse(v.last_fire))}` : '';
      ctx.io.out(`  ${v.name}  ${head}  ${next}${last}`);
    }
  }
  return 0;
}

async function turn(ctx: TriggersCtx, on: boolean): Promise<number> {
  const ws = ctx.ws();
  requirePerson(ws, `turns git triggers ${on ? 'on' : 'off'}`);
  const roots = rootsOf(ctx);
  if (roots.length !== 1) {
    throw new OpsError('name the root: swarmup triggers on|off --root NAME [--trust]', 2);
  }
  const root = roots[0]!;
  editUserConfig(
    ctx.io.env,
    (doc) => {
      doc.setIn([daemonKeyIn(doc), 'triggers', root.name], on);
    },
    (next) => void opsdConfig(next),
  );
  if (!on) {
    ctx.io.out(`${root.name}: this machine runs none of its git triggers`);
    await notifyDaemon(ctx.io.env);
    return 0;
  }
  // What turning them on lets fire, so the person sees it before trusting it.
  const defs = loadDefinitions(root.dir).triggers.flatMap((t) => (t.def ? [t.def] : []));
  const hash = triggersHash(defs);
  const trusted = opsdConfig(readUserConfig(ctx.io.env)).trusted_defs[root.name]?.triggers;
  const state = triggersTrust(defs, trusted);
  ctx.io.out(
    `${root.name}: this machine runs the git triggers it trusts, from swarmupd's next tick`,
  );
  if (!hash) {
    ctx.io.out('  the store has no triggers yet');
    await notifyDaemon(ctx.io.env);
    return 0;
  }
  for (const l of triggerLines(defs)) ctx.io.out(l);
  if (state === 'trusted') {
    await notifyDaemon(ctx.io.env);
    return 0;
  }
  if (ctx.opts.trust) {
    await recordTrust(ctx.io.env, [{ root: root.name, triggers: hash }]);
    ctx.io.out(`  trusted these triggers (${hash.slice(0, 14)}); any change needs a new trust`);
    return 0;
  }
  ctx.io.out(
    `  ${untrustedTriggersText(root.name, state, defs.length)}, or \`swarmup triggers on --root ${root.name} --trust\``,
  );
  await notifyDaemon(ctx.io.env);
  return 0;
}
