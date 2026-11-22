import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { ParseArgsConfig } from 'node:util';
import type { McpToolRules } from '@swarmup/core';
import { mcpArgsHash, mcpToolAllowed, OpsError } from '@swarmup/core';
import { quoteBatch, resolveCommand } from '@swarmup/supervisor';

/** The file in the run's scratch folder swarmupd writes the run token to (see `mcp-api.ts`). */
const TOKEN_FILE = 'mcp-token.json';
/** The log of tool calls in the run's scratch folder: tool names and argument hashes, no values. */
export const MCP_LOG = 'mcp.log';

/** The spec `POST /api/mcp/resolve` answers with. */
export interface McpSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  tools: McpToolRules;
}

interface McpCtx {
  io: { out: (line: string) => void; err: (line: string) => void; env: NodeJS.ProcessEnv };
  args: string[];
  opts: Record<string, string | boolean | string[] | undefined>;
}

/** `swarmup mcp exec NAME --run-dir DIR`: the proxy a run's runtime starts for one MCP server. */
export const mcpCommand = {
  usage: 'mcp exec NAME --run-dir DIR',
  summary:
    "start the MCP server NAME for a supervised run: fetches its spec from swarmupd with the run's token, starts it with its secrets in its environment only, filters its tools and logs calls to DIR/mcp.log",
  options: { 'run-dir': { type: 'string' } } satisfies NonNullable<ParseArgsConfig['options']>,
  run: async (ctx: McpCtx): Promise<number> => {
    const [sub, name] = ctx.args;
    if (sub !== 'exec' || !name)
      throw new OpsError('usage: swarmup mcp exec NAME --run-dir DIR', 2);
    const runDir = typeof ctx.opts['run-dir'] === 'string' ? ctx.opts['run-dir'] : '';
    if (!runDir) throw new OpsError('name the run scratch folder with --run-dir', 2);
    const spec = await fetchMcpSpec(resolve(runDir), name);
    return runMcpProxy({ spec, runDir: resolve(runDir), env: ctx.io.env });
  },
};

/** The run token and swarmupd's state folder from the run's scratch folder, then the spec. */
export async function fetchMcpSpec(runDir: string, name: string): Promise<McpSpec> {
  let token: string;
  let stateDir: string;
  try {
    const t = JSON.parse(readFileSync(join(runDir, TOKEN_FILE), 'utf8')) as {
      token?: unknown;
      state_dir?: unknown;
    };
    if (typeof t.token !== 'string' || typeof t.state_dir !== 'string') throw new Error('bad');
    token = t.token;
    stateDir = t.state_dir;
  } catch {
    throw new OpsError(`no MCP token in ${runDir}: swarmupd grants MCP servers to runs only`, 2);
  }
  let port: number;
  try {
    port = (JSON.parse(readFileSync(join(stateDir, 'opsd.json'), 'utf8')) as { port: number }).port;
  } catch {
    throw new OpsError('swarmupd is not running', 1);
  }
  const res = await fetch(`http://127.0.0.1:${port}/api/mcp/resolve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<McpSpec> & { error?: string };
  if (!res.ok) throw new OpsError(`${name}: ${data.error ?? `swarmupd answered ${res.status}`}`, 1);
  return data as McpSpec;
}

type Message = Record<string, unknown>;

/**
 * Filters one MCP stdio stream pair by the server's tool rules: `tools/list` answers lose the tools
 * the rules hide, and a `tools/call` of such a tool is answered with an error and never reaches the
 * server. Each call is logged with its tool name and a hash of its arguments.
 */
export class McpFilter {
  /** Ids of `tools/list` requests whose answers are filtered. */
  private readonly lists = new Set<string>();

  constructor(
    private readonly server: string,
    private readonly rules: McpToolRules,
    private readonly log: (entry: Record<string, unknown>) => void,
  ) {}

  /**
   * One line from the client. Returns what goes to the server (null: nothing) and the answers
   * that go straight back to the client.
   */
  fromClient(line: string): { forward: string | null; reply: string[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { forward: line, reply: [] };
    }
    const batch = Array.isArray(parsed);
    const msgs = (batch ? parsed : [parsed]) as unknown[];
    const keep: unknown[] = [];
    const reply: string[] = [];
    for (const m of msgs) {
      const msg = (m && typeof m === 'object' ? m : {}) as Message;
      const id = msg.id;
      if (msg.method === 'tools/list' && id !== undefined) this.lists.add(JSON.stringify(id));
      if (msg.method === 'tools/call') {
        const params = (msg.params ?? {}) as Message;
        const tool = typeof params.name === 'string' ? params.name : '';
        const allowed = tool !== '' && mcpToolAllowed(this.rules, tool);
        this.log({
          at: new Date().toISOString(),
          server: this.server,
          tool,
          args_sha256: mcpArgsHash(params.arguments),
          allowed,
        });
        if (!allowed) {
          if (id !== undefined) {
            reply.push(
              JSON.stringify({
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: `tool ${tool} is not allowed for this run` },
              }),
            );
          }
          continue;
        }
      }
      keep.push(m);
    }
    if (keep.length === 0) return { forward: null, reply };
    if (keep.length === msgs.length) return { forward: line, reply };
    return { forward: JSON.stringify(batch ? keep : keep[0]), reply };
  }

  /** One line from the server, with hidden tools taken out of `tools/list` answers. */
  fromServer(line: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return line;
    }
    const batch = Array.isArray(parsed);
    const msgs = (batch ? parsed : [parsed]) as Message[];
    let changed = false;
    for (const msg of msgs) {
      if (!msg || typeof msg !== 'object' || msg.id === undefined) continue;
      const key = JSON.stringify(msg.id);
      if (!this.lists.has(key)) continue;
      this.lists.delete(key);
      const result = msg.result as { tools?: Array<{ name?: unknown }> } | undefined;
      if (!result || !Array.isArray(result.tools)) continue;
      const tools = result.tools.filter(
        (t) => typeof t?.name === 'string' && mcpToolAllowed(this.rules, t.name),
      );
      if (tools.length !== result.tools.length) {
        result.tools = tools;
        changed = true;
      }
    }
    return changed ? JSON.stringify(batch ? msgs : msgs[0]) : line;
  }
}

/** Calls `onLine` for each newline-ended line of `stream`, and `onEnd` at its end. */
function lines(stream: Readable, onLine: (line: string) => void, onEnd: () => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let at: number;
    while ((at = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, at).replace(/\r$/, '');
      buf = buf.slice(at + 1);
      if (line.trim() !== '') onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf.trim() !== '') onLine(buf.replace(/\r$/, ''));
    buf = '';
    onEnd();
  });
}

/** Starts the real server: a `.cmd` or `.bat` (such as `npx` on Windows) through `cmd.exe`. */
function startServer(spec: McpSpec, env: NodeJS.ProcessEnv): ChildProcess {
  const childEnv: NodeJS.ProcessEnv = { ...env, ...spec.env };
  // The run's API token is the run's, not the server's.
  for (const k of Object.keys(childEnv)) {
    if (/^(SWARMUP|OPS)_RUN_TOKEN$/i.test(k)) delete childEnv[k];
  }
  const file = resolveCommand(spec.command, childEnv) ?? spec.command;
  const opts: SpawnOptions = {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
    const line = `"${[file, ...spec.args].map(quoteBatch).join(' ')}"`;
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', line], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(file, spec.args, opts);
}

/**
 * Runs the server of `spec` between this process's stdio (or `io`) and the server's, through
 * {@link McpFilter}. The secrets in `spec.env` go to the server's environment only. Resolves with
 * the server's exit code.
 */
export function runMcpProxy(input: {
  spec: McpSpec;
  runDir: string;
  env?: NodeJS.ProcessEnv;
  io?: { stdin: Readable; stdout: Writable };
}): Promise<number> {
  const { spec, runDir } = input;
  const stdin = input.io?.stdin ?? process.stdin;
  const stdout = input.io?.stdout ?? process.stdout;
  const logFile = join(runDir, MCP_LOG);
  const filter = new McpFilter(spec.name, spec.tools ?? {}, (entry) => {
    try {
      appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    } catch {
      // The log never stops a call.
    }
  });
  const child = startServer(spec, input.env ?? process.env);
  return new Promise<number>((done) => {
    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      done(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`swarmup mcp exec ${spec.name}: ${err.message}\n`);
      finish(1);
    });
    child.on('exit', (code) => finish(code ?? 1));
    child.stdin?.on('error', () => {});
    lines(
      stdin,
      (line) => {
        const { forward, reply } = filter.fromClient(line);
        for (const r of reply) stdout.write(`${r}\n`);
        if (forward !== null) child.stdin?.write(`${forward}\n`);
      },
      () => child.stdin?.end(),
    );
    if (child.stdout) {
      lines(
        child.stdout,
        (line) => {
          stdout.write(`${filter.fromServer(line)}\n`);
        },
        () => {},
      );
    }
  });
}
