// `swarmup trigger fire|test` (W8 phase 4): a person fires a webhook trigger's effect here, as a
// delivery would, or sends a payload through the local inbound listener to check the whole path.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { ParseArgsConfig } from 'node:util';
import type { Workspace } from '@swarmup/core';
import {
  OpsError,
  readSecrets,
  secretsPath,
  TRIGGER_NAME_RE,
  Workspace as Ws,
} from '@swarmup/core';
import type { HookTarget, RunRecord } from '@swarmup/supervisor';
import {
  appendHookLog,
  daemonCall,
  HOOK_BODY_MAX,
  hookConfig,
  hookRoots,
  hookTarget,
  opsdConfig,
  readDaemon,
  runHookEffect,
  signDelivery,
  stateDir,
} from '@swarmup/supervisor';
import { requirePerson } from './trust.js';

/** What `swarmup trigger` needs of the CLI's context. */
interface TriggerCtx {
  io: {
    out: (line: string) => void;
    err: (line: string) => void;
    env: NodeJS.ProcessEnv;
    cwd: string;
  };
  args: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
  ws: () => Workspace;
}

const USAGE =
  'trigger fire ROOT/NAME [--payload FILE] | trigger test ROOT/NAME --payload FILE [--sign]';

export const triggerCommand = {
  usage: USAGE,
  summary:
    "a person checks a webhook trigger (triggers/<name>.yaml with a webhook section), outside runs: fire does here what a delivery does (a finding for triage, or the action where swarmupd.hooks.direct approves it), with --payload as the body; test posts --payload to swarmupd's local inbound listener, signed with the trigger's secret from secrets.yml with --sign, and prints the answer",
  options: {
    payload: { type: 'string' },
    sign: { type: 'boolean' },
  } satisfies NonNullable<ParseArgsConfig['options']>,
  run: async (ctx: TriggerCtx): Promise<number> => {
    const [sub, ref, ...rest] = ctx.args;
    if (!ref || rest.length > 0 || (sub !== 'fire' && sub !== 'test')) {
      throw new OpsError(`usage: swarmup ${USAGE}`, 2);
    }
    const ws = ctx.ws();
    requirePerson(ws, `${sub === 'fire' ? 'fires' : 'tests'} a webhook trigger`);
    const m = /^([^/]+)\/([^/]+)$/.exec(ref);
    if (!m || !TRIGGER_NAME_RE.test(m[2]!)) {
      throw new OpsError(`name the trigger as ROOT/NAME, such as launch/linear-issue`, 2);
    }
    return sub === 'fire' ? await fire(ctx, ws, m[1]!, m[2]!) : await test(ctx, ws, m[1]!, m[2]!);
  },
};

/** The trigger a delivery would fire here, or a usage error that says why not. */
function target(ws: Workspace, root: string, name: string): HookTarget {
  const cfg = opsdConfig(ws.user);
  const t = hookTarget(
    hookRoots(ws),
    hookConfig({ config: cfg, machineConfig: cfg }),
    ws.user.machine,
    root,
    name,
  );
  if ('why' in t) throw new OpsError(`${root}/${name} takes no delivery here: ${t.why}`, 2);
  return t;
}

function payloadOf(ctx: TriggerCtx, required: boolean): Buffer {
  const file = typeof ctx.opts.payload === 'string' ? ctx.opts.payload : undefined;
  if (!file) {
    if (required) throw new OpsError('name the body to send: --payload FILE', 2);
    return Buffer.alloc(0);
  }
  let body: Buffer;
  try {
    body = readFileSync(file);
  } catch (err) {
    throw new OpsError(`cannot read ${file}: ${(err as Error).message}`, 2);
  }
  if (body.length > HOOK_BODY_MAX) {
    throw new OpsError(`${file} is over ${HOOK_BODY_MAX} bytes, the listener's body cap`, 2);
  }
  return body;
}

async function fire(ctx: TriggerCtx, ws: Workspace, root: string, name: string): Promise<number> {
  const t = target(ws, root, name);
  const body = payloadOf(ctx, false);
  const now = Date.now();
  const out = await runHookEffect(
    {
      // As swarmupd acts for a delivery: the trigger's actor, never the person, so a `starter`
      // workflow still waits for a person's approval.
      ws: (actor) => new Ws({ cwd: ctx.io.cwd, env: ctx.io.env, actor }),
      launch: async (r) => {
        const info = readDaemon(ctx.io.env);
        if (!info) throw new OpsError('swarmupd is not running, so no run can start');
        const run = await daemonCall<RunRecord>(info, 'POST', '/api/runs', {
          agent: r.agent,
          ...(r.task ? { task: r.task } : {}),
          extra: r.extra,
        });
        return run.id;
      },
      paused: opsdConfig(ws.user).paused,
    },
    t,
    { body: body.toString('utf8'), at: now, via: 'fire' },
  );
  appendHookLog(stateDir(ctx.io.env), {
    at: new Date(now).toISOString(),
    via: 'fire',
    root,
    trigger: name,
    status: 'accepted',
    code: 0,
    effect: out.effect,
    ref: out.ref,
    ...(out.fallback ? { reason: out.fallback } : {}),
  });
  const what = out.effect === 'run' ? `started run ${out.ref}` : `${out.effect} ${out.ref}`;
  ctx.io.out(`${root}/${name}: ${what}`);
  if (out.fallback) ctx.io.err(`note: filed for triage instead of the action: ${out.fallback}`);
  else if (out.effect === 'finding' && t.notDirect) ctx.io.err(`note: ${t.notDirect}`);
  return 0;
}

async function test(ctx: TriggerCtx, ws: Workspace, root: string, name: string): Promise<number> {
  const cfg = opsdConfig(ws.user);
  if (!cfg.hooks.enabled) {
    throw new OpsError(
      'the inbound listener is off: set swarmupd.hooks.enabled: true in the user config and restart swarmupd',
      2,
    );
  }
  const t = target(ws, root, name);
  let body = payloadOf(ctx, true);
  let headers: Record<string, string> = {};
  if (ctx.opts.sign) {
    const secret = readSecrets(ctx.io.env)[t.def.webhook.secret];
    if (secret === undefined) {
      throw new OpsError(`${secretsPath(ctx.io.env)} has no value for ${t.def.webhook.secret}`, 2);
    }
    ({ headers, body } = signDelivery(t.def.webhook, secret, body, Date.now()));
  }
  // A listener on every address still answers on loopback; the test never leaves this machine.
  const host = /^(0\.0\.0\.0|::|\[::\])$/.test(cfg.hooks.host) ? '127.0.0.1' : cfg.hooks.host;
  const path = `/hooks/${encodeURIComponent(root)}/${encodeURIComponent(name)}`;
  const res = await post(host, cfg.hooks.port, path, body, headers);
  ctx.io.out(`POST ${path}: ${res.status} ${res.text}`);
  return res.status >= 200 && res.status < 300 ? 0 : 1;
}

function post(
  host: string,
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: host.replace(/^\[|\]$/g, ''),
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(body.length),
          ...headers,
        },
        timeout: 15_000,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('no answer in 15 s')));
    req.on('error', (err) =>
      reject(
        new OpsError(
          `the inbound listener at ${host}:${port} does not answer (${err.message}); is swarmupd running with swarmupd.hooks.enabled?`,
        ),
      ),
    );
    req.end(body);
  });
}
