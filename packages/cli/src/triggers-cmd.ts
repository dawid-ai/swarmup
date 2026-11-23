import type { Workspace } from '@swarmup/core';
import { daemonKeyIn, editUserConfig, localTime, OpsError } from '@swarmup/core';
import {
  daemonCall,
  opsdConfig,
  readDaemon,
  RunStore,
  stateDir,
  TRIGGERS_STATE,
  triggersView,
} from '@swarmup/supervisor';

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
  usage: 'triggers list [--root NAME] [--json] | triggers on|off [--root NAME]',
  summary:
    "the git triggers of each root (triggers/*.yaml): when each fires, what it starts, and whether and when it fires next on this machine; on and off turn a root's triggers on or off for this machine (swarmupd.triggers.<root>)",
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
    for (const v of mine) {
      const where = v.runs_on ? ` runs_on ${v.runs_on.join(', ')}` : '';
      const head = v.when ? `${v.when}  ${v.target}${where}` : 'has errors';
      const next = v.here
        ? `next ${v.next_fire ? localTime(Date.parse(v.next_fire)) : 'never'}`
        : `not here: ${v.why}`;
      const last = v.last_fire ? `, last ${localTime(Date.parse(v.last_fire))}` : '';
      ctx.io.out(`  ${v.name}  ${head}  ${next}${last}`);
    }
  }
  return 0;
}

async function turn(ctx: TriggersCtx, on: boolean): Promise<number> {
  const roots = rootsOf(ctx);
  if (roots.length !== 1) {
    throw new OpsError('name the root: swarmup triggers on|off --root NAME', 2);
  }
  const root = roots[0]!.name;
  editUserConfig(
    ctx.io.env,
    (doc) => {
      doc.setIn([daemonKeyIn(doc), 'triggers', root], on);
    },
    (next) => void opsdConfig(next),
  );
  ctx.io.out(
    on
      ? `${root}: this machine runs its git triggers from swarmupd's next tick`
      : `${root}: this machine runs none of its git triggers`,
  );
  // A running swarmupd reads the user config again at once.
  const info = readDaemon(ctx.io.env);
  if (info) await daemonCall(info, 'POST', '/api/settings', { patch: {} }).catch(() => undefined);
  return 0;
}
