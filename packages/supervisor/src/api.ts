import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type {
  AgentDef,
  MarkInput,
  Priority,
  RepeatInput,
  RoleInput,
  RoleScope,
  TaskView,
  Workspace,
} from '@swarmup/core';
import {
  agentRuntimeValues,
  readAgentLayers,
  readWorkflows,
  checkDefinitionText,
  COMMAND_TIMEOUT_MS,
  loadDefinitions,
  parseCriteriaResults,
  parseDoneWhen,
  findAttachment,
  listDecisionIds,
  MAX_ATTACHMENT_BYTES,
  OpsError,
  openQuestion,
  readPresence,
  SWARM_FILE,
} from '@swarmup/core';
import {
  agentDirectory,
  applySettings,
  deleteSchedule,
  mirrorRoot,
  projectAction,
  projectsView,
  saveSchedule,
  schedulesView,
  settingsView,
  standup,
} from './admin.js';
import type { BenchHost, BenchRunRequest } from './bench-runs.js';
import { listBenchSets } from './bench-runs.js';
import { createSwarmFile, planDefsImport, writeSwarmFile } from './defs-import.js';
import { NoArtifact } from './artifact-api.js';
import { NoDiff } from './diff.js';
import { mapCheck, mapIndex, mapInit, mapNodeView, mapSearch, mapView } from './map-api.js';
import {
  deleteMcpServer,
  McpResolveError,
  mcpView,
  resolveMcp,
  saveMcpServer,
  setMcpSecret,
  setMcpStrict,
} from './mcp-api.js';
import { doctor, installUserSkills } from './doctor.js';
import { buildReportAsync, ReportEvents, reportWindow } from './report.js';
import { scorerCatalog, scorerSettings, summarizeScores } from './scores.js';
import { historyBucket } from './score-history.js';
import { buildWrapped } from './wrapped.js';
import type { SettingsPatch } from './admin.js';
import { pageRuns, RUN_FILTERS } from './runs.js';
import type { RunFilter, RunRecord } from './runs.js';
import { liveRunsEndMessage } from './supervisor.js';
import type { Supervisor } from './supervisor.js';
import { CommandRunner } from './merge.js';
import { briefDetail, CriteriaChecks } from './task-criteria.js';
import { CriteriaJudges, judgeMessage, judgeTask } from './judge.js';

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
  // The app's **Run checks**: `swarmup criteria check` in swarmupd, one run per task at a time.
  const criteriaChecks = new CriteriaChecks({
    runCommand: async (command, cwd) => {
      const runner = new CommandRunner(sup.commandEnv());
      const [r] = await runner.runAll([command], cwd, COMMAND_TIMEOUT_MS);
      return { ok: r?.ok ?? false, output: r?.output ?? '', why: r?.why };
    },
    record: (task, by, results, message) => {
      const done = sup.ws(by).recordCriteriaCheck(task, results, message);
      checkTasks();
      return done.events.at(-1)?.id ?? '';
    },
  });
  // The app's **Judge**: `swarmup criteria judge` in swarmupd, one run per task at a time.
  const criteriaJudges = new CriteriaJudges({
    judge: async (job, criteria, on) => {
      const ws = sup.ws(job.by);
      const { meta, body } = ws.showEvents(job.task);
      const root = ws.resolve(job.task).root;
      const base = sup.config.merge[root.name]?.base ?? 'main';
      const j = await judgeTask({
        criteria,
        cwd: job.cwd,
        base,
        storeDir: root.dir,
        task: `# ${meta.title}\n\n${body}`.trim(),
        config: sup.config.judge,
        env: sup.commandEnv(),
        runtimes: sup.config.runtimes,
        ...(sup.judgeRunner ? { runner: sup.judgeRunner } : {}),
        onStart: on.start,
        onResult: on.result,
      });
      return { ...j, message: judgeMessage(j, base, sup.config.judge) };
    },
    record: (task, by, results, message) => {
      const done = sup.ws(by).recordCriteriaCheck(task, results, message, 'judge');
      checkTasks();
      return done.events.at(-1)?.id ?? '';
    },
  });
  // Task events the reports read, kept so a report opened again reads only the tasks that changed.
  const reportEvents = new ReportEvents();
  const benchHost = (): BenchHost => sup.benchHost();
  const bench = sup.bench;
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
    // MCP servers on roles (W8). Settings is for the person; resolve is for runs alone, and is the
    // only answer that holds secret values.
    if (area === 'mcp') {
      if (method === 'POST' && id === 'resolve') {
        try {
          return send(res, 200, resolveMcp(sup, run, need(body.name, 'name')));
        } catch (err) {
          if (err instanceof McpResolveError) throw new HttpError(err.status, err.message);
          throw err;
        }
      }
      if (method === 'GET' && !id) {
        humanOnly('reading MCP settings');
        return send(res, 200, mcpView(sup));
      }
      if (method === 'POST') humanOnly('changing MCP servers');
      if (method === 'POST' && id === 'servers' && !action) {
        return send(res, 200, saveMcpServer(sup, body));
      }
      if (method === 'POST' && id === 'servers' && action && parts[4] === 'delete') {
        return send(res, 200, deleteMcpServer(sup, action));
      }
      if (method === 'POST' && id === 'secrets') return send(res, 200, setMcpSecret(sup, body));
      if (method === 'POST' && id === 'strict')
        return send(res, 200, setMcpStrict(sup, body.strict));
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
      const waits = sup.waits();
      return send(res, 200, {
        providers: sup.usageReport(),
        waits,
        // A provider that cannot run is one line, not one per task it holds (AO-0341).
        stalls: sup.stalls(waits),
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
    if (method === 'POST' && area === 'doctor' && id === 'skills') {
      humanOnly('installing user-level skills');
      const { env } = sup.context;
      return send(res, 200, installUserSkills({ env }));
    }
    // Projects in the user config, archived ones included (AO-0353). The folder goes in the body,
    // since it holds slashes: `{ root, archived }`, `{ root, label }`, `{ root, to }`, `{ root }`.
    if (area === 'projects') {
      if (method === 'GET' && !id) return send(res, 200, projectsView(sup));
      if (method === 'POST' && id && !action) {
        humanOnly(`changing the project list (${id})`);
        return send(res, 200, projectAction(sup, id, body));
      }
    }
    if (method === 'GET' && area === 'doctor' && !id) {
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

    // swarmupd's merge attempts from `state.db`: `?task=<root/id>` for one task, `?since=<ISO>`
    // for the counts per outcome, `?limit=` for the list (default 200).
    if (area === 'merges' && method === 'GET' && !id) {
      const since = q.get('since') || undefined;
      if (since !== undefined && Number.isNaN(Date.parse(since))) {
        throw new HttpError(400, 'since: use an ISO date and time');
      }
      const limit = wholeParam(q.get('limit'), 'limit', 1, 5000);
      return send(res, 200, {
        attempts: sup.mergeAttempts(q.get('task') || undefined, limit),
        counts: sup.mergeCounts(since),
      });
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
        // `since` starts the today counts; `start` and `end` limit the page to a date range.
        const time = (name: string): string | undefined => {
          const v = q.get(name) || undefined;
          if (v !== undefined && Number.isNaN(Date.parse(v))) {
            throw new HttpError(400, `${name}: use an ISO date and time`);
          }
          return v;
        };
        const since = time('since');
        const start = time('start');
        const end = time('end');
        if (start && end && !(Date.parse(start) < Date.parse(end))) {
          throw new HttpError(400, 'end: the range must end after it starts');
        }
        const page = pageRuns(sup.runs(), {
          limit,
          before: q.get('before')?.toUpperCase() || undefined,
          from: q.get('from')?.toUpperCase() || undefined,
          filter: filter as RunFilter,
          since,
          start,
          end,
          pick: q.get('pick') || undefined,
          // `resumed=1`: only runs that resumed a session; `model`: only runs of that model.
          resumed: q.get('resumed') === '1',
          model: q.get('model') || undefined,
        });
        // The orientation the score keeper read from each ended run's log, by run id: a lookup
        // in memory per run on the page, no log read.
        const orientation: Record<string, unknown> = {};
        for (const r of page.pick ? [...page.runs, page.pick] : page.runs) {
          if (r.status !== 'ended') continue;
          const o = sup.scores.orientation(r);
          if (o) orientation[r.id] = o;
        }
        return send(res, 200, { ...page, orientation });
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
          ...(str(body.variant) ? { variant: str(body.variant) } : {}),
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
        const root = requestedRoot(ws, body.root);
        const { meta, proposed, notes } = ws.addTask(
          {
            title: need(body.title, 'title'),
            body: str(body.body),
            owner: str(body.to) || undefined,
            type: str(body.type) || undefined,
            priority: (str(body.priority) || undefined) as Priority | undefined,
            project: str(body.project) || undefined,
            parent: str(body.parent) || undefined,
            // `done_when`: a list of criteria (text or typed), or text with one check per line.
            doneWhen: parseDoneWhen(body.done_when),
          },
          root,
        );
        const warnings = ws.reachWarnings([meta.owner]);
        // The root's name with the id: another root may hold a task with the same id.
        const task = {
          ...compact(ws.view(`${(root ?? ws.defaultRoot()).name}/${meta.id}`)),
          proposed,
          // Such as the note on work without a checkable criterion.
          ...(notes?.length ? { notes } : {}),
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
      // One file of the task's review at the reviewed commit, for the **Work** section (W8).
      if (method === 'GET' && action === 'artifact') {
        try {
          return send(
            res,
            200,
            await sup.taskArtifact(ref, need(q.get('path'), 'path'), q.get('commit') || undefined),
          );
        } catch (err) {
          if (err instanceof NoArtifact) throw new HttpError(404, err.message);
          throw err;
        }
      }
      // A person records that they published the work (W8); never a run.
      if (method === 'POST' && action === 'published') {
        humanOnly('recording a publish');
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const done = await sup.recordPublished(ref, ws.actor, {
          url: need(body.url, 'url'),
          artifact: str(body.artifact) || undefined,
          commit: str(body.commit) || undefined,
          message: str(body.message) || undefined,
        });
        const { view, ...rest } = done;
        return send(res, 200, { ...rest, task: compact(view) });
      }
      // A person publishes a publish task with its adapter (W8 phase 3); never a run. The GET
      // names the adapter, for the app's Publish button.
      if (action === 'publish') {
        if (method === 'GET') return send(res, 200, { adapter: sup.publishAdapterOf(ref) });
        if (method === 'POST') {
          humanOnly('publishing');
          if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
          const one = str(body.artifact);
          const paths: string[] | undefined = Array.isArray(body.artifacts)
            ? body.artifacts.filter((a: unknown): a is string => typeof a === 'string')
            : one
              ? [one]
              : undefined;
          const done = await sup.publishTask(ref, ws.actor, {
            ...(str(body.adapter) ? { adapter: str(body.adapter) } : {}),
            ...(body.again === true ? { again: true } : {}),
            ...(paths?.length ? { paths } : {}),
            ...(str(body.commit) ? { commit: str(body.commit) } : {}),
          });
          if (!done.ok) {
            // The attempt and a comment on what to do next are on the task.
            throw new HttpError(
              502,
              `adapter ${done.adapter} failed (${done.why ?? 'no reason'}); it will not run again for these files without again: if it went live, record the URL with Mark published`,
            );
          }
          const { view, ...rest } = done;
          return send(res, 200, { ...rest, task: compact(view) });
        }
      }
      // A milestone's plan as `swarmup plan show` reports it (AO-0110).
      if (method === 'GET' && action === 'plan') return send(res, 200, ws.planShow(ref));
      if (method === 'GET' && !action) {
        const { body: text, events } = ws.showEvents(ref);
        const v = ws.view(ref);
        // The goal brief and the children it covers, for the task panel's Brief section.
        const children = ws
          .list({ all: true })
          .filter((c) => c.root === v.root && c.meta.parent === v.meta.id)
          .map((c) => ({
            id: c.meta.id,
            title: c.meta.title,
            status: c.status,
            updatedAt: c.updatedAt,
          }));
        // The criteria and their latest results, for the task panel's "Done when".
        return send(res, 200, {
          task: compact(v),
          body: text,
          events,
          ...(v.criteria ? { criteria: v.criteria, criteriaResults: v.criteriaResults } : {}),
          ...briefDetail(v.meta.type, events, children),
        });
      }
      // **Run checks**: `swarmup criteria check ID` in the task's worktree, in the background.
      // The app reads the run's progress with a GET until it ends.
      if (action === 'criteria-check') {
        const v = ws.view(ref);
        const task = `${v.root}/${v.meta.id}`;
        if (method === 'GET') return send(res, 200, { job: criteriaChecks.get(task) });
        if (method === 'POST') {
          // It runs commands as swarmupd, outside a run's sandbox.
          humanOnly('running criteria checks');
          if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
          const cwd = await sup.criteriaDir(ref);
          if (!cwd)
            throw new HttpError(409, `the code of ${task} is in no git checkout on this PC`);
          try {
            const { job } = criteriaChecks.start(task, ws.actor, cwd, v.criteria ?? []);
            return send(res, 202, { job });
          } catch (err) {
            throw new HttpError(409, (err as Error).message);
          }
        }
      }
      // **Judge**: `swarmup criteria judge ID` against the task's worktree, in the background.
      if (action === 'criteria-judge') {
        const v = ws.view(ref);
        const task = `${v.root}/${v.meta.id}`;
        if (method === 'GET') return send(res, 200, { job: criteriaJudges.get(task) });
        if (method === 'POST') {
          // It spends tokens on the person's account.
          humanOnly('judging rubric criteria');
          if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
          const cwd = await sup.criteriaDir(ref);
          if (!cwd)
            throw new HttpError(409, `the code of ${task} is in no git checkout on this PC`);
          try {
            const { job } = criteriaJudges.start(task, ws.actor, cwd, v.criteria ?? []);
            return send(res, 202, { job });
          } catch (err) {
            throw new HttpError(409, (err as Error).message);
          }
        }
      }
      if (method === 'POST') {
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const msg = str(body.message) ?? '';
        // The app's Approve plan and Send back: the functions behind `swarmup plan approve` and
        // `swarmup plan reject`, so the rules live in one place (AO-0110).
        if (action === 'plan-approve' || action === 'plan-reject') {
          humanOnly(action === 'plan-approve' ? 'approving a plan' : 'sending a plan back');
          const done =
            action === 'plan-approve'
              ? ws.planApprove(ref, { source: planSource(body.plan), message: msg })
              : ws.planReject(ref, msg);
          return send(res, 200, {
            task: compact(done.view),
            events: done.events,
            warnings: done.warnings,
            created: done.created,
            applied: done.applied,
            skipped: done.skipped,
          });
        }
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
              // `criteria`: results by criterion id, as `--criteria-file` takes them.
              const criteria =
                body.criteria === undefined ? undefined : parseCriteriaResults(body.criteria);
              // `force`: approve with a criterion marked fail, as `--force` does.
              const by = body.force === true ? sup.ws(ws.actor, undefined, false, true) : ws;
              return by.verdict(ref, v, msg, mark, criteria);
            }
            // `swarmup criteria ID --set-file`: the whole new list (`done_when`), or with `add`
            // the entries to append, as a `criteria` event under the CLI's permission rules.
            case 'criteria': {
              const list = body.done_when;
              const entries = Array.isArray(list) ? list : list === undefined ? [] : [list];
              return ws.setCriteria(ref, entries, {
                add: body.add === true,
                message: msg || undefined,
              });
            }
            // `swarmup brief ID --body-file -`: a new goal brief, which wins over older ones.
            case 'brief':
              return ws.brief(ref, msg);
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
          // Soft checks, such as a verdict that leaves a judged criterion without a result.
          ...(result.notes?.length ? { notes: result.notes } : {}),
        });
      }
    }

    // Each milestone's progress on its plan, for the board's cards and its Milestone lanes.
    if (method === 'GET' && area === 'milestones') return send(res, 200, wsAs().planProgress());
    // Definitions as code (W5): each root's swarm.yaml and agent files, what they set in the
    // config, and the machine keys that won over them.
    if (area === 'defs') {
      // Proposals (W6): the variants with their diffs and benchmarks; a person promotes or
      // rejects one, with the functions behind `swarmup defs promote` and `reject`.
      if (id === 'variants') {
        if (method === 'GET' && !action) return send(res, 200, sup.improver.proposals());
        const verb = parts[4];
        if (method === 'POST' && action && (verb === 'promote' || verb === 'reject')) {
          humanOnly(
            verb === 'promote' ? 'promoting a definition change' : 'rejecting a definition change',
          );
          const ws = wsAs();
          if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
          const rootName = str(body.root) || undefined;
          const done =
            verb === 'promote'
              ? ws.defsPromote(action, {
                  root: rootName,
                  message: str(body.message) || undefined,
                  force: body.force === true,
                })
              : ws.defsReject(action, str(body.message) ?? '', { root: rootName });
          await sup.tick();
          return send(res, 200, done);
        }
      }
      const defs = await defsRoute(sup, method, id, body, humanOnly);
      if (defs !== undefined) return send(res, 200, defs);
    }
    // **Propose an improvement** on an agent's failing scorer: the improvement task, now (W6).
    if (method === 'POST' && area === 'improve' && !id) {
      humanOnly('filing an improvement task');
      const ws = wsAs();
      if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
      try {
        const meta = sup.improver.request(need(body.agent, 'agent'), ws.actor);
        return send(res, 201, meta);
      } catch (err) {
        if (err instanceof OpsError) throw err;
        throw new HttpError(409, (err as Error).message);
      }
    }
    // Benchmarks (W7): sets, runs under the state folder, and runs started from the app.
    if (area === 'bench') {
      const sub = parts[4];
      if (method === 'GET' && id === 'sets' && !action) {
        return send(res, 200, listBenchSets(benchHost()));
      }
      if (method === 'GET' && id === 'runs' && !action) return send(res, 200, bench.list());
      if (method === 'GET' && id === 'runs' && action && !sub) {
        return send(res, 200, bench.detail(action));
      }
      if (method === 'GET' && id === 'runs' && action && sub === 'attempt') {
        return sendText(
          res,
          bench.attemptFile(action, q.get('entry') ?? '', q.get('n') ?? '', q.get('file') ?? ''),
        );
      }
      if (method === 'POST') humanOnly('benchmarks');
      if (method === 'POST' && id === 'run' && !action) {
        const started = bench.start(benchRequest(body));
        return send(res, started.id ? 201 : 200, started);
      }
      if (method === 'POST' && id === 'runs' && action && sub === 'stop') {
        return send(res, 200, bench.stop(action));
      }
      if (method === 'POST' && id === 'compare' && !action) {
        return send(res, 200, bench.compare(need(body.a, 'a'), need(body.b, 'b')));
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
        return send(res, 200, {
          ...roleOut(def),
          root,
          ...(def.folder ? { layers: readAgentLayers(def) } : {}),
          settings: roleSettings(sup, def),
        });
      }
      if (method === 'POST' && !id) {
        humanOnly('editing role files');
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const role = (body.role ?? {}) as RoleInput;
        if (typeof role !== 'object' || Array.isArray(role))
          throw new HttpError(400, 'role: expected an object');
        const scope = str(body.scope);
        if (scope !== undefined && scope !== 'role' && scope !== 'runtime') {
          throw new HttpError(400, 'scope: use role or runtime');
        }
        const def = ws.saveRole(role, {
          root: str(body.root) || undefined,
          create: body.create === true,
          scope: scope as RoleScope | undefined,
        });
        return send(res, body.create === true ? 201 : 200, roleOut(def));
      }
    }
    // Workflows (W5): each root's list, one compiled with sample values, and a start.
    if (area === 'workflows') {
      const ws = wsAs();
      if (method === 'GET' && !id) {
        return send(
          res,
          200,
          ws.roots
            .filter((r) => !r.isMirror)
            .flatMap((r) =>
              readWorkflows(r.dir).map((w) => ({
                root: r.name,
                id: w.id,
                title: w.def?.title,
                description: w.def?.description,
                approval: w.def ? (w.def.approval ?? 'proposal') : undefined,
                params: w.def?.params ?? {},
                stages: w.def?.stages.length ?? 0,
                ok: w.def !== null,
                problems: w.problems.map((p) => `${p.path}: ${p.message}`),
              })),
            ),
        );
      }
      if (method === 'POST' && id === 'start') {
        humanOnly('starting a workflow');
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const raw = body.params ?? {};
        if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
          throw new HttpError(400, 'params: expected an object of names to values');
        }
        const params = Object.fromEntries(
          Object.entries(raw as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
            .map(([k, v]) => [k, String(v)]),
        );
        const out = ws.workflowStart(need(body.id, 'id'), {
          params,
          root: str(body.root) || undefined,
          title: str(body.title) || undefined,
          project: str(body.project) || undefined,
          message: str(body.message) || undefined,
        });
        return send(res, 201, {
          milestone: out.milestone,
          workflow: out.compiled.id,
          approved: Boolean(out.approved),
          created: out.approved?.created ?? [],
          warnings: [...(out.proposed.warnings ?? []), ...(out.approved?.warnings ?? [])],
        });
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
      // The task events are read without holding the event loop, so other calls go on meanwhile.
      const report = await buildReportAsync(wsAs(), sup.runs(), w.from, w.to, {
        project,
        root,
        events: reportEvents,
      });
      return send(res, 200, report);
    }
    if (area === 'scores') {
      // The scores swarmupd keeps in state.db (scores.ts): per agent, each scorer's mean, pass
      // rate and worst subjects; `agent=ID` for one agent, `task=root/ID` adds that task's
      // scores with evidence. Task and run scores count from `since` (ISO), agent scores over all
      // time. The report carries the scores of its own window. `POST /api/scores/refresh`
      // computes them all again.
      if (method === 'POST' && id === 'refresh') {
        return send(res, 200, { scores: await sup.refreshScores(true) });
      }
      let settings = {};
      try {
        settings = scorerSettings(sup.user);
      } catch {
        // The tick warns about it.
      }
      const time = (name: string): number | undefined => {
        const v = q.get(name) || '';
        if (v && Number.isNaN(Date.parse(v))) {
          throw new HttpError(400, `${name}: use an ISO date and time`);
        }
        return v ? Date.parse(v) : undefined;
      };
      if (method === 'GET' && !id) {
        const since = time('since');
        const sinceIso = since !== undefined ? new Date(since).toISOString() : '';
        const results = (await sup.refreshScores()).filter(
          (r) => r.level === 'agent' || r.at >= sinceIso,
        );
        const agent = q.get('agent') || undefined;
        const task = q.get('task') || undefined;
        // A task's own scores, and the run scores (orientation) of its runs.
        let mine: typeof results = [];
        if (task) {
          const slash = task.lastIndexOf('/');
          const [root, tid] =
            slash > 0 ? [task.slice(0, slash), task.slice(slash + 1)] : ['', task];
          const runs = new Set(
            sup
              .runs()
              .filter((r) => r.task === tid && (!root || !r.root || r.root === root))
              .map((r) => r.id),
          );
          mine = results.filter(
            (r) => r.subject === task || (r.level === 'run' && runs.has(r.subject)),
          );
        }
        return send(res, 200, {
          agents: summarizeScores(results, { settings }).filter((a) => !agent || a.agent === agent),
          scorers: scorerCatalog({ settings }),
          ...(task ? { results: mine } : {}),
        });
      }
      // Each agent's trend per scorer from `since` (default 30 days ago) to `until` (default
      // now): task and run scores by their subject's time, agent scores from their rows in
      // state.db. `tz` is the reader's `getTimezoneOffset()`, for local days.
      if (method === 'GET' && id === 'history') {
        const to = time('until') ?? Date.now();
        const from = time('since') ?? to - 30 * 86_400_000;
        if (!(from < to)) throw new HttpError(400, 'until: the window must end after it starts');
        const tz = Number(q.get('tz') || 0);
        if (!Number.isInteger(tz) || Math.abs(tz) > 840) {
          throw new HttpError(400, 'tz: use minutes from -840 to 840');
        }
        await sup.refreshScores();
        const bucket = historyBucket(from, to);
        return send(res, 200, {
          since: new Date(from).toISOString(),
          until: new Date(to).toISOString(),
          bucket,
          series: sup.scores.history(scorerCatalog({ settings }), {
            from,
            to,
            tz,
            bucket,
            ...(q.get('agent') ? { agent: q.get('agent')! } : {}),
            ...(q.get('scorer') ? { scorer: q.get('scorer')! } : {}),
          }),
        });
      }
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
      const report = await buildReportAsync(ws, sup.runs(), w.from, w.to, {
        project,
        root,
        events: reportEvents,
      });
      const named = { ...report, project: report.project ?? root ?? null };
      return send(res, 200, { ...timeline, wrapped: buildWrapped(named, timeline) });
    }
    if (method === 'GET' && area === 'activity') {
      // One page, newest first: `q` filters (words, `agent:`, `task:`, `kind:`; see
      // parseActivityQuery), `before` is the `next` of the page before. `days`, or `from` and
      // `to`, keep the items of that window, as for the report; without them, every item.
      const limit = Number(q.get('limit') ?? 100);
      const windowed = q.has('days') || q.has('from') || q.has('to');
      const w = windowed
        ? reportWindow(
            { days: q.get('days'), from: q.get('from'), to: q.get('to') },
            Date.now(),
            'activity',
          )
        : null;
      return send(
        res,
        200,
        wsAs().activityPage({
          q: (q.get('q') ?? '').slice(0, 500),
          before: q.get('before') || undefined,
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100,
          ...(w ? { since: w.from, until: w.to } : {}),
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
    // The project map of a root (`?root=` or `{ root }`, else the default root): in its code
    // checkout, else in its store's folder. The check and type detection run git off the loop.
    if (area === 'map' && !action) {
      const ws = wsAs();
      const root = requestedRoot(ws, method === 'GET' ? q.get('root') : body.root);
      const name = (root ?? ws.defaultRoot()).name;
      const top = await sup.mapTopOf(root ?? ws.defaultRoot());
      if (method === 'GET' && !id) return send(res, 200, await mapView(name, top));
      if (method === 'GET' && id === 'node') {
        const node = mapNodeView(top, need(q.get('id'), 'id'));
        if (!node) throw new HttpError(404, `no map node '${q.get('id')}'`);
        return send(res, 200, node);
      }
      if (method === 'GET' && id === 'search') {
        const file = q.get('file') || undefined;
        return send(res, 200, mapSearch(top, { q: (q.get('q') ?? '').slice(0, 500), file }));
      }
      // The check reads; the root's merge base is the default it compares with.
      if (method === 'POST' && id === 'check') {
        return send(res, 200, await mapCheck(top, str(body.base) || sup.config.merge[name]?.base));
      }
      if (method === 'POST' && (id === 'index' || id === 'init'))
        humanOnly('writing the project map');
      if (method === 'POST' && id === 'index') return send(res, 200, mapIndex(top));
      if (method === 'POST' && id === 'init') {
        return send(res, 201, await mapInit(top, str(body.type) || undefined));
      }
    }
    if (area === 'attachments') {
      if (method === 'POST' && !id) {
        const ws = wsAs();
        if (!ws.actor) throw new HttpError(400, "set 'as', or `me` in the user config");
        const data = need(body.data, 'data');
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HttpError(400, 'data: expected base64');
        const root = requestedRoot(ws, body.root);
        const a = ws.attach(Buffer.from(data, 'base64'), {
          task: str(body.task) || undefined,
          root,
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

/** The optional data root named by a request body, with the same error on every route. */
function requestedRoot(ws: Workspace, value: unknown) {
  const name = str(value)?.trim() || undefined;
  if (!name) return undefined;
  const root = ws.roots.find((r) => r.name === name);
  if (!root) {
    const names = ws.roots.map((r) => r.name).join(', ');
    throw new HttpError(400, `no root named '${name}': use one of ${names}`);
  }
  return root;
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

/**
 * The edited plan of a `plan-approve` call as the text of a plan file: `{ notes?, items }`, which
 * is YAML as it stands, so core parses and checks it as it does `--file`. Undefined without one:
 * the plan is approved as proposed.
 */
function planSource(plan: unknown): string | undefined {
  if (plan === undefined || plan === null) return undefined;
  if (typeof plan !== 'object' || Array.isArray(plan)) {
    throw new HttpError(400, 'plan: expected an object with `items`');
  }
  return JSON.stringify(plan);
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
    // A gate (W5): its question; a milestone from a workflow: the workflow's id.
    gate: v.meta.gate,
    workflow: v.meta.workflow,
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

/** One setting of a role, with where its value comes from, for the app's role editor (W5). */
interface RoleSetting {
  key: string;
  value: unknown;
  /** `machine`: this machine's user config; `swarm.yaml`: the store's; `role`: the role file. */
  from: 'machine' | 'swarm.yaml' | 'role';
  /** The value it overrides, when a machine value wins over a git one. */
  over?: unknown;
}

/**
 * The run settings of an agent and where each comes from (W5): model and effort, budget, and its
 * role's providers and limits. A machine value wins over `swarm.yaml` and the role file.
 */
function roleSettings(sup: Supervisor, def: AgentDef): RoleSetting[] {
  const at = def.id.indexOf(':');
  const runtime = def.id.slice(0, at);
  const role = def.id.slice(at + 1);
  const machine = sup.machineConfig;
  const out: RoleSetting[] = [];
  const own = machine.agents[def.id] ?? {};
  const file = agentRuntimeValues(def, runtime);
  for (const k of ['model', 'effort'] as const) {
    if (own[k])
      out.push({ key: k, value: own[k], from: 'machine', ...(file[k] ? { over: file[k] } : {}) });
    else if (file[k]) out.push({ key: k, value: file[k], from: 'role' });
  }
  if (own.budget) out.push({ key: 'budget', value: own.budget, from: 'machine' });
  for (const v of sup.defsView().values) {
    const mine = v.key.startsWith(`runtimes.${runtime}.`) || v.key.startsWith(`roles.${role}.`);
    if (!mine || v.source === 'unused') continue;
    // The agent's own model and effort, when it has them, win over its runtime's.
    if (v.key.startsWith('runtimes.') && out.some((o) => o.key === v.key.split('.').pop()))
      continue;
    out.push({
      key: v.key,
      value: v.value,
      from: v.source === 'machine' ? 'machine' : 'swarm.yaml',
      ...(v.source === 'machine' && JSON.stringify(v.git) !== JSON.stringify(v.value)
        ? { over: v.git }
        : {}),
    });
  }
  const local = machine.roles[role] ?? {};
  for (const [k, value] of Object.entries(local)) {
    if (value === undefined || out.some((o) => o.key === `roles.${role}.${k}`)) continue;
    out.push({ key: `roles.${role}.${k}`, value, from: 'machine' });
  }
  return out;
}

function taskSignature(views: TaskView[]): string {
  return views.map((v) => `${v.root}/${v.meta.id}:${v.lastEvent ?? ''}:${v.status}`).join('|');
}

/**
 * `GET /api/defs`, `POST /api/defs/validate` (a file's text, or a whole root with `root`),
 * `POST /api/defs/import` (a preview, then a write with `write: true` and the previewed text as
 * `expect`), `POST /api/defs/create` (the template, when the root has no swarm.yaml) and
 * `POST /api/defs/save` (edited text, with the text it started from as `expect`). Undefined for a
 * route it does not serve.
 */
async function defsRoute(
  sup: Supervisor,
  method: string,
  id: string | undefined,
  body: Json,
  humanOnly: (what: string) => void,
): Promise<unknown> {
  if (method === 'GET' && !id) return sup.defsView();
  if (method !== 'POST') return undefined;
  const storeOf = (): { name: string; dir: string } => {
    const name = str(body.root);
    const r = name ? sup.ws().roots.find((x) => x.name === name && !x.isMirror) : undefined;
    if (!r) throw new HttpError(400, name ? `no root named '${name}'` : 'root: name a root');
    return r;
  };
  // Checks a definition file's text while a person edits it, or a whole root; writes nothing.
  if (id === 'validate') {
    const text = body.text;
    if (typeof text !== 'string' && str(body.root)) {
      const r = storeOf();
      const machine = sup.machineConfig;
      const set = loadDefinitions(r.dir, {
        strict: body.strict === true,
        machineRuntimes: Object.keys(machine.runtimes),
        machineAgents: Object.keys(machine.agents),
        machineMcp: Object.keys(machine.mcp.servers),
      });
      return { ok: set.ok, present: set.present, hash: set.hash, problems: set.problems };
    }
    if (typeof text !== 'string') throw new HttpError(400, 'text: send the file text');
    const kind = body.kind === 'agent' || body.kind === 'swarm' ? body.kind : undefined;
    const problems = checkDefinitionText(str(body.file) || 'swarm.yaml', text, {
      strict: body.strict === true,
      kind,
    });
    return { ok: !problems.some((p) => p.severity === 'error'), problems };
  }
  if (id === 'import') {
    const r = storeOf();
    const plan = planDefsImport(r.dir, sup.userConfig);
    if (body.write !== true) return plan;
    humanOnly('writing swarm.yaml');
    if (plan.empty) throw new HttpError(400, 'the user config sets nothing to import');
    // The file must still be what the preview read, and the result what it showed.
    if (body.expect !== plan.after) {
      throw new OpsError('swarm.yaml or your settings changed since the preview; preview again', 1);
    }
    writeSwarmFile(plan.file, plan.after, plan.before);
    await sup.tick();
    return { ...plan, written: true };
  }
  if (id === 'create') {
    humanOnly('creating swarm.yaml');
    const file = createSwarmFile(storeOf().dir);
    await sup.tick();
    return { file };
  }
  if (id === 'save') {
    humanOnly('saving swarm.yaml');
    const r = storeOf();
    const text = body.text;
    if (typeof text !== 'string') throw new HttpError(400, 'text: send the file text');
    writeSwarmFile(join(r.dir, SWARM_FILE), text, str(body.expect) ?? '');
    await sup.tick();
    return { file: join(r.dir, SWARM_FILE) };
  }
  return undefined;
}

/** A `POST /api/bench/run` body, checked for shape; the runner checks the rest. */
function benchRequest(body: Json): BenchRunRequest {
  const text = (k: string): string | undefined => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new HttpError(400, `${k}: expected text`);
    return v;
  };
  const number = (k: string, whole: boolean): number | undefined => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || (whole && !Number.isInteger(n))) {
      throw new HttpError(400, `${k}: expected a ${whole ? 'whole ' : ''}number above 0`);
    }
    return n;
  };
  const raw = body.entries;
  const entries =
    raw === undefined || raw === null
      ? undefined
      : (Array.isArray(raw) ? raw : String(raw).split(','))
          .map((e) => String(e).trim())
          .filter(Boolean);
  const mode = text('mode') ?? 'agent';
  if (mode !== 'agent' && mode !== 'reference' && mode !== 'none') {
    throw new HttpError(400, 'mode: agent, reference or none');
  }
  const out: BenchRunRequest = {
    set: text('set') ?? '',
    repo: text('repo') ?? '',
    mode,
    dry_run: body.dry_run === true,
  };
  if (entries?.length) out.entries = entries;
  for (const k of [
    'agent',
    'model',
    'effort',
    'hidden_dir',
    'reference_dir',
    'variant',
    'root',
  ] as const) {
    const v = text(k);
    if (v !== undefined) out[k] = v;
  }
  if (body.role_file === true) out.role_file = true;
  const repeat = number('repeat', true);
  if (repeat !== undefined) out.repeat = repeat;
  const budget = number('budget_min', false);
  if (budget !== undefined) out.budget_min = budget;
  return out;
}
