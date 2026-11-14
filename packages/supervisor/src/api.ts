import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { sep } from 'node:path';
import type {
  AgentDef,
  MarkInput,
  Priority,
  RepeatInput,
  RoleInput,
  TaskView,
  Workspace,
} from '@swarmup/core';
import {
  findAttachment,
  listDecisionIds,
  MAX_ATTACHMENT_BYTES,
  OpsError,
  openQuestion,
  readPresence,
} from '@swarmup/core';
import {
  agentDirectory,
  applySettings,
  deleteSchedule,
  mirrorRoot,
  saveSchedule,
  schedulesView,
  settingsView,
  standup,
} from './admin.js';
import { NoDiff } from './diff.js';
import { doctor } from './doctor.js';
import { buildReport, reportWindow } from './report.js';
import { buildWrapped } from './wrapped.js';
import type { SettingsPatch } from './admin.js';
import { pageRuns, RUN_FILTERS } from './runs.js';
import type { RunFilter, RunRecord } from './runs.js';
import { liveRunsEndMessage } from './supervisor.js';
import type { Supervisor } from './supervisor.js';

export interface ApiOptions {
  port: number;
  token: string;
  /** Called after a POST /api/shutdown has been answered. */
  onShutdown?: (killRuns: boolean) => void;
  version?: string;
  /** `buildStamp()` at start, so the desktop can tell a swarmupd older than its install. */
  build?: string;
}

export interface ApiServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

type Json = Record<string, unknown>;

const MAX_BODY = 1024 * 1024;
/** An attachment upload: the largest image in base64, plus room for the other fields. */
const MAX_ATTACHMENT_BODY = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Serves the supervisor on 127.0.0.1 for the desktop app and `swarmup`. Every request needs the token
 * from `opsd.json` (header `Authorization: Bearer <token>`, or `?token=` for event streams) and a
 * localhost Host header, so web pages in a browser cannot reach it. A live run's own token
 * (`SWARMUP_RUN_TOKEN`) also passes; it acts as that run's agent and cannot take human actions.
 *
 * Push uses Server-Sent Events at `/api/events` (`hello`, `run`, `tasks`, `changed`, `sync`,
 * `warn`); commands
 * go over plain HTTP.
 */
/**
 * Runs jobs one per turn of the event loop, in the order they came. Between two jobs the loop
 * takes what arrived meanwhile, so a request that came after a round of queued reads is not held
 * until the last of them is answered.
 */
export class TurnQueue {
  private readonly jobs: (() => void)[] = [];
  private waiting = false;

  push(job: () => void): void {
    this.jobs.push(job);
    this.next();
  }

  private next(): void {
    if (this.waiting || this.jobs.length === 0) return;
    this.waiting = true;
    // An immediate set inside an immediate runs in the next turn, after the loop polled for I/O.
    setImmediate(() => {
      this.waiting = false;
      const job = this.jobs.shift();
      try {
        job?.();
      } finally {
        this.next();
      }
    });
  }
}

export function startApi(sup: Supervisor, opts: ApiOptions): Promise<ApiServer> {
  const streams = new Set<ServerResponse>();
  let port = opts.port;
  let lastSig = '';
  let poll: NodeJS.Timeout | undefined;

  const broadcast = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const s of streams) s.write(frame);
  };
  let lastData = '';
  // Tasks, channel messages and votes all change by files that agents write directly, so the API
  // compares signatures: `tasks` when a task changed, `changed` when anything did.
  const checkTasks = (): void => {
    try {
      const ws = sup.ws();
      const sig = taskSignature(ws.views());
      const data = `${sig}#${collabSignature(ws)}`;
      const first = lastData === '';
      if (sig !== lastSig) {
        lastSig = sig;
        if (!first) broadcast('tasks', { at: new Date().toISOString() });
      }
      if (data !== lastData) {
        lastData = data;
        if (!first) broadcast('changed', { at: new Date().toISOString() });
      }
    } catch (err) {
      broadcast('warn', { message: (err as Error).message });
    }
  };
  const onRun = (r: RunRecord): void => broadcast('run', r);
  const onWarn = (message: string): void => broadcast('warn', { message });
  const onSync = (res: unknown): void => broadcast('sync', res);
  sup.on('run', onRun);
  sup.on('warn', onWarn);
  sup.on('sync', onSync);
  // A provider was signed out or signed in again: the app's banner reads `/api/usage` again.
  const onSignIn = (): void => broadcast('signin', {});
  sup.on('signin', onSignIn);
  // The chat: `streaming` carries the live reply so far, `changed` a new message or state.
  const onChat = (data: unknown): void => broadcast('chat', data);
  sup.on('chat', onChat);
  // The merge under way started, moved on or ended: the app reads `/api/waits` again (AO-0161).
  const onMerge = (status: unknown): void => broadcast('merge', status);
  sup.on('merge-status', onMerge);
  sup.on('tick', checkTasks);

  const reads = new TurnQueue();
  const server = createServer((req, res) => {
    // The app reads some seven paths at once after each run or task event. Answered back to
    // back they held a write that arrived then, such as a chat send at the start or end of a
    // PM turn, for the whole round (AO-0277). Reads wait their turn; a write is answered now.
    if (req.method === 'GET') {
      reads.push(() => {
        // The client gave up while the read waited: nobody reads the answer.
        if (!res.destroyed) answer(req, res);
      });
    } else answer(req, res);
  });
  const answer = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).then(
      // A write through the API shows in open windows at once, not at the next poll.
      () => {
        if (req.method === 'POST') checkTasks();
      },
      (err: unknown) => {
        const status =
          err instanceof HttpError
            ? err.status
            : err instanceof OpsError
              ? err.code === 2
                ? 400
                : 409
              : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) send(res, status, { error: message });
        else res.end();
      },
    );
  };

  // Node closes an idle keep-alive socket after 5 s by default. A client whose event loop stalls
  // past that sends its next request as the server closes the socket, and fetch fails with 'other
  // side closed' without retrying a POST. Clients are few and local, so idle sockets stay open
  // until the client closes them or `close()` runs (AO-0223).
  server.keepAliveTimeout = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      throw new HttpError(403, 'bad host');
    }
    const auth = req.headers.authorization ?? '';
    // EventSource cannot send headers, so the event stream alone may carry the token in the URL.
    const streamRoute = req.method === 'GET' && url.pathname === '/api/events';
    const token = auth.startsWith('Bearer ')
      ? auth.slice(7)
      : streamRoute
        ? url.searchParams.get('token')
        : null;
    // The full token (the desktop app, `swarmup` outside a run) may act as anyone with `as`. A run's
    // own token (`SWARMUP_RUN_TOKEN`) acts as that run's agent only and never reaches human actions.
    const run = token && token !== opts.token ? sup.runByToken(token) : undefined;
    if (token !== opts.token && !run) throw new HttpError(401, 'missing or wrong token');

    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'api') throw new HttpError(404, 'not found');
    const [, area, id, action] = parts;
    const q = url.searchParams;
    const limit = area === 'attachments' ? MAX_ATTACHMENT_BODY : MAX_BODY;
    const body = method === 'POST' ? await readBody(req, limit) : {};
    const actor = run ? run.agent : (str(body.as) ?? str(q.get('as'))) || undefined;
    /** A workspace acting as the caller: a run's token also binds its run id and helper status. */
    const wsAs = (): Workspace =>
      run ? sup.ws(run.agent, run.id, Boolean(run.parent)) : sup.ws(actor);
    const humanOnly = (what: string): void => {
      if (run) throw new HttpError(403, `${what} is for the human; run ${run.id} cannot do it`);
    };
    /** A run may mutate only itself or one of its direct helpers. */
    const ownRunOnly = (runId: string, what: string): void => {
      if (run && runId !== run.id && sup.run(runId).parent !== run.id) humanOnly(what);
    };

    if (method === 'GET' && area === 'usage') return send(res, 200, sup.usageReport());
    // The app's Resume on a signed-out provider, and `swarmup daemon resume` (AO-0154).
    if (method === 'POST' && area === 'signin' && id === 'resume') {
      humanOnly('resuming a signed-out provider');
      const provider = str(body.provider);
      return send(res, 200, { resumed: sup.resumeSignIn(provider), providers: sup.usageReport() });
    }
    if (area === 'settings') {
      if (method === 'POST') humanOnly('changing settings');
      if (method === 'POST') applySettings(sup, (body.patch ?? body) as SettingsPatch);
      if (method === 'GET' || method === 'POST') return send(res, 200, settingsView(sup));
    }
    if (area === 'schedules') {
      if (method === 'GET' && !id) return send(res, 200, schedulesView(sup));
      if (method === 'POST' && !id) {
        humanOnly('editing schedules');
        saveSchedule(sup, body, str(body.previous) || undefined);
        return send(res, 200, schedulesView(sup));
      }
      if (method === 'POST' && id && action === 'run') {
        humanOnly(`running schedule ${id}`);
        return send(res, 201, sup.runScheduleNow(id));
      }
      if (method === 'POST' && id && action === 'delete') {
        humanOnly(`deleting schedule ${id}`);
        deleteSchedule(sup, id);
        return send(res, 200, schedulesView(sup));
      }
    }
    if (area === 'repeats') {
      // Repeats create approved work, so only the human manages them (AO-0142).
      if (method === 'GET' && !id) return send(res, 200, wsAs().repeats());
      if (method === 'GET' && id) return send(res, 200, wsAs().repeatView(id));
      if (method === 'POST') humanOnly('managing repeats');
      if (method === 'POST' && !id) {
        const ws = wsAs();
        ws.saveRepeat(repeatInput(body), { replace: body.replace === true });
        return send(res, 200, ws.repeats());
      }
      if (method === 'POST' && id && (action === 'pause' || action === 'resume')) {
        return send(res, 200, wsAs().setRepeatPaused(id, action === 'pause'));
      }
      if (method === 'POST' && id && action === 'run') {
        return send(res, 201, wsAs().runRepeat(id));
      }
      if (method === 'POST' && id && action === 'delete') {
        const ws = wsAs();
        ws.deleteRepeat(id);
        return send(res, 200, ws.repeats());
      }
    }
    if (method === 'GET' && area === 'standup') {
      return send(res, 200, standup(sup, Number(q.get('hours') ?? 24)));
    }
    if (area === 'chat') {
      if (method === 'GET' && !id) return send(res, 200, sup.chat.view());
      // One message by id: the source of a recorded decision (`--source chat:<id>`, AO-0109).
      if (method === 'GET' && id === 'messages' && action) {
        const m = sup.chat.message(action);
        if (!m) throw new HttpError(404, `no message ${action} in the PM chat`);
        return send(res, 200, m);
      }
      // The chat is the human's conversation with the orchestrator: a run may read it, not drive it.
      if (method === 'POST') humanOnly('the orchestrator chat');
      if (method === 'POST' && !id)
        return send(res, 200, sup.chat.send(need(body.text, 'text'), actor, { later: true }));
      if (method === 'POST' && id === 'stop') return send(res, 200, sup.chat.stop());
      if (method === 'POST' && id === 'reset') return send(res, 200, sup.chat.reset());
    }
    if (method === 'GET' && area === 'waits') {
      // The merge under way goes with what waits: a merge can hold every writing run (AO-0161).
      return send(res, 200, {
        providers: sup.usageReport(),
        waits: sup.waits(),
        merge: sup.mergeStatus(),
      });
    }

    if (method === 'POST' && area === 'notify' && id === 'test') {
      humanOnly('sending a test notification');
      return send(res, 200, await sup.notifyTest());
    }
    if (method === 'POST' && area === 'roots' && id && action === 'mirror') {
      humanOnly(`changing mirroring for root ${id}`);
      return send(res, 200, mirrorRoot(sup, id, body.on));
    }
    if (method === 'GET' && area === 'doctor') {
      const { env, cwd } = sup.context;
      return send(
        res,
        200,
        await doctor({ env, cwd, self: { pid: process.pid, build: opts.build } }),
      );
    }
    if (method === 'GET' && area === 'health') {
      return send(res, 200, {
        ok: true,
        pid: process.pid,
        version: opts.version,
        build: opts.build,
        live: sup.runs({ live: true }).length,
        me: sup.ws().actor,
        paused: sup.config.paused,
        runs_outlive: sup.runsOutlive,
      });
    }
    if (method === 'GET' && area === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ pid: process.pid })}\n\n`);
      streams.add(res);
      if (!poll) {
        checkTasks();
        poll = setInterval(checkTasks, 3000);
      }
      req.on('close', () => {
        streams.delete(res);
        if (streams.size === 0 && poll) {
          clearInterval(poll);
          poll = undefined;
        }
      });
      return;
    }

    if (area === 'runs') {
      if (method === 'GET' && !id) {
        // With `limit`, one page and the view's counts instead of every record (AO-0167).
        const limit = wholeParam(q.get('limit'), 'limit', 1, 1000);
        if (limit === undefined || q.has('live')) {
          return send(res, 200, sup.runs({ live: q.has('live') }));
        }
        const filter = q.get('filter') || 'all';
        if (!(RUN_FILTERS as readonly string[]).includes(filter)) {
          throw new HttpError(400, `filter: use one of ${RUN_FILTERS.join(', ')}`);
        }
        const since = q.get('since') || undefined;
        if (since !== undefined && Number.isNaN(Date.parse(since))) {
          throw new HttpError(400, 'since: use an ISO date and time');
        }
        return send(
          res,
          200,
          pageRuns(sup.runs(), {
            limit,
            before: q.get('before')?.toUpperCase() || undefined,
            from: q.get('from')?.toUpperCase() || undefined,
            filter: filter as RunFilter,
            since,
            pick: q.get('pick') || undefined,
          }),
        );
      }
      if (method === 'POST' && !id) {
        const agent = need(body.agent, 'agent');
        const parent = str(body.parent);
        // A run may start a helper of itself (any agent), or another run of its own agent.
        if (run && (parent ? parent !== run.id : agent !== run.agent)) {
          humanOnly(parent ? `starting a helper of run ${parent}` : `starting a run of ${agent}`);
        }
        const launched = await sup.launchFresh({
          agent,
          task: str(body.task),
          prompt: str(body.prompt),
          cwd: str(body.cwd),
          budget: str(body.budget),
          tokens: str(body.tokens),
          parent,
        });
        return send(res, 201, launched);
      }
      const runId = findRun(sup, need(id, 'run id'));
      if (method === 'GET' && !action) return send(res, 200, sup.run(runId));
      if (method === 'GET' && action === 'log') {
        const tail = Number(q.get('tail') ?? 65536);
        return sendText(res, readTail(sup.run(runId).log, tail));
      }
      if (method === 'POST' && action === 'kill') {
        ownRunOnly(runId, `stopping run ${runId}`);
        return send(res, 200, sup.kill(runId, str(body.reason) ?? 'killed'));
      }
      if (method === 'GET' && action === 'procs') return send(res, 200, await sup.procs(runId));
      // Kills what an ended run left behind.
      if (method === 'POST' && action === 'procs') {
        ownRunOnly(runId, `stopping processes of run ${runId}`);
        const pid = body.pid === undefined ? undefined : Number(body.pid);
        if (pid !== undefined && !Number.isInteger(pid))
          throw new HttpError(400, 'pid must be a number');
        return send(res, 200, await sup.reapNow(runId, pid));
      }
    }

    if (area === 'tasks') {
      const ws = wsAs();
      if (method === 'GET' && !id) {
        return send(res, 200, ws.list({ all: q.has('all') }).map(compact));
      }
      if (method === 'POST' && !id) {
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        // `root` names the data root the task goes to (AO-0323): its store, code checkout, agents
        // and merge settings then handle it. Without it, the default root, as before.
        const rootName = str(body.root)?.trim() || undefined;
        const root = rootName ? ws.roots.find((r) => r.name === rootName) : undefined;
        if (rootName && !root) {
          const names = ws.roots.map((r) => r.name).join(', ');
          throw new HttpError(400, `no root named '${rootName}': use one of ${names}`);
        }
        const { meta, proposed } = ws.addTask(
          {
            title: need(body.title, 'title'),
            body: str(body.body),
            owner: str(body.to) || undefined,
            type: str(body.type) || undefined,
            priority: (str(body.priority) || undefined) as Priority | undefined,
            project: str(body.project) || undefined,
            parent: str(body.parent) || undefined,
          },
          root,
        );
        const warnings = ws.reachWarnings([meta.owner]);
        // The root's name with the id: another root may hold a task with the same id.
        const task = {
          ...compact(ws.view(`${(root ?? ws.defaultRoot()).name}/${meta.id}`)),
          proposed,
        };
        return send(res, 201, warnings.length > 0 ? { ...task, warnings } : task);
      }
      const ref = need(id, 'task id');
      if (method === 'GET' && action === 'diff') {
        // The diff of the commits the task's review names, from the local repo (AO-0106).
        try {
          return send(res, 200, await sup.taskDiff(ref));
        } catch (err) {
          if (err instanceof NoDiff) throw new HttpError(404, err.message);
          throw err;
        }
      }
      if (method === 'GET' && !action) {
        const { body: text, events } = ws.showEvents(ref);
        return send(res, 200, { task: compact(ws.view(ref)), body: text, events });
      }
      if (method === 'POST') {
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const msg = str(body.message) ?? '';
        const mark = markInput(body);
        // Only the commands whose event can mark a decision take one (AO-0109).
        if (mark && !['comment', 'answer', 'park', 'retype', 'verdict'].includes(action ?? '')) {
          throw new HttpError(400, `'${action}' cannot mark a decision`);
        }
        const result = (() => {
          switch (action) {
            case 'comment':
              return ws.comment(ref, msg, str(body.to), mark);
            case 'start':
              return ws.start(ref, msg);
            case 'block': {
              const on = Array.isArray(body.on)
                ? body.on.map(String)
                : str(body.on)
                  ? str(body.on)!
                      .split(/[\s,]+/)
                      .filter(Boolean)
                  : undefined;
              if (!msg.trim()) throw new HttpError(400, 'a block needs a reason');
              return ws.block(ref, msg, { on, to: str(body.to) || undefined });
            }
            case 'review':
              return ws.review(ref, msg, str(body.to) || undefined);
            case 'answer':
              humanOnly('answering');
              return ws.answer(ref, msg, mark);
            case 'unblock':
              return ws.unblock(ref, msg);
            case 'done':
              return ws.done(ref, msg);
            case 'release':
              return ws.release(ref, msg);
            case 'reopen':
              return ws.reopen(ref, msg);
            case 'park':
              return ws.park(ref, msg, mark);
            case 'assign':
              return ws.assign(ref, need(body.to, 'to'), msg);
            case 'priority':
              return ws.setPriority(ref, need(body.priority, 'priority') as Priority, msg);
            case 'retype':
              return ws.retype(ref, need(body.type, 'type'), msg, {
                to: str(body.to) || undefined,
                answer: str(body.answer) || undefined,
                priority: (str(body.priority) || undefined) as Priority | undefined,
                mark,
              });
            case 'verdict': {
              humanOnly('a verdict');
              const v = need(body.verdict, 'verdict');
              if (v !== 'approve' && v !== 'changes') throw new HttpError(400, 'bad verdict');
              return ws.verdict(ref, v, msg, mark);
            }
            case 'delegate':
              return ws.delegate(ref, need(body.to, 'to'), {
                budget: str(body.budget),
                tokens: str(body.tokens),
                due: str(body.due),
                review: str(body.review),
                message: msg,
              });
            default:
              throw new HttpError(404, `no task action '${action}'`);
          }
        })();
        return send(res, 200, {
          task: compact(result.view),
          events: result.events,
          warnings: result.warnings,
          // The record a `decision` in the body wrote, by id.
          decision: result.decision?.id,
        });
      }
    }

    if (method === 'GET' && area === 'agents') {
      // Role files, plus agents only the swarmupd config names; `wake` from the config.
      const defined = sup
        .ws()
        .agents()
        .map(({ body: _b, ...a }) => a);
      const ids = new Set(defined.map((a) => a.id));
      const configured = Object.keys(sup.config.agents)
        .filter((id) => !ids.has(id))
        .map((id) => ({ id, status: 'active' as const }));
      return send(
        res,
        200,
        [...defined, ...configured].map((a) => ({
          ...a,
          wake: sup.config.agents[a.id]?.wake ?? false,
          // Listed in the swarmupd config, so the Agents view can remove it there.
          configured: Object.hasOwn(sup.config.agents, a.id),
          // The provider it runs on is in Settings > Providers.
          provider: Object.hasOwn(sup.config.runtimes, a.id.split(':')[0] ?? ''),
          live: sup.liveFor(a.id)?.id ?? null,
        })),
      );
    }
    if (method === 'GET' && area === 'directory') return send(res, 200, agentDirectory(sup));
    if (area === 'roles') {
      const ws = wsAs();
      if (method === 'GET' && id) {
        const def = ws.agent(id);
        if (!def) throw new HttpError(404, `no role file for ${id}`);
        const root = ws.roots.find((r) => def.file.startsWith(r.dir + sep))?.name ?? null;
        return send(res, 200, { ...roleOut(def), root });
      }
      if (method === 'POST' && !id) {
        humanOnly('editing role files');
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const role = (body.role ?? {}) as RoleInput;
        if (typeof role !== 'object' || Array.isArray(role))
          throw new HttpError(400, 'role: expected an object');
        const def = ws.saveRole(role, {
          root: str(body.root) || undefined,
          create: body.create === true,
        });
        return send(res, body.create === true ? 201 : 200, roleOut(def));
      }
    }
    if (method === 'GET' && area === 'inbox') {
      const ws = wsAs();
      return send(res, 200, ws.inbox(ws.requireActor(), { markRead: q.has('markRead') }));
    }
    if (area === 'decisions') {
      const ws = wsAs();
      // The decision log, as `swarmup decisions --log` lists it (AO-0109): `all` adds the
      // superseded ones; `project` or `task` narrows it.
      if (method === 'GET' && !id && q.has('log')) {
        return send(
          res,
          200,
          ws.decisionLog({
            all: q.has('all'),
            project: q.get('project') || undefined,
            task: q.get('task') || undefined,
          }),
        );
      }
      if (method === 'GET' && !id) return send(res, 200, ws.decisions({ all: q.has('all') }));
      // A new record, as `swarmup decision TEXT` writes it: the app's Supersede sends it.
      if (method === 'POST' && !id) {
        humanOnly('recording a decision');
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const rec = ws.recordDecision({
          text: need(body.text, 'text'),
          body: str(body.message),
          root: str(body.root) || undefined,
          project: str(body.project) || undefined,
          task: str(body.task) || undefined,
          scope: str(body.scope) || undefined,
          supersedes: idList(body.supersedes, 'supersedes'),
          narrows: idList(body.narrows, 'narrows'),
        });
        return send(res, 201, {
          root: rec.root,
          id: rec.meta.id,
          meta: rec.meta,
          warnings: rec.warnings.length > 0 ? rec.warnings : undefined,
        });
      }
      if (method === 'GET' && id) return send(res, 200, ws.decision(id));
      if (method === 'POST' && id && action === 'decide') {
        return send(res, 200, ws.decide(id, need(body.choice, 'choice'), str(body.message) ?? ''));
      }
      if (method === 'POST' && id && action === 'vote') {
        return send(res, 200, ws.vote(id, need(body.choice, 'choice'), str(body.message) ?? ''));
      }
    }
    if (method === 'GET' && area === 'machines') {
      return send(res, 200, readPresence(sup.ws().roots));
    }
    if (method === 'GET' && area === 'report') {
      const w = reportWindow({ days: q.get('days'), from: q.get('from'), to: q.get('to') });
      const project = q.get('project') || undefined;
      const root = q.get('root') || undefined;
      return send(res, 200, buildReport(wsAs(), sup.runs(), w.from, w.to, { project, root }));
    }
    if (method === 'GET' && area === 'timeline') {
      // The replay timeline of `project` (or of every project) in `root` (or every root), for
      // the report's window (`days`, or `from` and `to`). `clip` scales playback to that many
      // seconds; `gap` is the minutes an idle stretch plays as (default 30). `wrapped=1` adds
      // the Wrapped cards of the project and window (AO-0084), from the report of the same root
      // and project; the cards of a root without a project carry the root's name (AO-0301).
      // `graph=1` adds task links and the files events name, for the constellation (AO-0080).
      const w = reportWindow(
        { days: q.get('days'), from: q.get('from'), to: q.get('to') },
        Date.now(),
        'timeline',
      );
      const clip = wholeParam(q.get('clip'), 'clip', 1, 3600);
      const gap = wholeParam(q.get('gap'), 'gap', 1, 1440);
      const project = q.get('project') || undefined;
      const root = q.get('root') || undefined;
      const ws = wsAs();
      const timeline = ws.timeline({
        root,
        project,
        from: w.from,
        to: w.to,
        ...(clip !== undefined ? { clipMs: clip * 1000 } : {}),
        ...(gap !== undefined ? { maxGapMs: gap * 60_000 } : {}),
        graph: q.get('graph') === '1',
      });
      if (q.get('wrapped') !== '1') return send(res, 200, timeline);
      const report = buildReport(ws, sup.runs(), w.from, w.to, { project, root });
      const named = { ...report, project: report.project ?? root ?? null };
      return send(res, 200, { ...timeline, wrapped: buildWrapped(named, timeline) });
    }
    if (method === 'GET' && area === 'activity') {
      // One page, newest first: `q` filters (words, `agent:`, `task:`, `kind:`; see
      // parseActivityQuery), `before` is the `next` of the page before.
      const limit = Number(q.get('limit') ?? 100);
      return send(
        res,
        200,
        wsAs().activityPage({
          q: (q.get('q') ?? '').slice(0, 500),
          before: q.get('before') || undefined,
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
        }),
      );
    }
    if (method === 'GET' && area === 'search') {
      // Words, phrases and filters such as `agent:codex status:blocked`; see parseQuery.
      const text = (q.get('q') ?? '').slice(0, 500);
      const limit = Math.min(Math.max(Number(q.get('limit')) || 50, 1), 200);
      return send(res, 200, wsAs().searchResult(text, { limit }));
    }
    if (method === 'GET' && area === 'kb') {
      const ws = wsAs();
      if (id && action && parts.length === 4) {
        // One note: `/api/kb/<topic>/<slug>`, with `?root=` when the ref exists in several roots.
        const root = q.get('root');
        const note = ws.kbNote(root ? `${root}/${id}/${action}` : `${id}/${action}`);
        // The local file path stays on this machine.
        return send(res, 200, { ...note, file: undefined });
      }
      if (id) throw new HttpError(404, 'use /api/kb or /api/kb/<topic>/<slug>');
      // Same matching as `swarmup kb`: every word must match; no words lists every note, newest first.
      const words = (q.get('q') ?? '').split(/\s+/).filter(Boolean);
      const hits = ws.kb(words, q.get('topic') || undefined);
      return send(
        res,
        200,
        hits.map(({ note: { file: _file, ...note }, score }) => ({ ...note, score })),
      );
    }
    if (area === 'attachments') {
      if (method === 'POST' && !id) {
        const ws = wsAs();
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const data = need(body.data, 'data');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HttpError(400, 'data: expected base64');
        const a = ws.attach(Buffer.from(data, 'base64'), {
          task: str(body.task) || undefined,
          alt: str(body.alt) || undefined,
        });
        // The local file path stays on this machine.
        return send(res, 201, { ...a, file: undefined });
      }
      if (method === 'GET' && id && !action) {
        // Only `<ULID>.<ext>` names resolve, and only inside a root's attachments folder.
        const attachment = findAttachment(sup.ws().roots, id);
        if (!attachment) throw new HttpError(404, `no attachment ${id}`);
        const data = readFileSync(attachment.file);
        res.writeHead(200, {
          'content-type': attachment.type,
          'content-length': data.length,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'",
          // An attachment never changes: every file gets a new ULID name.
          'cache-control': 'private, max-age=31536000, immutable',
        });
        res.end(data);
        return;
      }
    }
    if (area === 'channels') {
      const ws = wsAs();
      if (method === 'GET' && !id) return send(res, 200, ws.channels());
      if (method === 'GET' && id) {
        // `?root=` reads one root; `?around=<message id>` loads the messages around that one.
        return send(
          res,
          200,
          ws.channel(id, {
            limit: Number(q.get('limit') ?? 100),
            root: q.get('root') || undefined,
            around: q.get('around') || undefined,
          }),
        );
      }
      if (method === 'POST' && !id) {
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        return send(res, 201, ws.createChannel(need(body.name, 'name'), str(body.description)));
      }
      if (method === 'POST' && id) {
        const m = ws.post(id, need(body.message, 'message'));
        // Mentions that reach no agent are posted anyway; the poster hears about them at once.
        const warnings = ws.reachWarnings(m.mentions ?? []);
        return send(res, 201, warnings.length > 0 ? { ...m, warnings } : m);
      }
    }
    if (method === 'POST' && area === 'shutdown') {
      humanOnly('stopping swarmupd; use `swarmup ask --human` to request a restart');
      const killRuns = body.killRuns === true;
      // ifIdle: shut down only when no run is live, decided in one step with stopping launches.
      if (body.ifIdle === true && !sup.quiesceIfIdle()) throw new HttpError(409, 'runs are live');
      // Where runs end with swarmupd (runsOutlive off), a stop that keeps runs needs none live.
      if (!killRuns && !sup.runsOutlive && !sup.quiesceIfIdle()) {
        throw new HttpError(409, liveRunsEndMessage(sup.runs({ live: true }).length));
      }
      send(res, 200, { ok: true });
      setImmediate(() => opts.onShutdown?.(killRuns));
      return;
    }
    throw new HttpError(404, `no route ${method} ${url.pathname}`);
  }

  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolveStart({
        server,
        port,
        close: () =>
          new Promise<void>((done) => {
            if (poll) clearInterval(poll);
            for (const s of streams) s.end();
            streams.clear();
            sup.off('run', onRun);
            sup.off('warn', onWarn);
            sup.off('sync', onSync);
            sup.off('signin', onSignIn);
            sup.off('chat', onChat);
            sup.off('merge-status', onMerge);
            sup.off('tick', checkTasks);
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** A list of ids from a request body: a list of text, or text with commas. */
function idList(v: unknown, name: string): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const all = typeof v === 'string' ? v.split(',') : v;
  if (!Array.isArray(all) || !all.every((x) => typeof x === 'string')) {
    throw new HttpError(400, `${name}: use a list of text`);
  }
  const out = (all as string[]).map((x) => x.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/**
 * The decision a task write marks (`--decision` of the CLI, AO-0109): `decision` is its one line;
 * `scope`, `supersedes` and `narrows` describe it, so they are refused without one.
 */
function markInput(body: Json): MarkInput | undefined {
  const text = str(body.decision);
  const scope = str(body.scope) || undefined;
  const supersedes = idList(body.supersedes, 'supersedes');
  const narrows = idList(body.narrows, 'narrows');
  if (text === undefined) {
    const lone = scope ? 'scope' : supersedes ? 'supersedes' : narrows ? 'narrows' : null;
    if (lone) throw new HttpError(400, `${lone} describes a decision: add decision, its one line`);
    return undefined;
  }
  return { text, scope, supersedes, narrows };
}

function need(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `missing ${name}`);
  return v;
}

/** A whole number from `min` to `max` in a query parameter, or undefined when it is not given. */
function wholeParam(v: string | null, name: string, min: number, max: number): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!/^\d+$/.test(v) || n < min || n > max) {
    throw new HttpError(400, `${name}: use a whole number from ${min} to ${max}`);
  }
  return n;
}

/** A repeat from a request body; text fields only, `labels` and `days` as lists or text. */
function repeatInput(body: Json): RepeatInput {
  const list = (v: unknown, name: string): string[] | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v === 'string')
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
    throw new HttpError(400, `${name}: use a list of text`);
  };
  const count = body.count;
  if (count !== undefined && count !== null && count !== '' && typeof count !== 'number') {
    throw new HttpError(400, 'count: use a number');
  }
  if (body.paused !== undefined && typeof body.paused !== 'boolean') {
    throw new HttpError(400, 'paused: use true or false');
  }
  return {
    name: need(body.name, 'name'),
    root: str(body.root),
    title: need(body.title, 'title'),
    body: str(body.body),
    type: str(body.type),
    priority: str(body.priority) as Priority | undefined,
    owner: str(body.owner),
    project: str(body.project),
    parent: str(body.parent),
    labels: list(body.labels, 'labels'),
    start: str(body.start),
    repeat: str(body.repeat),
    days: list(body.days, 'days'),
    until: str(body.until),
    count: typeof count === 'number' ? count : undefined,
    when: str(body.when),
    paused: body.paused as boolean | undefined,
  };
}

/** Accepts a full run id or a unique prefix or suffix of one. */
export function findRun(sup: Supervisor, ref: string): string {
  const r = ref.toUpperCase();
  const ids = sup.runs().map((x) => x.id);
  if (ids.includes(r)) return r;
  const hits = ids.filter((id) => id.startsWith(r) || id.endsWith(r));
  if (hits.length === 1) return hits[0]!;
  throw new HttpError(
    hits.length ? 400 : 404,
    hits.length ? `run '${ref}' is ambiguous` : `no run ${ref}`,
  );
}

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Json> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolveBody({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolveBody(v as Json);
      } catch {
        reject(new HttpError(400, 'body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, data: unknown): void {
  const text = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendText(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** The last `bytes` of a file, starting at a line break when it cuts the file. */
export function readTail(file: string, bytes: number): string {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return '';
  }
  const len = Math.max(0, Math.min(size, Number.isFinite(bytes) ? bytes : 65536));
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8');
    if (len === size) return text;
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    closeSync(fd);
  }
}

export function compact(v: TaskView): Json {
  return {
    id: v.meta.id,
    root: v.root,
    title: v.meta.title,
    type: v.meta.type,
    priority: v.meta.priority,
    project: v.meta.project,
    labels: v.meta.labels,
    createdBy: v.meta.created_by,
    createdAt: v.meta.created_at,
    status: v.status,
    stale: v.stale || undefined,
    unblocked: v.unblocked || undefined,
    mergeWait: v.mergeWait,
    archived: v.archived || undefined,
    owner: v.owner,
    claimedBy: v.claimedBy,
    leaseUntil: v.leaseUntil,
    reviewer: v.reviewer,
    waitingOn: v.waitingOn,
    blockedOn: v.blockedOn.length ? v.blockedOn : undefined,
    question: openQuestion(v),
    checkpoint: v.checkpoint,
    delegation: v.delegation ?? undefined,
    updatedAt: v.updatedAt,
  };
}

/** Channel heads and every vote's ballots and outcome; changes when a message or ballot lands. */
function collabSignature(ws: Workspace): string {
  const channels = ws
    .channels()
    .map((c) => `${c.name}:${c.last ?? ''}`)
    .join(',');
  const votes = ws
    .decisions({ all: true })
    .map((d) => `${d.root}/${d.meta.id}:${d.ballots.length}:${d.outcome?.choice ?? ''}`)
    .join(',');
  // A record is never edited, so the count of decision folders says when the log grew.
  const records = ws.roots.map((r) => `${r.name}:${listDecisionIds(r).length}`).join(',');
  return `${channels}#${votes}#${records}`;
}

/** A role file for the page: the body as `instructions`; the local file path stays here. */
function roleOut({ file: _file, body, ...rest }: AgentDef): Omit<AgentDef, 'file' | 'body'> & {
  instructions: string;
} {
  return { ...rest, instructions: body.trim() };
}

function taskSignature(views: TaskView[]): string {
  return views.map((v) => `${v.root}/${v.meta.id}:${v.lastEvent ?? ''}:${v.status}`).join('|');
}
