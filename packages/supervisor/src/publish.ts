// Publish adapters (W8 phase 3): the machine-side step that publishes a `publish` task's approved
// files once a person starts it. `swarmupd.publish.<root>.<name>` defines each adapter (`manual`,
// `command` or `mcp`); a publish task names one with the label `publish:<name>`. The attempt is
// recorded before the adapter runs, so it runs once per (task, files and blobs); on success the
// URL it reports becomes the task's `publish` event, as `swarmup published` writes it.
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type {
  ApprovedFile,
  CriteriaResults,
  GitRun,
  OpsEvent,
  McpConfig,
  McpEnvValue,
  PublishEdits,
  PublishTarget,
  ReviewArtifact,
  TaskView,
  Workspace,
} from '@swarmup/core';
import {
  approvedFiles,
  artifactKindOf,
  blobAt,
  commitOf,
  escapeHtml,
  imageRefs,
  imageType,
  isHuman,
  markdownToHtml,
  MCP_NAME_RE,
  mcpArgsHash,
  mcpToolAllowed,
  OpsError,
  previewPage,
  publishEdits,
  PUBLISH_TYPE,
  publishTarget,
  readSecrets,
  redactSecrets,
  resolveMcpEnv,
  secretKind,
  workspacePath,
} from '@swarmup/core';
import { stopTree } from './git.js';
import { quoteBatch, resolveCommand } from './proc.js';

export const PUBLISH_KINDS = ['manual', 'command', 'mcp'] as const;
export type PublishKind = (typeof PUBLISH_KINDS)[number];

/** One adapter in `swarmupd.publish.<root>.<name>`. */
export interface PublishAdapterConfig {
  kind: PublishKind;
  /** command: the command line, run in a shell in the root's workspace checkout. */
  run?: string;
  /** command: extra environment, text or `{secret: NAME}` from `secrets.yml`. */
  env?: Record<string, McpEnvValue>;
  /** mcp: a `publish: true` server of `swarmupd.mcp.servers`. */
  server?: string;
  /** mcp: the tool to call. */
  tool?: string;
  /** mcp: the tool's arguments; text may hold `{task}`, `{root}`, `{commit}`, `{path}`, `{content}`. */
  arguments?: Record<string, unknown>;
  /** command, mcp: minutes the adapter may take; default 10. */
  timeout_minutes?: number;
}

/** `swarmupd.publish`: adapters by root name, then by adapter name. */
export type PublishConfig = Record<string, Record<string, PublishAdapterConfig>>;

/** The label that names a publish task's adapter: `publish:<name>`. */
export const PUBLISH_LABEL = 'publish:';
/** Minutes an adapter may take when `timeout_minutes` is unset. */
export const PUBLISH_TIMEOUT_MINUTES = 10;

const ADAPTER_KEYS = ['kind', 'run', 'env', 'server', 'tool', 'arguments', 'timeout_minutes'];
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

function fail(message: string): never {
  throw new OpsError(message, 2);
}

function checkAdapter(raw: unknown, where: string): PublishAdapterConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where}: use ${ADAPTER_KEYS.join(', ')}`);
  }
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !ADAPTER_KEYS.includes(k));
  if (extra) fail(`${where}: unknown key ${extra}; use ${ADAPTER_KEYS.join(', ')}`);
  if (!(PUBLISH_KINDS as readonly unknown[]).includes(r.kind)) {
    fail(`${where}.kind: use ${PUBLISH_KINDS.join(', ')}`);
  }
  const out: PublishAdapterConfig = { kind: r.kind as PublishKind };
  const text = (k: string): string => {
    const v = r[k];
    if (typeof v !== 'string' || v.trim() === '')
      fail(`${where}.${k}: a ${out.kind} adapter needs it`);
    return v.trim();
  };
  if (out.kind === 'command') out.run = text('run');
  if (out.kind === 'mcp') {
    out.server = text('server');
    if (!MCP_NAME_RE.test(out.server)) fail(`${where}.server: not a server name`);
    out.tool = text('tool');
    if (r.arguments !== undefined && r.arguments !== null) {
      if (typeof r.arguments !== 'object' || Array.isArray(r.arguments)) {
        fail(`${where}.arguments: map argument names to values`);
      }
      out.arguments = r.arguments as Record<string, unknown>;
    }
  }
  if (r.env !== undefined && r.env !== null) {
    if (out.kind !== 'command') fail(`${where}.env: only a command adapter takes env`);
    if (typeof r.env !== 'object' || Array.isArray(r.env)) {
      fail(`${where}.env: map variable names to text or {secret: NAME}`);
    }
    const env: Record<string, McpEnvValue> = {};
    for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
      if (!ENV_NAME_RE.test(k)) fail(`${where}.env.${k}: not a variable name`);
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        env[k] = String(v);
      else if (
        v &&
        typeof v === 'object' &&
        Object.keys(v).length === 1 &&
        typeof (v as { secret?: unknown }).secret === 'string' &&
        ENV_NAME_RE.test((v as { secret: string }).secret)
      ) {
        env[k] = { secret: (v as { secret: string }).secret };
      } else fail(`${where}.env.${k}: use text or {secret: NAME}`);
    }
    out.env = env;
  }
  if (r.timeout_minutes !== undefined && r.timeout_minutes !== null) {
    const t = r.timeout_minutes;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > 24 * 60) {
      fail(`${where}.timeout_minutes: use minutes from more than 0 to 1440`);
    }
    out.timeout_minutes = t;
  }
  return out;
}

/** `swarmupd.publish`, checked; none gives no adapters. Refuses a bad entry with exit 2. */
export function checkPublishConfig(raw: unknown): PublishConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('swarmupd.publish: map root names to their adapters');
  }
  const out: PublishConfig = {};
  for (const [root, adapters] of Object.entries(raw as Record<string, unknown>)) {
    if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) {
      fail(`swarmupd.publish.${root}: map adapter names to their settings`);
    }
    out[root] = {};
    for (const [name, a] of Object.entries(adapters as Record<string, unknown>)) {
      if (!MCP_NAME_RE.test(name)) {
        fail(`swarmupd.publish.${root}.${name}: use lowercase letters, digits, - and _`);
      }
      out[root][name] = checkAdapter(a, `swarmupd.publish.${root}.${name}`);
    }
  }
  return out;
}

/** The largest file handed to an adapter. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Reads a blob's bytes with `git cat-file blob` in `top`: bytes, so an image passes unchanged. */
export function blobData(top: string, env: NodeJS.ProcessEnv): (blob: string) => Promise<Buffer> {
  return (blob) =>
    new Promise((done, reject) => {
      execFile(
        'git',
        ['cat-file', 'blob', blob],
        {
          cwd: top,
          env,
          windowsHide: true,
          encoding: 'buffer',
          maxBuffer: MAX_FILE_BYTES,
          timeout: 60_000,
        },
        (err, stdout) => (err ? reject(err) : done(stdout)),
      );
    });
}

/** The adapter a task's labels name (`publish:<name>`), if any. */
export function taskAdapter(labels: readonly string[] | undefined): string | undefined {
  const l = (labels ?? []).find((x) => x.startsWith(PUBLISH_LABEL));
  return l ? l.slice(PUBLISH_LABEL.length).trim() || undefined : undefined;
}

/**
 * The URL an adapter reports: the last line of its output of the form `url: <http(s) URL>`.
 * Null when it printed none.
 */
export function urlFromOutput(output: string): string | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n').reverse();
  for (const line of lines) {
    const m = /^\s*url:\s*(https?:\/\/\S+)\s*$/i.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/** What an adapter run reports. */
export interface AdapterOutcome {
  ok: boolean;
  /** The URL it published at, from its output. */
  url?: string;
  /** The end of what it printed. */
  output: string;
  /** Why it failed. */
  why?: string;
}

/** A file handed to an adapter: its workspace path, its blob, and its bytes. */
export interface PublishFile {
  path: string;
  blob: string;
  data: Buffer;
}

/** What an adapter runs with. */
export interface AdapterInput {
  root: string;
  task: string;
  commit: string;
  /** The root's workspace checkout: a command adapter's working folder. */
  top: string;
  files: PublishFile[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** command: the files already written to a temporary folder, which the caller removes. */
  staged?: StagedFiles;
}

const OUTPUT_KEEP = 64 * 1024;

function tailOf(text: string, n = 2000): string {
  const t = text.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** The environment a publish child gets: swarmupd's, without any run's identity or token. */
function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const k of Object.keys(env)) {
    if (/^(SWARMUP|OPS)_(RUN_TOKEN|RUN|PARENT_RUN|AGENT)$/i.test(k)) delete env[k];
  }
  return env;
}

/** The approved files written to a new temporary folder, for a `command` adapter. */
export interface StagedFiles {
  dir: string;
  /** Each file in `dir`, in the order of the input. */
  paths: string[];
}

/**
 * Writes `files` to a new temporary folder. A failure removes what it wrote and throws, so the
 * caller can stage before it records an attempt.
 */
export function stageFiles(files: readonly PublishFile[]): StagedFiles {
  const dir = mkdtempSync(join(tmpdir(), 'swarmup-publish-'));
  try {
    const paths = files.map((f) => {
      const p = join(dir, ...f.path.split('/'));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, f.data);
      return p;
    });
    return { dir, paths };
  } catch (err) {
    removeStaged(dir);
    throw err;
  }
}

/** Removes a staged folder; a file still held open (Windows) is left to the OS's temp cleanup. */
export function removeStaged(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Left behind: never a reason to fail a publish.
  }
}

/** How long a command adapter's output may stay open after its shell exits. */
const EXIT_GRACE_MS = 500;

/**
 * Runs a `command` adapter: the approved files are in a temporary folder (`input.staged`, else
 * staged here and removed after), and the command runs in a shell in the workspace with
 * `SWARMUP_PUBLISH_TASK`, `SWARMUP_PUBLISH_ROOT`, `SWARMUP_PUBLISH_COMMIT`, `SWARMUP_PUBLISH_DIR`
 * (that folder), `SWARMUP_PUBLISH_FILES` (the files in it, one per line), `SWARMUP_PUBLISH_FILE`
 * (the first), `SWARMUP_PUBLISH_PATHS` (their workspace paths, one per line) and
 * `SWARMUP_PUBLISH_WORKSPACE`, plus the adapter's `env`. It must exit 0 and print `url: <URL>` as
 * its last such line. On a timeout the whole process tree is stopped (`taskkill /T` on Windows,
 * the process group elsewhere). The call settles when the shell exits, after a short grace for
 * its output, even when a process it started keeps that output open.
 */
export function runCommandAdapter(
  adapter: PublishAdapterConfig,
  input: AdapterInput,
  secrets: Record<string, string>,
): Promise<AdapterOutcome> {
  const own = input.staged === undefined;
  let staged: StagedFiles;
  try {
    staged = input.staged ?? stageFiles(input.files);
  } catch (err) {
    return Promise.resolve({ ok: false, output: '', why: (err as Error).message });
  }
  const vars = resolveMcpEnv(
    { command: '', ...(adapter.env ? { env: adapter.env } : {}) },
    secrets,
  );
  const env = childEnv(input.env, {
    ...vars.env,
    SWARMUP_PUBLISH_TASK: input.task,
    SWARMUP_PUBLISH_ROOT: input.root,
    SWARMUP_PUBLISH_COMMIT: input.commit,
    SWARMUP_PUBLISH_DIR: staged.dir,
    SWARMUP_PUBLISH_FILES: staged.paths.join('\n'),
    SWARMUP_PUBLISH_FILE: staged.paths[0] ?? '',
    SWARMUP_PUBLISH_PATHS: input.files.map((f) => f.path).join('\n'),
    SWARMUP_PUBLISH_WORKSPACE: input.top,
  });
  return new Promise<AdapterOutcome>((done) => {
    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    let grace: NodeJS.Timeout | undefined;
    const child = spawn(adapter.run ?? '', {
      cwd: input.top,
      env,
      shell: true,
      windowsHide: true,
      // Off Windows the shell leads its own process group, so a timeout reaches what it started.
      detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      const kill = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Gone.
        }
      };
      if (pid) void stopTree(pid).finally(kill);
      else kill();
    }, input.timeoutMs);
    child.stdout?.on('data', (c: Buffer) => {
      out = (out + c.toString('utf8')).slice(-OUTPUT_KEEP);
    });
    child.stderr?.on('data', (c: Buffer) => {
      err = (err + c.toString('utf8')).slice(-OUTPUT_KEEP);
    });
    const end = (o: AdapterOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (own) removeStaged(staged.dir);
      done(o);
    };
    const finish = (code: number | null): void => {
      const output = tailOf([out, err].filter((s) => s.trim()).join('\n'));
      if (timedOut) return end({ ok: false, output, why: 'timed out' });
      if (code !== 0) return end({ ok: false, output, why: `exit ${code ?? 'killed'}` });
      const url = urlFromOutput(out);
      end(
        url
          ? { ok: true, url, output }
          : { ok: false, output, why: 'it printed no `url: <URL>` line' },
      );
    };
    child.on('error', (e) => end({ ok: false, output: tailOf(err), why: e.message }));
    child.on('exit', (code) => {
      grace ??= setTimeout(() => finish(code), EXIT_GRACE_MS);
    });
    child.on('close', (code) => finish(code));
  });
}

/** An `mcp` adapter's arguments with `{task}`, `{root}`, `{commit}`, `{path}` and `{content}` filled. */
export function mcpArguments(
  args: Record<string, unknown> | undefined,
  fill: Record<string, string>,
): Record<string, unknown> {
  const sub = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\{(task|root|commit|path|content)\}/g, (m, k: string) => fill[k] ?? m);
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    }
    return v;
  };
  return (sub(args ?? {}) as Record<string, unknown>) ?? {};
}

/** True when an `mcp` adapter's arguments name one file: `{path}` or `{content}`. */
function namesOneFile(args: Record<string, unknown> | undefined): boolean {
  return /\{(path|content)\}/.test(JSON.stringify(args ?? {}));
}

/** What a tool call answered: its text, its structured content, and whether it is an error. */
export interface ToolAnswer {
  text: string;
  structured?: Record<string, unknown>;
  isError: boolean;
}

/** Starts an MCP server: a `.cmd` or `.bat` (such as `npx` on Windows) through `cmd.exe`. */
function startServer(command: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const file = resolveCommand(command, env) ?? command;
  const opts: SpawnOptions = { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = `"${[file, ...args].map(quoteBatch).join(' ')}"`;
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', line], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, args, opts);
}

/** A tool call that failed, with what the server wrote to stderr kept apart from the message. */
export class McpCallError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/**
 * Calls one tool of an MCP server over stdio, as a client: `initialize`, `initialized`, then
 * `tools/call`. The server runs with `env` (its secrets) and is stopped after the answer.
 */
export function callMcpTool(o: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  tool: string;
  arguments: Record<string, unknown>;
  timeoutMs: number;
}): Promise<ToolAnswer> {
  return new Promise<ToolAnswer>((resolveCall, rejectCall) => {
    const child = startServer(o.command, o.args, o.env);
    let err = '';
    let buf = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => rejectCall(new Error('timed out'))), o.timeoutMs);
    const send = (msg: Record<string, unknown>): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
    };
    const onMessage = (msg: Record<string, unknown>): void => {
      if (msg.id === 1) {
        if (msg.error) {
          return finish(() => rejectCall(new Error(`initialize: ${errorText(msg.error)}`)));
        }
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/call', params: { name: o.tool, arguments: o.arguments } });
        return;
      }
      if (msg.id !== 2) return;
      if (msg.error) return finish(() => rejectCall(new Error(errorText(msg.error))));
      const r = (msg.result ?? {}) as {
        content?: Array<{ type?: string; text?: string }>;
        structuredContent?: unknown;
        isError?: boolean;
      };
      const text = (r.content ?? [])
        .filter((c) => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join('\n');
      const structured =
        r.structuredContent && typeof r.structuredContent === 'object'
          ? (r.structuredContent as Record<string, unknown>)
          : undefined;
      finish(() =>
        resolveCall({ text, ...(structured ? { structured } : {}), isError: r.isError === true }),
      );
    };
    child.on('error', (e) => finish(() => rejectCall(e)));
    // The server's stderr stays with the caller's answer (`McpCallError.stderr`): it may hold
    // anything the server logs, so it never goes into a task event.
    child.on('exit', (code) =>
      finish(() =>
        rejectCall(new McpCallError(`the server exited (${code ?? 'killed'})`, tailOf(err, 2000))),
      ),
    );
    child.stdin?.on('error', () => {});
    child.stderr?.on('data', (c: Buffer) => {
      err = (err + c.toString('utf8')).slice(-OUTPUT_KEEP);
    });
    child.stdout?.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      let at: number;
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (!line) continue;
        try {
          const m = JSON.parse(line) as unknown;
          if (m && typeof m === 'object' && !Array.isArray(m))
            onMessage(m as Record<string, unknown>);
        } catch {
          // Not a JSON-RPC line: some servers log to stdout.
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'swarmup-publish', version: '1' },
      },
    });
  });
}

function errorText(e: unknown): string {
  const m = (e as { message?: unknown })?.message;
  return typeof m === 'string' ? m : JSON.stringify(e);
}

/**
 * The URL a tool answer reports: `structuredContent.url`, else the last `url: <URL>` line of its
 * text.
 */
export function urlFromTool(answer: ToolAnswer): string | null {
  const u = answer.structured?.url;
  if (typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim())) return u.trim();
  return urlFromOutput(answer.text);
}

/**
 * The log of the tool calls `mcp` publish adapters make, in swarmupd's state folder: one JSON line
 * per call, in the shape of a run's `mcp.log` with the task, adapter, attempt and outcome. Never
 * the arguments (only their SHA-256) and never a secret.
 */
export const PUBLISH_MCP_LOG = 'publish-mcp.log';

/** One line of {@link PUBLISH_MCP_LOG}. */
export interface PublishMcpLogEntry {
  at: string;
  server: string;
  tool: string;
  args_sha256: string;
  /** `root/ID`. */
  task: string;
  adapter: string;
  attempt: string;
  ok: boolean;
  /** Why the call failed: the first line, with anything that looks like a secret redacted. */
  error?: string;
}

/** Appends one entry to {@link PUBLISH_MCP_LOG} in `dir`; the log never stops a publish. */
function logPublishCall(dir: string, entry: PublishMcpLogEntry): void {
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, PUBLISH_MCP_LOG), `${JSON.stringify(entry)}\n`);
  } catch {
    // A log that cannot be written leaves the publish as it is.
  }
}

/** Injectable runners, for tests. */
export interface PublishRunners {
  command?: typeof runCommandAdapter;
  mcp?: typeof callMcpTool;
}

/** What `swarmup publish` and `POST /api/tasks/:id/publish` report. */
export interface PublishOutcome {
  adapter: string;
  commit: string;
  files: string[];
  /** The `publish-attempt` event. */
  attempt: string;
  ok: boolean;
  url?: string;
  why?: string;
  output: string;
  target?: PublishTarget;
  results?: CriteriaResults;
  /**
   * After a publish that went live: the steps of recording it that failed. The work is published
   * all the same; never run the adapter again for them.
   */
  problems?: string[];
  /** The task after it; missing only when reading it failed after a publish. */
  view?: TaskView;
}

/** Options of one publish. */
export interface PublishOptions {
  /** The adapter; default the task's `publish:<name>` label. */
  adapter?: string;
  /** Publish again: for files an earlier attempt had, or on a closed task. */
  again?: boolean;
  /** The files, from the top of the workspace; default the approved files. */
  paths?: string[];
  /** The commit; default the root's merge base, else HEAD. */
  commit?: string;
}

/**
 * The tasks whose approved work a publish task publishes: itself, then each task it waits on
 * (`blocked_by`), with their events.
 */
export function publishSources(
  ws: Workspace,
  ref: string,
): Array<{ id: string; events: ReturnType<Workspace['showEvents']>['events'] }> {
  const v = ws.view(ref);
  const ids = [v.meta.id, ...(v.meta.blocked_by ?? [])];
  const out: Array<{ id: string; events: ReturnType<Workspace['showEvents']>['events'] }> = [];
  for (const id of ids) {
    const r = id.includes('/') ? id : `${v.root}/${id}`;
    try {
      out.push({ id, events: ws.showEvents(r).events });
    } catch {
      // A task that is gone adds no files.
    }
  }
  return out;
}

/**
 * What the person changed between approval and a publish of `target` (W8 phase 3): the edits of
 * the task's approved files, all of them, or only `target.path` when the publish names one.
 */
export async function editsOfPublish(
  ws: Workspace,
  ref: string,
  git: GitRun,
  target: { commit: string; path?: string },
): Promise<PublishEdits | undefined> {
  const approved = taskApprovedFiles(ws, ref);
  const paths = target.path ? [target.path] : approved.map((f) => f.path);
  return publishEdits(git, approved, target.commit, paths);
}

/** The approved files of a publish task (see {@link approvedFiles}). */
export function taskApprovedFiles(ws: Workspace, ref: string): ApprovedFile[] {
  return approvedFiles(publishSources(ws, ref));
}

/**
 * The files a publish of the task hands over, and the commit they are read at: `opts.paths`,
 * else the approved files ({@link taskApprovedFiles}), at `opts.commit`, else `base`, else HEAD.
 * Refuses a task with no files, or a file the commit lacks, with exit 2.
 */
export async function publishFiles(o: {
  ws: Workspace;
  ref: string;
  top: string;
  git: GitRun;
  env: NodeJS.ProcessEnv;
  base?: string;
  readBlob?: (blob: string) => Promise<Buffer>;
  opts?: Pick<PublishOptions, 'paths' | 'commit'>;
}): Promise<{ commit: string; files: PublishFile[] }> {
  const opts = o.opts ?? {};
  const rev = opts.commit ?? o.base ?? 'HEAD';
  const commit = await commitOf(o.git, rev);
  if (!commit) throw new OpsError(`the workspace has no commit ${rev}`, 2);
  const paths = opts.paths?.length
    ? [...new Set(opts.paths.map(workspacePath))]
    : [...new Set(taskApprovedFiles(o.ws, o.ref).map((f) => f.path))];
  if (paths.length === 0) {
    throw new OpsError(
      `${o.ws.resolve(o.ref).id} has no approved files: its review and the reviews of the tasks it waits on name none; pass --artifact PATH`,
      2,
    );
  }
  const read = o.readBlob ?? blobData(o.top, o.env);
  const files: PublishFile[] = [];
  for (const path of paths) {
    const blob = await blobAt(o.git, commit, path);
    if (!blob) throw new OpsError(`${path} is not in ${commit.slice(0, 10)}`, 2);
    files.push({ path, blob, data: await read(blob) });
  }
  return { commit, files };
}

/** The largest image a preview embeds. */
export const PREVIEW_IMAGE_MAX = 5 * 1024 * 1024;

/** One file of a preview. */
export interface PreviewFile {
  path: string;
  blob: string;
  kind: 'markdown' | 'image' | 'text';
  /** Safe HTML: rendered Markdown, an embedded image, or the text escaped. */
  html: string;
  /** markdown, text: the file, for a client that renders it itself. */
  text?: string;
  /** image: a `data:` URL, when it is small enough to embed. */
  data?: string;
}

/** What `swarmup preview` and `GET /api/tasks/:id/preview` give. */
export interface TaskPreview {
  task: string;
  commit: string;
  files: PreviewFile[];
  /** The whole preview as one HTML page that runs no script. */
  page: string;
}

/**
 * A preview of what a publish of the task would hand over (W8 phase 3): each file at the commit,
 * Markdown rendered by `markdownToHtml` with the images it names from the workspace embedded as
 * `data:` URLs, an image embedded, any other file as text. Writes nothing.
 */
export async function taskPreview(o: {
  ws: Workspace;
  ref: string;
  top: string;
  git: GitRun;
  env: NodeJS.ProcessEnv;
  base?: string;
  readBlob?: (blob: string) => Promise<Buffer>;
  opts?: Pick<PublishOptions, 'paths' | 'commit'>;
}): Promise<TaskPreview> {
  const read = o.readBlob ?? blobData(o.top, o.env);
  const { commit, files } = await publishFiles({ ...o, readBlob: read });
  const { root, id } = o.ws.resolve(o.ref);
  const imageData = async (path: string): Promise<string | null> => {
    if (artifactKindOf(path) !== 'image') return null;
    const blob = await blobAt(o.git, commit, path);
    if (!blob) return null;
    const data = await read(blob);
    if (data.length > PREVIEW_IMAGE_MAX) return null;
    return `data:${imageType(path)};base64,${data.toString('base64')}`;
  };
  const out: PreviewFile[] = [];
  for (const f of files) {
    if (artifactKindOf(f.path) === 'image') {
      const src = await imageData(f.path);
      out.push({
        path: f.path,
        blob: f.blob,
        kind: 'image',
        ...(src ? { data: src } : {}),
        html: src
          ? `<img src="${src}" alt="${escapeHtml(f.path)}">`
          : `<p class="image-missing">[image over ${PREVIEW_IMAGE_MAX / 1024 / 1024} MB]</p>`,
      });
      continue;
    }
    const text = f.data.toString('utf8');
    if (!/\.(md|markdown|mdx)$/i.test(f.path)) {
      out.push({
        path: f.path,
        blob: f.blob,
        kind: 'text',
        text,
        html: `<pre>${escapeHtml(text)}</pre>`,
      });
      continue;
    }
    // The images the Markdown names, by their source as escaped text, from the workspace.
    const images = new Map<string, string | null>();
    for (const im of imageRefs(text)) {
      const key = escapeHtml(im.src);
      if (images.has(key) || !im.src || /^[a-z][a-z0-9+.-]*:/i.test(im.src)) continue;
      let at: string | null = null;
      try {
        at = workspacePath(
          posix.join(posix.dirname(f.path), decodeURI(im.src.replace(/[?#].*$/, ''))),
        );
      } catch {
        at = null;
      }
      images.set(key, at ? await imageData(at) : null);
    }
    const html = markdownToHtml(text, {
      // A remote image is never fetched, and one the workspace lacks shows its alt text.
      image: (src) => images.get(src) ?? null,
    });
    out.push({ path: f.path, blob: f.blob, kind: 'markdown', text, html });
  }
  const page = previewPage(
    `Preview of ${id}`,
    `${root.name}/${id} at ${commit.slice(0, 10)}: what a publish would hand over. Remote images are not loaded.`,
    out.map((f) => ({ path: f.path, html: f.html })),
  );
  return { task: `${root.name}/${id}`, commit, files: out, page };
}

/**
 * Publishes a `publish` task with its adapter (W8 phase 3), for a person outside any run:
 * checks the adapter and the files, records the `publish-attempt` (refused for files an earlier
 * attempt had, unless `again`), runs the adapter, and on success tags the commit, writes the
 * `publish` event with the URL it printed and runs the post-publish criteria. A failure leaves
 * the attempt and a comment that says what to do.
 */
export async function publishWithAdapter(o: {
  ws: Workspace;
  ref: string;
  publish: PublishConfig;
  mcp: McpConfig;
  /** The root's workspace checkout. */
  top: string;
  git: GitRun;
  env: NodeJS.ProcessEnv;
  /** The root's merge base, the default commit. */
  base?: string;
  /** A blob's bytes; default `git cat-file blob` in `top`. */
  readBlob?: (blob: string) => Promise<Buffer>;
  opts?: PublishOptions;
  runners?: PublishRunners;
  /** swarmupd's state folder, where {@link PUBLISH_MCP_LOG} goes; nothing is logged without it. */
  stateDir?: string;
}): Promise<PublishOutcome> {
  const { ws } = o;
  const opts = o.opts ?? {};
  const actor = ws.requireActor();
  if (!isHuman(actor) || ws.run) {
    throw new OpsError('only a person publishes, outside any run', 1);
  }
  const v = ws.view(o.ref);
  const { root, id } = ws.resolve(o.ref);
  if (v.meta.type !== PUBLISH_TYPE) {
    throw new OpsError(`${id} is a ${v.meta.type} task: publish adapters run on publish tasks`, 2);
  }
  const name = opts.adapter?.trim() || taskAdapter(v.meta.labels);
  if (!name) {
    throw new OpsError(
      `${id} names no publish adapter: give it the label ${PUBLISH_LABEL}<name>, or pass --adapter NAME`,
      2,
    );
  }
  const adapter = o.publish[root.name]?.[name];
  if (!adapter) {
    throw new OpsError(
      `no publish adapter ${name} for ${root.name} on this machine: define swarmupd.publish.${root.name}.${name}`,
      2,
    );
  }
  if (adapter.kind === 'manual') {
    throw new OpsError(
      `${name} is a manual adapter: publish the work yourself, then run swarmup published ${id} --url URL`,
      2,
    );
  }
  const { commit, files } = await publishFiles({ ...o, opts });
  const paths = files.map((f) => f.path);
  const secrets = readSecrets(o.env);
  // Everything that can be checked before the attempt is recorded, so a typo costs no attempt.
  let server: McpConfig['servers'][string] | undefined;
  if (adapter.kind === 'mcp') {
    server = o.mcp.servers[adapter.server ?? ''];
    if (!server) {
      throw new OpsError(`${name}: no MCP server ${adapter.server} in swarmupd.mcp.servers`, 2);
    }
    if (!server.publish) {
      throw new OpsError(
        `${name}: MCP server ${adapter.server} is not a publish server; set publish: true on it`,
        2,
      );
    }
    if (!mcpToolAllowed(server.tools, adapter.tool ?? '')) {
      throw new OpsError(`${name}: tool ${adapter.tool} is not allowed on ${adapter.server}`, 2);
    }
    if (namesOneFile(adapter.arguments) && files.length !== 1) {
      throw new OpsError(
        `${name}: its arguments take one file ({path}, {content}) and ${id} has ${files.length}: pass one --artifact PATH`,
        2,
      );
    }
  }
  const envSource = adapter.kind === 'mcp' ? server! : { command: '', env: adapter.env };
  const missing = resolveMcpEnv(envSource, secrets).missing;
  if (missing.length > 0) {
    throw new OpsError(
      `${name}: secrets.yml lacks ${missing.join(', ')}; set them with swarmup mcp secret or Settings`,
      2,
    );
  }
  const artifacts: ReviewArtifact[] = files.map((f) => ({
    kind: artifactKindOf(f.path) === 'image' ? 'image' : 'file',
    ref: f.path,
    blob: f.blob,
  }));
  // A command adapter's files are written before the attempt is recorded, so a failure to write
  // them leaves neither an attempt nor a folder.
  const staged = adapter.kind === 'command' ? stageFiles(files) : undefined;
  let attempt: OpsEvent;
  try {
    attempt = ws.publishAttempt(o.ref, {
      adapter: name,
      commit,
      artifacts,
      ...(opts.again ? { again: true } : {}),
    }).events[0]!;
  } catch (err) {
    if (staged) removeStaged(staged.dir);
    throw err;
  }
  const timeoutMs = (adapter.timeout_minutes ?? PUBLISH_TIMEOUT_MINUTES) * 60_000;
  let outcome: AdapterOutcome;
  if (adapter.kind === 'command') {
    const run = o.runners?.command ?? runCommandAdapter;
    try {
      outcome = await run(
        adapter,
        { root: root.name, task: id, commit, top: o.top, files, env: o.env, timeoutMs, staged },
        secrets,
      );
    } catch (err) {
      outcome = { ok: false, output: '', why: (err as Error).message };
    } finally {
      removeStaged(staged!.dir);
    }
  } else {
    const call = o.runners?.mcp ?? callMcpTool;
    const one = files.length === 1 ? files[0]! : undefined;
    const args = mcpArguments(adapter.arguments, {
      task: id,
      root: root.name,
      commit,
      ...(one ? { path: one.path, content: one.data.toString('utf8') } : {}),
    });
    const logged = {
      server: adapter.server!,
      tool: adapter.tool!,
      args_sha256: mcpArgsHash(args),
      task: `${root.name}/${id}`,
      adapter: name,
      attempt: attempt.id,
    };
    const log = (ok: boolean, error?: string): void => {
      if (o.stateDir === undefined) return;
      logPublishCall(o.stateDir, {
        at: new Date().toISOString(),
        ...logged,
        ok,
        ...(error ? { error: redactSecrets(error.split('\n')[0]!).slice(0, 300) } : {}),
      });
    };
    try {
      const answer = await call({
        command: server!.command,
        args: server!.args ?? [],
        env: childEnv(o.env, resolveMcpEnv(server!, secrets).env),
        tool: adapter.tool!,
        arguments: args,
        timeoutMs,
      });
      const url = answer.isError ? null : urlFromTool(answer);
      outcome = answer.isError
        ? { ok: false, output: tailOf(answer.text), why: 'the tool answered with an error' }
        : url
          ? { ok: true, url, output: tailOf(answer.text) }
          : {
              ok: false,
              output: tailOf(answer.text),
              why: 'the tool reported no URL (structuredContent.url or a `url: <URL>` line)',
            };
      log(!answer.isError, answer.isError ? outcome.why : undefined);
    } catch (err) {
      const stderr = err instanceof McpCallError ? err.stderr : '';
      outcome = { ok: false, output: stderr, why: (err as Error).message };
      log(false, outcome.why);
    }
  }
  const base = { adapter: name, commit, files: paths, attempt: attempt.id, output: outcome.output };
  if (!outcome.ok || !outcome.url) {
    const why = outcome.why ?? 'it failed';
    const res = ws.comment(
      o.ref,
      [
        `${id}: publish adapter ${name} failed (${why}); attempt ${attempt.id} stands.`,
        '',
        `- If it went live anyway, record it: \`swarmup published ${id} --url URL\``,
        `- Else fix the adapter and run \`swarmup publish ${id} --again\``,
      ].join('\n'),
    );
    return { ...base, ok: false, why, view: res.view };
  }
  return recordAdapterPublish({ ...o, id, name, commit, paths, url: outcome.url, base });
}

/**
 * A URL safe to write into an event: as given, else without its query and fragment when those
 * look like a secret (a token in a link), else only its origin.
 */
export function recordableUrl(url: string): string {
  if (!secretKind(url)) return url;
  const bare = url.replace(/[?#].*$/, '');
  if (!secretKind(bare)) return bare;
  try {
    return new URL(url).origin;
  } catch {
    return bare;
  }
}

/**
 * After an adapter published: writes the `publish` event first, then tags the commit, then runs
 * the post-publish criteria. The work is live by now, so nothing here throws: each step that
 * fails is named in `problems`, and the URL is always in the answer.
 */
async function recordAdapterPublish(o: {
  ws: Workspace;
  ref: string;
  git: GitRun;
  top: string;
  id: string;
  name: string;
  commit: string;
  paths: string[];
  url: string;
  base: Omit<PublishOutcome, 'ok' | 'view'>;
}): Promise<PublishOutcome> {
  const { ws, git, id } = o;
  const problems: string[] = [];
  const say = (step: string, err: unknown): void => {
    problems.push(`${step} failed: ${err instanceof Error ? err.message : String(err)}`);
  };
  let target: PublishTarget | undefined;
  try {
    target = await publishTarget(git, id, {
      rev: o.commit,
      ...(o.paths.length === 1 ? { path: o.paths[0] } : {}),
      create: false,
    });
  } catch (err) {
    say('finding the tag', err);
  }
  let edits: PublishEdits | undefined;
  try {
    edits = await publishEdits(git, taskApprovedFiles(ws, o.ref), o.commit, o.paths);
  } catch (err) {
    say('measuring the edits', err);
  }
  const url = recordableUrl(o.url);
  let recorded = false;
  try {
    ws.published(o.ref, {
      url,
      commit: o.commit,
      ...(target ?? {}),
      adapter: o.name,
      ...(edits ? { edits } : {}),
      message: `Published at ${url} with adapter ${o.name}`,
    });
    recorded = true;
  } catch (err) {
    say(
      `recording the publish (record it with \`swarmup published ${id} --url URL\`; do not run the adapter again)`,
      err,
    );
  }
  if (recorded && target) {
    try {
      const at = (await git(['tag', '--list', target.tag])).trim();
      if (!at) await git(['tag', target.tag, o.commit]);
    } catch (err) {
      say(`tagging ${target.tag}`, err);
    }
  }
  let results: CriteriaResults | undefined;
  if (recorded) {
    try {
      results = await ws.publishChecks(o.ref, url, { cwd: o.top });
    } catch (err) {
      say('the post-publish checks', err);
    }
  }
  let view: TaskView | undefined;
  try {
    view = ws.view(o.ref);
  } catch (err) {
    say('reading the task', err);
  }
  return {
    ...o.base,
    ok: true,
    url: o.url,
    ...(target ? { target } : {}),
    ...(results ? { results } : {}),
    ...(problems.length > 0 ? { problems } : {}),
    ...(view ? { view } : {}),
  };
}
